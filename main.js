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
  idea: 'You are a product manager. Ask 1-2 clarifying questions to refine this idea. Do not write code yet.',
  refine: 'Based on the conversation, output a formal markdown specification for the app. Output ONLY the spec.',
  spec: 'Break this spec into a 1-3 step milestone plan. Output ONLY the plan.',
  plan: 'Execute step 1 of the plan. You MUST output the code inside a markdown code block (```html or ```javascript). Do not explain, just output the code block.',
};

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
/* Code-block extraction                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Extract the contents of the FIRST fenced code block from a markdown string.
 * Accepts ```lang ... ``` or ~~~lang ... ~~~. Returns null if none found.
 */
function extractCodeBlock(text) {
  if (typeof text !== 'string' || !text) return null;
  const re = /```[ \t]*([\w+-]*)[ \t]*\r?\n([\s\S]*?)```|~~~[ \t]*([\w+-]*)[ \t]*\r?\n([\s\S]*?)~~~/;
  const m = text.match(re);
  if (m) {
    return (m[2] != null ? m[2] : m[4] || '').replace(/\s+$/, '');
  }
  return null;
}

/**
 * Extract the language tag of the first code block, e.g. "html" or "javascript".
 * Used to choose a sensible filename when writing to the workspace.
 */
function extractCodeBlockLang(text) {
  if (typeof text !== 'string' || !text) return '';
  const re = /```[ \t]*([\w+-]*)[ \t]*\r?\n[\s\S]*?```|~~~[ \t]*([\w+-]*)[ \t]*\r?\n[\s\S]*?~~~/;
  const m = text.match(re);
  if (!m) return '';
  return (m[1] || m[2] || '').toLowerCase();
}

/**
 * Pick a filename for the extracted code based on its language tag.
 * Defaults to output.txt for unknown languages.
 */
