import { randomUUID } from 'node:crypto';
import { ActionResult, SessionService, ToolingError } from './models';
import { requireBackend } from './session';
import { McpTransport } from './mcpTransport';
import { waitForAgentReadiness } from './agentReadiness';
import { inlineAgentAsset, AgentAsset } from './agentIcon';

type AgentSelection = { backend?: string; environmentUid: string; expectedAccount?: string };
export type AgentRequest = AgentSelection & (
  | { action: 'agents-list'; search?: string; limit?: number; offset?: number; includeIcons?: boolean }
  | { action: 'agent-get'; agentUid: string; includeIcons?: boolean }
  | { action: 'agent-session'; agentUid: string; handleId?: string; sessionUid?: string }
  | { action: 'agent-readiness'; agentUid: string; sessionUid: string; timeoutMs?: number }
  | { action: 'agent-send'; agentUid: string; message: string; responseKind: 'message' | 'task';
      handleId?: string; sessionUid?: string; taskUid?: string; waitForReady?: boolean; messageId?: string }
  | { action: 'agent-task-get' | 'agent-task-wait' | 'agent-task-cancel'; agentUid: string; taskUid: string; afterSequence?: number }
);
export type PlatformAgent = {
  uid: string; name: string; description: string; environmentUid: string; environmentName: string;
  repositoryBranch: string; runtimeReleaseUid: string | null; runtimeState: string; responseKinds: string[];
  defaults: { provider: string; model: string; thinking: string };
  skills: { name: string; description: string; examples: string[] }[];
  icon?: AgentAsset | null;
};
export function isAgentAction(action: string): boolean {
  return ['agents-list', 'agent-get', 'agent-session', 'agent-readiness', 'agent-send', 'agent-task-get', 'agent-task-wait', 'agent-task-cancel'].includes(action);
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
    throw new ToolingError('INVALID_REQUEST', 'Choose an agent and organization environment from the directory.');
  }
  return value.toLowerCase();
}
function text(value: unknown, limit = 16000): string { return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit) : ''; }
function agent(row: any, environmentUid: string, includeIcons = false): PlatformAgent {
  if (!row || uuid(row.organization_environment_uid) !== environmentUid) throw new ToolingError('INVALID_REQUEST', 'This agent belongs to a different environment. Refresh the directory.');
  if (!text(row.name).trim()) throw new ToolingError('API_ERROR', 'The agent directory returned an unnamed agent.');
  return { uid: uuid(row.uid), name: text(row.name, 300), description: text(row.description), environmentUid,
    ...(includeIcons ? { icon: inlineAgentAsset(row.command_center_icon) } : {}),
    environmentName: text(row.organization_environment_name, 300), repositoryBranch: text(row.repository_branch, 300),
    runtimeReleaseUid: row.runtime_release_uid ? uuid(row.runtime_release_uid) : null,
    runtimeState: text(row.runtime_update?.state, 50) || 'unknown',
    defaults: { provider: text(row.llm_provider, 64).trim(), model: text(row.llm_model, 128).trim(), thinking: text(row.llm_thinking, 1000).trim() },
    responseKinds: Array.isArray(row.a2a_profile?.supported_response_kinds) ? row.a2a_profile.supported_response_kinds.filter((value: unknown) => value === 'message' || value === 'task') : [],
    skills: (Array.isArray(row.agent_card?.skills) ? row.agent_card.skills : []).slice(0, 50).map((skill: any) => ({ name: text(skill.name, 300), description: text(skill.description), examples: (Array.isArray(skill.examples) ? skill.examples : []).slice(0, 10).map((value: unknown) => text(value, 2000)) })) };
}

/** Host-independent platform Agent client. Never connects to a card's URL or exposes runtime credentials. */
export class AgentClient {
  constructor(private readonly session: SessionService, private readonly options: { signal?: AbortSignal; progress?: (message: string) => void } = {}) {}

