/**
 * planner.js — Plan Phase
 *
 * Takes a user idea + conversation history and generates a strict,
 * machine-readable Plan JSON payload containing:
 *   - objective: what is being built and why
 *   - acceptanceCriteria: BDD Given/When/Then definitions of "done"
 *   - tasks: granular execution steps with files, actions, verification, linked AC
 *   - boundaries: hard limits on files/directories the agent must NOT touch
 *
 * The LLM is forced to output ONLY valid JSON via a tight system prompt.
 */

const state = require('./state');

// ─── Plan JSON Schema ───────────────────────────────────────────
// Example output the LLM must produce:
// {
//   "id": "plan-001",
//   "objective": "Build a browser-based todo list application",
//   "acceptanceCriteria": [
//     {
//       "id": "AC-1",
//       "given": "the app is loaded in a browser",
//       "when": "the user types a task and presses Enter",
//       "then": "the task appears in the task list"
//     }
//   ],
//   "tasks": [
//     {
//       "id": "T-1",
//       "title": "Create HTML with form and list",
//       "files": ["output/index.html"],
//       "action": "Create a single HTML file containing an input form and an empty unordered list",
//       "verification": "node -e \"const f=require('fs').readFileSync('output/index.html','utf8'); if(!f.includes('<form')||!f.includes('<ul')) throw new Error('missing form or list')\"",
//       "acRef": "AC-1",
//       "status": "pending",
//       "retries": 0,
//       "maxRetries": 3
//     }
//   ],
//   "boundaries": ["node_modules", ".kovix", "package.json", "main.js", "preload.js"]
// }

const PLAN_SYSTEM_PROMPT = `You are a strict planning agent. Given a user's app idea, you MUST output a single valid JSON object — no markdown, no explanation, no code fences, JUST raw JSON.

The JSON must follow this exact schema:
{
  "id": "plan-001",
  "objective": "Clear description of what is being built and why",
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "given": "precondition",
      "when": "action taken",
      "then": "expected result"
    }
  ],
  "tasks": [
    {
      "id": "T-1",
      "title": "Short task title",
      "files": ["output/filename.ext"],
      "action": "Exact description of what code to write. Include the COMPLETE code to write in the description so the executor can just write it to the file.",
      "verification": "A shell command that exits 0 on success. Use 'node -e \"...\"' for JS checks or 'test -f output/filename.ext' for file existence.",
      "acRef": "AC-1",
      "status": "pending",
      "retries": 0,
      "maxRetries": 3
    }
  ],
  "boundaries": ["node_modules", ".kovix", "package.json", "main.js", "preload.js", "loop"]
}

Rules:
- Produce 1-3 acceptance criteria maximum.
- Produce 1-3 tasks maximum. Keep the MVP tiny.
- Every task must have a verification command that can be run in the shell.
- All output files go in the "output/" directory.
- Never touch anything in the boundaries list.
- The action field must include the FULL code content to write — not just a description.
- OUTPUT ONLY THE JSON. No markdown. No fences. No commentary.`;

/**
 * Generate a structured Plan from the user idea and conversation history.
 *
 * @param {object} openaiClient  — Initialized OpenAI client
 * @param {string} model         — Model string
 * @param {string} rootDir       — Project root directory
 * @param {string} userIdea      — The raw user idea
 * @param {Array}  history       — Conversation history [{role, content}]
 * @param {function} onLog       — Callback for log events
 * @returns {object} The parsed Plan JSON
 */
async function generatePlan(openaiClient, model, rootDir, userIdea, history, onLog) {
  onLog(`[PLAN] Generating plan for: "${userIdea.slice(0, 80)}…"`);

  const messages = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: `My app idea: ${userIdea}` },
  ];

  const response = await openaiClient.chat.completions.create({
    model,
    messages,
    temperature: 0.3, // Low temp for structured output
    max_tokens: 4096,
  });

  let raw = response.choices[0].message.content.trim();

  // Strip markdown code fences if the LLM wrapped them anyway
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (parseErr) {
    onLog(`[PLAN] ⚠ LLM output was not valid JSON. Attempting repair…`);
    // Try to extract JSON from a longer response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      plan = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Plan generation failed: LLM did not return valid JSON. Raw output: ${raw.slice(0, 200)}`);
    }
  }

  // Validate minimum schema
  if (!plan.objective || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Plan missing required fields: objective, tasks');
  }

  // Ensure defaults
  plan.id = plan.id || `plan-${Date.now()}`;
  plan.acceptanceCriteria = plan.acceptanceCriteria || [];
  plan.boundaries = plan.boundaries || ['node_modules', '.kovix', 'package.json', 'main.js', 'preload.js', 'loop'];
  plan.tasks.forEach((t, i) => {
    t.id = t.id || `T-${i + 1}`;
    t.status = t.status || 'pending';
    t.retries = t.retries || 0;
    t.maxRetries = t.maxRetries || 3;
  });

  // Persist
  state.savePlan(rootDir, plan);
  onLog(`[PLAN] ✓ Plan generated: ${plan.id} — ${plan.tasks.length} task(s), ${plan.acceptanceCriteria.length} AC(s)`);

  return plan;
}

module.exports = { generatePlan, PLAN_SYSTEM_PROMPT };
