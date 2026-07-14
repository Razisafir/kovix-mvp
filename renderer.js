'use strict';

/**
 * Kovix MVP — renderer (UI logic)
 *
 * Three-pane layout:
 *   LEFT   — 5-step workflow + File Manager
 *   CENTER — Chat console + composer
 *   RIGHT  — File Viewer
 *
 * Talks to the main process exclusively through window.kovix (see preload.js).
 */

/* -------------------------------------------------------------------------- */
/* Step metadata                                                              */
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
  execute: 'Send to execute step 1 and write code to your workspace…',
};

/* -------------------------------------------------------------------------- */
/* DOM lookups                                                                */
/* -------------------------------------------------------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  // Header
  settingsBtn:   $('#settings-btn'),
  resetBtn:      $('#reset-btn'),
  workspaceName: $('#workspace-name'),

  // Sidebar — workflow
  stepItems:     $$('.step-item'),
  statusProvider: $('#status-provider'),
  statusModel:    $('#status-model'),
  stepPill:       $('#step-pill'),

  // Sidebar — file manager
  openFolderBtn: $('#open-folder-btn'),
  fileTree:      $('#file-tree'),

  // Chat
  messages:      $('#messages'),
  input:         $('#input'),
  sendBtn:       $('#send-btn'),
  errorBanner:   $('#error-banner'),
  infoBanner:    $('#info-banner'),

  // File viewer
  viewerTitle:   $('#viewer-title'),
  viewerMeta:    $('#viewer-meta'),
  viewerBody:    $('#viewer-body'),

  // Settings modal
  modal:         $('#settings-modal'),
  providerSel:   $('#provider'),
  apiKeyInput:   $('#api-key'),
  baseUrlInput:  $('#base-url'),
  modelSel:      $('#model'),
  fetchModelsBtn:  $('#fetch-models-btn'),
  saveSettingsBtn: $('#save-settings-btn'),
  settingsError: $('#settings-error'),
  settingsInfo:  $('#settings-info'),
};

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const state = {
  currentStep: 'idea',
  activeWorkspace: '',
  selectedFilePath: '',     // absolute path of the file currently shown in the viewer
  busy: false,
};

/* -------------------------------------------------------------------------- */
/* Step indicator                                                             */
/* -------------------------------------------------------------------------- */

function setActiveStep(step) {
  state.currentStep = step;
  const idx = STEP_ORDER.indexOf(step);
  els.stepItems.forEach((li) => {
    const s = li.dataset.step;
    const liIdx = STEP_ORDER.indexOf(s);
    li.classList.toggle('active', s === step);
    li.classList.toggle('done', liIdx < idx);
  });
  els.input.placeholder = STEP_PLACEHOLDERS[step] || 'Type a message…';
  els.stepPill.textContent = `Step ${idx + 1} · ${STEP_LABELS[step]}`;
}

/* -------------------------------------------------------------------------- */
/* Banners                                                                    */
/* -------------------------------------------------------------------------- */

function showError(msg)    { banner(els.errorBanner, msg); }
function clearError()      { els.errorBanner.classList.add('hidden'); }
function showInfo(msg)     { banner(els.infoBanner, msg); }
function clearInfo()       { els.infoBanner.classList.add('hidden'); }
function showSettingsError(msg) { banner(els.settingsError, msg); }
function showSettingsInfo(msg)  { banner(els.settingsInfo, msg); }

