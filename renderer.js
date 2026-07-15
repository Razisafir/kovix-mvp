'use strict';

/**
 * Kovix MVP — renderer (UI logic)
 *
 * Layout matches stitch_kovix_ai_assistant_ui mockups:
 *   - 48px header with Kovix brand + settings
 *   - 240px sidebar with Workflow steps + Workspace file manager
 *   - Fluid center chat area with sticky composer
 *   - Right file-viewer panel (40% width) that slides in when a file is opened
 *
 * Talks to the main process through window.kovix (preload.js).
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
const STEP_ICONS = {
  idea: 'lightbulb',
  refine: 'edit_note',
  spec: 'description',
  plan: 'assignment',
  execute: 'play_arrow',
};
const STEP_TITLES = {
  idea: 'Project Ideation',
  refine: 'Refining Requirements',
  spec: 'Specification',
  plan: 'Milestone Plan',
  execute: 'Executing',
};
const STEP_SUBS = {
  idea: 'Describe your concept, and I\'ll help structure the initial architecture and requirements.',
  refine: 'Answer the clarifying questions so we can lock down the spec.',
  spec: 'Review the formal specification generated from your requirements.',
  plan: 'Review the milestone plan before execution.',
  execute: 'The agent is writing code into your workspace.',
};
const STEP_PLACEHOLDERS = {
  idea: 'Describe your idea...',
  refine: 'Answer the clarifying questions...',
  spec: 'Approve the spec, or ask for changes...',
  plan: 'Approve the plan, or ask for changes...',
  execute: 'Send to execute and write code to your workspace...',
};

/* -------------------------------------------------------------------------- */
/* DOM lookups                                                                */
/* -------------------------------------------------------------------------- */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  // Header
  settingsBtn: $('#settings-btn'),
  resetBtn:    $('#reset-btn'),
  newProjectBtn: $('#new-project-btn'),
  workspacePill: $('#workspace-pill'),

  // Sidebar — workflow
  stepItems:   $$('.step-item'),
  statusProvider: $('#status-provider'),
  statusModel:    $('#status-model'),

  // Sidebar — file manager
  openFolderBtn: $('#open-folder-btn'),
  fileTree:      $('#file-tree'),

  // Sidebar — chat history
  historyList:        $('#history-list'),
  newSessionBtn:      $('#new-session-btn'),
  refreshHistoryBtn:  $('#refresh-history-btn'),

  // Chat
  messages:     $('#messages'),
  welcome:      $('#welcome'),
  input:        $('#input'),
  sendBtn:      $('#send-btn'),
  errorBanner:  $('#error-banner'),
  infoBanner:   $('#info-banner'),
  advanceBanner: $('#advance-banner'),
  advanceBtn:   $('#advance-step-btn'),

  // File viewer
  viewerPanel:     $('#file-viewer-panel'),
  viewerTitle:     $('#viewer-title'),
  viewerBreadcrumb: $('#viewer-breadcrumb'),
  viewerBody:      $('#viewer-body'),
  viewerCloseBtn:  $('#viewer-close-btn'),

  // Settings modal
  modal:         $('#settings-modal'),
  providerSel:   $('#provider'),
  apiKeyInput:   $('#api-key'),
  baseUrlInput:  $('#base-url'),
  modelSel:      $('#model'),
  fetchModelsBtn:  $('#fetch-models-btn'),
  saveSettingsBtn: $('#save-settings-btn'),
  testConnectionBtn: $('#test-connection-btn'),
  settingsError: $('#settings-error'),
  settingsInfo:  $('#settings-info'),
};

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const state = {
  currentStep: 'idea',
  activeWorkspace: '',
  selectedFilePath: '',
  busy: false,
  currentSessionId: null,
};

// --- Module-level watchdog ---
// Only ONE watchdog can exist at a time. Previous watchdogs are cleared at
// the start of each handleSend() so a stale timer from a previous (failed)
// message can never fire and cancel the new one.
let watchdogTimer = null;
let watchdogFired = false;
let watchdogUnsubscribeDelta = null;

function clearWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

