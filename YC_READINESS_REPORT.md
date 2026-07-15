# Kovix MVP — Y Combinator Readiness Report

**Date:** July 15, 2026
**Repo:** https://github.com/Razisafir/kovix-mvp
**Current version:** v6.5-nocancel
**Author:** Engineering audit

---

## Executive Summary

Kovix MVP is a standalone Electron desktop app that provides an AI-powered
agentic IDE with a 5-step workflow (Idea → Refine → Spec → Plan → Execute).
It supports 7 LLM providers (OpenAI, OpenRouter, Anthropic, Ollama, Gemini,
NVIDIA NIM, Z.ai), features a premium Material Design 3 UI, file management,
chat history, and streaming responses.

**Current state: 70% MVP-complete.** The core architecture is solid, the UI
is polished, and multi-provider support works. However, there are critical
reliability bugs, dead code from the old Python architecture, and missing
features that YC partners and early users will immediately notice.

**To be YC-ready, you need 2-3 weeks of focused work** on the items in this
report. Priority order is marked P0 (blocking), P1 (should fix), P2 (nice
to have).

---

## What's Working ✅

1. **Multi-provider architecture** — 7 providers, dynamic model fetching,
   OpenAI-compatible SDK path + native fetch for Anthropic/Gemini
2. **Streaming responses** — tokens appear in real-time, no more timeouts
3. **Premium UI** — Material Design 3 palette, Material Symbols icons,
   3-pane layout (file manager | chat | file viewer), resizable sidebar
4. **5-step state machine** — Idea → Refine → Spec → Plan → Execute
5. **File management** — recursive tree, expand/collapse, file viewer with
   line numbers, breadcrumb navigation
6. **Chat history** — sessions saved as JSON in workspace, load/resume/delete
7. **Settings** — provider dropdown, API key, base URL, auto-fetch models,
   test connection button
8. **Cancel button** — red pulsing cancel, smart watchdog
9. **Error handling** — user-friendly error messages for 401, 429, 5xx,
   network errors

---

## Critical Issues (P0 — Blocking)

### 1. Dead Python codebase (2,600 lines)
**Problem:** The repo contains 8 Python files (agent.py, bdd.py, db.py,
executor.py, loop.py, main.py, providers.py, setup_workspace.py) from the
old v0.2 architecture. These are completely unused — the app is now
Electron. They confuse contributors, inflate the repo, and make the
project look unfinished.

**Fix:** Delete all `.py` files, `requirements.txt`, and `scripts/smoke_test.py`.
Rewrite `README.md` to reflect the Electron architecture.

**Effort:** 1 hour

### 2. No automated tests
**Problem:** Zero tests. No unit tests, no integration tests, no E2E tests.
The app has been debugged manually through 20+ commits, and regressions
keep happening (the watchdog bug, the cancel bug, the session-save bug
were all regressions that tests would have caught).

**Fix:**
- Add `vitest` or `jest` for unit testing `extractCodeBlock`,
  `pickOutputFilename`, `sessionTitleFromMessages`
- Add Playwright or Spectron for E2E testing the 5-step workflow
- Add a CI workflow (GitHub Actions) that runs tests on every push
- Write tests for: settings save/load, session save/load, file tree
  building, code block extraction, each provider's fetch-models path

**Effort:** 3-5 days

### 3. No error boundary / crash recovery
**Problem:** If the main process crashes (e.g., a provider returns
malformed JSON, or a file path has unicode characters), the app dies
silently. There's no crash reporter, no auto-restart, no error boundary
in the renderer.

**Fix:**
- Add `process.on('uncaughtException')` handler that shows a dialog
  with the error and a "Reload" button
- Add `crashReporter` from Electron
- Wrap the renderer's `init()` in a try/catch that shows a fallback UI
  if something fails

**Effort:** 1 day

### 4. API keys stored in plaintext
**Problem:** `settings.json` stores the API key in plaintext. It's
gitignored, but anyone with file access to the user's machine can read it.

**Fix:**
- Use Electron's `safeStorage` API to encrypt the API key at rest
- Or use `keytar` for OS-level credential storage (Keychain on macOS,
  Credential Manager on Windows, Secret Service on Linux)

**Effort:** 1 day

### 5. No packaging / distribution
**Problem:** The app can only be run via `npm start`. There's no
installer, no `.exe`, no `.dmg`, no `.AppImage`. YC partners and users
can't try it without installing Node.js and cloning the repo.

