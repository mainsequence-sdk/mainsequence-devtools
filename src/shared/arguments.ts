import { ActionRequest, ProjectType, ToolingError } from './models';

export const HELP = `MainSequence developer tooling (Node 22+)

ms-devtools login|logout|refresh-token|auth-status|repositories [--backend URL]
ms-devtools auth-status [--check] [--backend URL]
ms-devtools status|resolve [--path ROOT] [--type python|vite_react] [--backend URL]
ms-devtools sync --message TEXT [--path ROOT] [--dry-run]
ms-devtools freeze-env|sdk-status|update-sdk|update-agents|install-skills|install|env-cleanup [--path ROOT]
ms-devtools setup --uid UID --branch BRANCH --base-dir DIR [--install] [--backend URL]

Project commands also accept --type and --backend. update-sdk and install-skills accept --dry-run.
All commands accept --json. No command accepts credentials as arguments.
skills-sync requires MainSequence MCP and reports unsupported.
open-folder and signed-terminal require a host with those native capabilities.
In Codex desktop, type /ms, select the ms slash-menu entry, then append COMMAND ... .
The trusted plugin hook executes the selected command before inference.
`;
export function parseArguments(argv: string[], cwd = process.cwd()): { request?: ActionRequest; json: boolean; help?: boolean } {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { json: argv.includes('--json'), help: true };
  const action = argv[0];
  const flags: Record<string, string | boolean> = {};
  const boolean = new Set(['--json', '--check', '--dry-run', '--install']);
  const valued = new Set(['--backend', '--path', '--type', '--message', '-m', '--uid', '--branch', '--base-dir']);
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i] === '-m' ? '--message' : argv[i];
    if (key === '--help' || key === '-h') return { json: argv.includes('--json'), help: true };
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
  const allowed = ['login', 'logout', 'refresh-token', 'repositories'].includes(action) ? global
    : action === 'auth-status' ? [...global, '--check']
    : action === 'setup' ? [...global, '--uid', '--branch', '--base-dir', '--install']
    : [...global, ...project, ...(action === 'sync' ? ['--message', '--dry-run'] : ['update-sdk', 'install-skills'].includes(action) ? ['--dry-run'] : [])];
  if (Object.keys(flags).some(key => !allowed.includes(key))) throw new ToolingError('INVALID_REQUEST', 'This option does not apply to the selected action.');
  const backend = typeof flags['--backend'] === 'string' ? flags['--backend'] : undefined;
  const common = { backend };
  let request: ActionRequest;
  if (['login', 'logout', 'refresh-token', 'repositories'].includes(action)) request = { action, ...common } as ActionRequest;
  else if (action === 'auth-status') request = { action, ...common, check: Boolean(flags['--check']) };
  else if (action === 'setup') request = { action, ...common, repositoryUid: flags['--uid'] as string, branch: flags['--branch'] as string, baseDir: flags['--base-dir'] as string, install: Boolean(flags['--install']) };
  else request = { action, ...common, root: flags['--path'] as string || cwd, projectType: flags['--type'] as ProjectType | undefined, message: flags['--message'] as string | undefined, dryRun: Boolean(flags['--dry-run']) } as ActionRequest;
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
