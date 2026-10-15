# Shared platform agent conversations

The additive 0.2.5 API discovers agents and exchanges messages through the existing
MainSequence `/mcp` gateway. No backend routes, schemas, account handling, or provider
configuration change. Claude UI, native draft/command handling and conversation controls
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
| `agent-session` | `agent.get_or_create_session` | agentUid, expectedAccount; exactly one of handleId or sessionUid |
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

`agent-session` opens or resolves a conversation without sending a message or
requesting runtime access. Pass a stable client handle for allocation or the saved
session UID for resolution. The result exposes only account, public agent, session
UID and handle. Agent, environment and returned identity are checked. Missing
provider/model defaults are reported without changing them. Client chat IDs are
external handles, not MainSequence parent-session foreign keys.

A send may use that resolved `sessionUid`, or a stable handle for legacy clients.
The returned `sessionUid` identifies follow-ups. Message mode is synchronous. Task mode always requests `completion_policy:
poll`; `resume_caller` is for platform AgentSessions and is not used by desktop hosts.
Task continuation passes only `task_uid` to the gateway. Waits last at most 15 seconds
per operation and expose the next cursor. Cancellation requests may complete later;
hosts must show `cancellationRequested` and the returned status accurately.

Mutating sends and task cancellations are never automatically replayed. If a request
may have reached the platform, failure includes `effects.state: partial-or-uncertain`.
Hosts should inspect Activity/the known task and require an explicit decision before
starting over. Tool deadlines come from validated `mainsequence.ai/timeout-seconds/v1` metadata
plus five seconds of transport margin, bounded to 300 seconds. Missing/invalid send
metadata falls back to 145 seconds, covering the existing 140-second gateway budget.
Other calls without metadata retain their default timeout. SessionService's optional
sixth request argument accepts a per-request `timeoutMs` up to 300,000 milliseconds.

Agent replies are external data. Consumers must not treat returned text or card
descriptions as instructions that override user requests or permission checks.

## Verification and release

`tests/agents.test.cjs` checks environment/account boundaries, public projection,
session allocation/resolution without messaging, timeout metadata, session continuation, response modes, polling, cancellation and uncertain-send
behavior using a synthetic MCP transport. These are contract tests, not evidence of
live agent availability. Existing authentication and project tests remain in the suite.

Version 0.2.4 was published on 2026-10-15 from commit `57bb311` through the existing
[trusted-publisher workflow](https://github.com/mainsequence-sdk/mainsequence-devtools/actions/runs/38732377231).
The public registry archive is verified with integrity
`sha512-RgU8NALWU6XjCMC297pVcfjyM5xEQlZjnxdTKXkgBSWF1MX8HHreGMxA7xbdxs+SjWJczJ3bhBYmxsqJGxLQkQ==`.
Claude's consumer lockfile pins that archive. Publication does not update the Claude
marketplace or existing VS Code/Codex pins. See the [release procedure](phase-2-release.md);
do not republish a rebuilt archive under an existing npm version.

Version 0.2.5 adds session allocation/resolution without a message and validated
platform tool deadlines. Claude 0.4.4 consumes this additive API. Release through
the existing trusted-publisher workflow, verify the public archive integrity, and
then pin that archive in the consumer. Existing Codex marketplace and VS Code pins
are unchanged by this shared-library release.
