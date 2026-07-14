'use strict';

/**
 * Kovix MVP — renderer (UI logic)
 *
 * Runs in the renderer process with contextIsolation enabled. The only bridge
 * to Node is window.kovix (exposed by preload.js). All LLM work happens in the
 * main process; this file just renders chat bubbles, drives the step indicator,
 * and wires up the settings modal.
 */

/* -------------------------------------------------------------------------- */
/* Step metadata — keep a renderer-side copy for the UI labels                */
/* -------------------------------------------------------------------------- */

const STEP_ORDER = ['idea', 'refine', 'spec', 'plan', 'execute'];
const STEP_LABELS = {
  idea: 'Idea',
  refine: 'Refine',
  spec: 'Spec',
  plan: 'Plan',
  execute: 'Execute',
};

const STEP_PLACEHOLDERS = {
  idea: 'Describe your idea…',
  refine: 'Answer the clarifying questions…',
  spec: 'Approve the spec, or ask for changes (Send to continue)…',
  plan: 'Approve the plan, or ask for changes (Send to continue)…',
  execute: 'Send to execute step 1 and write code to output.txt…',
};

/* -------------------------------------------------------------------------- */
/* DOM lookups                                                                */
/* -------------------------------------------------------------------------- */

const $ = (sel) => document.querySelector(sel);

const els = {
  // Header
  settingsBtn:  $('#settings-btn'),
  resetBtn:     $('#reset-btn'),

  // Sidebar
  stepItems:    document.querySelectorAll('.step-item'),
  statusProvider: $('#status-provider'),
  statusModel:    $('#status-model'),

  // Chat
  messages:     $('#messages'),
  input:        $('#input'),
  sendBtn:      $('#send-btn'),
  errorBanner:  $('#error-banner'),
  infoBanner:   $('#info-banner'),

  // Settings modal
  modal:        $('#settings-modal'),
  providerSel:  $('#provider'),
  apiKeyInput:  $('#api-key'),
  baseUrlInput: $('#base-url'),
  modelSel:     $('#model'),
  fetchModelsBtn: $('#fetch-models-btn'),
  saveSettingsBtn: $('#save-settings-btn'),
  settingsError: $('#settings-error'),
  settingsInfo:  $('#settings-info'),
};

/* -------------------------------------------------------------------------- */
/* Step indicator                                                             */
/* -------------------------------------------------------------------------- */

function setActiveStep(step) {
  const idx = STEP_ORDER.indexOf(step);
  els.stepItems.forEach((li) => {
    const s = li.dataset.step;
    const liIdx = STEP_ORDER.indexOf(s);
    li.classList.toggle('active', s === step);
    li.classList.toggle('done', liIdx < idx);
  });
  els.input.placeholder = STEP_PLACEHOLDERS[step] || 'Type a message…';
}

/* -------------------------------------------------------------------------- */
/* Banners                                                                    */
/* -------------------------------------------------------------------------- */

function showError(msg) {
  if (!msg) { els.errorBanner.classList.add('hidden'); return; }
  els.errorBanner.textContent = msg;
  els.errorBanner.classList.remove('hidden');
}
function clearError() { els.errorBanner.classList.add('hidden'); }

function showInfo(msg) {
  if (!msg) { els.infoBanner.classList.add('hidden'); return; }
  els.infoBanner.textContent = msg;
  els.infoBanner.classList.remove('hidden');
}
function clearInfo() { els.infoBanner.classList.add('hidden'); }

function showSettingsError(msg) {
  if (!msg) { els.settingsError.classList.add('hidden'); return; }
  els.settingsError.textContent = msg;
  els.settingsError.classList.remove('hidden');
}
function showSettingsInfo(msg) {
  if (!msg) { els.settingsInfo.classList.add('hidden'); return; }
  els.settingsInfo.textContent = msg;
  els.settingsInfo.classList.remove('hidden');
}

/* -------------------------------------------------------------------------- */
/* Chat rendering                                                             */
/* -------------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Very small, safe markdown renderer for AI bubbles:
 *   - fenced ```lang\ncode``` blocks -> <pre><code>
 *   - inline `code` -> <code>
 *   - **bold** -> <strong>
 *   - ## headings, - bullet lists, paragraphs
 *
 * We escape everything first, then layer on a few transformations on the
 * escaped string, so we never inject raw HTML from the LLM.
 */
