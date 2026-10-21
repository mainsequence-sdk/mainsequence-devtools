# ADR 0003: Extract the Codex plugin into its own repository

- **Status:** Accepted; implemented by devtools 0.3.0 and Codex plugin 0.3.0.
- **Date:** 2026-10-21
- **Scope:** Ownership and release of the Codex host integration.

## Context

[ADR 0001](0001-shared-developer-tooling-and-codex.md) built the Codex plugin inside this
repository: the hook adapter (`src/hosts/codex.ts`), its presentation layer, the
`--codex-hook` branch of the `ms-devtools` runner, the manifests, skills and icons under
`manifests/codex`, the host checks, and a build that copied the manifest, hooks, skills
and assets to the package root because Codex's npm plugin source expects them there. The
published `@dev-mainsequence/devtools` archive therefore served two purposes: the shared
library pinned by VS Code and Claude Desktop, and the installable Codex plugin.

The Claude Desktop integration already lives in
[mainsequence-claude-desktop](https://github.com/mainsequence-sdk/mainsequence-claude-desktop),
consuming only the public package API and bundling the pinned package into its own
artifact. The [integration roadmap](../integration-roadmap.md) deferred the same move for
Codex: "extract adapter, manifests, host tests and releases into an independent
repository. Preserve plugin identity and installation compatibility."

Two private modules stood in the way. The adapter imported `parseArguments` and
`tokenizeCommand` from `src/shared/arguments.ts`, which the package did not export, and the
package `files` list and `.gitignore` carried plugin-only paths.

## Decision

1. Devtools becomes a pure library plus terminal CLI. `parseArguments`, `tokenizeCommand`
   and `HELP` are exported from the package entry so a host runner can parse the same
   command line. `src/hosts/`, `manifests/codex`, the Codex build, pack and verification
   scripts, the Codex tests and the `--codex-hook` branch are removed. The npm archive
   contains `dist`, `README.md`, `LICENSE` and `NOTICE` only.
2. The plugin moves to
   [mainsequence-sdk/mainsequence-codex-plugin](https://github.com/mainsequence-sdk/mainsequence-codex-plugin),
   published as `@dev-mainsequence/codex-plugin`. That repository is modelled on the
   Claude Desktop repository: it pins an exact devtools version, vendors the reachable
   `dist` modules into its artifact so the plugin runs without `node_modules` or an npm
   download at execution time (ADR 0001 requirement 6), writes `build-info.json` with the
   pinned devtools version and registry integrity, and keeps a dependency-boundary test
   that forbids private imports. Its `ms-devtools` bin keeps the plain CLI, and its
   runner serves `--codex-hook`.
3. **Plugin identity changes by the owner's decision.** The plugin is renamed from
   `mainsequence-devtools` to `mainsequence`, matching the Claude Desktop plugin's
   manifest name, so both hosts present MainSequence as one product. In Codex a plugin
   is identified by `<marketplace entry name>@<marketplace name>`, and hook trust is
   recorded under that id, so the renamed plugin is a new install
   (`mainsequence@mainsequence`) rather than an update of `mainsequence-devtools@mainsequence`.
   The owner also decided to remove the old marketplace entry rather than keep it pinned
   at 0.2.8. Users install the new entry, review and trust its hook, and remove the old
   plugin; the Codex repository's README carries that migration note.
4. The marketplace file `.agents/plugins/marketplace.json` stays in this repository,
   because people added the marketplace by this repository's URL. Its single entry becomes
   `mainsequence` with `source.package` `@dev-mainsequence/codex-plugin` once that package
   is published; until then it keeps pointing at devtools 0.2.8, the last package that
   carries the plugin, and `scripts/check-release.cjs` refuses any newer devtools pin.
5. Versions keep advancing from what people have installed: devtools 0.3.0 and Codex
   plugin 0.3.0.

## Consequences

- VS Code and Claude Desktop are unchanged; their devtools pins stay at 0.2.8 until 0.3.0
  is on npm, after which they may adopt it independently.
- A devtools release no longer changes anything in Codex. A Codex release pins a
  published devtools version; a change that needs both lands as a devtools release
  first, then a plugin release, then the marketplace change here.
- `docs/adr/0002` and `docs/conversational-mcp.md` moved with the plugin; stubs here point
  at their new location. The MCP client itself (the `mcp-*` actions) remains shared code.
- Codex's `ms-devtools` bin and the shared package's bin have the same name. Installing
  both globally is unsupported; the plugin's copy is meant for Codex, the shared one for
  terminals.

## Publish order

1. Tag `v0.3.0` here; the release workflow publishes `@dev-mainsequence/devtools@0.3.0`
   with provenance.
2. Confirm the Codex repository's lockfile integrity matches the registry archive, then
   tag `v0.3.0` there; its release workflow publishes `@dev-mainsequence/codex-plugin@0.3.0`.
3. Merge the marketplace change here so `codex plugin marketplace upgrade` offers
   `mainsequence@mainsequence` from the published package.

## Verification

- This repository: `npm run release:check` builds, runs the test suite (including the
  new `tests/arguments.test.cjs` covering the public parser, tokenizer, help and the
  terminal runner), checks release metadata, packs the npm archive and verifies it from
  an isolated consumer that also asserts the archive carries no plugin files and that the
  packaged runner refuses `--codex-hook`.
- Codex repository: `npm run release:check` builds the plugin artifact from the pinned
  devtools package, runs the moved adapter tests plus the dependency-boundary test, packs
  the npm archive and verifies that it is installable as a Codex plugin. The moved
  `scripts/verify-codex-host.cjs` and `scripts/verify-codex-reload.cjs` exercise the
  built artifact in an installed Codex host; the rename compatibility result and the
  migration note are recorded in that repository's
  [verification document](https://github.com/mainsequence-sdk/mainsequence-codex-plugin/blob/main/docs/codex-verification.md).
