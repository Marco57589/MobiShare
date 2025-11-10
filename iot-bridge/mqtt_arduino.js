#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <IRremoteESP8266.h>
#include <IRrecv.h>
#include <IRutils.h>

// ======= CONFIGURAZIONE =======
const char* ssid = "Asia's Galaxy A53 5G";
const char* password = "qhsv9957";
const char* mqtt_server = "10.68.44.82";
const int mqtt_port = 1883;
const char* mqtt_user = "arduino";
const char* mqtt_password = "arduino123";

// ======= CONFIGURAZIONE IR =======
const uint16_t RECV_PIN = 4;
IRrecv irrecv(RECV_PIN);
decode_results results;

// ======= CONFIGURAZIONE LED =======
const int LED_ROSSO = D5;
const int LED_GIALLO = D6;
const int LED_VERDE = D7;

// ======= CONFIGURAZIONE POTENZIOMETRO =======
const int POTENZIOMETRO_PIN = A0;
int batteriaCorrente = -1;      // Batteria letta dal potenziometro
bool batteriaInAttesa = false;  // Se c'è una batteria letta in attesa di pubblicazione

// ======= MAPPING TASTI IR =======
const uint32_t TASTI_IR[] = {
  0xFF6897,  // 0 deselezione mezzo
  0xFF30CF,  // 1
  0xFF18E7,  // 2
  0xFF7A85,  // 3
  0xFF10EF,  // 4
  0xFF38C7,  // 5
  0xFF5AA5,  // 6
  0xFF42BD,  // 7
  0xFF4AB5,  // 8
  0xFF52AD,  // 9
  0xFF9867,  // pubblicazione batteria mezzo
  0xFFB04F,  // lettura potenziometro
  0xFF22DD,  // Non disponibile
  0xFF02FD,  // In corso
  0xFFC23D,  // Disponibile
  0xFFE21D   // Cambio visualizzazione LED
};

// ======= STATI CONNESSIONE =======
enum StatoConnessione {
  STATO_WIFI,
  STATO_MQTT,
  STATO_PRONTO,
  STATO_SELEZIONE
};

enum VisualizzazioneLED {
  VISUALIZZA_BATTERIA,
  VISUALIZZA_STATO
};

VisualizzazioneLED visualizzazioneCorrente = VISUALIZZA_BATTERIA;
bool visualizzazioneCambiata = false;

StatoConnessione statoConnessione = STATO_WIFI;
unsigned long lastStatoLED = 0;
bool ledStato = false;

WiFiClient espClient;
PubSubClient client(espClient);

unsigned long lastRequest = 0;
const unsigned long REQUEST_INTERVAL = 30000;  // 30 secondi
bool listaRicevuta = false;
DynamicJsonDocument docLista(1024);  // Documento per memorizzare la lista
int mezzoSelezionato = -1;           // -1 significa nessun mezzo selezionato
//lampeggio sequenziale
bool lampeggioAttivo = false;
unsigned long lastLampeggio = 0;
int ledCorrente = 0;

// ======= GESTIONE LED CONNESSIONE WIFI/MQTT =======
void gestisciLEDConnessione() {
  if (statoConnessione == STATO_SELEZIONE) return;

  unsigned long now = millis();
  unsigned long interval = 0;

  switch (statoConnessione) {
    case STATO_WIFI:
      interval = 500;  // Lampeggio rapido per WiFi
      break;
    case STATO_MQTT:
      interval = 1000;  // Lampeggio lento per MQTT
      break;
    case STATO_PRONTO:
      interval = 1000;  // Lampeggio lento per PRONTO (verde)
      break;
    default:
      return;
  }

  if (now - lastStatoLED >= interval) {
    lastStatoLED = now;
    ledStato = !ledStato;

    switch (statoConnessione) {
      case STATO_WIFI:
      case STATO_MQTT:
        // Usa solo il LED GIALLO per WiFi/MQTT
        digitalWrite(LED_GIALLO, ledStato ? HIGH : LOW);
        digitalWrite(LED_ROSSO, LOW);
        digitalWrite(LED_VERDE, LOW);
        break;
      case STATO_PRONTO:
        // Usa solo il LED VERDE per PRONTO
        digitalWrite(LED_VERDE, ledStato ? HIGH : LOW);
        digitalWrite(LED_ROSSO, LOW);
        digitalWrite(LED_GIALLO, LOW);
        break;
    }
  }
}