function renderMarkdown(md) {
  const escaped = escapeHtml(md || '');
  const parts = escaped.split(/(```[\s\S]*?```)/g);
  const out = [];

  for (const part of parts) {
    if (/^```/.test(part)) {
      // strip ```lang and closing ```
      const body = part.replace(/^```[a-zA-Z0-9+-]*\n?/, '').replace(/```$/, '');
      out.push(`<pre><code>${body}</code></pre>`);
    } else {
      let block = part;
      // Inline code
      block = block.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Bold
      block = block.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Headings (## and ###)
      block = block.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
      block = block.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
      // Bullet lists
      block = block.replace(/(?:^|\n)((?:- .*(?:\n|$))+)/g, (m, group) => {
        const items = group.trim().split(/\n/).map((line) =>
          line.replace(/^- /, '').trim()
        );
        return '\n<ul>' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>';
      });
      // Numbered lists
      block = block.replace(/(?:^|\n)((?:\d+\. .*(?:\n|$))+)/g, (m, group) => {
        const items = group.trim().split(/\n/).map((line) =>
          line.replace(/^\d+\. /, '').trim()
        );
        return '\n<ol>' + items.map((i) => `<li>${i}</li>`).join('') + '</ol>';
      });
      // Paragraphs: blank-line separated
      block = block
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => /^<(h\d|ul|ol|pre)/.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('');
      out.push(block);
    }
  }
  return out.join('');
}

function appendUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'msg user';
  row.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  els.messages.appendChild(row);
  scrollMessagesToBottom();
}

function appendAiMessage(text) {
  const row = document.createElement('div');
  row.className = 'msg ai';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(text);
  row.appendChild(bubble);
  els.messages.appendChild(row);
  scrollMessagesToBottom();
  return row;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function removeWelcomeIfPresent() {
  const w = els.messages.querySelector('.welcome');
  if (w) w.remove();
}

function setBusy(busy) {
  els.sendBtn.disabled = !!busy;
  els.input.disabled = !!busy;
  els.sendBtn.textContent = busy ? 'Working…' : 'Send';
  if (busy) {
    els.fetchModelsBtn.disabled = true;
    els.fetchModelsBtn.textContent = 'Fetching…';
  } else {
    els.fetchModelsBtn.disabled = false;
    els.fetchModelsBtn.textContent = 'Fetch Models';
  }
}

/* -------------------------------------------------------------------------- */
/* Status card                                                                */
/* -------------------------------------------------------------------------- */

function updateStatusCard(settings) {
  els.statusProvider.textContent = settings.provider || '—';
  els.statusModel.textContent = settings.model || '—';
}

/* -------------------------------------------------------------------------- */
/* Settings modal                                                             */
/* -------------------------------------------------------------------------- */

function openSettings() {
  showSettingsError('');
  showSettingsInfo('');
  els.modal.classList.remove('hidden');
  els.modal.setAttribute('aria-hidden', 'false');
  // Load current settings into the form
  window.kovix.getSettings().then((s) => {
    els.providerSel.value = s.provider || '';
    els.apiKeyInput.value = s.apiKey || '';
    els.baseUrlInput.value = s.baseUrl || '';
    if (s.model) {
      // If we already have a saved model, seed the dropdown with it so the user
      // can see what's configured without re-fetching.
      els.modelSel.innerHTML = `<option value="${escapeHtml(s.model)}">${escapeHtml(s.model)}</option>`;
      els.modelSel.value = s.model;
      els.modelSel.disabled = false;
    } else {
      els.modelSel.innerHTML = '<option value="">Click “Fetch Models” first</option>';
      els.modelSel.disabled = true;
    }
  }).catch((err) => showSettingsError(err.message));
}

function closeSettings() {
  els.modal.classList.add('hidden');
  els.modal.setAttribute('aria-hidden', 'true');
}

async function handleFetchModels() {
  showSettingsError('');
  showSettingsInfo('');
  const provider = els.providerSel.value;
  const apiKey = els.apiKeyInput.value.trim();
  const baseUrl = els.baseUrlInput.value.trim();

  if (!provider) {
    showSettingsError('Please select a provider first.');
    return;
  }

  els.fetchModelsBtn.disabled = true;
  els.fetchModelsBtn.textContent = 'Fetching…';

  try {
    const models = await window.kovix.fetchModels({ provider, apiKey, baseUrl });
    if (!Array.isArray(models) || models.length === 0) {
      showSettingsError('Provider returned no models.');
      els.modelSel.innerHTML = '<option value="">No models available</option>';
      els.modelSel.disabled = true;
      return;
    }
    els.modelSel.innerHTML = models
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join('');
    els.modelSel.disabled = false;
    showSettingsInfo(`Loaded ${models.length} models.`);
  } catch (err) {
    showSettingsError(err && err.message ? err.message : String(err));
    els.modelSel.innerHTML = '<option value="">Click “Fetch Models” first</option>';
    els.modelSel.disabled = true;
  } finally {
    els.fetchModelsBtn.disabled = false;
    els.fetchModelsBtn.textContent = 'Fetch Models';
  }
}

async function handleSaveSettings() {
  showSettingsError('');
  showSettingsInfo('');
  const next = {
    provider: els.providerSel.value,
    apiKey:   els.apiKeyInput.value.trim(),
    baseUrl:  els.baseUrlInput.value.trim(),
    model:    els.modelSel.value,
  };
  if (!next.provider) {
    showSettingsError('Please select a provider.');
    return;
  }
  if (!next.model) {
    showSettingsError('Please fetch and select a model.');
    return;
  }
  try {
    const saved = await window.kovix.saveSettings(next);
    updateStatusCard(saved);
    showInfo('Settings saved.');
    closeSettings();
  } catch (err) {
    showSettingsError(err && err.message ? err.message : String(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Send-message handler                                                       */
/* -------------------------------------------------------------------------- */

async function handleSend() {
  clearError();
  clearInfo();
  const text = els.input.value.trim();
  if (!text) return;

  removeWelcomeIfPresent();
  appendUserMessage(text);
  els.input.value = '';
  autoResizeInput();
  setBusy(true);

  try {
    const res = await window.kovix.sendMessage(text);

    if (res.assistant) {
      appendAiMessage(res.assistant);
    }

    if (res.error) {
      showError(res.error);
    }

    if (res.info) {
      showInfo(res.info);
    }

    if (res.nextStep) {
      setActiveStep(res.nextStep);
    }
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------------------------- */
/* Reset conversation                                                         */
/* -------------------------------------------------------------------------- */

async function handleReset() {
  try {
    await window.kovix.resetConvo();
    els.messages.innerHTML = '';
    const w = document.createElement('div');
    w.className = 'welcome';
    w.innerHTML = `
      <div class="welcome-title">Welcome to Kovix MVP</div>
      <div class="welcome-sub">
        Start by typing an idea. The 5-step workflow will refine it into a spec, plan the
        build, then write code to <code>output.txt</code>.
      </div>`;
    els.messages.appendChild(w);
    setActiveStep('idea');
    clearError();
    clearInfo();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Composer auto-resize                                                       */
/* -------------------------------------------------------------------------- */

function autoResizeInput() {
  const ta = els.input;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  els.sendBtn.addEventListener('click', handleSend);

  els.input.addEventListener('input', autoResizeInput);
  els.input.addEventListener('keydown', (e) => {
    // Enter to send, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  els.resetBtn.addEventListener('click', handleReset);

  // Settings modal open/close
  els.settingsBtn.addEventListener('click', openSettings);
  els.modal.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', closeSettings)
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.classList.contains('hidden')) {
      closeSettings();
    }
  });

  // Settings modal actions
  els.fetchModelsBtn.addEventListener('click', handleFetchModels);
  els.saveSettingsBtn.addEventListener('click', handleSaveSettings);

  // When user changes provider, clear the model dropdown so they re-fetch
  els.providerSel.addEventListener('change', () => {
    els.modelSel.innerHTML = '<option value="">Click “Fetch Models” first</option>';
    els.modelSel.disabled = true;
    showSettingsError('');
    showSettingsInfo('');
    // Pre-fill Base URL placeholder based on provider (visible hint only)
    const hints = {
      openai:     'https://api.openai.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      anthropic:  'https://api.anthropic.com',
      ollama:     'http://localhost:11434',
      gemini:     'https://generativelanguage.googleapis.com',
    };
    els.baseUrlInput.placeholder = hints[els.providerSel.value] || '';
  });
}

async function init() {
  bindEvents();
  setActiveStep('idea');
  try {
    const s = await window.kovix.getSettings();
    updateStatusCard(s);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

document.addEventListener('DOMContentLoaded', init);
