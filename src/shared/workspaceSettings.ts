import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ToolingError } from './models';
import { requireBackend } from './session';
import { readWorkspacePreferences } from './repositories';
type Options = { env?: NodeJS.ProcessEnv; configPath?: string; homeDir?: string };
function location(options: Options) {
  const home = options.homeDir ?? os.homedir(), env = options.env ?? process.env;
  return options.configPath ?? path.join(process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'MainSequenceCLI') : process.platform === 'win32' ? path.join(env.APPDATA || home, 'MainSequenceCLI') : path.join(home, '.config', 'mainsequence'), 'config.json');
}
async function read(file: string): Promise<Record<string, unknown>> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000000) throw Error();
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Error();
    return value;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new ToolingError('STORE_ERROR', 'Workspace settings could not be read safely. Existing settings were preserved.'); }
}
export async function readDesktopPreferences(options: Options = {}) {
  const config = await read(location(options));
  return { ...await readWorkspacePreferences(options), commandCenterUrl: typeof config.command_center_url === 'string' ? config.command_center_url : '' };
}
/** Updates only non-secret workspace fields, preserving existing CLI settings. */
export async function writeWorkspacePreferences(input: { backend: string; baseDir: string; commandCenterUrl?: string }, options: Options = {}) {
  const backend = requireBackend(input.backend);
  if (!path.isAbsolute(input.baseDir) || /[\0\r\n]/.test(input.baseDir)) throw new ToolingError('INVALID_REQUEST', 'Repositories folder must be an absolute path.');
  const commandCenterUrl = input.commandCenterUrl ? requireBackend(input.commandCenterUrl) : '';
  const file = location(options); await fs.mkdir(path.dirname(file), { recursive: true });
  let lock;
  try { lock = await fs.open(file + '.preferences.lock', 'wx', 0o600); }
  catch { throw new ToolingError('PROJECT_BUSY', 'Another settings update is in progress. Try again after it finishes.'); }
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const config = await read(file);
    await fs.writeFile(temporary, JSON.stringify({ ...config, backend_url: backend, mainsequence_path: path.resolve(input.baseDir), command_center_url: commandCenterUrl }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    return readDesktopPreferences(options);
  } finally { await fs.rm(temporary, { force: true }); await lock.close(); await fs.unlink(file + '.preferences.lock'); }
}
