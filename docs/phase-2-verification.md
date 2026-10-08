# Phase 2 verification — updated 2026-10-08

The shared package and VS Code migration are implemented. The public npm registry serves `@dev-mainsequence/devtools@0.2.1`; its downloaded archive matches VS Code's lockfile integrity `sha512-7cYZN5fUJi4347BO38LES6Uvi+p+szR+SqLiv9ngsnC91S/6vcoKIfRr38xCcSJ0LmG4vlx+namtLqmDSzxt7g==`. This release includes the Codex line-ending and readable-output fixes and dependency-only sync. `mainsequence-devtools@mainsequence-local` is installed, enabled and trusted in the local Codex plugin cache (`~/.codex/plugins/cache/mainsequence-local/mainsequence-devtools/0.2.1`). All 50 compiled runner, plugin, hook, skill and asset files match the repository build. Published archives remain immutable.

## Compatibility audit — 2026-10-08

All four repositories' remote refs were fetched. These are the integration baselines checked:

| Repository | Ref | Commit | Version |
| --- | --- | --- | --- |
| Developer tools | `origin/main` | `e46888e` | 0.2.1 |
| VS Code extension | `origin/main` | `48ddfc3` | 0.1.47; pins devtools 0.2.1 |
| Python SDK | `origin/development` | `5ebcd264` | 9.0.20 declared as the next release; publication not checked |
| Command Center SDK | `origin/main` | `519008a` | 0.5.16 |

Developer tools, VS Code and Command Center SDK matched their fetched main branches. The local Python SDK `development` checkout was four commits behind; the entire difference was version declarations in `pyproject.toml` and `uv.lock`. Its CLI and authentication source used in the interoperability check is identical to fetched `origin/development`.

Recent Python SDK changes add projected workload identity tokens for runtime credentials and exclude credentials from diagnostic representations. Developer browser authorization, refresh endpoints and the version-1 machine-session record remain compatible with the shared tooling. Synthetic record interoperability passed in all directions between developer tools and both SDKs, for two backend identities. The verification script now isolates the requested Python source package so a new CLI dependency cannot accidentally import and initialize an older globally installed SDK. Both the SDK virtual-environment interpreter and default `python3` passed.

VS Code's package and lockfile already pinned 0.2.1, but its local `node_modules` still held 0.2.0. The verified published archive replaced that dependency using `scripts/use-local-devtools.cjs`; a fresh compile regenerated `out/vendor/devtools` at 0.2.1 and all 43 tests passed. No VS Code source or lockfile change was required. Neither SDK was modified.

Codex 0.162.0-alpha.2 passed 13 help/error/pass-through cases and two valid dependency-sync cases against the installed plugin. Python and Node SDK fixtures executed with zero backend requests, zero model requests both during execution and afterward, refreshed dependency files, unchanged Git HEAD/tags and released locks. The isolated existing-chat reload regression also passed on this host: an external enable alone does not reload an existing chat, while a new chat or supported configuration hot reload intercepts commands with zero model requests. These checks exercise the actual host API, not the desktop composer or a live project's dependency installation.

## Shared package and consumer

- Strict TypeScript compilation and 62 shared tests pass. Fixtures cover the canonical credential record, browser authorization, refresh rotation, rejection/identity boundaries, host fallback, repository resolution, dependency-only SDK sync, rejection of retired SDK sync capabilities, cancellation and hook packaging.
- The migrated `ms-vscode-extension` compiles and its 43 tests pass, including Python distribution status with `MAINSEQUENCE_TEST_PYTHON` set to the SDK virtual environment. New adapter checks cover shared session renewal, native versus fallback credential handoff, literal SDK arguments, Electron's Node mode, cancellation and workspace trust. Existing user changes were retained.
- The public npm archive works from an isolated ESM consumer without SDKs or runtime npm dependencies. Private deep imports are rejected by package exports.
- VS Code pins the published 0.2.1 archive and bundles its installed public distribution into `out/vendor/devtools`. Earlier Phase 2 VSIX checks established that packaging includes the vendored distribution and version metadata without runtime `node_modules`, sibling checkouts or private package imports. The October 8 audit rebuilt the vendor directory and ran the consumer tests; it did not install a new VSIX. The lockfile integrity identifies the registry archive rather than a later development build with the same version.
- Synthetic interoperability checks pass in both directions against the actual Python SDK `development` and Command Center SDK `main` session implementations. Both SDK repositories remain unchanged. These checks do not access the user's credential store or log in to a live backend.

