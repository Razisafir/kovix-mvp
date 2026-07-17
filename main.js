'use strict';

/**
 * Kovix MVP — Electron main process
 *
 * Responsibilities:
 *  - Create the BrowserWindow and load index.html
 *  - Persist user settings (provider / apiKey / baseUrl / model) to settings.json
 *  - Manage an "active workspace" directory (persisted across sessions in settings)
 *  - Fetch available models from any of the 5 supported providers
 *  - Orchestrate the 5-step state machine (Idea -> Refine -> Spec -> Plan -> Execute)
 *  - Call the configured LLM dynamically (openai SDK for OpenAI/OpenRouter/Ollama,
 *    native fetch for Anthropic/Gemini)
 *  - Parse the final code block out of the LLM response and write it to a file
 *    INSIDE the active workspace (default: index.html, fallback: output.txt)
 *  - Serve the file tree and file contents to the renderer
 *  - Notify the renderer when the file tree changes (so the FM auto-refreshes)
 *
 * Every IPC handler and every LLM call is wrapped in try/catch so the renderer
 * always receives a structured error string instead of crashing the app.
 */

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

// openai SDK is used for OpenAI, OpenRouter, and Ollama (all expose an OpenAI-compatible /v1/chat/completions endpoint).
const OpenAI = require('openai').default || require('openai');

// Agent tools system — gives the lead agent the ability to read/write files,
// search the web, run commands, etc. Turns Kovix from a chatbot into a real
// autonomous agent like Cursor or Antigravity.
const { executeTool, buildAgentSystemPrompt, parseToolCalls } = require('./tools');

// THE APPROVE-BEFORE-WRITE GATE — every file write from the autonomous agent
// (both the Execute step and the write_file tool) MUST pass through staging.
// The user sees a Monaco diff and explicitly accepts, rejects, or modifies
// each change before it touches disk. See staging.js for the full contract.
const { staging, STAGING_CHANNELS } = require('./staging');

// Multi-file code block extraction (Task Zeta — "App Builder" upgrade).
// Extracted into a standalone module so the parsing logic is unit-testable
// without launching Electron. main.js re-exports the functions for internal use.
const codeBlocks = require('./code-blocks');
const extractCodeBlocks = codeBlocks.extractCodeBlocks;
const extractFilenameFromComment = codeBlocks.extractFilenameFromComment;
const extractFilenameFromPrecedingLine = codeBlocks.extractFilenameFromPrecedingLine;

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const APP_ROOT = __dirname;
const SETTINGS_PATH = path.join(APP_ROOT, 'settings.json');

const DEFAULT_SETTINGS = {
  provider: '',
  apiKey: '',
  baseUrl: '',
  model: '',
  activeWorkspace: '',
  mode: 'agent',  // 'agent' (5-step workflow) or 'chat' (free conversation)
};

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  zai: 'https://api.z.ai/api/paas/v4',
};

/**
 * State machine for the conversation.
 *   idea    -> user typed an idea, ask clarifying questions
 *   refine  -> user answered, generate spec
 *   spec    -> spec generated, generate plan
 *   plan    -> plan generated, execute step 1
 *   execute -> parse code block, write to disk
 */
const STEPS = ['idea', 'refine', 'spec', 'plan', 'execute'];

const SYSTEM_PROMPTS = {
  idea: 'You are a product manager helping the user refine their app idea. Your job is to understand what they want to build. Ask 1-2 clarifying questions each turn to understand: what the app does, who it\'s for, key features, and any technical preferences. Do NOT write code. Do NOT generate a spec. Just have a conversation to understand the idea better. If the user\'s message is vague (like "hi" or "hello"), ask them what they want to build. Only when you have a clear understanding should you suggest moving to the next step.',
  refine: 'You are a product manager refining the user\'s idea. Ask follow-up questions about edge cases, user flows, data models, and UI/UX details. Do NOT write code. Do NOT generate a spec yet. Keep asking questions until you have enough detail to write a complete specification. If the user says "next" or "ready for spec", acknowledge and wait for the user to click the Next Step button.',
  spec: 'Based on the conversation, output a formal markdown specification for the app. Include: Overview, Objectives, Target Audience, Functional Requirements, Non-Functional Requirements, UI Specifications, and Technical Stack. Output ONLY the spec in markdown.',
  plan: 'Break this spec into a 1-3 step milestone plan. Each milestone should be a concrete deliverable. Output ONLY the plan in markdown.',
  execute: 'You are an autonomous software engineer. Output the COMPLETE code for the project. You may output MULTIPLE files in one response — use a separate fenced code block for each file. Tag each code block with the filename using the syntax ```lang:filepath (e.g. ```html:index.html, ```jsx:src/App.jsx, ```css:src/styles.css). If the user previously rejected a file, address their feedback directly and do NOT repeat the rejected approach. Output ONLY the code blocks with a one-line description before each — no long explanations.',
};

// Keywords that indicate the user wants to advance to the next step.
const ADVANCE_KEYWORDS = ['next', 'continue', 'ready', 'done', 'go ahead', 'proceed', 'move on', 'spec', 'plan', 'execute', 'looks good', 'that works', 'yes', 'ok go', 'let\'s go'];

function userWantsToAdvance(text) {
  const lower = text.toLowerCase().trim();
  // Exact match or starts with the keyword
  return ADVANCE_KEYWORDS.some(kw => lower === kw || lower.startsWith(kw + ' ') || lower.startsWith('next step') || lower.startsWith('ready for'));
}

// Per-step user-facing labels (renderer also keeps its own copy).
const STEP_LABELS = {
  idea: 'Idea',
  refine: 'Refine',
  spec: 'Spec',
  plan: 'Plan',
  execute: 'Execute',
};

// Directories to hide from the file tree.
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.cache', '.kovix']);
// Max file size we will read into the viewer (8 MB) to avoid OOM on big binaries.
const MAX_READ_BYTES = 8 * 1024 * 1024;
// How deep buildTree recurses. Big enough for real project layouts; deep enough
// that clicking a subfolder reveals its contents without another IPC round-trip.
const TREE_MAX_DEPTH = 6;

/* -------------------------------------------------------------------------- */
/* Settings persistence                                                       */
/* -------------------------------------------------------------------------- */
//
// All file I/O in the main process is ASYNC. Synchronous fs.*Sync() calls
// block the Electron event loop, which freezes the BrowserWindow and makes
// Windows show "(Not Responding)". This is especially bad when the workspace
// is on a slow drive (network mount, OneDrive sync, spinning disk).

