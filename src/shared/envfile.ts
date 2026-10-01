// Machine-mode extraction of VS Code envfile.ts. No token projection or private fallback.
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { HostServices, ToolingError } from './models';
import { git } from './repositories';
import { requireBackend } from './session';

const RETIRED = new Set(['MAINSEQUENCE_ACCESS_TOKEN', 'MAINSEQUENCE_REFRESH_TOKEN', 'MAINSEQUENCE_RUNTIME_CREDENTIAL_ID', 'MAINSEQUENCE_RUNTIME_CREDENTIAL_SECRET', 'MAINSEQUENCE_TOKEN']);
// The block the VS Code extension owns in a project `.env`. In machine mode it holds the endpoint
// only; the extension (0.1.45 and later) writes the same block, so both tools leave the same file.
const MANAGED_START = '# BEGIN MAINSEQUENCE AUTH (managed by VS Code)';
const MANAGED_END = '# END MAINSEQUENCE AUTH';
// Every variable the extension manages in that file. They move into the block or, with no
// credential belonging in the file, are dropped.
const MANAGED = new Set([
  ...RETIRED,
  'MAINSEQUENCE_ENDPOINT',
  'MAIN_SEQUENCE_PROJECT_UID',
  'MAIN_SEQUENCE_PROJECT_BRANCH_UID',
  'MAINSEQUENCE_REPOSITORY_BRANCH',
  'MAIN_SEQUENCE_ORGANIZATION_PROJECT_ENVIRONMENT_UID',
  'MAIN_SEQUENCE_PROJECT_ID'
]);
export function hasProjectCredentials(env: Record<string, string>): boolean {
  return [...RETIRED].some(key => key in env) || env.MAINSEQUENCE_AUTH_MODE === 'runtime_credential';
}
/**
 * The project `.env` in machine mode: every unrelated line as it was, no credential, and the
 * endpoint in the extension's block at the end, exactly as the extension writes it.
 */
export function renderMachineEnv(text: string, backend: string): string {
  let inside = false;
  const lines = text.replace(/\r/g, '').split('\n').filter(line => {
    if (/^# BEGIN MAINSEQUENCE AUTH/.test(line)) { inside = true; return false; }
    if (/^# END MAINSEQUENCE AUTH/.test(line)) { inside = false; return false; }
    if (inside) return false;
    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!assignment) return true;
    if (MANAGED.has(assignment[1])) return false;
    return !(assignment[1] === 'MAINSEQUENCE_AUTH_MODE' && /=\s*["']?runtime_credential["']?\s*(?:#.*)?$/.test(line));
  });
  while (lines.at(-1) === '') lines.pop();
  return [...lines, ...(lines.length ? [''] : []), MANAGED_START, `MAINSEQUENCE_ENDPOINT=${requireBackend(backend)}`, MANAGED_END, ''].join('\n');
}
/**
 * Leave `root/.env` in its machine-mode form. A file that already has it is not written again:
 * an editor holding the file with unsaved changes would then refuse to save over a newer copy.
 */
export async function writeMachineEnv(host: HostServices, root: string, backend: string): Promise<void> {
  const envPath = path.join(root, '.env');
  const stat = await fs.lstat(envPath).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new ToolingError('INVALID_REQUEST', 'Refusing to replace a non-regular project .env.');
  const tracked = await host.runProcess({ executable: 'git', args: ['ls-files', '--error-unmatch', '--', '.env'], cwd: root, timeoutMs: 5000 });
  if (tracked.exitCode === 0) throw new ToolingError('INVALID_REQUEST', 'The project .env is tracked by Git. Untrack it before cleanup.');
  if (tracked.exitCode !== 1) throw new ToolingError('INVALID_GIT_CONTEXT', 'Could not check whether .env is tracked by Git.');
  const original = stat ? await fs.readFile(envPath, 'utf8') : '';
  const rendered = renderMachineEnv(original, backend);
  if (stat && original === rendered) return;
  const ignore = await host.runProcess({ executable: 'git', args: ['check-ignore', '-q', '--', '.env'], cwd: root, timeoutMs: 5000 });
  if (ignore.exitCode !== 0) {
    const raw = await git(host, root, ['rev-parse', '--git-path', 'info/exclude']);
    const exclude = path.resolve(root, raw);
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    const current = await fs.readFile(exclude, 'utf8').catch(() => '');
    await fs.appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/.env\n`);
  }
  const temporary = `${envPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, rendered, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, envPath);
  } finally { await fs.rm(temporary, { force: true }); }
}
