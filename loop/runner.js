/**
 * runner.js — Apply Phase (Execute & Qualify)
 *
 * The heart of the self-healing engine. For each task in the plan:
 *
 *   1. EXECUTE  — Write the code to the target file
 *   2. VERIFY   — Run the task's verification command
 *   3. QUALIFY  — Check exit code against the linked Acceptance Criteria
 *   4. FIX      — If verification fails:
 *       a. Classify the failure (Code / Spec / Intent)
 *       b. For "Code" issues: send error context + file boundaries to LLM,
 *          get a patch, apply it, re-run verification
 *       c. Auto-retry up to maxRetries (default 3) before declaring BLOCKED
 *
 * Emits events via the onEvent callback so the UI can show live progress.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const state = require('./state');

// ─── Failure Classification ─────────────────────────────────────
const FAILURE_TYPES = {
  CODE: 'code',     // Plan was right, code just needs a fix
  SPEC: 'spec',     // The plan was wrong
  INTENT: 'intent', // Requires plan adjustment
};

function classifyFailure(stderr, task) {
  // Simple heuristic classification for the MVP:
  // - Syntax/parse errors → CODE
  // - "not found" / module errors → CODE
  // - Logic mismatches against AC → SPEC
  // - Anything ambiguous → CODE (safest default for auto-fix)
  const codeSignals = ['SyntaxError', 'ReferenceError', 'TypeError', 'Cannot find module',
    'ENOENT', 'Unexpected token', 'is not defined', 'is not a function'];
  const lower = (stderr || '').toLowerCase();
  for (const sig of codeSignals) {
    if (lower.includes(sig.toLowerCase())) return FAILURE_TYPES.CODE;
  }
  return FAILURE_TYPES.CODE; // Default to code — let the fix agent try
}

// ─── File Writer ────────────────────────────────────────────────
function writeTaskFiles(rootDir, task) {
  // Ensure output/ directory exists
  const outputDir = path.join(rootDir, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write the action content to each target file
  for (const filePath of task.files) {
    const fullPath = path.join(rootDir, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, task.action, 'utf-8');
  }
}

// ─── Verification Runner ────────────────────────────────────────
function runVerification(rootDir, task) {
  try {
    const result = execSync(task.verification, {
      cwd: rootDir,
      timeout: 15000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, stdout: result, stderr: '' };
  } catch (err) {
    return {
      passed: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}

// ─── Corrective LLM Prompt ──────────────────────────────────────
const FIX_SYSTEM_PROMPT = `You are a code-fixing agent. You will receive:
1. The ORIGINAL TASK description
2. The CURRENT FILE CONTENTS
3. The VERIFICATION COMMAND that failed
4. The ERROR OUTPUT

You must output ONLY the corrected file content — no markdown, no fences, no explanation.
Just the raw file content that will replace the current file. Fix the exact error. Do not rewrite from scratch.`;

async function requestFix(openaiClient, model, rootDir, task, verifyResult) {
  // Read current file contents
  const fileContents = {};
  for (const filePath of task.files) {
    const fullPath = path.join(rootDir, filePath);
    if (fs.existsSync(fullPath)) {
      fileContents[filePath] = fs.readFileSync(fullPath, 'utf-8');
    }
  }

  const userMessage = `TASK: ${task.title}
ACTION: ${task.action}
VERIFICATION COMMAND: ${task.verification}
ERROR OUTPUT:
${verifyResult.stderr}

CURRENT FILE CONTENTS:
${JSON.stringify(fileContents, null, 2)}

Output the corrected file content. ONLY the code, no markdown fences.`;

  const response = await openaiClient.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: FIX_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.2,
    max_tokens: 4096,
  });

  let fixedContent = response.choices[0].message.content.trim();
  // Strip fences if LLM added them
  if (fixedContent.startsWith('```')) {
    fixedContent = fixedContent.replace(/^```(?:[a-zA-Z0-9+-]*)\n?/, '').replace(/\n?```$/, '');
  }

  return fixedContent;
}

// ─── Apply Fix ──────────────────────────────────────────────────
function applyFix(rootDir, task, fixedContent) {
  // Write the fixed content to the first (primary) file
  if (task.files.length > 0) {
    const fullPath = path.join(rootDir, task.files[0]);
    fs.writeFileSync(fullPath, fixedContent, 'utf-8');
  }
}

// ─── Execute Single Task ────────────────────────────────────────
async function executeTask(openaiClient, model, rootDir, task, onEvent) {
  onEvent({
    type: 'task:start',
    taskId: task.id,
    title: task.title,
    phase: 'apply',
  });

  // Step 1: EXECUTE — Write the code
  onEvent({ type: 'task:writing', taskId: task.id });
  writeTaskFiles(rootDir, task);
  onEvent({ type: 'task:written', taskId: task.id, files: task.files });

  // Step 2: VERIFY
  onEvent({ type: 'task:verifying', taskId: task.id, command: task.verification });
  let verifyResult = runVerification(rootDir, task);

  if (verifyResult.passed) {
    onEvent({ type: 'task:passed', taskId: task.id });
    task.status = 'passed';
    return task;
  }

  // Step 3: FAILED → Auto-fix loop
  onEvent({ type: 'task:failed', taskId: task.id, stderr: verifyResult.stderr });

  while (task.retries < task.maxRetries) {
    task.retries++;
    const failureType = classifyFailure(verifyResult.stderr, task);

    onEvent({
      type: 'task:fixing',
      taskId: task.id,
      retry: task.retries,
      maxRetries: task.maxRetries,
      failureType,
    });

    if (failureType === FAILURE_TYPES.CODE) {
      // Request a fix from the LLM
      try {
        const fixedContent = await requestFix(openaiClient, model, rootDir, task, verifyResult);
        applyFix(rootDir, task, fixedContent);
        onEvent({ type: 'task:fix-applied', taskId: task.id, retry: task.retries });

        // Re-verify
        verifyResult = runVerification(rootDir, task);
        if (verifyResult.passed) {
          onEvent({ type: 'task:passed', taskId: task.id, retries: task.retries });
          task.status = 'passed';
          return task;
        }

        onEvent({ type: 'task:still-failing', taskId: task.id, retry: task.retries, stderr: verifyResult.stderr });
      } catch (fixErr) {
        onEvent({ type: 'task:fix-error', taskId: task.id, error: fixErr.message });
      }
    } else {
      // SPEC or INTENT failure — can't auto-fix, bail out
      onEvent({ type: 'task:unfixable', taskId: task.id, failureType });
      break;
    }
  }

  // Exhausted retries
  task.status = 'blocked';
  onEvent({ type: 'task:blocked', taskId: task.id, retries: task.retries });
  return task;
}

// ─── Run All Tasks ──────────────────────────────────────────────
async function runAllTasks(openaiClient, model, rootDir, plan, onEvent) {
  const results = [];

  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];

    // Update state
    const s = state.loadState(rootDir);
    s.currentTaskIndex = i;
    state.saveState(rootDir, s);

    const result = await executeTask(openaiClient, model, rootDir, task, onEvent);
    results.push(result);

    // If a task is blocked, stop the whole loop
    if (result.status === 'blocked') {
      const s2 = state.loadState(rootDir);
      s2.phase = 'blocked';
      s2.error = `Task ${task.id} blocked after ${task.retries} retries`;
      state.saveState(rootDir, s2);
      break;
    }
  }

  // Update the plan on disk with final statuses
  state.savePlan(rootDir, plan);

  return results;
}

module.exports = {
  runAllTasks,
  executeTask,
  classifyFailure,
  FAILURE_TYPES,
};
