# Phase-1 implementation and verification

Implemented on 2026-09-30 from ADR 0001. One private npm package contains shared TypeScript contracts/actions, extracted browser and native machine authentication, repository/project orchestration, the deterministic CLI, and the Codex prompt adapter. SDK and VS Code repositories remain unchanged.

## Source baseline

| Repository | Inspected source |
| --- | --- |
| Python SDK | `development`, `66f11a48`, next source version `8.1.28` |
| Command Center SDK | `main`, `6c083af`, prepared source version `0.5.11` |
| VS Code extension | `main`, `4bb107e`, version `0.1.45`, including the user's existing uncommitted dispatcher/metadata changes |

Extraction provenance is recorded in `NOTICE`. The copied native store retains the existing service, backend hash, version-1 ASCII record, macOS entry mark/stdin guard, and Linux Secret Service attributes. This implementation also refuses future record versions and avoids deleting an unscoped legacy session associated with another backend.

## Automated checks

Local suite result: **42 tests passed, 0 failed**. Build, SDK source compatibility, and isolated public npm consumer checks also passed.

- TypeScript strict compilation/type checking.
- Fixture browser login against the existing PKCE/token endpoints, state verification, durable save/read-back, profile lookup, renewal, logout, timeout/cancellation, and token-free results.
- Synthetic native macOS/Linux store program tests, foreign entry protection, missing/unavailable stores, backend isolation, and refresh-only records.
- Current SDK source interoperability using explicit checkout paths: common records read by both SDKs; Python records read by common/Node; Node records read by common/Python; exact backend identity checked across two backends. Python runs with an isolated temporary home and synthetic store; it imports no application auth bootstrap.
- Installed-CLI fixtures validate Python/Node argv, local CLI selection, capability probing, dependency/source policy, explicit credential/backend association, safe status filtering, cancellation/timeouts, and unsupported MCP skills.
- Sync fixtures create real Git commits and tags in temporary projects. They verify paths with spaces, literal shell syntax in messages, dry-run dispatch, partial failure without retry/rollback, and repository lock cleanup.
- Setup uses a temporary home, synthetic SSH keypair, fixture backend contracts, and a local clone; verifies key registration, canonical folder layout, endpoint-only `.env`, and existing-folder protection.
- Project cleanup covers exported/spaced assignments, unrelated settings, private permissions, Git-tracked files, and symlinks.
- Built plugin copied outside this checkout runs without `node_modules` or sibling repositories; ordinary prompts pass through and explicit actions return blocking hook JSON.
- Plugin tarball and local npm tarball are built without publication. The npm consumer check uses only its public export.

Tests were run locally on macOS with Node `25.2.0`. CI is configured for Node 22 on macOS and Linux; those hosted jobs have not been run in this local task.

## Remaining release checks

These are explicitly unverified and are not implied by fixture success:

1. Desktop app interception before inference, visible hook results, trust review, and host timeout behavior. The chat hook remains experimental; the direct runner is the supported zero-LLM path.
2. Live macOS/Linux credential-store round trips across all three tools and simultaneous Python/Node renewal against the real backend's refresh-token rotation policy. No cross-language renewal lock is claimed.
3. Full installed-SDK sync through a real backend and Git remote, including server deployment-tag selection and atomic push. Fixtures exercise orchestration and Git changes, not that external deployment path. No longer applicable since 2026-10-02: sync only refreshes dependency files and contacts no backend.
4. Windows native machine persistence, which the extracted Node implementation does not support.
5. An existing non-MCP API for backend-owned skills. Until verified, these commands are unsupported here.

No real login, logout, token refresh, credential-store mutation, SDK update, user-project sync, or deployment was performed during verification.
