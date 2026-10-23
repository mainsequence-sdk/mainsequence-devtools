import { ToolingError } from './models';
import type { McpTool } from './discoveryTypes';
import { DEFAULT_PROJECT_REQUEST_TIMEOUT_MS } from './projectTools';

/** One request's own options; the transport's defaults apply otherwise. */
export type McpRequestOptions = { timeoutMs?: number };
export type McpSend = (message: Record<string, unknown>, options?: McpRequestOptions) => Promise<unknown>;

const safeText = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').trim().slice(0, max);
/** `initialize`, `tools/list`, `tools/call crm_contacts_list`: what a message asked the server for. */
export function describeMcpMessage(message: Record<string, unknown>): string {
  const method = typeof message.method === 'string' ? message.method : 'request';
  const name = method === 'tools/call' && message.params && typeof message.params === 'object' ? (message.params as Record<string, unknown>).name : undefined;
  return typeof name === 'string' && name ? `${method} ${safeText(name, 120)}` : method;
}
/** "0.3", "1", "120": a budget in seconds, as a person reads it. */
export const describeSeconds = (ms: number): string => (ms / 1000).toFixed(ms % 1000 ? 1 : 0);
/** Why a request failed before any response arrived: the system error code (ECONNREFUSED, ENOTFOUND,
 * ECONNRESET, a certificate code) when there is one. Free-text error messages never reach a host:
 * they can carry addresses and credentials. */
export function failureReason(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code ?? (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : '';
}

/** The platform's stateless Streamable HTTP profile; no legacy SSE endpoint. */
export class McpTransport {
  private sequence = 0;
  constructor(private readonly send: McpSend, private initialized = false) {}

  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'mainsequence-devtools', version: '0.2.7' },
    });
    if (result?.protocolVersion !== '2025-11-25' || !result?.capabilities?.tools) {
      throw new ToolingError('UNSUPPORTED_ACTION', 'This endpoint does not support the platform MCP tools profile (2025-11-25).');
    }
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
  }

  async request(method: string, params: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    if (method !== 'initialize' && !this.initialized) throw new ToolingError('API_ERROR', 'The MCP connection has not initialized.');
    const id = ++this.sequence;
    const message = { jsonrpc: '2.0', id, method, params };
    const response = await this.send(message, options) as any;
    if (!response || response.jsonrpc !== '2.0' || response.id !== id) {
      throw new ToolingError('API_ERROR', 'The MCP endpoint returned an invalid or mismatched response to ' + describeMcpMessage(message) + '.');
    }
    if (response.error) {
      // The server's own words, bounded; the dispatcher redacts credentials before any host sees them.
      const detail = safeText(response.error.message, 300);
      throw new ToolingError('API_ERROR', 'The MCP endpoint rejected ' + describeMcpMessage(message)
        + (Number.isInteger(response.error.code) ? ' (JSON-RPC ' + response.error.code + ')' : '') + (detail ? ': ' + detail : '.'));
    }
    if (!Object.hasOwn(response, 'result')) throw new ToolingError('API_ERROR', 'The MCP response to ' + describeMcpMessage(message) + ' has no result.');
    return response.result;
  }

  async tools(): Promise<McpTool[]> {
    const tools: McpTool[] = [], cursors = new Set<string>(), names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new ToolingError('API_ERROR', 'The MCP tool catalog is invalid.');
      for (const tool of page.tools) {
        if (!tool || typeof tool.name !== 'string' || !tool.name || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema) || names.has(tool.name)) {
          throw new ToolingError('API_ERROR', 'The MCP tool catalog contains an invalid or duplicate tool.');
        }
        const normalized = { ...tool };
        if (typeof normalized.description !== 'string') delete normalized.description;
        for (const field of ['annotations', '_meta']) if (!normalized[field] || typeof normalized[field] !== 'object' || Array.isArray(normalized[field])) delete normalized[field];
        if (normalized.annotations) {
          normalized.annotations = { ...normalized.annotations };
          for (const flag of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
            if (typeof normalized.annotations[flag] !== 'boolean') delete normalized.annotations[flag];
          }
        }
        names.add(tool.name); tools.push(normalized);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) {
        throw new ToolingError('API_ERROR', 'The MCP tool catalog returned an invalid pagination cursor.');
      }
      if (cursor) cursors.add(cursor);
      if (tools.length > 10_000 || cursors.size > 100) throw new ToolingError('API_ERROR', 'The MCP tool catalog exceeded the client limit.');
    } while (cursor);
    return tools;
  }
}

