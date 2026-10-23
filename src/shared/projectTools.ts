import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActionRequest, ActionResult, ErrorCode, SessionStatus, ToolingError } from './models';
import type { McpCatalog, McpConnection, McpTool } from './discoveryTypes';
import { mainSequenceStateDirectory } from './stateDirectory';

/**
 * Saved project MCP tools as first-class tools of a host (ADR 0004). One tool name, one
 * definition, one result shape, one refresh loop and one on-disk catalog serve every host;
 * a host keeps only how it registers tools, asks for approval and renders results.
 * The catalog stores schemas and labels, never credentials, tool results or tokens.
 */
type Row = Record<string, unknown>;
export type ProjectToolDispatch = (request: ActionRequest) => Promise<ActionResult<any>>;
/** Which saved connections a listing or a refresh covers. Without a scope, every saved connection. */
export type ProjectToolScope = { backend?: string; environmentUid?: string };
export type ProjectToolBinding = { backend: string; environmentUid: string; environmentName: string; releaseUid: string; connection: string; tool: string };
export type ProjectToolConnection = { backend: string; releaseUid: string; environmentUid: string; environmentName: string; name: string; tools: McpTool[] };
export type ProjectToolCatalog = { version: 1; updatedAt: string; connections: ProjectToolConnection[] };
export type ProjectToolDefinition = { name: string; title: string; description: string; inputSchema: Row;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean } };
export type ProjectToolResult = { content: Row[]; structuredContent?: unknown; isError?: true };
export type ProjectToolCatalogState = {
  count: number;
  connections: { backend: string; releaseUid: string; environmentUid: string; environmentName: string; name: string; tools: number }[];
  updatedAt: string | null; refreshing: boolean; unavailable: string[]; retained: number;
  error: { code: ErrorCode; message: string } | null;
};
/** The `mcp-catalog` action's payload: the state plus what a host registers and how it forwards a call. */
export type ProjectToolCatalogView = ProjectToolCatalogState & {
  backend: string; environmentUid?: string; file: string; refreshed: boolean;
  definitions: ProjectToolDefinition[]; bindings: Record<string, ProjectToolBinding>;
};
export type ProjectToolCatalogOptions = {
  /** A dispatcher for one refresh; the signal aborts when the catalog is disposed mid-refresh. */
  dispatch: (signal: AbortSignal) => ProjectToolDispatch;
  file?: string; env?: NodeJS.ProcessEnv; staleMs?: number; disabled?: boolean;
  /** Called when the registered definitions changed, for a host's change announcement. */
  notify?: () => void;
};

export const PROJECT_TOOL_PREFIX = 'ms_';
export const MAX_PROJECT_TOOLS_PER_CONNECTION = 80;
/** A project may advertise how long one of its tools can take; the client honours it up to the cap. */
export const PROJECT_TOOL_TIMEOUT_HINT = 'mainsequence.ai/timeout-seconds/v1';
export const DEFAULT_PROJECT_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_PROJECT_TOOL_TIMEOUT_MS = 300_000;
const CATALOG_FILE = 'project-tool-catalog.json';
const LOCK_STALE_MS = 10 * 60_000;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 300): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
const clean = (value: string, max: number) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').slice(0, max);

/** `ms_` + the remote name (unsafe characters replaced, cut to 32) + `_` + FNV-1a 32-bit of
 * `backend:environment:release:tool`. The hash binds the saved connection and environment; the
 * prefix keeps the remote name readable. The cut is 32 because Codex qualifies the name as
 * `mcp__mainsequence__<name>` under a 64-character limit; for remote names up to 32 characters
 * the result is the name Claude Desktop has registered since 0.4.13. */
export function projectToolName(backend: string, environmentUid: string, releaseUid: string, tool: string): string {
  const value = `${backend}:${environmentUid}:${releaseUid}:${tool}`;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  return `${PROJECT_TOOL_PREFIX}${String(tool).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}_${hash.toString(16)}`;
}
export const isProjectToolName = (name: unknown): name is string => typeof name === 'string' && name.startsWith(PROJECT_TOOL_PREFIX);

function hints(value: unknown): ProjectToolDefinition['annotations'] extends infer A ? Partial<A> : never {
  const result: Partial<ProjectToolDefinition['annotations']> = {};
  for (const flag of HINTS) if (object(value) && typeof value[flag] === 'boolean') result[flag] = value[flag];
  return result;
}
/** Only what a host needs to register and call a tool: name, description, object schema and the four hints. */
function normalizeTool(value: unknown): McpTool | undefined {
  if (!object(value) || typeof value.name !== 'string' || !value.name || !object(value.inputSchema)) return;
  return { name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}), inputSchema: value.inputSchema, annotations: hints(value.annotations) };
}
const normalizeTools = (tools: unknown): McpTool[] => (Array.isArray(tools) ? tools : []).map(normalizeTool).filter((tool): tool is McpTool => Boolean(tool)).slice(0, MAX_PROJECT_TOOLS_PER_CONNECTION);