function banner(el, msg) {
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
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
 * Tiny, safe markdown renderer for AI bubbles:
 *   fenced ```lang\ncode``` -> <pre><code>
 *   inline `code`            -> <code>
 *   **bold**                 -> <strong>
 *   ## / ### headings
 *   - bullet lists, 1. numbered lists
 *   blank-line separated paragraphs
 *
 * Everything is escaped first; transformations operate on the escaped string,
 * so no raw HTML from the LLM ever reaches the DOM.
 */
function renderMarkdown(md) {
  const escaped = escapeHtml(md || '');
  const parts = escaped.split(/(```[\s\S]*?```)/g);
  const out = [];

  for (const part of parts) {
    if (/^```/.test(part)) {
      const body = part.replace(/^```[a-zA-Z0-9+-]*\n?/, '').replace(/```$/, '');
      out.push(`<pre><code>${body}</code></pre>`);
    } else {
      let block = part;
      block = block.replace(/`([^`]+)`/g, '<code>$1</code>');
      block = block.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      block = block.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
      block = block.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
      block = block.replace(/(?:^|\n)((?:- .*(?:\n|$))+)/g, (m, group) => {
        const items = group.trim().split(/\n/).map((l) => l.replace(/^- /, '').trim());
        return '\n<ul>' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>';
      });
      block = block.replace(/(?:^|\n)((?:\d+\. .*(?:\n|$))+)/g, (m, group) => {
        const items = group.trim().split(/\n/).map((l) => l.replace(/^\d+\. /, '').trim());
        return '\n<ol>' + items.map((i) => `<li>${i}</li>`).join('') + '</ol>';
      });
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
  state.busy = !!busy;
  els.sendBtn.disabled = state.busy;
  els.input.disabled = state.busy;
  els.sendBtn.textContent = state.busy ? 'Working…' : 'Send';
  els.fetchModelsBtn.disabled = state.busy;
  els.fetchModelsBtn.textContent = state.busy ? 'Fetching…' : 'Fetch Models';
}

/* -------------------------------------------------------------------------- */
/* Status card                                                                */
/* -------------------------------------------------------------------------- */

function updateStatusCard(settings) {
  els.statusProvider.textContent = settings.provider || '—';
  els.statusModel.textContent    = settings.model || '—';
}

function updateWorkspacePill(path) {
  state.activeWorkspace = path || '';
  if (!path) {
    els.workspaceName.textContent = 'No folder';
    els.workspaceName.title = 'No workspace folder open';
  } else {
    // Show basename for the pill, full path in the tooltip.
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
    els.workspaceName.textContent = name;
    els.workspaceName.title = path;
  }
}

/* -------------------------------------------------------------------------- */
/* File tree                                                                  */
/* -------------------------------------------------------------------------- */

function fileIcon(name, isDir) {
  if (isDir) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>`;
  }
  const ext = (name.split('.').pop() || '').toLowerCase();
  // Color-code by file type
  let color = 'currentColor';
  if (['html', 'htm'].includes(ext)) color = '#e06c2a';
  else if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) color = '#d4b106';
  else if (['ts', 'tsx'].includes(ext)) color = '#2b6cb0';
  else if (['css', 'scss', 'sass'].includes(ext)) color = '#39a0d6';
  else if (['json'].includes(ext)) color = '#7c7a72';
  else if (['md', 'markdown'].includes(ext)) color = '#5b8def';
  else if (['py'].includes(ext)) color = '#3776ab';
  else if (['txt'].includes(ext)) color = '#7c7a72';
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>`;
}

function renderTree(node, depth = 0) {
  // node = { name, path, type, children?, error? }
  const wrap = document.createDocumentFragment();

  const row = document.createElement('div');
  row.className = 'tree-node';
  row.dataset.path = node.path;
  row.dataset.type = node.type;
  row.dataset.name = node.name;
  row.innerHTML =
    `<span class="tree-icon">${fileIcon(node.name, node.type === 'dir')}</span>` +
    `<span class="tree-name">${escapeHtml(node.name)}</span>`;
  wrap.appendChild(row);

  if (node.type === 'dir') {
    const children = document.createElement('div');
    children.className = 'tree-children';
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        children.appendChild(renderTree(child, depth + 1));
      }
    }
    if (node.error) {
      const err = document.createElement('div');
      err.className = 'tree-node';
      err.style.color = 'var(--danger)';
      err.textContent = `⚠ ${node.error}`;
      children.appendChild(err);
    }
    // Top-level node (the workspace root) is always expanded.
    // Deeper directories start collapsed if empty, expanded if they have children.
    if (depth === 0) {
      children.classList.remove('hidden');
    } else if (node.children && node.children.length === 0) {
      children.classList.add('hidden');
    }
    wrap.appendChild(children);

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      children.classList.toggle('hidden');
    });
  } else {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      selectFile(node.path, row);
    });
  }

  return wrap;
}

async function refreshFileTree(trySelectPath) {
  // Clear current tree
  els.fileTree.innerHTML = '';

  if (!state.activeWorkspace) {
    els.fileTree.innerHTML =
      '<div class="file-tree-empty">No folder open.<br />Click <strong>Open</strong> to pick a workspace.</div>';
    return;
  }

  let res;
  try {
    res = await window.kovix.getTree();
  } catch (err) {
    els.fileTree.innerHTML =
      `<div class="file-tree-empty">Error: ${escapeHtml(err.message || String(err))}</div>`;
    return;
  }

  if (!res.ok) {
    els.fileTree.innerHTML =
      `<div class="file-tree-empty">Error: ${escapeHtml(res.error || 'unknown')}</div>`;
    return;
  }

  if (!res.tree || !Array.isArray(res.tree.children)) {
    els.fileTree.innerHTML =
      '<div class="file-tree-empty">Empty workspace.</div>';
    return;
  }

  // Render the root's children (skip rendering the root row itself for cleanliness)
  for (const child of res.tree.children) {
    els.fileTree.appendChild(renderTree(child, 0));
  }

  // If a file was just written, try to auto-select & open it.
  if (trySelectPath) {
    const row = els.fileTree.querySelector(`.tree-node[data-path="${cssEscape(trySelectPath)}"]`);
    if (row && row.dataset.type === 'file') {
      selectFile(row.dataset.path, row);
    }
  }
}

/**
 * Minimal CSS attribute-value escape (for querySelector on data-path).
 * Paths may contain characters that need backslash-escaping inside [attr="…"].
 */
