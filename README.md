# Kovix

The AI development environment built for people who have ideas, not code.

Kovix is a standalone, offline-first desktop application that takes a user from a rough idea all the way to working software — through conversation, a shared plan, and an autonomous build agent that never touches your files without asking first.

[![CI](https://github.com/Razisafir/kovix-mvp/actions/workflows/ci.yml/badge.svg)](https://github.com/Razisafir/kovix-mvp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Problem: The "Vibe Coding" Gap

The world has 1 billion+ knowledge workers who think in systems but cannot write syntax. The "vibe coding" movement is exploding, but current AI coding tools (Cursor, GitHub Copilot, Windsurf) are built for developers. They assume the user already knows what they want, how to structure it, and how to read a git diff. They write code immediately without staged reviews.

Kovix is built from first principles for the non-coder.

## The Solution: The 6-Stage Autonomous Pipeline

Kovix guides users through a structured, transparent process:

1. **Idea** — Describe what you want in plain English. A single sentence is enough.
2. **Refinement** — Kovix interviews you to sharpen the idea, surface tradeoffs, and define scope before building.
3. **Spec Approval** — Kovix generates a written specification. You edit, push back, and explicitly approve it.
4. **Plan** — Kovix generates a milestone-by-milestone execution plan.
5. **Configuration** — Set agent autonomy levels (pause every step, pause at milestones, or full auto) and credit budgets.
6. **Execution** — The agent builds the software, routing all changes through the Approve Gate.

## The Core Differentiator: The Approve-Before-Write Gate ("Trust UX")

Non-coders are terrified of AI agents silently overwriting their files.

In Kovix, every single file write is staged first. The user sees exactly what will change via a line-by-line diff before anything touches the local disk. Users can Accept, Reject, or Modify each change individually. This applies in every mode, including full auto.

## Tech Stack

- **Environment:** Standalone Desktop App (Electron)
- **Runtime:** Node.js 22
- **Editor UI:** Monaco Editor integration (for inline diffs and code review)
- **Agent Architecture:** Multi-agent swarm supporting 11+ LLM providers (OpenAI, Anthropic, Ollama, etc.) with local-first session persistence.

## Development Status

We recently executed a massive pivot from a heavy Python/FastAPI backend to a lean, ground-up Electron MVP.

Current focus: Wiring the Monaco DiffEditor into the Approve-Before-Write staging module.

## For Developers

### Run from source

```bash
git clone https://github.com/Razisafir/kovix-mvp.git
cd kovix-mvp
npm install
npm start
```

### Run the test suite

```bash
npm test                    # runs all 3 smoke test suites (129 tests total)
npm run test:staging        # 42 tests — staging engine + backup logic
npm run test:gamma          # 21 tests — agent routing + reject feedback
npm run test:zeta           # 66 tests — multi-file code block extraction
```

### Build installers for distribution

```bash
npm run dist:mac            # builds .dmg (x64 + arm64) and .zip
npm run dist:win            # builds .exe installer + portable .exe
npm run dist:linux          # builds .AppImage + .deb
npm run dist                # builds for current platform
npm run dist:all            # builds for all 3 platforms (run on macOS with cross-compile)
```

Output goes to `dist/`. The build:

- Packages the app as an asar archive (Monaco editor assets included)
- Excludes `settings.json`, `scripts/`, `.kovix/`, and test files from the package
- Auto-backs up user files to `<workspace>/.kovix/backups/` at runtime (never inside the app bundle)

### Continuous Integration

Every push to `main` and every PR runs the full test suite on GitHub Actions — Node 22, Ubuntu. The green checkmark at the top of this README confirms the build is healthy.