// ======= LEGGI BATTERIA DAL POTENZIOMETRO =======
void leggiBatteriaPotenziometro() {
  int valoreRaw = analogRead(POTENZIOMETRO_PIN);
  batteriaCorrente = map(valoreRaw, 0, 1023, 0, 100);
  batteriaInAttesa = true;

  Serial.printf("📊 BATTERIA LETTA: %d%%\n", batteriaCorrente);
  Serial.println("   ✅ Batteria letta correttamente");
  Serial.println("   📤 Premi EQ per pubblicare questa batteria");

  // Feedback visivo - lampeggio giallo
  for (int i = 0; i < 2; i++) {
    digitalWrite(LED_GIALLO, HIGH);
    delay(150);
    digitalWrite(LED_GIALLO, LOW);
    delay(150);
  }
}

// ======= PUBBLICA BATTERIA =======
void pubblicaBatteria() {
  if (mezzoSelezionato == -1) {
    Serial.println("❌ Nessun mezzo selezionato");
    lampeggiaLED();
    return;
  }

  // ⚡ CONTROLLO CONNESSIONE
  if (!client.connected()) {
    Serial.println("❌ MQTT non connesso, skip pubblicazione");
    lampeggiaLED();
    return;
  }

  if (!batteriaInAttesa) {
    Serial.println("❌ Nessuna batteria letta - Premi prima POWER per leggere il potenziometro");
    lampeggiaLED();
    return;
  }

  Serial.printf("📤 PUBBLICAZIONE BATTERIA: %d%% per mezzo %d\n", batteriaCorrente, mezzoSelezionato);

  String azioneComando;
  if (batteriaCorrente < 25) {
    azioneComando = "blocca";
    Serial.println("🔴 Batteria < 25% - Stato impostato a 'Non disponibile'");
  } else {
    azioneComando = "sblocca";
    Serial.println("🟢 Batteria >= 25% - Stato impostato a 'Disponibile'");
  }

  String statoCorrente = "sconosciuto";
  bool statoCambiato = false;

  // Aggiorna la lista locale
  if (listaRicevuta && docLista.containsKey("vehicles")) {
    JsonArray vehicles = docLista["vehicles"];
    for (JsonObject vehicle : vehicles) {
      if (vehicle["id"] == mezzoSelezionato) {
        const char* stato = vehicle["stato"];
        if (stato != nullptr) {
          statoCorrente = String(stato);
        }

        String nuovoStatoPrevisto = (batteriaCorrente < 25) ? "Non disponibile" : "Disponibile";
        if (statoCorrente != nuovoStatoPrevisto) {
          statoCambiato = true;
          Serial.printf("🔄 Cambio stato necessario: '%s' → '%s'\n", statoCorrente.c_str(), nuovoStatoPrevisto.c_str());
        }

        vehicle["batteria"] = batteriaCorrente;
        break;
      }
    }
  }

  // Pubblica su MQTT
  StaticJsonDocument<96> doc;
  doc["mezzoId"] = mezzoSelezionato;
  doc["batteria"] = batteriaCorrente;
  doc["timestamp"] = millis();
  doc["userId"] = mqtt_user;
  doc["source"] = "arduino";
  doc["action"] = "batteria";

  String jsonString;
  serializeJson(doc, jsonString);

  if (client.publish("mobishare/mezzi/comando", jsonString.c_str())) {
    Serial.println("✅ Batteria pubblicata con successo!");

    // Feedback visivo - lampeggio verde
    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_VERDE, HIGH);
      delay(100);
      digitalWrite(LED_VERDE, LOW);
      delay(100);
    }

    aggiornaLEDInBaseAllaVisualizzazione();
    batteriaInAttesa = false;  // Reset dello stato

  } else {
    Serial.println("❌ Errore pubblicazione batteria");
    lampeggiaLED();
  }
  if (statoCambiato) {
    pubblicaStato(azioneComando);
  }
}

