// Extracted from ms-vscode-extension/src/api.ts and authSession.ts (0.1.45).
// Host-independent machine mode; the VS Code legacy fallback stays with that host.
import * as crypto from 'crypto';
import { readMcpResponse } from './mcpTransport';
import * as http from 'http';
import { normalizeBackendUrl } from './config';
import { clearSession, CredentialStore, ForeignEntryError, MachineSession, openCredentialStore, readSession, saveSession } from './machineSession';
import { HostServices, SessionService, SessionStatus, SessionPersistence, ToolingError } from './models';
import { validateExpectedAccount } from './accountScope';

class AccountChangedError extends ToolingError {
  constructor() { super('AUTH_REJECTED', 'The MainSequence account or session changed. Refresh the current view before continuing.'); }
}

export function requireBackend(input: string): string {
  const backend = normalizeBackendUrl(input);
  let url: URL;
  try { url = new URL(backend); } catch { throw new ToolingError('INVALID_REQUEST', 'An HTTP(S) backend URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\r\n]/.test(backend)) {
    throw new ToolingError('INVALID_REQUEST', 'The backend must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  // Keep the original normalized text: URL serialization would change the session account hash.
  return backend;
}
function expiry(access: string): string | undefined {
  try {
    const exp = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : undefined;
  } catch { return undefined; }
}
/** " on 2026-09-30 18:45 UTC" when the token carries an expiry that has passed. */
function expiredOn(token: string): string {
  const at = expiry(token);
  return at && Date.parse(at) <= Date.now() ? ` on ${at.slice(0, 16).replace('T', ' ')} UTC` : '';
}
/** Say which credentials the backend refused and how to repair them; no token value is included. */
function refusedCredentials(source: 'machine' | 'environment', backend: string, token: string): ToolingError {
  const when = expiredOn(token);
  if (source === 'environment') {
    return new ToolingError('AUTH_REJECTED',
      `The backend refused the credentials set in this process's environment (MAINSEQUENCE_ACCESS_TOKEN / MAINSEQUENCE_REFRESH_TOKEN) for ${backend}` +
      (when ? `: they expired${when}.` : '.') +
      ' They win over the saved session. Start the process without them to use the saved session, or sign in again and set a current pair.');
  }
  return new ToolingError('AUTH_REJECTED',
    `The backend refused the saved session for ${backend}` + (when ? `: it expired${when}.` : ': it was revoked or belongs to another backend.') +
    ' Sign in again.');
}
function tokenPair(data: any, previous?: MachineSession): MachineSession {
  const access = data?.access || data?.access_token || data?.token || data?.jwt;
  const refresh = data?.refresh || data?.refresh_token || previous?.refresh;
  const user = data?.user || data?.profile || data?.metadata?.user || data?.user_metadata || {};
  const username = data?.username || data?.user_name || user?.username || user?.user_name || previous?.username || '';
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
    throw new ToolingError('API_ERROR', 'The backend did not return a valid session pair.');
  }
  return { access, refresh, username: typeof username === 'string' ? username : '' };
}

export class MachineSessionService implements SessionService {
  private readonly store: CredentialStore | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly renewals = new Map<string, Promise<MachineSession>>();
  private readonly secrets = new Set<string>();
  private readonly verifiedAccounts = new Map<string, string>();
  constructor(private readonly host: HostServices, private readonly options: {
    store?: CredentialStore | null;
    persistence?: SessionPersistence;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    loginTimeoutMs?: number;
    requestTimeoutMs?: number;
  } = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.store = options.store === undefined ? openCredentialStore({ env: this.env }) : options.store;
    for (const [key, value] of Object.entries(this.env)) {
      if (value && /TOKEN|CREDENTIAL_SECRET/i.test(key)) this.secrets.add(value);
    }
  }
  /** Only for internal error/output sanitization; never a token transport. */
  sanitize(text: string): string {
    let output = text;
    for (const secret of this.secrets) {
      if (output === secret) return '[redacted]';
      if (secret.length >= 8) output = output.split(secret).join('[redacted]');
    }
    return output
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
      .replace(/([?&](?:access_token|refresh_token|token|credential_secret|client_secret)=)[^&#\s]+/gi, '$1[redacted]');
  }
  private remember(session: MachineSession): MachineSession {
    if (session.access) this.secrets.add(session.access);
    if (session.refresh) this.secrets.add(session.refresh);
    return session;
  }
  private requireStore(): CredentialStore {
    if (!this.store) throw new ToolingError('STORE_UNAVAILABLE', 'A machine credential store is required: macOS Keychain or Linux Secret Service with secret-tool.');
    return this.store;
  }
  private async saved(backend: string): Promise<MachineSession | null> {
    try {
      const value = this.options.persistence ? await this.options.persistence.read(backend) : readSession(this.requireStore(), backend);
      return value ? this.remember(value) : null;
    } catch (error) {
      if (error instanceof ToolingError) throw error;
      throw new ToolingError('STORE_ERROR', error instanceof ForeignEntryError
        ? 'The saved entry belongs to an older tool. Sign in to replace it.'
        : 'The machine session could not be read. Check that the credential store is unlocked and available.');
    }
  }
  private environment(backend: string): MachineSession | null {
    if (this.env.MAINSEQUENCE_RUNTIME_CREDENTIAL_ID || this.env.MAINSEQUENCE_RUNTIME_CREDENTIAL_SECRET) {
      throw new ToolingError('UNSUPPORTED_ACTION', 'Runtime credentials are not a developer session. Use a separate developer process.');
    }
    if (this.env.MAINSEQUENCE_TOKEN) throw new ToolingError('INVALID_REQUEST', 'MAINSEQUENCE_TOKEN is unsupported; use explicit MAINSEQUENCE_ACCESS_TOKEN and MAINSEQUENCE_ENDPOINT.');
    if (!this.env.MAINSEQUENCE_ACCESS_TOKEN && !this.env.MAINSEQUENCE_REFRESH_TOKEN) return null;
    if (!this.env.MAINSEQUENCE_ENDPOINT || requireBackend(this.env.MAINSEQUENCE_ENDPOINT) !== backend) {
      throw new ToolingError('BACKEND_MISMATCH', 'Process credentials must name the same backend with MAINSEQUENCE_ENDPOINT.');
    }
    return this.remember({ access: this.env.MAINSEQUENCE_ACCESS_TOKEN || '', refresh: this.env.MAINSEQUENCE_REFRESH_TOKEN || '', username: '' });
  }
  private async selected(backend: string): Promise<{ session: MachineSession; source: 'machine' | 'environment' }> {
    const explicit = this.environment(backend);
    if (explicit) return { session: explicit, source: 'environment' };
    const session = await this.saved(backend);
    if (!session) throw new ToolingError('NOT_AUTHENTICATED', 'No session is saved for this backend. Run login.');
    return { session, source: 'machine' };
  }
  private async http<T>(backend: string, method: string, apiPath: string, body?: unknown, access?: string, timeoutMs?: number): Promise<T> {
    this.options.signal?.throwIfAborted();
    if ((apiPath !== '/mcp' && !/^\/(api|auth)\//.test(apiPath)) || apiPath.includes('..')) throw new ToolingError('INVALID_REQUEST', 'Only existing /api/, /auth/, or central /mcp endpoints can be requested.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.options.requestTimeoutMs ?? timeoutMs ?? 30_000);
    try {
      const response = await (this.options.fetch ?? fetch)(backend + apiPath, {
        method, redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(apiPath === '/mcp' ? { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (response.status === 401 || response.status === 403) throw new ToolingError('AUTH_REJECTED', 'The backend rejected the selected credentials.');
      if (!response.ok) throw new ToolingError('API_ERROR', `The backend returned HTTP ${response.status}.`);
      if (apiPath === '/mcp') return await readMcpResponse(response, body as Record<string, unknown>) as T;
      if (response.status === 204) return undefined as T;
      try { return await response.json() as T; } catch { throw new ToolingError('API_ERROR', 'The backend returned an invalid JSON response.'); }
    } catch (error) {
      if (this.options.signal?.aborted) throw new ToolingError('CANCELLED', 'The action was cancelled.');
      if (error instanceof ToolingError) throw error;
      throw new ToolingError('BACKEND_UNREACHABLE', 'The backend could not be reached. The saved session has been kept.');
    } finally {
      clearTimeout(timer);
      this.options.signal?.removeEventListener('abort', abort);
    }
  }
  private renew(backend: string, expectedAccount?: string): Promise<MachineSession> {
    const renewalKey = JSON.stringify([backend, expectedAccount]);
    const running = this.renewals.get(renewalKey);
    if (running) return running;
    const task = (async () => {
      // Bypass cached state: another SDK process may have rotated the refresh token.
      const previous = await this.saved(backend);
      if (!previous?.refresh) throw new ToolingError('NOT_AUTHENTICATED', 'No refreshable machine session is saved for this backend.');
      if (expectedAccount !== undefined && previous.username && previous.username !== expectedAccount) throw this.accountChanged();
      let data: unknown;
      try { data = await this.http(backend, 'POST', '/auth/jwt-token/token/refresh/', { refresh: previous.refresh }); }
      catch (error) {
        if (error instanceof ToolingError && error.code === 'AUTH_REJECTED') throw refusedCredentials('machine', backend, previous.refresh);
        throw error;
      }
      const session = this.remember(tokenPair(data, previous));
      if (expectedAccount !== undefined) {
        const current = await this.saved(backend);
        if (!current || current.access !== previous.access || current.refresh !== previous.refresh) throw this.accountChanged();
      }
      // Refresh may rotate the old token. Keep the new pair even if the subsequent
      // profile check is unavailable; no domain request runs before that check passes.
      await this.persist(backend, session);
      if (expectedAccount !== undefined) await this.verifyAccount(backend, session, expectedAccount);
      return session;
    })();
    this.renewals.set(renewalKey, task);
    void task.finally(() => this.renewals.delete(renewalKey)).catch(() => {});
    return task;
  }
  private async persist(backend: string, session: MachineSession): Promise<void> {
    try {
      if (this.options.persistence) await this.options.persistence.write(backend, session);
      else saveSession(this.requireStore(), backend, session);
      const saved = await this.saved(backend);
      if (!saved || saved.access !== session.access || saved.refresh !== session.refresh) throw new Error('verification failed');
    } catch {
      throw new ToolingError('PERSISTENCE_FAILED', 'Authorization completed but the machine session could not be saved and verified.');
    }
  }
  async status(input: string, check = false): Promise<SessionStatus> {
    const backend = requireBackend(input);
    const explicit = this.environment(backend);
    let session = explicit || ((this.store || this.options.persistence) ? await this.saved(backend) : null);
    const source = explicit ? 'environment' : session ? (this.options.persistence?.mode ?? 'machine') : 'none';
    let expiresAt = expiry(session?.access || '');
    let authenticated = Boolean(session?.access && (!expiresAt || Date.parse(expiresAt) > Date.now()) || (!explicit && session?.refresh));
    if (check) {
      if (!authenticated) throw new ToolingError('NOT_AUTHENTICATED', 'No usable session is selected for this backend.');
      if (authenticated) {
        const profile = await this.request<any>(backend, 'GET', '/api/v1/users/me/');
        const username = profile?.user?.username || profile?.username;
        if (typeof username === 'string') session = { ...session!, username };
        authenticated = true;
        expiresAt = expiry((explicit || await this.saved(backend))?.access || '');
      }
    }
    return {
      backend, authenticated, source,
      persistence: explicit ? 'environment' : this.options.persistence?.mode ?? (this.store ? 'machine' : 'unavailable'),
      store: this.options.persistence?.name ?? this.store?.name ?? null,
      ...(session?.username ? { username: session.username } : {}),
      ...(expiresAt ? { expiresAt } : {}), ...(check ? { checked: true } : {})
    };
  }
  async request<T>(input: string, method: 'GET' | 'POST', apiPath: string, body?: unknown, retrySafe = method === 'GET', options?: { timeoutMs?: number }): Promise<T> {
    return this.accountRequest(input, method, apiPath, body, retrySafe, options);
  }
  private accountChanged(): ToolingError {
    return new AccountChangedError();
  }
  private recordAccount(backend: string, session: MachineSession, profile: any, expectedAccount: string): void {
    const username = profile?.user?.username || profile?.username;
    if (username !== expectedAccount) {
      this.verifiedAccounts.delete(JSON.stringify([backend, session.access]));
      throw this.accountChanged();
    }
    if (this.verifiedAccounts.size >= 32) this.verifiedAccounts.delete(this.verifiedAccounts.keys().next().value!);
    this.verifiedAccounts.set(JSON.stringify([backend, session.access]), username);
  }
  private async verifyAccount(backend: string, session: MachineSession, expectedAccount: string): Promise<void> {
    if (this.verifiedAccounts.get(JSON.stringify([backend, session.access])) === expectedAccount) return;
    this.recordAccount(backend, session, await this.http(backend, 'GET', '/api/v1/users/me/', undefined, session.access), expectedAccount);
  }
  /** The same selected credential is verified and used. A 401 retry must verify its new credential too. */
  async withAccount(input: string, expectedAccount: string): Promise<SessionService & { sanitize(text: string): string }> {
    const backend = requireBackend(input);
    validateExpectedAccount(expectedAccount);
    const target = (value: string) => { if (requireBackend(value) !== backend) throw new ToolingError('BACKEND_MISMATCH', 'The request belongs to another backend.'); };
    const unsupported = async (): Promise<never> => { throw new ToolingError('UNSUPPORTED_ACTION', 'Account-bound operations cannot change authentication.'); };
    const scoped: SessionService & { sanitize(text: string): string } = {
      request: (value, method, apiPath, body, retrySafe = method === 'GET', options) => {
        target(value); return this.accountRequest(backend, method, apiPath, body, retrySafe, options, expectedAccount);
      },
      status: async value => {
        target(value);
        await this.accountRequest(backend, 'GET', '/api/v1/users/me/', undefined, true, undefined, expectedAccount);
        const current = await this.selected(backend);
        await this.verifyAccount(backend, current.session, expectedAccount);
        const status = await this.status(backend);
        if (!status.authenticated) throw this.accountChanged();
        return { ...status, username: expectedAccount, checked: true };
      },
      login: unsupported, logout: unsupported, refresh: unsupported,
      sanitize: text => this.sanitize(text),
    };
    await scoped.status(backend, true);
    return scoped;
  }
  private async accountRequest<T>(input: string, method: 'GET' | 'POST', apiPath: string, body: unknown, retrySafe: boolean, options?: { timeoutMs?: number }, expectedAccount?: string): Promise<T> {
    if (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 300000)) throw new ToolingError('INVALID_REQUEST', 'Request timeout must be between 1 and 300000 milliseconds.');
    const backend = requireBackend(input);
    let { session, source } = await this.selected(backend);
    if (!session.access || (expiry(session.access) && Date.parse(expiry(session.access)!) <= Date.now() + 30_000)) {
      if (source === 'machine') session = await this.renew(backend, expectedAccount);
      else if (!session.access) throw new ToolingError('NOT_AUTHENTICATED', 'The explicit environment has no access token.');
    }
    const send = async (selected: MachineSession): Promise<T> => {
      const checkSelected = async () => {
        if (expectedAccount === undefined) return;
        const current = await this.selected(backend);
        if (current.source !== source || current.session.access !== selected.access || current.session.refresh !== selected.refresh) throw this.accountChanged();
      };
      if (expectedAccount !== undefined && apiPath !== '/api/v1/users/me/') await this.verifyAccount(backend, selected, expectedAccount);
      await checkSelected();
      const value = await this.http<T>(backend, method, apiPath, body, selected.access, options?.timeoutMs);
      if (expectedAccount !== undefined && apiPath === '/api/v1/users/me/') this.recordAccount(backend, selected, value, expectedAccount);
      await checkSelected();
      return value;
    };
    try { return await send(session); }
    catch (error) {
      if (!(error instanceof ToolingError) || error.code !== 'AUTH_REJECTED') throw error;
      // Scope failures are not expired-token failures and must never trigger a replay.
      if (error instanceof AccountChangedError) throw error;
      if (source === 'environment') throw refusedCredentials('environment', backend, session.access);
      if (!retrySafe) throw error;
      const latest = await this.saved(backend);
      const retry = latest?.access && latest.access !== session.access ? latest : await this.renew(backend, expectedAccount);
      try { return await send(retry); }
      catch (retryError) {
        if (retryError instanceof AccountChangedError) throw retryError;
        if (retryError instanceof ToolingError && retryError.code === 'AUTH_REJECTED') throw refusedCredentials('machine', backend, retry.refresh || retry.access);
        throw retryError;
      }
    }
  }
  async refresh(input: string): Promise<SessionStatus> {
    const backend = requireBackend(input);
    await this.renew(backend); // Explicitly renew the saved machine pair, not a user process override.
    return this.machineStatus(backend);
  }
  private async machineStatus(backend: string): Promise<SessionStatus> {
    const session = await this.saved(backend);
    return { backend, authenticated: Boolean(session?.access || session?.refresh), source: session ? (this.options.persistence?.mode ?? 'machine') : 'none', persistence: this.options.persistence?.mode ?? 'machine', store: this.options.persistence?.name ?? this.store?.name ?? null, username: session?.username, expiresAt: expiry(session?.access || '') };
  }
  async logout(input: string): Promise<{ revoked: boolean }> {
    const backend = requireBackend(input);
    const session = await this.saved(backend);
    let revoked = false;
    try {
      if (session?.refresh) { await this.http(backend, 'POST', '/auth/cli/revoke/', { refresh: session.refresh }); revoked = true; }
    } catch { /* local logout is still useful offline; report revocation separately */ }
    if (this.options.signal?.aborted) throw new ToolingError('CANCELLED', 'The action was cancelled.');
    try { if (this.options.persistence) await this.options.persistence.remove(backend); else clearSession(this.requireStore(), backend); }
    catch { throw new ToolingError('STORE_ERROR', 'The machine session could not be removed.'); }
    return { revoked };
  }
  async login(input: string): Promise<SessionStatus> {
    const backend = requireBackend(input);
    if (!this.options.persistence) this.requireStore();
    // Probe before opening the browser. An old marked entry can be replaced by explicit login.
    try { await this.saved(backend); }
    catch (error) { if (!(error instanceof ForeignEntryError) && !(error instanceof ToolingError && error.code === 'STORE_ERROR' && error.message.includes('older tool'))) throw new ToolingError('STORE_ERROR', 'The credential store is unavailable. Unlock it before signing in.'); }
    this.options.signal?.throwIfAborted();
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(64).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let resolveCallback!: (code: string) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<string>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    void callback.catch(() => {});
    let completed = false;
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (parsed.pathname !== '/callback') { res.writeHead(404).end('Not found'); return; }
      if (parsed.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid authorization state'); return; }
      if (completed) { res.writeHead(409).end('Callback already handled'); return; }
      completed = true;
      const code = parsed.searchParams.get('code');
      if (!code || parsed.searchParams.has('error')) {
        rejectCallback(new ToolingError('INVALID_CALLBACK', 'Browser authorization did not return an authorization code.'));
        res.writeHead(400).end('MainSequence authorization failed. Return to your developer tool.');
      } else {
        resolveCallback(code);
        res.end('MainSequence authorization received. Return to your developer tool to check that it was saved.');
      }
    });
    const abort = () => rejectCallback(new ToolingError('CANCELLED', 'Login was cancelled.'));
    this.options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => rejectCallback(new ToolingError('LOGIN_TIMEOUT', 'Timed out waiting for browser authorization.')), this.options.loginTimeoutMs ?? 300_000);
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new ToolingError('BROWSER_FAILED', 'Could not start the loopback callback.');
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const params = new URLSearchParams({ client_id: 'mainsequence-cli', response_type: 'code', state, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
      let opened = false;
      try { opened = await this.host.openBrowser(`${backend}/auth/cli/authorize/?${params}`); } catch { /* safe error below */ }
      if (!opened) throw new ToolingError('BROWSER_FAILED', 'Could not open the browser. Check your desktop browser configuration.');
      const code = await callback;
      const session = this.remember(tokenPair(await this.http(backend, 'POST', '/auth/cli/token/', { client_id: 'mainsequence-cli', code, code_verifier: verifier, redirect_uri: redirectUri })));
      await this.persist(backend, session);
      if (!session.username) {
        try {
          const profile = await this.request<any>(backend, 'GET', '/api/v1/users/me/');
          const username = profile?.user?.username || profile?.username;
          const latest = await this.saved(backend);
          if (typeof username === 'string' && username.trim() && latest) await this.persist(backend, { ...latest, username: username.trim() });
        } catch { /* Profile is best-effort; the authorization pair is already durable. */ }
      }
      this.options.signal?.throwIfAborted();
      return this.machineStatus(backend);
    } finally {
      clearTimeout(timer);
      this.options.signal?.removeEventListener('abort', abort);
      server.closeAllConnections();
      await new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); });
    }
  }
}

export function createSessionService(host: HostServices, options: ConstructorParameters<typeof MachineSessionService>[1] = {}) {
  return new MachineSessionService(host, options);
}
