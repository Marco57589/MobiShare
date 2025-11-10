# agent/agent.py
import os
from agno.agent import Agent
from agno.models.google import Gemini
from .agent_config import AGENT_IDENTITY, RESPONSE_SYSTEM_PROMPT
from agno.db.firestore import FirestoreDb

gemini_llm = Gemini(
    api_key=os.getenv('GEMINI_API_KEY')
)

def get_mobishare_agent(db=None, user_role=None, user_id=None):
    from .tools import ChatbotTools

    firestore_memory = FirestoreDb(
        db_client=db,
        project_id=os.getenv('FIREBASE_PROJECT_ID'),
        session_collection="agent_sessions",
        memory_collection="agent_memory"
    )

    MobiShareAgentTemplate = Agent(
        model=gemini_llm,
        instructions=f"""
        {AGENT_IDENTITY}
        {RESPONSE_SYSTEM_PROMPT}
        
        REGOLE DI ACCESSO BASATE SUL RUOLO:
        - Un 'gestore' ha accesso a tutte le informazioni di tutti gli utenti e della piattaforma
        - Un 'user' non può richiedere informazioni su altri utenti, gestire mezzi e parcheggi
        
        Ruolo corrente: {user_role}

        Sei autorizzato a usare i tool forniti per rispondere.
        """,
        tools=[ChatbotTools],
        enable_agentic_memory=True,
        add_memories_to_context=True,
        add_history_to_context=True,
        user_id=user_id,
        db=firestore_memory,
        markdown=True,
    )

    return MobiShareAgentTemplate