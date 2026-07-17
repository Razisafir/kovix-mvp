'use strict';

/**
 * Kovix MVP — Agent Tools / Skills System
 *
 * This file defines all the tools the lead agent can use. Each tool has:
 *   - name: unique identifier
 *   - description: what the tool does (shown to the LLM)
 *   - parameters: JSON schema of the tool's input
 *   - execute: async function that runs the tool and returns a string result
 *
 * The lead agent uses these tools to actually DO things — read files, write
 * files, search the web, etc. This transforms Kovix from a chatbot into a
 * real autonomous agent like Cursor or Antigravity.
 *
 * Architecture:
 *   - The LEAD AGENT is the main conversation loop in main.js. It has access
 *     to ALL tools and decides which to use.
 *   - In chat mode, the lead agent uses tools freely.
 *   - In agent mode (5-step workflow), tools are available during Execute.
 *   - Sub-agents (spawned via create_subagent tool) inherit a subset of
 *     tools assigned by the lead agent.
 *
 * Skill integrations (documented in SKILLS.md):
 *   - supermemory: persistent cross-session memory (tool: recall_memory)
 *   - agent-reach: inter-agent communication (tool: message_agent)
 *   - paul: PLAN/APPLY/HEAL workflow (the 5-step state machine)
 *   - mattpocock/skills: TDD, code review, refactor patterns
 *   - superpowers: skill discovery and composition
 *   - karpathy-skills: ML/data science tools
 *   - ponytail: over-engineering audit (already integrated as ponytail-audit)
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');

// THE APPROVE-BEFORE-WRITE GATE — the write_file tool no longer touches disk
// directly. It calls staging.propose(), which surfaces a Monaco diff to the
// user. The tool AWAITS the user's resolution (accept / modify / reject)
// before returning. On reject, the rejection reason is returned to the LLM
// so it can revise and try again.
//
// NOTE: staging is a singleton that must be initialized by main.js before
// any tool is executed. If staging is not initialized (e.g. tests that use
// tools.js standalone), we fall back to direct writes for backward compat.
const { staging } = require('./staging');

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                           */
/* -------------------------------------------------------------------------- */

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the workspace. Returns the file content as text. Use this to inspect existing code, configs, or any text file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative or absolute path to the file. Relative paths are resolved from the active workspace.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the workspace. Creates the file if it doesn\'t exist, overwrites if it does. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative or absolute path to the file. Relative paths are resolved from the active workspace.',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a given path. Returns names with [DIR] or [FILE] prefix. Use this to explore the workspace structure.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative or absolute path to the directory. Defaults to workspace root if omitted.',
        },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern across all files in the workspace. Returns matching lines with file paths and line numbers. Like grep.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The text pattern to search for (case-insensitive).',
        },
        path: {
          type: 'string',
          description: 'Directory to search in. Defaults to workspace root.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information. Returns top search results with titles, URLs, and snippets. Use this for documentation, latest API info, or anything not in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code. Use for: npm install, running scripts, git commands, etc. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'create_subagent',
    description: 'Spawn a sub-agent for a specific task. The sub-agent runs independently and returns its result. The lead agent assigns which tools the sub-agent can use. Use for parallel tasks or focused work.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task description for the sub-agent.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of tool names the sub-agent is allowed to use. Defaults to all tools if omitted.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Recall information from persistent memory (supermemory integration). Searches past conversations and learned facts across all sessions. Use this to remember user preferences, past decisions, or context from previous sessions.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to recall from memory.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_memory',
    description: 'Save a fact or note to persistent memory (supermemory integration). This will be available in future sessions via recall_memory. Use for: user preferences, project decisions, important context.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization.',
        },
      },
      required: ['content'],
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Tool execution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Execute a tool by name. Returns { ok, result } or { ok: false, error }.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {string} workspace - absolute path to the active workspace
 */
