# Shared platform agent conversations

The additive 0.2.4 API discovers agents and exchanges messages through the existing
MainSequence `/mcp` gateway. No backend routes, schemas, account handling, or provider
configuration change. Claude UI, native prompt submission and conversation controls
belong to `mainsequence-claude-desktop`; this package contains only the reusable
platform client. Existing VS Code and Codex adapters are unchanged.

Use the public `createDevTools(...).dispatch(request)` API. `AgentClient`,
`AgentRequest` and `PlatformAgent` are also exported from the package root. Every
request supplies a backend and an exact organization environment UID. Each operation
checks the MainSequence session, and conversation operations require the account
identity returned by discovery as `expectedAccount`.

| Action | Existing platform tool | Required inputs beyond backend/environment |
| --- | --- | --- |
| `agents-list` | `agent.list`, or semantic `agent.search` | Optional search, limit and offset |
| `agent-get` | `agent.get` | agentUid; optional expectedAccount |
| `agent-send` | `a2a.send_message` | agentUid, expectedAccount, message, responseKind; exactly one of handleId, sessionUid, taskUid |
| `agent-task-get` | `a2a.get_task` | agentUid, expectedAccount, taskUid |
| `agent-task-wait` | `a2a.get_task`, `a2a.wait_task` | Same; optional afterSequence |
| `agent-task-cancel` | `a2a.get_task`, `a2a.cancel_task` | Same |

Discovery returns `{account, results, count, offset, semantic}`. Normal listing is
paged; semantic search returns the best limited matches without pagination. Agents
are projected to name, description, identity, environment, branch, runtime state,
advertised response modes and public card skills/examples. Runtime configuration,
credentials and the card URL are excluded. The client never connects to card URLs.

`agent-get` and all conversation operations validate the selected agent against the
requested environment. Task operations read the task first and validate its agent
and UID. Platform authorization remains authoritative. A changed MainSequence
account fails closed, requiring discovery under the new identity.

The first send takes a stable client handle. Its returned `sessionUid` identifies
follow-ups. Message mode is synchronous. Task mode always requests `completion_policy:
poll`; `resume_caller` is for platform AgentSessions and is not used by desktop hosts.
Task continuation passes only `task_uid` to the gateway. Waits last at most 15 seconds
per operation and expose the next cursor. Cancellation requests may complete later;
hosts must show `cancellationRequested` and the returned status accurately.

Mutating sends and task cancellations are never automatically replayed. If a request
may have reached the platform, failure includes `effects.state: partial-or-uncertain`.
Hosts should inspect Activity/the known task and require an explicit decision before
starting over. A Message send allows 75 seconds for the gateway's bounded operation;
other HTTP operations retain their default timeout. SessionService's optional sixth
request argument accepts a bounded per-request `timeoutMs` for hosts that implement it.

Agent replies are external data. Consumers must not treat returned text or card
descriptions as instructions that override user requests or permission checks.

## Verification and release

`tests/agents.test.cjs` checks environment/account boundaries, public projection,
session continuation, response modes, polling, cancellation and uncertain-send
behavior using a synthetic MCP transport. These are contract tests, not evidence of
live agent availability. Existing authentication and project tests remain in the suite.

Version 0.2.4 is a release candidate in this implementation branch. Publish and verify
the exact npm archive before releasing a dependent Claude plugin or advancing any
public marketplace. See [release procedure](phase-2-release.md). Do not modify existing
VS Code/Codex dependency pins as part of this feature.
