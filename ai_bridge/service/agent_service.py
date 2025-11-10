# service/agent_service.py
"""
Questo modulo definisce l'endpoint API principale del chatbot (/chatbot/query).
Gestisce le richieste in arrivo, l'autenticazione (tramite header),
la gestione della sessione e l'esecuzione dell'agente AI.
"""
import logging
from fastapi import APIRouter, HTTPException, Header
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from typing import Optional

from .agent.tools import ChatbotTools
from .agent.agent import get_mobishare_agent

router = APIRouter(tags=["AI Chatbot"], prefix="/chatbot")
db = None # Istanza globale del database Firestore


class ChatQuery(BaseModel):
    query: str
    conversation_id: Optional[str] = None


@router.post("/query")
async def handle_chatbot_query(
        request_body: ChatQuery,
        user_id: str = Header(..., alias="user-id"),
        user_role: str = Header(..., alias="user-role")
):
    """
    Endpoint principale per la gestione delle query del chatbot.

    Recupera user-id e user-role dagli header, inizializza un agente
    contestualizzato per quell'utente, esegue la query e salva
    la cronologia della conversazione su Firestore.
    """
    try:
        if db is None:
            raise HTTPException(status_code=500, detail="Database non inizializzato")

        conversation_id = request_body.conversation_id
        # Se l'ID conversazione non è fornito, prova a recuperarne uno esistente
        if not conversation_id:
            existing_sessions = db.collection("agent_sessions").where("user_id", "==", user_id).limit(1).get()
            for doc in existing_sessions:
                conversation_id = doc.id
                break
        # Se ancora non esiste, ne crea uno nuovo
        if not conversation_id:
            conversation_id = f"mobishare_{user_id}_{user_role}"

        stable_agent_id = f"mobishare_agent_{user_id}"

        #Inizializzazione dell'Agente
        agent = get_mobishare_agent(
            db=db,
            user_role=user_role,
            user_id=user_id
        )
        agent.session_id = conversation_id
        agent.agent_id = stable_agent_id
        contextual_tools = ChatbotTools(db, user_id, user_role)
        agent.tools = [contextual_tools]
        response = await run_in_threadpool(agent.run, request_body.query)

        session_data = {
            "user_id": user_id,
            "user_role": user_role,
            "last_message": request_body.query,
            "agent_id": stable_agent_id
        }

        session_ref = db.collection("agent_sessions").document(conversation_id)
        session_doc = session_ref.get()

        if session_doc.exists:
            existing_data = session_doc.to_dict()
            conversation_history = existing_data.get("conversation_history", [])
        else:
            conversation_history = []

        conversation_history.append({
            "query": request_body.query,
            "response": response.content,
        })

        if len(conversation_history) > 10:
            conversation_history = conversation_history[-10:]

        session_data["conversation_history"] = conversation_history
        session_ref.set(session_data, merge=True)

        return {
            "response": response.content,
            "reasoning_steps": getattr(response, 'reasoning', []),
            "data_used": getattr(response, 'tool_calls', []),
            "conversation_id": conversation_id,
        }

    except Exception as e:
        logging.exception(f"Errore chatbot con Agno: {e}")
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"Errore chatbot: {str(e)}")