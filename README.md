# MainSequence developer tooling

One TypeScript package owns the shared action models, browser authentication, machine session, repository resolution, project dispatch, command runner, and Codex adapter. Both SDK repositories remain unchanged. VS Code now consumes the public package API and bundles its compiled code into the VSIX. There are no runtime npm dependencies, LLM calls, or MainSequence MCP calls in the implemented action path.

## Build and run

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
node dist/runner.js sync --path "/path/to/project" --message "Update environment"
```

Login and session status work before either SDK is installed. Login opens the existing hosted browser authorization flow with PKCE and a loopback callback; account creation remains part of that hosted flow. The runner checks the store before opening a browser and reads back the saved pair before reporting success.

Persistent login uses macOS Keychain or Linux Secret Service (`secret-tool` from libsecret). Windows has no native persistent Node store in this extracted implementation. A deliberately supplied `MAINSEQUENCE_ACCESS_TOKEN` with its matching `MAINSEQUENCE_ENDPOINT` supports a process/CI identity. A rejected process identity never falls back to another saved identity. Runtime credentials are a separate application lane and are not accepted for these developer actions.

The machine record is the SDKs' existing `MainSequenceCLI.auth` service, backend-scoped account, and version-1 JSON format. There is no Codex-specific credential record and no token file. `refresh-token` renews the saved machine session; it does not replace a token exported into another shell. `logout` removes this backend's local record and separately reports whether remote revocation completed.

## Project actions

Backend selection uses an explicit `--backend`, process `MAINSEQUENCE_ENDPOINT`, the Git-root `.env` endpoint, existing CLI configuration, then the standard backend. Project selection validates the real Git root, attached branch, full HEAD SHA, and canonical remote identity. Ambiguous Python/frontend projects require `--type python` or `--type vite_react`.

| Command | Behavior |
| --- | --- |
| `status` | Local Git context, session metadata, and installed command capabilities. |
| `resolve` | Existing backend Git-context resolution with identity/branch/ref/commit validation. |
| `setup --uid UID --branch BRANCH --base-dir DIR [--install]` | Fetch the registered binding; reuse/register the repository SSH key; verify access; clone into `<base>/<org>/projects/<name>-<uid>`; write endpoint-only `.env`; optionally install dependencies. Existing checkout folders are never replaced. |
| `install` | `uv sync` for Python; `npm ci` for frontend projects. |
| `sync --message TEXT [--dry-run]` | The project-installed SDK's existing sync workflow. |
| `freeze-env` | Python SDK `code-repository freeze-env`. |
| `sdk-status` | Isolated Python distribution metadata plus stable source version, or Node `application sdk-status`. A source version does not prove registry publication. |
| `update-sdk [--dry-run]` | Python `code-repository update-sdk` or Node `application update-sdk`; retains the project's existing dependency policy. |
| `update-agents` | Python SDK's packaged `AGENTS.md` managed-block update. |
| `install-skills [--dry-run]` | Node SDK's packaged skills installation. Python's current combined skills command requires MCP and is unsupported here. |
| `env-cleanup` | Remove legacy project credentials and keep the endpoint and unrelated settings; refuse tracked or symlink `.env` files. |
| `skills-sync` | Reports unsupported: backend-owned skills currently require MainSequence MCP. |
| `open-folder`, `signed-terminal` | Host capabilities exposed by the library. The initial Codex/terminal runner reports these as unsupported. |

Python dispatch uses `.venv/bin/mainsequence` (`Scripts/mainsequence.exe` on Windows). Node dispatch executes the project's installed `@dev-mainsequence/command-center-sdk/cli/command-center-sdk.mjs` with the runner's Node executable. No global SDK or sibling source path is a fallback. Command help is checked before dispatch; missing/older capabilities produce a structured error.

If `.env` still contains credentials, run `env-cleanup` explicitly before SDK dispatch. It removes canonical tokens, runtime credentials, the unsupported legacy token, and the runtime credential auth-mode assignment, including `export` and whitespace forms. It preserves unrelated application settings, keeps the endpoint in the VS Code extension's block (`# BEGIN MAINSEQUENCE AUTH (managed by VS Code)` … `# END MAINSEQUENCE AUTH`) as the extension writes it, excludes `.env` from Git, and writes it atomically with private permissions. A file already in that form is not written again.

Mutations hold a repository lock in the Git common directory, also covering linked worktrees. Before a clone exists, setup locks `.<folder>.mainsequence-devtools.lock` in its canonical parent directory. Cancellation stops the child process; failures after execution begins report partial or uncertain effects. Sync is never automatically retried or rolled back after commits, tags, or pushes may have happened. After an abrupt process kill, inspect running actions before manually removing the stale lock (`mainsequence-devtools.lock` in the Git common directory, or the named setup lock).

Raw SDK output is private and is not included in results or hook output. Progress reports command lifecycle; supported structured status metadata is filtered. Run the SDK directly in a private terminal when its detailed diagnostic output is needed. Raw credentials are never arguments, public results, or model context.

## Codex artifact and slash-menu entry

`npm run build` creates the installable plugin directory at `artifacts/codex/mainsequence-devtools/`, containing `.codex-plugin/plugin.json`, the `ms` skill registration, hook configuration, and the compiled runner. `npm run pack:plugin` also creates a standalone `.tgz`. The artifact runs without this checkout, sibling repositories, `node_modules`, or an npm download at execution time; Node 22+ remains a runtime prerequisite. Codex 0.159.2 skips hooks from the newer root Agent Plugins manifest; the compatibility entry point is deliberate and was verified in the installed host.

