import re
from datetime import datetime, timedelta
import json
import logging
from google.cloud import firestore

logger = logging.getLogger(__name__)


class ChatbotTools:
    def __init__(self, db, user_id: str, user_role: str):
        super().__init__()
        self.db = db
        self.user_id = user_id
        self.user_role = user_role

    async def get_user_rides(self, time_filter=None):
        """Recupera le corse dell'utente con filtri temporali"""
        try:
            query = self.db.collection('rides').where('userId', '==', self.user_id)

            if time_filter:
                if time_filter == 'last_week':
                    start_date = datetime.now() - timedelta(days=7)
                elif time_filter == 'last_month':
                    start_date = datetime.now() - timedelta(days=30)
                elif time_filter == 'today':
                    start_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                else:
                    start_date = None

                if start_date:
                    query = query.where('startTime', '>=', start_date)

            rides_snapshot = query.stream()
            rides = []
            for ride in rides_snapshot:
                ride_data = ride.to_dict()
                if 'startTime' in ride_data:
                    ride_data['startTime'] = ride_data['startTime'].isoformat() if hasattr(ride_data['startTime'],
                                                                                           'isoformat') else str(
                        ride_data['startTime'])
                if 'endTime' in ride_data:
                    ride_data['endTime'] = ride_data['endTime'].isoformat() if hasattr(ride_data['endTime'],
                                                                                       'isoformat') else str(
                        ride_data['endTime'])
                rides.append({'id': ride.id, **ride_data})

            return rides
        except Exception as e:
            logger.error(f"Errore recupero corse: {e}")
            return []

    async def get_payment_history(self):
        """Recupera lo storico pagamenti"""
        try:
            payments_snapshot = self.db.collection('ricariche').where('userId', '==', self.user_id).stream()
            payments = []
            for payment in payments_snapshot:
                payment_data = payment.to_dict()
                if 'data' in payment_data:
                    payment_data['data'] = payment_data['data'].isoformat() if hasattr(payment_data['data'],
                                                                                       'isoformat') else str(
                        payment_data['data'])
                payments.append(payment_data)
            return payments
        except Exception as e:
            logger.error(f"Errore recupero pagamenti: {e}")
            return []

    async def get_available_vehicles(self, parking_id=None):
        """Recupera mezzi disponibili"""
        try:
            query = self.db.collection('mezzi').where('stato', '==', 'Disponibile')
            if parking_id:
                query = query.where('id_parcheggio', '==', int(parking_id))

            vehicles_snapshot = query.stream()
            return [{'id': vehicle.id, **vehicle.to_dict()} for vehicle in vehicles_snapshot]
        except Exception as e:
            logger.error(f"Errore recupero mezzi: {e}")
            return []

    async def analyze_ride_patterns(self):
        """Analizza pattern di utilizzo con reasoning complesso"""
        rides = await self.get_user_rides('last_month')

        if not rides:
            return "Nessun dato sufficiente per l'analisi"

        # Usa l'agente per analisi avanzata
        analysis_prompt = f"""
        Analizza questi dati di corse e fornisci insights in italiano:
        {json.dumps(rides, default=str, ensure_ascii=False)}
        
        Cerca pattern su:
        - Orari preferiti per le corse
        - Tipi di mezzo preferiti
        - Parcheggi più utilizzati
        - Consumo di credito medio
        - Suggerimenti per ottimizzare le spese
        
        Fornisci una risposta strutturata ma naturale.
        """

        try:
            response = self.agent.model.generate_content(analysis_prompt)
            return response.text
        except Exception as e:
            logger.error(f"Errore analisi pattern: {e}")
            return "Impossibile analizzare i pattern in questo momento."

    async def check_user_status(self):
        """Recupera lo stato completo dell'utente, incluso saldo e eventuali corse in sospeso"""

        try:
            #recupera dati utente
            user_ref = self.db.collection('users').document(self.user_id)
            user_doc = user_ref.get()
            if not user_doc.exists:
                logger.error(f"Utente non trovato con userId: {self.user_id}")
                return "impossibile analizzare lo stato: utente non trovato"

            user_data = user_doc.to_dict()

            query = (((self.db.collection('rides')
                       .where('userId', '==', self.user_id))
                      .where('status', '==', 'in_riepilogo'))
                     .limit(1))
            #recupera pagamenti in sospeso
            pending_ride_snapshot = query.get()
            pending_ride = None
            if pending_ride_snapshot:
                pending_ride_doc = pending_ride_snapshot[0]
                pending_ride_data = pending_ride_doc.to_dict()
                pending_ride = {
                    "id": pending_ride_data['id'],
                    "costo": pending_ride_data['costo'],
                    "endTime": pending_ride_data.get('endTime').isoformat() if pending_ride_data.get(
                        'endTime') else None
                }

            status_report = {
                "user_id": self.user_id,
                "ruolo": user_data.get('ruolo', 'utente'),
                "stato_profilo": user_data.get('stato_profilo', 'attivo'),
                "saldo": user_data.get('saldo', 0),
                "punti_fedelta": user_data.get('puntiFedelta', 0),
                "has_pending_payment": pending_ride is not None,
                "pending_ride_details": pending_ride
            }

            return status_report
        except Exception as e:
            logger.error(f"Errore analisi stato utente: {e}")
            return "impossibile analizzare lo stato completo"

    async def get_shop_packages(self):
        """Recupera i pacchetti disponibile nello shop per il riscatto punti"""
        try:
            query_shop = self.db.collection('shop').stream()

            packages = []
            for doc in query_shop:
                p_data = doc.to_dict()
                packages.append({
                    "package_id": doc.id,
                    "nome_pacchetto": p_data.get('nome', f"Riscatta {p_data.get('costo')}€ di credito"),
                    "costo_in_punti_fedelta": p_data.get('credito'),
                    "valore_ottenuto_in_euro": p_data.get('costo')
                })
            return packages
        except Exception as e:
            logger.error(f"Errore analisi pacchetti dello shop: {e}")
            return "impossibile ottenere i pacchetti dello shop"

    async def redeem_shop_package(self, details: str):
        """Riscatta un pacchetto fedeltà cercando il pacchetto in base ai dettagli (es. "50 punti" o "5 euro")."""

        if not details:
            return {"success": False, "error": "Non hai specificato quale pacchetto riscattare."}

        if isinstance(details, dict):
            details_str = details.get('text', '') or details.get('input', '') or str(details)
        else:
            details_str = str(details)

        logger.info(f"Tentativo di riscatto con dettagli: {details_str}")
        try:
            match = re.search(r'\d+', details)
            if not match:
                return {"success": False, "error": "Non ho capito quale pacchetto intendi."}

            value = int(match.group(0))

            query = self.db.collection('shop')

            if "punti" in details.lower():
                query = query.where('credito', '==', value)
            elif "euro" in details.lower() or "€" in details:
                query = query.where('costo', '==', value)
            else:
                return {"success": False, "error": f"Non ho capito se intendi {value} punti o {value} euro."}

            packages = query.limit(1).get()
            if not packages:
                return {"success": False, "error": f"Nessun pacchetto trovato corrispondente a '{details}'."}

            package_doc = packages[0]
            package_ref = package_doc.reference
            package_id = package_doc.id

            user_reference = self.db.collection('users').document(self.user_id)
            transaction = self.db.transaction()

            @firestore.transactional
            def redeem(trans, user_ref_t, package_ref_t):
                user_doc = user_ref_t.get(transaction=trans)
                package_doc_t = package_ref_t.get(transaction=trans)

                if not user_doc.exists:
                    raise Exception("Utente non trovato")
                if not package_doc_t.exists:
                    raise Exception("Pacchetto non trovato")

                user_data = user_doc.to_dict()
                package_data = package_doc_t.to_dict()

                user_points = user_data.get('puntiFedelta', 0)
                package_cost_points = package_data.get('credito', 0)
                package_value_euro = package_data.get('costo', 0)

                if user_points < package_cost_points:
                    raise Exception(
                        f"Punti insufficienti. Hai {user_points} punti, ma ne servono {package_cost_points}.")

                new_points = user_points - package_cost_points
                trans.update(user_ref_t, {
                    'puntiFedelta': new_points,
                    'saldo': firestore.Increment(package_value_euro)
                })

                redemption_ref = self.db.collection('redemptions').document()
                trans.set(redemption_ref, {
                    'userId': self.user_id,
                    'pacchettoId': package_id,
                    'creditoSpeso': package_cost_points,
                    'valoreCredito': package_value_euro,
                    'data': firestore.SERVER_TIMESTAMP
                })

                new_saldo = user_data.get('saldo', 0) + package_value_euro
                return {
                    "success": True,
                    "nuovo_saldo_punti": new_points,
                    "nuovo_saldo_euro": new_saldo,
                    "nome_pacchetto_riscattato": package_data.get('nome', f"Pacchetto da {package_cost_points} punti")
                }

            result = redeem(transaction, user_reference, package_ref)
            return result

        except Exception as e:
            logger.error(f"Errore riscatto punti per {self.user_id}: {e}")
            return {"success": False, "error": str(e)}

    async def get_suspended_users(self):
        """[Gestore] Recupera un elenco di tutti gli utenti con stato_profilo sospeso"""
        if self.user_role != 'gestore':
            return {"success": False, "error": "Accesso negato. Funzione riservata solo ai gestori."}

        try:
            query = self.db.collection('users').where('stato_profilo', '==', 'sospeso')
            users_snapshot = query.stream()
            suspended_users = []
            for doc in users_snapshot:
                user_data = doc.to_dict()
                suspended_users.append({
                    "user_id": doc.id,
                    "email": user_data.get('email'),
                    "nome": user_data.get('nome'),
                    "numeroSospensioni": user_data.get('numeroSospensioni'),
                    "saldo": user_data.get('saldo'),
                    "stato_profilo": user_data.get('stato_profilo')
                })

                if not suspended_users:
                    return {"success": True, "message": "Nessun utente sospeso trovato."}

                return {"success": True, "users": suspended_users}
        except Exception as e:
            logger.error(f"Errore recupero utenti sospesi: {e}")
            return {"success": False, "error": "Impossibile recuperare l'elenco degli utenti sospesi."}

    async def unblock_user(self, details: str):
        """[Gestore] Sblocca un utente specifico impostando il suo stato_profilo su attivo"""
        if self.user_role != "gestore":
            return {"success": False, "error": "Accesso negato. Funzione riservata agli amministratori."}
        if not details:
            return {"success": False, "error": "ID utente non fornito."}

        try:
            user_ref = self.db.collection('users').document(details)
            transaction = self.db.transaction()

            @firestore.transactional
            def _unblock_transaction(trans, user_ref_t):
                user_doc = user_ref_t.get(transaction=trans)

                if not user_doc.exists:
                    raise Exception(f"Utente con ID {details} non trovato.")

                user_data = user_doc.to_dict()
                current_status = user_data.get('stato_profilo')
                current_balance = user_data.get('saldo', 0)

                if current_status == 'attivo':
                    return {"already_active": True}

                if current_balance <= 0:
                    raise Exception(f"Impossibile sbloccare. Il saldo dell'utente è {current_balance}€.")

                trans.update(user_ref_t, {'stato_profilo': 'attivo'})

                logger.info(f"Admin {self.user_id} ha sbloccato l'utente {details}")
                return {"success": True}

            result = _unblock_transaction(transaction, user_ref)

            if result.get("already_active"):
                return {"success": False, "message": f"L'utente {details} è già attivo."}

            return {
                "success": True,
                "message": f"Utente {details} sbloccato con successo.",
                "saldo_al_momento_sblocco": result.get("saldo_utente")
            }

        except Exception as e:
            logger.error(f"Errore transazionale sblocco utente {details}: {e}")
            return {"success": False, "error": f"Errore durante lo sblocco: {str(e)}"}

    async def find_users_by_details(self, email: str = None, nome: str = None):
        """[Gestore] Trova utenti in base a email o nome . Richiede almeno un parametro di ricerca."""
        if self.user_role != 'gestore':
            return {"success": False, "error": "Accesso negato. Funzione riservata ai gestori."}

        if not email and not nome:
            return {"success": False, "error": "Devi fornire almeno un criterio di ricerca (email o nome)."}

        try:
            query = self.db.collection('users')

            if email:
                query = query.where('email', '==', email)
            if nome:
                query = query.where('nome', '==', nome)

            users_snapshot = query.stream()
            found_users = []
            for doc in users_snapshot:
                user_data = doc.to_dict()
                found_users.append({
                    "user_id": doc.id,
                    "email": user_data.get('email'),
                    "nome": user_data.get('nome'),
                    "stato_profilo": user_data.get('stato_profilo')
                })

            if not found_users:
                return {"success": True, "users": [], "message": "Nessun utente trovato con questi criteri."}

            return {"success": True, "users": found_users}

        except Exception as e:
            logger.error(f"Errore ricerca utente: {e}")
            if "FAILED_PRECONDITION" in str(e) or "missing an index" in str(e):
                return {"success": False,
                        "error": f"Errore di configurazione database: indice composto mancante per questa query. Cerca usando un solo campo (es. solo email)."}
            return {"success": False, "error": f"Impossibile completare la ricerca: {e}"}

    async def find_and_unblock_user(self, email: str = None, nome: str = None):
        """
        [Gestore] Cerca un utente per nome/mail e se ne trova solo uno tenta di sbloccarlo
        richiede saldo > 0
        """
        if self.user_role != "gestore":
            return {"success": False, "error": "Accesso negato. Funzione riservata ai gestori."}

        search_result = await self.find_users_by_details(email=email, nome=nome)
        if not search_result.get("success"):
            return search_result

        found_users = search_result.get("users",[])
        if len(found_users) == 0:
            return {"success": False,
                    "error": f"Nessun utente trovato con i criteri forniti (Nome: {nome}, Email: {email})."}
        if len(found_users) > 1:
            user_list_str = ", ".join(
                [f"'{u.get('nome')}' (ID: {u.get('user_id')})" for u in found_users])
            return {"success": False,
                    "error": f"Trovati {len(found_users)} utenti. Impossibile procedere. Utenti trovati: {user_list_str}. Si prega di usare l'ID utente."}

        user = found_users[0]
        id_user = user.get("user_id")
        name = user.get("nome")
        result = await self.unblock_user(id_user)

        if result.get("success"):
            result["message"] = f"Utente '{nome}' (ID: {id_user}) sbloccato con successo."
        else:
            result["error"] = f"Impossibile sbloccare '{nome}' (ID: {id_user}). Motivo: {result.get('error','Errore sconosciuto')}"

        return result

    async def get_damages(self):
        """[Gestore]: Recupera una lista di tutti i mezzi in manutenzione con i relativi danni"""
        if self.user_role != "gestore":
            return {"success": False, "error": "Accesso negato. Funzione riservata ai gestori."}

        try:
            query = self.db.collection('danni')
            damages_snapshot = query.stream()

            damages = []
            for doc in damages_snapshot:
                data = doc.to_dict()
                damages.append({
                    "id_veicolo": data.get("mezzoId"),
                    "parcheggio": data.get("parcheggioId"),
                    "segnalato_da": data.get("segnalatoDa"),
                    "tipo_danno": data.get("tipoDanno"),
                    "data_segnalazione": data.get("dataSegnalazione")
                })
            if len(damages) == 0:
                return {"success": True, "message": "nessun danno al momento segnalato"}

            return {"success": True, "data": damages}
        except Exception as e:
            logger.error(f"Errore recupero danni: {e}")
            return {"success": False, "error": f"Impossibile recuperare l'elenco dei danni: {e}"}

    async def analyze_vehicle_positioning(self, time_filter_days=7):
        """
        [Gestore] Analizza i dati storici di TUTTE le corse per suggerire
        il posizionamento ottimale dei mezzi.
        """

        if self.user_role != 'gestore':
            return {"success": False, "error": "Accesso negato. Funzione riservata ai gestori."}

        try:
            logger.info(f"Avvio analisi posizionamento per gli ultimi {time_filter_days} giorni...")
            start_date = datetime.now() - timedelta(days=time_filter_days)

            query = self.db.collection('rides').where('startTime', '>=', start_date)
            rides_snapshot = query.stream()

            rides_data = []
            count = 0
            for ride in rides_snapshot:
                count += 1
                data = ride.to_dict()
                rides_data.append({
                    "startParkingId": data.get("parcheggioPartenza"),
                    "endParkingId": data.get("parcheggioArrivo"),
                    "startTime": data.get("startTime"),
                    "vehicleType": data.get("mezzoTipo"),
                    "vehicleId": data.get("mezzoId")
                })

            if not rides_data:
                return {"success": True,
                        "message": "Nessun dato sulle corse trovato nell'ultimo periodo per l'analisi."}

            logger.info(f"Analisi di {count} corse in corso...")

            rides_json = json.dumps(rides_data, default=str, ensure_ascii=False)

            analysis_prompt = f"""
            Sei un analista di dati per MobiShare. Analizza i seguenti dati di corse (ultimi {time_filter_days} giorni).
            NON analizzare l'utente, ma il posizionamento generale dei mezzi.

            Dati (un campione o tutti): {rides_json}

            Obiettivo: Suggerire al gestore dove posizionare i mezzi.

            Rispondi in italiano e identifica:
            1.  **Parcheggi di partenza:** Quali 'startParkingId' sono più popolari? (Alta domanda, qui servono più mezzi).
            2.  **Parcheggi di arrivo:** Quali 'endParkingId' sono più popolari? (I mezzi si accumulano qui e potrebbero dover essere ridistribuiti).
            3.  **Orari di Punta:** Ci sono orari specifici (es. mattina, sera) in cui la domanda esplode?
            4.  **Mezzi Preferiti:** I 'vehicleType' più usati in queste zone.
            5.  **Suggerimento Azionabile:** Un breve riepilogo per il gestore (es. "Sposta 5 monopattini dal parcheggio Y [accumulo] al parcheggio X [hotspot] ogni mattina alle 8:00").

            Fornisci una risposta strutturata ma naturale.
            """

            analysis_result = await self._get_llm_analysis(analysis_prompt)

            return {"success": True, "analysis": analysis_result}

        except Exception as e:
            logger.error(f"Errore analisi posizionamento: {e}")
            if "FAILED_PRECONDITION" in str(e) or "missing an index" in str(e):
                return {"success": False,
                        "error": "Errore database: è necessario un indice per questa query. Contatta l'amministratore per creare un indice sulla collezione 'rides' per il campo 'startTime'."}
            return {"success": False, "error": f"Impossibile completare l'analisi: {e}"}

    async def _get_llm_analysis(self, prompt: str, llm):
        response = llm.generate_content(prompt)
        return response.text
