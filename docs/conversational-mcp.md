# Conversational project MCP connections

The user guide moved on 2026-10-21 to the Codex plugin repository:
[mainsequence-codex-plugin/docs/conversational-mcp.md](https://github.com/mainsequence-sdk/mainsequence-codex-plugin/blob/main/docs/conversational-mcp.md).

This package keeps the client and its command-line form. `ms-devtools mcp-discover`,
`mcp-add`, `mcp-list`, `mcp-remove`, `mcp-tools` and `mcp-call` are listed by
`ms-devtools --help`, and `createDevTools().dispatch()` accepts the same `mcp-*`
actions through `ActionRequest`. Hosts may inject `mcpConnectionsPath` for their own
metadata location. See [ADR 0002](adr/0002-conversational-project-mcp-client.md).
