# Workspace defaults and MCP environments

`readWorkspacePreferences({ env?, configPath?, homeDir? })` resolves only the backend
URL and repositories folder. It never signs in or rewrites configuration. The
backend uses `MAINSEQUENCE_ENDPOINT`, then existing `backend_url`, then
`https://api.main-sequence.app`. The folder uses `mainsequence_path`, otherwise
`<home>/mainsequence`. Host-saved overrides remain the host's responsibility.

Every action reads a repositories folder as the MainSequence CLI does
(`repositoriesFolder(value, home?)`): `~` is the home folder, a bare name such as
`mainsequence-dev` is a folder in it, and any other path is an ordinary one. A bare name is
never resolved against the working directory, which for a Claude, Codex or VS Code host is
whatever folder its session has open. Setup, local listings, Projects setup and saved
settings therefore all use one tree, `<base>/<organization>/projects/`, as the CLI does.

The structured `createDevTools().dispatch` API accepts `mcp-environments` to read
all authorized organization environments through the existing paginated backend
endpoint. MCP requests accept an optional `environmentUid`. Discovery scans the
existing MCP directory before paginating matching releases, because the backend
MCP tool does not accept an environment filter. Scans are bounded to 10,000 entries;
an oversized directory fails with a request to narrow the search, rather than
pretending a partial list is complete. No backend modification is required.

Environment-scoped listing leaves other saved connections intact. Connecting,
reading tools and calling a tool recheck the release's current environment before
exchanging credentials. Removing a connection checks its saved environment. Existing
metadata without environment names remains readable; new names are retained when
provided. Omitting `environmentUid` preserves the prior API behavior for other hosts.

Tests cover default/config/environment precedence, no configuration writes,
filtered results on later pages, legacy metadata, and rejection of cross-environment
calls before credential exchange. The CLI flags are unchanged; these additions are
public structured APIs for host adapters.
