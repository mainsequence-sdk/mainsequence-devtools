# ADR 0002: Conversational project MCP connections in the Codex plugin

Moved on 2026-10-21 to the Codex plugin repository:
[mainsequence-codex-plugin/docs/adr/0002-conversational-project-mcp-client.md](https://github.com/mainsequence-sdk/mainsequence-codex-plugin/blob/main/docs/adr/0002-conversational-project-mcp-client.md).

The MCP client that ADR specifies stays in this package: the `mcp-discover`, `mcp-add`,
`mcp-list`, `mcp-remove`, `mcp-tools` and `mcp-call` actions, the `mcp-connections.json`
store beside the CLI configuration, and the release credential exchange. The
`mainsequence-mcp` skill, the `ms` slash-menu entry and the hook that expose them in
Codex are released from that repository. See [ADR 0003](0003-codex-plugin-extraction.md).
