// Git identity and canonical layout extracted from the VS Code extension.
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { HostServices, ProjectContext, ProjectType, SessionService, ToolingError } from './models';
import { requireBackend } from './session';
import { repositorySshKeyIdentity } from './repositoryIdentity';
import { RepositoryClient } from './repositoryClient';
import { codeRepositoryBranchFromResponse, codeRepositoryFromResponse, gitHubRepositoryBindingFromResponse, CodeRepository, CodeRepositoryGitContextResolution } from './repositoryModels';
import { mainSequenceStateDirectory } from './stateDirectory';

export async function readProjectEnv(root: string): Promise<Record<string, string>> {
  let text: string;
  try { text = await fs.readFile(path.join(root, '.env'), 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw new ToolingError('INVALID_REQUEST', 'The project .env could not be read.'); }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}
export async function resolveBackend(explicit?: string, root?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (explicit) return requireBackend(explicit);
  if (env.MAINSEQUENCE_ENDPOINT) return requireBackend(env.MAINSEQUENCE_ENDPOINT);
  if (root) {
    const projectEnv = await readProjectEnv(root);
    if (projectEnv.MAINSEQUENCE_ENDPOINT) return requireBackend(projectEnv.MAINSEQUENCE_ENDPOINT);
  }
  return (await readWorkspacePreferences({ env })).backend;
}

/** Resolve non-secret workspace settings without requiring a session or writing configuration. */
export async function readWorkspacePreferences(options: { env?: NodeJS.ProcessEnv; configPath?: string; homeDir?: string } = {}): Promise<{ backend: string; baseDir: string }> {
  const env = options.env ?? process.env, home = options.homeDir ?? os.homedir();
  const directory = mainSequenceStateDirectory(env, home);
  const config = await fs.readFile(options.configPath ?? path.join(directory, 'config.json'), 'utf8')
    .then(text => JSON.parse(text)).catch(() => ({}));
  const folder = config?.mainsequence_path;
  return { backend: requireBackend(env.MAINSEQUENCE_ENDPOINT || (typeof config?.backend_url === 'string' && config.backend_url.trim()) || 'https://api.main-sequence.app'),
    baseDir: typeof folder === 'string' && path.isAbsolute(folder) && !/[\0\r\n]/.test(folder) ? folder : path.join(home, 'mainsequence') };
}

export async function git(host: HostServices, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await host.runProcess({ executable: 'git', args, cwd, signal, timeoutMs: 15_000 });
  if (result.cancelled) throw new ToolingError('CANCELLED', 'The action was cancelled.');
  if (result.exitCode !== 0) throw new ToolingError('INVALID_GIT_CONTEXT', 'Git could not resolve the required worktree, attached branch, commit, or origin.');
  return result.stdout.trim();
}
export async function projectContext(host: HostServices, root: string, backend?: string, projectType?: ProjectType, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ProjectContext> {
  let requested: string;
  try { requested = await fs.realpath(path.resolve(root)); } catch { throw new ToolingError('PROJECT_NOT_FOUND', 'The project directory does not exist.'); }
  const resolved = await fs.realpath(await git(host, requested, ['rev-parse', '--show-toplevel'], signal));
  const relative = path.relative(resolved, requested);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new ToolingError('INVALID_GIT_CONTEXT', 'Git resolved a worktree outside the selected project directory. Check inherited Git environment overrides.');
  const ref = await git(host, resolved, ['symbolic-ref', '--quiet', 'HEAD'], signal);
  if (!ref.startsWith('refs/heads/')) throw new ToolingError('INVALID_GIT_CONTEXT', 'An attached Git branch is required.');
  const branch = ref.slice('refs/heads/'.length);
  const commit = (await git(host, resolved, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new ToolingError('INVALID_GIT_CONTEXT', 'A full Git commit SHA is required.');
  let remote: string;
  try { remote = await git(host, resolved, ['config', '--get', `branch.${branch}.remote`], signal); } catch { remote = ''; }
  if (!remote || remote === '.') {
    const remotes = (await git(host, resolved, ['remote'], signal)).split(/\r?\n/).filter(Boolean);
    remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
  }
  if (!remote) throw new ToolingError('INVALID_GIT_CONTEXT', 'The project Git remote is ambiguous.');
  const origin = await git(host, resolved, ['remote', 'get-url', remote], signal);
  let identity: string;
  try { identity = repositorySshKeyIdentity(origin).identity; } catch { throw new ToolingError('INVALID_GIT_CONTEXT', 'The Git origin is not a supported repository URL.'); }
  const common = await git(host, resolved, ['rev-parse', '--git-common-dir'], signal);
  const backendUrl = await resolveBackend(backend, resolved, env);
  const type = projectType ?? await detectProjectType(resolved);
  return { root: resolved, projectType: type, backend: backendUrl, origin: safeOrigin(origin), repositoryIdentity: identity, branch, ref, commit, gitCommonDir: path.resolve(resolved, common) };
}
function safeOrigin(origin: string): string {
  if (!origin.includes('://')) return origin;
  const parsed = new URL(origin);
  parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
  return parsed.toString();
}
export async function detectProjectType(root: string): Promise<ProjectType | undefined> {
  const python = await fs.stat(path.join(root, 'pyproject.toml')).then(s => s.isFile()).catch(() => false);
  const node = await fs.readFile(path.join(root, 'package.json'), 'utf8').then(text => {
    const pkg = JSON.parse(text);
    return Boolean(pkg.dependencies?.['@dev-mainsequence/command-center-sdk'] || pkg.devDependencies?.['@dev-mainsequence/command-center-sdk']);
  }).catch(() => false);
  return python === node ? undefined : python ? 'python' : 'vite_react';
}
export async function listRepositories(session: SessionService, backend: string): Promise<CodeRepository[]> {
  const payload = await session.request<any>(backend, 'GET', '/api/v1/code-repositories/');
  const values = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(values)) throw new ToolingError('API_ERROR', 'The backend repository list has an invalid shape.');
  return values.map((value, index) => codeRepositoryFromResponse(value, `CodeRepository ${index}`));
}
export async function resolveRepository(session: SessionService, context: ProjectContext): Promise<CodeRepositoryGitContextResolution> {
  return new RepositoryClient(session, context.backend).resolveCodeRepositoryGitContext({ repositoryIdentity: context.repositoryIdentity, repositoryBranch: context.branch, commitSha: context.commit });
}
export async function repositorySetupInfo(session: SessionService, backend: string, uid: string, branchName: string) {
  const repository = codeRepositoryFromResponse(await session.request(backend, 'GET', `/api/v1/code-repositories/${encodeURIComponent(uid)}/`), 'CodeRepository');
  if (repository.uid !== uid) throw new ToolingError('API_ERROR', 'The backend returned another CodeRepository.');
  const summary = repository.branches.find(branch => branch.repository_branch === branchName);
  if (!summary) throw new ToolingError('INVALID_REQUEST', 'The requested branch is not registered for this CodeRepository.');
  const branch = codeRepositoryBranchFromResponse(await session.request(backend, 'GET', `/api/v1/code-repository-branches/${encodeURIComponent(summary.uid)}/`), 'CodeRepositoryBranch');
  if (branch.uid !== summary.uid || branch.code_repository_uid !== uid || branch.repository_branch !== branchName) throw new ToolingError('API_ERROR', 'The backend returned another repository branch.');
  if (!branch.is_initialized) throw new ToolingError('INVALID_REQUEST', 'This CodeRepositoryBranch has not finished initializing.');
  const bindingUid = branch.github_repository_binding_uid || repository.github_repository_binding_uid;
  if (!bindingUid) throw new ToolingError('API_ERROR', 'This repository has no GitHub binding.');
  const binding = gitHubRepositoryBindingFromResponse(await session.request(backend, 'GET', `/api/v1/github-repository-bindings/${encodeURIComponent(bindingUid)}/`), 'GitHub binding');
  if (binding.code_repository_uid !== uid || binding.uid !== bindingUid) throw new ToolingError('API_ERROR', 'The GitHub binding belongs to another repository.');
  const profile = await session.request<any>(backend, 'GET', '/api/v1/users/me/');
  const user = profile?.user || profile;
  const organization = user?.organization || profile?.organization || {};
  const orgName = typeof organization === 'string' ? organization : organization.name || organization.slug || organization.uid || 'default';
  return { repository, branch, binding, orgSlug: safeSlug(orgName) };
}
export function safeSlug(value: string): string {
  return String(value || 'code-repository').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'code-repository';
}
export function canonicalRepositoryDir(base: string, org: string, uid: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(uid) || uid === '.' || uid === '..') throw new ToolingError('INVALID_REQUEST', 'The CodeRepository UID must be a filesystem-safe segment.');
  return path.join(path.resolve(base), safeSlug(org), 'projects', `${safeSlug(name)}-${uid}`);
}