**Fix:**
- Add `electron-builder` or `electron-forge` for packaging
- Create installers for Windows (.exe), macOS (.dmg), and Linux (.AppImage)
- Set up auto-update with `electron-updater`
- Code-sign the binaries (required for macOS, recommended for Windows)

**Effort:** 2-3 days

---

## Should Fix (P1)

### 6. No multi-file execution
**Problem:** The Execute step writes ONE file (index.html or script.js).
Real apps need multiple files (HTML + CSS + JS, or a multi-file Python
project). The agent can't build anything complex.

**Fix:**
- Parse multiple code blocks from the LLM response (each with its own
  filename from the language tag)
- Or change the prompt to ask for a JSON manifest of files
- Write each file to the workspace and refresh the tree

**Effort:** 1 day

### 7. No terminal / code execution
**Problem:** The agent can write files but can't run them. There's no
integrated terminal, no "Run" button, no way to test the generated code.

**Fix:**
- Add a terminal panel (use `node-pty` or `xterm.js`)
- Add a "Run" button that executes the generated file
- Stream stdout/stderr back to the UI

**Effort:** 2-3 days

### 8. No diff/preview before writing files
**Problem:** The Execute step writes files directly to disk with no
preview. If the LLM generates bad code, it overwrites the user's
existing files.

**Fix:**
- Show a diff preview before writing
- Add a "Apply" / "Discard" confirmation
- Keep a `.kovix/backups/` directory with auto-backed-up files

**Effort:** 1-2 days

### 9. No conversation branching
**Problem:** If the user wants to try a different approach, they have
to start over. There's no way to branch from a specific message.

**Fix:**
- Add "Fork from here" on each message
- Store branches in the session JSON
- Show branches as a tree in the history panel

**Effort:** 2-3 days

### 10. No keyboard shortcuts
**Problem:** No keyboard shortcuts for common actions. Power users
(YC partners are power users) expect Cmd/Ctrl+Enter to send, Cmd/Ctrl+N
for new chat, Cmd/Ctrl+, for settings, etc.

**Fix:**
- Add `Cmd/Ctrl+Enter` to send
- Add `Cmd/Ctrl+N` for new chat
- Add `Cmd/Ctrl+,` for settings
- Add `Cmd/Ctrl+B` to toggle sidebar
- Add `Cmd/Ctrl+Shift+I` is already DevTools

**Effort:** 0.5 days

### 11. No dark mode
**Problem:** The UI is light-mode only. Developers (the target audience)
overwhelmingly prefer dark mode.

**Fix:**
- Add a theme toggle in settings
- Define dark-mode CSS variables
- Respect `prefers-color-scheme` by default

**Effort:** 1 day

### 12. No model parameter customization
**Problem:** Temperature is hardcoded to 0.7. No way to adjust max_tokens,
top_p, or system prompt.

**Fix:**
- Add an "Advanced" section in settings
- Allow custom system prompts per project
- Save model params in the session

**Effort:** 1 day

---

## Nice to Have (P2)

### 13. No git integration
**Problem:** No way to init a git repo, commit changes, or push from
within the app.

**Fix:** Use `simple-git` or `isomorphic-git` to add git operations.

**Effort:** 2-3 days

### 14. No collaboration / sharing
**Problem:** Can't share a session with another person.

**Fix:** Export session as a shareable link or file. Import sessions.

**Effort:** 1-2 days

### 15. No plugin system
**Problem:** Can't extend the agent with custom tools.

**Fix:** Define a tool interface, let users add custom tools (file
search, web search, code execution, etc.)

**Effort:** 3-5 days

### 16. No analytics / telemetry
**Problem:** No way to know how users use the app, what errors they hit,
what providers are most popular.

**Fix:** Add opt-in, privacy-respecting telemetry (PostHog, Plausible,
or self-hosted).

**Effort:** 1 day

### 17. No landing page / marketing site
**Problem:** The GitHub README is the only marketing material.

**Fix:** Build a simple landing page (Next.js or plain HTML) with
screenshots, demo video, download links.

**Effort:** 1-2 days

---

## Ponytail Audit Summary

A ponytail audit (over-engineering scan) found:
- **2,600 lines of dead Python code** from the old architecture
- **Duplicate STEP_LABELS** constant in main.js and renderer.js
- **extractCodeBlockLang** is a separate function that re-runs the same
  regex as extractCodeBlock — should be merged
