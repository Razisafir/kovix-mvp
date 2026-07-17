'use strict';

/**
 * Integration smoke test for Task Gamma — verifies that:
 *
 * 1. tools.js `write_file` routes through staging.propose() and correctly
 *    translates accept / modify / reject results into tool result strings.
 * 2. tools.js still works (falls back to direct write) if staging is not
 *    initialized — this protects standalone unit tests.
 * 3. The Execute step in main.js cannot be unit-tested without launching
 *    Electron, but we verify staging.propose() integration indirectly by
 *    confirming the staging module + tools module compose correctly.
 *
 * Run: node /home/z/my-project/repos/kovix-mvp/scripts/smoke-gamma.js
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

// We need to load tools.js fresh for each test scenario so we can swap
// the staging singleton. Use require cache manipulation.
const STAGING_PATH = require.resolve('../staging.js');
const TOOLS_PATH = require.resolve('../tools.js');

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

async function main() {
  console.log('--- Task Gamma integration smoke test ---\n');

  // -------- Scenario 1: write_file with ACCEPT --------
  console.log('[1] write_file with staging ACCEPT');
  await withMockStaging({ action: 'accept', finalContent: 'PROPOSED' }, async () => {
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    const result = await executeTool('write_file', {
      path: 'foo.js',
      content: 'PROPOSED',
    }, tmpDir);
    assert(result.ok === true, 'write_file returns ok=true on accept');
    assert(/ACCEPTED/.test(result.result), 'result mentions ACCEPTED');
    assert(/foo\.js/.test(result.result), 'result mentions filename');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------- Scenario 2: write_file with MODIFY --------
  console.log('\n[2] write_file with staging MODIFY');
  await withMockStaging({ action: 'modify', finalContent: 'USER-EDITED' }, async () => {
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    const result = await executeTool('write_file', {
      path: 'bar.js',
      content: 'PROPOSED',
    }, tmpDir);
    assert(result.ok === true, 'write_file returns ok=true on modify');
    assert(/MODIFIED/.test(result.result), 'result mentions MODIFIED');
    assert(/edited: 11 chars/.test(result.result), 'result reports edited char count');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------- Scenario 3: write_file with REJECT (reason fed back) --------
  console.log('\n[3] write_file with staging REJECT (reason propagation)');
  await withMockStaging({
    action: 'reject',
    finalContent: 'PROPOSED',
    reason: 'I do not like this code',
  }, async () => {
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    const result = await executeTool('write_file', {
      path: 'baz.js',
      content: 'PROPOSED',
    }, tmpDir);
    assert(result.ok === false, 'write_file returns ok=false on reject');
    assert(/REJECTED/.test(result.error), 'error mentions REJECTED');
    assert(/I do not like this code/.test(result.error), 'error includes user reason verbatim');
    assert(/Revise your approach/.test(result.error), 'error prompts LLM to revise');

    // Verify the file was NOT written
    const fileExists = fs.existsSync(path.join(tmpDir, 'baz.js'));
    assert(fileExists === false, 'file was NOT written to disk on reject');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------- Scenario 4: write_file with staging NOT initialized (fallback) --------
  console.log('\n[4] write_file fallback when staging not initialized');
  await withNoStaging(async () => {
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    const result = await executeTool('write_file', {
      path: 'fallback.txt',
      content: 'FALLBACK',
    }, tmpDir);
    assert(result.ok === true, 'fallback write succeeds');
    assert(/direct, no staging/.test(result.result), 'result notes fallback mode');
    const fileContent = await fsp.readFile(path.join(tmpDir, 'fallback.txt'), 'utf8');
    assert(fileContent === 'FALLBACK', 'file was actually written in fallback mode');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------- Scenario 5: staging.propose is called with correct source --------
  console.log('\n[5] staging.propose receives correct source="write_file"');
  let capturedSource = null;
  await withMockStaging({ action: 'accept', finalContent: 'X' }, async () => {
    const { staging } = require(STAGING_PATH);
    const origPropose = staging.propose.bind(staging);
    staging.propose = async (relPath, content, source) => {
      capturedSource = source;
      return { action: 'accept', finalContent: content };
    };
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    await executeTool('write_file', { path: 'src.js', content: 'X' }, tmpDir);
    staging.propose = origPropose;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
  assert(capturedSource === 'write_file', `source is "write_file" (got: ${capturedSource})`);

  // -------- Scenario 6: staging.propose receives correct relative path --------
  console.log('\n[6] staging.propose receives relative path (not absolute)');
  let capturedPath = null;
  await withMockStaging({ action: 'accept', finalContent: 'X' }, async () => {
    const { staging } = require(STAGING_PATH);
    const origPropose = staging.propose.bind(staging);
    staging.propose = async (relPath, content, source) => {
      capturedPath = relPath;
      return { action: 'accept', finalContent: content };
    };
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    await executeTool('write_file', { path: 'nested/dir/file.js', content: 'X' }, tmpDir);
    staging.propose = origPropose;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
  assert(capturedPath === 'nested/dir/file.js', `relative path preserved (got: ${capturedPath})`);

  // -------- Scenario 7: read_file still works (unchanged) --------
  console.log('\n[7] read_file tool unchanged by Gamma refactor');
  await withMockStaging({ action: 'accept', finalContent: 'X' }, async () => {
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    await fsp.writeFile(path.join(tmpDir, 'readme.md'), '# Hello', 'utf8');
    const result = await executeTool('read_file', { path: 'readme.md' }, tmpDir);
    assert(result.ok === true, 'read_file returns ok=true');
    assert(result.result === '# Hello', 'read_file returns correct content');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------- Scenario 8: other tools (list_directory) still work --------
  console.log('\n[8] list_directory tool unchanged by Gamma refactor');
  await withMockStaging({ action: 'accept', finalContent: 'X' }, async () => {
    const { executeTool } = require(TOOLS_PATH);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-gamma-'));
    await fsp.writeFile(path.join(tmpDir, 'a.txt'), 'a', 'utf8');
    await fsp.writeFile(path.join(tmpDir, 'b.txt'), 'b', 'utf8');
    const result = await executeTool('list_directory', { path: '.' }, tmpDir);
    assert(result.ok === true, 'list_directory returns ok=true');
    assert(/a\.txt/.test(result.result), 'list_directory shows a.txt');
    assert(/b\.txt/.test(result.result), 'list_directory shows b.txt');
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  console.log(`\n--- Results: ${pass} passed, ${fail} failed ---`);
  process.exit(fail > 0 ? 1 : 0);
}

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Replace the staging singleton with a mock that resolves propose() with
 * the given result. Restores the original after the callback completes.
 */
