/**
 * engine.js — The 3-Phase Loop Orchestrator
 *
 * PAUL's heartbeat adapted for Kovix: Plan → Apply → Unify
 *
 * This is the single entry point for the "Self-Healing Milestone Loop."
 * It wires together:
 *   - planner.js  (Plan phase)
 *   - runner.js   (Apply phase — execute/qualify/auto-fix)
 *   - unifier.js  (Unify phase — reconcile/commit)
 *
 * It emits a stream of events via the onEvent callback so the
 * renderer process can display real-time loop progress.
 *
 * Usage:
 *   const engine = require('./loop/engine');
 *   engine.run(client, model, rootDir, userIdea, history, onEvent);
 */

const state = require('./state');
const planner = require('./planner');
const runner = require('./runner');
const unifier = require('./unifier');

/**
 * Run the full Plan → Apply → Unify loop.
 *
 * @param {object}   openaiClient — Initialized OpenAI client
 * @param {string}   model        — Model string (e.g. 'gpt-4o-mini')
 * @param {string}   rootDir      — Project root directory
 * @param {string}   userIdea     — The user's raw idea text
 * @param {Array}    history      — Conversation history for context
 * @param {function} onEvent      — Callback(eventObj) for UI updates
 * @returns {object} Final result with phase, plan, summary
 */
async function run(openaiClient, model, rootDir, userIdea, history, onEvent) {
  // ─── Bootstrap state ──────────────────────────────────────────
  const s = state.loadState(rootDir);
  s.phase = 'plan';
  s.startedAt = new Date().toISOString();
  s.error = null;
  state.saveState(rootDir, s);
  state.appendLog(rootDir, `Loop started for idea: "${userIdea.slice(0, 100)}"`);

  onEvent({ type: 'loop:start', idea: userIdea });

  let plan;
  let taskResults;

  try {
    // ═══════════════════════════════════════════════════════════
    // PHASE 1: PLAN
    // ═══════════════════════════════════════════════════════════
    onEvent({ type: 'phase:start', phase: 'plan' });
    state.appendLog(rootDir, '## PLAN phase started');

    plan = await planner.generatePlan(
      openaiClient, model, rootDir, userIdea, history, onEvent
    );

    // Update state
    const s1 = state.loadState(rootDir);
    s1.phase = 'apply';
    s1.planId = plan.id;
    s1.totalTasks = plan.tasks.length;
    s1.currentTaskIndex = 0;
    state.saveState(rootDir, s1);

    onEvent({
      type: 'phase:complete',
      phase: 'plan',
      plan,
      taskCount: plan.tasks.length,
      acCount: plan.acceptanceCriteria.length,
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: APPLY (Execute & Qualify)
    // ═══════════════════════════════════════════════════════════
    onEvent({ type: 'phase:start', phase: 'apply' });
    state.appendLog(rootDir, '## APPLY phase started');

    taskResults = await runner.runAllTasks(
      openaiClient, model, rootDir, plan, onEvent
    );

    // Check if we're blocked
    const blocked = taskResults.some(t => t.status === 'blocked');
    if (blocked) {
      const s2 = state.loadState(rootDir);
      s2.phase = 'blocked';
      s2.error = 'One or more tasks are blocked';
      state.saveState(rootDir, s2);

      onEvent({
        type: 'phase:blocked',
        phase: 'apply',
        blockedTasks: taskResults.filter(t => t.status === 'blocked'),
      });

      // Still run unify for partial reconciliation
    }

    onEvent({
      type: 'phase:complete',
      phase: 'apply',
      results: taskResults,
      passed: taskResults.filter(t => t.status === 'passed').length,
      blocked: taskResults.filter(t => t.status === 'blocked').length,
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: UNIFY (Reconcile & Commit)
    // ═══════════════════════════════════════════════════════════
    onEvent({ type: 'phase:start', phase: 'unify' });
    state.appendLog(rootDir, '## UNIFY phase started');

    const unifyResult = unifier.unify(rootDir, plan, taskResults, onEvent);

    onEvent({
      type: 'phase:complete',
      phase: 'unify',
      summary: unifyResult.summary,
      committed: unifyResult.commitResult.success,
    });

    // ═══════════════════════════════════════════════════════════
    // DONE
    // ═══════════════════════════════════════════════════════════
    onEvent({ type: 'loop:done', finalPhase: unifyResult.finalPhase });

    return {
      plan,
      taskResults,
      unifyResult,
      finalPhase: unifyResult.finalPhase,
    };

  } catch (err) {
    // Global error handler — any unhandled exception in the loop
    const sErr = state.loadState(rootDir);
    sErr.phase = 'blocked';
    sErr.error = err.message || String(err);
    state.saveState(rootDir, sErr);
    state.appendLog(rootDir, `⚠ LOOP ERROR: ${err.message}`);

    onEvent({ type: 'loop:error', error: err.message, stack: err.stack });

    return {
      plan: plan || null,
      taskResults: taskResults || [],
      unifyResult: null,
      finalPhase: 'blocked',
      error: err.message,
    };
  }
}

/**
 * Get the current loop state without running anything.
 */
function getStatus(rootDir) {
  const s = state.loadState(rootDir);
  const plan = state.loadPlan(rootDir);
  return { state: s, plan };
}

/**
 * Reset the loop to idle.
 */
function reset(rootDir) {
  state.resetState(rootDir);
  state.appendLog(rootDir, 'Loop reset to idle');
  return getStatus(rootDir);
}

module.exports = { run, getStatus, reset };
