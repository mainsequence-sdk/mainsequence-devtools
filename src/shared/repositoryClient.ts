import { SessionService, ToolingError } from './models';
import { codeRepositoryFromResponse, codeRepositoryBranchFromResponse, gitHubRepositoryBindingFromResponse, CodeRepository, CodeRepositoryBranch, GitHubRepositoryBinding, CodeRepositoryGitContextResolution } from './repositoryModels';
const AUTH_PATHS = { userDetails: '/api/v1/users/me/' };
const ApiError = Error;
function requiredObject(value: any, label: string): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolingError('API_ERROR', `${label} must be an object.`);
  return value;
}
function requiredSingleLine(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new ToolingError('INVALID_REQUEST', `${label} is required.`);
  return value.trim();
}
export class RepositoryClient {
  constructor(private readonly session: Pick<SessionService, 'request'>, protected readonly backend: string) {}
  async authed(method: 'GET' | 'POST', apiPath: string, body?: unknown) {
    const retrySafe = method === 'GET' || apiPath === '/api/v1/code-repository-branches/resolve-git-context/';
    return { data: await this.session.request<any>(this.backend, method, apiPath, body, retrySafe) };
  }
  async getCurrentUserProfile(): Promise<{username: string, organization: string, uid: string, organizationUid: string}> {
    const details = await this.authed('GET', AUTH_PATHS.userDetails);
    const detailsData = details.data || {};
    const detailsUser = detailsData.user || detailsData;
    const userUid = typeof detailsUser?.uid === 'string' ? detailsUser.uid.trim() : '';
    const detailsOrg = detailsUser?.organization || detailsData.organization || {};
    const org = detailsUser?.organization || detailsOrg || {};
    const orgName = typeof org === 'string'
      ? org
      : (org?.name || org?.slug || detailsUser?.organization_name || detailsData.organization_name || '');
    const organizationUid = typeof org === 'object' && org
      ? (org?.uid || detailsOrg?.uid || '')
      : '';
    return {
      username: detailsUser?.username || '',
      organization: orgName,
      uid: userUid,
      organizationUid
    };
  }

  async getCodeRepositories(): Promise<CodeRepository[]> {
    const r = await this.authed('GET', '/api/v1/code-repositories/');
    const data = r.data || {};
    const results = Array.isArray(data) ? data : data.results || [];
    if (!Array.isArray(results)) throw new ApiError('CodeRepository list returned an unexpected payload.');
    return results.map((value, index) => codeRepositoryFromResponse(value, `CodeRepository list item ${index}`));
  }

  async getCodeRepository(codeRepositoryUid: string): Promise<CodeRepository> {
    const uid = requiredSingleLine(codeRepositoryUid, 'CodeRepository UID');
    const r = await this.authed('GET', `/api/v1/code-repositories/${encodeURIComponent(uid)}/`);
    return codeRepositoryFromResponse(r.data, 'CodeRepository response');
  }

  async getCodeRepositoryBranch(codeRepositoryBranchUid: string): Promise<CodeRepositoryBranch> {
    const uid = requiredSingleLine(codeRepositoryBranchUid, 'CodeRepositoryBranch UID');
    const r = await this.authed('GET', `/api/v1/code-repository-branches/${encodeURIComponent(uid)}/`);
    return codeRepositoryBranchFromResponse(r.data, 'CodeRepositoryBranch response');
  }

  async getGitHubRepositoryBinding(repositoryUid: string): Promise<GitHubRepositoryBinding> {
    const uid = requiredSingleLine(repositoryUid, 'GitHubRepositoryBinding UID');
    const r = await this.authed('GET', `/api/v1/github-repository-bindings/${encodeURIComponent(uid)}/`);
    return gitHubRepositoryBindingFromResponse(r.data, 'GitHubRepositoryBinding response');
  }

  async addCodeRepositoryDeployKey(codeRepositoryUid: string, keyTitle: string, publicKey: string): Promise<void> {
    const uid = requiredSingleLine(codeRepositoryUid, 'CodeRepository UID');
    const title = requiredSingleLine(keyTitle, 'Deploy-key title');
    const key = requiredSingleLine(publicKey, 'Deploy-key public key');
    await this.authed('POST', `/api/v1/code-repositories/${encodeURIComponent(uid)}/add-deploy-key/`, {
      key_title: title, public_key: key
    });
  }

  async resolveCodeRepositoryGitContext(input: {
    repositoryIdentity: string;
    repositoryBranch: string;
    commitSha: string;
  }): Promise<CodeRepositoryGitContextResolution> {
    const repositoryIdentity = requiredSingleLine(input.repositoryIdentity, 'Git repository identity');
    const repositoryBranch = requiredSingleLine(input.repositoryBranch, 'Git branch');
    const commitSha = requiredSingleLine(input.commitSha, 'Git commit').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new ApiError('Git commit must be a canonical full SHA.');
    const r = await this.authed('POST', '/api/v1/code-repository-branches/resolve-git-context/', {
      repository_identity: repositoryIdentity,
      repository_branch: repositoryBranch,
      commit_sha: commitSha
    });
    const payload = requiredObject(r.data, 'Git-context resolution') as CodeRepositoryGitContextResolution;
    const branch = codeRepositoryBranchFromResponse(
      payload.code_repository_branch,
      'Resolved CodeRepositoryBranch'
    );
    if (payload.canonical_repository_identity !== repositoryIdentity) {
      throw new ApiError('Git-context resolution returned another canonical repository identity.');
    }
    if (payload.repository_branch !== repositoryBranch || branch.repository_branch !== repositoryBranch) {
      throw new ApiError('Git-context resolution returned another repository branch.');
    }
    if (payload.repository_ref !== `refs/heads/${repositoryBranch}`) {
      throw new ApiError('Git-context resolution returned another attached Git ref.');
    }
    if (String(payload.commit_sha || '').toLowerCase() !== commitSha) {
      throw new ApiError('Git-context resolution returned another Git commit.');
    }
    return { ...payload, code_repository_branch: branch };
  }
}

