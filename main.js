'use strict';

/**
 * Kovix MVP — Electron main process
 *
 * Responsibilities:
 *  - Create the BrowserWindow and load index.html
 *  - Persist user settings (provider / apiKey / baseUrl / model) to settings.json
 *  - Fetch available models from any of the 5 supported providers
 *  - Orchestrate the 5-step state machine (Idea -> Refine -> Spec -> Plan -> Execute)
 *  - Call the configured LLM dynamically (openai SDK for OpenAI/OpenRouter/Ollama,
 *    native fetch for Anthropic/Gemini)
 *  - Parse the final code block out of the LLM response and write it to output.txt
 *
 * Every IPC handler and every LLM call is wrapped in try/catch so the renderer
 * always receives a structured error string instead of crashing the app.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// openai SDK is used for OpenAI, OpenRouter, and Ollama (all expose an OpenAI-compatible /v1/chat/completions endpoint).
const OpenAI = require('openai').default || require('openai');

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const APP_ROOT = __dirname;
const SETTINGS_PATH = path.join(APP_ROOT, 'settings.json');
const OUTPUT_PATH = path.join(APP_ROOT, 'output.txt');

const DEFAULT_SETTINGS = {
  provider: '',
  apiKey: '',
  baseUrl: '',
  model: '',
};

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434/v1',
  gemini: 'https://generativelanguage.googleapis.com',
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

/* -------------------------------------------------------------------------- */
/* Settings persistence                                                       */
/* -------------------------------------------------------------------------- */

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err) {
    console.error('Failed to read settings.json:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(next) {
  try {
    const merged = { ...DEFAULT_SETTINGS, ...next };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error('Failed to write settings.json:', err);
    throw err;
  }
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
    case 'openrouter': {
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
      // Anthropic requires both x-api-key and anthropic-version headers.
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
      // Ollama exposes /api/tags (no auth). We also keep /v1/models as a fallback
      // because newer Ollama builds expose an OpenAI-compatible endpoint.
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
        // Convert "models/gemini-1.5-flash" -> "gemini-1.5-flash" for display
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
    case 'ollama': {
      if (provider !== 'ollama' && !apiKey) {
        throw new Error(`API key is required for ${provider}.`);
      }
      const client = new OpenAI({
        apiKey: apiKey || 'ollama', // Ollama doesn't care about the key, but the SDK requires one.
        baseURL: baseUrl || DEFAULT_BASE_URLS[provider],
        // OpenRouter likes these headers for attribution; harmless elsewhere.
        defaultHeaders: provider === 'openrouter' ? {
          'HTTP-Referer': 'https://github.com/Razisafir/kovix-mvp',
          'X-Title': 'Kovix MVP',
        } : undefined,
      });
      const completion = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.7,
      });
      const text = completion?.choices?.[0]?.message?.content;
      if (!text) throw new Error('LLM returned an empty response.');
      return text;
    }

    case 'anthropic': {
      if (!apiKey) throw new Error('API key is required for Anthropic.');
      const url = `${baseUrl || DEFAULT_BASE_URLS.anthropic}/v1/messages`;
      // Anthropic splits system prompt from messages.
      const sysMsg = messages.find((m) => m.role === 'system');
      const userTurns = messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
      const body = {
        model,
        max_tokens: 4096,
        messages: userTurns,
      };
      if (sysMsg) body.system = sysMsg.content;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await safeReadText(res);
        throw new Error(`Anthropic /v1/messages returned ${res.status}: ${errText}`);
      }
      const data = await res.json();
      const text = Array.isArray(data?.content)
        ? data.content.map((c) => c?.text || '').join('')
        : '';
      if (!text) throw new Error('Anthropic returned an empty response.');
      return text;
    }

    case 'gemini': {
      if (!apiKey) throw new Error('API key is required for Gemini.');
      const url = `${baseUrl || DEFAULT_BASE_URLS.gemini}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      // Gemini has its own schema. We flatten messages into contents[].
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await safeReadText(res);
        throw new Error(`Gemini generateContent returned ${res.status}: ${errText}`);
      }
      const data = await res.json();
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
  // Match the first fenced block. The fence may be ``` or ~~~, optionally followed
  // by a language tag on the same line.
  const re = /```[ \t]*([\w+-]*)[ \t]*\r?\n([\s\S]*?)```|~~~[ \t]*([\w+-]*)[ \t]*\r?\n([\s\S]*?)~~~/;
  const m = text.match(re);
  if (m) {
    // group 2 = ``` body, group 4 = ~~~ body
    return (m[2] != null ? m[2] : m[4] || '').replace(/\s+$/, '');
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Conversation state                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Per-window conversation state. We only support one window in the MVP,
 * but keep this structured so it's easy to extend later.
 */
const convoState = {
  step: 'idea',
  messages: [], // [{role:'system'|'user'|'assistant', content:string}]
};

function resetConvo() {
  convoState.step = 'idea';
  convoState.messages = [];
}

function advanceStep(current) {
  const idx = STEPS.indexOf(current);
  if (idx === -1) return 'idea';
  return STEPS[Math.min(idx + 1, STEPS.length - 1)];
}

/* -------------------------------------------------------------------------- */
/* IPC handlers                                                               */
/* -------------------------------------------------------------------------- */

ipcMain.handle('get-settings', async () => {
  try {
    return readSettings();
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
    return writeSettings(next);
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
 * send-message handler — runs the state machine.
 *
 * Renderer contract:
 *   request:  { text: string }            // user's latest message
 *   response: {
 *     ok: boolean,
 *     step: string,                       // current step after this turn
 *     nextStep: string,                   // step the UI should switch to
 *     assistant: string,                  // assistant text to display (may be empty)
 *     info?: string,                      // success/info banner (e.g. "Success! Code written to output.txt")
 *     error?: string,                     // error banner (red)
 *     wroteFile?: boolean,                // true if output.txt was written
 *   }
 */
ipcMain.handle('send-message', async (_evt, req) => {
  try {
    if (!req || typeof req !== 'object' || typeof req.text !== 'string') {
      throw new Error('Invalid send-message payload.');
    }

    const settings = readSettings();
    if (!settings.provider || !settings.model) {
      return {
        ok: false,
        step: convoState.step,
        nextStep: convoState.step,
        assistant: '',
        error: 'Please open Settings and configure a provider first.',
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

    // Ensure there's exactly one system message at the top, set for the current step.
    if (convoState.messages.length === 0 || convoState.messages[0].role !== 'system') {
      convoState.messages.unshift({ role: 'system', content: systemPrompt });
    } else {
      convoState.messages[0] = { role: 'system', content: systemPrompt };
    }

    // Append the user's message.
    convoState.messages.push({ role: 'user', content: userText });

    // Call the LLM.
    const assistantText = await callLLM(settings, convoState.messages);
    convoState.messages.push({ role: 'assistant', content: assistantText });

    const currentStep = convoState.step;
    const nextStep = advanceStep(currentStep);

    // Execute step: parse code block and write to disk.
    if (currentStep === 'execute') {
      const code = extractCodeBlock(assistantText);
      if (!code) {
        // Don't advance — let the user retry.
        return {
          ok: false,
          step: currentStep,
          nextStep: currentStep,
          assistant: assistantText,
          error: 'Error: LLM did not output a code block.',
        };
      }
      try {
        fs.writeFileSync(OUTPUT_PATH, code, 'utf8');
        return {
          ok: true,
          step: currentStep,
          nextStep: currentStep, // terminal step
          assistant: assistantText,
          info: 'Success! Code written to output.txt',
          wroteFile: true,
        };
      } catch (writeErr) {
        console.error('write output.txt failed:', writeErr);
        return {
          ok: false,
          step: currentStep,
          nextStep: currentStep,
          assistant: assistantText,
          error: `Error writing output.txt: ${writeErr.message}`,
        };
      }
    }

    // Non-execute steps: just advance and let the renderer show the assistant text.
    convoState.step = nextStep;
    return {
      ok: true,
      step: currentStep,
      nextStep,
      assistant: assistantText,
    };
  } catch (err) {
    console.error('send-message error:', err);
    return {
      ok: false,
      step: convoState.step,
      nextStep: convoState.step,
      assistant: '',
      error: err && err.message ? err.message : String(err),
    };
  }
});

/**
 * Reset the conversation back to the Idea step.
 */
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
  return { step: convoState.step, labels: STEP_LABELS };
});

/* -------------------------------------------------------------------------- */
/* Window bootstrap                                                           */
/* -------------------------------------------------------------------------- */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Crash guard: log unhandled rejections instead of silently dying.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