async function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    console.error('Failed to read settings.json:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(next) {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...next };
    await fsp.writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error('Failed to write settings.json:', err);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Active workspace                                                           */
/* -------------------------------------------------------------------------- */

async function getActiveWorkspace() {
  const s = await readSettings();
  return s.activeWorkspace || '';
}

async function setActiveWorkspace(dirPath) {
  const s = await readSettings();
  return writeSettings({ ...s, activeWorkspace: dirPath });
}

/* -------------------------------------------------------------------------- */
/* Model fetching                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the list of available model IDs from a provider.
 * @param {{provider:string, apiKey:string, baseUrl:string}} cfg
 * @returns {Promise<string[]>}
 */
async function fetchModels(cfg) {
  const provider = (cfg.provider || '').toLowerCase();
  const apiKey = cfg.apiKey || '';
  const baseUrl = (cfg.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '');

  if (!provider) {
    throw new Error('No provider selected.');
  }

  switch (provider) {
    case 'openai':
    case 'openrouter':
    case 'nvidia':
    case 'zai': {
      if (!apiKey) throw new Error(`API key is required for ${provider}.`);
      const url = `${baseUrl || DEFAULT_BASE_URLS[provider]}/models`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        const body = await safeReadText(res);
        throw new Error(`${provider} /models returned ${res.status}: ${body}`);
      }
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data : [];
      return models
        .map((m) => m?.id)
        .filter((id) => typeof id === 'string')
        .sort();
    }

    case 'anthropic': {
      if (!apiKey) throw new Error('API key is required for Anthropic.');
      const url = `${baseUrl || DEFAULT_BASE_URLS.anthropic}/v1/models`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) {
        const body = await safeReadText(res);
        throw new Error(`Anthropic /v1/models returned ${res.status}: ${body}`);
      }
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data : [];
      return models
        .map((m) => m?.id)
        .filter((id) => typeof id === 'string')
        .sort();
    }

    case 'ollama': {
      const tagsUrl = `${baseUrl || 'http://localhost:11434'}/api/tags`;
      const res = await fetch(tagsUrl, { method: 'GET' });
      if (!res.ok) {
        const body = await safeReadText(res);
        throw new Error(`Ollama /api/tags returned ${res.status}: ${body}`);
      }
      const data = await res.json();
      const models = Array.isArray(data?.models) ? data.models : [];
      return models
        .map((m) => m?.name || m?.model)
        .filter((id) => typeof id === 'string')
        .sort();
    }

    case 'gemini': {
      if (!apiKey) throw new Error('API key is required for Gemini.');
      const url = `${baseUrl || DEFAULT_BASE_URLS.gemini}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        const body = await safeReadText(res);
        throw new Error(`Gemini /v1beta/models returned ${res.status}: ${body}`);
      }
      const data = await res.json();
      const models = Array.isArray(data?.models) ? data.models : [];
      return models
        .map((m) => m?.name)
        .filter((id) => typeof id === 'string')
        .map((id) => id.replace(/^models\//, ''))
        .sort();
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (_) {
    return '<no body>';
  }
}

/**
 * Wrap a promise with a hard timeout. Resolves to {ok, value} or {ok:false, error}.
 * Used to put a ceiling on LLM calls so a hung request can't freeze the UI forever.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: `${label || 'Request'} timed out after ${Math.round(ms / 1000)}s.` });
    }, ms);
    promise
      .then((value) => { clearTimeout(timer); resolve({ ok: true, value }); })
      .catch((err)  => { clearTimeout(timer); resolve({ ok: false, error: err && err.message ? err.message : String(err) }); });
  });
}

/* -------------------------------------------------------------------------- */
/* Dynamic LLM caller                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run a single chat-completion turn against the configured provider.
 *
 * @param {object} settings  - saved settings (provider/apiKey/baseUrl/model)
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Promise<string>} assistant text
 */
async function callLLM(settings, messages) {
  const provider = (settings.provider || '').toLowerCase();
  const apiKey = settings.apiKey || '';
  const baseUrl = (settings.baseUrl || DEFAULT_BASE_URLS[provider] || '').replace(/\/+$/, '');
  const model = settings.model || '';

  if (!provider) throw new Error('No provider configured. Open Settings and pick a provider.');
  if (!model) throw new Error('No model configured. Open Settings and pick a model.');

  switch (provider) {
    case 'openai':
    case 'openrouter':
    case 'ollama':
    case 'nvidia':
    case 'zai': {
      if (provider !== 'ollama' && !apiKey) {
        throw new Error(`API key is required for ${provider}.`);
      }
      const client = new OpenAI({
        apiKey: apiKey || 'ollama',
        baseURL: baseUrl || DEFAULT_BASE_URLS[provider],
        // CRITICAL: the openai SDK defaults to maxRetries:2 with exponential
        // backoff, which can hang for minutes on 429/5xx and freeze the UI.
        // maxRetries:0 = no retries, fail immediately on any error so the
        // user sees the real error message (401, 429, etc.) instantly.
        maxRetries: 0,
        // SDK-level timeout: aborts the HTTP request after 45s.
        timeout: 40_000,
        defaultHeaders: provider === 'openrouter' ? {
          'HTTP-Referer': 'https://github.com/Razisafir/kovix-mvp',
          'X-Title': 'Kovix MVP',
        } : undefined,
      });
      // NOTE: do NOT pass an external AbortController signal here. The SDK
      // creates its own internal signal from the `timeout` option, and
      // passing a second signal conflicts with it, causing spurious
      // "Request was aborted" errors. The SDK's own timeout is sufficient.
      //
      // STREAMING: instead of waiting for the full response (which can take
      // 40-60s on slow providers), we stream tokens as they arrive. The
      // renderer displays them in real-time, so the user sees progress
      // immediately and never wonders if the app is hung.
      console.log('[callLLM] openai-sdk path: baseURL =', baseUrl || DEFAULT_BASE_URLS[provider], 'model =', model);
      const stream = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
        stream: true,
      });
      console.log('[callLLM] stream started, waiting for chunks...');
      let text = '';
      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content || '';
        if (delta) {
          text += delta;
          // Send each delta to the renderer for live display.
          sendToRenderer('llm:delta', { delta });
        }
      }
      if (!text) throw new Error('LLM returned an empty response.');
      return text;
    }

    case 'anthropic': {
      if (!apiKey) throw new Error('API key is required for Anthropic.');
      const url = `${baseUrl || DEFAULT_BASE_URLS.anthropic}/v1/messages`;
      const sysMsg = messages.find((m) => m.role === 'system');
      const userTurns = messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
      const body = {
        model,
        max_tokens: 4096,
        messages: userTurns,
        stream: true,  // STREAMING — tokens arrive as they're generated
      };
      if (sysMsg) body.system = sysMsg.content;
      const ac = new AbortController();
      // Longer timeout for streaming: the first token should arrive in 1-5s,
      // but the full response can take 60s+. We set 120s as the hard cap.
      const timeout = setTimeout(() => ac.abort(), 120_000);
      let res;
      try {
        console.log('[callLLM] anthropic path: url =', url, 'model =', model);
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        if (err && err.name === 'AbortError') {
          throw new Error('Anthropic request timed out after 120s.');
        }
        throw err;
      }
      console.log('[callLLM] anthropic response status:', res.status);
      if (!res.ok) {
        clearTimeout(timeout);
        const errText = await safeReadText(res);
        throw new Error(`Anthropic /v1/messages returned ${res.status}: ${errText}`);
      }
      console.log('[callLLM] anthropic stream started, reading body...');
      // Parse the SSE stream. Anthropic sends events like:
      //   event: content_block_delta
      //   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
      let text = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Split on double newlines (SSE event delimiter)
          const events = buffer.split('\n\n');
          buffer = events.pop() || ''; // keep the last partial event
          for (const evt of events) {
            const lines = evt.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr || jsonStr === '[DONE]') continue;
              try {
                const data = JSON.parse(jsonStr);
                if (data.type === 'content_block_delta' && data.delta?.text) {
                  text += data.delta.text;
                  sendToRenderer('llm:delta', { delta: data.delta.text });
                }
              } catch (_) { /* skip malformed JSON */ }
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }
      if (!text) throw new Error('Anthropic returned an empty response.');
      return text;
    }

    case 'gemini': {
      if (!apiKey) throw new Error('API key is required for Gemini.');
      const url = `${baseUrl || DEFAULT_BASE_URLS.gemini}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));
      const sysMsg = messages.find((m) => m.role === 'system');
      const body = {
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
      };
      if (sysMsg) {
        body.systemInstruction = { parts: [{ text: sysMsg.content }] };
      }
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 40_000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        if (err && err.name === 'AbortError') {
          throw new Error('Gemini request timed out after 40s.');
        }
        throw err;
      }
      if (!res.ok) {
        clearTimeout(timeout);
        const errText = await safeReadText(res);
        throw new Error(`Gemini generateContent returned ${res.status}: ${errText}`);
      }
      const data = await res.json();
      clearTimeout(timeout);
      const text = Array.isArray(data?.candidates?.[0]?.content?.parts)
        ? data.candidates[0].content.parts.map((p) => p?.text || '').join('')
        : '';
      if (!text) throw new Error('Gemini returned an empty response.');
      return text;
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/* -------------------------------------------------------------------------- */
/* File tree                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a file tree for a directory, recursively to `maxDepth`.
 * Returns: { name, path (absolute), type: 'file'|'dir', children?: [] }
 *
 * Filters out IGNORED_DIRS and dotfiles at the top level.
 */
