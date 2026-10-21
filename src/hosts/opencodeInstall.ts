import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ToolingError } from '../shared/models';

export async function installOpenCode(argv: string[]): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return 'ms-devtools opencode-install [--global | --project DIR]\nInstalls the bundled OpenCode V2 server and terminal plugins. Restart OpenCode after installation.';
  const global = argv.length === 0 || (argv.length === 1 && argv[0] === '--global');
  if (!global && !(argv.length === 2 && argv[0] === '--project' && argv[1]?.trim())) throw new ToolingError('INVALID_REQUEST', 'Use opencode-install --global or --project DIR.');
  const parent = global ? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'plugins')
    : path.join(path.resolve(argv[1]), '.opencode', 'plugins');
  const destination = path.join(parent, 'mainsequence-devtools');
  const source = path.resolve(__dirname, '../..', 'opencode');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  await fs.mkdir(parent, { recursive: true });
  let exists = false;
  try {
    const stat = await fs.lstat(destination);
    exists = true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not owned');
    const previous = JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8'));
    if (previous.name !== manifest.name || previous.mainsequenceArtifact !== true) throw new Error('not owned');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw new ToolingError('INVALID_REQUEST', 'The installation path contains an unrecognized plugin. It has been kept: ' + destination);
    // A pre-existing directory with no marker is also unowned.
    if (exists) throw new ToolingError('INVALID_REQUEST', 'The installation path is unrecognized and has been kept: ' + destination);
  }
  const temporary = path.join(parent, '.mainsequence-install-' + randomUUID());
  const backup = temporary + '.previous';
  try {
    await fs.cp(source, temporary, { recursive: true });
    // Record the actual Node executable; a Bun-hosted plugin must not use its own execPath.
    await fs.writeFile(path.join(temporary, 'runtime.json'), JSON.stringify({ nodePath: process.execPath }) + '\n');
    if (exists) await fs.rename(destination, backup);
    try { await fs.rename(temporary, destination); }
    catch (error) { if (exists) await fs.rename(backup, destination); throw error; }
    await fs.rm(backup, { recursive: true, force: true });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return `Installed MainSequence ${manifest.version} for OpenCode V2.\n${destination}\nRestart OpenCode, then enter /ms. Both server and terminal entries are discovered automatically.`;
}