/** The release's own name, else its repository's name, else the release UID. */
export const projectToolConnectionLabel = (connection: Pick<McpConnection, 'name' | 'display_name' | 'resource_release_uid'>): string =>
  text(connection.name) || text(connection.display_name) || connection.resource_release_uid;
/** The catalog record of a saved connection and its current tools. */
export function projectToolConnection(connection: McpConnection, tools: McpTool[] = []): ProjectToolConnection {
  return { backend: connection.backend, releaseUid: connection.resource_release_uid.toLowerCase(), environmentUid: connection.mcp_connection.organization_environment_uid.toLowerCase(),
    environmentName: text(connection.mcp_connection.organization_environment_name), name: projectToolConnectionLabel(connection), tools: normalizeTools(tools) };
}
type Source = ProjectToolConnection | McpConnection;
const source = (connection: Source): ProjectToolConnection => 'mcp_connection' in connection ? projectToolConnection(connection) : connection;

/** The host-neutral definition of one remote tool: `MainSequence <connection> [<environment>]: <description>`,
 * an object schema (`type: 'object'` added when the server omitted it) and the four boolean hints,
 * open-world by default. */
export function projectToolDefinition(connection: Source, tool: McpTool): ProjectToolDefinition {
  const c = source(connection), label = c.name || c.releaseUid;
  const schema = object(tool.inputSchema) ? tool.inputSchema : {};
  return { name: projectToolName(c.backend, c.environmentUid, c.releaseUid, tool.name), title: `${label}: ${tool.name}`,
    description: clean(`MainSequence ${label} [${c.environmentName || c.environmentUid}]: ${tool.description || tool.name}`, 2000),
    inputSchema: schema.type === 'object' ? schema : { type: 'object', ...schema }, annotations: { openWorldHint: true, ...hints(tool.annotations) } };
}
/** Up to 80 definitions per connection, one per distinct name. */
export function projectToolDefinitions(connection: Source, tools?: McpTool[]): ProjectToolDefinition[] {
  const seen = new Set<string>(), definitions: ProjectToolDefinition[] = [];
  for (const tool of normalizeTools(tools ?? ('tools' in connection ? connection.tools : []))) {
    const definition = projectToolDefinition(connection, tool);
    if (seen.has(definition.name)) continue;
    seen.add(definition.name); definitions.push(definition);
  }
  return definitions;
}
/** What a host sends back to `mcp-call` for a registered tool. */
export function projectToolBinding(connection: Source, tool: McpTool | string): ProjectToolBinding {
  const c = source(connection);
  return { backend: c.backend, environmentUid: c.environmentUid, environmentName: c.environmentName, releaseUid: c.releaseUid, connection: c.name || c.releaseUid, tool: typeof tool === 'string' ? tool : tool.name };
}
const inScope = (connection: { backend: string; environmentUid: string }, scope?: ProjectToolScope) =>
  (!scope?.backend || connection.backend === scope.backend) && (!scope?.environmentUid || connection.environmentUid === scope.environmentUid.toLowerCase());
/** Definitions and bindings for every tool of the catalog's connections in scope. */
export function projectToolRegistration(catalog: ProjectToolCatalog | null, scope?: ProjectToolScope): { definitions: ProjectToolDefinition[]; bindings: Map<string, ProjectToolBinding> } {
  const definitions: ProjectToolDefinition[] = [], bindings = new Map<string, ProjectToolBinding>();
  for (const connection of catalog?.connections ?? []) {
    if (!inScope(connection, scope)) continue;
    for (const tool of connection.tools.slice(0, MAX_PROJECT_TOOLS_PER_CONNECTION)) {
      const definition = projectToolDefinition(connection, tool);
      if (bindings.has(definition.name)) continue;
      bindings.set(definition.name, projectToolBinding(connection, tool)); definitions.push(definition);
    }
  }
  return { definitions, bindings };
}

/** The host-neutral result of a forwarded `mcp-call`: the remote content blocks, then one JSON text
 * block with `summary`, `effects`, `error` and `structuredContent` when the call failed, returned
 * structured content or no blocks at all; `isError` on any non-success, including `MCP_TOOL_ERROR`,
 * whose original remote content is preserved. A failure without structured content carries that
 * JSON as `structuredContent`, so a host that reads only structured output still sees the error. */
