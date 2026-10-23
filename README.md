# MainSequence developer tooling

One TypeScript package owns the shared action models, browser authentication, machine session, repository resolution, project dispatch, the `ms-devtools` command runner and the project MCP client. Both SDK repositories remain unchanged. Host integrations live in their own repositories and consume only this package's public API: [VS Code](https://github.com/mainsequence-sdk/ms-vscode-extension), [Claude Desktop](https://github.com/mainsequence-sdk/mainsequence-claude-desktop) and, since 0.3.0, the [Codex plugin](https://github.com/mainsequence-sdk/mainsequence-codex-plugin) ([ADR 0003](docs/adr/0003-codex-plugin-extraction.md)). Since 0.3.12 both plugins register saved project MCP tools through the [shared project-tool registry](#shared-project-tool-registry-0312) ([ADR 0004](docs/adr/0004-shared-project-tool-registry.md)). There are no runtime npm dependencies or LLM API calls in the runner. The MCP client calls the existing platform directory and selected project MCP endpoints; the developer actions retain their deterministic execution.

## Build and run

VS Code and Claude use the shared [MainSequence Projects API and local workspace setup](docs/organization-projects.md). Projects are environment-scoped collections of repository branches; the existing repository operations API retains its compatible names and storage layout.

Requires Node 22 or newer. Install build dependencies and build once:

```sh
npm ci
npm run build
node dist/runner.js --help
```

Run directly in a terminal for deterministic execution without invoking a model:

```sh
node dist/runner.js login --backend https://api.main-sequence.app
node dist/runner.js auth-status --backend https://api.main-sequence.app --check --json
node dist/runner.js refresh-token --backend https://api.main-sequence.app
node dist/runner.js repositories --backend https://api.main-sequence.app --json
node dist/runner.js status --path "/path/to/project" --json
node dist/runner.js sync --path "/path/to/project"
```

Login and session status work before either SDK is installed. Login opens the existing hosted browser authorization flow with PKCE and a loopback callback; account creation remains part of that hosted flow. The runner checks the store before opening a browser and reads back the saved pair before reporting success.

Persistent login uses macOS Keychain or Linux Secret Service (`secret-tool` from libsecret). Windows has no native persistent Node store in this extracted implementation. A deliberately supplied `MAINSEQUENCE_ACCESS_TOKEN` with its matching `MAINSEQUENCE_ENDPOINT` supports a process/CI identity. A rejected process identity never falls back to another saved identity. Runtime credentials are a separate application lane and are not accepted for these developer actions.

The machine record is the SDKs' existing `MainSequenceCLI.auth` service, backend-scoped account, and version-1 JSON format. There is no Codex-specific credential record and no token file. `refresh-token` renews the saved machine session; it does not replace a token exported into another shell. `logout` removes this backend's local record and separately reports whether remote revocation completed.

## Project MCP client

In 0.3.6, remote tool failures use `MCP_TOOL_ERROR` and retain the sanitized MCP
`content`/`structuredContent` in `ActionResult.data`, separately from transport/API
errors. Hosts must preserve that result and any `effects` warning. Calls are never
automatically replayed.

Since 0.3.7, a persistent client reuses verified release metadata, the release grant
and its tool catalog in memory for at most 60 seconds (never beyond credential
expiry). A prepared `mcp-call` sends only the business `tools/call` HTTP request.
`mcp-tools` explicitly refreshes schemas without repeating valid connection setup.
Cold setup verifies the account remotely at entry and completion; warm calls reread
the shared credential selection locally before and after execution. Logout, a
changed credential pair or saved endpoint, removal, expiry and transport failures
invalidate reuse. The server continues to enforce authorization for each call.
Tool results and credentials are never written to connection metadata; failed calls
are never replayed automatically, including after Stop.

`createDevTools()` owns a cache by default. Hosts that create a new dispatcher per
request can pass the same opaque `createMcpConnectionCache()` handle as `mcpCache`;
devtools owns validation and expiry, while each request retains its own cancellation
signal. A session adapter without `selectionIdentity()` always uses fresh setup.
Separate CLI processes do not share this memory cache.