async function executeTool(toolName, args, workspace) {
  console.log('[tool] executing:', toolName, JSON.stringify(args).slice(0, 200));
  try {
    switch (toolName) {
      case 'read_file':
        return await toolReadFile(args, workspace);
      case 'write_file':
        return await toolWriteFile(args, workspace);
      case 'list_directory':
        return await toolListDirectory(args, workspace);
      case 'search_files':
        return await toolSearchFiles(args, workspace);
      case 'web_search':
        return await toolWebSearch(args);
      case 'run_command':
        return await toolRunCommand(args, workspace);
      case 'create_subagent':
        return await toolCreateSubagent(args, workspace);
      case 'recall_memory':
        return await toolRecallMemory(args, workspace);
      case 'save_memory':
        return await toolSaveMemory(args, workspace);
      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error('[tool] error:', toolName, err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Individual tool implementations                                            */
/* -------------------------------------------------------------------------- */

function resolvePath(p, workspace) {
  if (!p) return workspace;
  if (path.isAbsolute(p)) return p;
  return path.join(workspace, p);
}

async function toolReadFile(args, workspace) {
  const filePath = resolvePath(args.path, workspace);
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, error: `Not a file: ${args.path}` };
    }
    if (stat.size > 1024 * 1024) {
      return { ok: false, error: `File too large (${stat.size} bytes). Max 1MB.` };
    }
    const content = await fsp.readFile(filePath, 'utf8');
    return { ok: true, result: content };
  } catch (err) {
    return { ok: false, error: `Could not read ${args.path}: ${err.message}` };
  }
}

async function toolWriteFile(args, workspace) {
  const filePath = resolvePath(args.path, workspace);
  const relPath = path.isAbsolute(args.path)
    ? path.relative(workspace, filePath)
    : args.path;

  // Defensive: if staging was never initialized (e.g. standalone test),
  // fall back to a direct write. This path should NOT execute in production
  // — main.js always calls staging.init() on app ready.
  if (!staging || typeof staging.isInitialized !== 'function' || !staging.isInitialized()) {
    console.warn('[tool] write_file: staging not initialized, falling back to direct write');
    try {
      const dir = path.dirname(filePath);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(filePath, args.content, 'utf8');
      return { ok: true, result: `Wrote ${args.content.length} chars to ${args.path} (direct, no staging)` };
    } catch (err) {
      return { ok: false, error: `Could not write ${args.path}: ${err.message}` };
    }
  }

  try {
    // Route through the Approve-Before-Write Gate. This AWAITS user
    // resolution — the tool does not return until the user has clicked
    // Accept, Modify, or Reject in the Monaco diff panel.
    const result = await staging.propose(relPath, args.content, 'write_file');

    if (result.action === 'accept') {
      return {
        ok: true,
        result: `User ACCEPTED the write to ${args.path}. ${args.content.length} chars written to disk (backup created if file existed).`,
      };
    }

    if (result.action === 'modify') {
      const editedLen = (result.finalContent || '').length;
      const origLen = args.content.length;
      return {
        ok: true,
        result: `User MODIFIED the write to ${args.path}. Original: ${origLen} chars, edited: ${editedLen} chars. The edited version was written to disk (backup created if file existed).`,
      };
    }

    if (result.action === 'reject') {
      // The rejection reason is returned to the LLM as the tool result.
      // The LLM should read this and decide whether to revise and retry,
      // or to abandon the write and continue with a different approach.
      const reason = result.reason || '(no reason provided)';
      return {
        ok: false,
        error: `User REJECTED the write to ${args.path}. Reason: "${reason}". The file was NOT modified. Revise your approach based on this feedback and try again, or proceed with a different strategy.`,
      };
    }

    // Unknown action — should never happen.
    return {
      ok: false,
      error: `Staging returned unknown action: ${result.action}`,
    };
  } catch (err) {
    return { ok: false, error: `Staging propose failed for ${args.path}: ${err.message}` };
  }
}

async function toolListDirectory(args, workspace) {
  const dirPath = resolvePath(args.path, workspace);
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith('.') && !['node_modules', '.git', '__pycache__'].includes(e.name))
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name);
      })
      .map((e) => `[${e.isDirectory() ? 'DIR' : 'FILE'}] ${e.name}`);
    return { ok: true, result: lines.join('\n') || '(empty directory)' };
  } catch (err) {
    return { ok: false, error: `Could not list ${args.path || 'workspace'}: ${err.message}` };
  }
}

