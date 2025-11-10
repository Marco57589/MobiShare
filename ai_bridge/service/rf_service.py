from fastapi import APIRouter, HTTPException
from .ML.rf_predictor import DistribuzioneOttimale
import logging

router = APIRouter(tags=["ML Predictions"], prefix="/ml-predictions")

db = None
predictor = None


@router.on_event("startup")
async def startup_event():
    global predictor
    if db:
        predictor = DistribuzioneOttimale(db)
        await predictor.load_model()


@router.post("/train")
async def train_model():
    """Addestra il modello Random Forest e salva i suggerimenti in cache"""
    global predictor
    try:
        if not predictor:
            raise HTTPException(status_code=500, detail="Predictor non inizializzato")

        success = await predictor.train_and_cache_model()

        if not success:
            raise HTTPException(status_code=400, detail="Addestramento e caching falliti")

        return {
            "status": "success",
            "message": "Modello addestrato e suggerimenti salvati in cache correttamente"
        }
    except Exception as e:
        logging.error(f"Errore addestramento modello: {e}")
        raise HTTPException(status_code=500, detail=f"Errore addestramento modello: {e}")


@router.get("/park_suggestions")
async def get_optimization_suggestions():
    """Fornisce suggerimenti dalla cache senza ricalcoli"""
    if not predictor:
        raise HTTPException(status_code=500, detail="Predictor non inizializzato")

    try:
        suggestions_data = await predictor.get_cached_suggestions()
        return suggestions_data
    except Exception as e:
        logging.error(f"Errore generazione suggerimenti: {e}")
        raise HTTPException(status_code=500, detail=f"Errore generazione suggerimenti: {str(e)}")


@router.get("/cache/status")
async def get_cache_status():
    """Endpoint per verificare lo stato della cache"""
    if not predictor:
        raise HTTPException(status_code=500, detail="Predictor non inizializzato")

    try:
        cache_data = await predictor.get_suggestions_from_cache()

        if cache_data:
            return {
                "cache_available": True,
                "total_suggestions": cache_data.get('total_suggestions', 0),
                "generated_at": cache_data.get('generated_at')
            }
        else:
            return {
                "cache_available": False,
                "total_suggestions": 0,
                "generated_at": None
            }
    except Exception as e:
        logging.error(f"Errore verifica cache: {e}")
        raise HTTPException(status_code=500, detail=f"Errore verifica cache: {str(e)}")