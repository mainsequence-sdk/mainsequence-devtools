import { ToolingError } from './models';
class ApiError extends ToolingError { constructor(message: string) { super('API_ERROR', message); } }
export type CodeRepositoryBranchSummary = {
  uid: string;
  repository_branch: string;
};

export type CodeRepository = {
  uid: string;
  code_repository_name: string;
  code_repository_type: string;
  primary_language: string;
  framework: string;
  github_repository_binding_uid?: string | null;
  branches: CodeRepositoryBranchSummary[];
};

export type CodeRepositoryBranch = {
  uid: string;
  code_repository_uid: string;
  code_repository_name: string;
  repository_branch: string;
  github_repository_binding_uid?: string | null;
  is_initialized: boolean;
};

export type GitHubRepositoryBinding = {
  uid: string;
  code_repository_uid: string;
  code_repository_name: string;
  repo_name: string;
  github_full_name: string;
  git_ssh_url?: string | null;
  git_repo_url?: string | null;
};

export type CodeRepositoryGitContextResolution = {
  canonical_repository_identity: string;
  repository_branch: string;
  repository_ref: string;
  commit_sha: string;
  code_repository_branch: CodeRepositoryBranch;
};

function requiredSingleLine(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || /[\r\n]/.test(normalized)) throw new ApiError(`${label} is required.`);
  return normalized;
}

function requiredObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(`${label} must be an object.`);
  }
  return value as Record<string, any>;
}

function optionalSingleLine(value: unknown, label: string): string | null | undefined {
  if (value == null) return value as null | undefined;
  return requiredSingleLine(value, label);
}

export function codeRepositoryFromResponse(value: unknown, label: string): CodeRepository {
  const payload = requiredObject(value, label);
  if (!Array.isArray(payload.branches)) throw new ApiError(`${label}.branches must be an array.`);
  return {
    uid: requiredSingleLine(payload.uid, `${label} UID`),
    code_repository_name: requiredSingleLine(payload.code_repository_name, `${label} name`),
    code_repository_type: requiredSingleLine(payload.code_repository_type, `${label} type`),
    primary_language: requiredSingleLine(payload.primary_language, `${label} primary language`),
    framework: requiredSingleLine(payload.framework, `${label} framework`),
    github_repository_binding_uid: optionalSingleLine(
      payload.github_repository_binding_uid,
      `${label} GitHubRepositoryBinding UID`
    ),
    branches: payload.branches.map((branch, index) => {
      const item = requiredObject(branch, `${label}.branches[${index}]`);
      return {
        uid: requiredSingleLine(item.uid, `${label}.branches[${index}] UID`),
        repository_branch: requiredSingleLine(
          item.repository_branch,
          `${label}.branches[${index}] repository branch`
        )
      };
    })
  };
}

export function codeRepositoryBranchFromResponse(value: unknown, label: string): CodeRepositoryBranch {
  const payload = requiredObject(value, label);
  if (typeof payload.is_initialized !== 'boolean') {
    throw new ApiError(`${label}.is_initialized must be a boolean.`);
  }
  return {
    uid: requiredSingleLine(payload.uid, `${label} UID`),
    code_repository_uid: requiredSingleLine(payload.code_repository_uid, `${label} CodeRepository UID`),
    code_repository_name: requiredSingleLine(payload.code_repository_name, `${label} CodeRepository name`),
    repository_branch: requiredSingleLine(payload.repository_branch, `${label} repository branch`),
    github_repository_binding_uid: optionalSingleLine(
      payload.github_repository_binding_uid,
      `${label} GitHubRepositoryBinding UID`
    ),
    is_initialized: payload.is_initialized
  };
}

export function gitHubRepositoryBindingFromResponse(value: unknown, label: string): GitHubRepositoryBinding {
  const payload = requiredObject(value, label);
  return {
    uid: requiredSingleLine(payload.uid, `${label} UID`),
    code_repository_uid: requiredSingleLine(payload.code_repository_uid, `${label} CodeRepository UID`),
    code_repository_name: requiredSingleLine(payload.code_repository_name, `${label} CodeRepository name`),
    repo_name: requiredSingleLine(payload.repo_name, `${label} repository name`),
    github_full_name: requiredSingleLine(payload.github_full_name, `${label} GitHub full name`),
    git_ssh_url: optionalSingleLine(payload.git_ssh_url, `${label} SSH URL`),
    git_repo_url: optionalSingleLine(payload.git_repo_url, `${label} Git URL`)
  };
}