function pickOutputFilename(lang) {
  switch ((lang || '').toLowerCase()) {
    case 'html':
    case 'htm':
      return 'index.html';
    case 'javascript':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'script.js';
    case 'typescript':
    case 'ts':
    case 'tsx':
      return 'script.ts';
    case 'css':
      return 'style.css';
    case 'json':
      return 'data.json';
    case 'python':
    case 'py':
      return 'script.py';
    case 'markdown':
    case 'md':
      return 'output.md';
    case 'bash':
    case 'sh':
    case 'shell':
      return 'script.sh';
    default:
      return 'output.txt';
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
// Sessions are stored as JSON files inside the active workspace under
// `.kovix/sessions/<id>.json`. Each file is a self-contained transcript:
//   {
//     id, startedAt, updatedAt, step,
//     title,            // first user message (truncated)
//     messages: [...]   // full role/content history
//   }
//
// This means sessions travel with the workspace — clone it, share it, the
// conversation history comes with it. No external database needed.

const SESSIONS_DIR_NAME = '.kovix';
const SESSIONS_SUBDIR = 'sessions';

async function getSessionsDir() {
  const ws = await getActiveWorkspace();
  if (!ws) {
    console.log('[sessions] getSessionsDir: no active workspace');
    return '';
  }
  const dir = path.join(ws, SESSIONS_DIR_NAME, SESSIONS_SUBDIR);
  console.log('[sessions] dir =', dir);
  return dir;
}

async function ensureSessionsDir() {
  const dir = await getSessionsDir();
  if (!dir) return '';
  try {
    await fsp.mkdir(dir, { recursive: true });
    console.log('[sessions] ensured dir exists:', dir);
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
  };
  try {
    const filePath = path.join(dir, `${convoState.sessionId}.json`);
    await fsp.writeFile(filePath, JSON.stringify(session, null, 2), 'utf8');
    console.log('[sessions] saved:', filePath, '(', session.messages.length, 'messages )');
    return session;
  } catch (err) {
    console.error('[sessions] save FAILED:', err);
    return null;
  }
}

async function listSessions() {
  const dir = await getSessionsDir();
  if (!dir) return [];
  try {
    if (!fs.existsSync(dir)) {
      console.log('[sessions] list: dir does not exist yet:', dir);
      return [];
    }
    const entries = await fsp.readdir(dir);
    const files = entries.filter((f) => f.endsWith('.json'));
    console.log('[sessions] list: found', files.length, 'session files in', dir);
    const sessions = [];
    for (const f of files) {
      try {
        const raw = await fsp.readFile(path.join(dir, f), 'utf8');
        const s = JSON.parse(raw);
        if (s && s.id && Array.isArray(s.messages)) {
          sessions.push({
            id: s.id,
            startedAt: s.startedAt || '',
            updatedAt: s.updatedAt || '',
            step: s.step || 'idea',
            title: s.title || sessionTitleFromMessages(s.messages) || 'Untitled session',
            messageCount: s.messages.filter((m) => m.role !== 'system').length,
          });
        }
      } catch (_) { /* skip corrupt files */ }
    }
    // Newest first
    sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return sessions;
  } catch (err) {
    console.error('listSessions error:', err);
    return [];
  }
}

async function loadSession(id) {
  const dir = await getSessionsDir();
  if (!dir) return null;
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const s = JSON.parse(raw);
    if (!s || !s.id || !Array.isArray(s.messages)) return null;
    convoState.sessionId = s.id;
    convoState.startedAt = s.startedAt || new Date().toISOString();
    convoState.step = s.step || 'idea';
    convoState.messages = s.messages.slice();
    return s;
  } catch (err) {
    console.error('loadSession error:', err);
    return null;
  }
}

async function deleteSession(id) {
  const dir = await getSessionsDir();
  if (!dir) return false;
  const file = path.join(dir, `${id}.json`);
  try {
    if (fs.existsSync(file)) await fsp.unlink(file);
    // If we just deleted the active session, reset convo state too.
    if (convoState.sessionId === id) resetConvo();
    return true;
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

    // Seed system prompt for the current step on first turn of that step.
    const systemPrompt = SYSTEM_PROMPTS[convoState.step];
    if (!systemPrompt) {
      throw new Error(`Unknown step: ${convoState.step}`);
    }

    if (convoState.messages.length === 0 || convoState.messages[0].role !== 'system') {
      convoState.messages.unshift({ role: 'system', content: systemPrompt });
    } else {
      convoState.messages[0] = { role: 'system', content: systemPrompt };
    }

    convoState.messages.push({ role: 'user', content: userText });

    // SAVE the session immediately (with just the user message) so the
    // conversation is recorded even if the LLM call fails or times out.
    saveInProgress = true;
    try {
      await saveCurrentSession();
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
    } finally {
      llmBusy = false;
    }
    console.log(logTag, 'LLM responded in', Date.now() - callStart, 'ms, length =', (assistantText || '').length);

    convoState.messages.push({ role: 'assistant', content: assistantText });

    const currentStep = convoState.step;
    const nextStep = advanceStep(currentStep);

    // Execute step: parse code block and write to disk INSIDE the workspace.
    if (currentStep === 'execute') {
      const code = extractCodeBlock(assistantText);
      if (!code) {
        return {
          ok: false,
          step: currentStep,
          nextStep: currentStep,
          assistant: assistantText,
          error: 'Error: LLM did not output a code block.',
        };
      }
      const lang = extractCodeBlockLang(assistantText);
      const filename = pickOutputFilename(lang);
      const outPath = path.join(workspace, filename);
      try {
        await fsp.writeFile(outPath, code, 'utf8');
        // Tell the renderer to refresh its file tree.
        notifyTreeChanged(filename);
        // Persist the session transcript.
        const saved = await saveCurrentSession();
        return {
          ok: true,
          step: currentStep,
          nextStep: currentStep,
          assistant: assistantText,
          info: `Success! Code written to ${filename}`,
          wroteFile: true,
          writtenPath: outPath,
          writtenName: filename,
          session: saved ? { id: saved.id, title: saved.title } : null,
        };
      } catch (writeErr) {
        console.error('write output file failed:', writeErr);
        return {
          ok: false,
          step: currentStep,
          nextStep: currentStep,
          assistant: assistantText,
          error: `Error writing ${filename}: ${writeErr.message}`,
        };
      }
    }

    // Non-execute steps: advance and let the renderer show the assistant text.
    convoState.step = nextStep;
    const saved = await saveCurrentSession();
    return {
      ok: true,
      step: currentStep,
      nextStep,
      assistant: assistantText,
      session: saved ? { id: saved.id, title: saved.title } : null,
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
