import * as net from 'net';
export function normalizeBackendUrl(input: string | undefined | null): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.includes('://')) return raw.replace(/\/+$/, '');

  const host = raw.split('/', 1)[0].split(':', 1)[0].replace(/^\[|\]$/g, '').toLowerCase();
  const localHost = host === 'localhost' || host === '0.0.0.0' || isPrivateIp(host);
  return `${localHost ? 'http' : 'https'}://${raw}`.replace(/\/+$/, '');
}

function isPrivateIp(host: string): boolean {
  const kind = net.isIP(host);
  if (kind === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  if (kind === 6) {
    const normalized = host.toLowerCase();
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return false;
}

