# Deployments and releases

`createDeployments()` reads deployments for the host panes and model tools. Every action is
a read (`GET`) bound to the shared session's account. Billing, cost and credential fields
never reach the result. A deployment the reader may not see answers with `hidden: true` and
a sentence that does not say whether it exists.

| Action | Reads | Use |
| --- | --- | --- |
| `deployment-release-history` | One page of the environment's resource release deployments of the last `days` (default 1), newest first, optionally for one branch, release, kind or search text | Releases: the deployment history |
| `deployment-active` | Only resource release deployments still `queued` or `running` (at most 100), optionally for one branch | The cheap check while something is deploying |
| `deployment-run` | One deployment or workflow run with its stages | A deployment's detail |
| `deployment-logs` | One page of a deployment's logs, by cursor | Logs |
| `deployment-wait` | One deployment, every ten seconds, until it ends or `timeoutSeconds` (at most 120) runs out | Waiting for a deployment the person or the model started |
| `deployment-history` | One page of every entry in the environment: workflow runs and the deployments no workflow owns | The Code section's deployments |

## Resource release deployment history

This is Command Center's Deployment History narrowed to resource releases: one row per
deployment, newest first, in one request. The backend does the narrowing with
`target_type__in` (`RELEASE_TARGETS`: `resource_release`, `harness_agent`, `static_site`),
so workflow runs, Jobs and image builds are never counted, paged or returned.

It is a history and not a list of releases: a release that was not deployed in the window
has no row. Each row carries what Command Center's columns show:

- **Revision:** `commit` and `revisionUid`.
- **Branch:** `repositoryName` and `branchName`.
- **Date:** `startedAt` (when it was created, until it starts) and `finishedAt`.
- **Type:** `kindLabel`, the backend's label.
- **State:** `state`, with `outcome`, `errorCode` and `error`.
- **Progress:** `steps` in order. A stage left running in a deployment that ended reads
  `stopped`.
- **Source:** `source`.
- **Duration:** `durationMs`, absent when the deployment ended without a finish time.

Names repeat across repositories (several releases are named `app`), so show the repository
with `releaseName`. An agent's release also carries `agentName`.

## Polling

The backend offers no push channel, so hosts poll. These rules keep that small:

- **Opening the history reads it once.** After that, only `deployment-active` is read.
- **Finished deployments never change.** `ACTIVE_RUN_STATES` (`queued`, `running`) are the
  only states that do, and the backend allows one active deployment per target.
- **While the release history is shown, check with `deployment-active` every 30 s.** It
  returns only the active ones, so a deployment that starts after the read is found. Read
  the history once more when a shown one leaves it or one that belongs in it starts;
  otherwise update the shown ones in place. Pause after an hour in which nothing started
  or ended.
- **Watching one deployment re-reads only that deployment,** at `WAIT_INTERVAL_MS`. Stop
  when it ends, and pause after an hour.
- **Poll once per account and environment, not once per chat.** The
  [shared desktop transport](shared-desktop-transport.md) merges identical reads that are
  in flight at the same moment. A host with several chats still lets one of them run the
  timer and shares its result with the others.