Version 0.3.3 adds the public `AgentDelivery` service for durable host conversations.
It stages immutable requests, records native submission acknowledgements separately
from agent delivery, and reuses saved receipts on recovery. It uses the same session,
agent and readiness APIs as other consumers; no host UI code is included. See
[the delivery contract](docs/agent-conversations.md#durable-host-delivery-033).

The `mcp-discover`, `mcp-add`, `mcp-list`, `mcp-remove`, `mcp-tools` and `mcp-call` actions discover the platform's MCP directory, remember a selected release and invoke its tools through a local MCP client, using the existing developer session and short-lived release credentials. They are available from `ms-devtools` and from `createDevTools().dispatch()`; hosts may inject `mcpConnectionsPath`. Since 0.3.1, `mcp-add` reads the release's name, its repository's name and its repository branch from the release directory and stores them with the connection as `name`, `display_name` and `code_repository_branch_uid`, so `mcp-list` labels a saved connection without a backend request; a record saved by an earlier version is completed by the first listing that can read them, and a label that cannot be read is left out rather than making the MCP unavailable. Discovery rows carry `name` and `code_repository_branch_uid` as the platform directory reports them. The conversational `mainsequence-mcp` skill that lets Codex use them without `/ms` ships with the [Codex plugin](https://github.com/mainsequence-sdk/mainsequence-codex-plugin), together with [its user guide](https://github.com/mainsequence-sdk/mainsequence-codex-plugin/blob/main/docs/conversational-mcp.md) and [ADR 0002](https://github.com/mainsequence-sdk/mainsequence-codex-plugin/blob/main/docs/adr/0002-conversational-project-mcp-client.md).

A cold project MCP (a scaled-to-zero FastAPI release) is slow. Measured against the
Production CRM on 2026-10-23, a first `mcp-call` took 53–71 s (release detail and
exchange-launch about 2 s each, the project's `initialize` 9 s to over 60 s, `tools/call`
10–39 s); a warm one 7–10 s. Since 0.3.12 project requests have their own budget,
`projectRequestTimeoutMs` (default 120 s; `requestTimeoutMs` keeps governing backend
requests, default 30 s), and a `tools/call` honours the tool's advertised
`_meta["mainsequence.ai/timeout-seconds/v1"]` when it is larger, capped at 300 s. Hosts set
their outer limit above this (Codex `tool_timeout_sec`, the Claude Desktop worker budget).
Error messages say which endpoint answered which request (`The project MCP https://… returned
HTTP 503 for tools/call crm_contacts_list.`), tell a timeout (`timed out after 120 s`) apart
from a connection failure (`failed before a response arrived (ECONNREFUSED)`), and keep a
JSON-RPC error's own message, redacted. The error codes are unchanged.

## Shared project-tool registry (0.3.12)

Both host plugins present every saved project MCP connection's tools as first-class tools of
the host, named `ms_<tool>_<hash>` (for example `ms_crm_contacts_list_183f8138`), so a model
calls `crm_contacts_list` like any other tool instead of walking a discovery protocol. Since
0.3.12 this package owns that registry ([ADR 0004](docs/adr/0004-shared-project-tool-registry.md))
and the plugins keep only what is specific to their host.

- `projectToolName(backend, environmentUid, releaseUid, tool)`: `ms_` + the remote name
  (characters outside `[a-zA-Z0-9_-]` replaced by `_`, cut to 32) + `_` + the lower-case
  hexadecimal FNV-1a 32-bit hash of `backend:environment:release:tool`. One remote tool has
  one name in every host; the CRM vector above is a frozen test.
- `projectToolDefinition(connection, tool)` and `projectToolDefinitions(connection, tools)`
  (80 per connection, duplicates and invalid tools dropped): `{ name, title, description,
  inputSchema, annotations }` with the description `MainSequence <release name> [<environment>]:
  <remote description>`, an object schema (`type: 'object'` added when the server omitted it)
  and the four boolean hints, open-world by default.
- `projectToolResult(actionResult)`: what a host returns for a forwarded call: the remote
  content blocks, then one JSON text block with `summary`, `effects`, `error` and
  `structuredContent` when the call failed, returned structured content or no blocks;
  `isError` on any non-success, with the remote content of an `MCP_TOOL_ERROR` preserved.
- `readProjectToolCatalog(dispatch, { backend?, environmentUid?, previous?, signal? })`:
  `mcp-list` (read-only), then one `mcp-tools` per saved connection, two at a time. A
  connection whose catalog cannot be read keeps its previous tools and is named in
  `unavailable`; a removed connection loses them; connections outside the scope are carried
  over. No account snapshot is attached: the session for a connection's backend is verified
  when its tool is called.
- `createProjectToolCatalog({ dispatch, file?, staleMs?, notify?, disabled? })`: the shared
  on-disk catalog, `project-tool-catalog.json` beside `mcp-connections.json`
  (`mainSequenceStateDirectory(env)` names that directory). `list()` answers from the file at
  once, scoped to the current account's backend once a refresh has learned it; `refresh()`
  re-reads under a lock, so one process reads catalogs at a time while the others pick its
  result up from the file; `update()`, `dispose()` and `notify` serve a long-lived host such as
  the Codex MCP server. The file holds schemas and labels only, never credentials, tool
  results or tokens.
- The `mcp-catalog` action returns the same definitions, bindings and state for a host that
  dispatches actions instead of importing (the Claude Desktop hook reaches this package only
  through a worker process): without `refresh` from the file, with `refresh: true` re-reading
  a stale cache, with `'force'` always, waiting up to two minutes for another process's
  refresh to end. `mcp-tool-call` is `mcp-call` answered in the `projectToolResult` shape.
  `ms-devtools mcp-catalog [--refresh]` is the command-line form.

What stays host-specific: the Codex server merges the definitions into its `tools/list`,
sends `tools/list_changed`, keeps its `contextId` discovery layer and shared transport, and
forwards an `ms_*` call through `mcp-call` and `projectToolResult`; the Claude Desktop hook
registers the definitions with `$.tool.register`, asks `$.ui.ask` before every call,
converts the result's blocks to Messages API blocks and spawns one worker per action.

## Shared discovery API (0.3.2)

`createDevTools().dispatch()` now infers typed payloads for session status, environments,
agent directories, MCP discovery, saved connections and tool catalogs. `ActionResult<T>`
defaults to `unknown` for compatibility; the public exports include `McpConnection`,
`McpTool`, `McpCatalog`, `McpDiscoveryPage`, `AgentDirectory` and `DiscoveryResultMap`.
Backend response validation stays in devtools; host applications own their view state.

```ts
const verified = await devtools.dispatch({ action: 'auth-status', backend, check: true });
if (verified.status !== 'success' || !verified.data?.username) throw new Error('Sign in first');
const scope = { backend, expectedAccount: verified.data.username, environmentUid };
const saved = await devtools.dispatch({ action: 'mcp-list', ...scope, readOnly: true });
const available = await devtools.dispatch({ action: 'mcp-discover', ...scope, enrichNames: true, limit: 20 });
```

- `mcp-list` with `readOnly: true` reads saved metadata without label lookups, locks or
  connection-file writes. Missing stores remain absent; corrupt files are preserved and
  reported. Omit the option (or explicitly use `false`) to retain the legacy label-backfill
  behavior. Normal authentication renewal is independent of connection metadata writes.
- `mcp-discover` with `enrichNames: true` resolves optional repository names once per branch,
  with at most four concurrent lookups and no connection writes. Missing optional metadata
  leaves usable endpoints visible. Cancellation and account changes still fail the action.
- `mcp-environments` and `organization-environments` use the same bounded `listEnvironments`
  loader. Short pages advance by their actual length; duplicate rows, changing totals,
  premature empty pages and directories over 10,000 entries are refused. The existing MCP
  result retains `isProduction`; the Projects result retains `{uid, name}`.
- MCP and organization-project actions accept optional `expectedAccount`. The built-in
  session verifies the actual credential used for requests and retries, rejects a different
  account and discards responses when the selected credentials change during a read. Agent
  operations also use this binding when the session supports it. This does not make remote
  mutations atomic with account changes or roll back work already dispatched.

`bindSessionAccount(session, backend, expectedAccount)` is available for public domain
clients. Custom `SessionService` implementations can implement the optional `withAccount`
method to provide that contract. New opt-in MCP/Projects account checks fail with
`UNSUPPORTED_ACTION` when the custom transport lacks it; existing unscoped callers and
legacy custom agent transports retain their prior behavior. The built-in scoped session
cannot log in, log out or change authentication. Hosts still invalidate stale selections
when their configured backend/environment changes.

## Project actions

Backend selection uses an explicit `--backend`, process `MAINSEQUENCE_ENDPOINT`, the Git-root `.env` endpoint, existing CLI configuration, then the standard backend. Project selection validates the real Git root, attached branch, full HEAD SHA, and canonical remote identity. Ambiguous Python/frontend projects require `--type python` or `--type vite_react`.

| Command | Behavior |
| --- | --- |
| `status` | Local Git context, session metadata, and installed command capabilities. |
| `resolve` | Existing backend Git-context resolution with identity/branch/ref/commit validation. |
| `setup --uid UID --branch BRANCH --base-dir DIR [--install]` | Fetch the registered binding; reuse/register the repository SSH key; verify access; clone into `<base>/<org>/projects/<name>-<uid>`; write endpoint-only `.env`; optionally install dependencies. Existing checkout folders are never replaced. |
| `install` | `uv sync` for Python; `npm ci` for frontend projects. |
| `sync` | Refresh the project's dependency files with its installed SDK: Python `code-repository sync` runs `uv lock`, `uv sync` and the locked `requirements.txt` export (`mainsequence` 9.0.5 or later); Node `code-repository sync` refreshes `package-lock.json` and runs `npm ci` (`@dev-mainsequence/command-center-sdk` 0.5.13 or later). No commit message, dry run, Git command or backend request: review the changes, then commit and push them yourself. An installed SDK that still has the retired release sync (`--dry-run`/`--message` in its sync help) is reported unavailable without running it; run `update-sdk`. |
| `sdk-status` | Isolated Python distribution metadata plus stable source version, or Node `application sdk-status`. A source version does not prove registry publication. |
| `update-sdk [--dry-run]` | Python `code-repository update-sdk` or Node `application update-sdk`; retains the project's existing dependency policy. |
| `update-agents` | Python SDK's packaged `AGENTS.md` managed-block update. |
| `install-skills [--dry-run]` | Node SDK's packaged skills installation. Python's current combined skills command requires MCP and is unsupported here. |
| `env-cleanup` | Remove legacy project credentials and keep the endpoint and unrelated settings; refuse tracked or symlink `.env` files. |
| `skills-sync` | Reports unsupported: backend-owned skills currently require MainSequence MCP. |
| `open-folder`, `signed-terminal` | Host capabilities exposed by the library. The initial Codex/terminal runner reports these as unsupported. |

Python dispatch uses `.venv/bin/mainsequence` (`Scripts/mainsequence.exe` on Windows). Node dispatch executes the project's installed `@dev-mainsequence/command-center-sdk/cli/command-center-sdk.mjs` with the runner's Node executable. No global SDK or sibling source path is a fallback. Command help is checked before dispatch; missing/older capabilities produce a structured error.

Versions and release tags of a CodeRepository are repository code, for example a GitHub Actions workflow; the platform deploys from Git pushes. `freeze-env` was removed because `sync` now writes the locked `requirements.txt`. For existing library callers, a sync request that still carries `message` is accepted and the message ignored, a `freeze-env` request reports `UNSUPPORTED_ACTION`, and the deprecated `sanitizeCommitMessage` export and `freezeEnv` CLI action name remain but build no command.

If `.env` still contains credentials, run `env-cleanup` explicitly before SDK dispatch. It removes canonical tokens, runtime credentials, the unsupported legacy token, and the runtime credential auth-mode assignment, including `export` and whitespace forms. It preserves unrelated application settings, keeps the endpoint in the VS Code extension's block (`# BEGIN MAINSEQUENCE AUTH (managed by VS Code)` … `# END MAINSEQUENCE AUTH`) as the extension writes it, excludes `.env` from Git, and writes it atomically with private permissions. A file already in that form is not written again.

Mutations hold a repository lock in the Git common directory, also covering linked worktrees. Before a clone exists, setup locks `.<folder>.mainsequence-devtools.lock` in its canonical parent directory. Cancellation stops the child process; failures after execution begins report partial or uncertain effects. A failed sync is never automatically retried or rolled back; the lock file, environment or exported requirements may have changed. After an abrupt process kill, inspect running actions before manually removing the stale lock (`mainsequence-devtools.lock` in the Git common directory, or the named setup lock).

Raw SDK output is private and is not included in results or hook output. Progress reports command lifecycle; supported structured status metadata is filtered. Run the SDK directly in a private terminal when its detailed diagnostic output is needed. Raw credentials are never arguments, public results, or model context.

## Codex plugin

The Codex plugin (`mainsequence` in the `mainsequence` marketplace, npm package `@dev-mainsequence/codex-plugin`) is built, verified and released from [mainsequence-codex-plugin](https://github.com/mainsequence-sdk/mainsequence-codex-plugin). It vendors the exact pinned devtools package into its artifact, so an installed plugin needs neither this checkout nor an npm download at execution time. Its hook runs the `/ms` slash-menu commands before inference, and its `mainsequence-mcp` skill exposes the MCP client above in conversation.

The marketplace file `.agents/plugins/marketplace.json` stays in this repository because people added it with `codex plugin marketplace add mainsequence-sdk/mainsequence-devtools`. It points at the published plugin package. Devtools 0.2.8 was the last package that carried the plugin itself, under the former name `mainsequence-devtools`; the plugin repository's README explains the migration.

## Reusable API

```ts
import { createDevTools, createNodeHost } from '@dev-mainsequence/devtools';

const tools = createDevTools({ host: createNodeHost() });
const result = await tools.dispatch({
  action: 'sync', root: '/path/to/project'
});
```

The same dispatcher serves the library, the CLI and the host runners (the Claude Desktop worker and the Codex hook). `parseArguments`, `tokenizeCommand` and `HELP` are exported so a host runner can parse the same command line as `ms-devtools`. `HostServices` supplies browser/process execution, safe progress, cancellation, and optional native folder/terminal operations. Shared code imports no host API. Public types include `ActionRequest`, `ActionResult`, `ProjectContext`, `ActionCapability`, and `SessionStatus`. Credentials stay private to the session service.

Version 0.3.0 publishes the library and the `ms-devtools` runner only: the npm archive contains `dist`, `README.md`, `LICENSE` and `NOTICE`. VS Code and Claude Desktop pin exact published versions; the Codex plugin does the same from its own repository. See [release and installation](docs/phase-2-release.md) for the publishing procedure, which is unchanged. VS Code's existing SecretStorage fallback remains in that extension; no host introduces fallback project-token projection.

## Verification

```sh
npm run release:check
node scripts/verify-sdk-interop.cjs /path/to/mainsequence-sdk /path/to/command-center-sdk
```

`release:check` type-checks, builds, runs the tests, checks release metadata and the Codex marketplace file, packs the npm archive into `artifacts/` and verifies it from an isolated consumer. The Codex host checks moved to the plugin repository with the plugin.

Tests use a loopback fixture backend, synthetic in-memory store entries, stand-ins for native store programs, installed-CLI fixtures, and temporary Git repositories. They never log in to a real backend or read/write the user's credentials. Loopback networking must be permitted to run the browser tests. The parser, tokenizer and terminal runner have their own suite in `tests/arguments.test.cjs`, since host runners depend on them.

The optional SDK compatibility script checks the **actual provided SDK source implementations** against synthetic in-memory records in both directions, with an isolated temporary Python home. It imports the SDK private session implementation only for compatibility verification, never as a product dependency, and loads its dependencies from the specified checkout without running the SDK initializer. Set `MAINSEQUENCE_TEST_PYTHON=/path/to/sdk/.venv/bin/python` when its CLI dependencies are unavailable to `python3`. Native-store behavior is tested using the extracted macOS/Linux program fixtures; live OS-store and backend refresh-rotation interoperability require a separate release check.

See [ADR 0001](docs/adr/0001-shared-developer-tooling-and-codex.md), [ADR 0004](docs/adr/0004-shared-project-tool-registry.md), [Phase-1 verification](docs/phase-1-verification.md) and [Phase-2 verification](docs/phase-2-verification.md) for boundaries and outstanding checks.

## Phase 2 host integration

`createSessionService` owns browser authorization, authenticated HTTP, refresh and revocation. `RepositoryClient` owns the canonical backend response and Git-resolution contracts. `createDevTools` owns project actions and cancellation. Hosts import only `@dev-mainsequence/devtools`; no private paths or sibling SDK source imports are used.

`HostAuthSession` is an opt-in compatibility adapter for asynchronous host SecretStorage, machine-session adoption, and the existing host projection/migration policy. Its `get`, `save`, `environment` and `persistence` methods are privileged credential bridges for host internals: never put their values in webview state, progress, logs, hook output, or action results. Codex uses native persistence directly and does not enable this fallback.

## Shared operations and integration ownership

Version 0.2.2 adds the [public project operations API](docs/shared-project-operations.md).
Claude Desktop is maintained in [its own repository](https://github.com/mainsequence-sdk/mainsequence-claude-desktop).
The Codex plugin is maintained in [its own repository](https://github.com/mainsequence-sdk/mainsequence-codex-plugin) since 0.3.0.
See the [integration roadmap](docs/integration-roadmap.md) for ownership and the deferred OpenCode extraction.

Workspace defaults and environment-scoped MCP host APIs are documented in
[workspace settings and environments](docs/workspace-environments.md).

Version 0.2.4 adds the reusable [agent directory and conversation API](docs/agent-conversations.md),
using existing platform MCP contracts and the selected organization environment.
Claude's pane and prompt integration remain in its own repository.
