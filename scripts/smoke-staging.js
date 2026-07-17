'use strict';

/**
 * Smoke test for staging.js — verifies the module loads, exposes the
 * documented API, and the basic propose → resolve → write flow works.
 *
 * Run: node /home/z/my-project/repos/kovix-mvp/scripts/smoke-staging.js
 *
 * This test does NOT touch real disk writes — it uses a temp dir and
 * verifies backup files are created.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const { staging, StagingManager, STAGING_CHANNELS, AUTO_MODES } = require('../staging.js');

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
  console.log('--- staging.js smoke test ---\n');

  // 1. Module exports
  console.log('[1] Module exports');
  assert(typeof staging === 'object', 'staging singleton is an object');
  assert(staging instanceof StagingManager, 'staging is StagingManager instance');
  assert(STAGING_CHANNELS.PROPOSE === 'staging:propose', 'PROPOSE channel name');
  assert(STAGING_CHANNELS.QUEUE_UPDATE === 'staging:queue-update', 'QUEUE_UPDATE channel name');
  assert(Array.isArray(AUTO_MODES) && AUTO_MODES.length === 3, 'AUTO_MODES has 3 entries');
  assert(AUTO_MODES.includes('manual') && AUTO_MODES.includes('accept-all') && AUTO_MODES.includes('reject-all'), 'AUTO_MODES values');

  // 2. Init validation
  console.log('\n[2] Init validation');
  let initErr = null;
  try {
    const s = new StagingManager();
    s.init({ getWorkspace: null, sendToRenderer: () => {} });
  } catch (e) { initErr = e; }
  assert(initErr && /getWorkspace must be a function/.test(initErr.message), 'init rejects missing getWorkspace');

  initErr = null;
  try {
    const s = new StagingManager();
    s.init({ getWorkspace: () => '', sendToRenderer: null });
  } catch (e) { initErr = e; }
  assert(initErr && /sendToRenderer must be a function/.test(initErr.message), 'init rejects missing sendToRenderer');

  // 3. propose() before init fails
  console.log('\n[3] propose() before init fails');
  const freshManager = new StagingManager();
  let proposeErr = null;
  try {
    await freshManager.propose('foo.txt', 'bar', 'test');
  } catch (e) { proposeErr = e; }
  assert(proposeErr && /not initialized/i.test(proposeErr.message), 'propose before init throws');

  // 4. End-to-end propose → accept → file written + backup created
  console.log('\n[4] End-to-end: propose → accept → write + backup');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kovix-staging-test-'));
  console.log(`    tmpDir: ${tmpDir}`);

  const eventsReceived = [];
  const testManager = new StagingManager();
  testManager.init({
    getWorkspace: () => tmpDir,
    sendToRenderer: (channel, payload) => {
      eventsReceived.push({ channel, payload });
    },
  });

  // Pre-create an existing file so we can verify backup
  const existingPath = path.join(tmpDir, 'existing.txt');
  await fsp.writeFile(existingPath, 'OLD CONTENT\nline 2\n', 'utf8');

  // Start propose — it will return a Promise that doesn't resolve yet
  const proposePromise = testManager.propose('existing.txt', 'NEW CONTENT\nline 2\nline 3\n', 'execute');

  // Give the event loop a tick to fire propose events
  await new Promise((r) => setTimeout(r, 50));

  // Verify a propose event was fired
  const proposeEvent = eventsReceived.find((e) => e.channel === 'staging:propose');
  assert(!!proposeEvent, 'propose event was emitted');
  assert(proposeEvent && proposeEvent.payload.proposal.isCreate === false, 'isCreate=false for existing file');
  assert(proposeEvent && proposeEvent.payload.proposal.oldContent === 'OLD CONTENT\nline 2\n', 'oldContent read correctly');
  assert(proposeEvent && proposeEvent.payload.proposal.newContent === 'NEW CONTENT\nline 2\nline 3\n', 'newContent passed through');

  // Verify queue state
  const queueState = testManager.getQueue();
  assert(queueState.pendingCount === 1, 'pendingCount=1 after propose');
  assert(queueState.resolvedCount === 0, 'resolvedCount=0 after propose');
  assert(queueState.autoMode === 'manual', 'autoMode=manual by default');

  // Now resolve with accept
  const result = await testManager.resolve({ action: 'accept' });
  assert(result.ok === true, 'resolve returns ok=true');
  assert(result.result.action === 'accept', 'resolve result.action=accept');

  // The propose Promise should now resolve
  const proposeResult = await proposePromise;
  assert(proposeResult.action === 'accept', 'propose Promise resolved with action=accept');
  assert(proposeResult.finalContent === 'NEW CONTENT\nline 2\nline 3\n', 'propose Promise finalContent correct');

  // Verify the file was written
  const newContent = await fsp.readFile(existingPath, 'utf8');
  assert(newContent === 'NEW CONTENT\nline 2\nline 3\n', 'file was overwritten with new content');

  // Verify a backup was created
  const backupsDir = path.join(tmpDir, '.kovix', 'backups');
  const backupFiles = await fsp.readdir(backupsDir).catch(() => []);
  assert(backupFiles.length === 1, `exactly 1 backup file created (got ${backupFiles.length})`);
  assert(backupFiles[0] && backupFiles[0].startsWith('existing.txt.'), 'backup filename starts with original name');
  assert(backupFiles[0] && backupFiles[0].endsWith('.bak'), 'backup filename ends with .bak');

  // Verify backup content
  const backupContent = await fsp.readFile(path.join(backupsDir, backupFiles[0]), 'utf8');
  assert(backupContent === 'OLD CONTENT\nline 2\n', 'backup contains old content');

  // 5. Test NEW file (no backup)
  console.log('\n[5] New file creation (no backup)');
  const createPromise = testManager.propose('newfile.txt', 'fresh content', 'write_file');
  await new Promise((r) => setTimeout(r, 30));
  const createResult = await testManager.resolve({ action: 'accept' });
  await createPromise;
  const newFileExists = fs.existsSync(path.join(tmpDir, 'newfile.txt'));
  assert(newFileExists, 'new file was created');
  const backupsAfterCreate = await fsp.readdir(backupsDir);
  assert(backupsAfterCreate.length === 1, 'no new backup for new file (still 1 total)');

  // 6. Test reject
  console.log('\n[6] Reject path');
  const rejectPromise = testManager.propose('rejected.txt', 'should not write', 'execute');
  await new Promise((r) => setTimeout(r, 30));
  const rejectResult = await testManager.resolve({ action: 'reject', reason: 'I do not like this code' });
  assert(rejectResult.ok === true, 'reject returns ok=true');
  const rejectResolve = await rejectPromise;
  assert(rejectResolve.action === 'reject', 'reject promise resolves with action=reject');
  assert(rejectResolve.reason === 'I do not like this code', 'reject reason passed through');
  const rejectedFileExists = fs.existsSync(path.join(tmpDir, 'rejected.txt'));
  assert(rejectedFileExists === false, 'rejected file was NOT written to disk');

  // 7. Test modify
  console.log('\n[7] Modify path');
  const modifyPath = path.join(tmpDir, 'modify-me.txt');
  await fsp.writeFile(modifyPath, 'ORIGINAL', 'utf8');
  const modifyPromise = testManager.propose('modify-me.txt', 'PROPOSED', 'write_file');
  await new Promise((r) => setTimeout(r, 30));
  const modifyResult = await testManager.resolve({ action: 'modify', finalContent: 'USER-EDITED' });
  assert(modifyResult.ok === true, 'modify returns ok=true');
  await modifyPromise;
  const modifiedContent = await fsp.readFile(modifyPath, 'utf8');
  assert(modifiedContent === 'USER-EDITED', 'file contains user-edited content (not proposed)');

  // 8. Test accept-all auto-mode
  console.log('\n[8] Accept All auto-mode');
  testManager.setAutoMode('accept-all');
  const autoAccept = await testManager.propose('auto-accept.txt', 'auto content', 'execute');
  assert(autoAccept.action === 'accept', 'accept-all short-circuits with accept');
  const autoFileExists = fs.existsSync(path.join(tmpDir, 'auto-accept.txt'));
  assert(autoFileExists, 'auto-accepted file was written');

  // 9. Test reject-all auto-mode
  console.log('\n[9] Reject All auto-mode');
  testManager.setAutoMode('reject-all', 'Skipping the rest');
  const autoReject = await testManager.propose('auto-reject.txt', 'wont write', 'execute');
  assert(autoReject.action === 'reject', 'reject-all short-circuits with reject');
  assert(autoReject.reason === 'Skipping the rest', 'reject-all reason passed through');
  const autoRejectExists = fs.existsSync(path.join(tmpDir, 'auto-reject.txt'));
  assert(autoRejectExists === false, 'auto-rejected file was NOT written');

  // 10. Test reset clears pending
  console.log('\n[10] Reset clears pending');
  testManager.setAutoMode('manual');
  const pendingPromise = testManager.propose('pending.txt', 'content', 'execute');
  await new Promise((r) => setTimeout(r, 30));
  testManager.reset();
  const resetResult = await pendingPromise;
  assert(resetResult.action === 'reject', 'reset resolves pending with reject');
  assert(/Staging was reset/.test(resetResult.reason), 'reset reason is descriptive');
  const pendingExists = fs.existsSync(path.join(tmpDir, 'pending.txt'));
  assert(pendingExists === false, 'pending file was NOT written after reset');

  // 11. Test workspace boundary check
  console.log('\n[11] Workspace boundary check');
  let boundaryErr = null;
  try {
    await testManager.propose('/tmp/should-fail.txt', 'content', 'execute');
  } catch (e) { boundaryErr = e; }
  assert(boundaryErr && /OUTSIDE the workspace/i.test(boundaryErr.message), 'propose outside workspace throws');

  // Cleanup
  await fsp.rm(tmpDir, { recursive: true, force: true });

  console.log(`\n--- Results: ${pass} passed, ${fail} failed ---`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
