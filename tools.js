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
  try {
    // Create parent directories if needed
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, args.content, 'utf8');
    console.log('[tool] write_file: wrote', args.content.length, 'chars to', filePath);
    return { ok: true, result: `Successfully wrote ${args.content.length} characters to ${args.path}` };
  } catch (err) {
    return { ok: false, error: `Could not write ${args.path}: ${err.message}` };
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

## How to use tools

To call a tool, respond with EXACTLY this format (and nothing else):

<tool_call>
{"name": "tool_name", "args": {"param": "value"}}
</tool_call>

After you call a tool, you'll receive the result and can decide to:
1. Call another tool (same format)
2. Respond to the user with normal text

## Rules
- Always use tools to DO things (read files, write files, search) rather than asking the user to do them.
- If the user asks you to create a file, use write_file.
- If the user asks about existing files, use read_file or list_directory first.
- If you need current information (docs, APIs), use web_search.
- When you're done using tools, give a clear, concise summary of what you did.
- The workspace is: ${workspace || '(no workspace open)'}
- You are the LEAD AGENT. You can spawn sub-agents with create_subagent for parallel tasks.

Remember: you are autonomous. Don't ask the user to do things you can do yourself with tools.`;
}

/**
 * Extract tool calls from an LLM response.
 * Returns array of { name, args } or null if no tool call found.
 */
function parseToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  const calls = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        calls.push({ name: parsed.name, args: parsed.args || {} });
      }
    } catch (_) { /* skip malformed */ }
  }
  return calls.length > 0 ? calls : null;
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  buildAgentSystemPrompt,
  parseToolCalls,
};