// ======= PUBBLICA STATO =======
void pubblicaStato(String azione) {
  if (mezzoSelezionato == -1) {
    Serial.println("❌ Nessun mezzo selezionato per inviare comando");
    return;
  }

  if (!client.connected()) {
    Serial.println("❌ MQTT non connesso, skip comando");
    return;
  }

  String statoDisplay = "";
  if (azione == "blocca" || azione == "Non disponibile") statoDisplay = "Non disponibile";
  else if (azione == "sblocca" || azione == "Disponibile") statoDisplay = "Disponibile";
  else if (azione == "in_uso") statoDisplay = "In uso";
  else statoDisplay = azione;

  // **AGGIORNA PRIMA LA LISTA LOCALE**
  aggiornaStatoLocale(mezzoSelezionato, statoDisplay);

  StaticJsonDocument<128> docStato;
  docStato["mezzoId"] = mezzoSelezionato;
  docStato["action"] = azione;
  docStato["timestamp"] = millis();
  docStato["source"] = "arduino";

  String jsonStringComando;
  serializeJson(docStato, jsonStringComando);

  if (client.publish("mobishare/mezzi/comando", jsonStringComando.c_str())) {
    Serial.printf("✅ Stato '%s' pubblicato per mezzo %d\n", statoDisplay.c_str(), mezzoSelezionato);

    // Feedback visivo
    for (int i = 0; i < 3; i++) {
      digitalWrite(LED_VERDE, HIGH);
      delay(100);
      digitalWrite(LED_VERDE, LOW);
      delay(100);
    }
  } else {
    Serial.println("❌ Errore pubblicazione stato");
  }
}

// ======= AGGIORNA LISTA LOCALE CON NUOVO STATO =======
void aggiornaStatoLocale(int mezzoId, const String& nuovoStato) {
  if (listaRicevuta && docLista.containsKey("vehicles")) {
    JsonArray vehicles = docLista["vehicles"];
    bool aggiornato = false;

    for (JsonObject vehicle : vehicles) {
      if (vehicle["id"] == mezzoId) {
        const char* vecchioStato = vehicle["stato"] | "Sconosciuto";

        vehicle["stato"] = nuovoStato;
        aggiornato = true;
        
        Serial.printf("🔄 Lista locale aggiornata - Mezzo %d: %s → %s\n", 
                     mezzoId, vecchioStato, nuovoStato);

        if (mezzoSelezionato == mezzoId) {
          aggiornaLEDInBaseAllaVisualizzazione();
        }
        break;
      }
    }

    if (!aggiornato) {
      Serial.printf("⚠ Mezzo %d non trovato nella lista locale per aggiornamento stato\n", mezzoId);
    }
  } else {
    Serial.println("⚠ Lista locale non disponibile per aggiornamento stato");
  }
}

// ======= LAMPEGGIO SEQUENZIALE PER MEZZI NON ELETTRICI =======
void lampeggiaLEDSequenziale() {
  if (!lampeggioAttivo) return;

  unsigned long now = millis();
  if (now - lastLampeggio >= 300) {
    lastLampeggio = now;

    // Spegni tutti i LED
    digitalWrite(LED_ROSSO, LOW);
    digitalWrite(LED_GIALLO, LOW);
    digitalWrite(LED_VERDE, LOW);

    // Accendi il LED corrente
    switch (ledCorrente) {
      case 0: digitalWrite(LED_ROSSO, HIGH); break;
      case 1: digitalWrite(LED_GIALLO, HIGH); break;
      case 2: digitalWrite(LED_VERDE, HIGH); break;
    }

    // Passa al prossimo LED
    ledCorrente = (ledCorrente + 1) % 3;
  }
}

// ======= GESTIONE LED BATTERIA =======
void aggiornaLEDBatteria(int batteria) {
  // Spegni tutti i LED
  digitalWrite(LED_ROSSO, LOW);
  digitalWrite(LED_GIALLO, LOW);
  digitalWrite(LED_VERDE, LOW);

  if (batteria < 25) {
    digitalWrite(LED_ROSSO, HIGH);
    Serial.printf("🔴 Batteria: %d%% - LED ROSSO\n", batteria);
  } else if (batteria >= 25 && batteria <= 75) {
    digitalWrite(LED_GIALLO, HIGH);
    Serial.printf("🟡 Batteria: %d%% - LED GIALLO\n", batteria);
  } else if (batteria > 75) {
    digitalWrite(LED_VERDE, HIGH);
    Serial.printf("🟢 Batteria: %d%% - LED VERDE\n", batteria);
  }
}

