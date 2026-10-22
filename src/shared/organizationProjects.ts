import { SessionService, ToolingError } from './models';
import { requireBackend } from './session';
import { codeRepositoryBranchFromResponse, CodeRepositoryBranch } from './repositoryModels';
import { RepositoryClient } from './repositoryClient';
import { listEnvironments } from './environments';

export type OrganizationProject = { uid: string; organization_environment_uid: string; name: string; description: string; code_repository_branch_uids: string[] };
export type OrganizationProjectBranch = CodeRepositoryBranch & { organization_environment_uid: string; code_repository_type: string };
export type OrganizationProjectPage = { results: OrganizationProject[]; count: number; limit: number; offset: number };
export type OrganizationEnvironment = { uid: string; name: string };
export type OrganizationProjectRequest = { backend?: string; expectedAccount?: string } & (
  | { action: 'organization-environments' }
  | { action: 'organization-projects'; environmentUid: string; search?: string; limit?: number; offset?: number }
  | { action: 'organization-project'; environmentUid: string; projectUid: string }
  | { action: 'organization-project-link'; environmentUid: string; projectUid: string; branchUid?: string; target: 'project' | 'repository' | 'branch'; commandCenterUrl?: string }
  | { action: 'organization-project-setup'; environmentUid: string; projectUid: string; baseDir: string }
);

export function projectUid(value: unknown, label = 'UID'): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new ToolingError('INVALID_REQUEST', `${label} must be a UUID.`);
  return value.toLowerCase();
}
function object(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolingError('API_ERROR', 'The project service returned an invalid object.');
  return value;
}
function line(value: any, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new ToolingError('API_ERROR', `Invalid ${label}.`);
  return value;
}
function project(value: unknown, environmentUid: string): OrganizationProject {
  const row = object(value);
  if (projectUid(row.organization_environment_uid) !== environmentUid || !Array.isArray(row.code_repository_branch_uids) || typeof row.description !== 'string') throw new ToolingError('API_ERROR', 'The project response does not match the selected environment.');
  return { uid: projectUid(row.uid), organization_environment_uid: environmentUid, name: line(row.name, 'project name'), description: row.description,
    code_repository_branch_uids: [...new Set<string>(row.code_repository_branch_uids.map((uid: unknown) => projectUid(uid, 'Branch UID')))] };
}
function pageValues(value: unknown): { results: any[]; count: number } {
  const payload = object(value);
  if (!Array.isArray(payload.results) || !Number.isSafeInteger(payload.count) || payload.count < 0) throw new ToolingError('API_ERROR', 'The project service returned an invalid page.');
  return { results: payload.results, count: payload.count };
}
function webUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ToolingError('INVALID_REQUEST', 'Enter an absolute Command Center or repository web URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ToolingError('INVALID_REQUEST', 'Links must use HTTP(S) without embedded credentials.');
  return url;
}

