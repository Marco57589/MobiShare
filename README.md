![Logo](https://www.uniupo.it/themes/custom/uniupo_2020/uniupo-logo.svg)

## Università del Piemonte Orientale - Corso di Laurea in Informatica 
(A.A. 2024/2025)
### MF0244 - Progettazione e Implementazione di Sistemi Software in Rete
### MF9781 - Applicazioni Intelligenti

---

## Descrizione del Progetto

**MobiShare** è una piattaforma per la gestione di un servizio di noleggio di mezzi sostenibili (Biciclette e monopattini).
Il sistema è composto da un'applicazione web per gli utenti e un pannello di controllo per i gestori, supporta funzionalità 
IOT mediante un broker MQTT (iot_bridge) e funzionalità di intelligenza artificiale (Agenti, Modelli di Machine Learning e FaceRecognition) (ai_bridge).

---

## Componenti del Gruppo (Gruppo 12)

- **Baselice Asia** - 20049304
- **Bistoncini Sara** - 20050074
- **Duratti Matteo** - 20050372
- **Papa Marco Yuri** - 20051241

---

## Architettura e Tecnologie Utilizzate

### Frontend & Web App
- **Tecnologia:** Node.js, Express
- **Styling:** Bootstrap, CSS
- **Funzionalità:**
    - Autenticazione e gestione profilo.
    - Visualizzazione mappa con parcheggi e mezzi disponibili.
    - Noleggio e restituzione dei mezzi.
    - Storico corse e sistema di punti fedeltà.
    - Ricarica del credito tramite API di pagamento (Stripe).
    - Assistente Chatbot basato su Agno.
    - Verifica biometrica per i pagamenti (opzionale)
    - Modello ML per la gestione dei mezzi nei parcheggi

### Backend (WebAPP)
- **Tecnologia:** Node.js, Express
- **Database:** Google Firestore (NoSQL)
- **Autenticazione:** Firebase Authentication

### AI Bridge (Python)
- **Tecnologia:** Python, Flask, Google Generative AI (Gemini)
- **Funzionalità:**
    - **Agente:** Un agente Agno che utilizza dei tool per rispondere alle domande degli utenti (clienti/gestori).
    - **FaceRecognition:** Riconoscimento facciale per la verifica aggiuntiva nei pagamenti.
    - **Machine Learning:** Un modello Random Forest per suggerire la disposizione dei mezzi nei parcheggi.

### IoT Bridge (MQTT)
- **Tecnologia:** MQTT (broker Aedes)
- **Funzionalità:**
    - **Comunicazione in tempo reale:** Gestisce la comunicazione tra il server e i dispositivi IoT.
    - **Comandi Remoti:** Permette ai gestori di bloccare/sbloccare i mezzi da remoto.
    - **Aggiornamenti di Stato:** Riceve e aggiorna lo stato dei mezzi (es. livello batteria, posizione).

---

## Funzionalità Principali

### Per l'Utente
- **Noleggio mezzi**
- **Sistema di pagamento con Stripe**
- **Programma Fedeltà 'Punti Mobilità'**
- **Agente AI**
- **Sistema Feedback**

### Per il Gestore
- **Dashboard di Controllo**
- **Analisi Avanzata**
- **Posizionamento dei mezzi**
- **Feedback degli utenti**
- **Gestione Utenti**
- **Previsione Disponibilità**
- **Agente AI Avanzato**

---

## Installazione e Avvio

### Prerequisiti
- Node.js (versione 20.x o superiore)
- Python (versione 3.9 o superiore)
- Un account Google Cloud con Firestore e Firebase abilitati.
- Credenziali per Google Generative AI (Gemini).
- Credenziali Stripe (Publishable Key e Secret Key).

### 1. Clonazione del Repository
```bash
git clone https://gitlab.di.unipmn.it/pissir24-25/aa24-25-gruppo12.git
cd aa24-25-gruppo12/ServerNode
```

### 2. Configurazione Variabili d'Ambiente
Crea un file `.env` nella directory principale (`/ServerNode`) e compila le seguenti variabili:

```
NODE_ENV=development

# Server configuration
PORT=3000
SESSION_SECRET=mobishare-session-secret
BASE_URL=http://localhost:3000

FIREBASE_PROJECT_ID='...'
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\......\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL="......."
FIREBASE_DATABASE_URL=

# Firebase Web SDK Configuration (Client-side)
FIREBASE_API_KEY=AIza.....
FIREBASE_AUTH_DOMAIN=.....
FIREBASE_STORAGE_BUCKET=.....
FIREBASE_MESSAGING_SENDER_ID=...
FIREBASE_APP_ID=......
FIREBASE_MEASUREMENT_ID=G-......

# MQTT Configuration
MQTT_PORT=1883
MQTT_WS_PORT=9001
MQTT_HOST=localhost
MQTT_SERVER_USERNAME=server-username
MQTT_SERVER_PASSWORD=server-password

MQTT_DASHBOARD_PASSWORD=dashboard123
MQTT_EMULATOR_PASSWORD=emulator123

#STRIPE
STRIPE_PUBLISHABLE_KEY="pk_test_..."
STRIPE_SECRET_KEY="sk_test_..."

#GEMINI
GEMINI_API_KEY="AIza....."
GOGGLE_API_KEY="AIza....."
```

### 3. Configurazione del Backend (Node.js)
1.  **Installa le dipendenze:**
    ```bash
    npm install
    ```
2.  **Configura le credenziali Firebase:**
    - Scarica il file `serviceAccountKey.json` dalla tua console Firebase.
    - Inseriscilo nella directory principale (`/ServerNode`).
3.  **Avvia il server:**
    ```bash
    node server.js
    ```
    Il server sarà in ascolto su `http://localhost:3000`.

### 4. Configurazione dell'AI Bridge (Python)
1.  **Crea un ambiente virtuale e installa le dipendenze:**
    ```bash
    cd ai_bridge
    python -m venv venv
    source venv/bin/activate  # Su Windows: venv\Scripts\activate
    pip install -r requirements.txt
    ```
2.  **Avvia il server FastAPI:**
    ```bash
    cd ai_bridge
    uvicorn app:app --reload --port 7777
    ```
    Il server sarà in ascolto su `http://localhost:7777`.

### 5. Popolamento del Database e Addestramento Modello ML (Opzionale)

#### A. Generazione Dati di Esempio
Per generare dati fittizi (utenti, corse, mezzi), puoi utilizzare gli script di popolamento.

- **Per Firestore (attenzione ai limiti di scrittura):**
  ```bash
  node db_population.js
  ```
- **Per il database locale (consigliato per test ML):**
  ```bash
  node ai_bridge/service/ML/db_population_local.js
  ```
  Questo creerà un file `local_database.json` nella directory `ai_bridge/service/ML`.

#### B. Addestramento del Modello di Machine Learning
Dopo aver generato il database locale, puoi addestrare il modello di previsione della domanda.

1.  **Assicurati di essere nella directory `ai_bridge` con l'ambiente virtuale attivo.**
2.  **Esegui lo script di addestramento:**
    ```bash
    python -m service.ML.rf_predictor_local
    ```
    Lo script eseguirà le seguenti operazioni:
    - Caricherà i dati da `local_database.json`.
    - Addestrerà un modello RandomForest.
    - Salverà il modello addestrato in `ai_bridge/models/rf_parcheggi_local.pkl`.
    - Genererà e salverà dei grafici di analisi nella directory `ai_bridge/plots/`.

Le immagini risultanti (es. `line_plot_local.png`, `heatmap_plot_local.png`) saranno disponibili nella cartella `ServerNode/ai_bridge/plots`.

---

## Struttura del Repository

- **/ServerNode**: Directory principale del progetto.
    - **/views**: File EJS per il rendering delle pagine web.
    - **/public**: Asset statici (CSS, JavaScript, immagini).
     - **/iot-bridge**: Implementazione del broker MQTT e logica IoT.
         - `start.js`: File l'avvio dei servizi MQTT.
     - **/ai_bridge**: Servizio Python per l'intelligenza artificiale.
         - **/service**: Implementazione dei servizi AI.
             - **/agent**: Implementazione dell'agente AI e dei suoi strumenti.
             - **/ML**: Modello di machine learning.
               - **/plots**: Immagini generate dall'analisi del modello ML.
               - **/models**: Modelli di machine learning salvati.
               - `rf_predictor_local.py`: File per l'esecuzione locale del modello di RandomForest.
               - `db_population_local.js`: File per la creazione di un database locale per addestrare il modello.
           - **/FR**: Implementazione FaceRecognition.
           - `app.py`: File principale per l'avvio dei servizi AI.
     - `server.js`: File principale per l'avvio del server Node.js.
     - `server-emulator.js`: File per l'avvio dell'emulatore web MQTT.
     - `db_population.js`: Script per popolare il database Firestore.
---

## Licenza

Copyright (c) 2025, Università del Piemonte Orientale.

Questo progetto è distribuito sotto la licenza **GNU GPLv2.0**. Per maggiori dettagli, consulta il file `LICENSE`.