// ======= AGGIORNA LED IN BASE ALLO STATO =======
void aggiornaLEDStato(const String& stato) {
  // Ferma il lampeggio sequenziale
  lampeggioAttivo = false;
  
  // Spegni tutti i LED prima
  digitalWrite(LED_ROSSO, LOW);
  digitalWrite(LED_GIALLO, LOW);
  digitalWrite(LED_VERDE, LOW);

  if (stato == "Disponibile") {
    // VERDE + GIALLO per Disponibile
    digitalWrite(LED_VERDE, HIGH);
    digitalWrite(LED_GIALLO, HIGH);
    Serial.println("💚💛 LED: VERDE + GIALLO - Mezzo Disponibile");
  } 
  else if (stato == "In uso" || stato == "In Corso") {
    // TUTTI I LED per In uso
    digitalWrite(LED_ROSSO, HIGH);
    digitalWrite(LED_GIALLO, HIGH);
    digitalWrite(LED_VERDE, HIGH);
    Serial.println("❤️💛💚 LED: TUTTI ACCESI - Mezzo In uso");
  }
  else if (stato == "Non disponibile") {
    // GIALLO + ROSSO per Non disponibile
    digitalWrite(LED_GIALLO, HIGH);
    digitalWrite(LED_ROSSO, HIGH);
    Serial.println("💛❤️ LED: GIALLO + ROSSO - Mezzo Non disponibile");
  }
  else {
    Serial.printf("⚠️ Stato non riconosciuto per LED: %s\n", stato.c_str());
    // Stato sconosciuto - lampeggio di errore
    lampeggiaLED();
  }
}

// ======= LAMPEGGIO LED (batteria non disponibile) =======
void lampeggiaLED() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_ROSSO, HIGH);
    digitalWrite(LED_GIALLO, HIGH);
    digitalWrite(LED_VERDE, HIGH);
    delay(200);
    digitalWrite(LED_ROSSO, LOW);
    digitalWrite(LED_GIALLO, LOW);
    digitalWrite(LED_VERDE, LOW);
    delay(200);
  }
}

// ======= GESTIONE TASTI IR =======
void gestisciTastoIR(uint32_t codice) {
  Serial.printf("\n🎯 Codice IR ricevuto: 0x%X\n", codice);

  if (codice == TASTI_IR[0]) {
    if (mezzoSelezionato != -1) {
      Serial.printf("❌ Mezzo %d deselezionato\n", mezzoSelezionato);
      mezzoSelezionato = -1;
      lampeggioAttivo = false;
      batteriaInAttesa = false;  // Reset batteria in attesa
      batteriaCorrente = -1;
      lastStatoLED = millis();
      ledStato = false;
      digitalWrite(LED_ROSSO, LOW);
      digitalWrite(LED_GIALLO, LOW);
      digitalWrite(LED_VERDE, LOW);
      Serial.println("✅ Sistema pronto - Seleziona un nuovo mezzo");
    } else {
      Serial.println("ℹ️ Nessun mezzo selezionato");
    }
    return;
  }

  if (codice == TASTI_IR[10]) {
    Serial.println("📤 Tasto PUBBLICA batteria premuto");
    pubblicaBatteria();
    return;
  }


  if (codice == TASTI_IR[11]) {
    Serial.println("📊 Tasto LEGGI batteria premuto");
    leggiBatteriaPotenziometro();
    return;
  }

  if (codice == TASTI_IR[12]){
    Serial.println("📊 Tasto stato: Non disponibile premuto");
    pubblicaStato("blocca");
    return;
  }

  if (codice == TASTI_IR[13]){
    Serial.println("📊 Tasto stato: In uso premuto");
    pubblicaStato("in_uso");
    return;
  }

  if (codice == TASTI_IR[14]){
    Serial.println("📊 Tasto stato: Disponibile premuto");
    pubblicaStato("sblocca");
    return;
  }

  if (codice == TASTI_IR[15]){
    Serial.println("🔀 Tasto CAMBIO VISUALIZZAZIONE premuto");
    cambiaVisualizzazioneLED();
    return;
  }

  for (int i = 1; i < 10; i++) {  // Solo primi 7 tasti
    if (codice == TASTI_IR[i]) {
      int numeroTasto = i;
      Serial.printf("✅ Tasto %d riconosciuto\n", numeroTasto);

      if (!listaRicevuta) {
        Serial.println("❌ Lista mezzi non ancora ricevuta");
        lampeggiaLED();
        return;
      }

      if (!docLista.containsKey("vehicles")) {
        Serial.println("❌ Lista mezzi non valida");
        return;
      }
      JsonArray vehicles = docLista["vehicles"];
      if (numeroTasto <= vehicles.size()) {
        selezionaMezzo(numeroTasto - 1);  // -1 perché l'array parte da 0
      } else {
        Serial.printf("❌ Mezzo %d non presente nella lista (solo %d mezzi)\n", numeroTasto, vehicles.size());
        lampeggiaLED();
      }
      return;
    }
  }
  Serial.printf("❓ Codice IR non riconosciuto: 0x%X\n", codice);
}

