# Kovix MVP — Skills & Integrations

This document describes how the Kovix agent's skill system works and how
the following GitHub repositories are integrated (or planned for integration):

---

## Architecture: The Lead Agent

Kovix uses a **Lead Agent** architecture — a single, persistent agent that
powers both Chat mode and Agent mode (the 5-step workflow).

### Shared State
- **Memory:** `convoState` in `main.js` — the conversation history is shared
  between Chat and Agent modes. Switching modes resets the conversation
  (because the system prompt changes), but sessions are saved to disk and
  can be resumed.
- **Sessions:** Stored in `AppData/Roaming/kovix-mvp/sessions/<workspace-hash>/`
  — travel with the workspace, not the mode.
- **Persistent Memory:** `AppData/Roaming/kovix-mvp/memory.json` — the
  `recall_memory` and `save_memory` tools store cross-session facts.
- **Skills:** All tools in `tools.js` are available to the lead agent.
  Sub-agents (spawned via `create_subagent`) can be assigned a subset.

### How the Lead Agent Works
1. User sends a message
2. Lead agent calls the LLM with the system prompt + tools description
3. LLM responds with either:
   - Normal text → displayed to user
   - A `<tool_call>` block → parsed, tool executed, result fed back
4. Steps 3-4 repeat until the LLM gives a final text response (max 10 iterations)
5. Final response is displayed + saved to the session

### Sub-Agent Authority
The lead agent has authority to:
- Spawn sub-agents via `create_subagent(task, tools)`
- Assign specific tools to each sub-agent
- Receive results and synthesize them

(In this MVP, sub-agents run synchronously. Full async sub-agent spawning
with worker threads is on the roadmap — see YC_READINESS_REPORT.md)

---

## Integrated Skills

### 1. Supermemory
**Repo:** https://github.com/supermemoryai/supermemory
**Status:** ✅ Integrated (simplified)

Implemented as two tools in `tools.js`:
- `save_memory(content, tags)` — saves a fact to `memory.json` in userData
- `recall_memory(query)` — searches stored memories by keyword/tag

**Full integration roadmap:** Connect to the supermemory cloud API for
vector-based semantic search across all past sessions. This would let the
agent remember things from weeks ago without loading every session file.

```js
// Current: simple keyword search
// Future: vector embedding search via supermemory API
const client = new SupermemoryClient({ apiKey: '...' });
const memories = await client.search(query);
```

---

### 2. Agent-Reach
**Repo:** https://github.com/Panniantong/agent-reach
**Status:** 🔄 Planned

Agent-Reach provides inter-agent communication protocols. In Kovix, this
would enable:
- The lead agent sending messages to sub-agents
- Sub-agents reporting back asynchronously
- Multi-agent collaboration on complex tasks

**Planned implementation:** Add a `message_agent(agentId, message)` tool
and a background worker thread pool for sub-agents.

---

### 3. Paul (PLAN/APPLY/HEAL)
**Repo:** https://github.com/ChristopherKahler/paul
**Status:** ✅ Integrated (concept)

The 5-step workflow (Idea → Refine → Spec → Plan → Execute) IS the
PLAN/APPLY/HEAL pattern:
- **PLAN** = Idea + Refine + Spec + Plan stages
- **APPLY** = Execute stage (writes code to disk)
- **HEAL** = Error handling in Execute (if no code block, retry)

The old Python files (agent.py, loop.py, etc.) that directly implemented
PAUL have been deleted — the concept lives on in the Electron app's
state machine.

---

### 4. Matt Pocock's Skills
**Repo:** https://github.com/mattpocock/skills
**Status:** 🔄 Planned

Matt Pocock's skills include:
- TDD (test-driven development)
- Code review patterns
- Refactoring strategies
- TypeScript best practices

**Planned implementation:** These would become additional tools:
- `run_tests()` — execute the project's test suite
- `review_code(path)` — analyze code for issues
- `refactor_suggest(path)` — suggest refactoring improvements

---

### 5. Superpowers
**Repo:** https://github.com/obra/superpowers
**Status:** 🔄 Planned

Superpowers is a skill discovery and composition framework. In Kovix, this
would enable:
- Dynamic skill loading (add new tools without restarting)
- Skill composition (combine multiple tools into a workflow)
- Skill marketplace (share tool definitions)

**Planned implementation:** A `skills/` directory where each `.js` file
exports a tool definition. The agent loads them dynamically at startup.

---

### 6. Andrej Karpathy Skills
**Repo:** https://github.com/multica-ai/andrej-karpathy-skills
**Status:** 🔄 Planned

ML/data science oriented skills:
- Data analysis
- Model training
- Visualization
- Statistical analysis

**Planned implementation:** Add Python integration (via `run_command`)
and specialized tools like `analyze_data(path)`, `train_model(config)`.

---

### 7. Ponytail
**Repo:** https://github.com/DietrichGebert/ponytail
**Status:** ✅ Integrated

Ponytail is an over-engineering audit tool. It's been integrated as the
`ponytail-audit` skill, which scans the codebase for:
- Dead code
- Reinvented standard library
- Speculative abstractions
- Unneeded dependencies

**Usage:** The audit was already run on this repo — it found and led to
the deletion of 2,492 lines of dead Python code.

---

## Available Tools (Current)

The lead agent has access to these tools in Chat mode:

| Tool | Description | Status |
|------|-------------|--------|
| `read_file(path)` | Read a file from the workspace | ✅ Working |
| `write_file(path, content)` | Write content to a file | ✅ Working |
| `list_directory(path)` | List files in a directory | ✅ Working |
| `search_files(query, path)` | Search for text across files | ✅ Working |
| `web_search(query)` | Search the web (DuckDuckGo) | ✅ Working |
| `run_command(command)` | Execute a shell command | ✅ Working |
| `create_subagent(task, tools)` | Spawn a sub-agent | 🔄 Synchronous stub |
| `recall_memory(query)` | Recall from persistent memory | ✅ Working |
| `save_memory(content, tags)` | Save to persistent memory | ✅ Working |

---

## How to Use the Agent

1. Switch to **Chat mode** (click "Chat" in the sidebar)
2. Open a workspace folder
3. Ask the agent to do something:
   - "Read the file src/index.js and tell me what it does"
   - "Create a new file called hello.js with a function that prints hello"
   - "Search the workspace for all uses of 'useState'"
   - "Search the web for the latest React documentation"
   - "Run npm install and tell me if it succeeds"
   - "Remember that I prefer TypeScript over JavaScript"

The agent will:
1. Show a "Using tool: read_file(path: ...)" message in the chat
2. Execute the tool
3. Show the result in a collapsible block
4. Continue reasoning and may call more tools
5. Give you a final answer

---

## Roadmap

See `YC_READINESS_REPORT.md` for the full 30-day roadmap, including:
- Async sub-agent spawning (worker threads)
- Native function calling (OpenAI/Anthropic tool use API)
- Git integration
- Terminal panel
- Plugin system for community skills