  async dispatch(input: AgentRequest, selectedBackend: string): Promise<ActionResult> {
    let sent = false;
    let readinessDeadline: number | undefined;
    try {
      const backend = requireBackend(selectedBackend), environmentUid = uuid(input.environmentUid);
      this.options.signal?.throwIfAborted();
      if (!isAgentAction(input.action)) throw new ToolingError('INVALID_REQUEST', 'Unknown agent action.');
      if ('includeIcons' in input && input.includeIcons !== undefined && typeof input.includeIcons !== 'boolean') throw new ToolingError('INVALID_REQUEST', 'includeIcons must be a boolean.');
      const identity = await this.session.status(backend, true);
      if (!identity.authenticated || !identity.username) throw new ToolingError('NOT_AUTHENTICATED', 'Sign in to MainSequence to use agents.');
      if (input.expectedAccount !== undefined && input.expectedAccount !== identity.username) throw new ToolingError('AUTH_REJECTED', 'The MainSequence account changed. Refresh agents and start a new conversation.');
      if (['agent-session', 'agent-readiness', 'agent-send', 'agent-task-get', 'agent-task-wait', 'agent-task-cancel'].includes(input.action) && !input.expectedAccount) {
        throw new ToolingError('INVALID_REQUEST', 'Agent conversations must be bound to the account returned by discovery.');
      }
      // The built-in session binds every request/retry to the selected account. Legacy
      // custom agent transports retain their existing account-check contract.
      const session = input.expectedAccount !== undefined && this.session.withAccount
        ? await this.session.withAccount(backend, input.expectedAccount) : this.session;
      const timeouts = new Map<string, number>();
      const client = new McpTransport(message => {
        const remaining = readinessDeadline === undefined ? undefined : Math.ceil(readinessDeadline - performance.now());
        if (remaining !== undefined && remaining <= 0) throw new ToolingError('PROCESS_TIMEOUT', 'The agent did not become ready in time. No message was sent. Try again.');
        return session.request(backend, 'POST', '/mcp', message,
        message.method !== 'tools/call' || !['a2a.send_message', 'a2a.cancel_task'].includes((message.params as any)?.name),
        remaining !== undefined ? { timeoutMs: Math.min(30000, remaining) }
          : message.method === 'tools/call' && timeouts.has((message.params as any)?.name) ? { timeoutMs: timeouts.get((message.params as any).name) } : undefined);
      });
      await client.initialize();
      const tools = await client.tools();
      const catalog = new Set(tools.map(tool => tool.name));
      for (const tool of tools) {
        const seconds = tool._meta?.['mainsequence.ai/timeout-seconds/v1'];
        if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 295) {
          timeouts.set(tool.name, Math.ceil(seconds * 1000) + 5000);
        }
      }
      // Older catalogs omit deadlines. Cover the existing 140-second gateway budget.
      if (!timeouts.has('a2a.send_message')) timeouts.set('a2a.send_message', 145000);
      const call = async (name: string, args: Record<string, unknown>, mutation = false): Promise<any> => {
        if (!catalog.has(name)) throw new ToolingError('UNSUPPORTED_ACTION', `The connected platform does not offer ${name}.`);
        this.options.signal?.throwIfAborted();
        if (mutation) sent = true;
        const output = await client.request('tools/call', { name, arguments: args });
        if (output?.isError) {
          const code = text(output.structuredContent?.body?.code, 100).replace(/[^a-zA-Z0-9_-]/g, '');
          throw new ToolingError('API_ERROR', `${name} could not complete${code ? ` (${code})` : ''}. Check agent availability and access. The call was not replayed.`);
        }
        if (!output?.structuredContent || typeof output.structuredContent !== 'object') throw new ToolingError('API_ERROR', 'The platform returned an invalid agent result.');
        return output.structuredContent;
      };
      let data: Record<string, unknown>;
      if (input.action === 'agents-list') {
        const limit = input.limit ?? 25, offset = input.offset ?? 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0
          || (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 2000))) throw new ToolingError('INVALID_REQUEST', 'Search requires text, a limit of 1–100, and a nonnegative offset.');
        const search = input.search?.trim();
        const icons = input.includeIcons ? { include_icons:true } : {};
        const page = search ? await call('agent.search', { organization_environment_uid: environmentUid, q: search, limit, ...icons })
          : await call('agent.list', { organization_environment_uid: environmentUid, limit, offset, ...icons });
        if (!Array.isArray(page.results) || (!search && (!Number.isInteger(page.count) || page.count < 0))) throw new ToolingError('API_ERROR', 'The platform returned invalid agent pagination.');
        data = { account: identity.username, results: page.results.map((row: any) => agent(row, environmentUid, input.includeIcons)), count: search ? page.results.length : page.count, offset: search ? 0 : offset, semantic: !!search };
      } else {
        const agentUid = uuid(input.agentUid);
        const includeIcons = input.action === 'agent-get' && input.includeIcons === true;
        const selected = agent(await call('agent.get', { agent_uid: agentUid, ...(includeIcons ? { include_icons:true } : {}) }), environmentUid, includeIcons);
        if (selected.uid !== agentUid) throw new ToolingError('API_ERROR', 'The platform returned another agent.');
        const task = async (taskUid: string) => {
          const result = await call('a2a.get_task', { task_uid: uuid(taskUid) });
          if (uuid(result.agent_uid) !== agentUid || uuid(result.task_uid) !== uuid(taskUid)) throw new ToolingError('INVALID_REQUEST', 'This task belongs to another agent.');
          return result;
        };
        const resolveSession = async (target: Record<string, unknown>) => {
          const resolved = await call('agent.get_or_create_session', { agent_uid: agentUid, ...target });
          if (uuid(resolved.agent_uid) !== agentUid || uuid(resolved.organization_environment_uid) !== environmentUid
            || (target.session_uid && uuid(resolved.uid) !== uuid(target.session_uid))
            || (target.handle_unique_id && resolved.bound_handle?.handle_unique_id !== target.handle_unique_id)) {
            throw new ToolingError('API_ERROR', 'The platform returned another agent conversation.');
          }
          return resolved;
        };
        const ready = async (sessionUid: string, timeoutMs?: number) => {
          if (!selected.runtimeReleaseUid || selected.runtimeState === 'not_deployed') throw new ToolingError('UNSUPPORTED_ACTION', 'This agent has no deployed runtime.');
          try {
            await waitForAgentReadiness({ signal: this.options.signal, progress: this.options.progress, timeoutMs,
              resolve: async deadline => {
                readinessDeadline = deadline;
                const account = await this.session.status(backend, true);
                if (!account.authenticated || account.username !== identity.username) throw new ToolingError('AUTH_REJECTED', 'The MainSequence account changed while checking the agent. Choose the agent again.');
                return call('agent_session.resolve_runtime_access', { agent_session_uid: sessionUid });
              } });
          } finally { readinessDeadline = undefined; }
        };
        if (input.action === 'agent-get') data = { account: identity.username, agent: selected };
        else if (input.action === 'agent-readiness') {
          const resolved = await resolveSession({ session_uid: uuid(input.sessionUid) });
          await ready(uuid(resolved.uid), input.timeoutMs);
          data = { account: identity.username, agentUid, sessionUid: uuid(resolved.uid), ready: true };
        }
        else if (input.action === 'agent-session') {
          if ([input.handleId, input.sessionUid].filter(value => value !== undefined).length !== 1) {
            throw new ToolingError('INVALID_REQUEST', 'Use exactly one conversation handle or session.');
          }
          let target: Record<string, unknown>;
          if (input.sessionUid !== undefined) target = { session_uid: uuid(input.sessionUid) };
          else {
            if (typeof input.handleId !== 'string' || !/^[-a-zA-Z0-9_]{1,255}$/.test(input.handleId)) {
              throw new ToolingError('INVALID_REQUEST', 'A stable conversation handle is required.');
            }
            target = { handle_unique_id: input.handleId };
          }
          const resolved = await resolveSession(target);
          data = { account: identity.username, agent: selected, sessionUid: uuid(resolved.uid),
            ...(resolved.bound_handle?.handle_unique_id ? { handleId: text(resolved.bound_handle.handle_unique_id, 255) } : {}) };
        }
        else if (input.action === 'agent-send') {
          const messageId = input.messageId === undefined ? randomUUID() : uuid(input.messageId);
          if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 64000) throw new ToolingError('INVALID_REQUEST', 'Enter a message of 1–64000 characters.');
          if (!['message', 'task'].includes(input.responseKind) || !selected.responseKinds.includes(input.responseKind)) throw new ToolingError('UNSUPPORTED_ACTION', 'The agent does not advertise the requested response mode.');
          if (!selected.runtimeReleaseUid || selected.runtimeState === 'not_deployed') throw new ToolingError('UNSUPPORTED_ACTION', 'This agent has no deployed runtime.');
          if ([input.handleId, input.sessionUid, input.taskUid].filter(value => value !== undefined).length !== 1) throw new ToolingError('INVALID_REQUEST', 'Use exactly one conversation handle, session, or task.');
          let target: Record<string, unknown>;
          if (input.taskUid) {
            if (input.responseKind !== 'task') throw new ToolingError('INVALID_REQUEST', 'Continue an existing task in task mode.');
            await task(input.taskUid); target = { task_uid: uuid(input.taskUid) };
          } else if (input.sessionUid) target = { agent_uid: agentUid, agent_session_uid: uuid(input.sessionUid) };
          else {
            if (typeof input.handleId !== 'string' || !/^[-a-zA-Z0-9_]{1,255}$/.test(input.handleId)) throw new ToolingError('INVALID_REQUEST', 'A stable conversation handle is required.');
            target = { agent_uid: agentUid, handle_unique_id: input.handleId };
          }
          if (input.waitForReady !== undefined && typeof input.waitForReady !== 'boolean') throw new ToolingError('INVALID_REQUEST', 'waitForReady must be a boolean.');
          if (input.waitForReady) {
            const resolved = await resolveSession(input.taskUid
              ? { session_uid: uuid((await task(input.taskUid)).agent_session_uid) }
              : input.sessionUid ? { session_uid: uuid(input.sessionUid) } : { handle_unique_id: input.handleId });
            await ready(uuid(resolved.uid));
          }
          const reply = await call('a2a.send_message', { ...target, message: input.message, message_id: messageId, response_kind: input.responseKind,
            ...(input.responseKind === 'task' ? { completion_policy: 'poll' } : {}) }, true);
          if (uuid(reply.agent_uid) !== agentUid || reply.response_kind !== input.responseKind || (input.sessionUid && uuid(reply.agent_session_uid) !== uuid(input.sessionUid))) throw new ToolingError('API_ERROR', 'The agent response does not match this conversation.');
          data = { account: identity.username, agent: selected, ...projectReply(reply) };
        } else {
          const previous = await task(input.taskUid);
          if (input.afterSequence !== undefined && (!Number.isInteger(input.afterSequence) || input.afterSequence < 0)) throw new ToolingError('INVALID_REQUEST', 'Task event cursor must be nonnegative.');
          const result = input.action === 'agent-task-get' ? previous : await call(input.action === 'agent-task-wait' ? 'a2a.wait_task' : 'a2a.cancel_task',
            { task_uid: uuid(input.taskUid), ...(input.action === 'agent-task-wait' ? { after_sequence: input.afterSequence ?? previous.event_cursor, timeout_seconds: 15 } : {}) }, input.action === 'agent-task-cancel');
          if (uuid(result.agent_uid) !== agentUid || uuid(result.task_uid) !== uuid(input.taskUid)) throw new ToolingError('API_ERROR', 'The task result does not match the selected agent.');
          data = { account: identity.username, agent: selected, ...projectReply(result) };
        }
      }
      return { schemaVersion: 1, action: input.action, status: 'success', summary: input.action === 'agent-send' ? 'Agent response received.' : 'Agent operation completed.', data };
    } catch (error) {
      const failure = this.options.signal?.aborted ? new ToolingError('CANCELLED', 'Agent operation cancelled.')
        : error instanceof ToolingError ? error : new ToolingError('API_ERROR', 'The agent operation could not complete.');
      return { schemaVersion: 1, action: input.action, status: failure.code === 'CANCELLED' ? 'cancelled' : 'failure', summary: failure.message,
        error: { code: failure.code, message: failure.message }, ...(sent ? { effects: { state: 'partial-or-uncertain' as const, message: 'The remote agent may have received this request. Do not automatically resend it; inspect its session or task first.' } } : {}) };
    }
  }
}
function projectReply(reply: any): Record<string, unknown> {
  const result: Record<string, unknown> = { sessionUid: uuid(reply.agent_session_uid), responseKind: reply.response_kind || 'task' };
  if (reply.response_kind === 'message') {
    if (typeof reply.message !== 'string' || !reply.message.trim()) throw new ToolingError('API_ERROR', 'The agent returned an empty message.');
    result.message = text(reply.message, 64000);
  } else Object.assign(result, { taskUid: uuid(reply.task_uid), status: text(reply.status, 100), terminal: reply.terminal === true,
    eventCursor: reply.event_cursor, cancellationRequested: reply.cancellation_requested === true,
    outputs: Array.isArray(reply.outputs) ? reply.outputs : [], events: Array.isArray(reply.events) ? reply.events : [], timedOut: reply.timed_out === true });
  return result;
}