// ======= SELEZIONE MEZZO =======
void selezionaMezzo(int indice) {
  statoConnessione = STATO_SELEZIONE;
  JsonArray vehicles = docLista["vehicles"];

  if (indice < 0 || indice >= vehicles.size()) {
    Serial.printf("❌ Indice mezzo non valido: %d (max: %d)\n", indice, vehicles.size() - 1);
    return;
  }

  JsonObject vehicle = vehicles[indice];
  int id = vehicle["id"];
  const char* stato = vehicle["stato"];
  int batteria = vehicle["batteria"] | -1;
  const char* tipo = vehicle["tipo"];
  bool isElettrico = vehicle["isElettrico"] | false;

  mezzoSelezionato = id;

  Serial.println("\n✅ MEZZO SELEZIONATO:");
  Serial.printf("   🆔 ID: %d\n", id);
  Serial.printf("   📍 Stato: %s\n", stato);
  Serial.printf("   🔋 Batteria: %d%%\n", batteria);
  Serial.printf("   🚗 Tipo: %s\n", tipo);
  Serial.printf("   ⚡ Elettrico: %s\n", isElettrico ? "Sì" : "No");
  Serial.println("   🎛️ Ruota il potenziometro per impostare la batteria");
  Serial.println("   🔘 Premi ST/REPT sul telecomando per leggere la batteria");
  Serial.println("   🔘 Premi EQ sul telecomando per pubblicare");


  lampeggioAttivo = false;
  digitalWrite(LED_ROSSO, LOW);
  digitalWrite(LED_GIALLO, LOW);
  digitalWrite(LED_VERDE, LOW);

  aggiornaLEDInBaseAllaVisualizzazione();
}

// ======= CALLBACK MQTT =======
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.println("\n🎯 ========== MQTT CALLBACK ==========");
  Serial.print("📨 Topic: ");
  Serial.println(topic);

  // Controllo dimensione payload
  if (length >= 1024) {
    Serial.println("⚠ Payload troppo grande, ignorato");
    return;
  }

  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';

  Serial.print("💬 Contenuto: ");
  Serial.println(message);

  String t = String(topic);

  if (t == "mobishare/mezzi/lista_completa") {
    Serial.println("🚗 Lista completa ricevuta");
    processaListaMezzi(message);
    listaRicevuta = true;
  } else if (t == "mobishare/mezzi/stato") {
    Serial.println("🔄 Stato aggiornato");
    processaStatoMezzo(message);
  } else if (t == "mobishare/mezzi/batteria") {
    Serial.println("🔋 Batteria aggiornata");
    processaBatteriaMezzo(message);
  } else if (t == "test/echo") {
    Serial.println("📡 Echo di test ricevuto");
  } else {
    Serial.print("📢 Altro topic: ");
    Serial.println(t);
  }

  Serial.println("=====================================\n");
}

