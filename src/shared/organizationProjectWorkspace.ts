import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HostServices, SessionService, ToolingError } from './models';
import { OrganizationProjectClient, projectUid } from './organizationProjects';
import { canonicalRepositoryDir, projectContext, repositorySetupInfo, safeSlug } from './repositories';
import { ExecutionState, setupRepository, withProjectLock, projectEnvironment } from './projects';
import { repositorySshKeyIdentity } from './repositoryIdentity';
import { requireBackend } from './session';

type Input = { backend: string; environmentUid: string; projectUid: string; baseDir: string; instructionsFile?: 'AGENTS.md' | 'CLAUDE.md' };
type Options = { host: HostServices; session: SessionService; env: NodeJS.ProcessEnv; signal?: AbortSignal; state: ExecutionState };
type Checkout = { repositoryUid: string; branchUid: string; name: string; branch: string; path: string; sourcePath: string };
export type OrganizationProjectWorkspace = { root: string; name: string; projectUid: string; environmentUid: string; repositories: Checkout[]; claudeUrl: string };

function workspaceName(name: string): string {
  // Claude displays the folder basename. Keep the actual name, including case and spaces.
  if (!name || name.trim() !== name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
    || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    || Buffer.byteLength(name) > 200 || ['repositories', '.mainsequence-project.json'].includes(name.toLowerCase())) {
    throw new ToolingError('INVALID_REQUEST', 'The project name must be usable as a local folder name. Rename the project before setting it up.');
  }
  return name;
}

async function readManifest(file: string): Promise<any> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ToolingError('INVALID_REQUEST', 'The project workspace manifest must be an ordinary file.');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new ToolingError('INVALID_REQUEST', 'The project workspace manifest is unreadable.'); }
}

/** Read prepared membership, not a claim that any running Claude session has attached it. */
export async function readOrganizationProjectWorkspace(root: string): Promise<OrganizationProjectWorkspace & { backend: string }> {
  if (!path.isAbsolute(root)) throw new ToolingError('INVALID_REQUEST', 'Choose an absolute project workspace folder.');
  root = path.resolve(root);
  await ordinaryDirectory(root);
  const manifest = await readManifest(path.join(root, '.mainsequence-project.json'));
  const container = path.dirname(root);
  const canonical = await readManifest(path.join(container, '.mainsequence-project.json'));
  if (manifest.schemaVersion !== 2 || manifest.status !== 'ready' || manifest.root !== root
    || path.basename(root) !== workspaceName(manifest.name) || JSON.stringify(manifest) !== JSON.stringify(canonical)
    || !Array.isArray(manifest.repositories) || !manifest.repositories.length) {
    throw new ToolingError('INVALID_REQUEST', 'Set up this project again before opening its workspace.');
  }
  projectUid(manifest.projectUid); projectUid(manifest.environmentUid); requireBackend(manifest.backend);
  const paths = new Set<string>(), branches = new Set<string>();
  for (const row of manifest.repositories) {
    projectUid(row.repositoryUid); projectUid(row.branchUid);
    const relative = typeof row.path === 'string' ? path.relative(path.join(container, 'repositories'), row.path) : '';
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !path.isAbsolute(row.path) || paths.has(row.path) || branches.has(row.branchUid)
      || typeof row.branch !== 'string' || !row.branch || /[\r\n\0]/.test(row.branch)) {
      throw new ToolingError('INVALID_REQUEST', 'The project repository membership is invalid. Set up this project again.');
    }
    paths.add(row.path); branches.add(row.branchUid);
    await ordinaryDirectory(row.path);
    await ordinaryDirectory(path.join(row.path, '.git'));
    if (!await exists(path.join(row.path, '.git'))) throw new ToolingError('INVALID_REQUEST', 'A project checkout is missing. Set up this project again.');
  }
  const url = new URL('claude://code/new'); url.searchParams.set('folder', root);
  return { root, name: manifest.name, backend: manifest.backend, projectUid: manifest.projectUid,
    environmentUid: manifest.environmentUid, repositories: manifest.repositories, claudeUrl: url.href };
}

