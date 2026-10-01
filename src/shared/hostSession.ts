import * as crypto from 'crypto';
import * as fs from 'fs';
import { normalizeBackendUrl } from './config';
import { clearSession, CredentialStore, ForeignEntryError, readSession, saveSession } from './machineSession';
import type { SessionPersistence } from './models';

/** Opt-in host compatibility policy; Codex does not supply SecretStorage or token projection. */
export interface HostSessionPolicy {
  backend?(): string;
  readLegacyTokens?(): unknown;
  deleteLegacyTokens?(): boolean;
  setTokenProjection?(enabled: boolean): void;
  writeProjection?(root: string, access: string, refresh: string, backend: string): void;
  removeProjection?(root: string): void;
}
const SECRET_PREFIX = 'mainsequence.vscode.auth.v1';
const PROJECTIONS_KEY = 'mainsequence.auth.environmentProjections.v1';
const MACHINE_SESSION_AUTH_MODE = 'cli_browser';
// How long a session read from the machine's store is reused before the store is read again.
// Reading runs a program of the system, and the panel asks for the session many times in a row.
const MACHINE_SESSION_REUSE_MS = 5000;

export type AuthTokens = {
  username: string;
  access: string;
  refresh: string;
  authMode: string;
};

export type RefreshedTokens = {
  access: string;
  refresh?: string;
};

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: any): PromiseLike<void>;
}

type EnvironmentProjection = {
  repositoryPath: string;
  backend: string;
};

/**
 * The signed-in session of each backend.
 *
 * With a credential store of the operating system (`machineStore`), the session is the machine
 * session the Main Sequence CLIs read and write: a login here serves them, and a login with a CLI
 * serves the extension. Repository `.env` files then name the backend and hold no token. Without
 * such a store the session stays in VS Code SecretStorage and its tokens are written to the
 * registered repositories' `.env`, as before.
 */