// ======= ELABORA LA LISTA MEZZI =======
void processaListaMezzi(const char* jsonMessage) {
  DeserializationError error = deserializeJson(docLista, jsonMessage);

  if (error) {
    Serial.print("❌ Errore parsing JSON: ");
    Serial.println(error.c_str());
    return;
  }

  const char* tipo = docLista["type"];
  if (!tipo || String(tipo) != "complete_list") {
    Serial.println("❌ Messaggio non riconosciuto come lista completa");
    return;
  }

  int count = docLista["count"];
  const char* timestamp = docLista["timestamp"];

  Serial.println("✅ LISTA COMPLETA MEZZI:");
  Serial.printf("📊 Numero mezzi: %d\n", count);
  Serial.printf("🕒 Timestamp: %s\n", timestamp);

  JsonArray vehicles = docLista["vehicles"];

  for (JsonObject vehicle : vehicles) {
    int id = vehicle["id"];
    const char* stato = vehicle["stato"];
    int batteria = vehicle["batteria"] | -1;
    const char* tipo = vehicle["tipo"];
    bool isElettrico = vehicle["isElettrico"] | false;

    Serial.printf("🚗 Mezzo %d: %s", id, stato);
    if (batteria != -1) Serial.printf(" | 🔋 %d%%", batteria);
    Serial.printf(" | Tipo: %s%s\n", tipo, isElettrico ? " ⚡" : " 🔥");
  }

  Serial.println("====================================\n");
  controllaMezziDisponibili(vehicles);
}

// ======= CONTROLLO DISPONIBILITÀ =======
void controllaMezziDisponibili(JsonArray vehicles) {
  int disponibili = 0, inUso = 0, nonDisp = 0;

  for (JsonObject vehicle : vehicles) {
    String stato = vehicle["stato"].as<String>();
    if (stato == "Disponibile") disponibili++;
    else if (stato == "In uso") inUso++;
    else nonDisp++;
  }

  Serial.println("📊 RIEPILOGO STATI:");
  Serial.printf("   🟢 Disponibili: %d\n", disponibili);
  Serial.printf("   🔴 In uso: %d\n", inUso);
  Serial.printf("   ⚫ Non disponibili: %d\n\n", nonDisp);
}

// ======= GESTIONE STATO SINGOLO =======
void processaStatoMezzo(const char* jsonMessage) {
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, jsonMessage)) {
    Serial.println("⚠ Errore parsing stato mezzo");
    return;
  }
  bool hasStato = doc.containsKey("stato");
  bool hasMezzoId = doc.containsKey("mezzoId");

  if (!hasMezzoId) {
    Serial.println("❌ Campo mezzoId mancante nel messaggio stato");
    return;
  }

  int mezzoId = doc["mezzoId"];

  // Gestione aggiornamento STATO
  if (hasStato) {
    const char* nuovoStato = doc["stato"];
    const char* timestamp = doc["timestamp"] | "N/A";

    if (nuovoStato == nullptr) {
      Serial.println("❌ Stato null nel messaggio");
      return;
    }

    Serial.printf("🔄 Mezzo %d → %s (%s)\n", mezzoId, nuovoStato, timestamp);

    // **AGGIORNA LA LISTA LOCALE** con il nuovo stato
    if (listaRicevuta && docLista.containsKey("vehicles")) {
      JsonArray vehicles = docLista["vehicles"];
      bool aggiornato = false;

      for (JsonObject vehicle : vehicles) {
        if (vehicle["id"] == mezzoId) {
          const char* vecchioStato = vehicle["stato"] | "Sconosciuto";

          // Aggiorna lo stato del mezzo nella lista locale
          vehicle["stato"] = nuovoStato;
          aggiornato = true;
          aggiornaLEDInBaseAllaVisualizzazione();
          break;
        } 
      }

      if (!aggiornato) {
        Serial.printf("⚠ Mezzo %d non trovato nella lista locale\n", mezzoId);
        client.publish("system/request-vehicle-list", "request");
      }
    } else {
      Serial.println("⚠ Lista locale non disponibile per l'aggiornamento stato");
    }
  }

  if (!hasStato) {
    Serial.printf("❓ Messaggio stato senza campi validi per mezzo %d\n", mezzoId);
  }
}

