const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

// ─── Config ──────────────────────────────────────────────────────
let configPath = '';  // Set after app is ready
const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'openai/gpt-4o-mini',
};

function loadConfig() {
  if (!configPath) return { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(configPath)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  if (!configPath) return;
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ─── App State ────────────────────────────────────────────────────
const STEPS = ['idea', 'refine', 'spec', 'plan', 'execute'];
let conversationHistory = [];
let currentState = 'idea';
let mainWindow = null;
let config = null;

// Lazy OpenAI client
function getClient() {
  if (!config) config = loadConfig();
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
  });
}

// ─── Send event to renderer ───────────────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ─── System Prompts ───────────────────────────────────────────────
const SYSTEM_PROMPTS = {
  refine: 'You are a product manager. Ask 1-2 clarifying questions to refine this idea. Do not write code yet. Be concise.',
  spec: 'Based on the conversation so far, output a formal markdown specification for the app. Include: Purpose, Features, User Flow, Technical Requirements. Output ONLY the spec in markdown.',
  plan: 'Break this specification into a 1-3 step milestone plan. For each step, describe exactly what code needs to be written. Output ONLY the plan in markdown.',
  execute: 'You are an expert developer. Execute the plan by writing the complete code. You MUST output the code inside a markdown code block using ```html or ```javascript fences. Do not explain. Just output the code block.',
};

// ─── Code Block Extraction ────────────────────────────────────────
function extractCodeBlock(text) {
  const match = text.match(/```(?:[a-zA-Z0-9+#-]*)\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

// ─── LLM Call Helper ──────────────────────────────────────────────
async function callLLM(systemPrompt, history) {
  const client = getClient();
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];
  const response = await client.chat.completions.create({
    model: config.model,
    messages,
    temperature: 0.7,
    max_tokens: 4096,
  });
  return response.choices[0].message.content;
}

// ─── IPC: Get Config ─────────────────────────────────────────────
ipcMain.handle('get-config', () => {
  if (!config) config = loadConfig();
  return {
    apiKey: config.apiKey ? config.apiKey.slice(0, 6) + '...' + config.apiKey.slice(-4) : '',
    model: config.model,
    hasKey: !!config.apiKey,
  };
});

// ─── IPC: Save Config ────────────────────────────────────────────
ipcMain.handle('save-config', (_event, { apiKey, model }) => {
  if (!config) config = loadConfig();
  if (apiKey && apiKey.startsWith('\u25CF\u25CF\u25CF')) {
    // keep existing key
  } else if (apiKey !== undefined) {
    config.apiKey = apiKey.trim();
  }
  if (model) {
    config.model = model;
  }
  saveConfig(config);
  return { success: true, model: config.model, hasKey: !!config.apiKey };
});

// ─── IPC: Send Message (5-step state machine) ────────────────────
ipcMain.handle('send-message', async (event, userMessage) => {
  if (!config) config = loadConfig();

  if (!config.apiKey) {
    return { currentState, error: 'No API key set. Open Settings (gear icon) to add your OpenRouter key.' };
  }

  try {
    // ─── STEP 1: IDEA → REFINE ──────────────────────────────────
    if (currentState === 'idea') {
      conversationHistory.push({ role: 'user', content: userMessage });

      const questions = await callLLM(SYSTEM_PROMPTS.refine, conversationHistory);
      conversationHistory.push({ role: 'assistant', content: questions });

      currentState = 'refine';
      return { currentState: 'refine', response: questions, fileResult: null };
    }

    // ─── STEP 2: REFINE → SPEC ──────────────────────────────────
    if (currentState === 'refine') {
      conversationHistory.push({ role: 'user', content: userMessage });

      const spec = await callLLM(SYSTEM_PROMPTS.spec, conversationHistory);
      conversationHistory.push({ role: 'assistant', content: spec });

      currentState = 'spec';
      return { currentState: 'spec', response: spec, autoAdvance: true, fileResult: null };
    }

    // ─── STEP 3: SPEC → PLAN (auto-advance) ─────────────────────
    if (currentState === 'spec') {
      const plan = await callLLM(SYSTEM_PROMPTS.plan, conversationHistory);
      conversationHistory.push({ role: 'assistant', content: plan });

      currentState = 'plan';
      return { currentState: 'plan', response: plan, autoAdvance: true, fileResult: null };
    }

    // ─── STEP 4: PLAN → EXECUTE (auto-advance) ──────────────────
    if (currentState === 'plan') {
      const executeResponse = await callLLM(SYSTEM_PROMPTS.execute, conversationHistory);
      conversationHistory.push({ role: 'assistant', content: executeResponse });

      const code = extractCodeBlock(executeResponse);
      let fileResult = null;

      if (code) {
        const outputPath = path.join(app.getAppPath(), 'output.txt');
        try {
          fs.writeFileSync(outputPath, code, 'utf-8');
          fileResult = { success: true, path: outputPath };
        } catch (writeErr) {
          fileResult = { success: false, error: writeErr.message };
        }
      } else {
        fileResult = { success: false, error: 'No code block found in LLM response. The model did not output code inside ``` fences.' };
      }

      currentState = 'execute';
      return { currentState: 'execute', response: executeResponse, fileResult };
    }

    // ─── STEP 5: EXECUTE (re-run if user sends another message) ──
    if (currentState === 'execute') {
      conversationHistory.push({ role: 'user', content: userMessage });

      const executeResponse = await callLLM(SYSTEM_PROMPTS.execute, conversationHistory);
      conversationHistory.push({ role: 'assistant', content: executeResponse });

      const code = extractCodeBlock(executeResponse);
      let fileResult = null;

      if (code) {
        const outputPath = path.join(app.getAppPath(), 'output.txt');
        try {
          fs.writeFileSync(outputPath, code, 'utf-8');
          fileResult = { success: true, path: outputPath };
        } catch (writeErr) {
          fileResult = { success: false, error: writeErr.message };
        }
      } else {
        fileResult = { success: false, error: 'No code block found in LLM response.' };
      }

      return { currentState: 'execute', response: executeResponse, fileResult };
    }

    return { currentState, response: 'Unknown state. Hit Reset.', fileResult: null };

  } catch (err) {
    const errorMessage = err.message || String(err);
    if (err.status) {
      return { currentState, error: 'API Error ' + err.status + ': ' + errorMessage };
    }
    return { currentState, error: errorMessage };
  }
});

// ─── IPC: Get State ──────────────────────────────────────────────
ipcMain.handle('get-state', () => {
  return { currentState, steps: STEPS };
});

// ─── IPC: Reset ──────────────────────────────────────────────────
ipcMain.handle('reset', () => {
  conversationHistory = [];
  currentState = 'idea';
  return { currentState: 'idea' };
});

// ─── Window Setup ────────────────────────────────────────────────
function createWindow() {
  configPath = path.join(app.getAppPath(), '.kovix', 'config.json');
  config = loadConfig();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Kovix MVP',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
