"""
File di ingresso principale (main) dell'applicazione FastAPI.

Questo file gestisce:
- L'inizializzazione dell'app FastAPI.
- Il ciclo di vita (lifespan) dell'applicazione:
  - Avvio: Connessione a Firebase, inizializzazione AgentOS.
  - Chiusura: Disconnessione da Firebase.
- L'inclusione dei router per i diversi servizi (AI, FR, ML).
"""
import os
import aiohttp
import logging
from fastapi import FastAPI
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, firestore
from service import fr_service, agent_service, rf_service
from contextlib import asynccontextmanager
from agno.os import AgentOS
from service.agent.agent import get_mobishare_agent

load_dotenv()
logger = logging.getLogger("uvicorn.error")


# Ping per verificare che MobiShare sia online
async def ping_services():
    """
    Controlla se il server di MobiShare
    è attivo prima di avviare i servizi AI.
    """
    results = {}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as session:
        try:
            async with session.get("http://localhost:3000/") as response:
                results["mobishare_server"] = response.status == 200
        except Exception:
            results["mobishare_server"] = False
    return results


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Gestore del ciclo di vita di FastAPI.
    Esegue il codice prima dell'avvio e dopo la chiusura.
    """
    # --- FASE DI AVVIO ---
    # 1. Controlla dipendenze esterne
    ping_result = await ping_services()
    if not ping_result.get("mobishare_server"):
        raise RuntimeError("MobiShare non raggiungibile, avvio annullato.")
    # 2. Configura Firebase
    base_dir = os.path.dirname(os.path.abspath(__file__))
    cred_path = os.path.join(base_dir, "..", "serviceAccountKey.json")
    if not os.path.exists(cred_path):
        raise FileNotFoundError("Firebase credential file not found")

    try:
        if not firebase_admin._apps:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = cred_path
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred, {'storageBucket': 'mobishare-c60c9.firebasestorage.app'})
        # 3. Inizializza il database e lo inietta nei servizi
        db = firestore.client()
        app.firestore_db = db
        rf_service.db = db
        fr_service.db = db
        agent_service.db = db

        # 4. Inizializza AgentOS
        agent_instance = get_mobishare_agent(db=db)

        agent_os = AgentOS(
            description="AgnoAI services for MobiShare core",
            agents=[agent_instance],
            base_app=app
        )
        app.agent_os = agent_os
        agent_os.get_app()

        logger.info("Firebase e AgentOS inizializzati correttamente")

    except Exception as e:
        logger.error(f"Errore inizializzazione Firebase o AgentOS: {e}")
        raise

    yield
    # --- FASE DI CHIUSURA ---
    logger.info("FastAPI shutting down...")
    try:
        if firebase_admin._apps:
            firebase_admin.delete_app(firebase_admin.get_app())
            logger.info("Sessione firebase terminata.")
    except Exception as e:
        logger.warning(f"Errore nella chiusura Firebase: {e}")


# Creazione dell'istanza principale dell'app
app: FastAPI = FastAPI(
    title="MobiShare AI",
    summary="AI services for MobiShare core",
    version="1.0.0",
    lifespan=lifespan
)
# Inclusione dei router dei microservizi
app.include_router(fr_service.router, prefix="/api/ai-bridge", tags=["face-recognition"])
app.include_router(agent_service.router, prefix="/api/ai-bridge", tags=["ai-chatbot"])
app.include_router(rf_service.router, prefix="/api/ai-bridge", tags=["ml-predictions"])
# Avvio per debug
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=7777, reload=True)
