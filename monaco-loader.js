'use strict';

/**
 * Kovix MVP — Monaco Loader (renderer-side)
 *
 * Lazily boots Monaco's AMD distribution in the Electron renderer.
 *
 * Why AMD and not ESM?
 *   - The Kovix index.html has a strict CSP: `script-src 'self'`. Monaco's
 *     ESM distribution uses dynamic `import()` which (in older Electron
 *     builds) requires `unsafe-eval`/worker-src blob: permissions. The AMD
 *     distribution loads every chunk via a plain `<script src="...">` tag
 *     pointing at a local file under `node_modules/monaco-editor/min/vs`,
 *     which is allowed by `'self'`.
 *
 * Why lazy?
 *   - Monaco is ~3MB. We don't want to pay that cost on app boot — only
 *     the first time an Approve-Before-Write proposal arrives.
 *
 * Worker strategy:
 *   - Monaco normally spins up web workers for the JSON / TS / CSS language
 *     services. Under `script-src 'self'` (no `worker-src`), `new Worker(blob:)`
 *     is blocked. We redirect workers to the bundled `*.worker.js` files via
 *     `MonacoEnvironment.getWorkerUrl` returning a `file://`-style relative
 *     URL, which is allowed under `'self'`.
 *
 * Exports (on window.MonacoLoader):
 *   - getMonaco()                              -> Promise<monaco>
 *   - createDiffEditor(container, oldC, newC, language) -> Promise<DiffEditor>
 *   - createEditor(container, content, language)        -> Promise<editor>
 *   - detectLanguage(filePath)                           -> string
 */

