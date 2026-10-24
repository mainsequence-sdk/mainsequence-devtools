export { createDevTools } from './shared/actions';
export { createNodeHost } from './shared/process';
export { requireBackend } from './shared/session';
export { sessionAccount, openCredentialStore } from './shared/machineSession';
export type { CredentialStore } from './shared/machineSession';
export type { ActionRequest, ActionResult, ActionCapability, ProjectContext, ProjectType, SessionStatus, SessionService, HostServices, ProcessSpec, ProcessResult, ErrorCode } from './shared/models';
export { ToolingError } from './shared/models';
export type { CredentialStoreFailureReason } from './shared/credentialStoreFailure';
export { createSharedTransport } from './shared/sharedTransport';
export type { SharedTransportStatus, SessionLock } from './shared/sharedTransport';

export { createSessionService } from './shared/session';
export { HostAuthSession, authSecretKey } from './shared/hostSession';
export type { HostSessionPolicy, SecretStorageLike, MementoLike, AuthTokens, RefreshedTokens } from './shared/hostSession';
export { clearSession, readSession, saveSession, SESSION_SERVICE, CredentialStoreError, ForeignEntryError } from './shared/machineSession';
export type { MachineSession, ProgramRunner } from './shared/machineSession';
export type { ProjectAction, SessionPersistence } from './shared/models';
export { normalizeBackendUrl } from './shared/config';
export { readWorkspacePreferences, projectContext, detectProjectType, canonicalRepositoryDir, safeSlug } from './shared/repositories';
export { RepositoryClient } from './shared/repositoryClient';
export type { CodeRepository, CodeRepositoryBranch, CodeRepositoryGitContextResolution, GitHubRepositoryBinding } from './shared/repositoryModels';
export { repositorySshKeyIdentity, repositorySshKeyName, repositorySshKeyPaths } from './shared/repositoryIdentity';
export { resolveCodeRepositoryCli, buildCodeRepositoryCliInvocations, codeRepositoryActionPreview, sanitizeCommitMessage } from './shared/cli';
export type { CodeRepositoryCli, CodeRepositoryCliAction, CodeRepositoryCliInvocation } from './shared/cli';

export { pythonExecutable, hasPythonProject, projectVersion, readPythonSdkStatus as readPythonProjectSdkStatus, PYTHON_SDK_PROJECT_URL } from './shared/pythonProjectStatus';
export type { CaptureProcess } from './shared/pythonProjectStatus';

export type { McpRequest } from './shared/mcp';
export { createMcpConnectionCache } from './shared/mcp';
export type { McpConnectionCache } from './shared/mcp';
export type { ActionData, DiscoveryResultMap, AgentDirectory, McpConnection, McpDiscoveryPage, McpCatalog, McpTool } from './shared/discoveryTypes';
// The shared project-tool registry (ADR 0004): one name, definition, result shape and catalog for every host.
export { mainSequenceStateDirectory } from './shared/stateDirectory';
export { projectToolName, isProjectToolName, projectToolConnection, projectToolConnectionLabel, projectToolDefinition, projectToolDefinitions, projectToolBinding, projectToolRegistration,
  projectToolResult, projectToolTimeoutMs, readProjectToolCatalog, readProjectToolCatalogFile, projectToolCatalogPath, createProjectToolCatalog,
  PROJECT_TOOL_PREFIX, MAX_PROJECT_TOOLS_PER_CONNECTION, PROJECT_TOOL_TIMEOUT_HINT, DEFAULT_PROJECT_REQUEST_TIMEOUT_MS, MAX_PROJECT_TOOL_TIMEOUT_MS } from './shared/projectTools';
export type { ProjectToolBinding, ProjectToolConnection, ProjectToolCatalog, ProjectToolCatalogOptions, ProjectToolCatalogState, ProjectToolCatalogStore, ProjectToolCatalogView,
  ProjectToolDefinition, ProjectToolDispatch, ProjectToolResult, ProjectToolScope } from './shared/projectTools';
export { listEnvironments } from './shared/environments';
export type { EnvironmentSummary } from './shared/environments';
export { bindSessionAccount } from './shared/accountScope';
export { AgentClient } from './shared/agents';
export type { AgentRequest, PlatformAgent } from './shared/agents';
export { AgentDelivery } from './shared/agentDelivery';
export type { AgentDeliveryScope, AgentDeliveryRequest, AgentDeliveryState, AgentDeliveryDispatch } from './shared/agentDelivery';

export { createProjectOperations, PROJECT_OPERATION_ACTIONS, validateDockerImage, validateDockerPlatform } from './shared/projectOperations';
export type { ProjectOperationRequest, ProjectOperationOptions } from './shared/projectOperations';
export { updateDevcontainerJsonc } from './shared/devcontainerJsonc';
export { OrganizationProjectClient } from './shared/organizationProjects';
export type { OrganizationProject, OrganizationProjectBranch, OrganizationProjectPage, OrganizationEnvironment, OrganizationProjectRequest } from './shared/organizationProjects';
export type { OrganizationProjectWorkspace } from './shared/organizationProjectWorkspace';
export { readOrganizationProjectWorkspace } from './shared/organizationProjectWorkspace';

export { parseArguments, tokenizeCommand, HELP } from './shared/arguments';

export { createAgentAssets, stillAgentPng } from './shared/agentAssets';
export type { AgentAsset } from './shared/agentAssets';

export { createDeployments, DEPLOYMENT_ACTIONS, HIDDEN_DEPLOYMENT } from './shared/deployments';
export type { DeploymentRequest } from './shared/deployments';
export { writeWorkspacePreferences, readDesktopPreferences } from './shared/workspaceSettings';
