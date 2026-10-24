import type { McpRequest } from './mcp';
import { credentialStoreFailure, type CredentialStoreFailureReason } from './credentialStoreFailure';
import type { AgentRequest } from './agents';
import type { OrganizationProjectRequest } from './organizationProjects';
export type ProjectType = 'python' | 'vite_react';
export type ProjectAction = 'sync' | 'sdk-status' | 'update-sdk' | 'update-agents' | 'install-skills' | 'skills-sync' | 'install' | 'env-cleanup' | 'open-folder' | 'signed-terminal';
/**
 * @deprecated `freeze-env` was removed: `sync` now writes the locked requirements.txt. The request type
 * still names it so existing callers compile; dispatch reports UNSUPPORTED_ACTION.
 */
export type RetiredProjectAction = 'freeze-env';
type BackendSelection = { backend?: string };
export type ActionRequest = McpRequest | AgentRequest | OrganizationProjectRequest
  | (BackendSelection & { action: 'login' | 'logout' | 'refresh-token' })
  | (BackendSelection & { action: 'auth-status'; check?: boolean })
  | (BackendSelection & { action: 'repositories' })
  | (BackendSelection & { action: 'status' | 'resolve'; root: string; projectType?: ProjectType })
  | (BackendSelection & {
    action: ProjectAction | RetiredProjectAction; root: string; projectType?: ProjectType;
    /** @deprecated Ignored. `sync` refreshes dependency files only and takes no commit message. */
    message?: string;
    /** Only update-sdk and install-skills have a dry-run mode. */
    dryRun?: boolean;
  })
  | (BackendSelection & { action: 'setup'; repositoryUid: string; branch: string; baseDir: string; install?: boolean });

export type ErrorCode = 'CURRENT_DIRECTORY_UNAVAILABLE' | 'INVALID_REQUEST' | 'NOT_AUTHENTICATED' | 'AUTH_REJECTED' | 'STORE_UNAVAILABLE' | 'STORE_ERROR' | 'PERSISTENCE_FAILED' | 'BACKEND_UNREACHABLE' | 'API_ERROR' | 'MCP_TOOL_ERROR' | 'BROWSER_FAILED' | 'LOGIN_TIMEOUT' | 'INVALID_CALLBACK' | 'PROJECT_NOT_FOUND' | 'INVALID_GIT_CONTEXT' | 'PROJECT_TYPE_REQUIRED' | 'BACKEND_MISMATCH' | 'MISSING_PREREQUISITE' | 'UNSUPPORTED_ACTION' | 'PROJECT_BUSY' | 'PROCESS_FAILED' | 'PROCESS_TIMEOUT' | 'CANCELLED' | 'INTERNAL_ERROR';
export class ToolingError extends Error {
  readonly reason?: CredentialStoreFailureReason;
  constructor(public readonly code: ErrorCode, message: string, reason?: CredentialStoreFailureReason) {
    super(message); this.name = 'ToolingError'; this.reason = credentialStoreFailure(reason)?.reason;
  }
}
export type SessionStatus = {
  backend: string;
  authenticated: boolean;
  source: 'machine' | 'host' | 'environment' | 'none';
  persistence: 'machine' | 'host' | 'environment' | 'unavailable';
  store: string | null;
  username?: string;
  expiresAt?: string;
  checked?: boolean;
};
export type ActionCapability = { action: ProjectAction; state: 'available' | 'unavailable' | 'unsupported'; reason?: string };
export type ProjectContext = {
  root: string;
  projectType?: ProjectType;
  backend: string;
  origin: string;
  repositoryIdentity: string;
  branch: string;
  ref: string;
  commit: string;
  gitCommonDir: string;
};
export type ActionResult<T = unknown> = {
  schemaVersion: 1;
  action: string;
  status: 'success' | 'failure' | 'cancelled';
  summary: string;
  error?: { code: ErrorCode; message: string; reason?: CredentialStoreFailureReason };
  data?: T;
  effects?: { state: 'partial-or-uncertain'; message: string };
};
export type ProcessSpec = { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number };
/** stdout/stderr are private integration data, never public action output. */
export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string; cancelled?: boolean; timedOut?: boolean; unavailable?: boolean };
export interface HostServices {
  openBrowser(url: string): Promise<boolean>;
  runProcess(spec: ProcessSpec): Promise<ProcessResult>;
  progress?(message: string): void;
  openFolder?(root: string): Promise<void>;
  openTerminal?(spec: { root: string; env: NodeJS.ProcessEnv }): Promise<void>;
}
/** Authenticated requests expose API results, never the credential pair. */
export interface SessionService {
  status(backend: string, check?: boolean): Promise<SessionStatus>;
  login(backend: string): Promise<SessionStatus>;
  refresh(backend: string): Promise<SessionStatus>;
  logout(backend: string): Promise<{ revoked: boolean }>;
  request<T>(backend: string, method: 'GET' | 'POST', apiPath: string, body?: unknown, retrySafe?: boolean, options?: { timeoutMs?: number }): Promise<T>;
  /** Optional for legacy custom transports. Scoped operations fail closed if unavailable. */
  withAccount?(backend: string, expectedAccount: string): Promise<SessionService>;
  /** Opaque identity of the currently selected credentials, reread locally. No secrets.
   * Optional: transports without it never reuse a cached project MCP connection. */
  selectionIdentity?(backend: string): Promise<{ key: string; expiresAt?: number }>;
}

/** Trusted host persistence only. Credentials never cross the action-result boundary. */
export interface SessionPersistence {
  readonly name: string;
  readonly mode: 'machine' | 'host';
  read(backend: string): Promise<{ username: string; access: string; refresh: string } | null>;
  write(backend: string, value: { username: string; access: string; refresh: string }): Promise<void>;
  remove(backend: string): Promise<void>;
}
