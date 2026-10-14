# Integration ownership and deferred extraction

The shared package is `@dev-mainsequence/devtools`. Each integration consumes its
public API, pins a compatible version, and owns its host-specific implementation.

| Integration | Current ownership | Follow-up |
| --- | --- | --- |
| VS Code | [ms-vscode-extension](https://github.com/mainsequence-sdk/ms-vscode-extension) already owns the extension and pins devtools; inspected version 0.1.47 uses 0.2.1. | No repository move or pin update in this migration. Adoption of new shared operations is separate work. |
| Claude Desktop | [mainsequence-claude-desktop](https://github.com/mainsequence-sdk/mainsequence-claude-desktop) owns all Claude UI, lifecycle, account switching, worker transport, tests, docs, marketplace and releases. | Depends on the released devtools package; no sibling checkout or private imports. |
| Codex | Existing implementation remains in devtools. | Deferred: extract adapter, manifests, host tests and releases into an independent repository. Preserve plugin identity and installation compatibility. |
| OpenCode | Existing implementation remains in the development checkout. | Deferred: extract server/TUI/RPC integration, manifests, host tests and releases into an independent repository. Preserve plugin identity and configuration. |

Future Codex/OpenCode extraction is **not implemented by the Claude migration**.
It needs a separately agreed repository destination, compatibility plan, package
pin, host verification and release. No new repositories are created for it now.

The 0.2.2 core release adds reusable project operations without publishing pending
OpenCode changes from the development checkout. That checkout retains its planned
0.3.0 version and existing changes. Both current repositories are public; no
visibility change is required. Claude 0.3.1 independently consumes devtools 0.2.2.
Previously published Claude 0.3.0 remains an immutable preview.

Publication verified on 2026-10-14: devtools 0.2.2 is available from public npm,
and [Claude migration PR #1](https://github.com/mainsequence-sdk/mainsequence-claude-desktop/pull/1)
is merged. The [Claude 0.3.1 preview](https://github.com/mainsequence-sdk/mainsequence-claude-desktop/releases/tag/v0.3.1)
uses a registry lockfile and passed a fresh dependency install, Linux/macOS CI,
anonymous archive/checksum download and isolated native-engine installation.
Its marketplace advertises the verified 0.3.1 ZIP. The existing Codex marketplace
and VS Code dependency remain on 0.2.1; this release does not migrate those hosts.
Live Claude GUI/account acceptance remains tracked in the Claude repository.
