# ADR 0004: Shared project-tool registry for host plugins

Date: 2026-10-23.

Status: Accepted by the owner's instruction, "OK this plan approved", after the
comparison of the Claude Desktop and Codex plugins recorded in the Codex plugin's
`docs/agents-tools-panel.md` (0.7.8). Implemented in this repository as 0.3.12
(2026-10-23); the Claude Desktop and Codex plugins adopt it in their own releases.

## Context

Two host integrations present each saved project MCP connection (for example the
CRM release) as first-class tools of the host, so a model calls `crm_contacts_list`
like any other tool instead of walking a discovery protocol:

- The Claude Desktop mod (`mainsequence-claude-desktop`, `claude/hooks/register.mjs`)
  names each remote tool `ms_<tool>_<hash>`, registers it with `$.tool.register`,
  forwards a call to the `mcp-call` action in a fresh worker process, and converts the
  result into Messages API blocks. It pins devtools 0.3.1.
- The Codex plugin (`mainsequence-codex-plugin`, `src/hosts/toolCatalog.ts` and
  `src/panel-server.ts`) gained the same capability on 2026-10-23, with a catalog
  cache on disk so `tools/list` answers at once and a background refresh. It pins
  devtools 0.3.11.

Both copies implement the same five things: the tool name, the tool definition
(description, object schema, annotation hints, an 80-tool cap per connection), the
result shape (remote content blocks plus a JSON block carrying summary, effects, error
and structuredContent), the refresh loop over `mcp-list` and `mcp-tools` that keeps a
connection's earlier tools when its catalog cannot be read, and the directory where
shared MainSequence state lives. The Codex copy was written to match the Claude copy
by hand; the fixture `ms_crm_contacts_list_183f8138` proves they agree today and
nothing keeps them agreeing tomorrow. The version drift (0.3.1 against 0.3.11) is
already visible: `claudeMcpNames.ts` exists only because devtools 0.3.1 did not store
connection labels.

The comparison also found two gaps in this library that both hosts work around:

- A cold project MCP call measured 53–71 s against the Production CRM (release
  detail and exchange-launch about 2 s each, project `initialize` 9 s to over 60 s,
  `tools/call` 10–39 s). The project request timeout defaults to 60 s, which aborted a
  cold `initialize`; the Codex host additionally stops MCP tools at 60 s unless its
  manifest says otherwise. The CRM catalog already advertises a per-tool timeout hint,
  `_meta["mainsequence.ai/timeout-seconds/v1"]`, that nothing reads.
- Error messages lose what a model or a person needs: `BACKEND_UNREACHABLE` covers
  both a timeout and a connection failure, `API_ERROR` reports `HTTP 503` without
  saying which endpoint answered, and a JSON-RPC error's own message is dropped. Each
  host then relabels errors generically (Codex's `CONTEXT_CHANGED: Refresh
  MainSequence`, Claude's `PROCESS_FAILED`).

## Decision

This library owns the registry. It exports host-neutral building blocks and one
file-backed catalog; a host keeps only what is specific to how it registers tools,
asks for approval and renders results.

### Public API

Additive to the existing `createDevTools()` surface; nothing existing changes shape.

- `projectToolName(backend, environmentUid, releaseUid, tool)`: `ms_` + the remote
  name with `[^a-zA-Z0-9_-]` replaced by `_`, cut to 32 characters, + `_` + the
  lower-case hexadecimal FNV-1a 32-bit hash of `${backend}:${environmentUid}:${releaseUid}:${tool}`.
  The hash binds the saved connection and environment; the prefix keeps the remote
  name readable. The cut is 32, not Claude's current 42, because Codex qualifies the
  name as `mcp__mainsequence__<name>` and model-facing function names are limited to 64
  characters (19 + 3 + 32 + 1 + 8 = 63). For a remote name of at most 32 characters,
  which includes all 70 CRM tools today (the longest is 31), the result is identical to
  the name Claude registers now. `ms_crm_contacts_list_183f8138` for backend
  `http://127.0.0.1:8000`, environment `18595d12-f92a-4960-84cd-0c6798a1ad25`, release
  `2de75e21-bfe1-4b77-b668-6916488ed317` is a frozen test vector in this repository.
- `projectToolDefinition(connection, tool)`: `{ name, title, description, inputSchema, annotations }`
  with description `MainSequence <connection name> [<environment name>]: <remote description or name>`,
  an `inputSchema` that is an object schema (`type: 'object'` added when the server
  omitted it), only the four boolean hints `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint` (plus `openWorldHint: true` as default).
  `projectToolDefinitions(connection, tools)` applies the 80-tools-per-connection cap and
  drops duplicate or invalid tools. The connection name is the release's own name, else
  its repository's name, else the release UID (Claude's pane kept the repository name
  first; the tool description now follows the Codex order, which is also the stored
  `name`); the environment is its stored name, else its UID.