- **pickOutputFilename** is an 18-line switch that could be a 1-line map
- **withTimeout** is used in one place, could be inlined
- **README.md** references the old Python architecture, misleading

**Net: -2,600 lines possible by deleting dead code.**

---

## Skills & Tools to Add to the Agent

Currently the agent is a simple chatbot with file-writing capability. To
be a true "agentic IDE", it needs tools:

### Must-have tools (P0)
1. **File read** — agent can read existing files in the workspace
   (currently only the user can read files via the file viewer)
2. **File write** — already exists, but should support multiple files
3. **File search** — agent can search for text across all files (grep)
4. **Directory listing** — agent can list files in a directory
5. **Code execution** — agent can run code and see output (sandboxed)

### Should-have tools (P1)
6. **Web search** — agent can search the web for documentation
7. **Git operations** — agent can commit, diff, and revert
8. **Terminal** — agent can run shell commands
9. **Package manager** — agent can install npm/pip packages
10. **Linter/formatter** — agent can run eslint/prettier on generated code

### Nice-to-have tools (P2)
11. **Image generation** — agent can generate UI mockups
12. **Database** — agent can query a local SQLite database
13. **API tester** — agent can make HTTP requests to test APIs
14. **Browser automation** — agent can open a browser and test the UI
15. **Deploy** — agent can deploy to Vercel/Netlify/Render

### Tool implementation approach
Each tool should be:
- An IPC handler in `main.js` that executes the tool
- A function the LLM can call via function-calling (OpenAI) or
  tool-use (Anthropic)
- Displayed in the UI with a "tool call" indicator
- Sandboxed (especially code execution and shell commands)

---

## YC Interview Prep — Key Questions

### "What is Kovix?"
Kovix is an AI-powered agentic IDE that shifts coding from "chat-based
assistance" to "autonomous execution." You describe an idea, and Kovix
plans, builds, and tests the code — writing real files to your workspace,
not just snippets in a chat.

### "How is this different from Cursor / GitHub Copilot?"
- **Cursor** is a VS Code extension — it modifies code in your editor
- **Copilot** is autocomplete — it suggests the next line
- **Kovix** is a standalone IDE — it takes an idea and builds the ENTIRE
  project from scratch, end to end. It's not assistance, it's execution.

### "How is this different from Devin / Cognition?"
- **Devin** is cloud-based and autonomous — you give it a task and it
  works in the background
- **Kovix** is desktop-based and collaborative — you see each step,
  can intervene, and the files are on YOUR machine, not a cloud VM

### "Why will this succeed?"
1. **Desktop-first** = lower latency, no cloud costs, works offline
2. **Multi-provider** = users aren't locked into one LLM vendor
3. **Workspace-native** = files, git, and history travel with the project
4. **5-step workflow** = structured output, not a free-for-all chat

### "What's your biggest risk?"
The agent quality. If the LLM generates bad code, the user has to fix it
manually. Mitigation: diff preview, backup files, and a "heal" step that
fixes errors automatically.

---

## 30-Day Roadmap to YC-Ready

### Week 1: Stability
- [ ] Delete dead Python code
- [ ] Add unit tests for core functions
- [ ] Add crash recovery and error boundaries
- [ ] Encrypt API keys with safeStorage
- [ ] Fix all remaining P0 bugs

### Week 2: Features
- [ ] Multi-file execution
- [ ] Diff preview before writing
- [ ] Keyboard shortcuts
- [ ] Dark mode
- [ ] Model parameter customization

### Week 3: Tools
- [ ] File read tool (agent can read workspace files)
- [ ] File search tool (grep)
- [ ] Code execution tool (sandboxed)
- [ ] Terminal panel
- [ ] Tool-call UI indicators

### Week 4: Distribution
- [ ] Package with electron-builder
- [ ] Code-sign for macOS and Windows
- [ ] Landing page with demo video
- [ ] Set up auto-update
- [ ] Write proper README and docs

---

## Conclusion

Kovix has a strong foundation: multi-provider support, a polished UI,
streaming, file management, and a clear 5-step workflow. The architecture
is clean and the codebase is small (~4,000 lines of JS + HTML + CSS).

The biggest gaps are:
1. **Reliability** — no tests, no crash recovery, no encrypted keys
2. **Agent capability** — only writes one file, can't run code
3. **Distribution** — no installer, no landing page

With 3-4 weeks of focused work, this can be a compelling YC application.
The multi-provider, desktop-first, workspace-native approach is genuinely
differentiated from Cursor, Copilot, and Devin.
