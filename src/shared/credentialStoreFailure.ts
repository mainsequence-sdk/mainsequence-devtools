/** Public credential-store diagnostics contain fixed text and reason codes only. */
export const CREDENTIAL_STORE_FAILURES = {
  SESSION_UNAVAILABLE: 'The Linux desktop session bus is unavailable to this process. Start the host from your desktop session and forward DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR, plus DISPLAY or WAYLAND_DISPLAY when needed.',
  SERVICE_UNAVAILABLE: 'The desktop session is reachable, but Secret Service is unavailable. Start or install the desktop keyring service and retry.',
  LOCKED: 'The credential store is locked. Unlock the desktop keyring and retry.',
  ACCESS_DENIED: 'Access to the credential store was denied. Allow access in the desktop keyring and retry.',
  HELPER_UNAVAILABLE: 'The credential-store helper could not be started. Install secret-tool on Linux or check that the system credential-store helper is available.',
  HELPER_TIMEOUT: 'The credential-store helper timed out. Check the desktop keyring for a pending prompt and retry.',
  HELPER_FAILED: 'The credential-store helper failed. Check that the desktop session and keyring service are available, then retry.',
  INVALID_RECORD: 'The saved machine session record is invalid. Sign in again to replace it.',
  FOREIGN_ENTRY: 'The saved entry belongs to an older tool. Sign in to replace it.'
} as const;
export type CredentialStoreFailureReason = keyof typeof CREDENTIAL_STORE_FAILURES;
export function credentialStoreFailure(reason: unknown): { reason: CredentialStoreFailureReason; message: string } | undefined {
  if (typeof reason !== 'string' || !Object.prototype.hasOwnProperty.call(CREDENTIAL_STORE_FAILURES, reason)) return;
  return { reason: reason as CredentialStoreFailureReason, message: CREDENTIAL_STORE_FAILURES[reason as CredentialStoreFailureReason] };
}