(function () {
  // Use a RELATIVE path to Monaco's AMD distribution.
  //
  // WHY RELATIVE (not absolute file:// URL):
  //   - On Windows, absolute file:// URLs like
  //     `file:///C:/Users/.../loader.js` can fail to load via <script src>
  //     depending on Electron's webSecurity settings and the Windows
  //     path-format quirks (three slashes + drive letter is ambiguous).
  //   - A relative URL like `./node_modules/.../loader.js` resolves against
  //     the document's base URL — which is `index.html`. This works in:
  //       * Dev: index.html is at the project root
  //       * Packaged (asar): index.html is at the root of app.asar, and
  //         Electron transparently patches file:// reads to reach inside asar
  //   - Relative URLs are the most portable option across Mac/Windows/Linux
  //     and across dev/packaged builds. We deliberately avoid `new URL(...)`
  //     and `file://` construction.
  //
  // The leading `./` is important — it forces the browser to treat this as
  // a path relative to the document, not a bare module specifier.
  const MONACO_VS_PATH = './node_modules/monaco-editor/min/vs';
  const LOADER_SCRIPT_URL = MONACO_VS_PATH + '/loader.js';
  const EDITOR_MAIN_MODULE = 'vs/editor/editor.main';

  // Module-level cache. Once Monaco is loaded we reuse the same instance
  // for every subsequent proposal.
  let monacoPromise = null;

  /**
   * Map a file path / extension to a Monaco language id.
   * @param {string} filePath
   * @returns {string}
   */
  function detectLanguage(filePath) {
    if (!filePath || typeof filePath !== 'string') return 'plaintext';
    const lower = filePath.toLowerCase();
    const ext = lower.slice(lower.lastIndexOf('.') + 1);
    switch (ext) {
      case 'js':
      case 'jsx':
      case 'mjs':
      case 'cjs':
        return 'javascript';
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'html':
      case 'htm':
        return 'html';
      case 'css':
        return 'css';
      case 'scss':
      case 'sass':
        return 'scss';
      case 'json':
        return 'json';
      case 'py':
        return 'python';
      case 'md':
      case 'markdown':
        return 'markdown';
      case 'sh':
      case 'bash':
      case 'zsh':
        return 'shell';
      case 'go':
        return 'go';
      case 'rs':
        return 'rust';
      case 'java':
        return 'java';
      case 'c':
      case 'h':
        return 'c';
      case 'cpp':
      case 'cc':
      case 'cxx':
      case 'hpp':
      case 'hxx':
        return 'cpp';
      case 'cs':
        return 'csharp';
      case 'rb':
        return 'ruby';
      case 'php':
        return 'php';
      case 'yml':
      case 'yaml':
        return 'yaml';
      case 'xml':
      case 'svg':
        return 'xml';
      case 'sql':
        return 'sql';
      default:
        return 'plaintext';
    }
  }

  /**
   * Inject the AMD loader script into the document if it isn't already there.
   * Resolves once `window.require` (Monaco's AMD `require`) is available.
   * @returns {Promise<void>}
   */
  function injectAmdLoader() {
    return new Promise((resolve, reject) => {
      if (typeof window.require === 'function' && window.require.config) {
        // Already injected by a previous call.
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = LOADER_SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        if (typeof window.require === 'function') {
          resolve();
        } else {
          reject(new Error('Monaco AMD loader.js loaded but window.require is missing'));
        }
      };
      script.onerror = () => {
        reject(new Error('Failed to load Monaco AMD loader.js from ' + LOADER_SCRIPT_URL));
      };
      document.head.appendChild(script);
    });
  }

  /**
   * Configure the MonacoEnvironment so worker creation works under the
   * `script-src 'self'` CSP. We return a `file://`-relative URL pointing
   * at the bundled worker main so the browser does NOT try to spin up a
   * blob: worker (which would be blocked).
   *
   * @param {string} workerModuleId - e.g. 'vs/editor/editor.worker' or
   *        'vs/language/json/json.worker'
   * @returns {string} URL usable by `new Worker()`
   */
  function getWorkerUrl(workerModuleId) {
    // Use the same relative path prefix as the loader script. Relative URLs
    // are Windows-safe (no file:///C:/ drive-letter ambiguity) and resolve
    // correctly in both dev and asar-packaged builds.
    return MONACO_VS_PATH + '/' + workerModuleId + '.js';
  }

  /**
   * Configure MonacoEnvironment BEFORE the editor.main module loads so
   * Monaco picks up our worker URL resolver at boot.
   */
  function setupMonacoEnvironment() {
    if (window.MonacoEnvironment) return;
    window.MonacoEnvironment = {
      // Monaco calls getWorker(moduleId, label) when it needs a worker.
      // We hand back a Worker created from the bundled worker script URL
      // (NOT a blob), which keeps us CSP-compliant.
      getWorker: function (_moduleId, _label) {
        // Default editor worker — sufficient for plain text + diff highlighting.
        // Language services (JSON/TS/CSS) will fall back to the main thread
        // if their dedicated worker is unavailable, which is acceptable for
        // the diff-view use case.
        try {
          return new Worker(getWorkerUrl('vs/editor/editor.worker'));
        } catch (err) {
          // Some Electron builds block Worker creation entirely under strict
          // CSP. Monaco degrades gracefully to main-thread tokenization when
          // worker creation throws — return null and let Monaco handle it.
          console.warn('[monaco-loader] worker creation failed, falling back to main thread:', err);
          return null;
        }
      },
    };
  }

  /**
   * Define a custom Monaco theme (`kovix-dark`) that matches the Kovix dark
   * premium palette. The editor background is `#111113` (the same as
   * `--monaco-bg` / `--bg-surface`) so Monaco blends seamlessly into the
   * staging panel without needing CSS overrides.
   *
   * Token colors are inherited from `vs-dark` (Monaco's built-in dark theme)
   * so syntax highlighting remains familiar to developers. Only the surfaces
   * (background, line-number gutter, selection) are re-pointed.
   *
   * @param {typeof import('monaco-editor')} monaco
   */
  function defineKovixDarkTheme(monaco) {
    if (!monaco || !monaco.editor || typeof monaco.editor.defineTheme !== 'function') return;
    monaco.editor.defineTheme('kovix-dark', {
      base: 'vs-dark',           // inherit token colors from vs-dark
      inherit: true,
      rules: [
        // Keep vs-dark token colors — these are inherited, no overrides needed.
      ],
      colors: {
        // Editor background — matches --monaco-bg / --bg-surface
        'editor.background': '#111113',
        // Gutter (line numbers) — matches --bg-surface, slightly different feel
        'editorGutter.background': '#111113',
        // Line number color — matches --text-tertiary
        'editorLineNumber.foreground': '#6b6b75',
        'editorLineNumber.activeForeground': '#a0a0a8',
        // Current line highlight — subtle elevated surface
        'editor.lineHighlightBackground': '#18181b',
        'editor.lineHighlightBorder': '#18181b',
        // Selection — accent-soft
        'editor.selectionBackground': 'rgba(99, 102, 241, 0.25)',
        'editor.selectionHighlightBackground': 'rgba(99, 102, 241, 0.15)',
        // Cursor — accent
        'editorCursor.foreground': '#6366f1',
        // Whitespace
        'editorWhitespace.foreground': '#2a2a30',
        // Indent guides
        'editorIndentGuide.background': '#1f1f23',
        'editorIndentGuide.activeBackground': '#2a2a30',
        // Bracket matching
        'editorBracketMatch.background': 'rgba(99, 102, 241, 0.15)',
        'editorBracketMatch.border': '#6366f1',
        // Scrollbar
        'editorScrollbar.hoverBackground': '#3a3a42',
        'editorScrollbar.background': '#18181b',
        'editorScrollbarSlider.background': '#2a2a30',
        'editorScrollbarSlider.hoverBackground': '#3a3a42',
        'editorScrollbarSlider.activeBackground': '#3a3a42',
        // Diff editor — added/removed lines
        'diffEditor.insertedTextBackground': 'rgba(16, 185, 129, 0.12)',
        'diffEditor.removedTextBackground': 'rgba(239, 68, 68, 0.12)',
        'diffEditor.insertedLineBackground': 'rgba(16, 185, 129, 0.08)',
        'diffEditor.removedLineBackground': 'rgba(239, 68, 68, 0.08)',
        'diffEditorGutter.insertedLineBackground': 'rgba(16, 185, 129, 0.08)',
        'diffEditorGutter.removedLineBackground': 'rgba(239, 68, 68, 0.08)',
        // Focus border — accent
        'editor.focusBorder': '#6366f1',
      },
    });
  }

  /**
   * Boot Monaco (lazy). Resolves to the `monaco` global.
   * Subsequent calls reuse the same Promise.
   * @returns {Promise<typeof import('monaco-editor')>}
   */
  function getMonaco() {
    if (monacoPromise) return monacoPromise;
    monacoPromise = injectAmdLoader()
      .then(() => {
        setupMonacoEnvironment();
        // Configure AMD paths so 'vs/...' module ids resolve to
        // ./node_modules/monaco-editor/min/vs/... (relative path is
        // Windows-safe and works in both dev and asar-packaged builds).
        window.require.config({ paths: { vs: MONACO_VS_PATH } });
        return new Promise((resolve, reject) => {
          window.require(
            [EDITOR_MAIN_MODULE],
            () => {
              if (window.monaco) {
                // Define the custom Kovix dark theme and apply it up-front
                // so the first diff view doesn't flash white or mismatch
                // the staging panel background.
                defineKovixDarkTheme(window.monaco);
                window.monaco.editor.setTheme('kovix-dark');
                resolve(window.monaco);
              } else {
                reject(new Error('Monaco editor.main loaded but window.monaco is missing'));
              }
            },
            (err) => {
              reject(new Error('Monaco AMD require() failed: ' + (err && err.message ? err.message : String(err))));
            }
          );
        });
      })
      .catch((err) => {
        // Reset so a later retry can attempt to boot again.
        monacoPromise = null;
        throw err;
      });
    return monacoPromise;
  }

  /**
   * Create a side-by-side diff editor in `container`.
   *
   * @param {HTMLElement} container
   * @param {string} originalContent - left side (read-only)
   * @param {string} modifiedContent - right side (read-only)
   * @param {string} [language='plaintext']
   * @returns {Promise<import('monaco-editor').editor.IDiffEditor>}
   */
  function createDiffEditor(container, originalContent, modifiedContent, language) {
    if (!container) return Promise.reject(new Error('createDiffEditor: container is required'));
    const lang = language || 'plaintext';
    return getMonaco().then((monaco) => {
      // Diff editor options — render side-by-side, read-only on both sides
      // (the user can click "Modify" to switch to a single editable editor).
      const diffEditor = monaco.diffEditor.createDiffEditor(container, {
        automaticLayout: true,
        renderSideBySide: true,
        readOnly: true,
        originalEditable: false,
        theme: 'kovix-dark',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, Consolas, monospace",
        renderOverviewRuler: false,
      });

      const originalModel = monaco.editor.createModel(
        originalContent == null ? '' : String(originalContent),
        lang
      );
      const modifiedModel = monaco.editor.createModel(
        modifiedContent == null ? '' : String(modifiedContent),
        lang
      );
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });

      // Force a layout pass now that the container is visible.
      try { diffEditor.layout(); } catch (_) { /* noop */ }

      return diffEditor;
    });
  }

  /**
   * Create a single editable Monaco editor in `container`. Used for the
   * "Modify" flow — the user edits the proposed content inline, then clicks
   * Save to submit their version.
   *
   * @param {HTMLElement} container
   * @param {string} content
   * @param {string} [language='plaintext']
   * @returns {Promise<import('monaco-editor').editor.IStandaloneCodeEditor>}
   */
  function createEditor(container, content, language) {
    if (!container) return Promise.reject(new Error('createEditor: container is required'));
    const lang = language || 'plaintext';
    return getMonaco().then((monaco) => {
      const editor = monaco.editor.create(container, {
        value: content == null ? '' : String(content),
        language: lang,
        theme: 'kovix-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, Consolas, monospace",
        tabSize: 2,
        wordWrap: 'on',
      });
      try { editor.layout(); } catch (_) { /* noop */ }
      return editor;
    });
  }

  // Expose on window so renderer.js can call without a bundler.
  window.MonacoLoader = {
    getMonaco,
    createDiffEditor,
    createEditor,
    detectLanguage,
  };
})();
