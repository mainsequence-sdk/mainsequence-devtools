# Phase 2 verification — updated 2026-10-01

The shared package and VS Code migration are implemented. The public npm registry now serves `@dev-mainsequence/devtools@0.2.0`; its published archive has integrity `sha512-fdaeHMB/PHP3f+aXNJox2Py6k5wnHWck/5gjsZ8OCLLVANTimPUlzrMaimpEt0RAJX3nRPS5q9nmBugAZSjoGg==`. VS Code pins that published archive. `mainsequence-devtools@mainsequence-local` is installed, enabled and trusted in the local Codex plugin cache (`~/.codex/plugins/cache/mainsequence-local/mainsequence-devtools/0.2.0`). This local development installation includes the subsequent Codex line-ending and readable-output fixes on `main`; those changes require a new version before the next npm publication. The published 0.2.0 archive must not be replaced.

## Shared package and consumer

- Strict TypeScript compilation and 58 shared tests pass. Fixtures cover the canonical credential record, browser authorization, refresh rotation, rejection/identity boundaries, host fallback, repository resolution, SDK dispatch, bounded Codex sync preflight, cancellation and hook packaging.
- The migrated `ms-vscode-extension` compiles and its 43 tests pass, including Python distribution status with `MAINSEQUENCE_TEST_PYTHON` set to the SDK virtual environment. New adapter checks cover shared session renewal, native versus fallback credential handoff, literal SDK arguments, Electron's Node mode, cancellation and workspace trust. Existing user changes were retained.
- The public npm archive works from an isolated ESM consumer without SDKs or runtime npm dependencies. Private deep imports are rejected by package exports.
- VS Code pins the published 0.2.0 archive and bundles its installed public distribution into `out/vendor/devtools`. Its packaged VSIX contains that distribution and version metadata, without runtime `node_modules`, sibling checkouts or private package imports. The lockfile integrity identifies the registry archive rather than a later development build with the same version.
- Synthetic interoperability checks pass in both directions against the actual Python SDK `development` and Command Center SDK `main` session implementations. Both SDK repositories remain unchanged. These checks do not access the user's credential store or log in to a live backend.

## Installed Codex host

Codex 0.159.2 recognized the initial root Agent Plugins manifest but returned no hook from `hooks/list` or `plugin/read`. The supported `.codex-plugin/plugin.json` entry point exposes the hook correctly. The package now ships only that entry point, and packaging checks reject a root `plugin.json` that would take precedence and suppress hooks.

The CLI `/hooks` review showed the exact installed runner command, synchronous mode and 600-second host timeout. Only MainSequence's hook was trusted. A subsequent app-server query returned `trustStatus: "trusted"`, `enabled: true`, and the installed plugin's source path. The original implementation tested only a text prefix; that did not register a Codex interface. It has been replaced by an explicit-only `ms` skill for native desktop slash-menu registration and a hook that recognizes its linked mention. `skills/list` now returns an enabled `mainsequence-devtools:ms` entry with display name `ms`, and `plugin/read` exposes both the skill and hook. Duplicate result warnings were removed after observing host presentation.

`scripts/verify-codex-host.cjs` tests actual app-server turns using an ephemeral session and a counted loopback model fixture, with the MainSequence MCP server disabled for that session. It verifies the installed skill registry and submits the native linked mention together with an explicit skill input item. No real inference endpoint is used:

| Prompt | Action result | Host hook status | Model requests |
| --- | --- | --- | --- |
| selected `ms` + `--help` | success | blocked | 0 |
| selected `ms` + `--help --json` | success, structured output requested explicitly | blocked | 0 |
| literal `/ms --help --all` | success, complete command menu | blocked | 0 |
| literal `/ms sync --help` | success, command-specific options | blocked | 0 |
| selected `ms` + `--help` with the desktop's trailing newline | success | blocked | 0 |
| selected `ms` without arguments, with a trailing newline | success, help | blocked | 0 |
| selected `ms` + `invalid-action` | failure | blocked | 0 |
| selected `ms` + `sync` | failure, missing required arguments | blocked | 0 |
| literal `/ms --help` submitted via app-server | success | blocked | 0 |
| literal `/ms --help` ending in LF or CRLF | success | blocked | 0 |
| literal `/ms --help` followed by `status` on another line | failure, invalid request | blocked | 0 |
| ordinary fixture prompt | passes through | completed | 1, to the offline fixture |
| `:ms --help` | passes through | completed | 1, to the offline fixture |

The hook result is present in the host event stream on success and failure. The fixture intentionally rejects the ordinary prompt's model request; it proves pass-through without consuming inference. This check is opt-in and requires an installed, enabled, reviewed hook; it never bypasses hook trust. It does not operate the desktop composer. Static inspection of the installed desktop code confirms that enabled skills register slash entries using their display name and selecting one inserts a linked mention. A live CLI composer check confirms that Codex CLI 0.159.2 rejects custom `/ms` input before submission; the app-server literal-input test does not establish CLI slash support. Use the terminal runner in the CLI.

## Existing-chat reload regression — 2026-10-01

The user's selected native `ms` entry with `--help` reached the model in this pre-existing desktop chat. Menu registration was demonstrated by the linked skill mention, but interception did not occur. The plugin configuration was enabled and its exact hook hash was trusted; that alone does not establish that a loaded chat has adopted the hook.

