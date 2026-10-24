# Phase 2 release and installation

> Historical record of the 0.2.x releases. Since devtools 0.3.0 the Codex plugin is built, verified and released from [mainsequence-codex-plugin](https://github.com/mainsequence-sdk/mainsequence-codex-plugin); the Codex artifact, local marketplace and `verify-codex-*` scripts named below no longer exist in this repository. See [ADR 0003](adr/0003-codex-plugin-extraction.md).

One repository, one npm package, one lockfile. Both SDKs remain unchanged.

## Artifacts

The additive 0.2.2 release is now published on public npm. It exposes shared
project operations for independent integrations. Claude Desktop 0.3.1 pins that
registry archive; its source, lockfile, marketplace and releases live in
[mainsequence-claude-desktop](https://github.com/mainsequence-sdk/mainsequence-claude-desktop).
The existing Codex marketplace and VS Code pin remain on 0.2.1. See
[integration ownership](integration-roadmap.md) and the
[shared project API](shared-project-operations.md).

`@dev-mainsequence/devtools@0.2.1` contains the public TypeScript/JavaScript API, `ms-devtools` runner, `.codex-plugin/plugin.json`, the explicit-only `ms` skill registration, hooks and version metadata. The npm registry can therefore serve both VS Code's build dependency and Codex's marketplace package source. No package is downloaded when an action executes. The supported Codex compatibility manifest is required here: the tested 0.159.2 runtime recognized a root Agent Plugins manifest but skipped its hooks. Shipping both selected the root format and suppressed the hook, so this package deliberately omits root `plugin.json`. The installed 0.2.1 plugin also passes the actual-host checks on Codex 0.162.0-alpha.2.

The same build produces `artifacts/codex/mainsequence-devtools/`, the standalone plugin archive, and a local marketplace at `artifacts/local-marketplace/`. VS Code pins the package and copies the compiled distribution into `out/vendor/devtools` during compile; its VSIX includes that copy with version metadata. No new shared repository or npm workspace is needed.

## Verify and publish

1. Assign a new release version consistently across the package and built plugin manifest; published npm versions are immutable. Keep the public marketplace on its last published version during preparation. Run `npm ci --ignore-scripts`, then `npm run release:check`.
2. Verify VS Code against that packed npm archive, including its lockfile integrity and VSIX contents. Keep the exact archive used to generate the consumer lockfile.
3. Authenticate with `npm login` or the configured trusted publisher, then publish the exact verified archive for the new version with `--ignore-scripts --access public`. Do not publish a development rebuild under an existing release version.
4. Configure npm trusted publishing for `mainsequence-sdk/mainsequence-devtools`, workflow `release.yml`, GitHub environment `npm`, allowing direct `npm publish`. Subsequent version tags run checks, upload archives and publish that checked npm artifact through OIDC. A manual workflow run defaults to checks/artifacts only.
5. Verify the new version is available from the public registry and matches the checked artifact before advancing the public marketplace or consumer dependency pins. `scripts/check-release.cjs` checks producer metadata and release tags; it permits the public marketplace to remain on an older release. The consumer lockfile identifies the exact npm archive, not an arbitrary local checkout.

The public npm registry serves 0.2.1, and VS Code 0.1.47 pins that registry archive with integrity `sha512-7cYZN5fUJi4347BO38LES6Uvi+p+szR+SqLiv9ngsnC91S/6vcoKIfRr38xCcSJ0LmG4vlx+namtLqmDSzxt7g==`. This release includes line-ending and readable-output fixes, dependency-only sync and removal of `freeze-env`. Local builds and installations do not update the published archive. Verify registry integrity before updating a consumer pin.

Trusted publishing needs npm 11.5.1+ and Node 22.14+; the release workflow uses Node 22 and npm 11.6.2. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Install Codex locally

```sh
npm run build
codex plugin marketplace add /absolute/path/mainsequence-devtools/artifacts/local-marketplace
codex plugin add mainsequence-devtools@mainsequence-local
```

Review and trust the current hook definition in Codex (`/hooks` in the CLI). Start a new session after installation. For an existing desktop chat, toggle MainSequence Developer Tools off and on in Plugins settings after the current agent turn ends; this uses the supported configuration hot reload. External CLI installation alone does not update a loaded thread's hooks. Installation itself does not trust hooks. The local catalog loads the built artifact, while the installed plugin runs from Codex's cache. This machine's `mainsequence-devtools@mainsequence-local` installation is enabled and its exact hook definition has been reviewed and trusted.

After installation, run `node scripts/verify-codex-host.cjs` for an opt-in host integration check. It creates ephemeral Codex sessions, disables the MainSequence MCP server for those sessions, and directs inference to a local counted HTTP fixture. It verifies native `ms` skill registration and exercises help, failures, and valid SDK sync commands that refresh dependency files in temporary repositories without changing their Git state or contacting the backend. Handled commands make zero model requests, including while sync is running; ordinary prompts pass through to the offline fixture. The default check uses no live MainSequence authentication. Optionally set `MAINSEQUENCE_CODEX_SYNC_PROJECT=/absolute/project/path` to check, with the read-only `status` command, that a real project's installed SDK offers the dependency-only sync; this changes nothing in that project. No check contacts a real model endpoint.

## Install the published Codex release

Current installation instructions and the public marketplace are maintained in
[mainsequence-codex-plugin](https://github.com/mainsequence-sdk/mainsequence-codex-plugin#install).
The former Codex marketplace in this shared repository was removed on 2026-10-24.
Use the Codex repository’s instructions to replace an existing marketplace source.
The historical 0.2.x package details elsewhere in this document are not current
installation instructions.

See [Codex plugin packaging and npm sources](https://developers.openai.com/plugins/build/plugins) and [plugin commands](https://learn.chatgpt.com/docs/developer-commands).

## Execution and limits

In Codex desktop, type `/ms`, select the native `ms` slash-menu entry, append arguments such as `--help`, and submit. The skill registers the interface; its linked mention is intercepted by the trusted hook and executed by the bundled runner. Ordinary prompts pass through. Handled actions return a blocking hook result, with credentials excluded from results and logs. Installed registration and zero inference requests, including valid Python and Node dependency syncs, are verified in actual Codex 0.162.0-alpha.2 app-server turns. The desktop menu/renderer and long-operation UI still need manual verification. Codex CLI 0.159.2 rejected custom `/ms` before submission; use the `ms-devtools` terminal runner there. See [Phase-2 verification](phase-2-verification.md).

Native machine mode shares the SDK record and leaves repository `.env` files endpoint-only, the endpoint in the VS Code extension's block. VS Code explicitly supplies its existing SecretStorage fallback/projection policy where native persistence is unavailable, and opts into its SDK-owned MCP skills workflow. Codex enables neither option. SDK project operations retain their existing implementations; no SDK depends on this npm package.