function stopWatchdog() {
  clearWatchdog();
  if (watchdogUnsubscribeDelta) {
    watchdogUnsubscribeDelta();
    watchdogUnsubscribeDelta = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Step indicator + welcome header                                            */
/* -------------------------------------------------------------------------- */

function setActiveStep(step) {
  state.currentStep = step;
  const idx = STEP_ORDER.indexOf(step);
  els.stepItems.forEach((a) => {
    const s = a.dataset.step;
    const liIdx = STEP_ORDER.indexOf(s);
    a.classList.toggle('active', s === step);
    a.classList.toggle('done', liIdx < idx);
    // Update icon fill — active icons are filled per the mockup
    const iconEl = a.querySelector('.material-symbols-outlined');
    if (iconEl) {
      if (s === step) iconEl.style.fontVariationSettings = "'FILL' 1";
      else iconEl.style.fontVariationSettings = '';
    }
  });
  els.input.placeholder = STEP_PLACEHOLDERS[step] || 'Type your message...';
  // Update welcome header to reflect current step
  if (els.welcome) {
    const titleEl = els.welcome.querySelector('.welcome-title');
    const subEl = els.welcome.querySelector('.welcome-sub');
    const iconEl = els.welcome.querySelector('.welcome-icon .material-symbols-outlined');
    if (titleEl) titleEl.textContent = STEP_TITLES[step] || 'Kovix';
    if (subEl) subEl.textContent = STEP_SUBS[step] || '';
    if (iconEl) iconEl.textContent = STEP_ICONS[step] || 'lightbulb';
  }
}

/* -------------------------------------------------------------------------- */
/* Banners                                                                    */
/* -------------------------------------------------------------------------- */

function showError(msg) { banner(els.errorBanner, msg); }
function clearError()   { els.errorBanner.classList.add('hidden'); }
function showInfo(msg)  { banner(els.infoBanner, msg); }
function clearInfo()    { els.infoBanner.classList.add('hidden'); }
function showAdvanceBanner() { if (els.advanceBanner) els.advanceBanner.classList.remove('hidden'); }
function hideAdvanceBanner() { if (els.advanceBanner) els.advanceBanner.classList.add('hidden'); }
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
      block = block.replace(/^##\s+(.*)$/gm, '<h3>$1</h3>');
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
  hideWelcome();
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
  hideWelcome();
  scrollMessagesToBottom();
  return row;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function hideWelcome() {
  if (els.welcome && !els.welcome.classList.contains('hidden')) {
    els.welcome.classList.add('hidden');
  }
}

function showWelcome() {
  if (els.welcome) els.welcome.classList.remove('hidden');
}

function setBusy(busy) {
  state.busy = !!busy;
  els.input.disabled = state.busy;
  els.fetchModelsBtn.disabled = state.busy;
  if (state.busy) {
    // Turn the Send button into a Cancel button
    els.sendBtn.disabled = false;
    els.sendBtn.classList.add('canceling');
    els.sendBtn.querySelector('span:first-child').textContent = 'Cancel';
    const icon = els.sendBtn.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = 'cancel';
  } else {
    els.sendBtn.disabled = false;
    els.sendBtn.classList.remove('canceling');
    els.sendBtn.querySelector('span:first-child').textContent = 'Send';
    const icon = els.sendBtn.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = 'send';
  }
}

/* -------------------------------------------------------------------------- */
/* Status card + workspace pill                                               */
/* -------------------------------------------------------------------------- */

function updateStatusCard(settings) {
  els.statusProvider.textContent = settings.provider || '—';
  els.statusModel.textContent    = settings.model || '—';
}

function updateWorkspacePill(path) {
  state.activeWorkspace = path || '';
  if (!path) {
    els.workspacePill.textContent = 'No folder';
    els.workspacePill.title = 'No workspace folder open';
  } else {
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
    els.workspacePill.textContent = name;
    els.workspacePill.title = path;
  }
}

/* -------------------------------------------------------------------------- */
/* File tree                                                                  */
/* -------------------------------------------------------------------------- */

function fileIconName(name, isDir) {
  if (isDir) return 'folder';
  const ext = (name.split('.').pop() || '').toLowerCase();
  // NOTE: avoid Material Symbols "word-mark" ligatures like 'json', 'html',
  // 'css', 'javascript' — they render as wide multi-letter glyphs that break
  // the tree row layout. Use square single-glyph icons instead.
  if (['html', 'htm'].includes(ext)) return 'code';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'code';
  if (['ts', 'tsx'].includes(ext)) return 'code';
  if (['css', 'scss', 'sass'].includes(ext)) return 'palette';
  if (['json'].includes(ext)) return 'data_object';
  if (['md', 'markdown'].includes(ext)) return 'article';
  if (['py'].includes(ext)) return 'terminal';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
  if (['txt'].includes(ext)) return 'description';
  if (['env'].includes(ext)) return 'key';
  if (['lock'].includes(ext)) return 'lock';
  if (['yml', 'yaml'].includes(ext)) return 'settings';
  if (['xml'].includes(ext)) return 'code';
  if (['sql'].includes(ext)) return 'storage';
  if (['sh', 'bash'].includes(ext)) return 'terminal';
  return 'description';
}

function renderTree(node, depth = 0) {
  const wrap = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'tree-node' + (node.type === 'dir' ? ' is-dir' : '');
  row.dataset.path = node.path;
  row.dataset.type = node.type;
  row.dataset.name = node.name;
  const iconName = fileIconName(node.name, node.type === 'dir');
  const hasChildren = node.type === 'dir' && Array.isArray(node.children) && node.children.length > 0;
  // Chevron only shows for directories that actually have children.
  const chevron = hasChildren
    ? '<span class="tree-chevron"><span class="material-symbols-outlined">expand_more</span></span>'
    : '<span class="tree-chevron"></span>';
  row.innerHTML =
    chevron +
    `<span class="material-symbols-outlined">${escapeHtml(iconName)}</span>` +
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
      err.style.color = 'var(--error)';
      err.textContent = `⚠ ${node.error}`;
      children.appendChild(err);
    }
    // Collapsed by default for nested empty folders; expanded for non-empty
    // ones so users can drill down. Top level (depth 0) always starts expanded.
    if (depth > 0 && !hasChildren) {
      children.classList.add('collapsed');
      const ch = row.querySelector('.tree-chevron');
      if (ch) ch.classList.add('collapsed');
    }
    wrap.appendChild(children);

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const willCollapse = !children.classList.contains('collapsed');
      children.classList.toggle('collapsed');
      const ch = row.querySelector('.tree-chevron');
      if (ch) ch.classList.toggle('collapsed', willCollapse);
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
  els.fileTree.innerHTML = '';
  if (!state.activeWorkspace) {
    els.fileTree.innerHTML =
      '<div class="file-tree-empty"><span class="material-symbols-outlined">folder_off</span><span>No folder open</span></div>';
    return;
  }
  let res;
  try { res = await window.kovix.getTree(); }
  catch (err) {
    els.fileTree.innerHTML = `<div class="file-tree-empty"><span class="material-symbols-outlined">error</span><span>${escapeHtml(err.message || String(err))}</span></div>`;
    return;
  }
  if (!res.ok) {
    els.fileTree.innerHTML = `<div class="file-tree-empty"><span class="material-symbols-outlined">error</span><span>${escapeHtml(res.error || 'unknown')}</span></div>`;
    return;
  }
  if (!res.tree || !Array.isArray(res.tree.children)) {
    els.fileTree.innerHTML = '<div class="file-tree-empty"><span class="material-symbols-outlined">folder_off</span><span>Empty workspace</span></div>';
    return;
  }
  for (const child of res.tree.children) {
    els.fileTree.appendChild(renderTree(child, 0));
  }
  if (trySelectPath) {
    const safe = String(trySelectPath).replace(/["\\]/g, '\\$&');
    const row = els.fileTree.querySelector(`.tree-node[data-path="${safe}"]`);
    if (row && row.dataset.type === 'file') {
      selectFile(row.dataset.path, row);
    }
  }
}

async function selectFile(filePath, rowEl) {
  $$('.tree-node.selected').forEach((n) => n.classList.remove('selected'));
  if (rowEl) rowEl.classList.add('selected');

  state.selectedFilePath = filePath;
  const name = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
  els.viewerTitle.textContent = name;

  // Build breadcrumb from workspace-relative path
  const ws = state.activeWorkspace;
  let relPath = filePath;
  if (ws && filePath.startsWith(ws)) {
    relPath = filePath.slice(ws.length).replace(/^[\\/]+/, '');
  }
  const crumbs = relPath.split(/[\\/]/).filter(Boolean);
  els.viewerBreadcrumb.innerHTML = '';
  crumbs.forEach((c, i) => {
    const span = document.createElement('span');
    span.textContent = c;
    if (i === crumbs.length - 1) span.classList.add('crumb-current');
    els.viewerBreadcrumb.appendChild(span);
    if (i < crumbs.length - 1) {
      const chev = document.createElement('span');
      chev.className = 'material-symbols-outlined';
      chev.textContent = 'chevron_right';
      els.viewerBreadcrumb.appendChild(chev);
    }
  });

  els.viewerBody.innerHTML = '<div class="viewer-binary">Loading...</div>';

  let res;
  try { res = await window.kovix.readFile(filePath); }
  catch (err) {
    els.viewerBody.innerHTML = `<div class="viewer-binary">Error: ${escapeHtml(err.message || String(err))}</div>`;
    openViewerPanel();
    return;
  }
  if (!res.ok) {
    els.viewerBody.innerHTML = `<div class="viewer-binary">Error: ${escapeHtml(res.error || 'unknown')}</div>`;
    openViewerPanel();
    return;
  }

  if (res.binary) {
    els.viewerBody.innerHTML = `<div class="viewer-binary">${escapeHtml(res.content)}</div>`;
  } else {
    const lines = res.content.split('\n');
    const lineNums = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
    els.viewerBody.innerHTML =
      `<div class="viewer-code-wrap">` +
        `<div class="viewer-line-numbers">${lineNums}</div>` +
        `<div class="viewer-code"><pre>${escapeHtml(res.content)}</pre></div>` +
      `</div>`;
  }
  openViewerPanel();
}

function openViewerPanel() {
  els.viewerPanel.classList.remove('hidden');
}
function closeViewerPanel() {
  els.viewerPanel.classList.add('hidden');
  $$('.tree-node.selected').forEach((n) => n.classList.remove('selected'));
  state.selectedFilePath = '';
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
      if (res.canceled) return;
      showError(res.error || 'Failed to open folder');
      return;
    }
    updateWorkspacePill(res.path);
    await refreshFileTree();
    // Reset the active session (it belonged to the previous workspace, if any)
    state.currentSessionId = null;
    await window.kovix.newSession();
    clearChatUI();
    setActiveStep('idea');
    refreshHistory();
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
      els.modelSel.parentElement.classList.remove('disabled');
    } else {
      els.modelSel.innerHTML = '<option value="">Fetch models first...</option>';
      els.modelSel.disabled = true;
      els.modelSel.parentElement.classList.add('disabled');
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
  try {
    const models = await window.kovix.fetchModels({ provider, apiKey, baseUrl });
    if (!Array.isArray(models) || models.length === 0) {
      showSettingsError('Provider returned no models.');
      els.modelSel.innerHTML = '<option value="">No models available</option>';
      els.modelSel.disabled = true;
      els.modelSel.parentElement.classList.add('disabled');
      return;
    }
    els.modelSel.innerHTML = models
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join('');
    els.modelSel.disabled = false;
    els.modelSel.parentElement.classList.remove('disabled');
    showSettingsInfo(`Loaded ${models.length} models.`);
  } catch (err) {
    showSettingsError(err && err.message ? err.message : String(err));
    els.modelSel.innerHTML = '<option value="">Fetch models first...</option>';
    els.modelSel.disabled = true;
    els.modelSel.parentElement.classList.add('disabled');
  } finally {
    els.fetchModelsBtn.disabled = false;
  }
}

async function handleTestConnection() {
  showSettingsError('');
  showSettingsInfo('');
  const cfg = {
    provider: els.providerSel.value,
    apiKey:   els.apiKeyInput.value.trim(),
    baseUrl:  els.baseUrlInput.value.trim(),
  };
  if (!cfg.provider) {
    showSettingsError('Please select a provider first.');
    return;
  }

  const btn = els.testConnectionBtn;
  btn.disabled = true;
  btn.classList.remove('success', 'failure');
  btn.querySelector('span:last-child').textContent = 'Testing...';
  const icon = btn.querySelector('.material-symbols-outlined');
  if (icon) icon.textContent = 'progress_activity';

  try {
    const res = await window.kovix.testConnection(cfg);
    if (res.ok) {
      btn.classList.add('success');
      btn.querySelector('span:last-child').textContent = `Connected! ${res.modelCount} models available`;
      if (icon) icon.textContent = 'check_circle';
      showSettingsInfo(`Connection successful. ${res.modelCount} models available.`);
    } else {
      btn.classList.add('failure');
      btn.querySelector('span:last-child').textContent = 'Connection Failed';
      if (icon) icon.textContent = 'error';
      showSettingsError(res.error || 'Connection failed. Check your API key and network.');
    }
  } catch (err) {
    btn.classList.add('failure');
    btn.querySelector('span:last-child').textContent = 'Connection Failed';
    if (icon) icon.textContent = 'error';
    showSettingsError(err && err.message ? err.message : String(err));
  } finally {
    btn.disabled = false;
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
    activeWorkspace: state.activeWorkspace,
  };
  if (!next.provider) { showSettingsError('Please select a provider.'); return; }
  if (!next.model)    { showSettingsError('Please fetch and select a model.'); return; }
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
  // Guard: if already busy, do nothing. The Send button handler routes
  // to handleCancel() explicitly when busy, so we should never get here.
  if (state.busy) return;

  clearError();
  clearInfo();
  const text = els.input.value.trim();
  if (!text) return;

  if (!state.activeWorkspace) {
    showError('Please open a folder in the File Manager before starting.');
    return;
  }

  // CRITICAL: Clear any stale watchdog from a previous (failed) message.
  // Without this, a 60s timer from the last attempt can fire during this
  // new send and call cancelCurrent(), killing the new request.
  stopWatchdog();
  watchdogFired = false;

  appendUserMessage(text);
  els.input.value = '';
  autoResizeInput();
  setBusy(true);

  // --- Streaming setup ---
  // These are captured by the delta handler closure below.
  const sendCtx = {
    streamingBubble: null,
    streamingText: '',
    firstDeltaReceived: false,
  };

  watchdogUnsubscribeDelta = window.kovix.onLLMDelta((payload) => {
    if (!payload || !payload.delta) return;
    if (watchdogFired) return; // don't process deltas after watchdog fired
    if (!sendCtx.firstDeltaReceived) {
      sendCtx.firstDeltaReceived = true;
      hideWelcome();
      sendCtx.streamingBubble = appendAiMessage('');
      // Reset the watchdog since tokens are flowing.
      startWatchdog(sendCtx);
    }
    sendCtx.streamingText += payload.delta;
    if (sendCtx.streamingBubble) {
      const bubble = sendCtx.streamingBubble.querySelector('.bubble');
      if (bubble) bubble.innerHTML = renderMarkdown(sendCtx.streamingText);
      scrollMessagesToBottom();
    }
  });

  // Start the initial watchdog (will be reset on each delta).
  startWatchdog(sendCtx);

  try {
    const res = await window.kovix.sendMessage(text);
    stopWatchdog();

    if (watchdogFired) return; // watchdog already recovered; ignore stale response

    // If we got deltas, the bubble already exists with the streamed text.
    // If we DIDN'T get deltas, create the bubble now with the full response.
    if (!sendCtx.firstDeltaReceived && res.assistant) {
      appendAiMessage(res.assistant);
    } else if (sendCtx.firstDeltaReceived && sendCtx.streamingBubble) {
      const bubble = sendCtx.streamingBubble.querySelector('.bubble');
      if (bubble && res.assistant) {
        bubble.innerHTML = renderMarkdown(res.assistant);
      }
    }

    if (res.error) showError(res.error);
    if (res.info)  showInfo(res.info);
    // Show the "Next Step" button if the backend says this is a
    // conversational stage where the user can manually advance.
    if (res.canAdvance) {
      showAdvanceBanner();
    } else {
      hideAdvanceBanner();
    }
    if (res.nextStep) setActiveStep(res.nextStep);
    if (res.session && res.session.id) state.currentSessionId = res.session.id;
    if (res.wroteFile && res.writtenPath) {
      await refreshFileTree(res.writtenPath);
    }
    refreshHistory();
  } catch (err) {
    stopWatchdog();
    if (watchdogFired) return;
    showError(err && err.message ? err.message : String(err));
  } finally {
    stopWatchdog();
    if (!watchdogFired) setBusy(false);
  }
}

// --- Watchdog functions (module-level) ---
//
// The watchdog fires if NO token arrives within 60s, OR if tokens stop
// flowing for 60s. As long as tokens are arriving, it keeps resetting.
// A 2-minute response works fine because the user sees progress.
//
// CRITICAL: these use module-level variables so only ONE watchdog exists
// at a time. handleSend() calls stopWatchdog() at the start to clear any
// stale timer from a previous failed message.

function startWatchdog(sendCtx) {
  clearWatchdog();
  const WATCHDOG_MS = 60_000;
  console.log('[watchdog] starting 60s timer');
  watchdogTimer = setTimeout(async () => {
    console.log('[watchdog] FIRED after 60s — calling cancelCurrent');
    watchdogFired = true;
    if (watchdogUnsubscribeDelta) {
      watchdogUnsubscribeDelta();
      watchdogUnsubscribeDelta = null;
    }
    try { await window.kovix.cancelCurrent(); } catch (_) {}
    setBusy(false);
    if (!sendCtx.firstDeltaReceived) {
      showError('No response received after 60s. The provider may be down or your API key may be invalid. Try the Test Connection button in Settings.');
    } else {
      showError('Response stream stalled for 60s. Partial text is shown above.');
    }
  }, WATCHDOG_MS);
}

async function handleCancel() {
  console.log('[handleCancel] called, state.busy =', state.busy);
  console.log('[handleCancel] STACK:', new Error().stack);
  stopWatchdog();
  watchdogFired = true;  // prevent any pending watchdog from firing
  try {
    await window.kovix.cancelCurrent();
  } catch (_) { /* ignore */ }
  setBusy(false);
  showError('Request cancelled.');
}

/* -------------------------------------------------------------------------- */
/* Reset conversation                                                         */
/* -------------------------------------------------------------------------- */

async function handleReset() {
  try {
    await window.kovix.newSession();
    state.currentSessionId = null;
    clearChatUI();
    setActiveStep('idea');
    clearError();
    clearInfo();
    refreshHistory();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

function clearChatUI() {
  els.messages.innerHTML = '';
  const welcome = document.createElement('div');
  welcome.id = 'welcome';
  welcome.className = 'welcome';
  welcome.innerHTML =
    '<div class="welcome-icon"><span class="material-symbols-outlined">lightbulb</span></div>' +
    '<h1 class="welcome-title">Project Ideation</h1>' +
    '<p class="welcome-sub">Describe your concept, and I\'ll help structure the initial architecture and requirements.</p>';
  els.messages.appendChild(welcome);
  els.welcome = welcome;
}

/* -------------------------------------------------------------------------- */
/* Chat history                                                               */
/* -------------------------------------------------------------------------- */

function formatSessionDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return 'Today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) {
      return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch (_) { return iso; }
}

async function refreshHistory() {
  console.log('[history] refreshHistory called, activeWorkspace =', state.activeWorkspace);
  if (!state.activeWorkspace) {
    els.historyList.innerHTML =
      '<div class="history-empty"><span class="material-symbols-outlined">forum</span><span>Open a folder to save chats</span></div>';
    return;
  }
  let res;
  try { res = await window.kovix.listSessions(); }
  catch (err) {
    console.error('[history] listSessions threw:', err);
    els.historyList.innerHTML =
      `<div class="history-empty"><span class="material-symbols-outlined">error</span><span>${escapeHtml(err.message || String(err))}</span></div>`;
    return;
  }
  console.log('[history] listSessions returned:', res);
  if (!res.ok || !Array.isArray(res.sessions) || res.sessions.length === 0) {
    els.historyList.innerHTML =
      '<div class="history-empty"><span class="material-symbols-outlined">forum</span><span>No saved chats yet</span></div>';
    return;
  }
  console.log('[history] rendering', res.sessions.length, 'sessions');
  els.historyList.innerHTML = '';
  for (const s of res.sessions) {
    const item = document.createElement('div');
    item.className = 'history-item' + (s.id === state.currentSessionId ? ' active' : '');
    item.dataset.id = s.id;
    item.innerHTML =
      '<span class="history-icon"><span class="material-symbols-outlined">chat_bubble</span></span>' +
      '<div class="history-text">' +
        `<div class="history-title">${escapeHtml(s.title || 'Untitled session')}</div>` +
        `<div class="history-meta">${escapeHtml(formatSessionDate(s.updatedAt || s.startedAt))} · ${s.messageCount || 0} msgs · ${escapeHtml(s.step || 'idea')}</div>` +
      '</div>' +
      '<button class="history-delete" title="Delete chat" aria-label="Delete chat"><span class="material-symbols-outlined">delete</span></button>';

    item.addEventListener('click', (e) => {
      // Don't trigger load if they clicked delete
      if (e.target.closest('.history-delete')) return;
      loadSessionIntoUI(s.id);
    });
    item.querySelector('.history-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = confirm(`Delete this chat?\n\n"${s.title || 'Untitled session'}"`);
      if (!ok) return;
      try {
        await window.kovix.deleteSession(s.id);
        if (state.currentSessionId === s.id) {
          state.currentSessionId = null;
          await window.kovix.newSession();
          clearChatUI();
          setActiveStep('idea');
        }
        refreshHistory();
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
      }
    });

    els.historyList.appendChild(item);
  }
}

async function loadSessionIntoUI(id) {
  if (!id) return;
  setBusy(true);
  try {
    const res = await window.kovix.loadSession(id);
    if (!res.ok || !res.session) {
      showError(res.error || 'Failed to load session.');
      return;
    }
    const s = res.session;
    state.currentSessionId = s.id;
    // Rebuild the chat UI with the loaded messages
    els.messages.innerHTML = '';
    els.welcome = null;
    let sawAny = false;
    for (const m of (s.messages || [])) {
      if (m.role === 'system') continue;
      if (m.role === 'user') { appendUserMessage(m.content); sawAny = true; }
      else if (m.role === 'assistant') { appendAiMessage(m.content); sawAny = true; }
    }
    if (!sawAny) clearChatUI();
    setActiveStep(s.step || 'idea');
    clearError();
    showInfo(`Resumed session: ${s.title || 'Untitled'}`);
    refreshHistory();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------------------------- */
/* Composer auto-resize                                                       */
/* -------------------------------------------------------------------------- */

function autoResizeInput() {
  const ta = els.input;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  // Chat — Send button: sends if not busy, cancels if busy.
  // This is the ONLY way to cancel (explicit button click).
  els.sendBtn.addEventListener('click', () => {
    if (state.busy) {
      handleCancel();
    } else {
      handleSend();
    }
  });
  els.input.addEventListener('input', autoResizeInput);
  // Enter key: ONLY sends when NOT busy. Pressing Enter while busy does
  // nothing — this prevents accidental double-presses from cancelling
  // an in-flight request.
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!state.busy) {
        handleSend();
      }
    }
  });

  // Reset / new project
  els.resetBtn.addEventListener('click', handleReset);
  if (els.newProjectBtn) els.newProjectBtn.addEventListener('click', handleReset);

  // Chat history
  if (els.newSessionBtn)     els.newSessionBtn.addEventListener('click', handleReset);
  if (els.refreshHistoryBtn) els.refreshHistoryBtn.addEventListener('click', () => refreshHistory());

  // Settings modal
  els.settingsBtn.addEventListener('click', openSettings);
  els.modal.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', closeSettings)
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.modal.classList.contains('hidden')) closeSettings();
    }
  });
  els.fetchModelsBtn.addEventListener('click', handleFetchModels);
  els.saveSettingsBtn.addEventListener('click', handleSaveSettings);
  if (els.testConnectionBtn) els.testConnectionBtn.addEventListener('click', handleTestConnection);

  // Auto-fetch models when the user tabs out of the API key field (if a
  // provider is selected). Saves a click — just paste key, tab, models load.
  els.apiKeyInput.addEventListener('blur', () => {
    const provider = els.providerSel.value;
    const apiKey = els.apiKeyInput.value.trim();
    if (provider && apiKey && apiKey.length > 5) {
      // Only auto-fetch if the model dropdown is still empty/disabled.
      if (els.modelSel.disabled || !els.modelSel.value) {
        handleFetchModels();
      }
    }
  });

  // Also auto-fetch on Enter in the API key field.
  els.apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      els.apiKeyInput.blur();
    }
  });

  // Provider change → reset model dropdown + update baseUrl placeholder
  els.providerSel.addEventListener('change', () => {
    els.modelSel.innerHTML = '<option value="">Fetch models first...</option>';
    els.modelSel.disabled = true;
    els.modelSel.parentElement.classList.add('disabled');
    showSettingsError('');
    showSettingsInfo('');
    // Reset test-connection button
    if (els.testConnectionBtn) {
      els.testConnectionBtn.classList.remove('success', 'failure');
      els.testConnectionBtn.querySelector('span:last-child').textContent = 'Test Connection';
      const icon = els.testConnectionBtn.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = 'network_check';
    }
    const hints = {
      openai:     'https://api.openai.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      anthropic:  'https://api.anthropic.com',
      ollama:     'http://localhost:11434',
      gemini:     'https://generativelanguage.googleapis.com',
      nvidia:     'https://integrate.api.nvidia.com/v1',
      zai:        'https://api.z.ai/api/paas/v4',
    };
    els.baseUrlInput.placeholder = hints[els.providerSel.value] || '';
  });

  // File manager
  els.openFolderBtn.addEventListener('click', handleOpenFolder);
  els.viewerCloseBtn.addEventListener('click', closeViewerPanel);

  // Advance-step button — explicitly advances to the next workflow step.
  // This is the ONLY way to advance from Idea/Refine stages.
  if (els.advanceBtn) {
    els.advanceBtn.addEventListener('click', async () => {
      try {
        const res = await window.kovix.advanceStep();
        if (res.ok) {
          hideAdvanceBanner();
          setActiveStep(res.nextStep);
          showInfo(`Moved to: ${STEP_LABELS[res.nextStep] || res.nextStep}`);
          refreshHistory();
        } else {
          showError(res.error || 'Could not advance.');
        }
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
      }
    });
  }

  // Listen for tree-changed events
  window.kovix.onTreeChanged((_payload) => {
    refreshFileTree().catch((err) => console.error('tree refresh failed:', err));
  });
}