async function withMockStaging(mockResult, cb) {
  // Clear require cache so tools.js re-evaluates and picks up the new staging
  delete require.cache[TOOLS_PATH];
  delete require.cache[STAGING_PATH];

  // Load fresh staging singleton
  const { staging } = require(STAGING_PATH);

  // Save original methods
  const origPropose = staging.propose;
  const origInit = staging.init;
  const origIsInit = staging.isInitialized;

  // Stub init (no-op), isInitialized (true), and propose (returns mockResult)
  staging._initialized = true;
  staging.init = () => {};
  staging.isInitialized = () => true;
  staging.propose = async () => mockResult;

  try {
    await cb();
  } finally {
    staging.propose = origPropose;
    staging.init = origInit;
    staging.isInitialized = origIsInit;
    staging._initialized = false;
    // Clear cache again so subsequent tests get a fresh require
    delete require.cache[TOOLS_PATH];
    delete require.cache[STAGING_PATH];
  }
}

/**
 * Simulate staging NOT being initialized — isInitialized() returns false.
 * tools.js should fall back to direct write.
 */
async function withNoStaging(cb) {
  delete require.cache[TOOLS_PATH];
  delete require.cache[STAGING_PATH];

  const { staging } = require(STAGING_PATH);

  // Save original
  const origPropose = staging.propose;
  const origInit = staging.init;
  const origIsInit = staging.isInitialized;

  // Make staging report as uninitialized
  staging._initialized = false;
  staging.init = () => {};
  staging.isInitialized = () => false;
  staging.propose = async () => {
    throw new Error('StagingManager not initialized. Call init() first.');
  };

  try {
    await cb();
  } finally {
    staging.propose = origPropose;
    staging.init = origInit;
    staging.isInitialized = origIsInit;
    staging._initialized = true;
    delete require.cache[TOOLS_PATH];
    delete require.cache[STAGING_PATH];
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
