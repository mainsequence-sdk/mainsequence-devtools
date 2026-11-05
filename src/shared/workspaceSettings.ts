import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ToolingError } from './models';
import { requireBackend } from './session';
import { readWorkspacePreferences, repositoriesFolder } from './repositories';
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
/** Updates only the non-secret workspace fields given, preserving every other CLI setting: a host that
 * shares only the repositories folder (Claude Desktop) saves `{ baseDir }` alone. */
export async function writeWorkspacePreferences(input: { backend?: string; baseDir?: string; commandCenterUrl?: string }, options: Options = {}) {
  if (input.backend === undefined && input.baseDir === undefined && input.commandCenterUrl === undefined) throw new ToolingError('INVALID_REQUEST', 'Name a workspace setting to save.');
  const updates: Record<string, string> = {};
  if (input.backend !== undefined) updates.backend_url = requireBackend(input.backend);
  if (input.baseDir !== undefined) updates.mainsequence_path = repositoriesFolder(input.baseDir, options.homeDir, 'Repositories folder');
  if (input.commandCenterUrl !== undefined) updates.command_center_url = input.commandCenterUrl ? requireBackend(input.commandCenterUrl) : '';
  const file = location(options); await fs.mkdir(path.dirname(file), { recursive: true });
  let lock;
  try { lock = await fs.open(file + '.preferences.lock', 'wx', 0o600); }
  catch { throw new ToolingError('PROJECT_BUSY', 'Another settings update is in progress. Try again after it finishes.'); }
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const config = await read(file);
    await fs.writeFile(temporary, JSON.stringify({ ...config, ...updates }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    return readDesktopPreferences(options);
  } finally { await fs.rm(temporary, { force: true }); await lock.close(); await fs.unlink(file + '.preferences.lock'); }
}
