"""
KOVIX :: Workspace Initialization
==================================
Clones the PAUL reference repository and bootstraps the local workspace
with STATE.md and PROJECT.md so the autonomous loop has a context to track.

Run:
    python setup_workspace.py
"""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Paths are resolved relative to this file so the script works on Windows + Linux.
BASE_DIR: Path = Path(__file__).resolve().parent
REFERENCE_PAUL: Path = BASE_DIR / "reference_paul"
WORKSPACE_DIR: Path = BASE_DIR / "workspace"
STATE_FILE: Path = WORKSPACE_DIR / "STATE.md"
PROJECT_FILE: Path = WORKSPACE_DIR / "PROJECT.md"

PAUL_REPO_URL: str = "https://github.com/ChristopherKahler/paul.git"


def clone_paul_reference() -> None:
    """Clone the PAUL repository. Skip silently if already present."""
    if REFERENCE_PAUL.exists() and (REFERENCE_PAUL / ".git").exists():
        print(f"[KOVIX] reference_paul already exists at {REFERENCE_PAUL}")
        return
    print(f"[KOVIX] Cloning PAUL reference from {PAUL_REPO_URL} ...")
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", PAUL_REPO_URL, str(REFERENCE_PAUL)],
            check=True,
            cwd=str(BASE_DIR),
        )
        print("[KOVIX] PAUL reference clone complete.")
    except subprocess.CalledProcessError as exc:
        print(f"[KOVIX][WARN] git clone failed: {exc}")
        print("[KOVIX][WARN] Continuing without PAUL reference. "
              "Loop will run with embedded PAUL-compatible logic.")
    except FileNotFoundError:
        print("[KOVIX][WARN] git executable not found on PATH.")
        print("[KOVIX][WARN] Continuing without PAUL reference.")


def ensure_workspace() -> None:
    """Create the workspace directory."""
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[KOVIX] workspace ready at {WORKSPACE_DIR}")


STATE_TEMPLATE: str = """# KOVIX :: STATE.md

> Live state of the autonomous Plan-Apply-Unify loop.
> This file is overwritten by loop.py on every run -- do not edit by hand.

## Current Phase
IDLE

## Original Vibe
_(pending first run)_

## Refined Goal
_(pending)_

## Active Plan
_(pending)_

## Acceptance Criteria (BDD)
_(pending)_

## Execution Log
_(pending)_

## Self-Healing History
_(none)_

## Unify Report
_(pending)_

## Last Updated
{ts}
"""

PROJECT_TEMPLATE: str = """# KOVIX :: PROJECT.md

> Project-level metadata. Edit by hand to redirect KOVIX's mission.

## Vision
KOVIX shifts AI from "chat-based assistance" to "autonomous execution."
The user supplies an abstract vibe; KOVIX refines it, generates a strict plan,
executes the code locally, tests it, and autonomously heals any errors.

## Reference Architecture
PAUL -- The Plan-Apply-Unify Loop
Source: https://github.com/ChristopherKahler/paul

### Principles Adopted
1. **Loop Integrity** -- every PLAN step closes with a UNIFY step to reconcile
   planned vs. executed state and prevent drift.
2. **Acceptance-Driven Development** -- plans define "Done" in BDD format
   (Given / When / Then).
3. **Diagnostic Failure Routing** -- before self-healing, the agent classifies
   the root cause as INTENT, SPEC, or CODE.

## Tech Stack
- Backend:        Python 3.11+ / FastAPI
- State / Memory: SQLite + Markdown (STATE.md, PROJECT.md)
- Execution:      python subprocess
- Frontend:       Single-page Vanilla HTML/JS + TailwindCSS
- LLM:            GLM 5.2 via Z.ai OpenAI-compatible endpoint

## Runtime
    pip install -r requirements.txt
    python setup_workspace.py
    uvicorn main:app --reload
    open http://127.0.0.1:8000
"""


def write_seed_files() -> None:
    """Write STATE.md and PROJECT.md if they do not already exist."""
    ts: str = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not STATE_FILE.exists():
        STATE_FILE.write_text(STATE_TEMPLATE.format(ts=ts), encoding="utf-8")
        print(f"[KOVIX] wrote {STATE_FILE}")
    else:
        print(f"[KOVIX] {STATE_FILE.name} already exists -- leaving untouched.")
    if not PROJECT_FILE.exists():
        PROJECT_FILE.write_text(PROJECT_TEMPLATE, encoding="utf-8")
        print(f"[KOVIX] wrote {PROJECT_FILE}")
    else:
        print(f"[KOVIX] {PROJECT_FILE.name} already exists -- leaving untouched.")


def main() -> int:
    print("=" * 60)
    print("KOVIX :: Workspace Initialization")
    print("=" * 60)
    clone_paul_reference()
    ensure_workspace()
    write_seed_files()
    print("[KOVIX] setup complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