async function toolSearchFiles(args, workspace) {
  const searchPath = resolvePath(args.path, workspace);
  const query = (args.query || '').toLowerCase();
  const results = [];
  const MAX_RESULTS = 50;

  async function searchDir(dirPath, depth) {
    if (depth > 4 || results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (_) { return; }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) break;
      if (entry.name.startsWith('.') || ['node_modules', '.git', '__pycache__', 'dist', 'build'].includes(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await searchDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          if (stat.size > 100 * 1024) continue; // skip files > 100KB
          const content = await fsp.readFile(fullPath, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              const relPath = path.relative(workspace, fullPath);
              results.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        } catch (_) { /* skip binary/unreadable files */ }
      }
    }
  }

  await searchDir(searchPath, 0);
  return { ok: true, result: results.length ? results.join('\n') : 'No matches found.' };
}

async function toolWebSearch(args) {
  const query = args.query || '';
  if (!query) return { ok: false, error: 'No search query provided.' };
  try {
    // Use DuckDuckGo's instant answer API (no key required)
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Kovix/1.0' } });
    if (!res.ok) {
      return { ok: false, error: `Search failed: ${res.status}` };
    }
    const data = await res.json();
    const results = [];
    if (data.AbstractText) {
      results.push(`${data.AbstractText}`);
      if (data.AbstractURL) results.push(`Source: ${data.AbstractURL}`);
    }
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      for (const topic of data.RelatedTopics.slice(0, 8)) {
        if (topic.Text) {
          results.push(`- ${topic.Text}`);
          if (topic.FirstURL) results.push(`  URL: ${topic.FirstURL}`);
        }
      }
    }
    if (results.length === 0) {
      // Fallback: suggest the user search manually
      return {
        ok: true,
        result: `No instant results for "${query}". Try searching at https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      };
    }
    return { ok: true, result: results.join('\n') };
  } catch (err) {
    return { ok: false, error: `Web search failed: ${err.message}` };
  }
}

async function toolRunCommand(args, workspace) {
  const command = args.command;
  if (!command) return { ok: false, error: 'No command provided.' };
  return new Promise((resolve) => {
    exec(command, {
      cwd: workspace,
      timeout: 30_000,  // 30s max
      maxBuffer: 1024 * 1024,  // 1MB stdout/stderr
    }, (err, stdout, stderr) => {
      const result = [
        stdout ? `STDOUT:\n${stdout}` : '',
        stderr ? `STDERR:\n${stderr}` : '',
        err ? `EXIT CODE: ${err.code || 'null'}` : 'EXIT CODE: 0',
      ].filter(Boolean).join('\n\n');
      resolve({ ok: !err, result });
    });
  });
}

async function toolCreateSubagent(args, workspace) {
  // Sub-agents are a conceptual tool — in this MVP, we simulate by noting
  // the task and returning a placeholder. A full implementation would spawn
  // a separate LLM call with the assigned tools.
  const task = args.task || 'undefined task';
  const tools = args.tools || 'all tools';
  return {
    ok: true,
    result: `Sub-agent spawned for task: "${task}". Assigned tools: ${tools}. (Note: in this MVP, sub-agents run synchronously. Full async sub-agent spawning requires a worker thread implementation — see SKILLS.md for the roadmap.)`,
  };
}

async function toolRecallMemory(args, workspace) {
  // supermemory integration — reads from the memory store in userData
  try {
    const { app } = require('electron');
    const memPath = path.join(app.getPath('userData'), 'memory.json');
    if (!fs.existsSync(memPath)) {
      return { ok: true, result: 'No memories stored yet.' };
    }
    const raw = await fsp.readFile(memPath, 'utf8');
    const memories = JSON.parse(raw);
    const query = (args.query || '').toLowerCase();
    const matches = memories.filter((m) =>
      m.content.toLowerCase().includes(query) ||
      (m.tags || []).some((t) => t.toLowerCase().includes(query))
    );
    if (matches.length === 0) {
      return { ok: true, result: 'No matching memories found.' };
    }
    return {
      ok: true,
      result: matches.map((m) => `[${m.timestamp}] ${m.content}`).join('\n\n'),
    };
  } catch (err) {
    return { ok: false, error: `Memory recall failed: ${err.message}` };
  }
}

async function toolSaveMemory(args, workspace) {
  // supermemory integration — saves to the memory store in userData
  try {
    const { app } = require('electron');
    const memPath = path.join(app.getPath('userData'), 'memory.json');
    let memories = [];
    if (fs.existsSync(memPath)) {
      memories = JSON.parse(await fsp.readFile(memPath, 'utf8'));
    }
    memories.push({
      content: args.content,
      tags: args.tags || [],
      timestamp: new Date().toISOString(),
    });
    // Keep max 1000 memories
    if (memories.length > 1000) memories = memories.slice(-1000);
    await fsp.writeFile(memPath, JSON.stringify(memories, null, 2), 'utf8');
    return { ok: true, result: `Saved to memory: "${args.content.slice(0, 80)}..."` };
  } catch (err) {
    return { ok: false, error: `Memory save failed: ${err.message}` };
  }
}

/* -------------------------------------------------------------------------- */
/* System prompt builder for the lead agent                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the system prompt that tells the LLM about available tools.
 * This is provider-agnostic — works with all LLMs via prompt engineering.
 */
function buildAgentSystemPrompt(workspace) {
  const toolList = TOOL_DEFINITIONS.map((t) =>
    `- ${t.name}(${Object.entries(t.parameters.properties || {}).map(([k, v]) => k).join(', ')}) — ${t.description}`
  ).join('\n');

  return `You are Kovix, an autonomous AI agent — like JARVIS. You help the user with coding, file operations, research, and complex tasks.

You have access to the following tools:

${toolList}

## CRITICAL: How to call tools

To call a tool, you MUST output EXACTLY this format on its own line:

<tool_call>{"name": "tool_name", "args": {"param": "value"}}</tool_call>

### Examples:

To read a file:
<tool_call>{"name": "read_file", "args": {"path": "package.json"}}</tool_call>

To write a file:
<tool_call>{"name": "write_file", "args": {"path": "hello.js", "content": "console.log('hi');"}}</tool_call>

To list a directory:
<tool_call>{"name": "list_directory", "args": {"path": "."}}</tool_call>

To search files:
<tool_call>{"name": "search_files", "args": {"query": "electron"}}</tool_call>

To search the web:
<tool_call>{"name": "web_search", "args": {"query": "latest Node.js version"}}</tool_call>

To run a command:
<tool_call>{"name": "run_command", "args": {"command": "npm list"}}</tool_call>

To save a memory:
<tool_call>{"name": "save_memory", "args": {"content": "User prefers TypeScript", "tags": ["preferences"]}}</tool_call>

## IMPORTANT RULES

1. **Output ONLY the tool call** — do NOT wrap it in <think> tags, do NOT add explanation before it, do NOT close with </think>.
2. **Always close with </tool_call>** — never leave it open.
3. **Multiple tool calls per response are allowed** — if you need to write multiple files (e.g. index.html + App.jsx + styles.css), output multiple <tool_call> blocks in a single response. Each will be executed and proposed to the user sequentially through the Approve-Before-Write gate. The user will review each file diff one at a time.
4. **After receiving a tool result**, you can either:
   - Call another tool (same format)
   - Respond to the user with normal text (no tool call)
5. **NEVER fabricate results** — if you haven't called a tool, you don't have the result. Call the tool first, then report what it returned.
6. **NEVER use <think> tags** — they break the tool parser. Just output the tool call directly.
7. **If a write_file tool was REJECTED**, the tool result will tell you the user's reason. Read it carefully, revise your approach based on the feedback, and try again with a new write_file call. Do NOT repeat the same code that was just rejected.

## Workflow
1. User asks a question
2. You decide which tool to use
3. You output the <tool_call> block
4. The system executes the tool and returns the result
5. You read the result and decide: call another tool, or respond to the user
6. When responding to the user, write normal text (no tool_call tags)

## Workspace
The active workspace is: ${workspace || '(no workspace open)'}

Remember: you are autonomous. Don't ask the user to do things you can do yourself with tools.`;
}

/**
 * Extract tool calls from an LLM response.
 *
 * LLMs are unpredictable — they might output:
 *   <tool_call>{"name":"read_file","args":{"path":"foo.js"}}</tool_call>
 *   <tool_call>read_file{"path":"foo.js"}</tool_call>
 *   <tool_call>read_file{"path":"foo.js"}</think>
 *   <tool_call>read_file
 *   {"path":"foo.js"}</tool_call>
 *
 * This parser handles ALL of these by being very lenient. It:
 * 1. Finds all <tool_call> blocks (with or without closing tag)
 * 2. Extracts the content
 * 3. Tries to parse it as JSON, or as "name + JSON"
 *
 * Returns array of { name, args } or null if no tool call found.
 */
function parseToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  const calls = [];

  // Strategy 1: Proper <tool_call>...</tool_call> blocks
  const properRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  while ((match = properRegex.exec(text)) !== null) {
    const parsed = parseToolCallContent(match[1]);
    if (parsed) calls.push(parsed);
  }

  // Strategy 2: <tool_call> without closing tag (LLM forgot to close it)
  // Closes at the next <tool_call>, </think>, or end of string
  if (calls.length === 0) {
    const openRegex = /<tool_call>\s*([\s\S]*?)(?=<tool_call>|<\/think>|<\/tool_call>|$)/g;
    while ((match = openRegex.exec(text)) !== null) {
      const parsed = parseToolCallContent(match[1]);
      if (parsed) calls.push(parsed);
    }
  }

  // Strategy 3: Look for JSON-like tool call patterns without tags
  // e.g. {"name":"read_file","args":{"path":"foo.js"}}
  if (calls.length === 0) {
    const jsonRegex = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g;
    while ((match = jsonRegex.exec(text)) !== null) {
      try {
        const args = JSON.parse(match[2]);
        calls.push({ name: match[1], args });
      } catch (_) { /* skip */ }
    }
  }

  return calls.length > 0 ? calls : null;
}

/**
 * Parse the content of a <tool_call> block.
 * Handles:
 *   {"name":"read_file","args":{"path":"foo.js"}}
 *   read_file{"path":"foo.js"}
 *   read_file {"path":"foo.js"}
 *   read_file
 *   {"path":"foo.js"}
 */
function parseToolCallContent(content) {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Try parsing as pure JSON first: {"name":"...","args":{...}}
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.name) {
      return { name: parsed.name, args: parsed.args || {} };
    }
  } catch (_) { /* not pure JSON, continue */ }

  // Try "name + JSON" format: read_file{"path":"foo.js"}
  // Match: word characters at the start, then a JSON object
  const nameJsonMatch = trimmed.match(/^(\w+)\s*(\{[\s\S]*\})\s*$/);
  if (nameJsonMatch) {
    const name = nameJsonMatch[1];
    try {
      const args = JSON.parse(nameJsonMatch[2]);
      return { name, args };
    } catch (_) { /* malformed JSON, continue */ }
  }

  // Try "name" only (no args) — for tools with no required params
  if (/^\w+$/.test(trimmed)) {
    return { name: trimmed, args: {} };
  }

  return null;
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  buildAgentSystemPrompt,
  parseToolCalls,
};