## Installed Codex host

Codex 0.159.2 recognized the initial root Agent Plugins manifest but returned no hook from `hooks/list` or `plugin/read`. The supported `.codex-plugin/plugin.json` entry point exposes the hook correctly. The package now ships only that entry point, and packaging checks reject a root `plugin.json` that would take precedence and suppress hooks.

The CLI `/hooks` review showed the exact installed runner command, synchronous mode and 600-second host timeout. Only MainSequence's hook was trusted. A subsequent app-server query returned `trustStatus: "trusted"`, `enabled: true`, and the installed plugin's source path. The original implementation tested only a text prefix; that did not register a Codex interface. It has been replaced by an explicit-only `ms` skill for native desktop slash-menu registration and a hook that recognizes its linked mention. `skills/list` now returns an enabled `mainsequence-devtools:ms` entry with display name `ms`, and `plugin/read` exposes both the skill and hook. Duplicate result warnings were removed after observing host presentation.

`scripts/verify-codex-host.cjs` tests actual app-server turns using an ephemeral session and a counted loopback model fixture, with the MainSequence MCP server disabled for that session. It verifies the installed skill registry and submits the native linked mention together with an explicit skill input item. The following current cases passed on Codex 0.162.0-alpha.2 on October 8. No real inference endpoint is used:

| Prompt | Action result | Host hook status | Model requests |
| --- | --- | --- | --- |
| selected `ms` + `--help` | success | blocked | 0 |
| selected `ms` + `--help --json` | success, structured output requested explicitly | blocked | 0 |
| literal `/ms --help --all` | success, complete command menu | blocked | 0 |
| literal `/ms sync --help` | success, command-specific options | blocked | 0 |
| selected `ms` + `--help` with the desktop's trailing newline | success | blocked | 0 |
| selected `ms` without arguments, with a trailing newline | success, help | blocked | 0 |
| selected `ms` + `invalid-action` | failure | blocked | 0 |
| selected `ms` + `sync --message "retired option"` | failure, retired option explained | blocked | 0 |
| literal `/ms --help` ending in LF or CRLF | success | blocked | 0 |
| literal `/ms --help` followed by `status` on another line | failure, invalid request | blocked | 0 |
| literal `/ms sync` in Python fixture | success, dependency files refreshed | blocked | 0, including in flight |
| selected `ms` + `sync` in Node fixture | success, dependency files refreshed | blocked | 0, including in flight |
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

The fixture copies only this exact previously reviewed MainSequence hook definition's trust hash; it uses no live authentication and configures no MCP server. Assertions require completed turns and the above results. The regression was rerun on 2026-10-08 with Codex 0.162.0-alpha.2 and passed with the same behavior.

A terminal installation does not hot-reload a chat that was already running. Toggle MainSequence Developer Tools off and on in the desktop Plugins settings; the installed app's plugin setting code sends `config/batchWrite` with `reloadUserConfig: true`. Alternatively, start a new Codex chat after installation.

The user's subsequent screenshot shows the hook blocking the native entry in this chat. Its failure exposed a second issue: the desktop composer appends a newline to submitted text, which the single-line parser rejected. The adapter now removes trailing layout whitespace before parsing while retaining rejection of embedded newlines. Adapter tests and installed-host checks accept the exact trailing-newline form with zero model requests. The user subsequently supplied the successful help result from the desktop.

## Readable Codex output — 2026-10-01

That successful help result was displayed as compact JSON with escaped newlines. The first presentation fix removed the envelope but still dumped each command's `data` object and reused the dense terminal help. The Codex adapter now has its own presentation layer: a short getting-started menu, a full menu at `/ms --help --all`, command-specific options, named repository entries, account summaries and readable project/SDK fields. Default output contains no serialized data objects or internal store/lock metadata. Clear failure messages include next steps where appropriate; partial-effect warnings remain visible. Explicit `--json` retains the unchanged versioned action result and error codes, and a literal `--json` message value does not select export mode.

