// Project-local CLI selection and argv contracts extracted from codeRepositoryCli.ts.
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { ActionCapability, HostServices, ProcessSpec, ProjectAction, ProjectContext, SessionService, ToolingError } from './models';
import { canonicalRepositoryDir, git, projectContext, readProjectEnv, repositorySetupInfo } from './repositories';
import { hasProjectCredentials, writeMachineEnv } from './envfile';
import { repositorySshKeyIdentity, repositorySshKeyPaths, repositorySshKeyName } from './repositoryIdentity';
import { resolveCodeRepositoryCli, buildCodeRepositoryCliInvocations } from './cli';
import { requireBackend } from './session';
import { readPythonSdkStatus } from './pythonSdkStatus';

export type ExecutionState = { mutationStarted: boolean };
type Cli = { executable: string; prefix: string[]; available: boolean };
export async function projectCli(context: ProjectContext): Promise<Cli> {
  if (!context.projectType) throw new ToolingError('PROJECT_TYPE_REQUIRED', 'Select --type python or --type vite_react for an ambiguous or unknown project.');
  const cli = resolveCodeRepositoryCli(context.root, context.projectType);
  return { executable: cli.executable, prefix: cli.prefixArgs, available: cli.available };
}
async function isFile(value: string): Promise<boolean> { return fs.stat(value).then(s => s.isFile()).catch(() => false); }
function commandArgs(context: ProjectContext, action: ProjectAction, message?: string, dryRun?: boolean): string[] | undefined {
  const python = context.projectType === 'python';
  let args: string[];
  switch (action) {
    case 'sync': {
      const safeMessage = String(message || '').replace(/[\r\n]+/g, ' ').trim();
      if (!safeMessage || safeMessage.includes('\0')) throw new ToolingError('INVALID_REQUEST', 'Sync requires a non-empty commit message.');
      args = ['code-repository', 'sync', '--path', '.', '-m', safeMessage]; break;
    }
    case 'freeze-env': if (!python) return; args = ['code-repository', 'freeze-env', '--path', '.']; break;
    case 'sdk-status': if (python) return; args = ['application', 'sdk-status', '--path', '.', '--json']; break;
    case 'update-sdk': args = [python ? 'code-repository' : 'application', 'update-sdk', '--path', '.']; break;
    case 'update-agents': if (!python) return; args = ['code-repository', 'update', 'AGENTS.md', '--path', '.']; break;
    case 'install-skills': if (python) return; args = ['skills', 'install', '--path', '.']; break;
    default: return;
  }
  if (dryRun) {
    if (!['sync', 'update-sdk', 'install-skills'].includes(action)) throw new ToolingError('INVALID_REQUEST', 'This action has no read-only dry-run mode.');
    args.push('--dry-run');
  }
  return args;
}
async function probe(host: HostServices, context: ProjectContext, action: ProjectAction, cli: Cli, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ActionCapability> {
  if (!cli.available) return { action, state: 'unavailable', reason: 'The project-local SDK CLI is missing. Run install in this project.' };
  const args = commandArgs(context, action, 'Capability probe');
  if (!args) return { action, state: 'unsupported', reason: 'This operation is not provided by this project SDK.' };
  const command = args.slice(0, 2);
  const help = await host.runProcess({ executable: cli.executable, args: [...cli.prefix, ...(context.projectType === 'python' ? command : []), '--help'], cwd: context.root, env, signal, timeoutMs: 20_000 });
  if (help.cancelled) throw new ToolingError('CANCELLED', 'The action was cancelled.');
  if (help.exitCode !== 0 || !help.stdout.includes('--path') || (context.projectType !== 'python' && !help.stdout.includes(command.join(' ')))) {
    return { action, state: 'unavailable', reason: 'The installed SDK CLI does not advertise this command. Update the project SDK or fix its environment.' };
  }
  return { action, state: 'available' };
}
/** Scope inherited credentials to their explicit backend, then let the installed SDK read its store. */
export function projectEnvironment(context: Pick<ProjectContext, 'backend'>, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const credentialKeys = ['MAINSEQUENCE_ACCESS_TOKEN', 'MAINSEQUENCE_REFRESH_TOKEN', 'MAINSEQUENCE_TOKEN', 'MAINSEQUENCE_RUNTIME_CREDENTIAL_ID', 'MAINSEQUENCE_RUNTIME_CREDENTIAL_SECRET'];
  if (credentialKeys.some(key => env[key])) {
    if (!env.MAINSEQUENCE_ENDPOINT || requireBackend(env.MAINSEQUENCE_ENDPOINT) !== context.backend) {
      throw new ToolingError('BACKEND_MISMATCH', 'Inherited process credentials belong to another or unspecified backend.');
    }
    if (env.MAINSEQUENCE_TOKEN || env.MAINSEQUENCE_RUNTIME_CREDENTIAL_ID || env.MAINSEQUENCE_RUNTIME_CREDENTIAL_SECRET) {
      throw new ToolingError('INVALID_REQUEST', 'Unsupported or runtime credentials cannot be used for developer project actions.');
    }
  }
  env.MAINSEQUENCE_ENDPOINT = context.backend;
  return env;
}

export async function projectCapabilities(host: HostServices, context: ProjectContext, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ActionCapability[]> {
  const actions: ProjectAction[] = ['sync', 'freeze-env', 'sdk-status', 'update-sdk', 'update-agents', 'install-skills', 'skills-sync', 'install', 'env-cleanup', 'open-folder', 'signed-terminal'];
  if (!context.projectType) return actions.map(action => ({ action, state: 'unavailable', reason: 'Project type is ambiguous. Select --type.' }));
  const cli = await projectCli(context);
  const scoped = projectEnvironment(context, env);
  const results: ActionCapability[] = [];
  for (const action of actions) {
    if (action === 'skills-sync') results.push({ action, state: 'unsupported', reason: 'Backend-owned skills currently require MainSequence MCP.' });
    else if (action === 'open-folder' || action === 'signed-terminal') results.push({ action, state: (action === 'open-folder' ? host.openFolder : host.openTerminal) ? 'available' : 'unsupported', reason: (action === 'open-folder' ? host.openFolder : host.openTerminal) ? undefined : 'This host has no native folder/terminal capability.' });
    else if (action === 'env-cleanup') results.push({ action, state: 'available' });
    else if (action === 'install') {
      const command = context.projectType === 'python' ? { executable: 'uv', args: ['--version'] } : npmCommand('--version');
      const result = await host.runProcess({ ...command, cwd: context.root, env: scoped, signal, timeoutMs: 10_000 });
      if (result.cancelled) throw new ToolingError('CANCELLED', 'The action was cancelled.');
      results.push({ action, state: result.exitCode === 0 ? 'available' : 'unavailable', reason: result.exitCode === 0 ? undefined : `${context.projectType === 'python' ? 'uv' : 'npm'} is required.` });
    } else if (action === 'sdk-status' && context.projectType === 'python') {
      results.push({ action, state: await isFile(pythonExecutable(context.root)) ? 'available' : 'unavailable', reason: await isFile(pythonExecutable(context.root)) ? undefined : 'Build the project .venv first.' });
    } else results.push(await probe(host, context, action, cli, scoped, signal));
  }
  return results;
}
export function npmCommand(command: 'ci' | '--version', platform = process.platform): { executable: string; args: string[] } {
  // Windows npm.cmd needs cmd.exe. This is a fixed command, with no user arguments or secrets.
  return platform === 'win32' ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', `npm ${command}`] } : { executable: 'npm', args: [command] };
}
function pythonExecutable(root: string): string { return path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'); }
async function execute(host: HostServices, spec: ProcessSpec, state: ExecutionState, mutating: boolean): Promise<string> {
  spec.signal?.throwIfAborted();
  if (mutating) state.mutationStarted = true;
  const result = await host.runProcess(spec);
  if (result.cancelled) throw new ToolingError('CANCELLED', 'The action was cancelled; inspect the project before retrying.');
  if (result.timedOut) throw new ToolingError('PROCESS_TIMEOUT', 'The project command timed out; inspect the project before retrying.');
  if (result.unavailable) throw new ToolingError('MISSING_PREREQUISITE', 'The required project executable could not be started.');
  if (result.exitCode !== 0) throw new ToolingError('PROCESS_FAILED', `The project command failed (exit ${result.exitCode ?? 'unknown'}). No automatic retry or rollback was attempted.`);
  return result.stdout;
}
export async function withProjectLock<T>(commonDir: string, work: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(commonDir, 'mainsequence-devtools.lock'), work);
}
async function withFileLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw new ToolingError('PROJECT_BUSY', `Another tooling action holds this repository lock: ${lock}. After an interrupted run, verify no action is running before removing it.`);
    throw new ToolingError('INVALID_GIT_CONTEXT', 'Could not acquire the repository action lock.');
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, id: crypto.randomUUID() })); return await work(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
export async function runProjectAction(host: HostServices, session: SessionService, context: ProjectContext, action: ProjectAction, options: { message?: string; dryRun?: boolean; env: NodeJS.ProcessEnv; signal?: AbortSignal; state: ExecutionState; fetch?: typeof fetch; allowMcpSkills?: boolean; allowLegacyProjectCredentials?: boolean }): Promise<unknown> {
  const env = projectEnvironment(context, options.env);
  if (action === 'skills-sync') {
    if (!options.allowMcpSkills) throw new ToolingError('UNSUPPORTED_ACTION', 'Backend-owned skills require MainSequence MCP. This runner does not invoke it.');
    if (!context.projectType) throw new ToolingError('PROJECT_TYPE_REQUIRED', 'A supported project type is required.');
    const cli = resolveCodeRepositoryCli(context.root, context.projectType);
    if (!cli.available) throw new ToolingError('MISSING_PREREQUISITE', cli.missingMessage);
    await session.status(context.backend, true);
    for (const invocation of buildCodeRepositoryCliInvocations(cli, 'skills')) {
      await execute(host, { executable: invocation.executable, args: invocation.args, cwd: context.root, env, signal: options.signal }, options.state, true);
    }
    return { root: context.root, projectType: context.projectType };
  }
  if (action === 'open-folder') {
    if (!host.openFolder) throw new ToolingError('UNSUPPORTED_ACTION', 'This host does not expose a native folder opener. The project path is available through status.');
    await host.openFolder(context.root); return { root: context.root };
  }
  if (action === 'signed-terminal') {
    if (!host.openTerminal) throw new ToolingError('UNSUPPORTED_ACTION', 'This host does not expose a native terminal opener.');
    await session.status(context.backend, true);
    const { keyPath, pubPath } = repositorySshKeyPaths(context.origin);
    if (!repositorySshKeyIdentity(context.origin).usesSsh || !(await isFile(keyPath)) || !(await isFile(pubPath))) throw new ToolingError('MISSING_PREREQUISITE', 'A repository-specific SSH keypair is required. Set up this repository first.');
    env.GIT_SSH_COMMAND = `ssh -i ${quoteSshPath(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    // Store-aware SDKs acquire access themselves. Never return or print a token-bearing shell command.
    await host.openTerminal({ root: context.root, env }); return { root: context.root };
  }
  if (action === 'env-cleanup') {
    options.state.mutationStarted = true;
    await writeMachineEnv(host, context.root, context.backend); return { root: context.root, endpointOnly: true };
  }
  if (!context.projectType) throw new ToolingError('PROJECT_TYPE_REQUIRED', 'Select --type python or --type vite_react.');
  if (action === 'install') {
    if (options.dryRun) throw new ToolingError('INVALID_REQUEST', 'Install has no dry-run mode.');
    host.progress?.(context.projectType === 'python' ? 'Building the project environment with uv sync.' : 'Installing locked npm dependencies.');
    const command = context.projectType === 'python' ? { executable: 'uv', args: ['sync'] } : npmCommand('ci');
    await execute(host, { ...command, cwd: context.root, env, signal: options.signal }, options.state, true);
    return { root: context.root, projectType: context.projectType };
  }
  if (action === 'sdk-status' && context.projectType === 'python') {
    const output = await execute(host, { executable: pythonExecutable(context.root), args: ['-I', '-c', "import importlib.metadata as m, json\ntry: v = m.version('mainsequence')\nexcept m.PackageNotFoundError: v = None\nprint(json.dumps({'installed': v}))"], cwd: context.root, env, signal: options.signal, timeoutMs: 10_000 }, options.state, false);
    let installed: string | null;
    try { installed = JSON.parse(output).installed; if (installed !== null && typeof installed !== 'string') throw new Error(); }
    catch { throw new ToolingError('PROCESS_FAILED', 'The Python interpreter did not return valid distribution metadata.'); }
    return readPythonSdkStatus(installed, options.fetch, options.signal);
  }
  const cli = await projectCli(context);
  const capability = await probe(host, context, action, cli, env, options.signal);
  if (capability.state !== 'available') throw new ToolingError(capability.state === 'unsupported' ? 'UNSUPPORTED_ACTION' : 'MISSING_PREREQUISITE', capability.reason!);
  const args = commandArgs(context, action, options.message, options.dryRun)!;
  if (options.dryRun && !['sync', 'update-sdk', 'install-skills'].includes(action)) throw new ToolingError('INVALID_REQUEST', 'This action has no dry-run mode.');
  if (options.dryRun) {
    const help = await host.runProcess({ executable: cli.executable, args: [...cli.prefix, ...(context.projectType === 'python' ? args.slice(0, 2) : []), '--help'], cwd: context.root, env, signal: options.signal, timeoutMs: 20_000 });
    if (!help.stdout.includes('--dry-run')) throw new ToolingError('MISSING_PREREQUISITE', 'The installed CLI does not advertise dry-run support.');
  }
  // Old .env credentials would change the SDK's identity. Require explicit cleanup first.
  if (!options.allowLegacyProjectCredentials && hasProjectCredentials(await readProjectEnv(context.root))) throw new ToolingError('INVALID_REQUEST', 'The project .env contains retired credentials. Run env-cleanup before dispatching SDK commands.');
  host.progress?.(`Running ${action} with the project-installed ${context.projectType === 'python' ? 'Python' : 'Node'} SDK CLI.`);
  const output = await execute(host, { executable: cli.executable, args: [...cli.prefix, ...args], cwd: context.root, env, signal: options.signal }, options.state, action !== 'sdk-status' && !options.dryRun);
  if (action === 'sdk-status') {
    let report: any;
    try { report = JSON.parse(output); } catch { throw new ToolingError('PROCESS_FAILED', 'The SDK status command returned invalid JSON.'); }
    const result: Record<string, string | boolean | null> = {};
    for (const key of ['package', 'declared', 'locked', 'installed', 'wanted', 'latest', 'status', 'dependencyType', 'updateAvailable', 'updateSupported', 'hint']) {
      if (report[key] === null || typeof report[key] === 'string' || typeof report[key] === 'boolean') result[key] = report[key];
    }
    return result;
  }
  return { root: context.root, projectType: context.projectType, dryRun: Boolean(options.dryRun) };
}

function quoteSshPath(value: string): string {
  if (process.platform === 'win32') {
    if (/["%\r\n]/.test(value)) throw new ToolingError('INVALID_REQUEST', 'The SSH key path cannot be quoted safely on this platform.');
    return `"${value}"`;
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export async function setupRepository(host: HostServices, session: SessionService, input: { backend: string; repositoryUid: string; branch: string; baseDir: string; install?: boolean }, options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; state: ExecutionState }): Promise<unknown> {
  const { repository, binding, orgSlug } = await repositorySetupInfo(session, input.backend, input.repositoryUid, input.branch);
  const type = repository.code_repository_type;
  if (type !== 'python' && type !== 'vite_react') throw new ToolingError('UNSUPPORTED_ACTION', 'This CodeRepository type is not supported.');
  const cloneUrl = binding.git_ssh_url;
  if (!cloneUrl || !repositorySshKeyIdentity(cloneUrl).usesSsh) throw new ToolingError('INVALID_REQUEST', 'Repository setup requires the existing SSH GitHub binding.');
  const destination = canonicalRepositoryDir(input.baseDir, orgSlug, repository.uid, repository.code_repository_name);
  const env = projectEnvironment({ backend: input.backend }, options.env);
  // No replacement of existing folders. A failed clone is retained for inspection.
  if (await fs.lstat(destination).then(() => true).catch((error: any) => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new ToolingError('INVALID_REQUEST', 'The canonical checkout folder already exists. Select it with --path.');
  }
  options.signal?.throwIfAborted();
  options.state.mutationStarted = true;
  await fs.mkdir(path.resolve(input.baseDir), { recursive: true });
  const baseReal = await fs.realpath(path.resolve(input.baseDir));
  // Reject existing symlink components before creating folders or other setup effects.
  for (const segment of [path.join(path.resolve(input.baseDir), orgSlug), path.dirname(destination)]) {
    const stat = await fs.lstat(segment).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new ToolingError('INVALID_REQUEST', 'The canonical checkout parent must contain ordinary directories, not symlinks.');
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const parentReal = await fs.realpath(path.dirname(destination));
  if (!parentReal.startsWith(baseReal + path.sep)) throw new ToolingError('INVALID_REQUEST', 'The canonical checkout parent escapes the base directory through a symlink.');
  const setupLock = path.join(parentReal, `.${path.basename(destination)}.mainsequence-devtools.lock`);
  return withFileLock(setupLock, async () => {
    if (await fs.lstat(destination).then(() => true).catch((error: any) => { if (error.code === 'ENOENT') return false; throw error; })) throw new ToolingError('INVALID_REQUEST', 'The canonical checkout folder already exists. Select it with --path.');
    const { keyPath, pubPath } = repositorySshKeyPaths(cloneUrl);
    const privateKey = await isFile(keyPath), publicKey = await isFile(pubPath);
    if (privateKey !== publicKey) throw new ToolingError('INVALID_REQUEST', 'The repository SSH keypair is incomplete. Repair it before setup.');
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    if (!privateKey) {
      await execute(host, { executable: 'ssh-keygen', args: ['-t', 'ed25519', '-C', 'mainsequence@main-sequence.io', '-f', keyPath, '-N', ''], cwd: baseReal, env, signal: options.signal, timeoutMs: 30_000 }, options.state, true);
    }
    const key = (await fs.readFile(pubPath, 'utf8')).trim();
    if (!key || /[\r\n]/.test(key)) throw new ToolingError('INVALID_REQUEST', 'The repository SSH public key is invalid.');
    // Register only when access with the repository key is denied, matching VS Code setup.
    env.GIT_SSH_COMMAND = `ssh -i ${quoteSshPath(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    const check = await host.runProcess({ executable: 'git', args: ['ls-remote', '--exit-code', cloneUrl, 'HEAD'], cwd: path.resolve(input.baseDir), env, signal: options.signal, timeoutMs: 15_000 });
    if (check.cancelled) throw new ToolingError('CANCELLED', 'Setup was cancelled.');
    if (check.exitCode !== 0) {
      await session.request(input.backend, 'POST', `/api/v1/code-repositories/${encodeURIComponent(repository.uid)}/add-deploy-key/`, { key_title: repositorySshKeyName(cloneUrl), public_key: key });
      await execute(host, { executable: 'git', args: ['ls-remote', '--exit-code', cloneUrl, 'HEAD'], cwd: path.resolve(input.baseDir), env, signal: options.signal, timeoutMs: 15_000 }, options.state, false);
    }
    host.progress?.('Cloning the registered repository branch into its canonical folder.');
    await execute(host, { executable: 'git', args: ['clone', '--branch', input.branch, '--single-branch', '--', cloneUrl, destination], cwd: baseReal, env, signal: options.signal }, options.state, true);
    const context = await projectContext(host, destination, input.backend, type, env, options.signal);
    if (context.repositoryIdentity !== repositorySshKeyIdentity(cloneUrl).identity || context.branch !== input.branch) throw new ToolingError('INVALID_GIT_CONTEXT', 'The cloned identity or branch does not match the selected repository.');
    await withProjectLock(context.gitCommonDir, async () => {
      await git(host, destination, ['config', 'core.sshCommand', env.GIT_SSH_COMMAND!], options.signal);
      await writeMachineEnv(host, destination, input.backend);
      if (input.install) await runProjectAction(host, session, context, 'install', options);
    });
    return { root: destination, repositoryUid: repository.uid, projectType: type, endpointOnly: true, dependenciesInstalled: Boolean(input.install) };
  });
}
