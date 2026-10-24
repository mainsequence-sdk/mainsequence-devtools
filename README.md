# MainSequence developer tooling

`@dev-mainsequence/devtools` is the shared TypeScript package behind MainSequence's
developer integrations: browser sign-in and the machine session, repository and project
operations, the project MCP client, the platform agent client, the shared project-tool
registry and the `ms-devtools` command line. It has no runtime npm dependencies and makes
no LLM API calls; developer actions run deterministically. The host integrations live in
their own repositories and use only this package's public API.

## Which MainSequence tool do I install?

| Host | What you get | Install | Repository |
| --- | --- | --- | --- |
| **VS Code** | A MainSequence panel: sign in, browse repositories and projects, set them up locally, open signed terminals, run SDK actions | Install **MainSequence** from the VS Code Marketplace, or `code --install-extension mainsequencegmbh.vscode-mainsequence` | [ms-vscode-extension](https://github.com/mainsequence-sdk/ms-vscode-extension) |
| **Codex** (desktop and CLI) | The MainSequence panel (Home, Code, Projects, Agents, Tools), agent messaging in chat, project MCP tools, `/ms` commands | `codex plugin marketplace add mainsequence-sdk/mainsequence-codex-plugin`, then `codex plugin add mainsequence@mainsequence` | [mainsequence-codex-plugin](https://github.com/mainsequence-sdk/mainsequence-codex-plugin) |
| **Claude Desktop** (Code) | The MainSequence pane (Home, Code, Projects, Agents, Tools), agent conversations with `/ms @agent`, project MCP tools, deployments | **Customize → Plugins → Add marketplace → Add from repository**, enter `https://github.com/mainsequence-sdk/mainsequence-claude-desktop.git`, install **MainSequence** from `mainsequence-desktop` | [mainsequence-claude-desktop](https://github.com/mainsequence-sdk/mainsequence-claude-desktop) |
| **Terminal or CI** | The `ms-devtools` command line | `npx -p @dev-mainsequence/devtools ms-devtools --help`, or `npm install -g @dev-mainsequence/devtools` | this repository |

All of them need Node 22 or newer and share one sign-in per backend, kept in the operating
system's credential store (the login Keychain on macOS, Secret Service through
`secret-tool` on Linux). The `mainsequence` (Python) and `command-center-sdk` (Node)
command lines read the same record, so signing in anywhere signs in everywhere. Windows
has no persistent store in this package: the VS Code extension keeps its own session
there, and the Codex and Claude Desktop plugins are not supported on Windows yet. Each
host's README explains its own setup; the Command Center's **Settings → Account →
Developer tools** page gives the same steps with your deployment's backend URL.

## The `ms-devtools` command line

```sh
npx -p @dev-mainsequence/devtools ms-devtools --help
ms-devtools login --backend https://api.main-sequence.app
ms-devtools auth-status --backend https://api.main-sequence.app --check --json
ms-devtools refresh-token --backend https://api.main-sequence.app
ms-devtools repositories --backend https://api.main-sequence.app --json
ms-devtools status --path "/path/to/project" --json
ms-devtools sync --path "/path/to/project"
```

### Sign in

`login` opens the hosted browser authorization flow with PKCE and a loopback callback;
account creation is part of that hosted flow. Login and `auth-status` work before either
SDK is installed. The runner checks the store before opening a browser and reads back the
saved pair before reporting success. The saved record is the SDKs' existing
`MainSequenceCLI.auth` service, backend-scoped account and version-1 JSON format; there
is no separate credential record and no token file. `refresh-token` renews the saved
machine session; it does not replace a token exported into another shell. `logout`
removes this backend's local record and separately reports whether remote revocation
completed.

A deliberately supplied `MAINSEQUENCE_ACCESS_TOKEN` with its matching
`MAINSEQUENCE_ENDPOINT` is a process or CI identity. A rejected process identity never
falls back to another saved identity. Runtime credentials are a separate application lane
and are not accepted for developer actions.

### Project actions

Backend selection uses an explicit `--backend`, then `MAINSEQUENCE_ENDPOINT`, the Git-root
`.env` endpoint, the existing CLI configuration, then the standard backend. Project
selection validates the real Git root, attached branch, full HEAD SHA and canonical remote
identity. Ambiguous Python/frontend projects require `--type python` or `--type vite_react`.

| Command | Behavior |
| --- | --- |
| `status` | Local Git context, session metadata, and installed command capabilities. |
| `resolve` | Backend Git-context resolution with identity/branch/ref/commit validation. |
| `setup --uid UID --branch BRANCH --base-dir DIR [--install]` | Fetch the registered binding; reuse/register the repository SSH key; verify access; clone into `<base>/<org>/projects/<name>-<uid>`; write an endpoint-only `.env`; optionally install dependencies. Existing checkout folders are never replaced. |
| `install` | `uv sync` for Python; `npm ci` for frontend projects. |
| `sync` | Refresh the project's dependency files with its installed SDK: Python `code-repository sync` runs `uv lock`, `uv sync` and the locked `requirements.txt` export (`mainsequence` 9.0.5 or later); Node `code-repository sync` refreshes `package-lock.json` and runs `npm ci` (`@dev-mainsequence/command-center-sdk` 0.5.13 or later). No commit message, dry run, Git command or backend request: review the changes, then commit and push them yourself. An installed SDK that still has the retired release sync (`--dry-run`/`--message` in its sync help) is reported unavailable without running it; run `update-sdk`. |
| `sdk-status` | Isolated Python distribution metadata plus stable source version, or Node `application sdk-status`. A source version does not prove registry publication. |
| `update-sdk [--dry-run]` | Python `code-repository update-sdk` or Node `application update-sdk`; retains the project's existing dependency policy. |
| `update-agents` | Python SDK's packaged `AGENTS.md` managed-block update. |
| `install-skills [--dry-run]` | Node SDK's packaged skills installation. Python's combined skills command requires MCP and is unsupported here. |
| `env-cleanup` | Remove legacy project credentials and keep the endpoint and unrelated settings; refuse tracked or symlink `.env` files. |
| `skills-sync` | Reports unsupported: backend-owned skills require MainSequence MCP. |
| `open-folder`, `signed-terminal` | Host capabilities exposed by the library; the terminal runner reports them as unsupported. |

Python dispatch uses `.venv/bin/mainsequence` (`Scripts/mainsequence.exe` on Windows).
Node dispatch executes the project's installed
`@dev-mainsequence/command-center-sdk/cli/command-center-sdk.mjs` with the runner's Node
executable. No global SDK or sibling source path is a fallback. Command help is checked
before dispatch; missing or older capabilities produce a structured error.

Versions and release tags of a CodeRepository are repository code, for example a GitHub
Actions workflow; the platform deploys from Git pushes, so `sync` only refreshes
dependency files and there is no `freeze-env`. For existing library callers, a sync
request that still carries `message` is accepted and the message ignored, a `freeze-env`
request reports `UNSUPPORTED_ACTION`, and the deprecated `sanitizeCommitMessage` export
and `freezeEnv` CLI action name remain but build no command.

If `.env` still contains credentials, run `env-cleanup` explicitly before SDK dispatch.
It removes canonical tokens, runtime credentials, the unsupported legacy token and the
runtime credential auth-mode assignment, including `export` and whitespace forms. It
preserves unrelated application settings, keeps the endpoint in the VS Code extension's
block (`# BEGIN MAINSEQUENCE AUTH (managed by VS Code)` … `# END MAINSEQUENCE AUTH`) as
the extension writes it, excludes `.env` from Git, and writes it atomically with private
permissions. A file already in that form is not written again.

Mutations hold a repository lock in the Git common directory, also covering linked
worktrees. Before a clone exists, setup locks `.<folder>.mainsequence-devtools.lock` in
its canonical parent directory. Cancellation stops the child process; failures after
execution begins report partial or uncertain effects. A failed sync is never
automatically retried or rolled back. After an abrupt process kill, inspect running
actions before removing a stale lock (`mainsequence-devtools.lock` in the Git common
directory, or the named setup lock).

Raw SDK output is private and is not included in results or hook output. Progress
reports command lifecycle; supported structured status metadata is filtered. Run the SDK
directly in a private terminal when its detailed diagnostic output is needed. Raw
credentials are never arguments, public results, or model context.

### Project MCPs

`mcp-discover`, `mcp-add`, `mcp-list`, `mcp-remove`, `mcp-tools`, `mcp-call` and
`mcp-catalog [--refresh]` discover the platform's MCP directory, remember a selected
release, read its tools and invoke them through a local MCP client, using the developer
session and short-lived release credentials. Connections are saved in
`mcp-connections.json` beside the CLI configuration (hosts may inject
`mcpConnectionsPath`). `mcp-add` stores the release's name, its repository's name and
its repository branch with the connection (`name`, `display_name`,
`code_repository_branch_uid`), so `mcp-list` labels a saved connection without a backend
request; a label that cannot be read is left out rather than making the MCP unavailable.
The conversational use of these connections in Codex is described in
[the Codex plugin's guide](https://github.com/mainsequence-sdk/mainsequence-codex-plugin/blob/main/docs/conversational-mcp.md).

## Library API

```ts
import { createDevTools, createNodeHost } from '@dev-mainsequence/devtools';

const tools = createDevTools({ host: createNodeHost() });
const result = await tools.dispatch({ action: 'sync', root: '/path/to/project' });
```

The same dispatcher serves the library, the CLI and the host runners. `parseArguments`,
`tokenizeCommand` and `HELP` are exported so a host can parse the same command line as
`ms-devtools`. `HostServices` supplies browser and process execution, safe progress,
cancellation, and optional native folder and terminal operations. Shared code imports no
host API. Public types include `ActionRequest`, `ActionResult<T>`, `ProjectContext`,
`ActionCapability` and `SessionStatus`. Credentials stay private to the session service.

`createSessionService` owns browser authorization, authenticated HTTP, refresh and
revocation; `RepositoryClient` owns the canonical backend response and Git-resolution
contracts; `createDevTools` owns project actions and cancellation. `HostAuthSession` is an
opt-in compatibility adapter for asynchronous host SecretStorage, machine-session adoption
and the host projection/migration policy; its `get`, `save`, `environment` and
`persistence` methods are privileged credential bridges and must never reach webview
state, progress, logs, hook output or action results. The VS Code extension uses it where
no native store is reachable; Codex and Claude Desktop use native persistence only.

### Discovery and account binding

`dispatch()` infers typed payloads for session status, environments, agent directories,
MCP discovery, saved connections and tool catalogs; the exports include `McpConnection`,
`McpTool`, `McpCatalog`, `McpDiscoveryPage`, `AgentDirectory` and `DiscoveryResultMap`.
Backend response validation stays here; host applications own their view state.

```ts
const verified = await devtools.dispatch({ action: 'auth-status', backend, check: true });
if (verified.status !== 'success' || !verified.data?.username) throw new Error('Sign in first');
const scope = { backend, expectedAccount: verified.data.username, environmentUid };
const saved = await devtools.dispatch({ action: 'mcp-list', ...scope, readOnly: true });
const available = await devtools.dispatch({ action: 'mcp-discover', ...scope, enrichNames: true, limit: 20 });
```

- `mcp-list` with `readOnly: true` reads saved metadata without label lookups, locks or
  connection-file writes; without it, a record saved without labels is completed by the
  first listing that can read them.
- `mcp-discover` with `enrichNames: true` resolves optional repository names once per
  branch, at most four at a time, with no connection writes.
- `mcp-environments` and `organization-environments` share one bounded `listEnvironments`
  loader: duplicate rows, changing totals, premature empty pages and directories over
  10,000 entries are refused.
- MCP, agent and organization-project actions accept `expectedAccount`. The built-in
  session verifies the credential actually used for requests and retries, rejects a
  different account and discards responses when the selected credentials change during a
  read. `bindSessionAccount(session, backend, expectedAccount)` gives public domain
  clients the same contract; a custom `SessionService` implements the optional
  `withAccount` method, and account checks fail with `UNSUPPORTED_ACTION` when it lacks
  one. The scoped session cannot log in, log out or change authentication. Hosts still
  invalidate stale selections when their configured backend or environment changes.

### Project MCP client

A remote tool failure is `MCP_TOOL_ERROR` and keeps the sanitized MCP `content` and
`structuredContent` in `ActionResult.data`, apart from transport and API errors; hosts
preserve that result and any `effects` warning, and calls are never replayed
automatically. A persistent client reuses verified release metadata, the release grant and
its tool catalog in memory for at most 60 seconds, never beyond credential expiry: a
prepared `mcp-call` sends only the business `tools/call` request, `mcp-tools` refreshes
schemas explicitly, cold setup verifies the account remotely at entry and completion, and
warm calls reread the shared credential selection locally before and after execution.
Logout, a changed credential pair or saved endpoint, removal, expiry and transport
failures invalidate reuse; the server still authorizes every call. `createDevTools()`
owns a cache by default; hosts that create a dispatcher per request pass one opaque
`createMcpConnectionCache()` handle as `mcpCache`. A session adapter without
`selectionIdentity()` always uses fresh setup. Separate CLI processes share no cache.

A cold project MCP (a scaled-to-zero FastAPI release) is slow: measured against the
Production CRM, a first `mcp-call` took 53–71 s and a warm one 7–10 s. Project requests
have their own budget, `projectRequestTimeoutMs` (default 120 s; `requestTimeoutMs`, default
30 s, governs backend requests), and a `tools/call` honours the tool's advertised
`_meta["mainsequence.ai/timeout-seconds/v1"]` when it is larger, capped at 300 s. Hosts set
their outer limit above this. Error messages say which endpoint answered which request
(`The project MCP https://… returned HTTP 503 for tools/call crm_contacts_list.`), tell a
timeout (`timed out after 120 s`) apart from a connection failure (`failed before a
response arrived (ECONNREFUSED)`), and keep a JSON-RPC error's own message, redacted.

### Shared project-tool registry

Both host plugins present every saved project MCP connection's tools as first-class tools
of the host, named `ms_<tool>_<hash>` (for example `ms_crm_contacts_list_183f8138`), so a
model calls `crm_contacts_list` like any other tool. This package owns that registry
([ADR 0004](docs/adr/0004-shared-project-tool-registry.md)); the plugins keep only what
is specific to their host.

- `projectToolName(backend, environmentUid, releaseUid, tool)`: `ms_` + the remote name
  (characters outside `[a-zA-Z0-9_-]` replaced by `_`, cut to 32) + `_` + the lower-case
  hexadecimal FNV-1a 32-bit hash of `backend:environment:release:tool`. One remote tool has
  one name in every host; the CRM vector above is a frozen test.
- `projectToolDefinition(connection, tool)` and `projectToolDefinitions(connection, tools)`
  (80 per connection, duplicates and invalid tools dropped): `{ name, title, description,
  inputSchema, annotations }` with the description `MainSequence <release name>
  [<environment>]: <remote description>`, an object schema and the four boolean hints,
  open-world by default.
- `projectToolResult(actionResult)`: what a host returns for a forwarded call: the remote
  content blocks, then one JSON text block with `summary`, `effects`, `error` and
  `structuredContent` when the call failed, returned structured content or no blocks;
  `isError` on any non-success, with the remote content of an `MCP_TOOL_ERROR` preserved.
- `readProjectToolCatalog(dispatch, { backend?, environmentUid?, previous?, signal? })`:
  `mcp-list` (read-only), then one `mcp-tools` per saved connection, two at a time. A
  connection whose catalog cannot be read keeps its previous tools and is named in
  `unavailable`; a removed connection loses them; connections outside the scope are
  carried over. The session for a connection's backend is verified when its tool is called.
- `createProjectToolCatalog({ dispatch, file?, staleMs?, notify?, disabled? })`: the shared
  on-disk catalog, `project-tool-catalog.json` beside `mcp-connections.json`
  (`mainSequenceStateDirectory(env)` names that directory). `list()` answers from the file
  at once, scoped to the current account's backend once a refresh has learned it;
  `refresh()` re-reads under a lock, so one process reads catalogs at a time while the
  others pick its result up from the file; `update()`, `dispose()` and `notify` serve a
  long-lived host such as the Codex MCP server. The file holds schemas and labels only.
- The `mcp-catalog` action returns the same definitions, bindings and state for a host
  that dispatches actions instead of importing: without `refresh` from the file, with
  `refresh: true` re-reading a stale cache, with `'force'` always, waiting up to two
  minutes for another process's refresh to end. `mcp-tool-call` is `mcp-call` answered in
  the `projectToolResult` shape.

What stays host-specific: the Codex server merges the definitions into its `tools/list`,
sends `tools/list_changed` and forwards an `ms_*` call through `mcp-call`; the Claude
Desktop hook registers the definitions, asks before every call, converts the result's
blocks to Messages API blocks and spawns one worker per action.

### Agents, projects, workspaces and transport

- [Platform agent conversations](docs/agent-conversations.md): agent discovery, sessions,
  readiness, sends, tasks and the durable `AgentDelivery` coordinator for host chats.
- [Organization projects](docs/organization-projects.md): environment-scoped project
  listing and repeatable local workspace setup.
- [Shared project operations](docs/shared-project-operations.md): local repository
  discovery, deletion, Docker builds and devcontainer edits for host adapters.
- [Workspace defaults and environments](docs/workspace-environments.md): backend and
  repositories-folder resolution and environment-scoped MCP actions.
- [Shared desktop transport](docs/shared-desktop-transport.md): the per-user worker that
  hosts with one process per chat use to share HTTP connections, reads and token renewal.

Decisions are recorded in [ADR 0001](docs/adr/0001-shared-developer-tooling-and-codex.md)
(shared tooling), [ADR 0002](docs/adr/0002-conversational-project-mcp-client.md) (the MCP
client), [ADR 0003](docs/adr/0003-codex-plugin-extraction.md) (host repositories) and
[ADR 0004](docs/adr/0004-shared-project-tool-registry.md) (the project-tool registry).

## Development

Requires Node 22 or newer.

```sh
npm ci
npm run build
node dist/runner.js --help
npm run release:check
node scripts/verify-sdk-interop.cjs /path/to/mainsequence-sdk /path/to/command-center-sdk
```

`release:check` type-checks, builds, runs the tests, checks the release metadata and the
documentation, packs the npm archive into `artifacts/` and verifies it from an isolated
consumer. Tests use a loopback fixture backend, synthetic in-memory store entries,
stand-ins for the native store programs, installed-CLI fixtures and temporary Git
repositories; they never log in to a real backend or read or write the user's
credentials. Loopback networking must be permitted for the browser tests. The parser,
tokenizer and terminal runner have their own suite in `tests/arguments.test.cjs`, since
host runners depend on them.

The optional SDK compatibility script checks the actual SDK source implementations
against synthetic in-memory records in both directions, with an isolated temporary Python
home. It imports the SDK private session implementation only for that check and loads its
dependencies from the given checkout without running the SDK initializer. Set
`MAINSEQUENCE_TEST_PYTHON=/path/to/sdk/.venv/bin/python` when its CLI dependencies are
unavailable to `python3`. Live OS-store and backend refresh-rotation interoperability are a
separate release check.

## Release

The npm archive contains `dist`, `README.md`, `LICENSE` and `NOTICE`; host adapters,
manifests and marketplaces are released from their own repositories. To release: set the
new version in `package.json` and `package-lock.json`, run `npm run release:check`, merge,
and push the tag `v<version>`. The release workflow (`release.yml`, GitHub environment
`npm`) repeats the checks and publishes the verified archive with provenance through npm
trusted publishing. Published versions are immutable; never republish a rebuilt archive
under an existing version. Write the release notes on the GitHub release of that tag.
After publishing, read the archive's integrity from the registry
(`npm view @dev-mainsequence/devtools@<version> dist.integrity`; a local `npm pack` has
another) before a host pins the new version in its lockfile.