- `projectToolResult(actionResult)`: the host-neutral result for a forwarded call:
  the remote `content` blocks, followed by one JSON text block with `summary`,
  `effects`, `error` and `structuredContent` when the call failed or returned
  structured content; `structuredContent` passed through; `isError` on any non-success,
  including `MCP_TOOL_ERROR`, whose original remote content is preserved. This is the
  shape Claude's `toolResult` and Codex's `projectToolCall` build today; a fixture test
  pins it against both plugins' current test expectations. A result without content
  blocks (a refusal before the call) is that JSON block alone, and a failure without
  structured content carries the block as `structuredContent` too, as the Codex server
  returned it; Claude's hook keeps its whole-result fallback only for its own host tools.
- `readProjectToolCatalog(dispatch, { backend, environmentUid?, previous?, signal? })`:
  `mcp-list` (read-only) and one `mcp-tools` per saved connection with bounded
  concurrency (two, matching the shared transport's per-origin limit). A connection
  whose catalog cannot be read keeps its `previous` tools and is listed as
  `unavailable`; a removed connection loses its tools. No `expectedAccount` snapshot is
  attached: a registered tool is bound to a saved connection, and the session for that
  connection's backend is verified when the tool is called. Since 0.3.14 the whole read
  runs within one budget (`budgetMs`, default 300 s, `DEFAULT_PROJECT_REFRESH_BUDGET_MS`):
  a connection not read by then, like one whose read failed, stays in the catalog marked
  `unavailable: { at, code, message }` with its earlier tools, so a scope whose
  connections exist is never written empty and healthy, and the mark is in the file, where
  a host whose process did not run the refresh still sees it. The first release wrote an
  empty scope after a 773 s refresh and reported nothing; this is the correction.
- `createProjectToolCatalog({ file?, dispatch, staleMs?, notify?, disabled? })`: the
  on-disk catalog (default `codex-tool-catalog.json` is renamed to a host-neutral
  `project-tool-catalog.json` beside `mcp-connections.json`), with atomic writes, a lock
  so one process refreshes at a time, stale-lock recovery, modification-time reload so
  other processes see a refresh, `update(releaseUid, tools)` for a catalog just read
  explicitly, `dispose()` to free the lock when a host process ends, and `notify` for a
  host's change announcement. It stores schemas and labels only; never credentials,
  tool results or tokens. Because the file is shared by every host on the machine, a
  refresh replaces only the connections in its scope (the backend, and the environment
  when given) and carries the rest over, and `list()`/`state()` are scoped to the host's
  backend: the one given as `backend`, or resolved by `ready()` without any network
  request the way `auth-status` resolves it (process environment, shared preferences,
  default), or learned from a refresh. Until the backend is known a listing is empty,
  never another backend's tools (the first release listed every cached scope on a fresh
  server's first `tools/list`; a host now awaits `ready()` before answering it).
  `refresh(force, { scope?, waitMs? })` resolves to whether this process read and wrote
  the catalog; with `waitMs` it waits for another process's lock instead of skipping, and
  reports `PROJECT_BUSY` in its state when the wait runs out. A refresh ends its
  dispatcher's signal when it returns, so a read the budget left behind cannot keep a
  socket or the lock.
- `mainSequenceStateDirectory(env)`: the one place that knows
  `~/Library/Application Support/MainSequenceCLI`, `%APPDATA%\MainSequenceCLI` and
  `~/.config/mainsequence`, used by the connection store and the catalog.
- Two dispatch actions for a host that cannot import this package where it registers
  tools (the Claude Desktop hook runs in the mod runtime and reaches this package only
  through a worker process per action): `mcp-catalog` returns the definitions, bindings
  and catalog state (from the file; `refresh: true` re-reads a stale cache, `'force'`
  always, waiting up to two minutes for another process's refresh to end), and
  `mcp-tool-call` is `mcp-call` answered in the `projectToolResult` shape, keeping the
  call's status, summary, error and effects. Neither adds a second code path: both call
  the functions above. `ms-devtools mcp-catalog [--refresh]` is the command-line form.

### Error fidelity and timeouts

- Project requests get their own budget, `projectRequestTimeoutMs`, default 120 s;
  backend requests keep 30 s. When a tool's `_meta["mainsequence.ai/timeout-seconds/v1"]`
  is larger than the default it is honoured, capped at 300 s. Hosts still own their
  outer limit (Codex `tool_timeout_sec`, Claude's worker budget) and set it above this.
- Existing error codes stay, because hosts switch on them. Messages become precise:
  which origin and method (`initialize`, `tools/call crm_contacts_list`) answered which
  HTTP status, whether a request timed out after how many seconds or failed to connect,
  and the redacted JSON-RPC error message. Hosts pass these messages through instead
  of relabelling them.

### Host adapter contract

A host implements, and only implements:

1. obtaining definitions (`list()` from the catalog, or `readProjectToolCatalog` when
   it has no persistent process),
2. registering or listing them in its own vocabulary (`$.tool.register`, MCP
   `tools/list`),
3. forwarding a call: `mcp-call` with the binding's backend, environment, release and
   remote tool name, then `projectToolResult` and the host's own block conversion,
4. approvals and presentation (Claude asks per call with `$.ui.ask`; Codex relies on
   the host's tool approval modes),
5. refresh triggers: after a connection or account change, and a change announcement
   where the host supports one (`tools/list_changed`).

Everything in 1–3 is the shared code above; 4 and 5 are a few lines per host. A third
host, such as the VS Code extension, implements the same five points and gets the same
names, schemas, results and errors.

## Keeping Claude Desktop stable

The Claude plugin is the reference behaviour; this registry reproduces it rather than
redesigning it. Concretely:

- Names for every remote tool of up to 32 characters are unchanged. A longer remote
  name (none in the current CRM catalog) would change once when Claude adopts the
  shared helper; its hash, and so its identity, does not. The frozen name vector guards
  the scheme.
- The `mcp-call` action, the `ActionResult` shape, the connection file format, the
  Keychain session store and credential handling are untouched. The library's API grows;
  no existing export changes.
- `projectToolResult` is pinned by a fixture to Claude's current `toolResult` output,
  so the blocks Claude converts to the Messages API are the same bytes. The hook's
  `toolResult` keeps only that conversion (and a whole-result fallback for the host's own
  tools, deployment status and agents); a project tool's result arrives from the worker
  already shaped, through `mcp-tool-call`.
- Claude keeps its process model and safety: one worker per call, the 30-minute budget,
  `$.ui.ask` before every project call, stale names refused by the handler. The catalog
  cache is an optimization it may adopt (tools registered at boot from the cache instead
  of after N worker processes); when the cache is missing or unreadable, behaviour is
  today's.
- Adopting the registry is a Claude release of its own: devtools pin 0.3.1 → the new
  version, `claudeMcpNames.ts` removed because devtools stores connection labels since
  0.3.1, `register.mjs` reduced to the adapter contract, the existing
  `verify:claude*` scripts and `claude-mcp.test.cjs` kept green, and a live acceptance
  against the CRM recorded in its docs, as for every Claude release.

Known limit, unchanged by this decision: the name hashes the backend string. Today
Claude is bound to `http://127.0.0.1:8000` and Codex to `http://local-backend:8000`
for the same development backend, so the same CRM tool has two names across hosts on
this workstation until one string is used for both. Normalising aliases would change
the Keychain account that holds the session, so this ADR does not do it; it documents
the recommendation to configure one backend string per machine.

## Extensibility

- Server-declared metadata flows through once: the timeout hint today; approval or
  visibility hints a project may declare tomorrow are read in `projectToolDefinition`
  and reach every host without host changes.
- The catalog is host-neutral state. Two hosts on one machine share one refresh and
  one file; a refresh by either is visible to the other at its next listing.
- The library keeps no host SDK dependency and no network listener; the pieces are pure
  functions plus a file, and remain usable from the `ms-devtools` runner for scripts
  and verification.

## Alternatives considered

- Keep two implementations and a cross-repository test vector. Rejected: the drift has
  already happened (0.3.1 against 0.3.11, `claudeMcpNames.ts`), and the error and
  timeout fixes would have to be made twice more.
- A standalone MainSequence MCP proxy server that both hosts connect to natively.
  Rejected: Claude registers tools in-process and asks for approval per call; a daemon
  would add a lifecycle, a credential surface and a second place where the platform
  session is held, against ADR 0002's decision that the plugin is the MCP client.
- Asking the platform directory to proxy project tools. Out of scope, as in ADR 0002:
  each project remains a direct MCP endpoint reached with its own release credential.

## Rollout and verification

1. devtools: the API above, with tests for the name vector, definitions, result
   parity with both plugins' current fixtures, catalog refresh with retention, lock and
   disposal, modification-time reload, timeouts and the improved messages. Released as
   0.3.12 (or 0.4.0 if the API needs a breaking change, which this ADR does not expect).
2. Codex plugin: `src/hosts/toolCatalog.ts` replaced by the library; the server keeps
   `tools/list` merging, `tools/list_changed` and the thin `projectToolCall`;
   `tool_timeout_sec` stays at 300 s in its manifest; its suite and the live CRM check
   repeated.
3. Claude Desktop: as described under stability, in its own release.

Each step keeps its repository's suite green against the exact devtools pin; the Codex
build refuses a pin mismatch. Fixture tests are development evidence; the live checks
against a deployed CRM remain the acceptance of each plugin release.