/** Human desktop clients: exact environment scope, branch membership and permission-filtered data. */
export class OrganizationProjectClient {
  readonly backend: string;
  constructor(private readonly session: Pick<SessionService, 'request'>, backend: string, private readonly signal?: AbortSignal) { this.backend = requireBackend(backend); }
  private async get(apiPath: string): Promise<unknown> { this.signal?.throwIfAborted(); return this.session.request(this.backend, 'GET', apiPath); }
  async environments(): Promise<OrganizationEnvironment[]> {
    return (await listEnvironments(this.session, this.backend, this.signal)).map(({ uid, name }) => ({ uid, name }));
  }
  async list(environment: string, options: { search?: string; limit?: number; offset?: number } = {}): Promise<OrganizationProjectPage> {
    const environmentUid = projectUid(environment, 'Environment UID'), limit = options.limit ?? 25, offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || (options.search !== undefined && typeof options.search !== 'string')) throw new ToolingError('INVALID_REQUEST', 'Invalid project pagination or search.');
    const query = new URLSearchParams({ organization_environment_uid: environmentUid, limit: String(limit), offset: String(offset), ordering: 'name' });
    if (options.search?.trim()) query.set('search', options.search.trim());
    const payload = pageValues(await this.get(`/api/v1/organization-projects/?${query}`));
    return { results: payload.results.map(row => project(row, environmentUid)), count: payload.count, limit, offset };
  }
  async detail(environment: string, uid: string): Promise<OrganizationProject> {
    const environmentUid = projectUid(environment, 'Environment UID'), selectedUid = projectUid(uid, 'Project UID');
    const selected = project(await this.get(`/api/v1/organization-projects/${selectedUid}/`), environmentUid);
    if (selected.uid !== selectedUid) throw new ToolingError('API_ERROR', 'The backend returned another project.');
    return selected;
  }
  async branches(selected: OrganizationProject): Promise<OrganizationProjectBranch[]> {
    const payload = await this.get(`/api/v1/organization-projects/${projectUid(selected.uid)}/code-repository-branches/`);
    if (!Array.isArray(payload)) throw new ToolingError('API_ERROR', 'The project branch response must be an array.');
    const seen = new Set<string>();
    return payload.map(value => {
      const branch = codeRepositoryBranchFromResponse(value, 'Project branch');
      const uid = projectUid(branch.uid), environment = projectUid(value.organization_environment_uid);
      if (seen.has(uid) || environment !== selected.organization_environment_uid || !selected.code_repository_branch_uids.includes(uid)) throw new ToolingError('API_ERROR', 'Project membership changed or contains an invalid branch. Refresh the project.');
      seen.add(uid);
      return { ...branch, uid, code_repository_uid: projectUid(branch.code_repository_uid), organization_environment_uid: environment, code_repository_type: line(value.code_repository_type, 'repository type') };
    });
  }
  async getProject(environment: string, uid: string) { const selected = await this.detail(environment, uid); return { project: selected, branches: await this.branches(selected) }; }
  async link(input: Extract<OrganizationProjectRequest, { action: 'organization-project-link' }>): Promise<string> {
    const selected = await this.detail(input.environmentUid, input.projectUid);
    if (!['project', 'repository', 'branch'].includes(input.target)) throw new ToolingError('INVALID_REQUEST', 'Choose a project, repository or branch link.');
    const branch = input.target === 'project' ? undefined : (await this.branches(selected)).find(row => row.uid === projectUid(input.branchUid, 'Branch UID'));
    if (input.target !== 'project' && !branch) throw new ToolingError('INVALID_REQUEST', 'The selected branch is no longer a member of this project.');
    if (input.commandCenterUrl?.trim()) {
      const url = webUrl(input.commandCenterUrl.trim());
      url.pathname = `/app/main-sequence-foundry/${branch ? 'code-repositories' : 'projects'}`; url.search = ''; url.hash = '';
      if (branch) { url.searchParams.set('msCodeRepositoryUid', branch.code_repository_uid); if (input.target === 'branch') url.searchParams.set('msCodeRepositoryBranchUid', branch.uid); url.searchParams.set('msTab', 'code'); }
      else url.searchParams.set('msProjectUid', selected.uid);
      return url.href;
    }
    if (!branch?.github_repository_binding_uid) throw new ToolingError('INVALID_REQUEST', 'Set the Command Center URL in General to open this resource.');
    const binding = await new RepositoryClient(this.session, this.backend).getGitHubRepositoryBinding(branch.github_repository_binding_uid);
    if (binding.uid !== branch.github_repository_binding_uid || binding.code_repository_uid !== branch.code_repository_uid) throw new ToolingError('API_ERROR', 'The repository link does not match the selected branch.');
    if (!binding.git_repo_url) throw new ToolingError('INVALID_REQUEST', 'No repository web link is available. Set the Command Center URL in General.');
    const url = webUrl(binding.git_repo_url); url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '');
    if (input.target === 'branch') url.pathname += '/tree/' + encodeURIComponent(branch.repository_branch);
    return url.href;
  }
}
