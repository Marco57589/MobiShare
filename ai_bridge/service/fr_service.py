# fr_service.py

"""
Questo modulo definisce gli endpoint API FastAPI per il servizio
di Riconoscimento Facciale (Face Recognition).
"""
from fastapi import APIRouter, UploadFile, File, HTTPException, Header
from .FR.fr_recognizer import FaceRecognizer

router = APIRouter(tags=["Face recognition"], prefix="/face_recognition")

db = None
recognizer = None

@router.on_event("startup")
async def startup_event():
    """
    Evento di avvio di FastAPI.
    Inizializza l'istanza di FaceRecognizer con la connessione
    al database.
    """
    global recognizer
    if db:
        recognizer = FaceRecognizer(db)


@router.post("/register")
async def register_face(username: str = Header(), image: UploadFile = File(...)) -> dict:
    """
    Endpoint per registrare un nuovo volto utente.
    Riceve un 'username' (ID utente) dall'header e un file immagine.
    Salva gli encoding facciali (con data augmentation) su Firestore.
    Args:
        username (str): ID dell'utente (passato via Header).
        image (UploadFile): File immagine del volto.
    Returns:
        dict: Messaggio di successo o errore.
    """

    if not recognizer:
        raise HTTPException(status_code=500, detail="FaceRecognizer non inizializzato")

    success = await recognizer.save_encoding(username, image)
    if success:
        return {"message": "Face encoding saved successfully", "status": "success"}
    else:
        raise HTTPException(status_code=400, detail="Failed to save face encoding. Please ensure the image contains exactly one face.")


@router.post("/verify")
async def verify_face(username: str = Header(), image: UploadFile = File(...)) -> dict:
    """
        Endpoint per verificare l'identità di un utente tramite volto.
        Riceve 'username' (ID utente) e un'immagine.
        Confronta l'encoding dell'immagine con quelli salvati per l'utente.
        Args:
            username (str): ID dell'utente (passato via Header).
            image (UploadFile): File immagine del volto da verificare.
        Returns:
            dict: Risultato della verifica (verified: True/False).
        """

    if not recognizer:
        raise HTTPException(status_code=500, detail="FaceRecognizer non inizializzato")

    result = await recognizer.verify_face(username, image)
    if result is True:
        return {"message": "Face recognized", "status": "success", "verified": True}
    elif result is False:
        return {"message": "Face not recognized", "status": "success", "verified": False}
    else:
        raise HTTPException(status_code=400, detail="Please ensure the image contains exactly one face.")