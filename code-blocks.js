'use strict';

/**
 * Kovix MVP — Multi-file code block extraction utilities
 *
 * Extracted from main.js so the parsing logic is unit-testable without
 * launching Electron. main.js requires this module and uses the functions
 * directly.
 *
 * extractCodeBlocks() parses ALL fenced code blocks from a markdown string
 * and returns an array of { filename, content, lang } objects. This enables
 * the Execute step to propose multiple files in one turn (e.g. index.html +
 * App.jsx + styles.css for a React counter app).
 *
 * Filename detection strategies (in priority order):
 *   1. Lang tag with path:  ```html:index.html  or  ```jsx:src/App.jsx
 *   2. First-line comment:  HTML comment, JS single-line, CSS block comment,
 *      Python hash, or SQL dash comment containing a filename
 *   3. Preceding markdown:  **index.html**  or  index.html:  immediately before the fence
 *   4. Fallback:            pickOutputFilename(lang)
 */

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

/**
 * Extract ALL fenced code blocks from a markdown string.
 *
 * @param {string} text - the markdown text to parse
 * @returns {Array<{filename: string, content: string, lang: string, index: number}>}
 *          array of code blocks (empty array if none found)
 */
function extractCodeBlocks(text) {
  if (typeof text !== 'string' || !text) return [];

  const lines = text.split(/\r?\n/);
  const blocks = [];

  // Regex matches the opening fence: ``` or ~~~, optional lang, optional :filename
  const fenceRe = /^(```|~~~)\s*([\w+-]*)?(?::([^\s]+))?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(fenceRe);
    if (!m) continue;

    const fence = m[1];
    const lang = (m[2] || '').toLowerCase();
    const pathFromTag = m[3] || '';

    // Find the closing fence
    let closeIdx = -1;
    const closeRe = new RegExp('^' + fence.replace(/`/g, '\\`') + '\\s*$');
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].match(closeRe)) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) continue;  // malformed, skip

    const body = lines.slice(i + 1, closeIdx).join('\n').replace(/\s+$/, '');
    const firstLine = lines[i + 1] || '';

    // Determine filename via the 4 strategies
    let filename = '';
    if (pathFromTag) {
      filename = pathFromTag;
    } else {
      filename = extractFilenameFromComment(firstLine);
    }
    if (!filename && i > 0) {
      filename = extractFilenameFromPrecedingLine(lines[i - 1]);
    }
    if (!filename) {
      filename = pickOutputFilename(lang);
    }

    blocks.push({
      filename,
      content: body,
      lang,
      index: blocks.length,
    });

    i = closeIdx;  // jump past this block
  }

  return blocks;
}

/**
 * Strategy 2: extract a filename from a comment line.
 */
function extractFilenameFromComment(line) {
  if (!line) return '';
  const trimmed = line.trim();

  let m = trimmed.match(/^<!--\s*([^\s>]+\.[^\s>]+)\s*-->$/);
  if (m) return m[1];

  m = trimmed.match(/^\/\/\s*([^\s]+\.[^\s]+)\s*$/);
  if (m) return m[1];
  m = trimmed.match(/^\/\*\s*([^\s]+\.[^\s]+)\s*\*\/$/);
  if (m) return m[1];

  m = trimmed.match(/^#\s*([^\s]+\.[^\s]+)\s*$/);
  if (m) return m[1];

  m = trimmed.match(/^--\s*([^\s]+\.[^\s]+)\s*$/);
  if (m) return m[1];

  return '';
}

/**
 * Strategy 3: extract a filename from the markdown line immediately before
 * the code fence.
 */
function extractFilenameFromPrecedingLine(line) {
  if (!line) return '';
  const trimmed = line.trim();
  if (!trimmed) return '';

  let m = trimmed.match(/^\*\*([^\s*]+\.[^\s*]+)\*\*$/);
  if (m) return m[1];

  m = trimmed.match(/^([^\s*]+\.[^\s*]+):\s*$/);
  if (m) return m[1];
  m = trimmed.match(/^\*\*([^\s*]+\.[^\s*]+)\*\*:\s*$/);
  if (m) return m[1];

  m = trimmed.match(/^#+\s*([^\s]+\.[^\s]+)\s*$/);
  if (m) return m[1];

  m = trimmed.match(/([^\s]+\.[^\s]+):?\s*$/);
  if (m) {
    const candidate = m[1].replace(/:$/, '');
    if (/\.[a-z0-9]+$/i.test(candidate)) {
      return candidate;
    }
  }

  return '';
}

module.exports = {
  extractCodeBlocks,
  extractFilenameFromComment,
  extractFilenameFromPrecedingLine,
  pickOutputFilename,
};
