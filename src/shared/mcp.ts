import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ActionResult, SessionService, ToolingError } from './models';
import { requireBackend } from './session';
import { McpTransport, sendProjectMcp } from './mcpTransport';
import { codeRepositoryBranchFromResponse } from './repositoryModels';

export type McpRequest = { backend?: string; environmentUid?: string } & (
  | { action: 'mcp-discover'; search?: string; limit?: number; offset?: number }
  | { action: 'mcp-list' }
  | { action: 'mcp-environments' }
  | { action: 'mcp-add' | 'mcp-remove' | 'mcp-tools'; releaseUid: string }
  | { action: 'mcp-call'; releaseUid: string; tool: string; arguments: Record<string, unknown> }
);
/** `name` is the release's own name, `display_name` its repository's name; both are
 * resolved when a connection is added and stored with it, so listing needs no lookup. */
type Connection = {
  backend: string; resource_release_uid: string; name?: string; display_name?: string; code_repository_branch_uid?: string;
  mcp_connection: { url: string; transport: 'streamable-http'; resource_metadata_url: string;
    organization_environment_uid: string; organization_environment_name?: string; active_revision_uid: string };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ToolingError('INVALID_REQUEST', 'Select an exact resource release UUID from MCP discovery or saved connections.');
  }
  return value.toLowerCase();
}
type Labels = Pick<Connection, 'name' | 'display_name' | 'code_repository_branch_uid'>;
/** Optional labels: an absent or malformed value is dropped, never an error. */
function labels(row: any): Labels {
  const text = (value: unknown) => typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value) ? value.trim() : undefined;
  const name = text(row?.name), display = text(row?.display_name);
  const branch = typeof row?.code_repository_branch_uid === 'string' && UUID.test(row.code_repository_branch_uid) ? row.code_repository_branch_uid.toLowerCase() : undefined;
  return { ...(name ? { name } : {}), ...(display ? { display_name: display } : {}), ...(branch ? { code_repository_branch_uid: branch } : {}) };
}
function endpoint(value: unknown, metadata = false): string {
  if (typeof value !== 'string') throw new ToolingError('API_ERROR', 'The backend returned no MCP endpoint.');
  let url: URL;
  try { url = new URL(value); } catch { throw new ToolingError('API_ERROR', 'The backend returned an invalid MCP endpoint.'); }
  if (url.username || url.password || (!metadata && url.search) || url.hash || /[\r\n\0]/.test(value)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new ToolingError('API_ERROR', 'An HTTPS endpoint, or loopback HTTP endpoint for local development, is required.');
  }
  return value;
}
function connection(backend: string, row: any): Connection {
  const c = row?.mcp_connection;
  if (!c || c.transport !== 'streamable-http') {
    throw new ToolingError('API_ERROR', 'The selected release has no active platform MCP connection.');
  }
  const url = endpoint(c.url);
  if (new URL(url).pathname !== '/mcp') throw new ToolingError('API_ERROR', 'The release returned a non-canonical MCP endpoint.');
  const releaseUid = uuid(row.resource_release_uid ?? row.uid), metadataUrl = endpoint(c.resource_metadata_url, true);
  const metadataQuery = new URL(metadataUrl).searchParams;
  if ([...metadataQuery.keys()].some(key => key !== 'resource_release_uid') || metadataQuery.getAll('resource_release_uid').length !== 1
    || metadataQuery.get('resource_release_uid') !== releaseUid) throw new ToolingError('API_ERROR', 'The MCP metadata targets another release.');
  return { backend: requireBackend(backend), resource_release_uid: releaseUid, ...labels(row),
    mcp_connection: { url, transport: 'streamable-http', resource_metadata_url: metadataUrl,
      organization_environment_uid: uuid(c.organization_environment_uid),
      ...(typeof c.organization_environment_name === 'string' && c.organization_environment_name.trim() ? { organization_environment_name: c.organization_environment_name.trim() } : {}), active_revision_uid: uuid(c.active_revision_uid) } };
}
function storagePath(env: NodeJS.ProcessEnv): string {
  const dir = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'MainSequenceCLI')
    : process.platform === 'win32' ? path.join(env.APPDATA || os.homedir(), 'MainSequenceCLI') : path.join(os.homedir(), '.config', 'mainsequence');
  return path.join(dir, 'mcp-connections.json');
}

/** Only endpoint metadata is persisted. Release credentials exist in one invocation's memory. */
export class McpConnections {
  private readonly file: string;
  private readonly secrets = new Set<string>();
  constructor(private readonly session: SessionService & { sanitize?(text: string): string }, private readonly options: {
    connectionsPath?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; signal?: AbortSignal; requestTimeoutMs?: number;
  } = {}) { this.file = options.connectionsPath ?? storagePath(options.env ?? process.env); }

