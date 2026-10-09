import { ToolingError } from './models';

/** The platform's stateless Streamable HTTP profile; no legacy SSE endpoint. */
export class McpTransport {
  private sequence = 0;
  private initialized = false;
  constructor(private readonly send: (message: Record<string, unknown>) => Promise<unknown>) {}

  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'mainsequence-devtools', version: '0.2.1' },
    });
    if (result?.protocolVersion !== '2025-11-25' || !result?.capabilities?.tools) {
      throw new ToolingError('UNSUPPORTED_ACTION', 'This endpoint does not support the platform MCP tools profile (2025-11-25).');
    }
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
  }

  async request(method: string, params: Record<string, unknown>): Promise<any> {
    if (method !== 'initialize' && !this.initialized) throw new ToolingError('API_ERROR', 'The MCP connection has not initialized.');
    const id = ++this.sequence;
    const response = await this.send({ jsonrpc: '2.0', id, method, params }) as any;
    if (!response || response.jsonrpc !== '2.0' || response.id !== id) {
      throw new ToolingError('API_ERROR', 'The MCP endpoint returned an invalid or mismatched response.');
    }
    if (response.error) throw new ToolingError('API_ERROR', 'The MCP endpoint rejected ' + method
      + (Number.isInteger(response.error.code) ? ' (JSON-RPC ' + response.error.code + ')' : '') + '.');
    if (!Object.hasOwn(response, 'result')) throw new ToolingError('API_ERROR', 'The MCP response has no result.');
    return response.result;
  }

  async tools(): Promise<any[]> {
    const tools: any[] = [], cursors = new Set<string>(), names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new ToolingError('API_ERROR', 'The MCP tool catalog is invalid.');
      for (const tool of page.tools) {
        if (!tool || typeof tool.name !== 'string' || !tool.name || !tool.inputSchema || typeof tool.inputSchema !== 'object' || names.has(tool.name)) {
          throw new ToolingError('API_ERROR', 'The MCP tool catalog contains an invalid or duplicate tool.');
        }
        names.add(tool.name); tools.push(tool);
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

/** Read bounded JSON or POST SSE; never reconnect or replay a tool invocation. */
export async function readMcpResponse(response: Response, message: Record<string, unknown>): Promise<unknown> {
  if (response.headers.has('mcp-session-id')) {
    await response.body?.cancel();
    throw new ToolingError('UNSUPPORTED_ACTION', 'Stateful MCP sessions are outside the platform profile.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolingError(response.status === 401 || response.status === 403 ? 'AUTH_REJECTED' : 'API_ERROR',
      'The MCP endpoint returned HTTP ' + response.status + '.');
  }
  if (!Object.hasOwn(message, 'id')) {
    await response.body?.cancel();
    if (response.status !== 202 && response.status !== 204) throw new ToolingError('API_ERROR', 'The MCP notification was not acknowledged.');
    return undefined;
  }
  const kind = response.headers.get('content-type')?.split(';')[0].trim();
  if (kind !== 'application/json' && kind !== 'text/event-stream') {
    await response.body?.cancel();
    throw new ToolingError('API_ERROR', 'The MCP endpoint returned an unsupported content type.');
  }
  if (!response.body) throw new ToolingError('API_ERROR', 'The MCP endpoint returned an empty response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  const parse = (raw: string) => {
    try { return JSON.parse(raw); } catch { throw new ToolingError('API_ERROR', 'The MCP endpoint returned invalid JSON.'); }
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
    throw new ToolingError('API_ERROR', 'The MCP stream ended before the response arrived. The call was not retried.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function sendProjectMcp(url: string, token: string, message: Record<string, unknown>, options: {
  fetch?: typeof fetch; signal?: AbortSignal; requestTimeoutMs?: number;
}): Promise<unknown> {
  options.signal?.throwIfAborted();
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.requestTimeoutMs ?? 60_000);
  try {
    return await readMcpResponse(await (options.fetch ?? fetch)(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + token, 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify(message),
    }), message);
  } catch (error) {
    if (options.signal?.aborted) throw new ToolingError('CANCELLED', 'The MCP request was cancelled. Cancellation does not undo a remote operation.');
    if (error instanceof ToolingError) throw error;
    throw new ToolingError('BACKEND_UNREACHABLE', 'The MCP request failed or timed out. It was not retried.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
