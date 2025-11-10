# Guida all'Esecuzione del Progetto MobiShare

Questo file contiene le istruzioni per avviare correttamente tutti i componenti della piattaforma MobiShare.

---

## 1. Prerequisiti

Assicurarsi di avere installato:
- **Node.js**: Versione 20.x o successiva.
- **Python**: Versione 3.9 o successiva.
- **Cmake**
- **Java**: Versione 8 o successiva (necessario solo per l'emulatore Hue).
---

## 2. Configurazione

Prima di avviare i server, è necessario configurare le variabili d'ambiente.

1.  **Inserire i file `.env e serviceAccountKey.json`**: Nella directory principale del progetto (`/ServerNode`)

---

## 3. Installazione delle Dipendenze

È necessario installare le dipendenze per il server principale (Node.js) e per il servizio di intelligenza artificiale (Python).

- **Per il Server Node.js**:
  Aprire un terminale nella directory principale (`/ServerNode`) ed eseguire:
  ```bash
  npm install
  ```

- **Per l'AI Bridge (Python)**:
  Aprire un secondo terminale, navigare nella sottodirectory `ai_bridge` ed eseguire i seguenti comandi per creare un ambiente virtuale e installare le librerie:
  ```bash
  cd ai_bridge
  python -m venv venv
  source venv/bin/activate  # Su Windows: venv\Scripts\activate
  pip install -r requirements.txt
  ```

---

## 4. Avvio dei Servizi

Per l'avvio é necessario seguire questa sequenza (alcuni servizi non si avvieranno se non verranno rilevati 
i servizi da cui dipendono).

### A. Avvio del Server Principale (Node.js)
Nel primo terminale (directory `/ServerNode`), avviare il server web:
```bash
node server.js
```
Il server sarà in ascolto su `http://localhost:3000`.

### B. Avvio dell'AI Bridge (Python)(Solo se si vuole testare o usare funzionalià AI)
Nel secondo terminale (directory `ai_bridge` con ambiente virtuale attivo), avviare il servizio AI:
```bash
uvicorn app:app --reload --port 7777
```
Il servizio sarà in ascolto su `http://localhost:7777`.

### C. Avvio del Broker MQTT (JS) (Solo se si vuole testare o usare funzionalià MQTT)
Aprire un terzo terminale e avviare il broker MQTT per la gestione IoT:
```bash
node iot-bridge/start.js
```
Per simulare i dispositivi IoT (i mezzi), è possibile utilizzare i seguenti emulatori. 

 ### Emulatore Web
 Questo emulatore fornisce un'interfaccia web per visualizzare lo stato dei mezzi e inviare comandi.
 - In un nuovo terminale, eseguire:
   ```bash
   node server-emulator.js
   ```
 - Aprire il browser all'indirizzo `http://localhost:8080`.

 ### Emulatore Hue (JAVA)
 Emulatore mostratoci a lezione
 1.  **Avviare l'emulatore**:
     ```bash
     java -jar iot-bridge/Hue-Emulator/HueEmulator-v0.8.jar
     ```
 2.  **Configurazione**:
     - All'avvio, impostare la porta (HTTP Port) su `8300`.
     - Fare il link con il server MQTT: cliccare sul tastone bianco e attendere.
     - Attendere qualche secondo e successivamente caricare il json generato dal server con le luci: `File -> LoadConfig` e selezionare il file `hue-emulator.json` generato nella directory dell'emulatore.
     - Riavviare Hue Emulator (a volte non prende live le modifiche del json), impostare la porta e rifare il link.
---

## 5. Credenziali di Accesso di Default

È possibile registrare un nuovo account o utilizzare le seguenti credenziali per accedere:

- **Account Gestore**:
  - **Email**: `marco@marco.marco`
  - **Password**: `canecane`

- **Account Utente**:
  - **Email**: `sara@gmail.com`
  - **Password**: `password`

---

## 6. Operazioni Opzionali

### Popolamento del Database
Per generare corse:
```bash
node db_population.js
```

### Addestramento Modello Machine Learning
Per addestrare e usare il modello di ML locale (richiede la generazione del database locale):
```bash
# 1. Genera il DB locale
node ai_bridge/service/ML/db_population_local.js

# 2. Esegui l'addestramento (nel terminale dell'AI Bridge)
python -m service.ML.rf_predictor_local
```
I grafici risultanti saranno salvati nella cartella `ai_bridge/plots/`.
