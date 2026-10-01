/**
 * The developer's Main Sequence session on this machine.
 *
 * One session per backend lives in the operating system credential store. The Main Sequence Python
 * CLI and the Command Center SDK CLI read and write the same record, so a login made here, or with
 * either CLI, serves all three. The record and the way each store is reached must stay equal to
 * theirs.
 */

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeBackendUrl } from './config';

export const SESSION_SERVICE = 'MainSequenceCLI.auth';
const SESSION_RECORD_VERSION = 1;
// Old versions of the Python CLI wrote one account for every backend.
const UNSCOPED_ACCOUNT = 'default';

const SECURITY_PROGRAM = '/usr/bin/security';
const SECURITY_ITEM_NOT_FOUND = 44;
const STORE_TIMEOUT_MS = 10_000;
// `security -i` reads one command per line into a 4,096-character buffer and cuts a longer line:
// the first part runs with a truncated secret and the rest runs as another command.
const SECURITY_STDIN_LINE_LIMIT = 4000;
const SAFE_ENTRY_NAME = /^[A-Za-z0-9._@-]+$/;
// The comment attribute of every Keychain entry the Main Sequence tools write. Attributes are
// readable without consent, the secret is not: the mark tells, before the secret is asked for, that
// `security` wrote the entry and may read it without a dialog.
const SECURITY_ENTRY_MARK = 'MainSequenceCLI.session.v1';
const SECURITY_COMMENT_ATTRIBUTE = /^\s*"icmt"<blob>="([^"]*)"\s*$/m;
// The Python CLI keeps its Secret Service item under this attribute and replaces only an item
// that carries it. Writing the same attributes makes every tool replace one item in place.
const SECRET_SERVICE_APPLICATION = 'Python keyring library';

/** The credential store exists and could not be read or written. */
export class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

/** The entry was written by a program this one may not ask for it without a consent dialog. */
export class ForeignEntryError extends CredentialStoreError {
  constructor() {
    super(
      'The Keychain entry was written by another version of the Main Sequence tools. Asking for it would show a consent dialog in every process, so it is not read.'
    );
    this.name = 'ForeignEntryError';
  }
}

/** One named credential store of the operating system. */
export interface CredentialStore {
  readonly name: string;
  read(service: string, account: string): string | null;
  write(service: string, account: string, secret: string): void;
  remove(service: string, account: string): boolean;
}

export type MachineSession = {
  username: string;
  access: string;
  refresh: string;
};

type ProgramResult = { status: number | null; stdout: string; stderr: string; error?: Error & { code?: string } };
export type ProgramRunner = (
  program: string,
  args: string[],
  options: { input?: string; encoding: 'utf8'; timeout: number; windowsHide: boolean }
) => ProgramResult;

function runProgram(run: ProgramRunner, program: string, args: string[], input?: string): ProgramResult {
  const result = run(program, args, {
    input: input ?? '',
    encoding: 'utf8',
    timeout: STORE_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.error) {
    throw new CredentialStoreError(
      result.error.code === 'ETIMEDOUT'
        ? `The credential store did not answer within ${STORE_TIMEOUT_MS / 1000} seconds. It was waiting for the user: the entry belongs to another program, or the store is locked.`
        : `The credential store program could not be run (${result.error.code || result.error.name}).`
    );
  }
  return result;
}

function decodeSecuritySecret(output: string): string {
  // `security -w` prints printable ASCII as it is and anything else as hexadecimal. The record is
  // JSON, so a value made only of hexadecimal digits is the second form.
  const value = output.endsWith('\n') ? output.slice(0, -1) : output;
  if (value && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)) {
    const decoded = Buffer.from(value, 'hex').toString('utf8');
    if (!decoded.includes('�')) return decoded;
  }
  return value;
}

/**
 * The login Keychain through Apple's `security` program, which is one program for every runtime.
 *
 * Asking `security` for the secret of an entry that another program wrote shows a consent dialog,
 * in every process that starts. The secret is therefore asked for only when the entry carries the
 * tools' mark. Any other entry is left alone until a login replaces it.
 */