`scripts/verify-codex-reload.cjs` reproduces this in a temporary Codex home with this repository's plugin artifact and a counted offline model fixture. It starts a thread while the plugin is disabled, enables the plugin externally, and compares that loaded thread with a new thread and a supported configuration hot reload:

| Case | Hook runs | Model requests |
| --- | --- | --- |
| Existing thread after external enable | none | 1, rejected by offline fixture |
| New thread in the same backend | blocked | 0 |
| Existing thread after `config/batchWrite` with `reloadUserConfig: true` | blocked | 0 |

The fixture copies only this exact previously reviewed MainSequence hook definition's trust hash; it uses no live authentication and configures no MCP server. Assertions require completed turns and the above results.

A terminal installation does not hot-reload a chat that was already running. Toggle MainSequence Developer Tools off and on in the desktop Plugins settings; the installed app's plugin setting code sends `config/batchWrite` with `reloadUserConfig: true`. Alternatively, start a new Codex chat after installation.

The user's subsequent screenshot shows the hook blocking the native entry in this chat. Its failure exposed a second issue: the desktop composer appends a newline to submitted text, which the single-line parser rejected. The adapter now removes trailing layout whitespace before parsing while retaining rejection of embedded newlines. Adapter tests and installed-host checks accept the exact trailing-newline form with zero model requests. The user subsequently supplied the successful help result from the desktop.

## Readable Codex output — 2026-10-01

That successful help result was displayed as compact JSON with escaped newlines. The first presentation fix removed the envelope but still dumped each command's `data` object and reused the dense terminal help. The Codex adapter now has its own presentation layer: a short getting-started menu, a full menu at `/ms --help --all`, command-specific options, named repository entries, account summaries and readable project/SDK fields. Default output contains no serialized data objects or internal store/lock metadata. Clear failure messages include next steps where appropriate; partial-effect warnings remain visible. Explicit `--json` retains the unchanged versioned action result and error codes, and a literal `--json` message value does not select export mode.

The installed-host fixture asserts actual line breaks, the command menus, absence of a JSON envelope, and zero model requests; it separately checks explicit JSON output. Formatter fixtures cover repository lists, empty results, machine-session status, project capabilities and SDK source-versus-registry distinctions. Codex still marks the hook as blocked because it stops the prompt before inference, including after successful actions. This changes the text presentation rather than replacing the host-owned card or adding interactive components. The subsequent desktop screenshot confirms the compact getting-started menu; runtime API tests verify the other field layouts.

## Sync execution regression — 2026-10-02

A sync submission displayed the desktop's generic “Thinking” placeholder without a result. The hook had acquired the repository action lock at the submission time, but the SDK's backend lookup stalled. The saved CLI backend was an unavailable localhost service. A direct read-only SDK preflight continued retrying until it was stopped at 45 seconds; the original Codex turn was interrupted after 30 seconds, leaving a stale lock and no new commit. The lock was removed only after checking that its owner had exited and no SDK sync, Git, or dependency operation remained.

The Codex host now checks backend reachability before starting the SDK sync workflow. This unauthenticated HEAD request has a five-second deadline, does not follow redirects, and discards response content. An unavailable backend produces a readable `BACKEND_UNREACHABLE` result that blocks the prompt before inference, releases the lock, and reports no project mutations. A reachable backend continues to the existing SDK, which owns authentication and sync. The shared host interface provides an optional `prepareProjectAction` callback; other hosts keep their existing behavior. Neither SDK was changed. Network failures after the SDK starts remain subject to its own behavior and the runner's cancellation/timeout handling.

The installed-host verification now exercises valid sync commands in temporary Python and JavaScript repositories. Their project-local SDK fixtures pause deliberately, then create real commits and tags. Assertions check the exact message from the reported submission, literal and native skill inputs, zero model requests while the SDK is running and after completion, and removal of the repository lock. Separate unavailable-backend cases assert zero SDK workflow executions, zero model requests, and no reported mutations. Earlier help-only host checks did not establish this behavior.

Run `MAINSEQUENCE_CODEX_UNAVAILABLE_PROJECT=/absolute/project/path node scripts/verify-codex-host.cjs` to additionally check an affected project's real SDK with a read-only dry run against its known unavailable backend. This opt-in check asserts a blocking backend failure and zero model requests. It does not perform a live release or push.

That opt-in check was run for the affected project with the updated installed plugin: the hook returned `BACKEND_UNREACHABLE` in approximately 1.3 seconds, with zero model requests. The local backend subsequently came online. A second opt-in check using `MAINSEQUENCE_CODEX_SYNC_PROJECT=/absolute/project/path` ran the real SDK's successful read-only sync preflight through Codex in approximately four seconds, again with zero model requests. Tests did not commit, tag, or push this project's pending changes; those mutations are exercised only in the temporary fixture repositories.

## Remaining release checks

- Assign a new package/plugin/catalog version before publishing the later Codex fixes, then confirm the new registry archive's integrity. Configure trusted publishing before using the release workflow for subsequent versions. Do not attempt to republish 0.2.0.
- Manually verify the desktop renderer after restarting/reloading the app. Computer-use tooling refuses access to the Codex app, so GUI validation could not be completed automatically. The installed host runtime, event stream and CLI presentation were tested directly.
- Check the long-operation progress, cancellation and timeout UI in the desktop host. The runner's timeout and cancellation contracts have fixture coverage, but a full-duration desktop operation was not run.
- Validate live OS-store refresh rotation across all supported platforms and a real backend/Git setup/sync deployment. The automated suites use synthetic identities, loopback backends and temporary repositories.
