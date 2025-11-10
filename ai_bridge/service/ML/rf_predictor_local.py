import pandas as pd
import numpy as np
import json
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import mean_absolute_error, mean_squared_error
import joblib
from datetime import datetime, timedelta, timezone
import logging
import math
import matplotlib.pyplot as plt
import seaborn as sns
import os

logger = logging.getLogger(__name__)


class DistribuzioneOttimaleLocal:
    """
    Questa classe gestisce un modello di Machine Learning per prevedere la domanda
    di veicoli nei parcheggi e suggerire come distribuirli in modo ottimale,
    utilizzando un dataset JSON locale.
    """
    def __init__(self, data_path='local_database.json'):
        """
        Il costruttore inizializza la classe.
        - self.data_path: Il percorso del file JSON locale usato come database.
        - self.model: Conterrà il modello di machine learning una volta addestrato o caricato.
        - self.label_encoders: Dizionario per memorizzare gli "encoder".
        - self.feature_columns: La lista di colonne che il modello userà per fare previsioni.
        - self.model_path: Il percorso locale dove il modello viene salvato.
        """
        self.data_path = data_path
        self.model = None
        self.label_encoders = {}
        self.feature_columns = [
            'parking_id', 'hour', 'fascia_oraria', 'day_of_week', 'month', 'is_weekend',
            'previous_day_demand', 'previous_week_demand', 'mezzo_type_encoded'
        ]
        self.model_path = 'models/rf_parcheggi_local.pkl'
        self.mezzo_mapping = {
            'Bicicletta': 0,
            'Bicicletta Elettrica': 1,
            'Monopattino Elettrico': 2
        }
        self.mezzo_mapping_inv = {v: k for k, v in self.mezzo_mapping.items()}

        os.makedirs('models', exist_ok=True)
        os.makedirs('plots', exist_ok=True)

    def load_local_data(self):
        """Carica i dati dal file JSON locale."""
        try:
            with open(self.data_path, 'r') as f:
                data = json.load(f)
            return data
        except Exception as e:
            logger.error(f"Errore caricamento dati locali: {e}")
            return None

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

    def prepare_training_data(self, days_history=90):
        """
        Prepara i dati per addestrare il modello usando il dataset locale.
        1. Carica le corse dal file JSON.
        2. Crea un DataFrame e filtra i dati recenti.
        3. Estrae feature temporali (ora, giorno, mese).
        4. Calcola la domanda oraria per tipo di mezzo.
        5. Aggiunge feature come la domanda del giorno e della settimana precedenti.
        """
        try:
            data = self.load_local_data()
            if not data or 'rides' not in data:
                logger.error("Nessun dato 'rides' trovato nel file locale")
                return None

            rides_data = []
            for ride in data['rides']:
                try:
                    start_time_str = ride['startTime']
                    start_time = datetime.fromisoformat(start_time_str.replace('Z', '+00:00'))
                    rides_data.append({
                        'ride_id': ride.get('id', ''),
                        'parking_id': ride.get('parcheggioPartenza'),
                        'start_time': start_time,
                        'mezzo_tipo': ride.get('mezzoTipo', '')
                    })
                except Exception as e:
                    logger.warning(f"Errore parsing ride {ride.get('id', 'unknown')}: {e}")
                    continue

            if not rides_data:
                logger.error("Nessun dato di corsa valido trovato")
                return None

            df = pd.DataFrame(rides_data)
            df = df[df['start_time'].notna()]

            if days_history:
                cutoff_date = datetime.now(timezone.utc) - timedelta(days=days_history)
                df = df[df['start_time'] >= cutoff_date]

            if df.empty:
                logger.warning("Nessun dato dopo il filtro temporale")
                return None

            df['hour'] = df['start_time'].dt.hour
            df['day_of_week'] = df['start_time'].dt.dayofweek
            df['month'] = df['start_time'].dt.month
            df['is_weekend'] = df['day_of_week'].isin([5, 6]).astype(int)
            df['date'] = df['start_time'].dt.date

            hourly_demand = df.groupby(['date', 'parking_id', 'hour', 'mezzo_tipo']).size().reset_index(name='demand')
            hourly_demand['date'] = pd.to_datetime(hourly_demand['date'])
            hourly_demand['day_of_week'] = hourly_demand['date'].dt.dayofweek
            hourly_demand['month'] = hourly_demand['date'].dt.month
            hourly_demand['is_weekend'] = hourly_demand['day_of_week'].isin([5, 6]).astype(int)
            hourly_demand['fascia_oraria'] = hourly_demand['hour'].apply(self.get_fascia_oraria)
            hourly_demand['mezzo_type_encoded'] = hourly_demand['mezzo_tipo'].map(self.mezzo_mapping).fillna(0)

            hourly_demand = hourly_demand.sort_values(['parking_id', 'mezzo_type_encoded', 'date', 'hour'])
            hourly_demand['previous_day_demand'] = hourly_demand.groupby(['parking_id', 'hour', 'mezzo_type_encoded'])['demand'].shift(1).fillna(0)
            hourly_demand['previous_week_demand'] = hourly_demand.groupby(['parking_id', 'hour', 'mezzo_type_encoded'])['demand'].shift(7).fillna(0)

            hourly_demand = hourly_demand.dropna(subset=['demand'])
            logger.info(f"Dati finali preparati: {len(hourly_demand)} righe")
            return hourly_demand

        except Exception as e:
            logger.error(f"Errore preparazione dati training: {e}", exc_info=True)
            return None

    def train_model(self):
        """
        Addestra il modello di machine learning e lo salva in un file locale.
        1. Prepara i dati di training.
        2. Addestra un modello RandomForestRegressor.
        3. Valuta le performance (MAE, RMSE).
        4. Salva il modello, gli encoder e le performance in un file .pkl.
        """
        try:
            data = self.prepare_training_data()
            if data is None or data.empty:
                logger.error("Nessun dato disponibile per l'addestramento")
                return False

            missing_columns = set(self.feature_columns) - set(data.columns)
            if missing_columns:
                logger.error(f"Colonne mancanti nei dati: {missing_columns}")
                return False

            X = data[self.feature_columns]
            y = data['demand']

            for column in ['parking_id']:
                if column in X.columns:
                    self.label_encoders[column] = LabelEncoder()
                    X.loc[:, column] = self.label_encoders[column].fit_transform(X[column])

            X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

            self.model = RandomForestRegressor(n_estimators=100, max_depth=10, min_samples_split=5, random_state=42, n_jobs=-1)
            self.model.fit(X_train, y_train)

            y_pred = self.model.predict(X_test)
            mae = mean_absolute_error(y_test, y_pred)
            rmse = np.sqrt(mean_squared_error(y_test, y_pred))
            logger.info(f"Performance - MAE: {mae:.2f}, RMSE: {rmse:.2f}")

            model_data = {
                'model': self.model,
                'encoders': self.label_encoders,
                'feature_columns': self.feature_columns,
                'performance': {'mae': mae, 'rmse': rmse},
                'training_date': datetime.now().isoformat()
            }
            joblib.dump(model_data, self.model_path)
            logger.info(f"Modello salvato in: {self.model_path}")
            
            self.plot_model_performance(model_data)
            return True

        except Exception as e:
            logger.error(f"Errore addestramento modello: {e}", exc_info=True)
            return False

    def load_model(self):
        """Carica il modello dal file locale."""
        try:
            if not os.path.exists(self.model_path):
                logger.error("Modello non trovato localmente")
                return False
            model_data = joblib.load(self.model_path)
            self.model = model_data['model']
            self.label_encoders = model_data['encoders']
            logger.info("Modello caricato da file locale")
            return True
        except Exception as e:
            logger.error(f"Errore caricamento modello: {e}")
            return False

    def predict_demand(self, parking_id, target_time, mezzo_type_encoded=0):
        """
        Prevede la domanda per un parcheggio, ora e tipo di mezzo.
        """
        try:
            if self.model is None and not self.load_model():
                return None

            features = {
                'parking_id': parking_id,
                'hour': target_time.hour,
                'fascia_oraria': self.get_fascia_oraria(target_time.hour),
                'day_of_week': target_time.weekday(),
                'month': target_time.month,
                'is_weekend': 1 if target_time.weekday() in [5, 6] else 0,
                'previous_day_demand': 0, # Semplificato per previsioni future
                'previous_week_demand': 0, # Semplificato per previsioni future
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

    def get_current_vehicles(self, parking_id, mezzo_tipo=None):
        """Recupera il numero di veicoli disponibili in un parcheggio dal dataset locale."""
        try:
            data = self.load_local_data()
            if not data or 'mezzi' not in data:
                return 0
            
            vehicles = data['mezzi']
            count = sum(1 for mezzo in vehicles
                        if mezzo.get('id_parcheggio') == parking_id
                        and mezzo.get('stato') == 'Disponibile'
                        and (mezzo_tipo is None or mezzo.get('tipo') == mezzo_tipo))
            return count
        except Exception as e:
            logger.error(f"Errore recupero veicoli: {e}")
            return 0

    def generate_recommendation(self, predicted_demand, parking_id, mezzo_tipo):
        """Genera un suggerimento pratico basato sulla previsione per un tipo di mezzo."""
        current_vehicles = self.get_current_vehicles(parking_id, mezzo_tipo)
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

    def forecast(self, hours_ahead: int = 24):
        """Esegue previsioni per tutti i parcheggi e tipi di mezzo per le prossime ore."""
        try:
            forecasts = []
            current_time = datetime.now()
            local_data = self.load_local_data()
            if not local_data or 'parcheggi' not in local_data:
                logger.error("Dati parcheggi non trovati")
                return None

            parking_list = local_data['parcheggi']

            for hour_offset in range(hours_ahead):
                target_time = current_time + timedelta(hours=hour_offset)
                hourly_forecasts = []
                for parking in parking_list:
                    parking_id = parking.get('id')
                    parking_name = parking.get('nome')
                    for mezzo_tipo, mezzo_code in self.mezzo_mapping.items():
                        predicted_demand = self.predict_demand(parking_id, target_time, mezzo_code)
                        if predicted_demand is None:
                            continue
                        recommendation_data = self.generate_recommendation(predicted_demand, parking_id, mezzo_tipo)
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
            logger.error(f"Errore predizione: {e}", exc_info=True)
            return None

    def get_optimization_suggestions(self, hours_ahead: int = 6):
        """Raccoglie i suggerimenti dove è necessario un intervento."""
        try:
            forecast_data = self.forecast(hours_ahead)
            if not forecast_data:
                return {"suggestions": [], "total_suggestions": 0}

            suggestions = []
            for hour_data in forecast_data['forecasts']:
                for prediction in hour_data['predictions']:
                    if not prediction['is_optimal']:
                        suggestions.append({
                            'parking_id': prediction['parking_id'],
                            'parking_name': prediction['parking_name'],
                            'mezzo_tipo': prediction['mezzo_tipo'],
                            'suggested_action': prediction['action_text'],
                        })
            return {
                "suggestions": suggestions,
                "total_suggestions": len(suggestions),
                "forecast_data": forecast_data
            }
        except Exception as e:
            logger.error(f"Errore generazione suggerimenti: {e}", exc_info=True)
            return {"suggestions": [], "total_suggestions": 0}

    def plot_predictions(self, forecast_data):
        """
        Crea e salva i grafici delle previsioni (linee, barre, heatmap).
        """
        if not forecast_data:
            logger.warning("Nessun dato di forecast per generare i plot.")
            return

        predictions = []
        for hour_data in forecast_data['forecasts']:
            for pred in hour_data['predictions']:
                predictions.append({**pred, 'hour': hour_data['hour'], 'fascia': hour_data['fascia_oraria']})
        
        df_pred = pd.DataFrame(predictions)
        if df_pred.empty:
            logger.warning("DataFrame delle predizioni vuoto.")
            return

        def save_plot(filename):
            plt.savefig(f"plots/{filename}", bbox_inches='tight')

        # Line Plot
        plt.figure(figsize=(14, 7))
        sns.lineplot(data=df_pred, x='hour', y='predicted_demand', hue='parking_name', style='mezzo_tipo', palette='viridis', marker='o')
        plt.title("Andamento Domanda Prevista (Locale)", fontsize=16)
        plt.xlabel("Ora del giorno"), plt.ylabel("Domanda Prevista")
        plt.xticks(range(24)), plt.grid(True, alpha=0.3)
        plt.legend(title="Legenda", bbox_to_anchor=(1.05, 1), loc='upper left')
        plt.tight_layout(), save_plot("line_plot_local.png"), plt.close()

        # Bar Plot
        plt.figure(figsize=(12, 7))
        sns.barplot(data=df_pred, x='parking_name', y='predicted_demand', hue='mezzo_tipo', palette='muted')
        plt.title("Domanda Media Prevista (Locale)", fontsize=16)
        plt.xlabel("Parcheggio"), plt.ylabel("Domanda Media")
        plt.xticks(rotation=45, ha='right')
        plt.legend(title="Tipo di Mezzo"), plt.tight_layout(), save_plot("bar_plot_local.png"), plt.close()

        # Heatmap
        fascia_labels = {0: 'Notte', 1: 'Mattina', 2: 'Pomeriggio', 3: 'Sera'}
        df_pred['fascia_label'] = df_pred['fascia'].map(fascia_labels)
        heatmap_data = df_pred.pivot_table(index=['parking_name', 'mezzo_tipo'], columns='fascia_label', values='predicted_demand', aggfunc='mean', observed=False)
        heatmap_data = heatmap_data.reindex(columns=['Notte', 'Mattina', 'Pomeriggio', 'Sera'])
        
        plt.figure(figsize=(10, 8))
        sns.heatmap(heatmap_data, annot=True, fmt=".1f", cmap="YlGnBu", cbar_kws={'label': 'Domanda Media'})
        plt.title("Domanda Media per Fascia Oraria (Locale)", fontsize=16)
        plt.xlabel("Fascia Oraria"), plt.ylabel("Parcheggio e Tipo Mezzo")
        plt.tight_layout(), save_plot("heatmap_plot_local.png"), plt.close()
        logger.info("Plot delle previsioni salvati in 'plots/'.")

    def plot_model_performance(self, model_data):
        """Genera e salva il grafico delle performance del modello."""
        perf = model_data.get('performance', {'mae': 0, 'rmse': 0})
        metrics, values = list(perf.keys()), list(perf.values())
        
        plt.figure(figsize=(6, 4))
        sns.barplot(x=metrics, y=values, palette='Set2')
        plt.title("Performance Modello Locale"), plt.ylabel("Valore")
        plt.tight_layout()
        plt.savefig("plots/model_performance_local.png")
        plt.close()
        logger.info("Plot delle performance salvato in 'plots/'.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
    predictor = DistribuzioneOttimaleLocal()

    print("Addestramento modello locale...")
    if predictor.train_model():
        print("\nModello addestrato con successo!")
        
        print("\nGenerazione suggerimenti...")
        suggestions_data = predictor.get_optimization_suggestions(hours_ahead=24)
        
        if suggestions_data and suggestions_data['total_suggestions'] > 0:
            print(f"Trovati {suggestions_data['total_suggestions']} suggerimenti di ottimizzazione.")
            for i, suggestion in enumerate(suggestions_data['suggestions'][:5]):
                print(f" - {suggestion['suggested_action']} al parcheggio '{suggestion['parking_name']}'")
        else:
            print("Nessun suggerimento di ottimizzazione necessario.")

        print("\nGenerazione grafici delle previsioni...")
        predictor.plot_predictions(suggestions_data.get('forecast_data'))
        print("Grafici salvati nella cartella 'plots'.")
    else:
        print("\nErrore nell'addestramento del modello locale.")