function createMacOsKeychain(run: ProgramRunner): CredentialStore {
  const readable = new Set<string>();
  const key = (service: string, account: string) => `${service}\n${account}`;

  function remove(service: string, account: string): boolean {
    const result = runProgram(run, SECURITY_PROGRAM, ['delete-generic-password', '-s', service, '-a', account]);
    readable.delete(key(service, account));
    if (result.status === SECURITY_ITEM_NOT_FOUND) return false;
    if (result.status !== 0) {
      throw new CredentialStoreError(`The Keychain entry could not be deleted (security exit ${result.status}).`);
    }
    return true;
  }

  return {
    name: 'macOS Keychain',
    read(service, account) {
      readable.delete(key(service, account));
      // Attributes only: this shows no dialog, whoever wrote the entry.
      const inspected = runProgram(run, SECURITY_PROGRAM, ['find-generic-password', '-s', service, '-a', account]);
      if (inspected.status === SECURITY_ITEM_NOT_FOUND) return null;
      if (inspected.status !== 0) {
        throw new CredentialStoreError(`The Keychain entry could not be inspected (security exit ${inspected.status}).`);
      }
      if (SECURITY_COMMENT_ATTRIBUTE.exec(inspected.stdout)?.[1] !== SECURITY_ENTRY_MARK) {
        throw new ForeignEntryError();
      }
      const result = runProgram(run, SECURITY_PROGRAM, ['find-generic-password', '-s', service, '-a', account, '-w']);
      if (result.status === SECURITY_ITEM_NOT_FOUND) return null;
      if (result.status !== 0) {
        throw new CredentialStoreError(`The Keychain entry could not be read (security exit ${result.status}).`);
      }
      readable.add(key(service, account));
      return decodeSecuritySecret(result.stdout);
    },
    write(service, account, secret) {
      if (!SAFE_ENTRY_NAME.test(service) || !SAFE_ENTRY_NAME.test(account)) {
        throw new CredentialStoreError('Unsupported Keychain entry name.');
      }
      const line = `add-generic-password -U -s ${service} -a ${account} -j ${SECURITY_ENTRY_MARK} -X ${Buffer.from(secret, 'utf8').toString('hex')}\n`;
      if (line.length > SECURITY_STDIN_LINE_LIMIT) {
        throw new CredentialStoreError('The session record is too long to store through the Keychain helper.');
      }
      // An entry this process read is updated in place, so another process never finds it
      // missing. Any other entry is removed first: updating one that another program created
      // would wait for the user's consent, and removing it does not.
      if (readable.has(key(service, account))) {
        try {
          if (runProgram(run, SECURITY_PROGRAM, ['-i'], line).status === 0) return;
        } catch {
          // Fall through to remove and add.
        }
      }
      remove(service, account);
      // Never report this call's output: on a parse error it echoes the line.
      const result = runProgram(run, SECURITY_PROGRAM, ['-i'], line);
      if (result.status !== 0) {
        throw new CredentialStoreError(`The Keychain entry could not be written (security exit ${result.status}).`);
      }
      readable.add(key(service, account));
    },
    remove
  };
}

