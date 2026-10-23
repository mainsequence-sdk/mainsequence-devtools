# Shared platform agent conversations

The additive 0.2.6 API discovers agents and exchanges messages through the existing
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
| `agent-readiness` | `agent.get_or_create_session`, `agent_session.resolve_runtime_access` | agentUid, sessionUid, expectedAccount; optional timeoutMs (1–630000) |
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

`agent-readiness` validates the saved session and waits for
`runtime_interaction.can_submit`, independently of deployment status or `is_ready`.
Transient states follow the backend retry interval (100 ms minimum) within one
630-second cap, shortened by an earlier backend wake deadline plus 30 seconds.
Cancellation interrupts the wait; terminal or malformed decisions fail closed.
Progress goes through the host's progress callback as fixed credential-free text.
The public result is only `{account, agentUid, sessionUid, ready: true}`. The raw
runtime access response (token, URL, diagnostics and other fields) is never exposed
or persisted. This can wake the deployed agent but sends no message or inference.
Readiness is not cached across operations or restored as permanent state.

Set `waitForReady: true` on `agent-send` to use the same readiness gate immediately
before dispatch, including task continuation. A readiness failure has no uncertain
message effect; a failure after dispatch retains the existing uncertain-send marker.
This option defaults off for compatibility with existing adapters, whose gateway
sender continues to own readiness. Claude 0.4.5 opts in. No UI package, Python SDK
or direct runtime HTTP transport is added.

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

## Durable host delivery (0.3.3)

`AgentDelivery` is a public, host-independent coordinator. Construct it with
`createDispatch(signal)` returning the existing `createDevTools(...).dispatch`,
using the shared machine session. A scope contains `host`, a host-supplied
`conversationId`, the selected `backend` and verified `account`. Never accept the
conversation identity or storage directory from an app message or model argument.

`stage(scope, {requestId, environmentUid, agentUid, message})` validates the agent
and stores immutable content without allocating a session or sending. UUID request
IDs become `agent-send.messageId`; omitting messageId on the existing action retains
its previous generated-ID behavior. `submission` records attempted, acknowledged or
unknown native-queue submission. An acknowledgement is not a delivery receipt.

`deliver` claims the saved request under a cross-process lock, resolves a stable
host/chat/agent session handle, waits for backend readiness, persists the sending
marker, and dispatches once. `wait` waits at most 25 seconds by default; `get` and
`list` return saved status. A caller's AbortSignal stops its wait, while accepted work
continues under a separate 12-minute deadline. `cancel` applies only before acceptance.
Repeating delivery returns the existing job or exact receipt; it never replays a send.

State is stored under `MainSequenceCLI/agent-delivery-v1` in the platform application
data directory, with mode 0700 directories and 0600 atomic files. It contains message
text, replies and public IDs, not credentials. Files are partitioned by host, chat,
backend and verified account. Pending messages expire after 24 hours; at 256 requests
the conversation refuses new requests rather than dropping deduplication history.
Deleting these files removes recovery history and must not be used to retry a send.

Explicit recovery of failed preparation (including an agent-send preflight failure that proves `a2a.send_message` was never called) with zero dispatch attempts reuses the same request and stable session handle. After process loss, preparation can also resume through that handle. Loss during
dispatch becomes `uncertain`: the same request and further sends in that agent
conversation are blocked. The platform currently supplies no authoritative
direct-message reconciliation receipt. This provides at-most-once client dispatch,
not a distributed exactly-once guarantee or automatic retry after ambiguous failure.
Completed receipts survive process restart and can be returned to native chat again.
Only direct `message` responses are supported by this coordinator; task APIs retain
their existing independent behavior. Claude's consumer remains unchanged.

The delivery tests cover concurrent processes, Stop before and during send, process
death, lost outcomes, immutable IDs, account/chat isolation and corrupt/symlinked
storage. Fixtures use temporary storage and never replace machine credentials.

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

Version 0.2.6 adds readiness preparation and opt-in send-time revalidation for Claude
0.4.5. Existing session allocation and other adapter behavior remain unchanged.

Agent list, search and detail results include `defaults: { provider, model, thinking }`, projected only from existing `llm_provider`, `llm_model` and `llm_thinking` fields. Empty or absent fields remain empty strings. These are Agent defaults for new sessions, not a claim about a resumed session’s resolved configuration. Runtime configuration and credential fields are excluded.


### Inline agent icons

Desktop hosts request `includeIcons: true` on `agents-list` or `agent-get`.
Devtools forwards the platform's `include_icons: true` on agent.list,
agent.search and agent.get. Each projected agent then has an `icon` containing
bounded inline data and its reduced-motion still image, or null. Remote icon URLs
are never fetched. Missing/invalid sprites do not trigger fallback HTTP requests.
The default remains unchanged for callers that do not request icons.

`createAgentAssets` remains a compatibility API using this same inline MCP
contract. Hosts that already have a directory response should use its icons
instead of calling the compatibility API and repeating discovery.
