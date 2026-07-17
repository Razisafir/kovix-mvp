'use strict';

/**
 * Smoke test for Task Zeta — multi-file code block extraction.
 *
 * Tests the extractCodeBlocks() function and its helpers against various
 * LLM output formats. The Execute step itself can't be unit-tested without
 * launching Electron (it calls staging.propose() which needs IPC), but the
 * parsing logic is the heart of the multi-file feature.
 *
 * Run: node /home/z/my-project/repos/kovix-mvp/scripts/smoke-zeta.js
 */

const {
  extractCodeBlocks,
  extractFilenameFromComment,
  extractFilenameFromPrecedingLine,
  pickOutputFilename,
} = require('../code-blocks.js');

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.error(`  ✗ ${msg}`);
    fail++;
  }
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected "${expected}", got "${actual}")`);
}

function main() {
  console.log('--- Task Zeta smoke test (multi-file extraction) ---\n');

  // -------- 1. Single code block (backward compat) --------
  console.log('[1] Single code block (backward compat)');
  {
    const md = 'Here is your code:\n\n```html\n<h1>Hello</h1>\n```';
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 1, 'returns 1 block');
    assertEq(blocks[0].content, '<h1>Hello</h1>', 'content correct');
    assertEq(blocks[0].lang, 'html', 'lang correct');
    assertEq(blocks[0].filename, 'index.html', 'filename falls back to pickOutputFilename');
  }

  // -------- 2. Multiple code blocks (the new feature) --------
  console.log('\n[2] Multiple code blocks — React app');
  {
    const md = `I'll create a React counter app. Here are the files:

