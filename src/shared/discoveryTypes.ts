import type { ActionRequest, SessionStatus } from './models';
import type { PlatformAgent } from './agents';
import type { EnvironmentSummary } from './environments';
import type { OrganizationEnvironment, OrganizationProjectPage } from './organizationProjects';
import type { ProjectToolCatalogView, ProjectToolResult } from './projectTools';

export type McpConnection = {
  backend: string; resource_release_uid: string; name?: string; display_name?: string; code_repository_branch_uid?: string;
  mcp_connection: { url: string; transport: 'streamable-http'; resource_metadata_url: string;
    organization_environment_uid: string; organization_environment_name?: string; active_revision_uid: string };
};
export type McpTool = {
  name: string; description?: string; inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown> & { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};
export type McpDiscoveryPage = { count: number; results: McpConnection[] };
export type McpCatalog = { connection: McpConnection; tools: McpTool[] };
export type AgentDirectory = { account: string; results: PlatformAgent[]; count: number; offset: number; semantic: boolean };

/** Additive typed read contracts; unrelated actions retain their existing unknown payload. */
export type DiscoveryResultMap = {
  'auth-status': SessionStatus;
  'mcp-environments': EnvironmentSummary[];
  'organization-environments': OrganizationEnvironment[];
  'organization-projects': OrganizationProjectPage;
  'agents-list': AgentDirectory;
  'mcp-discover': McpDiscoveryPage;
  'mcp-list': McpConnection[];
  'mcp-tools': McpCatalog;
  'mcp-catalog': ProjectToolCatalogView;
  'mcp-tool-call': ProjectToolResult;
};
export type ActionData<R extends ActionRequest> = R extends { action: infer A }
  ? A extends keyof DiscoveryResultMap ? DiscoveryResultMap[A] : unknown : unknown;