async function exists(file: string): Promise<boolean> { return fs.lstat(file).then(() => true).catch((error: any) => { if (error.code === 'ENOENT') return false; throw error; }); }
async function ordinaryDirectory(directory: string, create = false): Promise<void> {
  const resolved = path.resolve(directory), parent = path.dirname(resolved);
  if (parent !== resolved) await ordinaryDirectory(parent, create);
  const stat = await fs.lstat(resolved).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new ToolingError('INVALID_REQUEST', `Use ordinary directories for the project workspace: ${resolved}`);
  if (!stat && create) {
    await fs.mkdir(resolved).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
    await ordinaryDirectory(resolved);
  }
}
async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function namedDirectory(parent: string, name: string, uid: string): Promise<string> {
  await ordinaryDirectory(parent);
  const names = await exists(parent) ? (await fs.readdir(parent)).filter(value => value === uid || value.endsWith(`-${uid}`)) : [];
  if (names.length > 1) throw new ToolingError('INVALID_REQUEST', `Multiple workspace folders match ${uid}. Resolve the duplicate folders first.`);
  return path.join(parent, names[0] || `${safeSlug(name)}-${uid}`);
}

/** Stable, independent branch checkouts. No reset, stash, force checkout, deletion or automatic pull. */
export async function setupOrganizationProject(input: Input, options: Options): Promise<OrganizationProjectWorkspace> {
  const { session, signal, state } = options;
  if (input.instructionsFile !== undefined && !['AGENTS.md','CLAUDE.md'].includes(input.instructionsFile)) throw new ToolingError('INVALID_REQUEST','Choose AGENTS.md or CLAUDE.md instructions.');

  const backend = requireBackend(input.backend), environmentUid = projectUid(input.environmentUid), uid = projectUid(input.projectUid);
  const env = projectEnvironment({ backend }, options.env);
  // Apply the same environment to nested Git helpers, including context and .env setup.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_SSH_COMMAND') delete env[key];
  const host: HostServices = { ...options.host, runProcess: spec => options.host.runProcess({ ...spec, env: spec.env ?? env }) };
  if (typeof input.baseDir !== 'string' || !path.isAbsolute(input.baseDir) || /[\r\n\0]/.test(input.baseDir)) throw new ToolingError('INVALID_REQUEST', 'Choose an absolute repositories base folder in General.');
  // Resolve the base once (macOS /tmp and home aliases are legitimate). Children must be ordinary directories.
  let base = path.resolve(input.baseDir);
  if (await exists(base)) base = await fs.realpath(base);
  const client = new OrganizationProjectClient(session, backend, signal);
  const { project, branches } = await client.getProject(environmentUid, uid);
  const displayName = workspaceName(project.name);
  if (!branches.length) throw new ToolingError('INVALID_REQUEST', 'This project has no accessible branches to set up.');
  if (branches.length !== project.code_repository_branch_uids.length) throw new ToolingError('API_ERROR', 'Project membership changed. Refresh it before setting up locally.');
  const infos = [];
  for (const branch of branches) {
    signal?.throwIfAborted();
    const info = await repositorySetupInfo(session, backend, branch.code_repository_uid, branch.repository_branch);
    if (info.branch.uid !== branch.uid) throw new ToolingError('API_ERROR', 'The selected project branch identity changed.');
    infos.push(info);
  }
  const org = infos[0].orgSlug;
  if (infos.some(info => info.orgSlug !== org)) throw new ToolingError('API_ERROR', 'The project repositories belong to different organizations.');
  // The UID identifies the storage container, never the folder opened/displayed by Claude.
  // Repositories are siblings of the named workspace: /add-dir must register each one,
  // instead of treating nested checkouts as already covered by the working directory.
  const container = await namedDirectory(path.join(base, org, 'organization-projects', createHash('sha256').update(backend).digest('hex').slice(0, 16)), project.name, uid);
  const root = path.join(container, displayName);
  const manifestPath = path.join(container, '.mainsequence-project.json');
  await ordinaryDirectory(container);
  let prior: any;
  if (await exists(manifestPath)) {
    prior = await readManifest(manifestPath);
    if (![1, 2].includes(prior.schemaVersion) || prior.backend !== backend || prior.projectUid !== uid || prior.environmentUid !== environmentUid) throw new ToolingError('INVALID_REQUEST', 'This workspace belongs to another project or backend.');
  } else if (await exists(container) && (await fs.readdir(container)).length) throw new ToolingError('INVALID_REQUEST', 'The workspace folder already contains unmanaged files. Choose another base folder.');
  await ordinaryDirectory(root);
  if (await exists(root) && (await fs.readdir(root)).length && prior?.root !== root) throw new ToolingError('INVALID_REQUEST', 'The named workspace folder already contains files. Resolve the folder collision before retrying.');

  const run = async (cwd: string, args: string[], mutation = false) => {
    signal?.throwIfAborted(); if (mutation) state.mutationStarted = true;
    const result = await host.runProcess({ executable: 'git', args, cwd, env, signal, timeoutMs: 120_000 });
    if (result.cancelled) throw new ToolingError('CANCELLED', 'Project setup was cancelled. Completed checkouts are retained.');
    if (result.exitCode !== 0) throw new ToolingError('PROCESS_FAILED', `Git could not ${args[0]} in ${cwd}. Existing files were preserved; inspect the checkout before retrying.`);
    return result.stdout.trim();
  };
  const repositories: Checkout[] = [];
  for (const info of infos) {
    const branch = info.branch;
    let sourcePath = canonicalRepositoryDir(base, org, info.repository.uid, info.repository.code_repository_name);
    const sourceParent = path.dirname(sourcePath);
    await ordinaryDirectory(sourceParent);
    if (!await exists(sourcePath) && await exists(sourceParent)) {
      const matches = (await fs.readdir(sourceParent)).filter(name => name.endsWith(`-${info.repository.uid}`));
      if (matches.length > 1) throw new ToolingError('INVALID_REQUEST', 'Multiple local repositories match this repository UID. Resolve the duplicate folders first.');
      if (matches.length === 1) sourcePath = path.join(sourceParent, matches[0]);
    }
    const repositoryFolder = await namedDirectory(path.join(container, 'repositories'), info.repository.code_repository_name, info.repository.uid);
    const target = await namedDirectory(repositoryFolder, branch.repository_branch, branch.uid);
    for (const candidate of [sourcePath, target]) {
      await ordinaryDirectory(candidate);
      if (!await exists(candidate)) continue;
      const gitDir = path.join(candidate, '.git');
      if (!await exists(gitDir) || (await fs.lstat(gitDir)).isSymbolicLink() || !(await fs.lstat(gitDir)).isDirectory()) throw new ToolingError('INVALID_REQUEST', 'Project setup requires standalone repository checkouts.');
      const origin = await run(candidate, ['remote', 'get-url', 'origin']);
      if (repositorySshKeyIdentity(origin).identity !== repositorySshKeyIdentity(info.binding.git_ssh_url || '').identity) throw new ToolingError('INVALID_GIT_CONTEXT', `The checkout origin does not match ${info.repository.code_repository_name}.`);
      if (candidate === target && await run(candidate, ['symbolic-ref', '--short', 'HEAD']) !== branch.repository_branch && await run(candidate, ['status', '--porcelain'])) throw new ToolingError('INVALID_REQUEST', `Commit or stash changes in ${candidate} before switching its branch.`);
    }
    repositories.push({ repositoryUid: info.repository.uid, branchUid: branch.uid, name: info.repository.code_repository_name, branch: branch.repository_branch, path: target, sourcePath });
  }
  // Phase 1: ensure the ordinary repository exists, without switching existing source checkouts.
  for (const row of repositories) {
    if (!await exists(row.sourcePath)) {
      host.progress?.(`Preparing repository ${row.name}.`);
      await setupRepository(host, session, { backend, repositoryUid: row.repositoryUid, branch: row.branch, baseDir: base }, { env, signal, state });
    }
  }
  signal?.throwIfAborted(); state.mutationStarted = true;
  await ordinaryDirectory(container, true);
  return withProjectLock(container, async () => {
    if (prior?.schemaVersion === 2 && prior.root !== root) {
      const previousRoot = path.join(container, workspaceName(prior.name));
      if (prior.root !== previousRoot) throw new ToolingError('INVALID_REQUEST', 'The previous workspace location is invalid.');
      await ordinaryDirectory(previousRoot);
      if (await exists(previousRoot)) {
        if (await exists(root)) throw new ToolingError('INVALID_REQUEST', 'The renamed workspace folder already exists.');
        await fs.rename(previousRoot, root);
      }
    }
    await ordinaryDirectory(root, true);
    const manifest = { schemaVersion: 2, backend, environmentUid, projectUid: uid, name: project.name, root, repositories, status: 'preparing' };
    // Phase 2: persist the stable Claude workspace before preparing its individual checkouts.
    await atomicJson(manifestPath, manifest);
    await atomicJson(path.join(root, '.mainsequence-project.json'), manifest);
    // Phase 3: each membership gets its own attached branch, including several branches of one repository.
    for (const row of repositories) {
      signal?.throwIfAborted();
      host.progress?.(`Preparing ${row.name} on ${row.branch}.`);
      if (!await exists(row.path)) {
        await setupRepository(host, session, { backend, repositoryUid: row.repositoryUid, branch: row.branch, baseDir: container }, { env, signal, state, destination: row.path, reference: row.sourcePath });
      } else {
        const context = await projectContext(host, row.path, backend, undefined, env, signal);
        await withProjectLock(context.gitCommonDir, async () => {
          if (context.branch === row.branch) return;
          if (await run(row.path, ['status', '--porcelain'])) throw new ToolingError('INVALID_REQUEST', `Commit or stash changes in ${row.path} before switching its branch.`);
          await run(row.path, ['check-ref-format', '--branch', row.branch]);
          await run(row.path, ['fetch', '--', 'origin', `refs/heads/${row.branch}:refs/remotes/origin/${row.branch}`], true);
          const local = await host.runProcess({ executable: 'git', args: ['show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`], cwd: row.path, env, signal });
          if (local.cancelled) throw new ToolingError('CANCELLED', 'Project setup was cancelled.');
          if (![0, 1].includes(local.exitCode ?? -1)) throw new ToolingError('INVALID_GIT_CONTEXT', 'Could not inspect the local branch.');
          await run(row.path, local.exitCode === 0 ? ['switch', '--no-guess', '--', row.branch] : ['switch', '--create', row.branch, '--track', `origin/${row.branch}`], true);
        });
      }
      if (await run(row.path, ['symbolic-ref', '--short', 'HEAD']) !== row.branch) throw new ToolingError('INVALID_GIT_CONTEXT', 'The checkout did not select the project branch.');
    }
    const instructionsFile = input.instructionsFile ?? 'CLAUDE.md';
    if (!['AGENTS.md', 'CLAUDE.md'].includes(instructionsFile)) throw new ToolingError('INVALID_REQUEST', 'Choose AGENTS.md or CLAUDE.md instructions.');
    const instructions = path.join(root, instructionsFile);
    if (!await exists(instructions)) {
      const legacyInstructions = path.join(container, 'CLAUDE.md');
      const content = instructionsFile === 'CLAUDE.md' && prior?.schemaVersion === 1 && await exists(legacyInstructions)
        ? await fs.readFile(legacyInstructions, 'utf8')
        : '# MainSequence workspace\n\nThe project repositories and their assigned branches are listed in `.mainsequence-project.json`.\nThe MainSequence plugin adds each repository to this Claude session with `/add-dir`.\nWork inside the appropriate repository directory; each checkout has its own Git history and instructions.\n';
      await fs.writeFile(instructions, instructionsFile === 'AGENTS.md' ? content.replace('The MainSequence plugin adds each repository to this Claude session with `/add-dir`.','Open the repository paths listed in the manifest in your editor. Grant access to each checkout before working in it.') : content, { flag: 'wx' });
    }
    await atomicJson(manifestPath, { ...manifest, status: 'ready' });
    await atomicJson(path.join(root, '.mainsequence-project.json'), { ...manifest, status: 'ready' });
    const claudeUrl = new URL('claude://code/new'); claudeUrl.searchParams.set('folder', root);
    return { root, name: project.name, projectUid: uid, environmentUid, repositories, claudeUrl: claudeUrl.href };
  });
}