\`\`\`html:index.html
<!DOCTYPE html>
<html>
<body><div id="root"></div></body>
</html>
\`\`\`

\`\`\`jsx:src/App.jsx
import { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
\`\`\`

\`\`\`css:src/styles.css
button { padding: 8px 16px; background: indigo; color: white; }
\`\`\``;
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 3, 'returns 3 blocks');
    assertEq(blocks[0].filename, 'index.html', 'block 0 filename from lang:path tag');
    assertEq(blocks[0].lang, 'html', 'block 0 lang');
    assertEq(blocks[1].filename, 'src/App.jsx', 'block 1 filename with path');
    assertEq(blocks[1].lang, 'jsx', 'block 1 lang');
    assert(blocks[1].content.includes('useState'), 'block 1 content has useState');
    assertEq(blocks[2].filename, 'src/styles.css', 'block 2 filename');
    assertEq(blocks[2].lang, 'css', 'block 2 lang');
  }

  // -------- 3. Filename from first-line comment --------
  console.log('\n[3] Filename from first-line comment');
  {
    const md = `\`\`\`html
<!-- index.html -->
<!DOCTYPE html>
<html></html>
\`\`\`

\`\`\`javascript
// app.js
console.log('hi');
\`\`\`

\`\`\`python
# script.py
print('hello')
\`\`\``;
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 3, '3 blocks found');
    assertEq(blocks[0].filename, 'index.html', 'HTML comment filename');
    assertEq(blocks[1].filename, 'app.js', 'JS comment filename');
    assertEq(blocks[2].filename, 'script.py', 'Python comment filename');
  }

  // -------- 4. Filename from preceding markdown line --------
  console.log('\n[4] Filename from preceding markdown line');
  {
    const md = `Here are the files:

**index.html**
\`\`\`html
<html></html>
\`\`\`

**src/App.jsx**
\`\`\`jsx
export default function App() {}
\`\`\`

styles.css:
\`\`\`css
body { margin: 0; }
\`\`\``;
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 3, '3 blocks found');
    assertEq(blocks[0].filename, 'index.html', '** filename ** format');
    assertEq(blocks[1].filename, 'src/App.jsx', '** path/filename ** format');
    assertEq(blocks[2].filename, 'styles.css', 'filename: format');
  }

  // -------- 5. Fallback to lang-based default --------
  console.log('\n[5] Fallback to pickOutputFilename');
  {
    const md = '```python\nprint("no filename hint")\n```';
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 1, '1 block');
    assertEq(blocks[0].filename, 'script.py', 'falls back to script.py for python');
    assertEq(blocks[0].lang, 'python', 'lang detected');
  }

  // -------- 6. Tilde fences (~~~) --------
  console.log('\n[6] Tilde fences');
  {
    const md = '~~~js:index.js\nconsole.log("tilde");\n~~~';
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 1, '1 block with tilde fence');
    assertEq(blocks[0].filename, 'index.js', 'tilde fence filename');
    assertEq(blocks[0].content, 'console.log("tilde");', 'tilde fence content');
  }

  // -------- 7. No code blocks --------
  console.log('\n[7] No code blocks');
  {
    const md = 'This is just text, no code.';
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 0, 'returns 0 blocks for plain text');
  }

  // -------- 8. Empty/null input --------
  console.log('\n[8] Empty/null input');
  {
    assertEq(extractCodeBlocks('').length, 0, 'empty string → 0 blocks');
    assertEq(extractCodeBlocks(null).length, 0, 'null → 0 blocks');
    assertEq(extractCodeBlocks(undefined).length, 0, 'undefined → 0 blocks');
  }

  // -------- 9. Malformed (no closing fence) --------
  console.log('\n[9] Malformed — no closing fence');
  {
    const md = '```html\n<html>\n(no closing fence)';
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 0, 'malformed block is skipped');
  }

  // -------- 10. Mixed strategies in one response --------
  console.log('\n[10] Mixed filename strategies');
  {
    const md = `\`\`\`html:index.html
<html></html>
\`\`\`

**app.js**
\`\`\`javascript
// code
\`\`\`

\`\`\`css
/* styles.css */
body {}
\`\`\``;
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 3, '3 blocks with mixed strategies');
    assertEq(blocks[0].filename, 'index.html', 'strategy 1 (lang:path)');
    assertEq(blocks[1].filename, 'app.js', 'strategy 3 (preceding ** markdown)');
    assertEq(blocks[2].filename, 'styles.css', 'strategy 2 (first-line comment)');
  }

  // -------- 11. pickOutputFilename coverage --------
  console.log('\n[11] pickOutputFilename coverage');
  {
    assertEq(pickOutputFilename('html'), 'index.html', 'html → index.html');
    assertEq(pickOutputFilename('js'), 'script.js', 'js → script.js');
    assertEq(pickOutputFilename('jsx'), 'script.js', 'jsx → script.js');
    assertEq(pickOutputFilename('ts'), 'script.ts', 'ts → script.ts');
    assertEq(pickOutputFilename('tsx'), 'script.ts', 'tsx → script.ts');
    assertEq(pickOutputFilename('css'), 'style.css', 'css → style.css');
    assertEq(pickOutputFilename('json'), 'data.json', 'json → data.json');
    assertEq(pickOutputFilename('py'), 'script.py', 'py → script.py');
    assertEq(pickOutputFilename('md'), 'output.md', 'md → output.md');
    assertEq(pickOutputFilename('sh'), 'script.sh', 'sh → script.sh');
    assertEq(pickOutputFilename('unknown'), 'output.txt', 'unknown → output.txt');
    assertEq(pickOutputFilename(''), 'output.txt', 'empty → output.txt');
  }

  // -------- 12. extractFilenameFromComment coverage --------
  console.log('\n[12] extractFilenameFromComment coverage');
  {
    assertEq(extractFilenameFromComment('<!-- index.html -->'), 'index.html', 'HTML comment');
    assertEq(extractFilenameFromComment('// app.js'), 'app.js', 'JS comment');
    assertEq(extractFilenameFromComment('/* styles.css */'), 'styles.css', 'CSS block comment');
    assertEq(extractFilenameFromComment('# script.py'), 'script.py', 'Python comment');
    assertEq(extractFilenameFromComment('-- query.sql'), 'query.sql', 'SQL comment');
    assertEq(extractFilenameFromComment('not a comment'), '', 'non-comment returns empty');
    assertEq(extractFilenameFromComment(''), '', 'empty returns empty');
  }

  // -------- 13. extractFilenameFromPrecedingLine coverage --------
  console.log('\n[13] extractFilenameFromPrecedingLine coverage');
  {
    assertEq(extractFilenameFromPrecedingLine('**index.html**'), 'index.html', '** filename **');
    assertEq(extractFilenameFromPrecedingLine('**src/App.jsx**'), 'src/App.jsx', '** path/filename **');
    assertEq(extractFilenameFromPrecedingLine('index.html:'), 'index.html', 'filename:');
    assertEq(extractFilenameFromPrecedingLine('### config.json'), 'config.json', '### filename');
    assertEq(extractFilenameFromPrecedingLine('Here is app.js:'), 'app.js', 'sentence with filename:');
    assertEq(extractFilenameFromPrecedingLine('no filename here'), '', 'no filename returns empty');
    assertEq(extractFilenameFromPrecedingLine(''), '', 'empty returns empty');
  }

  // -------- 14. Nested paths in lang tag --------
  console.log('\n[14] Nested paths in lang tag');
  {
    const md = '```tsx:src/components/Counter.tsx\nexport function Counter() {}\n```';
    const blocks = extractCodeBlocks(md);
    assert(blocks.length === 1, '1 block');
    assertEq(blocks[0].filename, 'src/components/Counter.tsx', 'deeply nested path preserved');
    assertEq(blocks[0].lang, 'tsx', 'lang correct');
  }

  // -------- 15. Content preservation (whitespace, newlines) --------
  console.log('\n[15] Content preservation');
  {
    const md = '```js\nfunction foo() {\n  return 42;\n}\n```';
    const blocks = extractCodeBlocks(md);
    assert(blocks[0].content === 'function foo() {\n  return 42;\n}', 'internal newlines preserved');
    assert(!blocks[0].content.endsWith('\n'), 'trailing whitespace stripped');
  }

  console.log(`\n--- Results: ${pass} passed, ${fail} failed ---`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
