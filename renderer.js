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
  els.sendBtn.disabled = state.busy;
  els.input.disabled = state.busy;
  els.sendBtn.querySelector('span:first-child').textContent = state.busy ? 'Working...' : 'Send';
  els.fetchModelsBtn.disabled = state.busy;
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
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'javascript';
  if (['ts', 'tsx'].includes(ext)) return 'javascript'; // no TS icon in material symbols; reuse
  if (['css', 'scss', 'sass'].includes(ext)) return 'css';
  if (['json'].includes(ext)) return 'json';
  if (['md', 'markdown'].includes(ext)) return 'description';
  if (['py'].includes(ext)) return 'code';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
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
  clearError();
  clearInfo();
  const text = els.input.value.trim();
  if (!text) return;

  if (!state.activeWorkspace) {
    showError('Please open a folder in the File Manager before starting.');
    return;
  }

  appendUserMessage(text);
  els.input.value = '';
  autoResizeInput();
  setBusy(true);

  try {
    const res = await window.kovix.sendMessage(text);
    if (res.assistant) appendAiMessage(res.assistant);
    if (res.error) showError(res.error);
    if (res.info)  showInfo(res.info);
    if (res.nextStep) setActiveStep(res.nextStep);
    if (res.session && res.session.id) state.currentSessionId = res.session.id;
    if (res.wroteFile && res.writtenPath) {
      await refreshFileTree(res.writtenPath);
    }
    // Refresh the history list so the new/updated session shows up.
    refreshHistory();
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
  if (!state.activeWorkspace) {
    els.historyList.innerHTML =
      '<div class="history-empty"><span class="material-symbols-outlined">forum</span><span>Open a folder to save chats</span></div>';
    return;
  }
  let res;
  try { res = await window.kovix.listSessions(); }
  catch (err) {
    els.historyList.innerHTML =
      `<div class="history-empty"><span class="material-symbols-outlined">error</span><span>${escapeHtml(err.message || String(err))}</span></div>`;
    return;
  }
  if (!res.ok || !Array.isArray(res.sessions) || res.sessions.length === 0) {
    els.historyList.innerHTML =
      '<div class="history-empty"><span class="material-symbols-outlined">forum</span><span>No saved chats yet</span></div>';
    return;
  }
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
  // Chat
  els.sendBtn.addEventListener('click', handleSend);
  els.input.addEventListener('input', autoResizeInput);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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

  // Provider change → reset model dropdown + update baseUrl placeholder
  els.providerSel.addEventListener('change', () => {
    els.modelSel.innerHTML = '<option value="">Fetch models first...</option>';
    els.modelSel.disabled = true;
    els.modelSel.parentElement.classList.add('disabled');
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
  els.viewerCloseBtn.addEventListener('click', closeViewerPanel);

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