The installed-host fixture asserts actual line breaks, the command menus, absence of a JSON envelope, and zero model requests; it separately checks explicit JSON output. Formatter fixtures cover repository lists, empty results, machine-session status, project capabilities and SDK source-versus-registry distinctions. Codex still marks the hook as blocked because it stops the prompt before inference, including after successful actions. This changes the text presentation rather than replacing the host-owned card or adding interactive components. The subsequent desktop screenshot confirms the compact getting-started menu; runtime API tests verify the other field layouts.

## Historical release-sync regression — 2026-10-02

A sync submission displayed the desktop's generic “Thinking” placeholder without a result. The hook had acquired the repository action lock at the submission time, but the SDK's backend lookup stalled. The saved CLI backend was an unavailable localhost service. A direct read-only SDK preflight continued retrying until it was stopped at 45 seconds; the original Codex turn was interrupted after 30 seconds, leaving a stale lock and no new commit. The lock was removed only after checking that its owner had exited and no SDK sync, Git, or dependency operation remained.

At that time, a temporary Codex preflight used an unauthenticated HEAD request with a five-second deadline to report `BACKEND_UNREACHABLE` before running the SDK. A shared optional `prepareProjectAction` callback supplied it. Both were subsequently removed when SDK sync became a local dependency refresh, as described below. They are not part of 0.2.1.

The original release-sync host fixtures deliberately paused before creating commits and tags. They established zero model requests while the SDK was running and afterward, and lock cleanup. Those fixtures have been replaced by dependency-only sync checks that require unchanged Git state and zero backend requests. Earlier help-only host checks did not establish valid SDK execution.

Historical opt-in checks of the affected project returned `BACKEND_UNREACHABLE` in approximately 1.3 seconds and, after the backend came online, completed a read-only SDK sync preflight in approximately four seconds. Both made zero model requests and did not commit, tag or push the project's changes. The unavailable-project check and sync dry run no longer exist; the current opt-in real-project check uses `status` only.

## Dependency-only sync — 2026-10-02

Sync no longer commits, tags, pushes or contacts the backend (see the ADR amendment of 2026-10-02). The stall above came from the SDK's backend lookup, which the dependency-only sync no longer makes, so the Codex backend preflight and the shared `prepareProjectAction` host callback added for it were removed; neither was in the published 0.2.0 archive. Sync dispatches exactly `code-repository sync --path .`. An installed SDK whose sync help still offers `--dry-run` or `--message` is reported unavailable with `update-sdk` as the repair, and its sync is not run. `freeze-env` was removed.

The shared suite's SDK fixtures now model the released CLIs: Python prints the selected command's help, Node prints one usage text, sync refuses any argument but `--path` with exit 2 and writes only dependency files, and a second fixture advertises the retired release sync. Tests assert the exact argv, unchanged `HEAD` and tags, zero backend requests from a Codex sync, the unavailable report for the retired sync without executing it, and the `UNSUPPORTED_ACTION` answer for `freeze-env`. `scripts/verify-codex-host.cjs` expects the dependency refresh, zero backend and model requests, and an unchanged Git state; these cases passed against installed 0.2.1 on October 8. Its opt-in real-project check runs the read-only `status` and requires the `sync` capability to be available; that optional check was not run in the October 8 audit.

## Remaining release checks

- Verify trusted-publishing configuration before the next release, align package/plugin/catalog versions, and confirm the new registry archive's integrity. Do not republish an existing version.
- Manually verify the desktop renderer after restarting/reloading the app. Computer-use tooling refuses access to the Codex app, so GUI validation could not be completed automatically. The installed host runtime, event stream and CLI presentation were tested directly.
- Check the long-operation progress, cancellation and timeout UI in the desktop host. The runner's timeout and cancellation contracts have fixture coverage, but a full-duration desktop operation was not run.
- Validate live OS-store refresh rotation across all supported platforms and a real backend/Git setup. The automated suites use synthetic identities, loopback backends and temporary repositories.
