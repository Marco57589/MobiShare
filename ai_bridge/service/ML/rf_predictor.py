# - pandas e numpy per la manipolazione dei dati.
# - google.cloud.firestore_v1 per interagire con Firestore.
# - sklearn per il modello di machine learning (Random Forest).
# - joblib per salvare e caricare il modello.
# - datetime per gestire date e ore.
# - logging per registrare informazioni ed errori.
# - firebase_admin per l'integrazione con Firebase.
# - matplotlib e seaborn per creare grafici.
import pandas as pd
import numpy as np
from google.cloud.firestore_v1 import FieldFilter
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import mean_absolute_error, mean_squared_error
import joblib
import tempfile
from datetime import datetime, timedelta, timezone
import logging
from firebase_admin import firestore, storage
import os
import matplotlib.pyplot as plt
import seaborn as sns
import math

logger = logging.getLogger(__name__)

class DistribuzioneOttimale:
    """
    Questa classe gestisce un modello di Machine Learning per prevedere la domanda
    di veicoli nei parcheggi e suggerire come distribuirli in modo ottimale.
    """
    def __init__(self, db):
        """
       Il costruttore inizializza la classe.
       - self.db: La connessione al database Firestore.
       - self.model: Conterrà il modello di machine learning una volta addestrato o caricato.
       - self.label_encoders: Dizionario per memorizzare gli "encoder", che convertono
         testo (es. ID parcheggio) in numeri per il modello.
       - self.feature_columns: La lista di colonne (dati) che il modello userà per fare previsioni.
       - self.bucket: Un riferimento a Firebase Storage, usato per salvare e caricare il modello.
       - self.model_path: Il percorso dove il modello è salvato in Firebase Storage.
        """
        self.db = db
        self.model = None
        self.label_encoders = {}
        self.feature_columns = [
            'parking_id', 'hour', 'fascia_oraria', 'day_of_week', 'month', 'is_weekend',
            'previous_day_demand', 'previous_week_demand', 'mezzo_type_encoded'
        ]
        self.bucket = storage.bucket()
        self.model_path = 'models/rf_parcheggi.pkl'
        self.mezzo_mapping = {
            'Bicicletta': 0,
            'Bicicletta Elettrica': 1,
            'Monopattino Elettrico': 2
        }
        self.mezzo_mapping_inv = {v: k for k, v in self.mezzo_mapping.items()}


    def get_fascia_oraria(self, hour: int) -> int:
        """
        Restituisce la fascia oraria:
        0 = Notte (21 - 5)
        1 = Mattina (5 - 12)
        2 = Pomeriggio (12 - 18)
        3 = Sera (18 - 21)
        """
        if 21 <= hour or hour < 5:
            return 0  # Notte
        elif 5 <= hour < 12:
            return 1  # Mattina
        elif 12 <= hour < 18:
            return 2  # Pomeriggio
        else:
            return 3  # Sera

    async def prepare_training_data(self, days_history=90):
        """
        Prepara i dati per addestrare il modello.
        1. Recupera le corse degli ultimi 'days_history' giorni da Firestore.
        2. Crea un DataFrame con i dati delle corse.
        3. Estrae informazioni utili dalla data/ora di ogni corsa (ora, giorno della settimana, mese).
        4. Calcola la "domanda oraria": quanti veicoli sono partiti da un parcheggio in una certa ora.
        5. Aggiunge feature "intelligenti", come la domanda del giorno prima e della settimana prima,
           per aiutare il modello a riconoscere pattern settimanali e giornalieri.
        6. Restituisce i dati pronti per l'addestramento.
        """
        try:
            logger.info(f"Recupero dati delle corse dagli ultimi {days_history} giorni...")

            start_date = datetime.now(timezone.utc) - timedelta(days=days_history)
            logger.info(f"Data di inizio: {start_date}")

            rides_ref = self.db.collection('rides')
            rides_snapshot = rides_ref.stream()

            rides_data = []
            ride_count = 0

            for ride in rides_snapshot:
                try:
                    r = ride.to_dict()
                    start_time = r.get('startTime')

                    # Conversione sicura della data
                    if hasattr(start_time, 'timestamp'):  # Firestore Timestamp
                        start_time = datetime.fromtimestamp(start_time.timestamp(), tz=timezone.utc)
                    elif isinstance(start_time, str):  # ISO string
                        start_time = datetime.fromisoformat(start_time.replace('Z', '+00:00'))

                    # Filtra corse solo recenti
                    if start_time >= start_date:
                        rides_data.append({
                            'ride_id': ride.id,
                            'parking_id': r.get('parcheggioPartenza'),
                            'start_time': start_time,
                            'mezzo_tipo': r.get('mezzoTipo', '')
                        })
                        ride_count += 1

                except Exception as e:
                    logger.warning(f"Errore parsing ride {ride.id}: {e}")
                    continue

            logger.info(f"Totale corse recuperate: {ride_count}")

            if not rides_data:
                logger.error("Nessun dato di training trovato")
                return None

            # Crea DataFrame
            df = pd.DataFrame(rides_data)
            logger.info(f"DataFrame creato con {len(df)} righe")

            # Estrai features temporali
            df['hour'] = df['start_time'].dt.hour
            df['day_of_week'] = df['start_time'].dt.dayofweek
            df['month'] = df['start_time'].dt.month
            df['is_weekend'] = df['day_of_week'].isin([5, 6]).astype(int)
            df['date'] = df['start_time'].dt.date

            # Calcola domanda oraria per tipo di mezzo
            hourly_demand = df.groupby(['date', 'parking_id', 'hour', 'mezzo_tipo']).size().reset_index(name='demand')

            logger.info(f"Domanda oraria calcolata: {len(hourly_demand)} righe")

            # Aggiungi features aggiuntive
            hourly_demand['date'] = pd.to_datetime(hourly_demand['date'])
            hourly_demand['day_of_week'] = hourly_demand['date'].dt.dayofweek
            hourly_demand['month'] = hourly_demand['date'].dt.month
            hourly_demand['is_weekend'] = hourly_demand['day_of_week'].isin([5, 6]).astype(int)
            hourly_demand['fascia_oraria'] = hourly_demand['hour'].apply(self.get_fascia_oraria)

            # Encoding tipo mezzo
            
            hourly_demand['mezzo_type_encoded'] = hourly_demand['mezzo_tipo'].map(self.mezzo_mapping).fillna(0)

            # Calcola domanda precedente per tipo di mezzo
            hourly_demand = hourly_demand.sort_values(['parking_id', 'mezzo_type_encoded', 'date', 'hour'])
            hourly_demand['previous_day_demand'] = hourly_demand.groupby(['parking_id', 'hour', 'mezzo_type_encoded'])['demand'].shift(1)
            hourly_demand['previous_week_demand'] = hourly_demand.groupby(['parking_id', 'hour', 'mezzo_type_encoded'])['demand'].shift(7)

            # Gestione valori NaN
            hourly_demand['previous_day_demand'] = hourly_demand['previous_day_demand'].fillna(0)
            hourly_demand['previous_week_demand'] = hourly_demand['previous_week_demand'].fillna(0)

            # Rimuovi righe con demand NaN (precauzione)
            hourly_demand = hourly_demand.dropna(subset=['demand'])

            logger.info(f"Dati finali preparati: {len(hourly_demand)} righe")
            logger.info(f"Sample dati:\n{hourly_demand.head()}")

            return hourly_demand

        except Exception as e:
            logger.error(f"Errore preparazione dati training: {e}", exc_info=True)
            return None

    async def train_model(self):
        """
        Addestra il modello di machine learning.
        1. Chiama `prepare_training_data` per ottenere i dati.
        2. Divide i dati in un set di addestramento e un set di test
        3. Addestra un modello "RandomForestRegressor".
        4. Valuta le performance del modello.
        5. Salva il modello addestrato, insieme agli encoder e alle performance, su Firebase Storage.
        6. Salva i grafici che mostrano le performance del modello.
        """
        try:
            logger.info("Inizio addestramento modello...")
            data = await self.prepare_training_data(days_history=30)  # Riduci giorni per test

            if data is None or data.empty:
                logger.error("Nessun dato disponibile per l'addestramento")
                return False

            logger.info(f"Colonne features: {self.feature_columns}")
            logger.info(f"Colonne disponibili nei dati: {data.columns.tolist()}")

            # Verifica che tutte le colonne necessarie siano presenti
            missing_columns = set(self.feature_columns) - set(data.columns)
            if missing_columns:
                logger.error(f"Colonne mancanti nei dati: {missing_columns}")
                return False

            X = data[self.feature_columns]
            y = data['demand']

            logger.info(f"Shape X: {X.shape}, y: {y.shape}")

            # Encoding delle colonne categoriche
            for column in ['parking_id']:
                if column in X.columns:
                    if column not in self.label_encoders:
                        self.label_encoders[column] = LabelEncoder()
                    X.loc[:, column] = self.label_encoders[column].fit_transform(X[column])

            # Split dei dati
            X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

            logger.info(f"Training set: {X_train.shape}, Test set: {X_test.shape}")

            # Addestramento del modello con parametri semplificati
            self.model = RandomForestRegressor(
                n_estimators=100,  # Ridotto per test
                max_depth=10,
                min_samples_split=5,
                random_state=42,
                n_jobs=-1
            )
            self.model.fit(X_train, y_train)

            # Valutazione
            y_pred = self.model.predict(X_test)
            mae = mean_absolute_error(y_test, y_pred)
            rmse = np.sqrt(mean_squared_error(y_test, y_pred))

            logger.info(f"Performance - MAE: {mae:.2f}, RMSE: {rmse:.2f}")

            # Modello da salvare
            model_data = {
                'model': self.model,
                'encoders': self.label_encoders,
                'feature_columns': self.feature_columns,
                'performance': {'mae': mae, 'rmse': rmse},
                'training_date': datetime.now().isoformat()
            }

            # Salvataggio su Firebase
            with tempfile.NamedTemporaryFile(delete=False, suffix=".pkl") as tmp:
                joblib.dump(model_data, tmp.name)
                blob = self.bucket.blob(self.model_path)

                logger.info(f"Caricamento modello su Firebase: {self.model_path}")
                try:
                    blob.upload_from_filename(tmp.name)
                    logger.info("Modello caricato con successo su Firebase Storage")
                except Exception as e:
                    logger.error(f"Errore durante upload su Firebase: {e}")
                    return False
                finally:
                    os.unlink(tmp.name)

            self.db.collection('ml_models').document('parking_predictor').set({
                'last_training': firestore.SERVER_TIMESTAMP,
                'performance': model_data['performance'],
                'model_path': self.model_path,
                'feature_columns': self.feature_columns,
                'training_samples': len(data)
            })

            try:
                await self.plot_model_performance()
            except Exception as e:
                logger.warning(f"Errore nella generazione dei plot: {e}")

            return True

        except Exception as e:
            logger.error(f"Errore addestramento modello: {e}", exc_info=True)
            return False

    async def load_model(self):
        """
        Carica il modello precedentemente salvato da Firebase Storage.
        """
        try:
            blob = self.bucket.blob(self.model_path)
            if not blob.exists():
                logger.error("Modello non trovato su Firebase Storage")
                return False

            with tempfile.NamedTemporaryFile() as tmp:
                blob.download_to_filename(tmp.name)
                model_data = joblib.load(tmp.name)
                self.model = model_data['model']
                self.label_encoders = model_data['encoders']
                logger.info("Modello caricato da Firebase Storage")
                return True
        except Exception as e:
            logger.error(f"Errore caricamento modello: {e}")
            return False

    async def predict_demand(self, parking_id, target_time, mezzo_type_encoded=0):
        """
        Prevede la domanda di veicoli per un singolo parcheggio, ora e tipo di mezzo.
        """
        try:
            if self.model is None:
                loaded = await self.load_model()
                if not loaded:
                    return None
            
            # Per le nuove previsioni, non abbiamo dati futuri, quindi usiamo 0.
            # L'impatto di queste feature è appreso dal modello durante il training.
            prev_day, prev_week = 0, 0

            features = {
                'parking_id': parking_id,
                'hour': target_time.hour,
                'fascia_oraria': self.get_fascia_oraria(target_time.hour),
                'day_of_week': target_time.weekday(),
                'month': target_time.month,
                'is_weekend': 1 if target_time.weekday() in [5, 6] else 0,
                'previous_day_demand': prev_day,
                'previous_week_demand': prev_week,
                'mezzo_type_encoded': mezzo_type_encoded
            }

            df = pd.DataFrame([features])

            if 'parking_id' in self.label_encoders:
                try:
                    df['parking_id'] = self.label_encoders['parking_id'].transform([parking_id])[0]
                except ValueError:
                    df['parking_id'] = 0

            prediction = self.model.predict(df[self.feature_columns])[0]
            return max(0, float(prediction))

        except Exception as e:
            logger.error(f"Errore durante predict_demand: {e}")
            return None

    async def forecast(self, hours_ahead: int = 24):
        """
        Esegue previsioni per tutti i parcheggi e tipi di mezzo per le prossime 'hours_ahead' ore.
        """
        try:
            forecasts = []
            current_time = datetime.now()

            parking_snapshot = self.db.collection('parcheggi').stream()
            parking_list = [parking.to_dict() for parking in parking_snapshot]

            logger.info(f"Forecast per {len(parking_list)} parcheggi e {len(self.mezzo_mapping)} tipi di mezzo")

            for hour_offset in range(hours_ahead):
                target_time = current_time + timedelta(hours=hour_offset)
                hourly_forecasts = []

                for parking in parking_list:
                    parking_id = parking.get('id')
                    parking_name = parking.get('nome')

                    for mezzo_tipo, mezzo_code in self.mezzo_mapping.items():
                        predicted_demand = await self.predict_demand(parking_id, target_time, mezzo_code)
                        if predicted_demand is None:
                            continue

                        recommendation_data = await self.generate_recommendation(predicted_demand, parking_id, mezzo_tipo)

                        hourly_forecasts.append({
                            'parking_id': parking_id,
                            'parking_name': parking_name,
                            'mezzo_tipo': mezzo_tipo,
                            'timestamp': target_time.isoformat(),
                            'predicted_demand': round(predicted_demand, 2),
                            **recommendation_data
                        })

                forecasts.append({
                    'timestamp': target_time.isoformat(),
                    'hour': target_time.hour,
                    'fascia_oraria': self.get_fascia_oraria(target_time.hour),
                    'predictions': hourly_forecasts
                })

            return {
                "forecast_hours": hours_ahead,
                "generated_at": current_time.isoformat(),
                "forecasts": forecasts
            }
        except Exception as e:
            logger.error(f"Errore predizione: {e}")
            raise

    async def get_current_vehicles(self, parking_id, mezzo_tipo=None):
        """
        Controlla su Firestore quanti veicoli "Disponibili" ci sono in un parcheggio,
        filtrando opzionalmente per tipo di mezzo.
        """
        try:
            query = (
                self.db.collection('mezzi')
                .where(filter=FieldFilter('id_parcheggio', '==', parking_id))
                .where(filter=FieldFilter('stato', '==', 'Disponibile'))
            )
            if mezzo_tipo:
                query = query.where(filter=FieldFilter('tipo', '==', mezzo_tipo))
            
            vehicles_snapshot = query.stream()
            return len(list(vehicles_snapshot))
        except Exception as e:
            logger.error(f"Errore recupero veicoli: {e}")
            return 0

    async def generate_recommendation(self, predicted_demand, parking_id, mezzo_tipo):
        """
        Genera un suggerimento basato sulla previsione per un tipo di mezzo.
        """
        current_vehicles = await self.get_current_vehicles(parking_id, mezzo_tipo)
        recommended_capacity = math.ceil(predicted_demand)
        vehicles_diff = recommended_capacity - current_vehicles

        action_prefix = f"[{mezzo_tipo}]"

        if vehicles_diff == 0:
            action = f"{action_prefix} Distribuzione ottimale"
            is_optimal = True
        elif vehicles_diff > 0:
            action = f"{action_prefix} Aumentare a {recommended_capacity} (+{vehicles_diff})"
            is_optimal = False
        else:
            action = f"{action_prefix} Ridurre a {recommended_capacity} ({vehicles_diff})"
            is_optimal = False

        return {
            "current_vehicles": current_vehicles,
            "recommended_capacity": recommended_capacity,
            "vehicles_diff": vehicles_diff,
            "action_text": action,
            "is_optimal": is_optimal
        }

    async def get_optimization_suggestions(self, hours_ahead: int = 24):
        """
        Raccoglie i suggerimenti per le prossime ore in cui è necessario un intervento.
        Filtra i casi in cui la distribuzione è già ottimale, mostrando solo dove bisogna
        aggiungere o rimuovere veicoli.
        """
        try:
            forecast_data = await self.forecast(hours_ahead)

            suggestions = []

            for hour_data in forecast_data['forecasts']:
                for prediction in hour_data['predictions']:
                    diff = prediction['vehicles_diff']
                    if abs(diff) > 0:  # Suggerisci se c'è una differenza
                        suggestions.append({
                            'parking_id': prediction['parking_id'],
                            'parking_name': prediction['parking_name'],
                            'mezzo_tipo': prediction['mezzo_tipo'],
                            'timestamp': prediction['timestamp'],
                            'predicted_demand': prediction['predicted_demand'],
                            'current_vehicles': prediction['current_vehicles'],
                            'recommended_capacity': prediction['recommended_capacity'],
                            'vehicles_to_move': abs(diff),
                            'action': 'ADD' if diff > 0 else 'REMOVE',
                            'suggested_action': prediction['action_text'],
                            'is_optimal': prediction.get('is_optimal', False)
                        })

            total_predictions = sum(len(hour_data['predictions']) for hour_data in forecast_data['forecasts'])

            logger.info(f"Generati {len(suggestions)} suggerimenti su {total_predictions} predizioni")

            return {
                "suggestions": suggestions,
                "total_suggestions": len(suggestions),
                "generated_at": datetime.now().isoformat(),
                "metadata": {
                    "total_predictions_analyzed": total_predictions,
                    "suggestions_percentage": round(len(suggestions) / total_predictions * 100,
                                                    2) if total_predictions else 0
                },
                "forecast_data": forecast_data # Passa i dati per il plotting
            }

        except Exception as e:
            logger.error(f"Errore generazione suggerimenti: {e}")
            return {"suggestions": [], "total_suggestions": 0, "generated_at": datetime.now().isoformat()}

    async def save_suggestions_to_cache(self, suggestions_data):
        """
        Salva i suggerimenti generati in una "cache" su Firestore.
        Questo serve per non dover ricalcolare tutto ogni volta che un utente chiede i dati.
        """
        try:
            forecast_data = suggestions_data.get("forecast_data")
            if forecast_data:
                await self.plot_predictions(forecast_data)

            plot_paths = {
                'line': '/images/plots/line_plot.png',
                'bar': '/images/plots/bar_plot.png',
                'heatmap': '/images/plots/heatmap_plot.png'
            }

            # Rimuovi i dati di forecast prima di salvare su Firestore per non duplicare
            if 'forecast_data' in suggestions_data:
                del suggestions_data['forecast_data']


            cache_data = {
                **suggestions_data,
                'generated_at': firestore.SERVER_TIMESTAMP,
                'plots': plot_paths,
                'plots_generated': True
            }

            self.db.collection('ml_cache').document('parking_suggestions').set(cache_data)
            logger.info("Suggerimenti e plot salvati nella cache")
            return True
        except Exception as e:
            logger.error(f"Errore salvataggio cache: {e}")
            return False

    async def get_suggestions_from_cache(self):
        """
        Recupera i suggerimenti dalla cache di Firestore, se disponibili.
        """
        try:
            cache_doc = self.db.collection('ml_cache').document('parking_suggestions').get()

            if not cache_doc.exists:
                return None

            cache_data = cache_doc.to_dict()
            logger.info("Suggerimenti recuperati dalla cache")
            return cache_data

        except Exception as e:
            logger.error(f"Errore recupero cache: {e}")
            return None

    async def get_cached_suggestions(self):
        """
        Funzione che restituisce i suggerimenti dalla cache.
        Se la cache è vuota, restituisce una risposta vuota indicandolo.
        """
        try:
            cached_data = await self.get_suggestions_from_cache()

            if cached_data:
                return cached_data

            logger.info("Nessuna cache trovata")
            return {
                "suggestions": [],
                "total_suggestions": 0,
                "generated_at": datetime.now().isoformat(),
                "cache_missing": True
            }

        except Exception as e:
            logger.error(f"Errore in get_cached_suggestions: {e}")
            return {
                "suggestions": [],
                "total_suggestions": 0,
                "generated_at": datetime.now().isoformat(),
                "error": str(e)
            }

    async def train_and_cache_model(self):
        """
        Funzione che esegue l'intero processo:
        1. Addestra il modello (`train_model`).
        2. Genera i suggerimenti per le prossime 24 ore.
        3. Salva i suggerimenti nella cache.
        """
        try:
            logger.info("Inizio addestramento e caching...")
            training_success = await self.train_model()

            if not training_success:
                logger.error("Addestramento fallito")
                return False

            logger.info("Addestramento completato, generazione suggerimenti...")
            suggestions_data = await self.get_optimization_suggestions(hours_ahead=24)
            cache_success = await self.save_suggestions_to_cache(suggestions_data)

            if cache_success:
                logger.info("Caching completato con successo")
            else:
                logger.error("Caching fallito")

            return cache_success

        except Exception as e:
            logger.error(f"Errore in train_and_cache_model: {e}")
            return False

    async def plot_predictions(self, forecast_data):
        """
        Crea una serie di grafici per visualizzare le previsioni della domanda per tipo di mezzo.
        """
        current_file_dir = os.path.dirname(os.path.abspath(__file__))
        local_plots_dir = os.path.join(current_file_dir, 'plots')
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(current_file_dir)))
        public_plots_dir = os.path.join(project_root, 'public', 'images', 'plots')

        for save_dir in [local_plots_dir, public_plots_dir]:
            if not os.path.exists(save_dir):
                os.makedirs(save_dir)

        # Estrai le previsioni dai dati passati
        predictions = []
        for hour_data in forecast_data['forecasts']:
            for pred in hour_data['predictions']:
                predictions.append({
                    **pred,
                    'hour': hour_data['hour'],
                    'fascia': hour_data['fascia_oraria']
                })

        df_pred = pd.DataFrame(predictions)
        
        save_dirs = [local_plots_dir, public_plots_dir]

        def save_plot(filename):
            for save_dir in save_dirs:
                plt.savefig(f"{save_dir}/{filename}", bbox_inches='tight')

        # === LINE PLOT ===
        plt.figure(figsize=(14, 7))
        sns.lineplot(
            data=df_pred,
            x='hour',
            y='predicted_demand',
            hue='parking_name',
            style='mezzo_tipo',
            palette='viridis',
            linewidth=2.5,
            marker='o',
            errorbar=None
        )
        plt.title("Andamento della domanda prevista per parcheggio e tipo di mezzo", fontsize=16)
        plt.xlabel("Ora del giorno", fontsize=12)
        plt.ylabel("Domanda prevista (n° mezzi)", fontsize=12)
        plt.xticks(range(0, 24))
        plt.xlim(0, 23)
        plt.grid(True, linestyle='--', alpha=0.6)
        plt.legend(title="Legenda", bbox_to_anchor=(1.05, 1), loc='upper left')
        plt.tight_layout()
        save_plot("line_plot.png")
        plt.close()

        # === BAR PLOT ===
        plt.figure(figsize=(12, 7))
        sns.barplot(
            data=df_pred,
            x='parking_name',
            y='predicted_demand',
            hue='mezzo_tipo',
            palette='muted'
        )
        plt.title("Domanda media prevista per parcheggio e tipo di mezzo", fontsize=16)
        plt.xlabel("Parcheggio", fontsize=12)
        plt.ylabel("Domanda media prevista", fontsize=12)
        plt.xticks(rotation=45, ha='right')
        plt.legend(title="Tipo di Mezzo")
        plt.tight_layout()
        save_plot("bar_plot.png")
        plt.close()

        # === HEATMAP ===
        fascia_labels = {0: 'Notte', 1: 'Mattina', 2: 'Pomeriggio', 3: 'Sera'}
        df_pred['fascia_label'] = df_pred['fascia'].map(fascia_labels)
        heatmap_data = df_pred.pivot_table(
            index=['parking_name', 'mezzo_tipo'],
            columns='fascia_label',
            values='predicted_demand',
            aggfunc='mean',
            observed=False
        )
        fascia_order = ['Notte', 'Mattina', 'Pomeriggio', 'Sera']
        heatmap_data = heatmap_data[fascia_order]

        plt.figure(figsize=(10, 8))
        sns.heatmap(
            heatmap_data,
            annot=True,
            fmt=".1f",
            cmap="YlGnBu",
            cbar_kws={'label': 'Domanda media prevista'}
        )
        plt.title("Domanda media per parcheggio, mezzo e fascia oraria", fontsize=16)
        plt.xlabel("Fascia oraria", fontsize=12)
        plt.ylabel("Parcheggio e Tipo di Mezzo", fontsize=12)
        plt.tight_layout()
        save_plot("heatmap_plot.png")
        plt.close()

    async def plot_model_performance(self):
        """
        Genera un grafico a barre che mostra le metriche di errore del modello (MAE e RMSE),
        """
        try:
            if self.model is None:
                loaded = await self.load_model()
                if not loaded:
                    logger.warning("Modello non disponibile per le performance")
                    return

            blob = self.bucket.blob(self.model_path)
            if blob.exists():
                with tempfile.NamedTemporaryFile() as tmp:
                    blob.download_to_filename(tmp.name)
                    model_data = joblib.load(tmp.name)
                    perf = model_data.get('performance', {'mae': 0, 'rmse': 0})
            else:
                perf = {'mae': 0, 'rmse': 0}

            metrics = ['MAE', 'RMSE']
            values = [perf['mae'], perf['rmse']]

            plt.figure(figsize=(6, 4))
            sns.barplot(x=metrics, y=values, palette='Set2')
            plt.title("Performance RandomForest")
            plt.ylabel("Valore")
            plt.tight_layout()

            current_file_dir = os.path.dirname(os.path.abspath(__file__))
            plots_dir = os.path.join(current_file_dir, 'plots')
            if not os.path.exists(plots_dir):
                os.makedirs(plots_dir)

            plt.savefig(f"{plots_dir}/model_performance.png")
            plt.close()

            logger.info("Plot delle performance generato")

        except Exception as e:
            logger.warning(f"Errore nella generazione del plot: {e}")