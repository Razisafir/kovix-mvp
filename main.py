"""
KOVIX :: FastAPI Entry Point (v2)
==================================
Endpoints:
    GET  /                          Single-page frontend
    GET  /api/health                Health probe
    GET  /api/providers             List all supported providers
    POST /api/models                List models for a provider+key
    POST /api/execute               Run PAUL loop, stream SSE events
    GET  /api/runs                  Cross-run history (SQLite)
    GET  /api/runs/{run_id}         Full detail for one run
    GET  /api/state                 Current STATE.md

Run:
    pip install -r requirements.txt
    python setup_workspace.py
    uvicorn main:app --reload
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import agent
import db
import loop
import providers

BASE_DIR: Path = Path(__file__).resolve().parent
WORKSPACE_DIR: Path = BASE_DIR / "workspace"
INDEX_HTML: Path = BASE_DIR / "index.html"

app: FastAPI = FastAPI(
    title="KOVIX",
    description="Autonomous, self-healing agentic IDE (PAUL-aligned, multi-provider).",
    version="0.2.0",
)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


# --------------------------------------------------------------------------- #
# Static + health
# --------------------------------------------------------------------------- #

@app.get("/", response_class=HTMLResponse)
async def root() -> HTMLResponse:
    if not INDEX_HTML.exists():
        return HTMLResponse("<h1>KOVIX</h1><p>index.html not found.</p>", 503)
    return HTMLResponse(INDEX_HTML.read_text(encoding="utf-8"))


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "version": "0.2.0",
        "workspace": str(WORKSPACE_DIR),
        "workspace_exists": WORKSPACE_DIR.exists(),
        "state_file_exists": (WORKSPACE_DIR / "STATE.md").exists(),
        "db_exists": (BASE_DIR / "kovix.db").exists(),
        "default_provider": agent.DEFAULT_PROVIDER_ID,
    }


# --------------------------------------------------------------------------- #
# Providers + Models
# --------------------------------------------------------------------------- #

@app.get("/api/providers")
async def list_providers() -> Dict[str, Any]:
    """Return the full provider catalogue for the frontend dropdown."""
    return {
        "providers": providers.list_providers(),
        "default_provider": agent.DEFAULT_PROVIDER_ID,
    }


class ModelsRequest(BaseModel):
    provider: str = Field(..., description="Provider id, e.g. 'openai'")
    api_key: Optional[str] = Field(
        None, description="If omitted, the provider's env var is consulted."
    )


@app.post("/api/models")
async def list_models(req: ModelsRequest) -> JSONResponse:
    """Fetch the model catalogue for a provider using the supplied key.

    Returns {"provider": "...", "models": ["..."], "from_env": bool}.
    """
    try:
        provider: providers.Provider = providers.get_provider(req.provider)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    resolved_key: Optional[str] = providers.resolve_api_key(provider, req.api_key)
    from_env: bool = (resolved_key is not None) and not (req.api_key and req.api_key.strip())

    if provider.needs_key_for_models and not resolved_key:
        raise HTTPException(
            status_code=400,
            detail=f"No API key for {provider.name}. "
                   f"Set {provider.env_var} or pass api_key in the request body.",
        )

    try:
        models: List[str] = providers.fetch_models(provider, resolved_key)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return JSONResponse({
        "provider": provider.id,
        "provider_name": provider.name,
        "models": models,
        "from_env": from_env,
        "default_model": provider.default_model,
    })


# --------------------------------------------------------------------------- #
# Execute (SSE)
# --------------------------------------------------------------------------- #

class ExecuteRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    provider: str = Field(default=agent.DEFAULT_PROVIDER_ID)
    api_key: Optional[str] = None
    model: Optional[str] = None


@app.post("/api/execute")
async def execute(req: ExecuteRequest) -> StreamingResponse:
    """Run the PAUL loop and stream events back as Server-Sent Events."""
    try:
        providers.get_provider(req.provider)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    cfg: agent.LLMConfig = agent.LLMConfig(
        provider_id=req.provider,
        api_key=req.api_key,
        model=req.model,
    )

    queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()
    main_loop: asyncio.AbstractEventLoop = asyncio.get_running_loop()

    def on_event(ev: Dict[str, Any]) -> None:
        main_loop.call_soon_threadsafe(queue.put_nowait, ev)

    async def runner() -> None:
        try:
            await asyncio.to_thread(
                loop.run_loop, req.prompt, WORKSPACE_DIR, cfg, on_event
            )
        except Exception as exc:  # noqa: BLE001
            on_event({
                "phase": "FATAL",
                "message": f"Loop crashed: {exc}",
                "status": "error",
                "timestamp": _utc_now(),
            })
        finally:
            on_event({"phase": "DONE", "message": "", "status": "info",
                      "timestamp": _utc_now()})

    async def event_stream():
        task: asyncio.Task = asyncio.create_task(runner())
        try:
            while True:
                ev: Dict[str, Any] = await queue.get()
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if ev.get("phase") == "DONE":
                    break
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# --------------------------------------------------------------------------- #
# State + History
# --------------------------------------------------------------------------- #

@app.get("/api/state")
async def get_state() -> JSONResponse:
    state_path: Path = WORKSPACE_DIR / "STATE.md"
    if not state_path.exists():
        return JSONResponse({
            "state": None,
            "error": "STATE.md not found. Run setup_workspace.py.",
        })
    return JSONResponse({"state": state_path.read_text(encoding="utf-8")})


@app.get("/api/runs")
async def list_runs(limit: int = 50) -> Dict[str, Any]:
    return {"runs": db.list_runs(limit=limit)}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: int) -> JSONResponse:
    detail: Optional[Dict[str, Any]] = db.get_run_detail(run_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found.")
    return JSONResponse(detail)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