// ======= GESTIONE AGGIORNAMENTO BATTERIA =======
void processaBatteriaMezzo(const char* jsonMessage) {
  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, jsonMessage)) {
    Serial.println("⚠ Errore parsing batteria mezzo");
    return;
  }

  // Controlli sicuri
  if (!doc.containsKey("mezzoId") || !doc.containsKey("batteria")) {
    Serial.println("❌ Campi obbligatori mancanti nel messaggio batteria");
    return;
  }

  int mezzoId = doc["mezzoId"];
  int nuovaBatteria = doc["batteria"];
  const char* timestamp = doc["timestamp"] | "N/A";
  const char* source = doc["source"] | "sconosciuto";

  Serial.printf("🔋 Aggiornamento BATTERIA ricevuto - Mezzo %d: %d%% (fonte: %s)\n",
                mezzoId, nuovaBatteria, source);

  // Aggiorna la lista locale
  if (listaRicevuta && docLista.containsKey("vehicles")) {
    JsonArray vehicles = docLista["vehicles"];
    bool aggiornato = false;

    for (JsonObject vehicle : vehicles) {
      if (vehicle["id"] == mezzoId) {
        int vecchiaBatteria = vehicle["batteria"] | -1;
        bool isElettrico = vehicle["isElettrico"] | false;

        vehicle["batteria"] = nuovaBatteria;
        aggiornato = true;

        // Se è il mezzo selezionato, aggiorna i LED
        if (mezzoSelezionato == mezzoId) {
          aggiornaLEDInBaseAllaVisualizzazione();
        }
        break;
      }
    }
    if (!aggiornato) {
      Serial.printf("⚠ Mezzo %d non trovato nella lista locale, richiesta lista completa...\n", mezzoId);
      client.publish("system/request-vehicle-list", "request");
    }
  } else {
    Serial.println("⚠ Lista locale non disponibile");
  }
}

// ======= CAMBIO VISUALIZZAZIONE LED =======
void cambiaVisualizzazioneLED() {
  if (visualizzazioneCorrente == VISUALIZZA_BATTERIA) {
    visualizzazioneCorrente = VISUALIZZA_STATO;
  } else {
    visualizzazioneCorrente = VISUALIZZA_BATTERIA;
  }
  
  visualizzazioneCambiata = true;
  
  // Feedback visivo - lampeggio di conferma
  for (int i = 0; i < 2; i++) {
    digitalWrite(LED_ROSSO, HIGH);
    digitalWrite(LED_GIALLO, HIGH);
    digitalWrite(LED_VERDE, HIGH);
    delay(200);
    digitalWrite(LED_ROSSO, LOW);
    digitalWrite(LED_GIALLO, LOW);
    digitalWrite(LED_VERDE, LOW);
    delay(200);
  }
  
  // Aggiorna immediatamente i LED con la nuova visualizzazione
  aggiornaLEDInBaseAllaVisualizzazione();
}

// ======= AGGIORNA LED IN BASE ALLA VISUALIZZAZIONE =======
void aggiornaLEDInBaseAllaVisualizzazione() {
  if (mezzoSelezionato == -1) {
    // Nessun mezzo selezionato
    digitalWrite(LED_ROSSO, LOW);
    digitalWrite(LED_GIALLO, LOW);
    digitalWrite(LED_VERDE, LOW);
    return;
  }

  if (visualizzazioneCorrente == VISUALIZZA_BATTERIA) {
    // Visualizzazione BATTERIA
    if (listaRicevuta && docLista.containsKey("vehicles")) {
      JsonArray vehicles = docLista["vehicles"];
      for (JsonObject vehicle : vehicles) {
        if (vehicle["id"] == mezzoSelezionato) {
          int batteria = vehicle["batteria"] | -1;
          bool isElettrico = vehicle["isElettrico"] | false;
          
          if (isElettrico && batteria != -1) {
            aggiornaLEDBatteria(batteria);
          } else {
            lampeggioAttivo = true;
            ledCorrente = 0;
            lastLampeggio = 0;
          }
          break;
        }
      }
    }
  } else {
    // Visualizzazione STATO
    if (listaRicevuta && docLista.containsKey("vehicles")) {
      JsonArray vehicles = docLista["vehicles"];
      for (JsonObject vehicle : vehicles) {
        if (vehicle["id"] == mezzoSelezionato) {
          const char* stato = vehicle["stato"];
          aggiornaLEDStato(stato);
          break;
        }
      }
    }
  }
}