export function projectToolResult(result: ActionResult): ProjectToolResult {
  const data = object(result.data) ? result.data : undefined;
  const blocks = Array.isArray(data?.content) ? data.content.filter((block): block is Row => object(block) && typeof block.type === 'string') : [];
  const failed = result.status !== 'success', structured = data?.structuredContent;
  const extra = { summary: result.summary, ...(result.effects ? { effects: result.effects } : {}), ...(result.error ? { error: result.error } : {}), ...(structured !== undefined ? { structuredContent: structured } : {}) };
  const content = [...blocks, ...(!blocks.length || failed || structured !== undefined ? [{ type: 'text', text: JSON.stringify(extra) }] : [])];
  return { ...(failed ? { isError: true as const } : {}), content, ...(structured !== undefined ? { structuredContent: structured } : failed ? { structuredContent: extra } : {}) };
}

/** The HTTP budget for one `tools/call`: the default, or the tool's advertised seconds when larger, capped. */
export function projectToolTimeoutMs(tool: McpTool | undefined, defaultMs = DEFAULT_PROJECT_REQUEST_TIMEOUT_MS): number {
  const hint = object(tool?._meta) ? tool!._meta![PROJECT_TOOL_TIMEOUT_HINT] : undefined;
  if (typeof hint !== 'number' || !Number.isFinite(hint) || hint <= 0) return defaultMs;
  return Math.max(defaultMs, Math.min(Math.round(hint * 1000), MAX_PROJECT_TOOL_TIMEOUT_MS));
}

function success<T>(result: ActionResult<T>): T {
  if (result.status !== 'success') throw new ToolingError(result.error?.code ?? 'API_ERROR', result.summary);
  if (result.data === undefined) throw new ToolingError('API_ERROR', 'MainSequence returned no data.');
  return result.data;
}
/** Every saved connection in scope and its current tools: `mcp-list` (read-only), then one `mcp-tools`
 * per connection, two at a time (the shared transport's per-origin limit). A connection whose catalog
 * cannot be read now keeps its `previous` tools and is named in `unavailable`; a removed connection
 * loses them; connections outside the scope are carried over from `previous` unchanged. No account
 * snapshot is attached: a registered tool is bound to a saved connection, and the session for that
 * connection's backend is verified when the tool is called. */
export async function readProjectToolCatalog(dispatch: ProjectToolDispatch, options: {
  backend?: string; environmentUid?: string; previous?: ProjectToolCatalog | null; signal?: AbortSignal;
  /** The session status already read for this refresh; otherwise `auth-status` is dispatched first. */
  session?: SessionStatus;
} = {}): Promise<{ catalog: ProjectToolCatalog; backend: string; unavailable: string[]; retained: number }> {
  const status = options.session ?? success(await dispatch({ action: 'auth-status', ...(options.backend ? { backend: options.backend } : {}) })) as SessionStatus;
  if (!status.authenticated || !status.backend) throw new ToolingError('NOT_AUTHENTICATED', 'Sign in to MainSequence to register saved project MCP tools.');
  const backend = status.backend, environmentUid = options.environmentUid?.toLowerCase();
  if (environmentUid !== undefined && !UUID.test(environmentUid)) throw new ToolingError('INVALID_REQUEST', 'The environment must be an organization environment UUID.');
  const scope = { backend, environmentUid }, environment = environmentUid ? { environmentUid } : {};
  const rows = success(await dispatch({ action: 'mcp-list', backend, readOnly: true, ...environment })) as McpConnection[];
  const previous = options.previous?.connections ?? [];
  const connections = previous.filter(connection => !inScope(connection, scope)), unavailable: string[] = [];
  let retained = 0;
  const pending = [...rows];
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
    while (pending.length) {
      options.signal?.throwIfAborted();
      const row = pending.shift()!;
      try {
        const output = success(await dispatch({ action: 'mcp-tools', backend, releaseUid: row.resource_release_uid, ...environment })) as McpCatalog;
        const current = output.connection;
        connections.push(projectToolConnection({ ...row, name: row.name ?? current?.name, display_name: row.display_name ?? current?.display_name,
          mcp_connection: { ...row.mcp_connection, organization_environment_name: row.mcp_connection.organization_environment_name ?? current?.mcp_connection?.organization_environment_name } }, output.tools));
      } catch (error) {
        if (error instanceof ToolingError && error.code === 'CANCELLED') throw error;
        options.signal?.throwIfAborted();
        const earlier = previous.find(connection => connection.backend === backend && connection.releaseUid === row.resource_release_uid.toLowerCase());
        if (earlier) { connections.push(earlier); retained += earlier.tools.length; }
        unavailable.push(projectToolConnectionLabel(row));
      }
    }
  }));
  connections.sort((a, b) => a.backend.localeCompare(b.backend) || a.environmentUid.localeCompare(b.environmentUid) || a.releaseUid.localeCompare(b.releaseUid));
  return { catalog: { version: 1, updatedAt: new Date().toISOString(), connections }, backend, unavailable, retained };
}

