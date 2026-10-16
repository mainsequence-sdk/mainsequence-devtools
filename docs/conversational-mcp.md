# Conversational project MCP connections

With the updated plugin loaded and a usable Main Sequence developer session, ask:

1. "Which internal MCPs are available?"
2. "Add metatable-mcp."
3. "Use it to list my tables."

Codex discovers the directory, saves your selection, reads that project's current tools and invokes them through the bundled client. You do not need a slash command, settings edit or restart between adding a project and using it. Saved selections work in later conversations. When multiple releases have the same name, select the intended release/Environment.

Connections are owned by the plugin. They do not create separate entries in Codex's native MCP list. Installing or updating the plugin itself still follows the host's plugin lifecycle.

## Runner and library

The conversational skill calls the same runner/API available to other local hosts:

| Command | Result |
| --- | --- |
| mcp-discover [--search TEXT] [--limit N] [--offset N] | A page from resource_release.mcp_endpoints; no local mutation. |
| mcp-add --uid RELEASE_UUID | Verify connection and tool catalog, then remember it. |
| mcp-list | Saved metadata for the selected backend; no health claim. |
| mcp-remove --uid RELEASE_UUID | Forget one connection without logging out. |
| mcp-tools --uid RELEASE_UUID | Read the current tools and their input schemas. |
| mcp-call --uid RELEASE_UUID --tool NAME [--arguments-file FILE] | Invoke the selected tool once; preserve its structured/content result. |

Run commands with node dist/runner.js, or the installed ms-devtools command. All accept --backend URL and --json. The JSON argument file contains the tool's argument object; omission supplies an empty object. It is limited to 1 MB. No credentials are accepted as command arguments.

The exported createDevTools().dispatch() accepts the same mcp-* actions through ActionRequest; mcp-call uses releaseUid, tool and arguments. Hosts can inject mcpConnectionsPath for their own local metadata location. Existing session and HostServices options still apply.

## Access and saved data

The plugin uses the existing developer machine session for central discovery and release credential exchange. A short-lived credential for the selected FastAPI release authenticates project requests; the platform login token never goes to the project endpoint. Credentials are not persisted with connections or exposed in results. The normal machine session renews privately.

If no developer session exists, use the existing Main Sequence hosted login. A central Codex OAuth connection does not automatically provide that session. Browser sign-in may be necessary once; adding subsequent project connections reuses the developer session.

Connection metadata lives in mcp-connections.json beside the existing MainSequence CLI configuration, separated by backend and release UID. Reads/calls recheck release access and fetch the current tool catalog. A changed endpoint requires an explicit add again. Removing a connection does not revoke your login.

The release UID identifies a connection. Its optional `name` is a display label from discovery; release detail responses omit it. Adding a connection and reading or calling its tools work without that label, including for saved connections. UID-based operations do not repeat discovery to obtain a name.

Project tools enforce their ordinary permissions. The client adds no agent-specific allowlist or exclusions.

## Failures and limits

Access denial, an unavailable release, or a corrupt connection file is reported without deleting the saved connection or changing accounts. All project requests use the current stateless Streamable HTTP profile. Stateful sessions, subscriptions, tasks and deprecated SSE endpoints are unsupported.

A tool call is never retried automatically. A timeout, interrupted stream or cancellation may follow a completed remote operation. If the result reports partial-or-uncertain effects, check the operation's outcome before repeating it. Tool errors retain their server result for diagnosis, with known authentication credentials redacted.

## Validation and release boundary

Run npm test for local protocol, credential-isolation, saved-connection and packaged-client fixtures. These tests do not access the user's credential store or invoke real project tools. The built plugin and npm archives include the conversational skill and client without runtime npm dependencies.

This source change does not publish a package, replace an immutable installed plugin version or establish live desktop end-to-end proof. A versioned plugin release/update and a read-only smoke test against a selected deployed MCP are the remaining rollout steps.

See [ADR 0002](adr/0002-conversational-project-mcp-client.md) for the approved design and authentication decision.