// ======= CONNESSIONE MQTT =======
bool connectMQTT() {
  Serial.println("🔗 Connessione al broker MQTT...");
  statoConnessione = STATO_MQTT;

  String clientId = "ESP8266Client-" + String(random(0xffff), HEX);

  if (client.connect(clientId.c_str(), mqtt_user, mqtt_password)) {
    Serial.println("✅ MQTT connesso!");

    client.subscribe("mobishare/mezzi/lista_completa", 0);
    client.subscribe("mobishare/mezzi/stato", 0);
    client.subscribe("mobishare/mezzi/batteria", 0);
    client.subscribe("mobishare/mezzi/comando", 0);
    client.subscribe("test/echo", 0);

    Serial.println("📥 Sottoscrizioni completate");

    client.publish("system/request-vehicle-list", "request");
    Serial.println("📤 Lista mezzi richiesta");

    // Connessione completata - sistema pronto
    statoConnessione = STATO_PRONTO;
    lastStatoLED = 0;
    ledStato = false;
    Serial.println("🎯 SISTEMA PRONTO - Seleziona un mezzo con il telecomando IR");

    return true;
  }

  Serial.printf("❌ Connessione MQTT fallita (stato %d)\n", client.state());
  return false;
}

// ======= CONNESSIONE WiFi =======
void setupWiFi() {
  Serial.printf("🔌 Connessione a WiFi '%s'...\n", ssid);
  statoConnessione = STATO_WIFI;
  lastStatoLED = 0;  // Reset timer
  ledStato = false;
  WiFi.begin(ssid, password);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 40) {
    delay(500);
    Serial.print(".");
    retries++;

    gestisciLEDConnessione();
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n✅ WiFi connesso! IP: %s\n", WiFi.localIP().toString().c_str());
    statoConnessione = STATO_MQTT;  // Passa allo stato MQTT
  } else
    Serial.println("\n❌ WiFi non connesso, ritento...");
}

// ======= SETUP =======
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n🚀 ESP8266 MQTT - GESTIONE MEZZI CON IR");
  Serial.println("==========================================");

  // Inizializza IR
  irrecv.enableIRIn();
  Serial.println("📟 Ricevitore IR inizializzato");

  // Inizializza LED
  pinMode(LED_ROSSO, OUTPUT);
  pinMode(LED_GIALLO, OUTPUT);
  pinMode(LED_VERDE, OUTPUT);
  digitalWrite(LED_ROSSO, LOW);
  digitalWrite(LED_GIALLO, LOW);
  digitalWrite(LED_VERDE, LOW);
  Serial.println("💡 LED inizializzati");

  // Inizializza potenziometro
  pinMode(POTENZIOMETRO_PIN, INPUT);
  Serial.println("🎛️  Potenziometro inizializzato");

  // Mostra mappatura tasti
  Serial.println("\n🎮 MAPPATURA TASTI IR:");
  Serial.println("   0 → Deseleziona mezzo");
  Serial.println("   0-9 → Seleziona mezzo");
  Serial.println("🎛️  POTENZIOMETRO:");
  Serial.println("   Ruota per impostare la batteria del mezzo selezionato");
  Serial.println("   Premi ST/REPT per leggere la batteria");
  Serial.println("   Premi EQ per pubblicare e aggiornare i LED");
  Serial.println("   ◀∣ Non disponibile");
  Serial.println("   >∣∣ In uso");
  Serial.println("   ▶∣ Disponibile");
  Serial.println("   Premi FUNC/STOP per cambiare visualizzazione LED");
  Serial.println("==========================================");

  statoConnessione = STATO_WIFI;
  lastStatoLED = millis();  // Inizia timer

  setupWiFi();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
  client.setBufferSize(1024);
  client.setKeepAlive(60);
  client.setSocketTimeout(30);

  connectMQTT();
}

// ======= LOOP PRINCIPALE =======
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    setupWiFi();
  }

  if (!client.connected()) {
    Serial.println("⚠ Riconnessione MQTT...");
    connectMQTT();
  }

  client.loop();
  delay(10);
  gestisciLEDConnessione();

  lampeggiaLEDSequenziale();
  // Gestione IR
  if ((statoConnessione == STATO_PRONTO || statoConnessione == STATO_SELEZIONE) && irrecv.decode(&results)) {
    if (!results.repeat && results.value != 0xFFFFFFFF) {  // Ignora ripetizioni e codici vuoti
      gestisciTastoIR(results.value);
    }
    irrecv.resume();
  }

  delay(50);
}