function connectionRecord(value: unknown): ProjectToolConnection | undefined {
  if (!object(value) || typeof value.backend !== 'string' || !UUID.test(String(value.releaseUid)) || !UUID.test(String(value.environmentUid)) || !Array.isArray(value.tools)) return;
  return { backend: value.backend, releaseUid: String(value.releaseUid).toLowerCase(), environmentUid: String(value.environmentUid).toLowerCase(),
    environmentName: text(value.environmentName), name: text(value.name), tools: normalizeTools(value.tools) };
}
/** Beside `mcp-connections.json`, shared by every host on the machine. */
export const projectToolCatalogPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(mainSequenceStateDirectory(env), CATALOG_FILE);
/** A missing or damaged cache is an empty catalog, never an error. */
export function readProjectToolCatalogFile(file: string): ProjectToolCatalog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.connections)) return null;
    return { version: 1, updatedAt: text(raw.updatedAt, 40), connections: raw.connections.map(connectionRecord).filter((item): item is ProjectToolConnection => Boolean(item)) };
  } catch { return null; }
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** The file-backed catalog: read at once from the shared cache so a host can register tools before
 * any network request, refreshed under a lock so one process reads the catalogs at a time while the
 * others pick its result up from the file, and reloaded when another process wrote it. */
export function createProjectToolCatalog(options: ProjectToolCatalogOptions) {
  const file = options.file ?? projectToolCatalogPath(options.env), staleMs = options.staleMs ?? 15 * 60_000;
  let catalog = readProjectToolCatalogFile(file), loadedAt = mtime(), running: Promise<boolean> | null = null;
  let current: { controller: AbortController; locked: boolean } | null = null;
  // The scope of the last refresh: the current account's backend (learned from auth-status), so a
  // listing shows this host's connections even when another backend's are cached beside them.
  let known: ProjectToolScope | undefined;
  const state = { unavailable: [] as string[], retained: 0, error: null as ProjectToolCatalogState['error'] };
  function mtime(): number { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }
  /** Another process may have refreshed the shared cache since this one read it. */
  function reload(): void {
    const now = mtime();
    if (now === loadedAt) return;
    catalog = readProjectToolCatalogFile(file); loadedAt = now;
  }
  const registration = (scope?: ProjectToolScope) => projectToolRegistration(catalog, scope ?? known);
  async function write(next: ProjectToolCatalog): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fsp.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fsp.rename(temporary, file); }
    finally { await fsp.rm(temporary, { force: true }); }
  }
  function adopt(next: ProjectToolCatalog | null, scope?: ProjectToolScope): void {
    const before = JSON.stringify(registration().definitions);
    if (next) { catalog = next; loadedAt = mtime(); }
    if (scope) known = scope;
    if (JSON.stringify(registration().definitions) !== before) options.notify?.();
  }
  /** One process refreshes at a time. A live lock means another process is refreshing: without a
   * wait the caller reuses its result from the file; with one it waits for the lock up to `waitMs`.
   * An interrupted refresh from a closed host must not block every later one (stale after 10 min). */
  async function lock(waitMs: number, signal: AbortSignal): Promise<(() => Promise<void>) | null> {
    const name = file + '.lock', deadline = Date.now() + waitMs;
    for (let attempt = 0; attempt < 10_000; attempt++) {
      signal.throwIfAborted();
      try {
        const handle = await fsp.open(name, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        return async () => { await handle.close(); await fsp.rm(name, { force: true }); };
      } catch (error: any) {
        if (error?.code === 'ENOENT') { await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); continue; }
        if (error?.code !== 'EEXIST') return null;
        let stale: boolean;
        try { stale = Date.now() - (await fsp.stat(name)).mtimeMs >= LOCK_STALE_MS; } catch { continue; }
        if (stale) { await fsp.rm(name, { force: true }); continue; }
        if (Date.now() >= deadline) return null;
        await sleep(250, signal);
      }
    }
    return null;
  }
  return {
    file,
    /** Definitions for the host's tool list, from the newest shared cache. */
    list(scope?: ProjectToolScope): ProjectToolDefinition[] { reload(); return registration(scope).definitions; },
    binding(name: string): ProjectToolBinding | undefined { reload(); return registration({}).bindings.get(name); },
    state(scope?: ProjectToolScope): ProjectToolCatalogState {
      reload();
      const selected = scope ?? known;
      return { count: registration(scope).definitions.length,
        connections: (catalog?.connections ?? []).filter(connection => inScope(connection, selected)).map(connection => ({ backend: connection.backend, releaseUid: connection.releaseUid,
          environmentUid: connection.environmentUid, environmentName: connection.environmentName, name: connection.name, tools: connection.tools.length })),
        updatedAt: catalog?.updatedAt || null, refreshing: running !== null, unavailable: state.unavailable, retained: state.retained, error: state.error };
    },
    /** The state plus definitions and bindings, as the `mcp-catalog` action returns them. */
    view(scope?: ProjectToolScope): ProjectToolCatalogState & { definitions: ProjectToolDefinition[]; bindings: Record<string, ProjectToolBinding> } {
      const { definitions, bindings } = registration(scope);
      return { ...this.state(scope), definitions, bindings: Object.fromEntries(bindings) };
    },
    /** Read every saved connection's current catalog. Without `force`, a fresh cache is kept. Resolves
     * true when this process read and wrote the catalog; the state carries why it did not. */
    refresh(force = false, extra: { scope?: ProjectToolScope; waitMs?: number } = {}): Promise<boolean> {
      if (options.disabled) return Promise.resolve(false);
      if (running) return running;
      reload();
      const controller = new AbortController();
      current = { controller, locked: false };
      running = (async () => {
        const dispatch = options.dispatch(controller.signal), scope = extra.scope;
        const fresh = () => Boolean(catalog && Date.parse(catalog.updatedAt) > Date.now() - staleMs);
        try {
          // A fresh cache with a known scope needs nothing; otherwise one local session read tells
          // whether there is a session to read catalogs with, and which backend the listing is for.
          if (!force && (known || scope) && fresh()) { if (scope) adopt(null, scope); return false; }
          const session = success(await dispatch({ action: 'auth-status', ...(scope?.backend ? { backend: scope.backend } : {}) })) as SessionStatus;
          if (session.backend) adopt(null, scope ?? { backend: session.backend });
          if (!session.authenticated || !session.backend) throw new ToolingError('NOT_AUTHENTICATED', 'Sign in to MainSequence to register saved project MCP tools.');
          if (!force && fresh()) return false;
          const release = await lock(extra.waitMs ?? 0, controller.signal);
          if (!release) {
            if (extra.waitMs) state.error = { code: 'PROJECT_BUSY', message: 'Another MainSequence process is refreshing the project tool catalog. The registered tools come from its last result; refresh again later.' };
            return false;
          }
          current!.locked = true;
          try {
            reload();
            const read = await readProjectToolCatalog(dispatch, { ...scope, backend: session.backend, previous: catalog, signal: controller.signal, session });
            await write(read.catalog);
            state.unavailable = read.unavailable; state.retained = read.retained; state.error = null;
            adopt(read.catalog, scope ?? { backend: read.backend });
            return true;
          } finally { current!.locked = false; await release(); }
        } catch (error) {
          state.error = { code: error instanceof ToolingError ? error.code : 'INTERNAL_ERROR', message: error instanceof ToolingError ? error.message : 'The saved project MCP tools could not be refreshed.' };
          return false;
        }
      })().finally(() => { running = null; current = null; });
      return running;
    },
    /** A host process is ending: stop its refresh and free the shared lock for the next one at once. */
    dispose(): void {
      if (!current) return;
      current.controller.abort();
      if (current.locked) { try { fs.rmSync(file + '.lock', { force: true }); } catch { /* the stale-lock rule still applies */ } }
    },
    /** A catalog just read explicitly for one saved release replaces that connection's tools without another round trip. */
    async update(releaseUid: string, tools: McpTool[], backend?: string): Promise<void> {
      if (options.disabled) return;
      reload();
      const index = catalog?.connections.findIndex(item => item.releaseUid === releaseUid.toLowerCase() && (!backend || item.backend === backend)) ?? -1;
      if (!catalog || index < 0) { void this.refresh(true); return; }
      const connections = catalog.connections.map((item, i) => i === index ? { ...item, tools: normalizeTools(tools) } : item);
      const next: ProjectToolCatalog = { version: 1, updatedAt: new Date().toISOString(), connections };
      try { await write(next); adopt(next); } catch { /* the in-memory tools are already current */ }
    },
  };
}
export type ProjectToolCatalogStore = ReturnType<typeof createProjectToolCatalog>;