Load the built directory through your Codex local plugin installation workflow, then review and trust its hook definition. Plugin installation does not automatically trust hooks. Packaging follows [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins); the prompt handler uses the documented [UserPromptSubmit blocking decision](https://learn.chatgpt.com/docs/hooks).

After a terminal installation, start a new Codex chat or toggle MainSequence Developer Tools off and on in the desktop Plugins settings to hot-reload existing chats. An already-loaded chat can display the skill entry while retaining its pre-install hook configuration. The isolated reload regression in `scripts/verify-codex-reload.cjs` verifies this distinction.

In Codex desktop, type `/ms` and **select `ms` from the slash menu**, then append the arguments and submit. Enabled skills supply native slash-menu entries; this small, explicit-only skill registers the interface. The trusted hook executes the action before inference. See [Codex slash commands](https://learn.chatgpt.com/docs/reference/slash-commands). Examples, shown in slash-command notation:

```text
/ms --help
/ms login --backend https://api.main-sequence.app
/ms refresh-token --backend https://api.main-sequence.app
/ms status
/ms sync --message "Update environment"
```

Selection inserts a native skill mention. The hook accepts that linked mention only when it references this plugin's own `skills/ms/SKILL.md`, then parses the single-line arguments as data; no shell expansion or evaluation occurs. It also handles literal `/ms` input if a host submits it. Ordinary prompts pass through without dispatch. Handled actions return a blocking decision on both success and failure, with readable, token-free output in the hook reason/UI message. The default help is a compact getting-started menu; `/ms --help --all` lists every supported command and `/ms COMMAND --help` shows its options. Repository results show names, branches and IDs; account/project results use readable labels and summaries. JSON is an explicit export with `--json`; default results never dump the data object. Codex's “Hook blocked this message” label means the hook stopped the prompt before inference; the result itself states whether the action succeeded or failed. The hook enforces a bounded action timeout.

**Installed registration and execution are verified; desktop presentation still needs a manual check.** Actual Codex 0.159.2 `skills/list` reports the enabled `mainsequence-devtools:ms` entry with display name `ms`. App-server turns using its linked mention and explicit skill input verify blocking results and zero requests to a counted offline model endpoint for successful, invalid and incomplete commands. Ordinary prompts reach that endpoint. The desktop menu/rendering and long-operation timeout UI have not been visually verified. Codex CLI 0.159.2 rejects custom `/ms` commands before submitting a turn; use `ms-devtools --help` in a terminal there. The skill supplies registration only; the executor is the local hook/runner and requires no MainSequence MCP. A disabled or untrusted hook cannot guarantee interception, so review and trust it before use. VS Code retains its existing opt-in SDK-owned MCP skills workflows.

## Reusable API

```ts
import { createDevTools, createNodeHost } from '@dev-mainsequence/devtools';

const tools = createDevTools({ host: createNodeHost() });
const result = await tools.dispatch({
  action: 'sync', root: '/path/to/project', message: 'Update environment'
});
```

The same dispatcher serves the library, CLI, and Codex hook. `HostServices` supplies browser/process execution, safe progress, cancellation, and optional native folder/terminal operations. Shared code imports no host API. Public types include `ActionRequest`, `ActionResult`, `ProjectContext`, `ActionCapability`, and `SessionStatus`. Credentials stay private to the session service.

Phase 2 publishes `@dev-mainsequence/devtools@0.2.0` to public npm and migrates VS Code to that exact archive. One npm artifact contains the public library, runner, and Codex plugin manifest/hooks; the standalone plugin archive comes from the same build. Later Codex fixes on `main` require a new version before publication; see [release and installation](docs/phase-2-release.md). VS Code's existing SecretStorage fallback remains in that extension; Codex introduces no fallback project-token projection. Claude Code and OpenCode adapters are not created until their host execution contracts are validated.

## Verification

```sh
npm run typecheck
npm test
npm run pack:plugin
npm pack --ignore-scripts --pack-destination artifacts
node scripts/verify-package.cjs artifacts/dev-mainsequence-devtools-0.2.0.tgz
node scripts/verify-sdk-interop.cjs /path/to/mainsequence-sdk /path/to/command-center-sdk
# Optional, after installing and reviewing the plugin hook:
node scripts/verify-codex-host.cjs
```

Tests use a loopback fixture backend, synthetic in-memory store entries, stand-ins for native store programs, installed-CLI fixtures, and temporary Git repositories. They never log in to a real backend or read/write the user's credentials. Loopback networking must be permitted to run the browser tests.

The optional SDK compatibility script checks the **actual provided SDK source implementations** against synthetic in-memory records in both directions, with an isolated temporary Python home. It imports the SDK private session implementation only for compatibility verification, never as a product dependency. Native-store behavior is tested using the extracted macOS/Linux program fixtures; live OS-store and backend refresh-rotation interoperability require a separate release check.

See [ADR 0001](docs/adr/0001-shared-developer-tooling-and-codex.md), [Phase-1 verification](docs/phase-1-verification.md) and [Phase-2 verification](docs/phase-2-verification.md) for boundaries and outstanding checks.

## Phase 2 host integration

`createSessionService` owns browser authorization, authenticated HTTP, refresh and revocation. `RepositoryClient` owns the canonical backend response and Git-resolution contracts. `createDevTools` owns project actions and cancellation. Hosts import only `@dev-mainsequence/devtools`; no private paths or sibling SDK source imports are used.

`HostAuthSession` is an opt-in compatibility adapter for asynchronous host SecretStorage, machine-session adoption, and the existing host projection/migration policy. Its `get`, `save`, `environment` and `persistence` methods are privileged credential bridges for host internals: never put their values in webview state, progress, logs, hook output, or action results. Codex uses native persistence directly and does not enable this fallback.
