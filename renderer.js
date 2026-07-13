// renderer.js — Kovix MVP UI (5-step state machine: Idea→Refine→Spec→Plan→Execute)
(() => {
  var chatMessages = document.getElementById('chat-messages');
  var chatInput = document.getElementById('chat-input');
  var btnSend = document.getElementById('btn-send');
  var btnReset = document.getElementById('btn-reset');
  var btnSettings = document.getElementById('btn-settings');
  var btnCloseSettings = document.getElementById('btn-close-settings');
  var btnSaveSettings = document.getElementById('btn-save-settings');
  var settingsOverlay = document.getElementById('settings-overlay');
  var inputApiKey = document.getElementById('input-api-key');
  var selectModel = document.getElementById('select-model');
  var settingsStatus = document.getElementById('settings-status');
  var stepItems = document.querySelectorAll('.step');
  var loopBadge = document.getElementById('loop-badge');
  var detailPhase = document.getElementById('detail-phase');
  var detailTask = document.getElementById('detail-task');

  var STEPS_ORDER = ['idea', 'refine', 'spec', 'plan', 'execute'];
  var currentState = 'idea';
  var isProcessing = false;
  var hasApiKey = false;

  var PLACEHOLDERS = {
    idea: 'Describe your idea\u2026',
    refine: 'Answer the clarifying questions\u2026',
    spec: 'Generating spec\u2026',
    plan: 'Generating plan\u2026',
    execute: 'Writing code\u2026',
  };

  // ─── Settings ─────────────────────────────────────────────
  function openSettings() {
    settingsOverlay.classList.remove('hidden');
    window.kovix.getConfig().then(function(cfg) {
      selectModel.value = cfg.model || 'openai/gpt-4o-mini';
      if (cfg.hasKey) {
        inputApiKey.value = '\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF' + cfg.apiKey;
        inputApiKey.type = 'text';
        hasApiKey = true;
      } else {
        inputApiKey.value = '';
        inputApiKey.type = 'password';
        hasApiKey = false;
      }
      updateSettingsStatus(cfg.hasKey);
    });
    inputApiKey.focus();
  }

  function closeSettings() {
    settingsOverlay.classList.add('hidden');
  }

  function updateSettingsStatus(hasKey) {
    if (hasKey) {
      settingsStatus.textContent = '\u2713 API key is set';
      settingsStatus.className = 'settings-status ok';
    } else {
      settingsStatus.textContent = '\u26A0 No API key \u2014 the loop won\'t work without one';
      settingsStatus.className = 'settings-status warn';
    }
  }

  btnSettings.addEventListener('click', openSettings);
  btnCloseSettings.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', function(e) {
    if (e.target === settingsOverlay) closeSettings();
  });

  btnSaveSettings.addEventListener('click', function() {
    var apiKey = inputApiKey.value.trim();
    var model = selectModel.value;
    window.kovix.saveConfig({ apiKey: apiKey, model: model }).then(function(result) {
      if (result.success) {
        hasApiKey = result.hasKey;
        updateSettingsStatus(hasApiKey);
        settingsStatus.textContent = '\u2713 Saved!';
        settingsStatus.className = 'settings-status ok';
        setTimeout(closeSettings, 800);
      }
    });
  });

  // ─── UI Helpers ──────────────────────────────────────────
  function setActiveStep(state) {
    stepItems.forEach(function(li) {
      var s = li.getAttribute('data-step');
      var idx = STEPS_ORDER.indexOf(s);
      var currentIdx = STEPS_ORDER.indexOf(state);
      li.classList.toggle('active', s === state);
      li.classList.toggle('completed', idx < currentIdx);
    });
    detailPhase.textContent = state;
  }

  function setBadge(text, cls) {
    loopBadge.textContent = text;
    loopBadge.className = 'loop-badge ' + cls;
  }

  function addMessage(role, content, extra) {
    var div = document.createElement('div');
    div.className = 'msg msg-' + role;
    if (extra === 'error') div.classList.add('msg-error');
    if (extra === 'success') div.classList.add('msg-success');
    if (extra === 'system') div.classList.add('msg-system');

    if (role === 'assistant') {
      div.innerHTML = renderContent(content);
    } else {
      div.textContent = content;
    }

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  function renderContent(text) {
    var html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    html = html.replace(/```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/g, function(_, lang, code) {
      return '<pre class="code-block"><code>' + code + '</code></pre>';
    });
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function setLoading(loading) {
    isProcessing = loading;
    btnSend.disabled = loading;
    chatInput.disabled = loading;
    btnSend.classList.toggle('loading', loading);
  }

  // ─── Core Send Logic ─────────────────────────────────────
  function sendMessage() {
    var text = chatInput.value.trim();
    if (!text || isProcessing) return;

    if (!hasApiKey) {
      addMessage('system', '\u26A0 No API key set. Click the \u2699 gear icon to add your OpenRouter key.', 'error');
      openSettings();
      return;
    }

    chatInput.value = '';
    autoResize();
    addMessage('user', text);
    setLoading(true);
    setBadge('RUNNING', 'running');

    window.kovix.sendMessage(text).then(function(result) {
      if (result.error) {
        addMessage('system', '\u26A0 Error: ' + result.error, 'error');
        setBadge('ERROR', 'blocked');
        setLoading(false);
        return;
      }

      currentState = result.currentState;
      setActiveStep(currentState);
      chatInput.placeholder = PLACEHOLDERS[currentState] || 'Type a message\u2026';

      if (result.response) {
        addMessage('assistant', result.response);
      }

      // Handle file write result (Execute step)
      if (result.fileResult) {
        if (result.fileResult.success) {
          addMessage('system', '\u2705 Success! File written to ' + result.fileResult.path, 'success');
          setBadge('COMPLETE', 'complete');
          detailTask.textContent = 'output.txt';
        } else {
          addMessage('system', '\u26A0 File write failed: ' + result.fileResult.error, 'error');
          setBadge('ERROR', 'blocked');
        }
        setLoading(false);
        return;
      }

      // Auto-advance: Spec→Plan→Execute happen automatically
      if (result.autoAdvance) {
        setBadge('RUNNING', 'running');
        // Small delay so user sees the response before next step
        setTimeout(function() { autoAdvance(); }, 500);
      } else if (currentState === 'refine') {
        // Waiting for user input
        setBadge('REFINE', 'running');
        setLoading(false);
      } else if (currentState === 'execute') {
        setLoading(false);
        setBadge('COMPLETE', 'complete');
      } else {
        setLoading(false);
      }
    }).catch(function(err) {
      addMessage('system', '\u26A0 Unexpected: ' + (err.message || err), 'error');
      setBadge('ERROR', 'blocked');
      setLoading(false);
    });
  }

  // ─── Auto-advance for Spec→Plan→Execute ──────────────────
  function autoAdvance() {
    // Send a continuation message to trigger the next state
    var prompt = '';
    if (currentState === 'spec') {
      prompt = 'Generate the spec now.';
    } else if (currentState === 'plan') {
      prompt = 'Generate the plan now.';
    } else {
      setLoading(false);
      return;
    }

    addMessage('system', '\u25B8 Auto-advancing to next step\u2026', 'system');

    window.kovix.sendMessage(prompt).then(function(result) {
      if (result.error) {
        addMessage('system', '\u26A0 Error: ' + result.error, 'error');
        setBadge('ERROR', 'blocked');
        setLoading(false);
        return;
      }

      currentState = result.currentState;
      setActiveStep(currentState);
      chatInput.placeholder = PLACEHOLDERS[currentState] || 'Type a message\u2026';

      if (result.response) {
        addMessage('assistant', result.response);
      }

      if (result.fileResult) {
        if (result.fileResult.success) {
          addMessage('system', '\u2705 Success! File written to ' + result.fileResult.path, 'success');
          setBadge('COMPLETE', 'complete');
          detailTask.textContent = 'output.txt';
        } else {
          addMessage('system', '\u26A0 File write failed: ' + result.fileResult.error, 'error');
          setBadge('ERROR', 'blocked');
        }
        setLoading(false);
        return;
      }

      if (result.autoAdvance) {
        setTimeout(function() { autoAdvance(); }, 500);
      } else {
        setLoading(false);
      }
    }).catch(function(err) {
      addMessage('system', '\u26A0 Auto-advance error: ' + (err.message || err), 'error');
      setBadge('ERROR', 'blocked');
      setLoading(false);
    });
  }

  // ─── Auto-resize textarea ────────────────────────────────
  function autoResize() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  }

  chatInput.addEventListener('input', autoResize);

  // ─── Event Listeners ─────────────────────────────────────
  btnSend.addEventListener('click', function(e) {
    e.preventDefault();
    sendMessage();
  });

  chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  btnReset.addEventListener('click', function() {
    window.kovix.reset().then(function() {
      currentState = 'idea';
      chatMessages.innerHTML = '';
      setActiveStep('idea');
      setBadge('IDLE', 'idle');
      detailTask.textContent = '\u2014';
      chatInput.placeholder = PLACEHOLDERS.idea;
      setLoading(false);
      addMessage('system', 'Session reset. Describe your idea to get started.');
    });
  });

  // ─── Init ────────────────────────────────────────────────
  setActiveStep('idea');

  window.kovix.getConfig().then(function(cfg) {
    hasApiKey = cfg.hasKey;
    if (cfg.hasKey) {
      addMessage('system', 'Welcome to Kovix. Model: ' + cfg.model + '. Describe your idea to get started.');
    } else {
      addMessage('system', 'Welcome to Kovix! Click the \u2699 gear icon to set your OpenRouter API key first.', 'error');
      setTimeout(openSettings, 500);
    }
  });
})();
