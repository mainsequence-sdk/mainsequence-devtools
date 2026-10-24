# Shared project operations

`@dev-mainsequence/devtools` owns host-neutral MainSequence authentication,
repository/SDK/dependency workflows, MCP and project filesystem operations.
Consumers import the package's public API. They implement their native UI,
process bridge, lifecycle, application-specific credentials and distribution.

The package exports `createProjectOperations`,
`PROJECT_OPERATION_ACTIONS`, `ProjectOperationRequest`, `ProjectOperationOptions`,
`validateDockerImage`, `validateDockerPlatform` and `updateDevcontainerJsonc`.

```ts
import { createNodeHost, createProjectOperations } from '@dev-mainsequence/devtools';
const operations = createProjectOperations({ host: createNodeHost(), signal });
const preview = await operations.dispatch({
  action: 'devcontainer-preview', root: projectRoot, image: 'example/app:latest'
});
```

The dispatcher returns the existing `ActionResult` contract and supports:

- `local-repositories`: read-only canonical directory discovery.
- `delete-local-preview` / `delete-local`: standalone Git repositories only;
  the confirmation digest is rechecked under the shared repository lock.
- `docker-preview` / `docker-build`: validated argv, Linux platform selection,
  cooperative cancellation and bounded execution; no shell interpolation.
- `devcontainer-preview` / `devcontainer-write`: comment-preserving JSONC edits,
  preview-bound image/content digest, atomic writes and symlink protection.

Pass a `HostServices` implementation and optional signal/environment. UI
confirmations belong to the consumer; the service enforces validation, locks and
stale-preview protection independently. Failures after mutation starts report
partial/uncertain effects. Reusable behavior has no Claude dependency.

Native folder pickers, terminal/container launchers, plugin runtime diagnostics and
Claude account credentials stay in the consuming integration. `createDevTools`
continues to own the established auth/project/SDK/MCP action API. Existing consumers
can keep their pins; the new API is additive. The opt-in MCP-skills capability flag
now matches dispatch; the default remains disabled.