/** Read bounded JSON or POST SSE; never reconnect or replay a tool invocation. `target` names the
 * endpoint in errors ("project MCP https://crm.example"), so a person or a model sees which server
 * answered which request with which status. */
export async function readMcpResponse(response: Response, message: Record<string, unknown>, target = 'MCP endpoint'): Promise<unknown> {
  if (response.headers.has('mcp-session-id')) {
    await response.body?.cancel();
    throw new ToolingError('UNSUPPORTED_ACTION', 'Stateful MCP sessions are outside the platform profile.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolingError(response.status === 401 || response.status === 403 ? 'AUTH_REJECTED' : 'API_ERROR',
      'The ' + target + ' returned HTTP ' + response.status + ' for ' + describeMcpMessage(message) + '.');
  }
  if (!Object.hasOwn(message, 'id')) {
    await response.body?.cancel();
    if (response.status !== 202 && response.status !== 204) throw new ToolingError('API_ERROR', 'The ' + target + ' did not acknowledge ' + describeMcpMessage(message) + ' (HTTP ' + response.status + ').');
    return undefined;
  }
  const kind = response.headers.get('content-type')?.split(';')[0].trim();
  if (kind !== 'application/json' && kind !== 'text/event-stream') {
    await response.body?.cancel();
    throw new ToolingError('API_ERROR', 'The ' + target + ' returned an unsupported content type for ' + describeMcpMessage(message) + '.');
  }
  if (!response.body) throw new ToolingError('API_ERROR', 'The ' + target + ' returned an empty response to ' + describeMcpMessage(message) + '.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  const parse = (raw: string) => {
    try { return JSON.parse(raw); } catch { throw new ToolingError('API_ERROR', 'The ' + target + ' returned invalid JSON for ' + describeMcpMessage(message) + '.'); }
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8_000_000) throw new ToolingError('API_ERROR', 'The MCP response exceeded the client limit.');
      text += decoder.decode(part.value, { stream: true });
      if (kind === 'text/event-stream') {
        // Normalize CRLF only once both bytes have arrived; chunk boundaries may split them.
        text = text.replace(/\r\n/g, '\n');
        let end: number;
        while ((end = text.indexOf('\n\n')) >= 0) {
          const event = text.slice(0, end); text = text.slice(end + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const value = parse(data);
          if (value?.id === message.id && !value.method) return value;
          if (value?.method && Object.hasOwn(value, 'id')) throw new ToolingError('UNSUPPORTED_ACTION', 'The MCP endpoint requested an unsupported client capability.');
          if (value && Object.hasOwn(value, 'id')) throw new ToolingError('API_ERROR', 'The MCP stream returned a mismatched response.');
        }
      }
    }
    text += decoder.decode();
    if (kind === 'application/json') return parse(text);
    throw new ToolingError('API_ERROR', 'The MCP stream from the ' + target + ' ended before the response to ' + describeMcpMessage(message) + ' arrived. The call was not retried.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One request to a project's MCP endpoint with the release credential. The budget is the project
 * request timeout (default 120 s: a scaled-to-zero release has taken over a minute to answer
 * `initialize`), or the caller's own for a tool that advertises a longer run. A timeout and a
 * connection failure keep the same code, `BACKEND_UNREACHABLE`, and say which they were. */
export async function sendProjectMcp(url: string, token: string, message: Record<string, unknown>, options: {
  fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number;
}): Promise<unknown> {
  options.signal?.throwIfAborted();
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const budget = options.timeoutMs ?? DEFAULT_PROJECT_REQUEST_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
  const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
  try {
    return await readMcpResponse(await (options.fetch ?? fetch)(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      ...(['initialize', 'notifications/initialized', 'tools/list'].includes(String(message.method)) ? { cache: 'force-cache' as const } : {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + token, 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify(message),
    }), message, 'project MCP ' + origin);
  } catch (error) {
    if (options.signal?.aborted) throw new ToolingError('CANCELLED', 'The MCP request was cancelled. Cancellation does not undo a remote operation.');
    if (error instanceof ToolingError) throw error;
    if (timedOut) throw new ToolingError('BACKEND_UNREACHABLE', 'The project MCP ' + describeMcpMessage(message) + ' request to ' + origin + ' timed out after ' + describeSeconds(budget) + ' s. It was not retried.');
    const reason = failureReason(error);
    throw new ToolingError('BACKEND_UNREACHABLE', 'The project MCP ' + describeMcpMessage(message) + ' request to ' + origin + ' failed before a response arrived' + (reason ? ' (' + reason + ')' : '') + '. It was not retried.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
