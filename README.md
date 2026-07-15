# KOVIX

> Autonomous, self-healing agentic IDE. Shifts AI from "chat-based assistance"
> to "autonomous execution." You supply a vibe; KOVIX plans, applies, and unifies.

## v0.2 highlights

- **Multi-provider** — pick any of 14 providers (OpenAI, Z.ai, Anthropic,
  Gemini, OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral,
  Perplexity, xAI, Cohere, Ollama). Enter your key, click LOAD, pick a model.
- **Strict BDD evaluator** — each `then` clause is parsed into assertions
  (`exit code is N`, `stdout contains 'X'`, `stdout matches /regex/`,
  `stderr is empty`, etc.). Conjuncts joined by `and` all must pass.
- **SPEC-level retry** — when HEAL classifies a failure as `SPEC`, the loop
  re-calls `generate_plan` with the diagnostic reasoning attached, up to 2 times.
- **SQLite persistence** — every run, milestone, healing event, and streamed
  event is written to `kovix.db`. Browse past runs from the **History** tab.

## Architecture (PAUL-aligned)

KOVIX adopts the three core principles from
[`ChristopherKahler/paul`](https://github.com/ChristopherKahler/paul):

1. **Loop Integrity** — every PLAN step closes with a UNIFY step that
   reconciles planned vs. executed state and updates `STATE.md`.
2. **Acceptance-Driven Development** — plans define "Done" in BDD format
   (Given / When / Then) and `bdd.py` enforces it per-criterion.
3. **Diagnostic Failure Routing** — before self-healing, the agent classifies
   the failure as `INTENT`, `SPEC`, or `CODE`. `SPEC` triggers re-planning.

```
 ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
 │  PLAN  │ -> │ APPLY  │ -> │  HEAL  │ -> │ UNIFY  │
 └────────┘    └────────┘    └────────┘    └────────┘
   refine       write &        classify       reconcile
   vibe into    execute        INTENT/SPEC    plan vs
   BDD plan     milestones     /CODE, patch   reality
                                │
                                ▼ SPEC
                          regenerate_plan
                          (max 2 retries)
```

## File Map

| File                  | Role                                                                |
| --------------------- | ------------------------------------------------------------------ |
| `setup_workspace.py`  | Clones PAUL, bootstraps `workspace/STATE.md` + `PROJECT.md`          |
| `providers.py`        | Provider catalogue + `/models` discovery (14 providers)             |
| `agent.py`            | LLM wrapper with 3 strict system prompts (PLAN/APPLY/HEAL)           |
| `bdd.py`              | Per-criterion assertion interpreter                                  |
| `loop.py`             | PAUL state machine + SPEC retry + SQLite integration                 |
| `executor.py`         | Cross-platform `subprocess` runner with typed results                |
| `db.py`               | SQLite persistence (runs / milestones / healing_events / events)     |
| `main.py`             | FastAPI app: SSE streaming + provider/model/runs endpoints           |
| `index.html`          | Dark terminal UI: provider bar, phase tracker, history tab           |
| `requirements.txt`    | Python dependencies                                                  |

## Quickstart (Windows)

```powershell
git clone https://github.com/Razisafir/kovix-mvp.git kovix
cd kovix
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python setup_workspace.py
uvicorn main:app --reload
# open http://127.0.0.1:8000
```

## Using any provider

1. Pick a provider from the dropdown.
2. Paste your API key (or leave blank if you've set the matching env var).
3. Click **LOAD** — the model dropdown populates with everything the provider
   exposes for that key.
4. Pick a model, type your vibe, hit **EXECUTE**.

### Env-var fallback

| Provider   | Env var              |
| ---------- | -------------------- |
| Z.ai       | `ZAI_API_KEY`        |
| OpenAI     | `OPENAI_API_KEY`     |
| Anthropic  | `ANTHROPIC_API_KEY`  |
| Gemini     | `GEMINI_API_KEY`     |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq       | `GROQ_API_KEY`       |
| Together   | `TOGETHER_API_KEY`   |
| Fireworks  | `FIREWORKS_API_KEY`  |
| DeepSeek   | `DEEPSEEK_API_KEY`   |
| Mistral    | `MISTRAL_API_KEY`    |
| Perplexity | `PERPLEXITY_API_KEY` |
| xAI        | `XAI_API_KEY`        |
| Cohere     | `COHERE_API_KEY`     |
| Ollama     | `OLLAMA_API_KEY` (local; usually empty) |

Without a key, KOVIX runs in **offline fallback mode** — a deterministic JSON
producer that exercises every loop path (including a deliberate first-iteration
`NameError` so the HEAL phase is observable end-to-end).

## BDD assertion syntax

The `then` clause is parsed for the following patterns (case-insensitive,
`and`-joined conjuncts all must pass):

| Pattern                                       | Meaning                                        |
| --------------------------------------------- | ---------------------------------------------- |
| `exit code is N` / `return code is N`         | `result.returncode == N`                        |
| `stdout contains "X"` / `stdout contains 'X'` | `X in result.stdout`                            |
| `stdout contains X`                            | `X in result.stdout` (greedy)                   |
| `stdout does not contain X`                    | `X not in result.stdout`                        |
| `stdout matches /regex/`                       | `re.search(regex, result.stdout)`               |
| `stdout matches regex X`                       | `re.search(X, result.stdout)`                   |
| `stdout is non-empty` / `stdout is not empty`  | `bool(result.stdout.strip())`                   |
| `stdout is empty`                              | `not result.stdout.strip()`                     |
| `stderr contains "X"`                          | `X in result.stderr`                            |
| `stderr is empty`                              | `not result.stderr.strip()`                     |
| `execution succeeds` / `succeeds`              | `result.success`                                |
| `execution fails` / `fails`                    | `not result.success`                            |

If no pattern matches, the evaluator falls back to `rc==0 and non-empty stdout`
and marks the criterion with `fallback_used: true`.

## API

| Method | Path                 | Description                                       |
| ------ | -------------------- | ------------------------------------------------- |
| GET    | `/`                  | Single-page frontend                              |
| GET    | `/api/health`        | Workspace + STATE.md + DB presence probe          |
| GET    | `/api/providers`     | Full provider catalogue                           |
| POST   | `/api/models`        | `{provider, api_key}` -> `{models: [...]}`         |
| POST   | `/api/execute`       | `{prompt, provider, api_key, model}` -> SSE stream |
| GET    | `/api/runs`          | Cross-run history                                 |
| GET    | `/api/runs/{id}`     | Full detail for one run                           |
| GET    | `/api/state`         | Current `STATE.md` contents                       |

The `/api/execute` response is a `text/event-stream` of JSON events shaped like:

```json
{"phase":"PLAN","message":"Refined goal: ...","status":"success","timestamp":"...","payload":{...}}
```

## SQLite schema

```text
runs             (id, started_at, finished_at, vibe, goal, verdict, passed,
                  failed, total_milestones, provider, model, spec_retries)
milestones       (run_id, milestone_id, name, filename, returncode,
                  all_criteria_passed, criteria_json)
healing_events   (run_id, milestone_id, attempt, classification, reasoning, action)
events           (run_id, phase, message, status, timestamp, payload_json)
```

Query it directly:

```bash
sqlite3 kovix.db "SELECT id, verdict, passed, total_milestones, provider, model FROM runs ORDER BY id DESC LIMIT 20;"
```
