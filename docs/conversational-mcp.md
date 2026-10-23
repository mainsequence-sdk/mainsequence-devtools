# Conversational project MCP connections

The user guide moved on 2026-10-21 to the Codex plugin repository:
[mainsequence-codex-plugin/docs/conversational-mcp.md](https://github.com/mainsequence-sdk/mainsequence-codex-plugin/blob/main/docs/conversational-mcp.md).

This package keeps the client and its command-line form. `ms-devtools mcp-discover`,
`mcp-add`, `mcp-list`, `mcp-remove`, `mcp-tools` and `mcp-call` are listed by
`ms-devtools --help`, and `createDevTools().dispatch()` accepts the same `mcp-*`
actions through `ActionRequest`. Hosts may inject `mcpConnectionsPath` for their own
metadata location. See [ADR 0002](adr/0002-conversational-project-mcp-client.md).

Since 0.3.12 the saved connections' tools are also available as a host registers them,
`ms_<tool>_<hash>`, through `ms-devtools mcp-catalog [--refresh]` and the `mcp-catalog`
action, from the shared `project-tool-catalog.json` beside `mcp-connections.json`; see the
[shared project-tool registry](../README.md#shared-project-tool-registry-0312) and
[ADR 0004](adr/0004-shared-project-tool-registry.md). A cold project MCP has taken over a
minute to answer `initialize`: project requests get 120 s by default
(`projectRequestTimeoutMs`), and a tool's advertised
`_meta["mainsequence.ai/timeout-seconds/v1"]` is honoured when larger, capped at 300 s.
