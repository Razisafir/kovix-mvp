/**
 * state.js — Local .kovix/ state management
 *
 * Manages the .kovix/ directory in the project root:
 *   .kovix/
 *     state.json   — current phase, task index, retry counts
 *     plan.json    — the active Plan payload
 *     log.md       — append-only execution log
 *
 * All reads/writes are synchronous for simplicity in the MVP.
 */

const fs = require('fs');
const path = require('path');

const KOVIX_DIR = '.kovix';
const STATE_FILE = 'state.json';
const PLAN_FILE = 'plan.json';
const LOG_FILE = 'log.md';

// ─── Default state shape ────────────────────────────────────────
function defaultState() {
  return {
    phase: 'idle',          // idle | plan | apply | unify | blocked | complete
    planId: null,
    currentTaskIndex: 0,
    totalTasks: 0,
    retryCount: 0,
    maxRetries: 3,
    startedAt: null,
    updatedAt: null,
    error: null,
  };
}

// ─── Directory bootstrap ────────────────────────────────────────
function ensureDir(rootDir) {
  const kovixPath = path.join(rootDir, KOVIX_DIR);
  if (!fs.existsSync(kovixPath)) {
    fs.mkdirSync(kovixPath, { recursive: true });
  }
  // Add .kovix/ to .gitignore if not already there
  const gitignorePath = path.join(rootDir, '.gitignore');
  let gitignore = '';
  if (fs.existsSync(gitignorePath)) {
    gitignore = fs.readFileSync(gitignorePath, 'utf-8');
  }
  if (!gitignore.includes('.kovix')) {
    gitignore += (gitignore.endsWith('\n') ? '' : '\n') + '.kovix/\n';
    fs.writeFileSync(gitignorePath, gitignore, 'utf-8');
  }
  return kovixPath;
}

// ─── State CRUD ─────────────────────────────────────────────────
function loadState(rootDir) {
  const filePath = path.join(rootDir, KOVIX_DIR, STATE_FILE);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return defaultState();
}

function saveState(rootDir, state) {
  ensureDir(rootDir);
  state.updatedAt = new Date().toISOString();
  const filePath = path.join(rootDir, KOVIX_DIR, STATE_FILE);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

function resetState(rootDir) {
  return saveState(rootDir, defaultState());
}

// ─── Plan CRUD ──────────────────────────────────────────────────
function loadPlan(rootDir) {
  const filePath = path.join(rootDir, KOVIX_DIR, PLAN_FILE);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

function savePlan(rootDir, plan) {
  ensureDir(rootDir);
  const filePath = path.join(rootDir, KOVIX_DIR, PLAN_FILE);
  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
  return plan;
}

// ─── Append-only log ────────────────────────────────────────────
function appendLog(rootDir, entry) {
  ensureDir(rootDir);
  const filePath = path.join(rootDir, KOVIX_DIR, LOG_FILE);
  const timestamp = new Date().toISOString().slice(11, 19);
  const line = `**${timestamp}** ${entry}\n\n`;
  fs.appendFileSync(filePath, line, 'utf-8');
}

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
  defaultState,
  ensureDir,
  loadState,
  saveState,
  resetState,
  loadPlan,
  savePlan,
  appendLog,
};
