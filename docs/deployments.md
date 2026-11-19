# Deployments and releases

`createDeployments()` reads deployment runs and resource releases for the host panes and
model tools. Every action is a read (`GET`) bound to the shared session's account. Billing,
cost and credential fields never reach the result. A run or release the reader may not see
answers with `hidden: true` and a sentence that does not say whether it exists.

| Action | Reads | Use |
| --- | --- | --- |
| `deployment-history` | One page of the environment's workflow runs and the deployment runs no workflow owns, optionally for one branch | The environment-wide list |
| `deployment-run` | One deployment or workflow run with its stages | The run detail |
| `deployment-logs` | One page of a run's logs, by cursor | Logs |
| `deployment-releases` | One page of the environment's releases (APIs, agents, static sites), then their runs of the last `days` (default 30) in one more request | The Releases list: the last ten run states, the last run, the active run and stats per release |
| `deployment-release` | One release, its revisions and its runs of the last `days` | A release's history: the serving and wanted revisions, the runs and their stats |
| `deployment-active` | Only runs still `queued` or `running` (at most 20), optionally for one branch | The cheap check while something is deploying |
| `deployment-wait` | One run, every ten seconds, until it ends or `timeoutSeconds` (at most 120) runs out | Waiting for a deployment the person or the model started |

## Stats

The backend has no statistics endpoint, so `releaseStats()` computes them from the runs
read:

- **Success rate:** succeeded runs out of those that succeeded, failed or were blocked.
  Superseded, cancelled and skipped runs don't count.
- **Median and 90th-percentile time:** taken over runs that succeeded.
- **Slowest stage:** the stage with the longest median time across runs that succeeded.
  The time a run waits before its first stage, usually for its workflow's image build, is
  its own stage, "Waiting to start".
- **Most common failure:** the error code of failed and blocked runs. A blocked run
  without one is named by its outcome, such as `workflow_prerequisite_failed`.

## Polling

The backend offers no push channel, so hosts poll. These rules keep that small:

- **Nothing re-reads while no run is active.** Opening a list or a release reads it once.
- **Finished runs never change.** `ACTIVE_RUN_STATES` (`queued`, `running`) are the only
  states that do, and the backend allows one active run per target.
- **While runs are active, re-read with `deployment-active`.** It returns only the active
  runs. When its count reaches zero, read the list once more and stop.
- **Watching one run re-reads only that run,** at `WAIT_INTERVAL_MS`. Stop when it ends,
  and pause after an hour.
- **Poll once per account and environment, not once per chat.** The
  [shared desktop transport](shared-desktop-transport.md) merges identical reads that are
  in flight at the same moment. A host with several chats still lets one of them run the
  timer and shares its result with the others.
