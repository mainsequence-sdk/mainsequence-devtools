import { createSessionService, requireBackend } from './session';
import type { CredentialStore } from './machineSession';
import { ToolingError, HostServices } from './models';
import type { SessionLock } from './sharedTransport';
import { AgentClient, PlatformAgent } from './agents';
import type { AgentAsset } from './agentIcon';
export { AgentAsset, stillAgentPng } from './agentIcon';

/** Compatibility API. New hosts consume agents-list with includeIcons directly. */
export function createAgentAssets(options: { host: HostServices; signal?: AbortSignal; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; store?: CredentialStore | null; sessionLock?: SessionLock }) {
  const session = createSessionService(options.host, options);
  const client = new AgentClient(session, { signal: options.signal });
  return { async read(input: { backend: string; expectedAccount: string; environmentUid: string; agentUids: string[] }): Promise<Record<string, AgentAsset>> {
    const backend = requireBackend(input.backend);
    if (!input.expectedAccount || !Array.isArray(input.agentUids) || input.agentUids.length > 20
      || input.agentUids.some(uid => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uid))) throw new ToolingError('INVALID_REQUEST', 'Choose up to twenty visible agents.');
    const remaining = new Set(input.agentUids.map(uid => uid.toLowerCase())), icons: Record<string, AgentAsset> = {};
    for (let offset = 0; remaining.size; offset += 100) {
      if (offset >= 10000) throw new ToolingError('API_ERROR', 'The agent directory is too large.');
      const result = await client.dispatch({ action:'agents-list', backend, expectedAccount:input.expectedAccount,
        environmentUid:input.environmentUid, includeIcons:true, limit:100, offset }, backend);
      if (result.status !== 'success') throw new ToolingError(result.error?.code || 'API_ERROR', result.summary);
      const page = result.data as { results: PlatformAgent[]; count: number };
      for (const agent of page.results) if (remaining.delete(agent.uid) && agent.icon) icons[agent.uid] = agent.icon;
      if (!page.results.length || offset + page.results.length >= page.count) break;
    }
    if ((await session.status(backend, true)).username !== input.expectedAccount) throw new ToolingError('AUTH_REJECTED', 'The MainSequence account changed.');
    return icons;
  }};
}
