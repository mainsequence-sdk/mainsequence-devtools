/** Opt-in, per-user HTTP owner for desktop hosts with one process per chat.
 * Credentials and cached responses stay in memory. The private Unix socket is
 * local IPC, not a new login, backend, public listener, or autonomous poller.
 */
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { readMcpResponse } from './mcpTransport';

const PROTOCOL = 2, MAX_BYTES = 8_000_000, MAX_FRAME = 12_000_000;
type WireRequest = { url: string; method: string; headers: [string, string][]; body?: string; read: boolean; fresh: boolean };
type WireResponse = { status: number; headers: [string, string][]; body: string };
export type SharedTransportStatus = { protocol: number; instanceId: string; pid: number; clients: number; requests: number; cacheHits: number; coalesced: number; active: number; connections: number; maxConnectionsPerOrigin: number };
export type SessionLock = <T>(backend: string, run: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
const unavailable = () => new Error('Shared MainSequence transport disconnected. No request was replayed. Read the saved operation receipt before recovery.');
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
function headerPairs(headers: Headers): [string, string][] { const pairs: [string, string][] = []; headers.forEach((value, key) => pairs.push([key, value])); return pairs; }
function privateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Shared transport requires a private directory owned by the current user.');
}
function frames(socket: net.Socket, receive: (message: any) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME) { socket.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { receive(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
}

/** All participating processes share one owner. No fallback creates a private pool. */
export function createSharedTransport(options: { directory?: string } = {}) {
  if (process.platform === 'win32') throw new Error('Shared MainSequence transport currently requires Unix-domain sockets.');
  const directory = options.directory ?? path.join(os.tmpdir(), `ms-http-v${PROTOCOL}-${process.getuid!()}-${hash(os.homedir()).slice(0, 12)}`);
  const socketPath = path.join(directory, 'transport.sock');
  // Capture the worker and its two internal dependencies now. Codex can remove
  // this installation while a chat is alive; a later reconnect still works.
  const modules = Object.fromEntries(['sharedTransport', 'mcpTransport', 'models'].map(name => [name, fs.readFileSync(path.join(__dirname, name + '.js'), 'utf8')]));
  const workerSource = `const sources=${JSON.stringify(modules)},cache={};function load(name){if(cache[name])return cache[name].exports;const m={exports:{}};cache[name]=m;const r=id=>id.startsWith('./')?load(id.slice(2).replace(/\\.js$/,'')):require(id);r.main=name==='sharedTransport'?m:null;new Function('require','module','exports','__filename','__dirname',sources[name])(r,m,m.exports,'sharedTransport.js','.');return m.exports;}process.argv=['node','worker','--shared-http-worker',${JSON.stringify(directory)}];load('sharedTransport');`;
  let socket: net.Socket | undefined, connecting: Promise<net.Socket> | undefined, closed = false;
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  async function connect(): Promise<net.Socket> {
    if (closed) throw unavailable();
    if (socket && !socket.destroyed) return socket;
    if (connecting) return connecting;
    connecting = (async () => {
      privateDirectory(directory);
      const attempt = () => new Promise<net.Socket>((resolve, reject) => {
        const next = net.createConnection(socketPath);
        next.once('error', reject);
        next.once('connect', () => { next.removeListener('error', reject); resolve(next); });
      });
      let next: net.Socket | undefined;
      try { next = await attempt(); } catch {
        // The worker takes an exclusive lock before listening; concurrent clients
        // may start contenders but only one can own the upstream connection pool.
        const worker = spawn(process.execPath, ['-'], { cwd: os.homedir(), detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: process.env.PATH, HOME: os.homedir() } });
        worker.stdin.on('error', () => {}); worker.stdin.end(workerSource);
        worker.on('error', () => {}); worker.unref();
        for (let n = 0; n < 100 && !next; n++) {
          await new Promise(resolve => setTimeout(resolve, 30));
          try { next = await attempt(); } catch { /* startup, not an HTTP replay */ }
        }
      }
      if (!next) throw unavailable();
      if (closed) { next.destroy(); throw unavailable(); }
      socket = next;
      next.on('error', () => {});
      next.on('close', () => { if (socket === next) socket = undefined; for (const task of pending.values()) task.reject(unavailable()); pending.clear(); });
      frames(next, message => {
        const task = pending.get(message.id); if (!task) return;
        pending.delete(message.id);
        if (!pending.size) next!.unref();
        if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
      });
      next.unref(); return next;
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  async function rpc(op: string, request?: WireRequest | { key: string; lease?: string }, signal?: AbortSignal | null): Promise<any> {
    signal?.throwIfAborted();
    const connection = await connect(); signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => { pending.delete(id); connection.write(JSON.stringify({ op: 'cancel', id }) + '\n'); if (!pending.size) connection.unref(); reject(signal?.reason ?? unavailable()); };
      pending.set(id, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value); }, reject: error => { signal?.removeEventListener('abort', abort); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      connection.ref(); connection.write(JSON.stringify({ id, op, request }) + '\n');
    });
  }
  const transport: typeof fetch = async (input, init = {}) => {
    if (input instanceof Request || (init.body !== undefined && init.body !== null && typeof init.body !== 'string')) throw new Error('Shared transport accepts URL requests with optional text bodies.');
    const request: WireRequest = { url: String(input), method: init.method ?? 'GET', headers: headerPairs(new Headers(init.headers)),
      ...(typeof init.body === 'string' ? { body: init.body } : {}), read: init.cache === 'force-cache', fresh: init.cache === 'reload' };
    const value: WireResponse = await rpc('fetch', request, init.signal);
    return new Response([204, 205, 304].includes(value.status) ? null : Buffer.from(value.body, 'base64'), { status: value.status, headers: value.headers });
  };
  const sessionLock: SessionLock = async (backend, run, signal) => {
    const key = hash(backend), lease = await rpc('acquire', { key }, signal);
    try { signal?.throwIfAborted(); return await run(); }
    finally { await rpc('release', { key, lease }).catch(() => {}); }
  };
  return { fetch: transport, sessionLock, status: (): Promise<SharedTransportStatus> => rpc('status'), invalidate: (): Promise<void> => rpc('invalidate'), close() { closed = true; socket?.destroy(); } };
}

function cacheTtl(request: WireRequest): number {
  const url = new URL(request.url);
  if (request.method === 'POST') return request.read ? 30_000 : 0;
  if (request.method !== 'GET') return 0;
  if (url.pathname === '/api/v1/users/me/') return 5_000;
  if (/^\/api\/v1\/command-center\/agents\/[a-f0-9-]+\/icon\/$/.test(url.pathname)) return 300_000;
  if (/^\/api\/v1\/(organization-environments|command-center\/agents|code-repositories|code-repository-branches|organization-projects)\//.test(url.pathname)) return 30_000;
  return 0;
}
function readKey(request: WireRequest): string {
  // IDs are transport correlation only; share reads and restore each caller's ID.
  let body = request.body;
  if (request.read && body) { const value = JSON.parse(body); delete value.id; body = JSON.stringify(value); }
  return hash(JSON.stringify([request.url, request.method, [...request.headers].sort(), body]));
}
function responseFor(value: WireResponse, request: WireRequest): WireResponse {
  if (!request.read || !request.body || value.status !== 200) return value;
  const body = JSON.parse(request.body);
  if (!Object.hasOwn(body, 'id')) return value;
  const response = JSON.parse(Buffer.from(value.body, 'base64').toString());
  return { ...value, body: Buffer.from(JSON.stringify({ ...response, id: body.id })).toString('base64') };
}

async function runWorker(directory: string) {
  privateDirectory(directory);
  const lock = path.join(directory, 'owner.json'), socketPath = path.join(directory, 'transport.sock');
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch {
    try { const owner = JSON.parse(fs.readFileSync(lock, 'utf8')); process.kill(owner.pid, 0); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      // Serialize stale recovery too; never unlink another contender's new lock.
      const recovery = path.join(directory, 'recover.lock');
      let fd: number; try { fd = fs.openSync(recovery, 'wx', 0o600); } catch { return; }
      try { const owner = JSON.parse(fs.readFileSync(lock, 'utf8')); try { process.kill(owner.pid, 0); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return; } fs.unlinkSync(lock); }
      finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
      return runWorker(directory);
    }
  }
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2, maxTotalSockets: 8, maxFreeSockets: 2 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2, maxTotalSockets: 8, maxFreeSockets: 2 });
  const sockets = new Set<net.Socket>(), cache = new Map<string, { value: WireResponse; until: number; epoch: number }>();
  type Job = { controller: AbortController; listeners: Map<string, { socket: net.Socket; id: string; request: WireRequest }>; promise: Promise<WireResponse> };
  const jobs = new Map<string, Job>(); let epoch = 0, requests = 0, cacheHits = 0, coalesced = 0, bytes = 0;
  const instanceId = randomUUID(), invalidate = () => { epoch++; cache.clear(); bytes = 0; };
  type Lease = { socket: net.Socket; id: string; token: string };
  const leases = new Map<string, Lease[]>();
  function grant(key: string) { const first = leases.get(key)?.[0]; if (first) send(first.socket, first.id, first.token); else leases.delete(key); }
  function releaseFor(socket: net.Socket, id?: string) {
    for (const [key, queue] of leases) {
      const first = queue[0]; const keep = queue.filter(lease => lease.socket !== socket || id && lease.id !== id);
      leases.set(key, keep); if (keep[0] !== first) grant(key);
    }
  }
  const upstream = async (request: WireRequest, signal: AbortSignal): Promise<WireResponse> => {
    requests++;
    const url = new URL(request.url);
    const response = await new Promise<Response>((resolve, reject) => {
      const call = (url.protocol === 'https:' ? https : http).request(url, { method: request.method, headers: Object.fromEntries(request.headers),
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent, signal, timeout: 300_000 }, result => {
        const headers = new Headers(); for (const [key, value] of Object.entries(result.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response([204, 205, 304].includes(result.statusCode!) ? null : Readable.toWeb(result) as ReadableStream, { status: result.statusCode, headers }));
        if ([204, 205, 304].includes(result.statusCode!)) result.resume();
      });
      call.on('timeout', () => call.destroy(new Error('HTTP timeout'))); call.on('error', reject); call.end(request.body);
    });
    const headers = headerPairs(response.headers);
    if (request.method === 'POST' && /json|event-stream/.test(response.headers.get('content-type') ?? '') && request.body && response.ok) {
      let message: any; try { message = JSON.parse(request.body); } catch { /* regular POST */ }
      if (message?.jsonrpc === '2.0') {
        const body = await readMcpResponse(response, message);
        return { status: response.status, headers: headers.filter(([key]) => !['content-type', 'content-length', 'content-encoding'].includes(key)).concat([['content-type', 'application/json']]), body: body === undefined ? '' : Buffer.from(JSON.stringify(body)).toString('base64') };
      }
    }
    const reader = response.body?.getReader(); let size = 0; const parts: Buffer[] = [];
    if (reader) try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > MAX_BYTES) throw new Error('Response size exceeded'); parts.push(Buffer.from(next.value)); } } finally { await reader.cancel().catch(() => {}); }
    return { status: response.status, headers, body: Buffer.concat(parts).toString('base64') };
  };
  function send(socket: net.Socket, id: string, result?: unknown, error?: string) { if (!socket.destroyed) socket.write(JSON.stringify({ id, ...(error ? { error } : { result }) }) + '\n'); }
  const server = net.createServer(socket => {
    sockets.add(socket); const identity = randomUUID();
    socket.on('error', () => {});
    const detach = (id?: string) => { for (const job of jobs.values()) { for (const [key, listener] of job.listeners) if (listener.socket === socket && (!id || listener.id === id)) job.listeners.delete(key); if (!job.listeners.size) job.controller.abort(); } };
    socket.on('close', () => { sockets.delete(socket); detach(); releaseFor(socket); });
    frames(socket, message => {
      const id = message.id;
      if (typeof id !== 'string' || id.length > 100) { socket.destroy(); return; }
      if (message.op === 'cancel') { detach(id); releaseFor(socket,id); return; }
      if (message.op === 'acquire' || message.op === 'release') {
        const key=message.request?.key;
        if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) { socket.destroy(); return; }
        const queue=leases.get(key)||[];
        if (message.op==='acquire') { if (queue.length>=256) {send(socket,id,undefined,'Too many pending session operations.');return;} queue.push({socket,id,token:randomUUID()});leases.set(key,queue);if(queue.length===1)grant(key); }
        else { if (queue[0]?.socket===socket && queue[0].token===message.request.lease) {queue.shift();grant(key);} send(socket,id); }
        return;
      }
      if (message.op === 'invalidate') { invalidate(); send(socket, id); return; }
      if (message.op === 'status') {
        const count = (agent: http.Agent) => [...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].reduce((sum, values) => sum + (values?.length || 0), 0);
        send(socket, id, { protocol: PROTOCOL, instanceId, pid: process.pid, clients: sockets.size, requests, cacheHits, coalesced, active: jobs.size, connections: count(httpAgent) + count(httpsAgent), maxConnectionsPerOrigin: 2 }); return;
      }
      if (message.op !== 'fetch' || jobs.size >= 256) { send(socket, id, undefined, 'Shared transport is busy or the operation is unsupported.'); return; }
      const request: WireRequest = message.request;
      let url: URL; try { url = new URL(request.url); } catch { socket.destroy(); return; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['GET', 'POST'].includes(request.method) || !Array.isArray(request.headers) || (request.body && Buffer.byteLength(request.body) > 1_000_000)) { socket.destroy(); return; }
      const renewal = request.method === 'POST' && url.pathname === '/auth/jwt-token/token/refresh/';
      const read = request.method === 'GET' || request.read || renewal, key = read ? readKey(request) : randomUUID();
      if (!read || request.fresh) invalidate();
      const flightKey = epoch + ':' + key;
      const found = cache.get(key);
      if (found && found.until > Date.now()) { cacheHits++; send(socket, id, responseFor(found.value, request)); return; }
      if (found) { bytes -= found.value.body.length; cache.delete(key); }
      let job = jobs.get(flightKey);
      if (job?.controller.signal.aborted) job = undefined;
      if (job) coalesced++;
      else {
        const controller = new AbortController(), startedEpoch = epoch;
        job = { controller, listeners: new Map(), promise: upstream(request, controller.signal) }; jobs.set(flightKey, job);
        const owned = job;
        void owned.promise.then(value => {
          if (!read || value.status === 401 || value.status === 403) invalidate();
          let ttl = cacheTtl(request);
          const auth = request.headers.find(([name]) => name === 'authorization')?.[1];
          try { const exp = JSON.parse(Buffer.from(auth!.split('.')[1], 'base64url').toString()).exp; if (typeof exp === 'number') ttl = Math.min(ttl, exp * 1000 - Date.now() - 5000); } catch { /* opaque token: bounded TTL */ }
          let success = value.status >= 200 && value.status < 300;
          if (request.read && value.body) { try { const result = JSON.parse(Buffer.from(value.body, 'base64').toString()); success = success && !result.error && !result.result?.isError; } catch { success = false; } }
          if (success && ttl > 0 && epoch === startedEpoch && !controller.signal.aborted) {
            while (cache.size >= 256 || bytes + value.body.length > 24_000_000) { const oldest = cache.keys().next().value; if (!oldest) break; bytes -= cache.get(oldest)!.value.body.length; cache.delete(oldest); }
            cache.set(key, { value, until: Date.now() + ttl, epoch }); bytes += value.body.length;
          }
          for (const listener of owned.listeners.values()) send(listener.socket, listener.id, responseFor(value, listener.request));
        }, () => { if (!read) invalidate(); for (const listener of owned.listeners.values()) send(listener.socket, listener.id, undefined, 'MainSequence HTTP request failed. It was not replayed.'); }).finally(() => { if (jobs.get(flightKey) === owned) jobs.delete(flightKey); });
      }
      job.listeners.set(identity + id, { socket, id, request });
    });
  });
  const cleanup = () => { for (const job of jobs.values()) job.controller.abort(); httpAgent.destroy(); httpsAgent.destroy(); server.close(); try { fs.unlinkSync(socketPath); fs.unlinkSync(lock); } catch { /* already cleaned */ } };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { cleanup(); process.exit(0); });
  try { fs.unlinkSync(socketPath); } catch { /* first launch */ }
  server.on('error', () => { cleanup(); process.exitCode = 1; });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  let idleSince = Date.now();
  setInterval(() => { if (sockets.size || jobs.size) idleSince = Date.now(); else if (Date.now() - idleSince > 30_000) { cleanup(); process.exit(0); } }, 1000).unref();
}
if (require.main === module && process.argv[2] === '--shared-http-worker') void runWorker(process.argv[3]).catch(() => { process.exitCode = 1; });
