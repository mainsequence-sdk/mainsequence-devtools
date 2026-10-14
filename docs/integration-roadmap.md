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
visibility change is required. The Claude migration targets independently versioned
0.3.1 consuming devtools 0.2.2. Previously published Claude 0.3.0 remains an immutable preview.

Publication status on 2026-10-14: the shared API is merged, but the 0.2.2 npm publish
was rejected by registry authentication. The public devtools marketplace stays on
0.2.1. [Claude migration PR #1](https://github.com/mainsequence-sdk/mainsequence-claude-desktop/pull/1)
remains draft until registry publication, generation of its registry lockfile and a
fresh consumer verification succeed. Claude's marketplace continues to advertise
the existing 0.3.0 preview.
