# Shared desktop transport

`createSharedTransport()` is an opt-in devtools API for hosts that launch a separate process for each chat. Codex supplies its `fetch` and `sessionLock` to every session-backed service: actions, agent delivery, repositories and deployments. Claude is unchanged.

The processes connect to one per-user, protocol-versioned Unix-domain socket. Its devtools worker owns the HTTP keep-alive agents and coordinates token renewal. There is no HTTP listener, new authentication store, or background polling. Credentials still come from the existing machine login. Tokens, HTTP bodies and cached results remain in memory; only owner PID metadata and a socket live in the private directory. The directory is owner-only (0700), the socket is 0600. The service exits after all clients disconnect and it has been idle for 30 seconds. This implementation supports macOS and Linux.

Identical in-flight GETs and explicitly marked stateless MCP reads share one request. The cache key includes the complete URL, authorization headers and semantic body, so accounts, backend URLs, environments, searches and pages remain separate. MCP correlation IDs are restored for each caller. The shared cache is bounded to 256 entries and 24 MB of encoded response bodies; each response is bounded to 8 MB. Profile reads live for five seconds, discovery reads for thirty seconds, and icons for five minutes, always capped before a JWT's expiry. Errors are not cached. Explicit invalidation discards the cache and prevents older in-flight responses from repopulating it.

Only initialize, initialized notifications, tools/list and the known platform agent/discovery reads are marked reusable. Arbitrary project tool calls, message sends and workspace changes are never coalesced or replayed. Mutations invalidate cached reads. A connection failure returns an error; a later operation may reconnect, but the failed operation is never resent automatically. Closing one client or cancelling its wait removes that subscriber, while other subscribers keep their shared read. The final subscriber's cancellation aborts the upstream request.

The shared session lease covers rereading, renewing and persisting the machine token pair. A waiter detects that another process already replaced its stale access token and reuses the saved pair. This prevents twenty clients from rotating or rewriting the same credentials. Lease ownership is released when a client disconnects. Existing account binding and durable agent-delivery receipts remain authoritative; the transport does not merge conversation contexts or agent jobs.

HTTP connections are bounded to two per origin, with eight total sockets per HTTP/HTTPS agent. This is a shared pool, not one pool per panel. An upstream server can close an idle socket; the next request can create a replacement. The guarantee is bounded shared ownership and deduplicated reads, not an immortal TCP connection.

The worker's required module source is captured when the host starts. Removing an old installation directory does not break an existing chat or its ability to reconnect. `status()` exposes only instance ID, PID, client count and counters; it does not expose URLs, headers, tokens or cached bodies.

Verification includes twenty separate client processes, twenty packaged Codex chat servers, scoped reads, MCP ID correlation, explicit refresh, individual cancellation, worker failure without POST replay, credential expiry, and twenty simultaneous refreshes with one token write. Live acceptance is recorded by the Codex consumer, which owns UI verification.


Codex agent icons now travel in the existing MCP directory/search/detail response
using `include_icons: true`. There are no separate Command Center directory or
per-agent icon requests. An idle panel schedules no discovery or image polling.
The shared transport still caches and coalesces the combined directory response.