async function buildTree(dirPath, maxDepth = 1, currentDepth = 0) {
  const node = {
    name: path.basename(dirPath),
    path: dirPath,
    type: 'dir',
    children: [],
  };
  if (currentDepth >= maxDepth) return node;

  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    node.error = err.message;
    return node;
  }

  // Sort: directories first, then files, alphabetical within each group.
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const child = await buildTree(fullPath, maxDepth, currentDepth + 1);
      node.children.push(child);
    } else if (entry.isFile()) {
      node.children.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
      });
    }
  }
  return node;
}

/**
 * Read a file as UTF-8 text if it's under MAX_READ_BYTES. Returns:
 *   { ok: true, content, path, name, size, binary: false }
 *   { ok: true, content: '<binary file>', path, name, size, binary: true }
 *   { ok: false, error } on failure
 */
async function readTextFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, error: 'Not a file.' };
    }
    const sizeBytes = stat.size;
    if (sizeBytes > MAX_READ_BYTES) {
      return {
        ok: true,
        path: filePath,
        name: path.basename(filePath),
        size: sizeBytes,
        binary: true,
        content: `<file too large to display: ${sizeBytes} bytes>`,
      };
    }
    // Detect binary: read first 4 KB and look for NUL bytes.
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(4096, sizeBytes));
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const slice = buf.slice(0, bytesRead);
      const isBinary = slice.includes(0);
      if (isBinary) {
        return {
          ok: true,
          path: filePath,
          name: path.basename(filePath),
          size: sizeBytes,
          binary: true,
          content: `<binary file: ${sizeBytes} bytes>`,
        };
      }
    } finally {
      await fd.close();
    }
    const content = await fsp.readFile(filePath, 'utf8');
    return {
      ok: true,
      path: filePath,
      name: path.basename(filePath),
      size: sizeBytes,
      binary: false,
      content,
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Conversation state                                                         */
/* -------------------------------------------------------------------------- */

const convoState = {
  step: 'idea',
  messages: [], // [{role:'system'|'user'|'assistant', content:string}]
  sessionId: null, // current session id (null = unsaved / new)
  startedAt: null, // ISO timestamp when the session was first created
};

function resetConvo() {
  convoState.step = 'idea';
  convoState.messages = [];
  convoState.sessionId = null;
  convoState.startedAt = null;
}

function advanceStep(current) {
  const idx = STEPS.indexOf(current);
  if (idx === -1) return 'idea';
  return STEPS[Math.min(idx + 1, STEPS.length - 1)];
}

/* -------------------------------------------------------------------------- */
/* Session persistence                                                        */
/* -------------------------------------------------------------------------- */
//
// Sessions are stored as JSON files in Electron's userData directory:
//   C:\Users\<user>\AppData\Roaming\kovix-mvp\sessions\<workspaceHash>\<id>.json
//
// Each file is a self-contained transcript:
//   {
//     id, startedAt, updatedAt, step, workspacePath,
//     title,            // first user message (truncated)
//     messages: [...]   // full role/content history
//   }
//
// We store in userData (not in the workspace) because workspace folders
// are often cloud-synced (OneDrive, Google Drive, Dropbox) or on slow
// drives, which causes fsp.mkdir / fsp.writeFile to hang for 60+ seconds
// and freeze the app.

// Sessions are stored in Electron's userData directory (NOT in the workspace)
// to avoid OneDrive / cloud-sync / antivirus hangs on workspace file I/O.
// Each workspace gets its own subdirectory keyed by a hash of its path, so
// sessions are still per-workspace but live in a fast, local, never-synced
// location: C:\Users\<user>\AppData\Roaming\kovix-mvp\sessions\<hash>\
const crypto = require('crypto');

function hashWorkspacePath(ws) {
  // Normalize separators so Windows C:\foo and C:/foo map to the same hash.
  const normalized = path.resolve(ws).toLowerCase();
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

function getSessionsRootDir() {
  // app.getPath('userData') is C:\Users\<user>\AppData\Roaming\<appName>
  // on Windows, ~/Library/Application Support/<appName> on macOS, and
  // ~/.config/<appName> on Linux. NEVER cloud-synced.
  try {
    return path.join(app.getPath('userData'), 'sessions');
  } catch (err) {
    console.error('[sessions] could not get userData path:', err);
    return '';
  }
}

async function getSessionsDir() {
  const ws = await getActiveWorkspace();
  if (!ws) {
    console.log('[sessions] getSessionsDir: no active workspace');
    return '';
  }
  const root = getSessionsRootDir();
  if (!root) return '';
  // Per-workspace subdirectory keyed by path hash, so each workspace has
  // its own session history but all sessions live in userData (fast + local).
  const dir = path.join(root, hashWorkspacePath(ws));
  return dir;
}

async function ensureSessionsDir() {
  const dir = await getSessionsDir();
  if (!dir) return '';
  try {
    console.log('[sessions] mkdir start:', dir);
    const t0 = Date.now();
    await fsp.mkdir(dir, { recursive: true });
    console.log('[sessions] mkdir done in', Date.now() - t0, 'ms:', dir);
    return dir;
  } catch (err) {
    console.error('[sessions] Failed to create sessions dir:', dir, err);
    return '';
  }
}

function genSessionId() {
  // YYYYMMDD-HHMMSS-xxxx — sortable + collision-resistant
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

function sessionTitleFromMessages(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'Untitled session';
  const t = (firstUser.content || '').trim().replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 57) + '…' : (t || 'Untitled session');
}

async function saveCurrentSession() {
  if (!convoState.messages.some((m) => m.role !== 'system')) {
    console.log('[sessions] save: skipped (no non-system messages)');
    return null;
  }
  const dir = await ensureSessionsDir();
  if (!dir) {
    console.log('[sessions] save: no dir available, cannot save');
    return null;
  }
  if (!convoState.sessionId) {
    convoState.sessionId = genSessionId();
    convoState.startedAt = new Date().toISOString();
  }
  const session = {
    id: convoState.sessionId,
    startedAt: convoState.startedAt,
    updatedAt: new Date().toISOString(),
    step: convoState.step,
    title: sessionTitleFromMessages(convoState.messages),
    messages: convoState.messages.slice(),
    workspacePath: await getActiveWorkspace(),  // so we can show which workspace
  };
  try {
    const filePath = path.join(dir, `${convoState.sessionId}.json`);
    console.log('[sessions] writeFile start:', filePath);
    const t0 = Date.now();
    await fsp.writeFile(filePath, JSON.stringify(session, null, 2), 'utf8');
    console.log('[sessions] writeFile done in', Date.now() - t0, 'ms');
    return session;
  } catch (err) {
    console.error('[sessions] save FAILED:', err);
    return null;
  }
}

async function listSessions() {
  // List sessions from ALL workspaces, not just the current one.
  // Each session includes its workspacePath so the UI can show which
  // workspace it belongs to.
  const root = getSessionsRootDir();
  if (!root || !fs.existsSync(root)) {
    console.log('[sessions] list: no sessions root dir yet:', root);
    return [];
  }
  try {
    const allSessions = [];
    // Each subdirectory is a workspace hash
    const workspaceDirs = await fsp.readdir(root, { withFileTypes: true });
    for (const wsDir of workspaceDirs) {
      if (!wsDir.isDirectory()) continue;
      const wsDirPath = path.join(root, wsDir.name);
      let files;
      try {
        files = await fsp.readdir(wsDirPath);
      } catch (_) { continue; }
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      for (const f of jsonFiles) {
        try {
          const raw = await fsp.readFile(path.join(wsDirPath, f), 'utf8');
          const s = JSON.parse(raw);
          if (s && s.id && Array.isArray(s.messages)) {
            allSessions.push({
              id: s.id,
              startedAt: s.startedAt || '',
              updatedAt: s.updatedAt || '',
              step: s.step || 'idea',
              title: s.title || sessionTitleFromMessages(s.messages) || 'Untitled session',
              messageCount: s.messages.filter((m) => m.role !== 'system').length,
              workspacePath: s.workspacePath || '',
              workspaceHash: wsDir.name,
            });
          }
        } catch (_) { /* skip corrupt files */ }
      }
    }
    console.log('[sessions] list: found', allSessions.length, 'sessions across all workspaces');
    // Newest first
    allSessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return allSessions;
  } catch (err) {
    console.error('listSessions error:', err);
    return [];
  }
}

async function loadSession(id) {
  // Search ALL workspace directories for the session, not just the current one.
  // This lets users load sessions from any workspace.
  const root = getSessionsRootDir();
  if (!root || !fs.existsSync(root)) return null;
  try {
    const workspaceDirs = await fsp.readdir(root, { withFileTypes: true });
    for (const wsDir of workspaceDirs) {
      if (!wsDir.isDirectory()) continue;
      const file = path.join(root, wsDir.name, `${id}.json`);
      if (fs.existsSync(file)) {
        const raw = await fsp.readFile(file, 'utf8');
        const s = JSON.parse(raw);
        if (!s || !s.id || !Array.isArray(s.messages)) return null;
        convoState.sessionId = s.id;
        convoState.startedAt = s.startedAt || new Date().toISOString();
        convoState.step = s.step || 'idea';
        convoState.messages = s.messages.slice();
        // Switch to the session's workspace if different from current
        if (s.workspacePath && s.workspacePath !== (await getActiveWorkspace())) {
          // Reset staging BEFORE switching — pending proposals belong to the
          // old workspace and would write to the wrong place if accepted.
          staging.reset();
          await setActiveWorkspace(s.workspacePath);
          notifyTreeChanged(null);
        }
        return s;
      }
    }
    return null;  // session not found in any workspace
  } catch (err) {
    console.error('loadSession error:', err);
    return null;
  }
}

async function deleteSession(id) {
  // Search ALL workspace directories for the session to delete.
  const root = getSessionsRootDir();
  if (!root) return false;
  try {
    const workspaceDirs = await fsp.readdir(root, { withFileTypes: true });
    for (const wsDir of workspaceDirs) {
      if (!wsDir.isDirectory()) continue;
      const file = path.join(root, wsDir.name, `${id}.json`);
      if (fs.existsSync(file)) {
        await fsp.unlink(file);
        // If we just deleted the active session, reset convo state too.
        if (convoState.sessionId === id) resetConvo();
        return true;
      }
    }
    return false;  // session not found
  } catch (err) {
    console.error('deleteSession error:', err);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Renderer notification helpers                                              */
/* -------------------------------------------------------------------------- */

let mainWindow = null;

// Flag to prevent concurrent LLM calls. When true, a new send-message call
// is rejected immediately so the convo state doesn't get corrupted.
let llmBusy = false;
// Flag to prevent cancel-current from dropping messages while a save is
// in progress. This ensures sessions are always saved with the user's
// message even if they cancel during the save.
let saveInProgress = false;

function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (err) {
    console.error(`Failed to send ${channel} to renderer:`, err);
  }
}

// Initialize the staging manager — every file write from the agent MUST
// pass through here. The renderer subscribes to STAGING_CHANNELS.PROPOSE
// and STAGING_CHANNELS.QUEUE_UPDATE to render the Monaco diff UI.
// getWorkspace is async because it reads from settings.json on disk.
staging.init({
  getWorkspace: () => getActiveWorkspace(),
  sendToRenderer,
});

function notifyTreeChanged(relativePath) {
  sendToRenderer('fs:tree-changed', { relativePath });
}

/* -------------------------------------------------------------------------- */
/* IPC handlers — Settings & Models                                           */
/* -------------------------------------------------------------------------- */

ipcMain.handle('get-settings', async () => {
  try {
    return await readSettings();
  } catch (err) {
    console.error('get-settings error:', err);
    return { ...DEFAULT_SETTINGS };
  }
});

ipcMain.handle('save-settings', async (_evt, next) => {
  try {
    if (!next || typeof next !== 'object') {
      throw new Error('Invalid settings payload.');
    }
    return await writeSettings(next);
  } catch (err) {
    console.error('save-settings error:', err);
    throw err;
  }
});

ipcMain.handle('fetch-models', async (_evt, cfg) => {
  try {
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('Invalid fetch-models payload.');
    }
    const models = await fetchModels(cfg);
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error('Provider returned no models.');
    }
    return models;
  } catch (err) {
    console.error('fetch-models error:', err);
    throw err;
  }
});

/**
 * Test Connection — does a quick fetch-models call with a short timeout
 * to verify the API key + network are working before the user chats.
 * Returns { ok: true, modelCount } or { ok: false, error }.
 */
ipcMain.handle('test-connection', async (_evt, cfg) => {
  try {
    if (!cfg || typeof cfg !== 'object') {
      return { ok: false, error: 'Invalid config.' };
    }
    console.log('[test-connection] testing provider =', cfg.provider);
    // Race the fetchModels against a 15s timeout — if it takes longer, the
    // network is too slow for reliable chat.
    const result = await withTimeout(fetchModels(cfg), 15_000, 'Connection test');
    if (!result.ok) {
      console.log('[test-connection] failed:', result.error);
      return { ok: false, error: result.error };
    }
    const models = result.value;
    if (!Array.isArray(models) || models.length === 0) {
      return { ok: false, error: 'Provider returned no models. Check your API key.' };
    }
    console.log('[test-connection] success, models =', models.length);
    return { ok: true, modelCount: models.length };
  } catch (err) {
    console.error('[test-connection] error:', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

/* -------------------------------------------------------------------------- */
/* IPC handlers — Workspace & Files                                           */
/* -------------------------------------------------------------------------- */

ipcMain.handle('dialog:open-folder', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Select Workspace Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const dirPath = result.filePaths[0];
    await setActiveWorkspace(dirPath);
    // Reset staging — any pending proposals belonged to the previous workspace.
    staging.reset();
    // Notify any open renderer that the workspace (and thus the tree) changed.
    notifyTreeChanged(null);
    return { ok: true, path: dirPath };
  } catch (err) {
    console.error('dialog:open-folder error:', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('fs:get-workspace', async () => {
  return { path: await getActiveWorkspace() };
});

ipcMain.handle('fs:get-tree', async () => {
  try {
    const ws = await getActiveWorkspace();
    if (!ws) {
      return { ok: false, error: 'No workspace open.' };
    }
    try {
      const stat = await fsp.stat(ws);
      if (!stat.isDirectory()) {
        return { ok: false, error: 'Workspace path is not a directory.' };
      }
    } catch (_) {
      return { ok: false, error: 'Workspace path does not exist.' };
    }
    const tree = await buildTree(ws, TREE_MAX_DEPTH);
    return { ok: true, root: ws, tree };
  } catch (err) {
    console.error('fs:get-tree error:', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('fs:read-file', async (_evt, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, error: 'No file path provided.' };
    }
    // Sanity: file must live inside the active workspace (if one is set).
    const ws = await getActiveWorkspace();
    const resolved = path.resolve(filePath);
    if (ws) {
      const wsResolved = path.resolve(ws);
      if (resolved !== wsResolved && !resolved.startsWith(wsResolved + path.sep)) {
        return { ok: false, error: 'File is outside the active workspace.' };
      }
    }
    return await readTextFile(resolved);
  } catch (err) {
    console.error('fs:read-file error:', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

/* -------------------------------------------------------------------------- */
/* IPC handlers — Chat & state machine                                        */
/* -------------------------------------------------------------------------- */

/**
 * send-message handler — runs the state machine.
 *
 * Renderer contract:
 *   request:  { text: string }
 *   response: {
 *     ok: boolean,
 *     step: string,                       // current step after this turn
 *     nextStep: string,                   // step the UI should switch to
 *     assistant: string,                  // assistant text to display (may be empty)
 *     info?: string,                      // success/info banner
 *     error?: string,                     // error banner (red)
 *     wroteFile?: boolean,                // true if a file was written
 *     writtenPath?: string,               // absolute path of the written file (if any)
 *     writtenName?: string,               // basename of the written file (if any)
 *   }
 */
ipcMain.handle('send-message', async (_evt, req) => {
  const logTag = '[send-message]';
  try {
    console.log(logTag, 'received, step =', convoState.step);

    if (!req || typeof req !== 'object' || typeof req.text !== 'string') {
      throw new Error('Invalid send-message payload.');
    }

    // Prevent concurrent calls — if a previous LLM call is still running,
    // reject immediately so the UI doesn't get into a weird state.
    if (llmBusy) {
      console.log(logTag, 'rejected — another call is in progress');
      return {
        ok: false,
        step: convoState.step,
        nextStep: convoState.step,
        assistant: '',
        error: 'Another request is still running. Please wait or cancel it.',
      };
    }

    const settings = await readSettings();

    // Guard 1: provider configured?
    if (!settings.provider || !settings.model) {
      console.log(logTag, 'guard: no provider/model configured');
      return {
        ok: false,
        step: convoState.step,
        nextStep: convoState.step,
        assistant: '',
        error: 'Please open Settings and configure a provider first.',
      };
    }

    // Guard 2: workspace open?
    const workspace = settings.activeWorkspace || '';
    if (!workspace) {
      console.log(logTag, 'guard: no workspace');
      return {
        ok: false,
        step: convoState.step,
        nextStep: convoState.step,
        assistant: '',
        error: 'Please open a folder in the File Manager before starting.',
      };
    }
    if (!fs.existsSync(workspace)) {
      console.log(logTag, 'guard: workspace not found:', workspace);
      return {
        ok: false,
        step: convoState.step,
        nextStep: convoState.step,
        assistant: '',
        error: `Workspace not found: ${workspace}. Please open a different folder.`,
      };
    }
    try {
      const wsStat = await fsp.stat(workspace);
      if (!wsStat.isDirectory()) {
        return {
          ok: false,
          step: convoState.step,
          nextStep: convoState.step,
          assistant: '',
          error: `Workspace path is not a directory: ${workspace}.`,
        };
      }
    } catch (statErr) {
      return {
        ok: false,
        step: convoState.step,
        nextStep: convoState.step,
        assistant: '',
        error: `Cannot access workspace: ${statErr.message}`,
      };
    }

    const userText = req.text.trim();
    if (!userText) {
      throw new Error('Empty message.');
    }

    // Determine the mode: 'chat' (free conversation) or 'agent' (5-step workflow).
    const mode = settings.mode || 'agent';

    // Pick the system prompt based on mode.
    let systemPrompt;
    if (mode === 'chat') {
      // Chat mode: AUTONOMOUS AGENT with tools — like Cursor/JARVIS.
      // The agent can read files, write files, search the web, run commands, etc.
      systemPrompt = buildAgentSystemPrompt(workspace);
    } else {
      // Agent mode: use the step-specific system prompt.
      systemPrompt = SYSTEM_PROMPTS[convoState.step];
      if (!systemPrompt) {
        throw new Error(`Unknown step: ${convoState.step}`);
      }
    }

    if (convoState.messages.length === 0 || convoState.messages[0].role !== 'system') {
      convoState.messages.unshift({ role: 'system', content: systemPrompt });
    } else {
      convoState.messages[0] = { role: 'system', content: systemPrompt };
    }

    convoState.messages.push({ role: 'user', content: userText });

    // SAVE the session immediately (with just the user message) so the
    // conversation is recorded even if the LLM call fails or times out.
    console.log(logTag, 'saving session (pre-LLM)...');
    saveInProgress = true;
    try {
      const saveStart = Date.now();
      await saveCurrentSession();
      console.log(logTag, 'session saved in', Date.now() - saveStart, 'ms');
    } finally {
      saveInProgress = false;
    }

    // Call the LLM — mark busy so concurrent calls are rejected.
    llmBusy = true;
    console.log(logTag, 'calling LLM:');
    console.log(logTag, '  provider:', JSON.stringify(settings.provider));
    console.log(logTag, '  model:   ', JSON.stringify(settings.model));
    console.log(logTag, '  apiKey:  ', settings.apiKey ? settings.apiKey.slice(0, 8) + '...' : '(EMPTY)');
    console.log(logTag, '  baseUrl: ', JSON.stringify(settings.baseUrl || DEFAULT_BASE_URLS[settings.provider] || '(none)'));
    console.log(logTag, '  msgs:    ', convoState.messages.length);
    const callStart = Date.now();
    let assistantText;
    try {
      assistantText = await callLLM(settings, convoState.messages);

      // TOOL-CALLING LOOP (chat mode only)
      // If the LLM responded with tool calls, execute them, feed the results
      // back, and call the LLM again. Loop until the LLM gives a final text
      // response (no tool calls). Max 10 iterations to prevent infinite loops.
      if (mode === 'chat') {
        let toolIterations = 0;
        const MAX_TOOL_ITERATIONS = 10;
        let toolCallsFound = parseToolCalls(assistantText);
        while (toolCallsFound && toolIterations < MAX_TOOL_ITERATIONS) {
          toolIterations++;
          console.log(logTag, `tool iteration ${toolIterations}: ${toolCallsFound.length} tool call(s)`);

          // Notify the renderer that tool calls are being executed
          for (const tc of toolCallsFound) {
            sendToRenderer('tool:call', {
              name: tc.name,
              args: tc.args,
              iteration: toolIterations,
            });
          }

          // Execute each tool call and collect results
          const toolResults = [];
          for (const tc of toolCallsFound) {
            const toolResult = await executeTool(tc.name, tc.args, workspace);
            const resultText = toolResult.ok ? toolResult.result : `ERROR: ${toolResult.error}`;
            toolResults.push(`[Tool: ${tc.name}] Result:\n${resultText}`);

            // Notify the renderer of the tool result
            sendToRenderer('tool:result', {
              name: tc.name,
              ok: toolResult.ok,
              result: toolResult.ok ? toolResult.result : toolResult.error,
              iteration: toolIterations,
            });
          }

          // Add the assistant's tool call + tool results to the conversation
          convoState.messages.push({ role: 'assistant', content: assistantText });
          convoState.messages.push({
            role: 'user',
            content: `Tool results:\n\n${toolResults.join('\n\n')}\n\nContinue. If you have enough information, respond to me directly (no tool call). If you need another tool, use the same <tool_call> format.`,
          });

          // Stream the intermediate tool activity to the renderer
          sendToRenderer('llm:delta', { delta: '' }); // placeholder to keep UI alive

          // Call the LLM again with the tool results
          console.log(logTag, `calling LLM again (iteration ${toolIterations + 1})...`);
          assistantText = await callLLM(settings, convoState.messages);
          toolCallsFound = parseToolCalls(assistantText);
        }
        if (toolIterations >= MAX_TOOL_ITERATIONS) {
          console.warn(logTag, 'max tool iterations reached, stopping');
          assistantText = (assistantText || '') + '\n\n[Note: Reached maximum tool call iterations (10). Stopping to prevent infinite loop.]';
        }
        console.log(logTag, `tool loop complete after ${toolIterations} iteration(s)`);
      }
    } finally {
      llmBusy = false;
    }
    console.log(logTag, 'LLM responded in', Date.now() - callStart, 'ms, length =', (assistantText || '').length);

    convoState.messages.push({ role: 'assistant', content: assistantText });

    const currentStep = convoState.step;
    const nextStep = advanceStep(currentStep);

    // Execute step: parse ALL code blocks and route each through the APPROVE GATE.
    //
    // MULTI-FILE SUPPORT (Task Zeta — "App Builder" upgrade):
    //   The LLM can output multiple files in one response (e.g. index.html +
    //   App.jsx + styles.css for a React app). We parse all of them with
    //   extractCodeBlocks() and propose each one sequentially. The staging
    //   queue handles the "File X of Y" counter in the UI.
    //
    // PER-FILE REJECT FEEDBACK:
    //   If the user rejects a specific file, the rejection reason is appended
    //   to the LLM context and the LLM is re-called asking it to revise JUST
    //   that file. Max STAGING_MAX_RETRIES per file. After max retries on a
    //   single file, we stop the batch and surface the error.
    if (currentStep === 'execute') {
      const blocks = extractCodeBlocks(assistantText);
      if (!blocks || blocks.length === 0) {
        return {
          ok: false,
          step: currentStep,
          nextStep: currentStep,
          assistant: assistantText,
          error: 'Error: LLM did not output any code blocks. Ask the LLM to output the code in a fenced code block with a filename.',
        };
      }

      console.log(logTag, `extracted ${blocks.length} code block(s) from LLM response`);

      const STAGING_MAX_RETRIES = 3;
      const results = [];        // per-file outcome: { filename, action, error? }
      let lastAssistantText = assistantText;
      let batchAborted = false;
      let abortReason = '';

      // Process each file sequentially. staging.propose() already serializes
      // (only one pending proposal at a time), so the user sees File 1, then
      // File 2, etc. with the counter in the diff panel.
      for (let blockIdx = 0; blockIdx < blocks.length && !batchAborted; blockIdx++) {
        const block = blocks[blockIdx];
        let currentFilename = block.filename;
        let currentCode = block.content;
        let attempt = 0;

        console.log(logTag, `processing file ${blockIdx + 1}/${blocks.length}: ${currentFilename}`);

        // Per-file retry loop
        while (attempt < STAGING_MAX_RETRIES) {
          attempt++;
          console.log(logTag, `  staging.propose attempt ${attempt}/${STAGING_MAX_RETRIES} for ${currentFilename}`);

          let stagingResult;
          try {
            stagingResult = await staging.propose(currentFilename, currentCode, 'execute');
          } catch (proposeErr) {
            console.error(logTag, 'staging.propose failed:', proposeErr);
            results.push({ filename: currentFilename, action: 'error', error: proposeErr.message });
            batchAborted = true;
            abortReason = `Staging error on ${currentFilename}: ${proposeErr.message}`;
            break;
          }

          // ACCEPT or MODIFY — file was written. Move to the next file.
          if (stagingResult.action === 'accept' || stagingResult.action === 'modify') {
            notifyTreeChanged(currentFilename);
            results.push({
              filename: currentFilename,
              action: stagingResult.action,
              modified: stagingResult.action === 'modify',
            });
            console.log(logTag, `  ${currentFilename}: ${stagingResult.action}`);
            break;  // exit retry loop, move to next file
          }

          // REJECT — feed the user's reason back to the LLM and retry.
          if (stagingResult.action === 'reject') {
            const reason = stagingResult.reason || 'User rejected the change (no reason provided)';
            console.log(logTag, `  ${currentFilename}: REJECTED (attempt ${attempt}) — "${reason}"`);

            // If this was the last attempt for this file, abort the batch.
            if (attempt >= STAGING_MAX_RETRIES) {
              results.push({ filename: currentFilename, action: 'reject', error: reason });
              batchAborted = true;
              abortReason = `User rejected "${currentFilename}" ${STAGING_MAX_RETRIES} times. Last reason: "${reason}". Batch stopped — ${blocks.length - blockIdx - 1} file(s) not proposed.`;
              console.warn(logTag, abortReason);
              break;
            }

            // Append the rejected assistant response, then ask the LLM to
            // revise JUST this file. The LLM may output one code block (the
            // revised file) or multiple (we'll take the first one).
            convoState.messages.push({ role: 'assistant', content: lastAssistantText });
            const feedbackMsg =
              `The user REJECTED your proposed write to "${currentFilename}".\n\n` +
              `Reason: "${reason}"\n\n` +
              `Please revise JUST this file based on the feedback and output a new code block for ${currentFilename}. ` +
              `Do NOT repeat the same approach that was just rejected. Address the user's concern directly. ` +
              `Output only the revised code block for this one file.`;
            convoState.messages.push({ role: 'user', content: feedbackMsg });

            sendToRenderer('llm:delta', { delta: '' }); // keep UI alive

            console.log(logTag, `  re-calling LLM to revise ${currentFilename} (attempt ${attempt + 1})...`);
            let revisedText;
            try {
              llmBusy = true;
              revisedText = await callLLM(settings, convoState.messages);
            } catch (llmErr) {
              llmBusy = false;
              console.error(logTag, 'LLM re-call after rejection failed:', llmErr);
              results.push({ filename: currentFilename, action: 'error', error: llmErr.message });
              batchAborted = true;
              abortReason = `LLM re-call failed while revising ${currentFilename}: ${llmErr.message}`;
              break;
            } finally {
              llmBusy = false;
            }

            // Parse the revised response — take the first code block.
            const revisedBlocks = extractCodeBlocks(revisedText);
            if (!revisedBlocks || revisedBlocks.length === 0) {
              // LLM didn't output a code block — surface its text and stop.
              const saved = await saveCurrentSession();
              return {
                ok: false,
                step: currentStep,
                nextStep: currentStep,
                assistant: revisedText,
                error: `LLM did not output a code block after rejecting ${currentFilename}. Batch stopped. ${results.length} file(s) were already written.`,
                wroteFile: results.some((r) => r.action === 'accept' || r.action === 'modify'),
                writtenFiles: results.filter((r) => r.action === 'accept' || r.action === 'modify').map((r) => r.filename),
                session: saved ? { id: saved.id, title: saved.title } : null,
              };
            }

            // Update state for the next retry iteration.
            lastAssistantText = revisedText;
            currentCode = revisedBlocks[0].content;
            // If the LLM provided a filename for the revised block, use it.
            // Otherwise keep the original filename.
            if (revisedBlocks[0].filename && revisedBlocks[0].filename !== 'output.txt') {
              currentFilename = revisedBlocks[0].filename;
            }
            // Loop continues — staging.propose will be called again with the revised code.
            continue;
          }

          // Unknown action — should never happen.
          console.error(logTag, 'staging.propose returned unknown action:', stagingResult.action);
          results.push({ filename: currentFilename, action: 'error', error: `Unknown action: ${stagingResult.action}` });
          batchAborted = true;
          abortReason = `Unknown staging action for ${currentFilename}: ${stagingResult.action}`;
          break;
        }
      }

      // ---- Batch complete — build summary response ----
      const saved = await saveCurrentSession();
      const writtenFiles = results
        .filter((r) => r.action === 'accept' || r.action === 'modify')
        .map((r) => r.filename);
      const failedFiles = results
        .filter((r) => r.action === 'reject' || r.action === 'error')
        .map((r) => ({ filename: r.filename, error: r.error }));

      if (batchAborted && writtenFiles.length === 0) {
        // Nothing was written — surface the error.
        return {
          ok: false,
          step: currentStep,
          nextStep: currentStep,
          assistant: lastAssistantText,
          error: abortReason || 'Batch aborted with no files written.',
          session: saved ? { id: saved.id, title: saved.title } : null,
        };
      }

      // At least some files were written. Build a success/info message.
      const totalFiles = blocks.length;
      const succeededCount = writtenFiles.length;
      const failedCount = failedFiles.length;

      let infoMsg;
      if (failedCount === 0) {
        infoMsg = `Success! ${succeededCount} file${succeededCount === 1 ? '' : 's'} written: ${writtenFiles.join(', ')}`;
      } else if (succeededCount > 0) {
        infoMsg = `Wrote ${succeededCount} of ${totalFiles} files: ${writtenFiles.join(', ')}. ` +
                  `Failed: ${failedFiles.map((f) => `${f.filename} (${f.error})`).join('; ')}`;
      } else {
        infoMsg = `All ${totalFiles} files failed. ${abortReason || ''}`;
      }

      return {
        ok: succeededCount > 0,
        step: currentStep,
        nextStep: currentStep,
        assistant: lastAssistantText,
        info: infoMsg,
        wroteFile: succeededCount > 0,
        writtenFiles,
        writtenPath: writtenFiles.length > 0 ? path.join(workspace, writtenFiles[0]) : '',
        writtenName: writtenFiles[0] || '',
        batchResults: results,
        session: saved ? { id: saved.id, title: saved.title } : null,
        ...(batchAborted && failedCount > 0 ? { error: abortReason } : {}),
      };
    }

    // Step advancement logic:
    // - CHAT MODE: no steps, no advancement. Just a free conversation.
    // - AGENT MODE:
    //   - idea & refine: CONVERSATIONAL — do NOT auto-advance. Only advance
    //     if the user explicitly says "next", "continue", "ready", etc.
    //   - spec & plan: GENERATION — auto-advance after generating.
    //   - execute: terminal (handled above).
    if (mode === 'chat') {
      const saved = await saveCurrentSession();
      return {
        ok: true,
        step: 'chat',
        nextStep: 'chat',
        mode: 'chat',
        assistant: assistantText,
        session: saved ? { id: saved.id, title: saved.title } : null,
        canAdvance: false,
      };
    }

    const isConversational = (currentStep === 'idea' || currentStep === 'refine');
    const shouldAdvance = isConversational ? userWantsToAdvance(userText) : true;

    if (shouldAdvance) {
      convoState.step = nextStep;
      console.log(logTag, 'advancing step:', currentStep, '->', nextStep);
    } else {
      console.log(logTag, 'staying in step:', currentStep, '(conversational, user did not request advance)');
    }

    const saved = await saveCurrentSession();
    return {
      ok: true,
      step: currentStep,
      nextStep: convoState.step,
      mode: 'agent',
      assistant: assistantText,
      session: saved ? { id: saved.id, title: saved.title } : null,
      canAdvance: isConversational,
    };
  } catch (err) {
    console.error('send-message error:', err);
    // Translate common SDK errors into user-friendly messages.
    let msg = err && err.message ? err.message : String(err);
    if (err && err.constructor && err.constructor.name === 'APIUserAbortError') {
      msg = 'Request aborted. If this keeps happening, check your API key in Settings.';
    } else if (err && err.status === 401) {
      msg = 'Invalid API key (401). Open Settings and paste a valid key for your provider.';
    } else if (err && err.status === 429) {
      msg = 'Rate limited (429). Wait a moment and try again, or switch to a different provider/model.';
    } else if (err && err.status && err.status >= 500) {
      msg = `Provider server error (${err.status}). The provider is having issues — try again in a moment.`;
    } else if (err && err.code === 'ENOTFOUND') {
      msg = `Network error: could not reach "${err.hostname || 'the provider'}". Check your internet connection or Base URL in Settings.`;
    } else if (err && err.code === 'ECONNREFUSED') {
      msg = `Connection refused. If using Ollama, make sure it's running locally.`;
    }
    return {
      ok: false,
      step: convoState.step,
      nextStep: convoState.step,
      assistant: '',
      error: msg,
    };
  }
});

/* -------------------------------------------------------------------------- */
/* IPC handlers — Sessions                                                    */
/* -------------------------------------------------------------------------- */

ipcMain.handle('sessions:list', async () => {
  try {
    return { ok: true, sessions: await listSessions() };
  } catch (err) {
    console.error('sessions:list error:', err);
    return { ok: false, error: err.message, sessions: [] };
  }
});

ipcMain.handle('sessions:load', async (_evt, id) => {
  try {
    if (typeof id !== 'string' || !id) {
      throw new Error('Session id required.');
    }
    const s = await loadSession(id);
    if (!s) {
      return { ok: false, error: 'Session not found.' };
    }
    return {
      ok: true,
      session: {
        id: s.id,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        step: s.step,
        title: s.title,
        messages: s.messages,
      },
    };
  } catch (err) {
    console.error('sessions:load error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:delete', async (_evt, id) => {
  try {
    if (typeof id !== 'string' || !id) {
      throw new Error('Session id required.');
    }
    const ok = await deleteSession(id);
    return { ok };
  } catch (err) {
    console.error('sessions:delete error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:new', async () => {
  try {
    resetConvo();
    // Reset staging — a new session means a fresh run; pending proposals
    // from the previous session are no longer relevant.
    staging.reset();
    return { ok: true, step: convoState.step };
  } catch (err) {
    console.error('sessions:new error:', err);
    return { ok: false, error: err.message };
  }
});

/**
 * Cancel the current LLM call. We can't truly abort an in-flight HTTP request
 * from here, but we can:
 *  1. Reset the busy flag so the next send-message call isn't rejected
 *  2. Reset the conversation state to drop the in-flight user message
 *  3. Return immediately so the renderer can un-busy
 * The stale LLM response (when it eventually arrives) will be ignored because
 * the renderer already moved on.
 */
/**
 * Explicitly advance to the next step. Called when the user clicks the
 * "Next Step →" button in the UI. This is the ONLY way to advance from
 * the conversational stages (idea, refine) — auto-advancement is disabled
 * for those stages so the user can have a real conversation.
 */
ipcMain.handle('advance-step', async () => {
  try {
    const current = convoState.step;
    const next = advanceStep(current);
    if (next === current) {
      return { ok: false, error: 'Already at the final step.' };
    }
    convoState.step = next;
    console.log('[advance-step] advanced:', current, '->', next);
    await saveCurrentSession();
    return { ok: true, step: current, nextStep: next };
  } catch (err) {
    console.error('[advance-step] error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cancel-current', async () => {
  // Log who called this with a stack trace so we can find the culprit.
  const callerStack = new Error().stack;
  console.log('[cancel-current] cancelling, llmBusy =', llmBusy);
  console.log('[cancel-current] CALLER STACK:', callerStack);
  llmBusy = false;
  // Only drop the last user message if there's NO matching assistant reply
  // AND the save is not in progress. We keep the message so the session
  // can still be saved (the user will see their message in history even
  // if the LLM was cancelled).
  const msgs = convoState.messages;
  const lastIsUser = msgs.length > 0 && msgs[msgs.length - 1].role === 'user';
  if (lastIsUser && !saveInProgress) {
    // Don't pop — keep the user message so the session is saved with it.
    // Just mark it as cancelled so the UI knows.
    console.log('[cancel-current] keeping user message for session save');
  }
  return { ok: true };
});

ipcMain.handle('reset-convo', async () => {
  try {
    resetConvo();
    return { ok: true, step: convoState.step };
  } catch (err) {
    console.error('reset-convo error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-convo-state', async () => {
  return {
    step: convoState.step,
    labels: STEP_LABELS,
    workspace: await getActiveWorkspace(),
    sessionId: convoState.sessionId,
    startedAt: convoState.startedAt,
  };
});

/* -------------------------------------------------------------------------- */
/* IPC handlers — Staging (Approve-Before-Write Gate)                         */
/* -------------------------------------------------------------------------- */
//
// These handlers are the renderer's only way to resolve pending proposals.
// The renderer subscribes to STAGING_CHANNELS.PROPOSE (new diff to review)
// and STAGING_CHANNELS.QUEUE_UPDATE (queue state changed) via preload.js.
//
// Flow:
//   1. Agent (Execute step or write_file tool) calls staging.propose()
//   2. staging.propose() emits STAGING_CHANNELS.PROPOSE → renderer shows diff
//   3. staging.propose() returns a Promise that does NOT resolve yet
//   4. Agent loop is paused waiting on that Promise
//   5. User clicks Accept/Reject/Modify in the Monaco diff panel
//   6. Renderer calls window.kovix.resolveStaging(decision)
//   7. This handler calls staging.resolve(decision)
//   8. staging writes the file (with backup) and resolves the Promise
//   9. Agent loop resumes; if rejected with a reason, that reason is fed
//      back to the LLM context for retry

ipcMain.handle('staging:resolve', async (_evt, decision) => {
  try {
    if (!decision || typeof decision !== 'object') {
      return { ok: false, error: 'Invalid decision payload.' };
    }
    const result = await staging.resolve(decision);
    // If a file was written (accept/modify), notify the renderer to refresh
    // its file tree so the new file appears immediately.
    if (result.ok && result.result &&
        (result.result.action === 'accept' || result.result.action === 'modify')) {
      // We don't have the relative path here directly, but staging broadcasts
      // a queue-update event that the renderer can use to find the resolved
      // proposal's path. The renderer should refresh the tree on any
      // resolved:accept / resolved:modify status change.
      sendToRenderer('fs:tree-changed', { relativePath: null });
    }
    return result;
  } catch (err) {
    console.error('[staging:resolve] error:', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('staging:get-current', async () => {
  try {
    return { ok: true, proposal: staging.getCurrent() };
  } catch (err) {
    console.error('[staging:get-current] error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('staging:get-queue', async () => {
  try {
    return { ok: true, queue: staging.getQueue() };
  } catch (err) {
    console.error('[staging:get-queue] error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('staging:set-auto-mode', async (_evt, payload) => {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid payload.' };
    }
    const { mode, reason } = payload;
    staging.setAutoMode(mode, reason);
    return { ok: true };
  } catch (err) {
    console.error('[staging:set-auto-mode] error:', err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('staging:clear-auto-mode', async () => {
  try {
    staging.clearAutoMode();
    return { ok: true };
  } catch (err) {
    console.error('[staging:clear-auto-mode] error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('staging:reset', async () => {
  try {
    staging.reset();
    return { ok: true };
  } catch (err) {
    console.error('[staging:reset] error:', err);
    return { ok: false, error: err.message };
  }
});

/* -------------------------------------------------------------------------- */
/* Window bootstrap                                                           */
/* -------------------------------------------------------------------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 650,
    backgroundColor: '#ffffff',
    title: 'Kovix MVP',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(APP_ROOT, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Disable HTTP cache via command-line switch (helps during development so
// changes to index.html / style.css / renderer.js are always picked up).
app.commandLine.appendSwitch('disable-http-cache');
app.disableHardwareAccelerationMode = false;

app.whenReady().then(async () => {
  // Clear the session cache so stale renderer files don't get loaded.
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ['shadercache', 'serviceworkers', 'cachestorage'],
    });
  } catch (err) {
    console.error('Failed to clear session cache:', err);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Crash guard.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