async function init() {
  bindEvents();
  initSidebarResizers();
  setActiveStep('idea');
  try {
    const s = await window.kovix.getSettings();
    updateStatusCard(s);
    updateWorkspacePill(s.activeWorkspace || '');
    if (s.activeWorkspace) await refreshFileTree();
    refreshHistory();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Resizable sidebar sections                                                 */
/* -------------------------------------------------------------------------- */
//
// Each `.sidebar-resizer` sits between two `.sidebar-section` elements.
// Dragging it adjusts the `flex-basis` of the section ABOVE it (the one
// that comes first in document order between the two). The section below
// absorbs the change because it has `flex: 1 1 <n>px`.
//
// We track drag state on `document` (mouse move/up) so the cursor can
// leave the thin handle without stopping the drag.

function initSidebarResizers() {
  const resizers = $$('.sidebar-resizer');
  resizers.forEach((resizer) => {
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      // The section ABOVE this resizer is the one we'll resize.
      const section = resizer.previousElementSibling;
      if (!section || !section.classList.contains('sidebar-section')) {
        cleanup();
        return;
      }
      const startY = e.clientY;
      const startHeight = section.getBoundingClientRect().height;
      const nav = section.closest('.side-nav');
      const navHeight = nav ? nav.getBoundingClientRect().height : 800;

      function onMouseMove(ev) {
        const delta = ev.clientY - startY;
        let nextHeight = startHeight + delta;
        // Clamp: min 80px, max 70% of nav height (leave room for other sections + footer)
        const maxH = navHeight * 0.7;
        nextHeight = Math.max(80, Math.min(maxH, nextHeight));
        section.style.flex = `0 0 ${nextHeight}px`;
      }
      function onMouseUp() {
        cleanup();
      }
      function cleanup() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