export class HostAuthSession {
  private readonly refreshes = new Map<string, Promise<AuthTokens>>();
  private readonly machineReads = new Map<string, { tokens: AuthTokens; until: number }>();
  private machineStore: CredentialStore | null;

  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly state: MementoLike,
    machineStore: CredentialStore | null = null,
    private readonly now: () => number = Date.now,
    private readonly policy: HostSessionPolicy = {}
  ) {
    this.machineStore = machineStore;
  }

  /** Private host bridge. Never place these credentials in UI state, logs or action results. */
  persistence(): SessionPersistence {
    const owner = this;
    return {
      get name() { return owner.machineStore?.name ?? 'VS Code SecretStorage'; },
      get mode() { return owner.usesMachineSession() ? 'machine' as const : 'host' as const; },
      async read(backend) { const value = await owner.get(backend, true); return value.access || value.refresh ? value : null; },
      async write(backend, value) { await owner.save(value, backend); },
      async remove(backend) { await owner.clear(backend); }
    };
  }

  /** Whether the session lives in the machine's credential store, shared with the CLIs. */
  usesMachineSession(): boolean {
    return this.machineStore !== null;
  }

  async initialize(): Promise<void> {
    const backend = (this.policy.backend?.() ?? process.env.MAINSEQUENCE_ENDPOINT ?? 'https://api.main-sequence.app');
    this.checkMachineStore(backend);
    this.policy.setTokenProjection?.(!this.machineStore);
    if (this.machineStore) {
      // Moves a session this extension saved before it used the machine's store.
      await this.get(backend);
      await this.removeProjectedTokens();
    }

    const legacy = normalizeTokens((this.policy.readLegacyTokens?.() ?? {}));
    if (!legacy.access || !legacy.refresh) return;
    const existing = await this.get(backend);
    if (!existing.access || !existing.refresh) await this.save(legacy, backend);
    if (!(this.policy.deleteLegacyTokens?.() ?? true)) throw new Error('Could not remove the legacy plaintext token store.');
  }

  async get(backend: string = (this.policy.backend?.() ?? process.env.MAINSEQUENCE_ENDPOINT ?? 'https://api.main-sequence.app'), fresh = false): Promise<AuthTokens> {
    if (!this.machineStore) return this.storedInSecrets(backend);
    const normalizedBackend = normalizeRequiredBackend(backend);
    const reused = this.machineReads.get(normalizedBackend);
    if (!fresh && reused && reused.until > this.now()) return reused.tokens;
    return this.readMachineSession(normalizedBackend);
  }

  async save(tokens: Partial<AuthTokens>, backend: string = (this.policy.backend?.() ?? process.env.MAINSEQUENCE_ENDPOINT ?? 'https://api.main-sequence.app')): Promise<AuthTokens> {
    const normalizedBackend = normalizeRequiredBackend(backend);
    const normalized = normalizeTokens(tokens);
    if (!normalized.access || !normalized.refresh) {
      throw new Error('Both access and refresh tokens are required.');
    }
    if (this.machineStore) {
      saveSession(this.machineStore, normalizedBackend, normalized);
      await this.secrets.delete(authSecretKey(normalizedBackend));
      return this.remember(normalizedBackend, { ...normalized, authMode: MACHINE_SESSION_AUTH_MODE });
    }
    await this.secrets.store(authSecretKey(normalizedBackend), JSON.stringify(normalized));
    await this.synchronizeProjections(normalizedBackend, normalized);
    return normalized;
  }

  async refresh(
    exchange: (refreshToken: string) => Promise<RefreshedTokens>,
    backend: string = (this.policy.backend?.() ?? process.env.MAINSEQUENCE_ENDPOINT ?? 'https://api.main-sequence.app')
  ): Promise<AuthTokens> {
    const normalizedBackend = normalizeRequiredBackend(backend);
    const key = authSecretKey(normalizedBackend);
    const active = this.refreshes.get(key);
    if (active) return active;

    const operation = (async () => {
      // Read from the store itself: a CLI may have renewed or replaced the session meanwhile.
      const current = this.machineStore
        ? await this.readMachineSession(normalizedBackend)
        : await this.get(normalizedBackend);
      if (!current.refresh) throw new Error('Not logged in.');
      const refreshed = await exchange(current.refresh);
      const access = String(refreshed.access || '').trim();
      if (!access) throw new Error('Refresh succeeded but no access token was returned.');
      return this.save({
        ...current,
        access,
        refresh: String(refreshed.refresh || '').trim() || current.refresh
      }, normalizedBackend);
    })();
    this.refreshes.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.refreshes.get(key) === operation) this.refreshes.delete(key);
    }
  }

  async environment(backend: string = (this.policy.backend?.() ?? process.env.MAINSEQUENCE_ENDPOINT ?? 'https://api.main-sequence.app')): Promise<Record<string, string>> {
    const normalizedBackend = normalizeRequiredBackend(backend);
    const tokens = await this.get(normalizedBackend);
    if (!tokens.access || !tokens.refresh) throw new Error('Sign in before running this operation.');
    return {
      MAINSEQUENCE_ENDPOINT: normalizedBackend,
      MAINSEQUENCE_ACCESS_TOKEN: tokens.access,
      MAINSEQUENCE_REFRESH_TOKEN: tokens.refresh
    };
  }

  async registerProjection(repositoryPath: string, backend: string = (this.policy.backend?.() ?? process.env.MAINSEQUENCE_ENDPOINT ?? 'https://api.main-sequence.app')): Promise<void> {
    const normalizedBackend = normalizeRequiredBackend(backend);
    const projections = this.projections().filter(item => item.repositoryPath !== repositoryPath);
    projections.push({ repositoryPath, backend: normalizedBackend });
    await this.state.update(PROJECTIONS_KEY, projections);
  }

  async clear(backend: string = (this.policy.backend?.() ?? process.env.MAINSEQUENCE_ENDPOINT ?? 'https://api.main-sequence.app')): Promise<void> {
    const normalizedBackend = normalizeRequiredBackend(backend);
    await this.secrets.delete(authSecretKey(normalizedBackend));
    if (this.machineStore) {
      this.machineReads.delete(normalizedBackend);
      // Removes an entry it cannot read as well: deleting needs no consent.
      clearSession(this.machineStore, normalizedBackend);
    }
    const retained: EnvironmentProjection[] = [];
    for (const projection of this.projections()) {
      if (projection.backend !== normalizedBackend) {
        retained.push(projection);
        continue;
      }
      try {
        // A repository keeps naming its backend when the session lives in the machine's store.
        if (this.machineStore) this.policy.writeProjection?.(projection.repositoryPath, '', '', normalizedBackend);
        else this.policy.removeProjection?.(projection.repositoryPath);
      } catch {
        retained.push(projection);
      }
    }
    await this.state.update(PROJECTIONS_KEY, retained);
    clearCanonicalProcessEnvironment(normalizedBackend);
    if (!(this.policy.deleteLegacyTokens?.() ?? true)) throw new Error('Could not remove the legacy plaintext token store.');
  }

  /** A machine store that cannot be reached at all is not used: the extension works as before. */
  private checkMachineStore(backend: string): void {
    if (!this.machineStore) return;
    try {
      readSession(this.machineStore, backend);
    } catch (error) {
      // An entry another program wrote is replaced by the next login; the store itself works.
      if (!(error instanceof ForeignEntryError)) this.machineStore = null;
    }
  }

  private async storedInSecrets(backend: string): Promise<AuthTokens> {
    const raw = await this.secrets.get(authSecretKey(backend));
    if (!raw) return emptyTokens();
    try {
      return normalizeTokens(JSON.parse(raw));
    } catch {
      return emptyTokens();
    }
  }

  private remember(backend: string, tokens: AuthTokens): AuthTokens {
    this.machineReads.set(backend, { tokens, until: this.now() + MACHINE_SESSION_REUSE_MS });
    return tokens;
  }

  private async readMachineSession(backend: string): Promise<AuthTokens> {
    const store = this.machineStore as CredentialStore;
    try {
      const session = readSession(store, backend);
      if (session) return this.remember(backend, { ...session, authMode: MACHINE_SESSION_AUTH_MODE });
    } catch {
      // Unreadable is not signed in: a login replaces the entry.
    }
    // A session this extension saved before it used the machine's store moves there once.
    const earlier = await this.storedInSecrets(backend);
    if (earlier.access && earlier.refresh) {
      try {
        saveSession(store, backend, earlier);
        await this.secrets.delete(authSecretKey(backend));
        return this.remember(backend, { ...earlier, authMode: MACHINE_SESSION_AUTH_MODE });
      } catch {
        return earlier;
      }
    }
    return this.remember(backend, emptyTokens());
  }

  /** Once: repositories this extension wrote tokens into keep the backend and lose the tokens. */
  private async removeProjectedTokens(): Promise<void> {
    const retained: EnvironmentProjection[] = [];
    for (const projection of this.projections()) {
      // A repository that was deleted has nothing left to clean.
      if (!fs.existsSync(projection.repositoryPath)) continue;
      try {
        this.policy.writeProjection?.(projection.repositoryPath, '', '', projection.backend);
      } catch {
        retained.push(projection);
      }
    }
    await this.state.update(PROJECTIONS_KEY, retained);
  }

  private projections(): EnvironmentProjection[] {
    const value = this.state.get<EnvironmentProjection[]>(PROJECTIONS_KEY, []);
    if (!Array.isArray(value)) return [];
    return value.filter(item => Boolean(item?.repositoryPath && item?.backend));
  }

  private async synchronizeProjections(backend: string, tokens: AuthTokens): Promise<void> {
    for (const projection of this.projections()) {
      if (projection.backend !== backend) continue;
      try {
        this.policy.writeProjection?.(
          projection.repositoryPath,
          tokens.access,
          tokens.refresh,
          backend
        );
      } catch {
        // A missing or read-only checkout must not invalidate the authenticated session.
      }
    }
  }
}

export function authSecretKey(backend: string): string {
  const normalized = normalizeRequiredBackend(backend);
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  return `${SECRET_PREFIX}.${digest}`;
}

function normalizeRequiredBackend(backend: string): string {
  const normalized = normalizeBackendUrl(backend);
  if (!normalized) throw new Error('MainSequence backend URL is required.');
  return normalized;
}

function normalizeTokens(value: any): AuthTokens {
  return {
    username: String(value?.username || ''),
    access: String(value?.access || ''),
    refresh: String(value?.refresh || ''),
    authMode: String(value?.authMode || value?.auth_mode || 'cli_browser')
  };
}

function emptyTokens(): AuthTokens {
  return { username: '', access: '', refresh: '', authMode: 'cli_browser' };
}

function clearCanonicalProcessEnvironment(backend: string): void {
  if (normalizeBackendUrl(process.env.MAINSEQUENCE_ENDPOINT) === backend) {
    delete process.env.MAINSEQUENCE_ENDPOINT;
    delete process.env.MAINSEQUENCE_ACCESS_TOKEN;
    delete process.env.MAINSEQUENCE_REFRESH_TOKEN;
  }
}
