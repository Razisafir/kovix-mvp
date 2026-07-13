/**
 * unifier.js — Unify Phase (Reconciliation)
 *
 * After all tasks pass verification, this module:
 *   1. Compares what was PLANNED against what ACTUALLY CHANGED
 *   2. Generates a structured markdown summary
 *   3. Stages a git commit with the reconciled changes
 *   4. Records any deferred issues
 *
 * This is the PAUL "Unify" adapted for automated, local-first use.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const state = require('./state');

// ─── File Diff (simple) ─────────────────────────────────────────
function getFileSnapshot(rootDir, filePaths) {
  const snapshot = {};
  for (const fp of filePaths) {
    const fullPath = path.join(rootDir, fp);
    if (fs.existsSync(fullPath)) {
      snapshot[fp] = {
        exists: true,
        size: fs.statSync(fullPath).size,
        modified: fs.statSync(fullPath).mtime.toISOString(),
      };
    } else {
      snapshot[fp] = { exists: false };
    }
  }
  return snapshot;
}

// ─── Generate Reconciliation Summary ────────────────────────────
function generateSummary(rootDir, plan, taskResults) {
  const lines = [];

  lines.push(`# Unify Report — ${plan.id}`);
  lines.push('');
  lines.push(`**Objective:** ${plan.objective}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  // Task outcomes
  lines.push('## Task Outcomes');
  lines.push('');
  const passed = taskResults.filter(t => t.status === 'passed');
  const blocked = taskResults.filter(t => t.status === 'blocked');

  for (const task of taskResults) {
    const icon = task.status === 'passed' ? '✓' : '✗';
    const retryNote = task.retries > 0 ? ` (${task.retries} fix retries)` : '';
    lines.push(`- ${icon} **${task.id}**: ${task.title}${retryNote}`);
    for (const fp of task.files) {
      lines.push(`  - File: \`${fp}\``);
    }
  }
  lines.push('');

  // Stats
  lines.push('## Summary Statistics');
  lines.push('');
  lines.push(`- Total tasks: ${taskResults.length}`);
  lines.push(`- Passed: ${passed.length}`);
  lines.push(`- Blocked: ${blocked.length}`);
  lines.push('');

  // Files changed
  lines.push('## Files Modified');
  lines.push('');
  const allFiles = [...new Set(taskResults.flatMap(t => t.files))];
  const snapshot = getFileSnapshot(rootDir, allFiles);
  for (const [fp, info] of Object.entries(snapshot)) {
    if (info.exists) {
      lines.push(`- \`${fp}\` — ${info.size} bytes, modified ${info.modified}`);
    } else {
      lines.push(`- \`${fp}\` — NOT FOUND`);
    }
  }
  lines.push('');

  // Deferred issues (blocked tasks)
  if (blocked.length > 0) {
    lines.push('## Deferred Issues');
    lines.push('');
    for (const task of blocked) {
      lines.push(`- **${task.id}** (${task.title}): Blocked after ${task.retries} retries. Manual intervention required.`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Git Operations ─────────────────────────────────────────────
function isGitRepo(rootDir) {
  return fs.existsSync(path.join(rootDir, '.git'));
}

function gitStageAndCommit(rootDir, plan, summary) {
  if (!isGitRepo(rootDir)) {
    return { success: false, error: 'Not a git repository' };
  }

  try {
    // Stage all output files
    execSync('git add output/ .kovix/', {
      cwd: rootDir,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write the summary to .kovix/unify-report.md
    const reportPath = path.join(rootDir, '.kovix', 'unify-report.md');
    fs.writeFileSync(reportPath, summary, 'utf-8');
    execSync('git add .kovix/unify-report.md', {
      cwd: rootDir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Commit
    const commitMsg = `kovix: complete plan ${plan.id} — ${plan.objective.slice(0, 60)}`;
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
      cwd: rootDir,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { success: true, commitMsg };
  } catch (err) {
    return { success: false, error: err.stderr || err.message };
  }
}

// ─── Main Unify Entry Point ─────────────────────────────────────
function unify(rootDir, plan, taskResults, onEvent) {
  onEvent({ type: 'unify:start', planId: plan.id });

  // Generate reconciliation summary
  const summary = generateSummary(rootDir, plan, taskResults);
  onEvent({ type: 'unify:summary', summary });

  // Append to log
  state.appendLog(rootDir, `## Unify — ${plan.id}\n${summary}`);

  // Auto-commit
  const commitResult = gitStageAndCommit(rootDir, plan, summary);

  if (commitResult.success) {
    onEvent({ type: 'unify:committed', commitMsg: commitResult.commitMsg });
  } else {
    onEvent({ type: 'unify:commit-skipped', reason: commitResult.error });
  }

  // Update state
  const s = state.loadState(rootDir);
  const allPassed = taskResults.every(t => t.status === 'passed');
  s.phase = allPassed ? 'complete' : 'blocked';
  s.updatedAt = new Date().toISOString();
  state.saveState(rootDir, s);

  onEvent({ type: 'unify:done', finalPhase: s.phase });

  return {
    summary,
    commitResult,
    finalPhase: s.phase,
  };
}

module.exports = { unify, generateSummary };
