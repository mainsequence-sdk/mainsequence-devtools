# Phase 2 verification — updated 2026-10-01

The shared package and VS Code migration are implemented locally. `mainsequence-devtools@mainsequence-local` version 0.2.0 is installed, enabled and trusted in `/Users/jose/.codex/plugins/cache/mainsequence-local/mainsequence-devtools/0.2.0`. Public npm publication remains pending: `npm whoami` returned HTTP 401. Local archives and a successful publish dry run do not constitute a published release.

## Shared package and consumer

- Strict TypeScript compilation and 45 shared tests pass. Fixtures cover the canonical credential record, browser authorization, refresh rotation, rejection/identity boundaries, host fallback, repository resolution, SDK dispatch, cancellation and hook packaging.
- The migrated `ms-vscode-extension` compiles and its 42 tests pass. New adapter checks cover shared session renewal, native versus fallback credential handoff, literal SDK arguments, Electron's Node mode, cancellation and workspace trust. Existing user changes were retained.
- The public npm archive works from an isolated ESM consumer without SDKs or runtime npm dependencies. Private deep imports are rejected by package exports.
- VS Code pins 0.2.0 and bundles its installed public distribution into `out/vendor/devtools`. Its packaged VSIX contains that distribution and version metadata, without runtime `node_modules`, sibling checkouts or private package imports. The lockfile integrity identifies the exact checked local npm archive intended for publication.
- Synthetic interoperability checks pass in both directions against the actual Python SDK `development` and Command Center SDK `main` session implementations. Both SDK repositories remain unchanged. These checks do not access the user's credential store or log in to a live backend.

## Installed Codex host

Codex 0.159.2 recognized the initial root Agent Plugins manifest but returned no hook from `hooks/list` or `plugin/read`. The supported `.codex-plugin/plugin.json` entry point exposes the hook correctly. The package now ships only that entry point, and packaging checks reject a root `plugin.json` that would take precedence and suppress hooks.

The CLI `/hooks` review showed the exact installed runner command, synchronous mode and 600-second host timeout. Only MainSequence's hook was trusted. A subsequent app-server query returned `trustStatus: "trusted"`, `enabled: true`, and the installed plugin's source path. The original implementation tested only a text prefix; that did not register a Codex interface. It has been replaced by an explicit-only `ms` skill for native desktop slash-menu registration and a hook that recognizes its linked mention. `skills/list` now returns an enabled `mainsequence-devtools:ms` entry with display name `ms`, and `plugin/read` exposes both the skill and hook. Duplicate result warnings were removed after observing host presentation.

`scripts/verify-codex-host.cjs` tests actual app-server turns using an ephemeral session and a counted loopback model fixture, with the MainSequence MCP server disabled for that session. It verifies the installed skill registry and submits the native linked mention together with an explicit skill input item. No real inference endpoint is used:

| Prompt | Action result | Host hook status | Model requests |
| --- | --- | --- | --- |
| selected `ms` + `--help` | success | blocked | 0 |
| selected `ms` + `invalid-action` | failure | blocked | 0 |
| selected `ms` + `sync` | failure, missing required arguments | blocked | 0 |
| literal `/ms --help` submitted via app-server | success | blocked | 0 |
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

A terminal installation does not hot-reload a chat that was already running. After the current agent turn ends, toggle MainSequence Developer Tools off and on in the desktop Plugins settings; the installed app's plugin setting code sends `config/batchWrite` with `reloadUserConfig: true`. Alternatively, start a new Codex chat after installation. The live desktop chat's final retry remains unverified until the user performs that reload; do not claim the interface is fully working in this chat based on the fresh-process test alone.

## Remaining release checks

- Authenticate to npm and publish the exact verified archive, then confirm registry integrity. Configure trusted publishing before using the release workflow for subsequent versions.
- Manually verify the desktop renderer after restarting/reloading the app. Computer-use tooling refuses access to the Codex app, so GUI validation could not be completed automatically. The installed host runtime, event stream and CLI presentation were tested directly.
- Check the long-operation progress, cancellation and timeout UI in the desktop host. The runner's timeout and cancellation contracts have fixture coverage, but a full-duration desktop operation was not run.
- Validate live OS-store refresh rotation across all supported platforms and a real backend/Git setup/sync deployment. The automated suites use synthetic identities, loopback backends and temporary repositories.