/** Secret Service through `secret-tool`, the program the desktop's libsecret ships. */
function createSecretService(run: ProgramRunner, program: string): CredentialStore {
  function call(args: string[], input?: string): ProgramResult {
    const result = runProgram(run, program, args, input);
    // `secret-tool` exits 1 both for "no such item" and for an unreachable service. Only the
    // second one says something on standard error.
    const complaint = (result.stderr || '').trim().split('\n')[0] || '';
    if (result.status !== 0 && complaint) {
      throw new CredentialStoreError(`Secret Service is not available: ${complaint}`);
    }
    return result;
  }

  return {
    name: 'Secret Service',
    read(service, account) {
      // The exact item the tools write, and then any item another program stored for the entry.
      for (const extra of [['application', SECRET_SERVICE_APPLICATION], []]) {
        const result = call(['lookup', 'service', service, 'username', account, ...extra]);
        if (result.status === 0 && result.stdout) return result.stdout;
      }
      return null;
    },
    write(service, account, secret) {
      const result = call(
        [
          'store',
          `--label=Password for '${account}' on '${service}'`,
          'service',
          service,
          'username',
          account,
          'application',
          SECRET_SERVICE_APPLICATION
        ],
        secret
      );
      if (result.status !== 0) {
        throw new CredentialStoreError(`The Secret Service entry could not be written (secret-tool exit ${result.status}).`);
      }
    },
    remove(service, account) {
      return call(['clear', 'service', service, 'username', account]).status === 0;
    }
  };
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * This system's credential store, or null when the extension can reach none. macOS and Linux each
 * use one named store, reached through a program of the system, so every runtime on the machine
 * sees the same entry.
 */
export function openCredentialStore(options: {
  platform?: string;
  env?: Record<string, string | undefined>;
  run?: ProgramRunner;
  isExecutable?: (candidate: string) => boolean;
} = {}): CredentialStore | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? (spawnSync as unknown as ProgramRunner);
  const isExecutable = options.isExecutable ?? isExecutableFile;

  if (platform === 'darwin') {
    return isExecutable(SECURITY_PROGRAM) ? createMacOsKeychain(run) : null;
  }
  if (platform === 'linux') {
    for (const directory of (env.PATH || '').split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, 'secret-tool');
      if (isExecutable(candidate)) return createSecretService(run, candidate);
    }
  }
  return null;
}

function requireBackend(backend: string): string {
  const normalized = normalizeBackendUrl(backend);
  if (!normalized) throw new Error('MainSequence backend URL is required.');
  return normalized;
}

/** The account that holds the session of one backend. Every tool computes it the same way. */
export function sessionAccount(backend: string): string {
  const digest = crypto.createHash('sha256').update(requireBackend(backend), 'utf8').digest('hex');
  return `${UNSCOPED_ACCOUNT}.${digest.slice(0, 16)}`;
}

function parseRecord(raw: string, backend: string): MachineSession | null {
  let record: any;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new CredentialStoreError('The saved session record is not valid.');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new CredentialStoreError('The saved session record is not valid.');
  }
  // `v` is written, not checked: the Python and Command Center CLIs read a record by its fields,
  // and the three readers must accept the same records.
  // A record written before the backend was part of it carries none.
  const recordedBackend = typeof record.backend === 'string' ? record.backend.trim() : '';
  if (recordedBackend && normalizeBackendUrl(recordedBackend) !== requireBackend(backend)) return null;
  const session = {
    username: typeof record.username === 'string' ? record.username : '',
    access: typeof record.access === 'string' ? record.access : '',
    refresh: typeof record.refresh === 'string' ? record.refresh : ''
  };
  return session.access || session.refresh ? session : null;
}

/** Read the saved session of one backend, or null. */
export function readSession(store: CredentialStore, backend: string): MachineSession | null {
  for (const account of [sessionAccount(backend), UNSCOPED_ACCOUNT]) {
    const raw = store.read(SESSION_SERVICE, account);
    if (!raw) continue;
    const session = parseRecord(raw, backend);
    if (session) return session;
  }
  return null;
}

/** Save the session of one backend. */
export function saveSession(store: CredentialStore, backend: string, session: MachineSession): void {
  const json = JSON.stringify({
    v: SESSION_RECORD_VERSION,
    backend: requireBackend(backend),
    username: session.username || '',
    access: session.access || '',
    refresh: session.refresh || ''
  });
  // ASCII only, as the Python CLI writes it, so every store returns the same bytes.
  const ascii = json.replace(/[\u007f-￿]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  store.write(SESSION_SERVICE, sessionAccount(backend), ascii);
}

/**
 * Remove the saved session of one backend. Missing state is success.
 *
 * The legacy unscoped entry goes too, unread, as the Python and Command Center CLIs remove it:
 * deleting needs no consent, while reading an entry another program wrote is refused on macOS
 * and would make the logout fail.
 */
export function clearSession(store: CredentialStore, backend: string): boolean {
  let removed = false;
  for (const account of [sessionAccount(backend), UNSCOPED_ACCOUNT]) {
    removed = store.remove(SESSION_SERVICE, account) || removed;
  }
  return removed;
}
