import face_recognition as fr
import numpy as np
import cv2
import tempfile
import os
from firebase_admin import firestore
import logging

logger = logging.getLogger(__name__)

class FaceRecognizer:
    def __init__(self, db):
        self.db = db

    async def save_encoding(self, username: str, image):
        """Crea e salva più encoding per lo stesso volto (data augmentation)"""
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as temp_file:
                img_content = await image.read()
                temp_file.write(img_content)
                temp_path = temp_file.name

            img_cv = cv2.imread(temp_path)
            if img_cv is None:
                raise ValueError("Immagine non valida")

            augmented_images = self._augment_image(img_cv)
            total_encodings = []

            for aug_img in augmented_images:
                rgb_img = cv2.cvtColor(aug_img, cv2.COLOR_BGR2RGB)
                encodings = fr.face_encodings(rgb_img)
                if len(encodings) == 1:
                    total_encodings.append(encodings[0].tolist())

            if not total_encodings:
                logger.warning("Nessun volto valido trovato nelle immagini")
                return False

            for encoding in total_encodings:
                face_data = {
                    'username': username,
                    'encoding': encoding,
                    'created_at': firestore.SERVER_TIMESTAMP,
                    'source': 'augmentation'
                }
                self.db.collection('face_encodings').document().set(face_data)

            logger.info(f"Salvati {len(total_encodings)} encoding per {username}")
            return True

        except Exception as e:
            logger.error(f"Errore durante il salvataggio dell'encoding: {e}")
            return False
        finally:
            if 'temp_path' in locals() and os.path.exists(temp_path):
                os.unlink(temp_path)


    async def verify_face(self, username: str, image):
        """Verifica se il volto corrisponde a quello salvato"""
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as temp_file:
                img_content = await image.read()
                temp_file.write(img_content)
                temp_path = temp_file.name

            img_np = fr.load_image_file(temp_path)
            encodings = fr.face_encodings(img_np)

            if len(encodings) != 1:
                logger.warning("L'immagine deve contenere esattamente un volto per la verifica")
                return None

            target_encoding = encodings[0]
            docs = self.db.collection('face_encodings').where('username', '==', username).stream()
            user_encodings = [np.array(doc.to_dict()['encoding'], dtype=np.float64) for doc in docs]

            if not user_encodings:
                logger.warning(f"Nessun encoding trovato per l'utente {username}")
                return False

            results = fr.compare_faces(user_encodings, target_encoding, tolerance=0.5)
            logger.info(f"Risultati riconoscimento utente {username}: {results}")
            return any(results)

        except Exception as e:
            logger.error(f"Errore nel riconoscimento facciale: {e}")
            return False
        finally:
            if 'temp_path' in locals() and os.path.exists(temp_path):
                os.unlink(temp_path)


    def _augment_image(self, image):
        """Applica flip, rotazioni e scala di grigi per migliorare il training"""
        augmented = [image]

        #Mirror orizzontale (per eventuali ftocamera che fanno il mirror)
        flipped = cv2.flip(image, 1)
        augmented.append(flipped)

        # Rotazioni piccole (inclinazione della testa)
        (h, w) = image.shape[:2]
        center = (w // 2, h // 2)
        for angle in [-10, 10]:
            M = cv2.getRotationMatrix2D(center, angle, 1.0)
            rotated = cv2.warpAffine(image, M, (w, h))
            augmented.append(rotated)

        #grigi (per i cambi di luce)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        gray_3ch = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        augmented.append(gray_3ch)

        return augmented