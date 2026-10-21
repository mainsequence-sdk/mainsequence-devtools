# OpenCode V2 adapter

The adapter ships inside `@dev-mainsequence/devtools` 0.3.0. The root export remains the shared library used by VS Code. Codex hooks/skills and the OpenCode artifact come from the same build. There is no additional published npm package, runtime npm dependency, backend service or SDK change.

## Install

From this checkout:

```sh
npm ci
npm run build
node dist/runner.js opencode-install --global
# Or install only for one project:
node dist/runner.js opencode-install --project "/path/to/project"
```

The global destination is `$XDG_CONFIG_HOME/opencode/plugins/mainsequence-devtools`, defaulting to `~/.config/opencode/plugins/mainsequence-devtools`. The project destination is `<project>/.opencode/plugins/mainsequence-devtools`. OpenCode discovers the server entry and its `./tui` export automatically. Restart OpenCode after installation. Repeating installation updates only an artifact with the expected ownership marker; an unrecognized directory is preserved and reported. Other plugins and JSON/JSONC configuration are untouched.

For the built npm archive, use `npm exec --package /absolute/path/dev-mainsequence-devtools-0.3.0.tgz -- ms-devtools opencode-install --global`. After 0.3.0 is published, use `npx @dev-mainsequence/devtools@0.3.0 opencode-install --global`. The previously published 0.2.1 archive does not contain this adapter. Building or installing locally does not publish a release.

The installer records the actual Node executable in `runtime.json`. Node 22+ must be available on the server machine. OpenCode's bundled Bun executable is not the Node SDK runner. A manually configured local plugin can override `nodePath` and the default backend through trusted OpenCode plugin options:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/devtools/opencode",
      "options": {
        "nodePath": "/absolute/path/to/node",
        "backend": "https://api.main-sequence.app"
      }
    }
  ]
}
```

Configure a local artifact directory, rather than the npm package root: its root export deliberately remains a library. Explicit consumers can import `@dev-mainsequence/devtools/opencode`, `/opencode/tui`, and `/opencode/rpc`. Do not configure both an auto-discovered installed artifact and another copy for the same location. For a remote server, install the server artifact there and configure the terminal entry locally using OpenCode's `cli.json` plugins setting with the local `tui.mjs` path. The terminal uses location-scoped RPC; project files, authentication and MCP networking belong to the server. Remote terminal deployment requires its own host validation.

To uninstall, remove only the installed `mainsequence-devtools` artifact directory and restart OpenCode. This does not delete developer authentication or saved MCP selections.

## Commands and UI

`/ms --help`, `/ms status`, `/ms sync`, `/ms login` and `/ms refresh-token` use native executable commands. Both the terminal slash action and the server command handler execute directly; neither calls session prompt/generate or a model. Selecting slash completion can insert the command first; submit it to execute. `/ms` opens a searchable menu grouped into Account, Projects, Maintenance and MCP. The command palette also provides sync, account, MCP connect and recent-action entries.

Running actions have native notifications and a progress dialog. Continue working to leave an operation in the background, or cancel it using the dialog or Ctrl+C while that dialog is open. Recent actions allows cancellation and inspection of results. Readable results show account state, project fields and uncertain-effect messages. The shared dispatcher never exposes private SDK output. RPC transports structured results; ordinary terminal results are human-readable. The standalone CLI retains `--json` for exports.

`sync` has the current dependency-only meaning: Python updates its lock/environment/export; Node refreshes its lockfile and installs locked dependencies. It does not commit or push. Retired commit-message/dry-run arguments produce a direct error. Missing SDKs, invalid arguments and failures remain in the command path. A command outside a Git project can still run help and account operations.

## MCP lifecycle and permissions

“Connect a project MCP” calls the existing `resource_release.mcp_endpoints` directory, supports search and pagination, and shows project plus Environment names. Release UUIDs distinguish duplicates. Selection verifies and saves through shared `mcp-add`, then reloads the native tool registry. Manage connections can read catalogs or disconnect. `/ms mcp-refresh` refreshes current backend selections; startup restores them. Failed catalogs are reported by refresh, and a removed/inaccessible project has no newly registered tools.

Conversational tools are `mainsequence_discover`, `mainsequence_connections`, `mainsequence_connect`, `mainsequence_disconnect`, `mainsequence_tools` and `mainsequence_refresh`. Project tools use a namespace derived from backend plus release UUID and a normalized name with an original-name hash. This prevents display-name and punctuation collisions. OpenCode's Code Mode exposes them under `tools.<namespace>.<tool>(arguments)` using the current server schemas. Reconnect or refresh after a catalog changes.

Each native tool has a corresponding OpenCode permission action equal to its effective tool ID, with the host's ordinary resource matching. Every nested Code Mode call still checks that permission. The adapter introduces no separate agent allowlist. Explicit commands and UI choices are user actions. Platform authorization is checked again on every project invocation; credentials are exchanged privately, canonical endpoints are revalidated, unknown current tools are refused, and writes are not replayed.

The connection file and authentication store are exactly those described in [the existing MCP guide](conversational-mcp.md). Credentials do not enter OpenCode configuration, RPC events, tool arguments or process arguments. Failed/cancelled mutations preserve uncertain-effect reporting. Connecting a project registers plugin tools, not a native MCP server entry. No external MCP registry publication is needed to consume the platform directory.

OpenCode 2.0.27's plugin `permission` option affects catalog visibility but does not assert `ask` rules. `permissions.mjs` therefore uses the host's existing Effect permission service, matching the built-in MCP executor. This is an isolated internal service-key dependency, not a copied permission evaluator. Missing service support makes conversational tools fail before execution while explicit commands remain available. Use the tested host version; replace this bridge when OpenCode exposes a public assertion method. The native verification checks deny, allow and ask, including no project call before approval.

## Verify

Tested host target: official `@opencode/cli` and `@opencode/plugin` **2.0.27**. V1 uses a different plugin API and is unsupported.

```sh
npm run typecheck
npm test
npm run release:check
MS_OPENCODE_BINARY=/absolute/path/to/opencode npm run verify:opencode
# Also drive the native terminal through a PTY (requires Python 3):
MS_OPENCODE_BINARY=/absolute/path/to/opencode MS_OPENCODE_TUI=1 npm run verify:opencode
# Validate the packed npm artifact in the host and terminal as CI does:
MS_OPENCODE_BINARY=/absolute/path/to/opencode MS_OPENCODE_TUI=1 npm run verify:package
```

The native verification installs into a temporary project, creates an isolated host home/config, and uses synthetic SDKs, platform and project servers. It counts zero provider/model requests and zero agent messages for executable help, errors and sync, checks exact SDK dispatch, cancellation and readable results, and exercises discovery, live schemas, release-credential renewal and disconnect. Separate conversational permission checks use a counted loopback fake model; no real provider or key is used. PTY verification types slash commands and checks the rendered native help and action/MCP menu. Unit tests exercise workspace isolation, safe IPC, owned installation and unload.

This verifies local native host behavior and fixture interoperability. It does not prove real organization login/access, remote-server terminal deployment or every terminal's appearance. Browser sign-in and OS-store support retain the existing shared limitations.

On 2026-10-12, all 82 regression tests, type checks, release metadata and isolated package-consumer checks passed. The local 0.3.0 npm archive passed actual OpenCode 2.0.27 server and PTY checks: help, invalid input, dependency sync and cancellation made zero model requests or agent messages; terminal help, SDK sync results and the action/MCP menu rendered; discovery, live schemas, credential rotation, disconnect and native deny/allow/ask/reject behavior passed. The archive is prepared locally and has not been published.
