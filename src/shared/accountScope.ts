import { SessionService, ToolingError } from './models';

export function validateExpectedAccount(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\r\n\0]/.test(value)) {
    throw new ToolingError('INVALID_REQUEST', 'Use the account returned by verified session status.');
  }
}

/** Opt-in account scope for domain operations; never silently weaken a custom transport. */
export async function bindSessionAccount(session: SessionService, backend: string, expectedAccount?: string): Promise<SessionService> {
  if (expectedAccount === undefined) return session;
  validateExpectedAccount(expectedAccount);
  if (!session.withAccount) throw new ToolingError('UNSUPPORTED_ACTION', 'This session transport does not support account-bound operations. Upgrade its session implementation.');
  return session.withAccount(backend, expectedAccount);
}