function cssEscape(str) {
  return String(str).replace(/["\\]/g, '\\$&');
}

async function selectFile(filePath, rowEl) {
  // Mark selected in the tree
  $$('.tree-node.selected').forEach((n) => n.classList.remove('selected'));
  if (rowEl) rowEl.classList.add('selected');

  state.selectedFilePath = filePath;
  const name = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
  els.viewerTitle.textContent = name;
  els.viewerMeta.textContent = 'Loading…';
  els.viewerBody.innerHTML = '<div class="viewer-binary">Loading…</div>';

  let res;
  try {
    res = await window.kovix.readFile(filePath);
  } catch (err) {
    els.viewerMeta.textContent = 'Error';
    els.viewerBody.innerHTML =
      `<div class="viewer-binary">Error: ${escapeHtml(err.message || String(err))}</div>`;
    return;
  }

  if (!res.ok) {
    els.viewerMeta.textContent = 'Error';
    els.viewerBody.innerHTML =
      `<div class="viewer-binary">Error: ${escapeHtml(res.error || 'unknown')}</div>`;
    return;
  }

  const sizeStr = formatBytes(res.size || 0);
  if (res.binary) {
    els.viewerMeta.textContent = `${res.name} · ${sizeStr} · binary`;
    els.viewerBody.innerHTML =
      `<div class="viewer-binary">${escapeHtml(res.content)}</div>`;
  } else {
    els.viewerMeta.textContent = `${res.name} · ${sizeStr}`;
    const pre = document.createElement('pre');
    pre.className = 'viewer-pre';
    pre.textContent = res.content; // textContent = safe, no HTML injection
    els.viewerBody.innerHTML = '';
    els.viewerBody.appendChild(pre);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Open folder                                                                */
/* -------------------------------------------------------------------------- */

async function handleOpenFolder() {
  try {
    const res = await window.kovix.openFolder();
    if (!res.ok) {
      if (res.canceled) return; // silent on cancel
      showError(res.error || 'Failed to open folder');
      return;
    }
    updateWorkspacePill(res.path);
    await refreshFileTree();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Settings modal                                                             */
/* -------------------------------------------------------------------------- */

function openSettings() {
  showSettingsError('');
  showSettingsInfo('');
  els.modal.classList.remove('hidden');
  els.modal.setAttribute('aria-hidden', 'false');
  window.kovix.getSettings().then((s) => {
    els.providerSel.value = s.provider || '';
    els.apiKeyInput.value = s.apiKey || '';
    els.baseUrlInput.value = s.baseUrl || '';
    if (s.model) {
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
    activeWorkspace: state.activeWorkspace, // preserve existing workspace
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

  // Workspace guard (defensive — backend also checks).
  if (!state.activeWorkspace) {
    showError('Please open a folder in the File Manager before starting.');
    return;
  }

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

    // If the agent wrote a file, refresh the tree and auto-open it in the viewer.
    if (res.wroteFile && res.writtenPath) {
      await refreshFileTree(res.writtenPath);
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
        Open a workspace folder, then type an idea. The 5-step workflow will refine it
        into a spec, plan the build, then write code into your workspace.
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
  // Chat
  els.sendBtn.addEventListener('click', handleSend);
  els.input.addEventListener('input', autoResizeInput);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Reset
  els.resetBtn.addEventListener('click', handleReset);

  // Settings modal
  els.settingsBtn.addEventListener('click', openSettings);
  els.modal.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', closeSettings)
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.classList.contains('hidden')) {
      closeSettings();
    }
  });

  // Settings actions
  els.fetchModelsBtn.addEventListener('click', handleFetchModels);
  els.saveSettingsBtn.addEventListener('click', handleSaveSettings);

  // Provider change → reset model dropdown + update baseUrl placeholder
  els.providerSel.addEventListener('change', () => {
    els.modelSel.innerHTML = '<option value="">Click “Fetch Models” first</option>';
    els.modelSel.disabled = true;
    showSettingsError('');
    showSettingsInfo('');
    const hints = {
      openai:     'https://api.openai.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      anthropic:  'https://api.anthropic.com',
      ollama:     'http://localhost:11434',
      gemini:     'https://generativelanguage.googleapis.com',
    };
    els.baseUrlInput.placeholder = hints[els.providerSel.value] || '';
  });

  // File manager
  els.openFolderBtn.addEventListener('click', handleOpenFolder);

  // Listen for tree-changed events from main (e.g. after Execute writes a file).
  // The Execute path itself also calls refreshFileTree() with the specific file,
  // but this keeps the tree in sync if the workspace changes from elsewhere.
  window.kovix.onTreeChanged((_payload) => {
    refreshFileTree().catch((err) => {
      console.error('tree refresh failed:', err);
    });
  });
}

async function init() {
  bindEvents();
  setActiveStep('idea');

  try {
    const s = await window.kovix.getSettings();
    updateStatusCard(s);
    updateWorkspacePill(s.activeWorkspace || '');
    // If a workspace is already persisted, render its tree on boot.
    if (s.activeWorkspace) {
      await refreshFileTree();
    }
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

document.addEventListener('DOMContentLoaded', init);
