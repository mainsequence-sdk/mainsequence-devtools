import { ActionResult } from '../shared/models';
import { codexHelp, developerCommands, displayCodexResult } from './codexPresentation';

export const openCodeActions = [
  ...developerCommands.map(({ action, title, group }) => ({ action, title, group })),
  { action: 'mcp-discover', title: 'Connect a project MCP', group: 'MCP' },
  { action: 'mcp-list', title: 'Manage connected MCPs', group: 'MCP' },
  { action: 'mcp-refresh', title: 'Refresh MCP tools', group: 'MCP' },
  { action: 'history', title: 'Recent actions', group: 'MainSequence' },
];

export function openCodeHelp(argv: string[]): string {
  return codexHelp(argv).replace(/\n\nAll commands:.*$/, '') +
    '\n\nProject MCPs\n/ms mcp-discover\n/ms mcp-list\n/ms mcp-add --uid RELEASE_UUID\n/ms mcp-remove --uid RELEASE_UUID\n/ms mcp-tools --uid RELEASE_UUID\n/ms mcp-refresh\n\n/ms opens the MainSequence menu. Commands run directly, without a model.';
}
export const cleanText = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
export function connectionLabel(value: any): string {
  return cleanText(value?.name || 'Unnamed project') + ' · ' + cleanText(value?.mcp_connection?.organization_environment_name || 'Unknown Environment');
}
function readable(value: unknown, depth = 0): string {
  if (depth > 8) return '[Nested content]';
  if (Array.isArray(value)) return value.map(item => readable(item, depth + 1)).join('\n\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) =>
    `${cleanText(key).replace(/[_-]/g, ' ')}: ${readable(item, depth + 1)}`).join('\n');
  return cleanText(value);
}
export function displayOpenCodeResult(result: ActionResult): string {
  if (!result.action.startsWith('mcp-') || result.status !== 'success') return cleanText(displayCodexResult(result));
  const data = result.data as any;
  if (result.action === 'mcp-refresh') return [result.summary, ...(Array.isArray(data?.unavailable) ? data.unavailable.map((item: any) =>
    `${cleanText(item.name)} · Unavailable\n${cleanText(item.message)}`) : [])].join('\n\n');
  const rows = Array.isArray(data) ? data : data?.results;
  if (Array.isArray(rows)) return [result.summary, ...rows.map(row => connectionLabel(row)),
    rows.length === 0 ? 'No connections found.' : '',
    typeof data?.count === 'number' ? `${rows.length} shown of ${data.count}. Use --offset to see more.` : ''].filter(Boolean).join('\n\n');
  if (Array.isArray(data?.tools)) return [connectionLabel(data.connection), result.summary,
    ...data.tools.map((tool: any) => `${cleanText(tool.name)}\n${cleanText(tool.description || '')}`)].join('\n\n');
  if (Array.isArray(data?.content)) return [result.summary, ...data.content.map((item: any) =>
    item.type === 'text' ? cleanText(item.text) : item.type === 'image' || item.type === 'audio' ? `${item.type} result (${cleanText(item.mimeType)})`
      : readable(item)), data.structuredContent ? readable(data.structuredContent) : ''].filter(Boolean).join('\n\n');
  return [result.summary, data?.connection ? connectionLabel(data.connection) : ''].filter(Boolean).join('\n\n');
}
