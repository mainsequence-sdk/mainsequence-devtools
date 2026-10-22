import { SessionService, ToolingError } from './models';
import { requireBackend } from './session';

export type EnvironmentSummary = { uid: string; name: string; isProduction: boolean };

/** One bounded directory reader for all hosts and domain clients. No settings writes. */
export async function listEnvironments(session: Pick<SessionService, 'request'>, inputBackend: string, signal?: AbortSignal): Promise<EnvironmentSummary[]> {
  const backend = requireBackend(inputBackend), items: EnvironmentSummary[] = [], seen = new Set<string>();
  let expectedCount: number | undefined;
  for (let offset = 0; ;) {
    signal?.throwIfAborted();
    const page = await session.request<any>(backend, 'GET', `/api/v1/organization-environments/?limit=100&offset=${offset}`);
    signal?.throwIfAborted();
    const rows = Array.isArray(page) ? page : page?.results;
    const count = Array.isArray(page) ? page.length : page?.count;
    if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count < 0 || count > 10_000 || offset + rows.length > count
      || (expectedCount !== undefined && expectedCount !== count) || (offset > 0 && Array.isArray(page))) {
      throw new ToolingError('API_ERROR', 'The environment pagination is invalid or changed. Refresh the directory.');
    }
    expectedCount = count;
    for (const row of rows) {
      if (typeof row?.uid !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.uid)
        || typeof row.name !== 'string' || !row.name.trim() || /[\r\n\0]/.test(row.name)) {
        throw new ToolingError('API_ERROR', 'The backend returned an invalid organization environment.');
      }
      const uid = row.uid.toLowerCase();
      if (seen.has(uid)) throw new ToolingError('API_ERROR', 'Environment pagination returned duplicate rows.');
      seen.add(uid); items.push({ uid, name: row.name.trim(), isProduction: row.is_production === true });
    }
    offset += rows.length;
    if (offset === count) return items;
    if (!rows.length) throw new ToolingError('API_ERROR', 'Environment pagination stopped before completion.');
  }
}