  private sanitize(value: any): any {
    if (typeof value === 'string') {
      for (const secret of this.secrets) value = value.split(secret).join('[redacted]');
      return this.session.sanitize?.(value) ?? value;
    }
    if (Array.isArray(value)) return value.map(item => this.sanitize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.sanitize(key), this.sanitize(item)]));
    return value;
  }
  private async read(): Promise<Connection[]> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.size > 2_000_000) throw new Error('invalid store');
      const rows = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('invalid store');
      return rows.map(row => connection(row.backend, row));
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      throw new ToolingError('STORE_ERROR', 'Saved MCP connections could not be read. The existing file has been kept.');
    }
  }
  private async update(change: (rows: Connection[]) => Connection[]): Promise<void> {
    this.options.signal?.throwIfAborted();
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = this.file + '.lock', temporary = this.file + '.' + randomUUID() + '.tmp';
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch { throw new ToolingError('PROJECT_BUSY', 'Another action holds the saved MCP connection lock. After an interrupted action, verify it has stopped before removing ' + lock + '.'); }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      const rows = change(await this.read());
      this.options.signal?.throwIfAborted();
      const serialized = JSON.stringify(rows, null, 2) + '\n';
      if (Buffer.byteLength(serialized) > 2_000_000) throw new ToolingError('PERSISTENCE_FAILED', 'The saved MCP connections exceed the client limit.');
      await fs.writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } catch (error) {
      if (error instanceof ToolingError) throw error;
      throw new ToolingError('PERSISTENCE_FAILED', 'The MCP connections could not be saved.');
    } finally {
      await fs.rm(temporary, { force: true });
      await handle.close(); await fs.unlink(lock);
    }
  }
  private async current(backend: string, releaseUid: string): Promise<Connection> {
    const row = await this.session.request<any>(backend, 'GET', '/api/v1/resource-releases/' + releaseUid + '/');
    const value = connection(backend, row);
    if (value.resource_release_uid !== releaseUid) throw new ToolingError('API_ERROR', 'The backend returned a different release.');
    return value;
  }
  private async open(value: Connection): Promise<McpTransport> {
    const grant = await this.session.request<any>(value.backend, 'GET',
      '/api/v1/resource-releases/' + value.resource_release_uid + '/exchange-launch/');
    if (grant?.mode !== 'token' || grant.release_kind !== 'fastapi' || typeof grant.token !== 'string' || !grant.token || /[\r\n]/.test(grant.token)) {
      throw new ToolingError('API_ERROR', 'The backend returned no usable FastAPI release credential.');
    }
    this.secrets.add(grant.token);
    if (new URL(endpoint(grant.rpc_url)).origin !== new URL(value.mcp_connection.url).origin) {
      throw new ToolingError('API_ERROR', 'The release credential targets a different endpoint.');
    }
    const client = new McpTransport(message => sendProjectMcp(value.mcp_connection.url, grant.token, message, this.options));
    await client.initialize();
    return client;
  }
  /** The release's name and repository from the release directory and its branch. Whatever
   * cannot be read is left out: labels never make a working MCP unavailable. */
  private async resolveLabels(value: Connection): Promise<Labels> {
    const found: Labels = {};
    const read = async <T>(apiPath: string): Promise<T | undefined> => {
      try { return await this.session.request<T>(value.backend, 'GET', apiPath, undefined, true); }
      catch { this.options.signal?.throwIfAborted(); return undefined; }
    };
    // The release detail carries no name or repository; the directory projection does.
    const page = await read<any>('/api/v1/resource-releases/?search=' + encodeURIComponent(value.resource_release_uid) + '&limit=100');
    const row = Array.isArray(page?.results) ? page.results.find((item: any) => typeof item?.uid === 'string' && item.uid.toLowerCase() === value.resource_release_uid) : undefined;
    if (row) Object.assign(found, labels({ name: row.name, code_repository_branch_uid: row.code_repository_branch_uid }));
    const branchUid = found.code_repository_branch_uid ?? value.code_repository_branch_uid;
    if (branchUid) {
      const branch = await read<unknown>('/api/v1/code-repository-branches/' + encodeURIComponent(branchUid) + '/');
      try {
        const parsed = codeRepositoryBranchFromResponse(branch, 'CodeRepositoryBranch response');
        if (parsed.uid.toLowerCase() === branchUid) Object.assign(found, labels({ display_name: parsed.code_repository_name, code_repository_branch_uid: branchUid }));
      } catch { /* an unreadable branch leaves the repository name out */ }
    }
    return found;
  }
  private labelled(value: Connection, found: Labels): Connection {
    return connection(value.backend, { ...value, ...found });
  }
  /** Records saved before labels were stored are completed once, when the backend answers. */
  private async backfill(rows: Connection[]): Promise<Connection[]> {
    const pending = rows.filter(row => !row.display_name);
    if (!pending.length) return rows;
    const found = new Map<string, Labels>();
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length) {
        const row = pending.shift()!;
        const resolved = await this.resolveLabels(row);
        const added = Object.entries(resolved).filter(([key, item]) => item !== row[key as keyof Labels]);
        if (added.length) found.set(row.backend + ' ' + row.resource_release_uid, Object.fromEntries(added));
      }
    }));
    if (!found.size) return rows;
    const key = (row: Connection) => row.backend + ' ' + row.resource_release_uid;
    const merge = (row: Connection) => found.has(key(row)) ? this.labelled(row, { ...found.get(key(row)) }) : row;
    try { await this.update(all => all.map(merge)); }
    catch (error) {
      // A held lock or a failed write keeps the listing itself available.
      if (error instanceof ToolingError && error.code === 'CANCELLED') throw error;
      this.options.signal?.throwIfAborted();
    }
    return rows.map(merge);
  }
  async dispatch(request: McpRequest, inputBackend: string): Promise<ActionResult> {
    let callStarted = false, resultData: unknown;
    try {
      const backend = requireBackend(inputBackend);
      this.options.signal?.throwIfAborted();
      const environmentUid = request.environmentUid === undefined ? undefined : uuid(request.environmentUid);
      const belongs = (value: Connection) => !environmentUid || value.mcp_connection.organization_environment_uid === environmentUid;
      const requireEnvironment = (value: Connection) => {
        if (!belongs(value)) throw new ToolingError('INVALID_REQUEST', 'This MCP belongs to a different organization environment. Select that environment first.');
      };
      let data: unknown, summary: string;
      if (request.action === 'mcp-environments') {
        const environments = new Map<string, { uid: string; name: string; isProduction: boolean }>();
        for (let offset = 0; ; offset += 100) {
          this.options.signal?.throwIfAborted();
          if (offset >= 10000) throw new ToolingError('API_ERROR', 'The environment list is too large.');
          const page = await this.session.request<any>(backend, 'GET', `/api/v1/organization-environments/?limit=100&offset=${offset}`);
          const items = Array.isArray(page) ? page : page?.results;
          if (!Array.isArray(items)) throw new ToolingError('API_ERROR', 'The backend returned an invalid environment list.');
          for (const row of items) {
            if (typeof row?.name !== 'string' || !row.name.trim()) throw new ToolingError('API_ERROR', 'An organization environment has no name.');
            const uid = uuid(row.uid);
            environments.set(uid, { uid, name: row.name.trim(), isProduction: row.is_production === true });
          }
          if (Array.isArray(page)) break;
          if (!Number.isInteger(page.count) || page.count < 0) throw new ToolingError('API_ERROR', 'The environment pagination is invalid.');
          if (offset + 100 >= page.count) break;
          if (!items.length) throw new ToolingError('API_ERROR', 'The environment directory changed; refresh it.');
        }
        data = [...environments.values()]; summary = 'Organization environments available to your MainSequence account.';
      } else if (request.action === 'mcp-discover') {
        if ((request.search !== undefined && typeof request.search !== 'string')
          || (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100))
          || (request.offset !== undefined && (!Number.isInteger(request.offset) || request.offset < 0))) {
          throw new ToolingError('INVALID_REQUEST', 'Discovery requires a text search, a limit from 1 to 100, and a nonnegative offset.');
        }
        const client = new McpTransport(message => this.session.request(backend, 'POST', '/mcp', message, true));
        await client.initialize();
        const query = async (offset: number, limit: number) => {
          const output = await client.request('tools/call', { name: 'resource_release.mcp_endpoints',
            arguments: { ...(request.search !== undefined ? { search: request.search } : {}), limit, offset } });
          if (output?.isError) throw new ToolingError('API_ERROR', 'Platform MCP could not list available project endpoints.');
          const page = output?.structuredContent;
          if (!Number.isInteger(page?.count) || page.count < 0 || !Array.isArray(page?.results)) throw new ToolingError('API_ERROR', 'Platform MCP returned an invalid directory.');
          return { count: page.count, results: page.results.map((row: unknown) => connection(backend, row)) as Connection[] };
        };
        if (!environmentUid) data = await query(request.offset ?? 0, request.limit ?? 100);
        else {
          // The existing platform MCP has no environment filter. Scan its pages
          // before paginating the matching releases; never show an incomplete page as complete.
          const matching = new Map<string, Connection>();
          for (let offset = 0; ; offset += 100) {
            this.options.signal?.throwIfAborted();
            if (offset >= 10000) throw new ToolingError('API_ERROR', 'MCP discovery is too large; narrow the search.');
            const page = await query(offset, 100);
            for (const value of page.results.filter(belongs)) matching.set(value.resource_release_uid, value);
            if (offset + 100 >= page.count) break;
          }
          const values = [...matching.values()], offset = request.offset ?? 0;
          data = { count: values.length, results: values.slice(offset, offset + (request.limit ?? 100)) };
        }
        summary = 'Available project MCP endpoints; discovery does not save a connection.';
      } else if (request.action === 'mcp-list') {
        data = await this.backfill((await this.read()).filter(row => row.backend === backend && belongs(row)));
        summary = 'Saved MCP connections for this backend. Availability is checked when used.';
      } else {
        const releaseUid = uuid(request.releaseUid);
        if (request.action === 'mcp-remove') {
          const saved = (await this.read()).find(row => row.backend === backend && row.resource_release_uid === releaseUid);
          if (saved) requireEnvironment(saved);
          await this.update(rows => rows.filter(row => !(row.backend === backend && row.resource_release_uid === releaseUid)));
          data = { resource_release_uid: releaseUid }; summary = 'The saved connection was removed.';
        } else {
          let value = await this.current(backend, releaseUid);
          requireEnvironment(value);
          if (request.action !== 'mcp-add') {
            const saved = (await this.read()).find(row => row.backend === backend && row.resource_release_uid === releaseUid);
            if (!saved) throw new ToolingError('INVALID_REQUEST', 'Add this MCP connection before using it.');
            if (saved.mcp_connection.url !== value.mcp_connection.url) throw new ToolingError('INVALID_REQUEST', 'The MCP endpoint changed. Add the release again to confirm its new endpoint.');
            value = this.labelled(value, labels(saved));
          }
          const client = await this.open(value);
          const tools = await client.tools();
          if (request.action === 'mcp-add') {
            value = this.labelled(value, await this.resolveLabels(value));
            await this.update(rows => [...rows.filter(row => !(row.backend === backend && row.resource_release_uid === releaseUid)), value]);
            data = { connection: value, tools }; summary = 'MCP connection verified and saved. Its tools can now be used through the plugin.';
          } else if (request.action === 'mcp-tools') {
            data = { connection: value, tools }; summary = 'Current tools from the selected MCP.';
          } else if (request.action === 'mcp-call') {
            if (typeof request.tool !== 'string' || !tools.some(tool => tool.name === request.tool)) throw new ToolingError('INVALID_REQUEST', 'The selected tool is absent from the current MCP catalog.');
            if (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) throw new ToolingError('INVALID_REQUEST', 'Tool arguments must be a JSON object.');
            this.options.signal?.throwIfAborted();
            callStarted = true;
            const output = await client.request('tools/call', { name: request.tool, arguments: request.arguments });
            if (!output || !Array.isArray(output.content)) throw new ToolingError('API_ERROR', 'The MCP tool returned an invalid result.');
            resultData = output;
            if (output.isError) throw new ToolingError('API_ERROR', 'The MCP tool reported an error. Inspect its result before retrying.');
            data = output; summary = 'The MCP tool completed.';
          } else throw new ToolingError('INVALID_REQUEST', 'Unknown MCP action.');
        }
      }
      return this.sanitize({ schemaVersion: 1, action: request.action, status: 'success', summary, data });
    } catch (error) {
      const failure = this.options.signal?.aborted ? new ToolingError('CANCELLED', 'The MCP action was cancelled.')
        : error instanceof ToolingError ? error : new ToolingError('INTERNAL_ERROR', 'The MCP action could not complete.');
      return this.sanitize({ schemaVersion: 1, action: request.action, status: failure.code === 'CANCELLED' ? 'cancelled' : 'failure',
        summary: failure.message, error: { code: failure.code, message: failure.message }, ...(resultData === undefined ? {} : { data: resultData }),
        ...(callStarted ? { effects: { state: 'partial-or-uncertain', message: 'The tool may have changed remote state. No automatic retry was attempted; verify the outcome before repeating it.' } } : {}) });
    } finally { this.secrets.clear(); }
  }
}
