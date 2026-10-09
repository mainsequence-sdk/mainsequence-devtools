# ADR 0002: Conversational project MCP connections in the Codex plugin

Date: 2026-10-09

Status: Accepted for implementation by the owner's instruction, "OK then extend the codex plugin", following the explicit proposal to use a bundled client instead of native Codex MCP registration.

## Decision

Extend this repository's shared dispatcher and bundled runner with discovery, add, list, remove, tool-catalog and tool-call actions. Package a normally discoverable mainsequence-mcp skill alongside the explicit-only ms developer-command skill. A person can ask which project MCPs exist, select one, use its tools in the same conversation, and use the saved connection in later conversations. They do not invoke /ms or edit Codex configuration for these actions.

The plugin is an MCP client. Codex runs its bundled helper through its existing execution capability. Each project remains a direct remote MCP endpoint; the platform directory is not a proxy for its tools. No new service, background daemon, application deployment, backend endpoint, credential namespace, or native host modification is introduced.

The distinction from native registration is part of the contract: a saved project does not appear as its own native Codex MCP server or model tool namespace. The helper discovers the live schemas and invokes the selected tool through MCP. The plugin must already be installed and its conversational skill loaded by the host. Distributing an updated plugin is separate from adding a project connection.

## Authentication decision and evidence

Reuse the existing developer machine session and authenticated GET /api/v1/resource-releases/{uid}/exchange-launch/. For a FastAPI release this returns mode=token, release_kind=fastapi, an opaque short-lived release credential, and rpc_url. The current project gateway accepts these release credentials on POST /mcp under current User, release and Environment permissions. Resource-bound browser OAuth remains the independent direct-client login mechanism; this client neither modifies it nor copies a central OAuth token to a project.

This resolves the implementation question using an existing mechanism: an already signed-in developer needs no new browser consent per project and no new backend authorization handoff. A central MCP connection in Codex alone is not a machine session. When that session is missing or expired beyond renewal, the existing hosted developer login remains necessary; the plugin cannot promise first-time sign-in entirely within chat.

The inspected platform contract is owned by platform ADR-0050 sections 4 and 6. Its current text explicitly permits existing release bearer credentials at project MCP endpoints, and its gateway tests cover that path. This ADR records the decision to consume that existing contract so it can be evaluated independently of implementation. No platform ADR amendment or backend behavior change is required by this implementation. No agent-specific approval/exclusion list is introduced.

The platform credential is sent only to the selected backend. The release credential is sent only to the freshly resolved canonical project endpoint, after matching the exchange's RPC origin. It is held in memory for that invocation, redacted from results, and never added to connection files, tool arguments or command lines. Existing machine-session rotation, OS-store behavior and explicit process-identity precedence remain authoritative.

## Discovery and connection lifecycle

Discovery initializes central POST /mcp and calls resource_release.mcp_endpoints with search, limit and offset. It returns the existing directory projection; there is no copied application tool catalog.

Add selects a release UID, rereads the authenticated release detail, validates its current connection, exchanges a release credential, initializes the project and enumerates its paginated tools before saving. Repeated add replaces only the same backend/UID record. Duplicate display names require selecting a UID. Arbitrary caller-provided project URLs are not accepted.

Saved records contain only backend, release UID, display name, and the canonical MCP connection metadata (URL, transport, resource metadata URL, Environment UID, active revision UID). Store them in mcp-connections.json next to the existing CLI configuration:

- macOS: ~/Library/Application Support/MainSequenceCLI/
- Linux: ~/.config/mainsequence/
- Windows: %APPDATA%/MainSequenceCLI/ (connection metadata only; native saved authentication remains unsupported by the existing Node store).

Writes use a private file, a lock, and atomic replacement. Corrupt records are preserved and reported. Library/test hosts may supply mcpConnectionsPath without changing the platform credential store.

List is local and does not promise availability. Tools/call require a saved record, reread current release access and MCP capability, and reject an endpoint change until the person adds that release again. A new active revision on the same endpoint uses its current catalog. Remove forgets only the selected record; it does not log out or revoke credentials.

## Transport and operation semantics

Use only the platform's stateless Streamable HTTP profile, MCP 2025-11-25, including initialize, notifications/initialized, tools/list and tools/call. Support JSON and POST SSE results, bounded bodies, pagination, request timeouts and cancellation. Do not add deprecated HTTP+SSE endpoint discovery, protocol downgrade, stateful sessions, subscriptions, tasks, sampling, elicitation, native Codex registration or reload fallbacks.

All server-advertised ordinary tools can be selected, including writes. Tool annotations inform the harness; they do not constitute another permission system. The server validates tool arguments and operation permissions.

Project requests do not follow redirects and are never automatically replayed. Once a tools/call request starts, failure or cancellation reports potentially partial/uncertain effects. MCP isError results remain available as error data with known authentication credentials redacted.

## Classification and verification

A: Amend ADR 0001 to distinguish its original deterministic developer path from the newly approved conversational MCP client.

B: This ADR owns the new local connection lifecycle and host limitation.

C: This is an owner-requested feature, not a defect or code-only fix; no defect issue is opened.

D: Update README and the conversational MCP guide in the same change.

Verification uses separate loopback platform and project servers, synthetic credentials and temporary connection files. Cover discovery through the actual tool name, same-session use, persistence across client instances/processes, duplicate names, backend isolation, private renewal, revocation, endpoint changes, pagination, JSON/SSE, bounded transport failures, no write replay, cancellation, redaction and packaged runner execution. No live project operation or OpenAI inference is required. Real endpoint interoperability and automatic model selection remain deployment validation; fixture tests must not be described as live desktop end-to-end proof.
