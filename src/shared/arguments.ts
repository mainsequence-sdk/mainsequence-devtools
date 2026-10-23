import { readFileSync, statSync } from 'node:fs';
import type { McpRequest } from './mcp';
import { ActionRequest, ProjectType, ToolingError } from './models';
import { currentDirectory } from './workingDirectory';

export const HELP = `MainSequence developer tooling (Node 22+)

ms-devtools login|logout|refresh-token|auth-status|repositories [--backend URL]
ms-devtools auth-status [--check] [--backend URL]
ms-devtools mcp-discover [--search TEXT] [--limit N] [--offset N] [--backend URL]
ms-devtools mcp-list [--backend URL]
ms-devtools mcp-add|mcp-remove|mcp-tools --uid RELEASE_UUID [--backend URL]
ms-devtools mcp-call --uid RELEASE_UUID --tool NAME [--arguments-file JSON_FILE] [--backend URL]
ms-devtools status|resolve [--path ROOT] [--type python|vite_react] [--backend URL]
ms-devtools sync [--path ROOT]
ms-devtools sdk-status|update-sdk|update-agents|install-skills|install|env-cleanup [--path ROOT]
ms-devtools setup --uid UID --branch BRANCH --base-dir DIR [--install] [--backend URL]

sync refreshes dependency files with the project SDK. Python: uv.lock, the environment and
requirements.txt. Node: package-lock.json, then npm ci. It does not commit, tag or push:
review the changes, then commit and push them yourself.
Project commands also accept --type and --backend. update-sdk and install-skills accept --dry-run.
All commands accept --json. No command accepts credentials as arguments.
skills-sync requires MainSequence MCP and reports unsupported.
open-folder and signed-terminal require a host with those native capabilities.
In Codex desktop, type /ms, select the ms slash-menu entry, then append COMMAND ... .
The trusted plugin hook executes the selected command before inference.
`;
export function parseArguments(argv: string[], cwd?: string): { request?: ActionRequest; json: boolean; help?: boolean } {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { json: argv.includes('--json'), help: true };
  const action = argv[0];
  const flags: Record<string, string | boolean> = {};
  const boolean = new Set(['--json', '--check', '--dry-run', '--install']);
  const valued = new Set(['--backend', '--path', '--type', '--uid', '--branch', '--base-dir', '--search', '--limit', '--offset', '--tool', '--arguments-file']);
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { json: argv.includes('--json'), help: true };
    if (action === 'sync' && ['--message', '-m', '--dry-run'].includes(key)) {
      throw new ToolingError('INVALID_REQUEST', `sync no longer takes ${key}: it refreshes dependency files and does not commit, tag or push. Commit and push the changes yourself.`);
    }
    if (key in flags) throw new ToolingError('INVALID_REQUEST', 'Duplicate command option.');
    if (boolean.has(key)) flags[key] = true;
    else if (valued.has(key)) {
      const value = argv[++i];
      if (value === undefined || !value.trim() || value.includes('\0')) throw new ToolingError('INVALID_REQUEST', 'A command option is missing its value.');
      flags[key] = value;
    } else throw new ToolingError('INVALID_REQUEST', 'Unknown command option or positional argument. Run --help.');
  }
  const global = ['--backend', '--json'];
  const project = ['--path', '--type'];
  const allowed = action === 'mcp-discover' ? [...global, '--search', '--limit', '--offset']
    : action === 'mcp-list' ? global
    : ['mcp-add', 'mcp-remove', 'mcp-tools'].includes(action) ? [...global, '--uid']
    : action === 'mcp-call' ? [...global, '--uid', '--tool', '--arguments-file']
    : ['login', 'logout', 'refresh-token', 'repositories'].includes(action) ? global
    : action === 'auth-status' ? [...global, '--check']
    : action === 'setup' ? [...global, '--uid', '--branch', '--base-dir', '--install']
    : [...global, ...project, ...(['update-sdk', 'install-skills'].includes(action) ? ['--dry-run'] : [])];
  if (Object.keys(flags).some(key => !allowed.includes(key))) throw new ToolingError('INVALID_REQUEST', 'This option does not apply to the selected action.');
  const backend = typeof flags['--backend'] === 'string' ? flags['--backend'] : undefined;
  const common = { backend };
  let request: ActionRequest;
  if (['mcp-discover', 'mcp-list', 'mcp-add', 'mcp-remove', 'mcp-tools', 'mcp-call'].includes(action)) {
    let args: Record<string, unknown> = {};
    if (typeof flags['--arguments-file'] === 'string') {
      try {
        if (statSync(flags['--arguments-file']).size > 1_000_000) throw new Error();
        args = JSON.parse(readFileSync(flags['--arguments-file'], 'utf8'));
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
      } catch { throw new ToolingError('INVALID_REQUEST', 'The arguments file must contain a JSON object of at most 1 MB.'); }
    }
    request = { action, ...common, ...(flags['--uid'] ? { releaseUid: flags['--uid'] } : {}),
      ...(flags['--search'] !== undefined ? { search: flags['--search'] } : {}),
      ...(flags['--limit'] !== undefined ? { limit: Number(flags['--limit']) } : {}),
      ...(flags['--offset'] !== undefined ? { offset: Number(flags['--offset']) } : {}),
      ...(action === 'mcp-call' ? { tool: flags['--tool'], arguments: args } : {}) } as McpRequest;
  } else if (['login', 'logout', 'refresh-token', 'repositories'].includes(action)) request = { action, ...common } as ActionRequest;
  else if (action === 'auth-status') request = { action, ...common, check: Boolean(flags['--check']) };
  else if (action === 'setup') request = { action, ...common, repositoryUid: flags['--uid'] as string, branch: flags['--branch'] as string, baseDir: flags['--base-dir'] as string, install: Boolean(flags['--install']) };
  else request = { action, ...common, root: flags['--path'] as string || cwd || currentDirectory(), projectType: flags['--type'] as ProjectType | undefined, dryRun: Boolean(flags['--dry-run']) } as ActionRequest;
  return { request, json: Boolean(flags['--json']) };
}

/** Tokenize explicit hook commands without evaluating a shell, substitutions, or expansions. */
export function tokenizeCommand(text: string): string[] {
  if (/[\r\n\0]/.test(text)) throw new ToolingError('INVALID_REQUEST', 'MainSequence commands must be a single line.');
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote) {
      if (character === quote) quote = '';
      else if (character === '\\' && quote === '"' && ['"', '\\'].includes(text[i + 1])) word += text[++i];
      else word += character;
    } else if (character === "'" || character === '"') { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) { words.push(word); word = ''; started = false; } }
    else if (';&|<>`'.includes(character)) throw new ToolingError('INVALID_REQUEST', 'Shell operators are not supported in MainSequence commands.');
    else { word += character; started = true; }
  }
  if (quote) throw new ToolingError('INVALID_REQUEST', 'A command argument has an unclosed quote.');
  if (started) words.push(word);
  return words;
}
