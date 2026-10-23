import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ActionRequest, ActionResult, ToolingError } from './models';
import { requireBackend } from './session';

/** Supplied by the host, never by message text or a remote agent. */
export type AgentDeliveryScope = { host: string; conversationId: string; backend: string; account: string };
export type AgentDeliveryState = 'pending' | 'preparing' | 'sending' | 'delivered' | 'failed' | 'uncertain' | 'cancelled' | 'expired';
type Owner = { pid: number; token: string };
export type AgentDeliveryRequest = {
  requestId: string; messageId: string; agentUid: string; agentName: string; environmentUid: string;
  message: string; conversationKey?: string; taskRequestId?: string; continuationTaskUid?: string; responseKind?: 'message' | 'task'; task?: Record<string, unknown>; handleId: string; sessionUid?: string; createdAt: string; expiresAt: string;
  state: AgentDeliveryState; sendAttempts: number; reason?: string;
  submission: { attempts: number; outcome: 'not-submitted' | 'attempted' | 'acknowledged' | 'unknown' };
  receipt?: { completedAt: string; sessionUid: string; message: string };
};
type StoredRequest = AgentDeliveryRequest & { owner?: Owner };
type State = { version: 1; scope: string; requests: Record<string, StoredRequest> };
export type AgentDeliveryDispatch = (request: ActionRequest) => Promise<ActionResult>;
type Options = {
  createDispatch(signal?: AbortSignal): AgentDeliveryDispatch;
  /** Trusted integration/test configuration. Never accept this path from an app or tool argument. */
  directory?: string;
  readinessTimeoutMs?: number;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) throw new ToolingError('INVALID_REQUEST', 'A valid saved request or agent identifier is required.');
  return value.toLowerCase();
};
const failStore = () => new ToolingError('STORE_ERROR', 'Saved agent requests could not be read safely. Existing requests were kept; no message was resent.');
const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const view = (r: StoredRequest): AgentDeliveryRequest => { const { owner: _, ...publicRequest } = r; return structuredClone(publicRequest); };
const finished = (r: StoredRequest) => !['pending', 'preparing', 'sending'].includes(r.state);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const defaultDirectory = () => path.join(process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'MainSequenceCLI')
  : process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'MainSequenceCLI') : path.join(os.homedir(), '.config', 'mainsequence'), 'agent-delivery-v1');

/**
 * Durable, account/chat-scoped delivery. A receipt can be read repeatedly; a send is never replayed.
 * Native turn cancellation only cancels the caller's wait. Accepted work has its own bounded lifetime.
 * Process loss during a send is uncertain, not evidence of failure or permission to send again.
 */
export class AgentDelivery {
  private readonly directory: string;
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly options: Options) { this.directory = path.resolve(options.directory || defaultDirectory()); }

  private scope(input: AgentDeliveryScope): { scope: AgentDeliveryScope; key: string } {
    if (!input || typeof input.host !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.host)
      || typeof input.conversationId !== 'string' || !input.conversationId.trim() || input.conversationId.length > 512
      || typeof input.account !== 'string' || !input.account.trim() || input.account.length > 300) throw new ToolingError('INVALID_REQUEST', 'A verified account and host conversation are required.');
    const scope = { ...input, backend: requireBackend(input.backend) };
    return { scope, key: hash([scope.host, scope.conversationId, scope.backend, scope.account]) };
  }
  private async verify(scope: AgentDeliveryScope, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = await this.options.createDispatch(signal)({ action: 'auth-status', backend: scope.backend, check: true });
    const data = result.data as { authenticated?: boolean; username?: string } | undefined;
    if (result.status !== 'success') throw new ToolingError(result.error?.code || 'AUTH_REJECTED', result.summary);
    if (!data?.authenticated || data.username !== scope.account) throw new ToolingError('AUTH_REJECTED', 'The MainSequence account changed. Refresh before accessing saved agent requests.');
    signal?.throwIfAborted();
  }
  private async secureDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw failStore();
    await fs.chmod(this.directory, 0o700);
  }
  private async readFile(file: string, lockRead = false): Promise<string> {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (lockRead && stat.nlink === 0) throw Object.assign(new Error('The lock was released while opening it.'), { code: 'ENOENT' });
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 36_000_000 || (process.getuid && stat.uid !== process.getuid())) throw failStore();
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }
  private async locked<T>(key: string, run: (state: State, save: () => Promise<void>) => Promise<T>): Promise<T> {
    await this.secureDirectory();
    const file = path.join(this.directory, key + '.json'), lock = file + '.lock';
    const owner = { pid: process.pid, token: randomUUID() }; let guard;
    const deadline = Date.now() + 3000;
    while (!guard) {
      try { guard = await fs.open(lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failStore();
        let previous: Owner;
        try { previous = JSON.parse(await this.readFile(lock, true)); }
        catch (e) {
          // A new exclusive file can briefly precede its owner record. Never reclaim it.
          if (Date.now() >= deadline) throw failStore();
          if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT') { await sleep(25); continue; }
          throw failStore();
        }
        if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.token !== 'string') throw failStore();
        if (!live(previous.pid)) {
          // One durable reclamation claim per dead owner prevents deleting a replacement lock.
          const claim = lock + '.reclaim-' + uuid(previous.token);
          try { const handle = await fs.open(claim, 'wx', 0o600); await handle.close(); }
          catch { throw new ToolingError('PROJECT_BUSY', 'Agent storage recovery is already running. Try reading status again.'); }
          if (await this.readFile(lock) !== JSON.stringify(previous)) throw failStore();
          await fs.unlink(lock); continue;
        }
        if (Date.now() >= deadline) throw new ToolingError('PROJECT_BUSY', 'Another agent request is updating local storage. Try reading status again.');
        await sleep(25);
      }
    }
    try {
      await guard.writeFile(JSON.stringify(owner)); await guard.sync();
      let state: State;
      try { state = JSON.parse(await this.readFile(file)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw failStore(); state = { version: 1, scope: key, requests: {} }; }
      if (state?.version !== 1 || state.scope !== key || !state.requests || Array.isArray(state.requests) || typeof state.requests !== 'object' || Object.keys(state.requests).length > 256) throw failStore();
      for (const [id, r] of Object.entries(state.requests)) {
        if (!r || uuid(id) !== id || r.requestId !== id || r.messageId !== id || typeof r.message !== 'string' || r.message.length > 64000
          || typeof r.agentName !== 'string' || !['pending','preparing','sending','delivered','failed','uncertain','cancelled','expired'].includes(r.state)
          || !/^host_[a-f0-9]{64}$/.test(r.handleId) || !Number.isFinite(Date.parse(r.createdAt))
          || !r.submission || !Number.isSafeInteger(r.submission.attempts) || r.submission.attempts < 0
          || !['not-submitted','attempted','acknowledged','unknown'].includes(r.submission.outcome)
          || !Number.isSafeInteger(r.sendAttempts) || r.sendAttempts < 0 || r.sendAttempts > 1 || !Number.isFinite(Date.parse(r.expiresAt))) throw failStore();
        // 'failed' is reserved for a completed devtools result proving no remote mutation.
        // Early development records counted entry into agent-send before its preflight.
        if (r.state === 'failed') r.sendAttempts = 0;
        uuid(r.agentUid); uuid(r.environmentUid);
        if (r.sessionUid) uuid(r.sessionUid);
        if (r.conversationKey) uuid(r.conversationKey); if(r.continuationTaskUid) uuid(r.continuationTaskUid); if(r.taskRequestId) uuid(r.taskRequestId);
        if (r.state === 'delivered' && (!r.receipt || typeof r.receipt.message !== 'string' || !r.receipt.message || r.receipt.sessionUid !== r.sessionUid)) throw failStore();
        if (['preparing', 'sending'].includes(r.state)) {
          if (!r.owner || !Number.isSafeInteger(r.owner.pid) || r.owner.pid <= 0 || typeof r.owner.token !== 'string') throw failStore();
          if (!live(r.owner.pid)) {
            r.state = r.state === 'sending' ? 'uncertain' : 'pending';
            r.reason = r.state === 'uncertain' ? 'The process ended during dispatch. Delivery is unknown; resend is blocked.' : 'Preparation was interrupted before sending. Recover this same request.';
            delete r.owner;
          }
        }
        if ((r.state === 'pending' || (r.state === 'failed' && r.sendAttempts === 0)) && Date.parse(r.expiresAt) <= Date.now()) { r.state = 'expired'; r.reason = 'This request expired without being sent.'; }
      }
      const save = async () => {
        const serialized = JSON.stringify(state);
        if (Buffer.byteLength(serialized) > 36_000_000) throw failStore();
        const temporary = file + '.' + randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        try { await fs.rename(temporary, file); const directory = await fs.open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
        finally { await fs.unlink(temporary).catch(() => {}); }
      };
      const result = await run(state, save); await save(); return result;
    } finally { await guard.close(); await fs.unlink(lock); }
  }
  /** Prepare a stable conversation without sending an introductory message. */
  async prepare(input: AgentDeliveryScope, selection: {environmentUid:string;agentUid:string;conversationKey?:string}, signal?:AbortSignal) {
    const {scope,key}=this.scope(input), environmentUid=uuid(selection.environmentUid),agentUid=uuid(selection.agentUid);
    const conversationKey=selection.conversationKey===undefined?undefined:uuid(selection.conversationKey);
    await this.verify(scope,signal);
    const dispatch=this.options.createDispatch(signal), target={backend:scope.backend,expectedAccount:scope.account,environmentUid,agentUid};
    const handleId='host_'+hash(conversationKey?[key,environmentUid,agentUid,conversationKey]:[key,environmentUid,agentUid]);
    const session=await dispatch({action:'agent-session',...target,handleId});
    if(session.status!=='success')throw new ToolingError(session.error?.code || 'API_ERROR',session.summary);
    const sessionUid=uuid((session.data as {sessionUid?:string})?.sessionUid);
    const ready=await dispatch({action:'agent-readiness',...target,sessionUid,timeoutMs:90000});
    if(ready.status!=='success')throw new ToolingError(ready.error?.code || 'API_ERROR',ready.summary);
    return {sessionUid,handleId,ready:true};
  }
  async stage(input: AgentDeliveryScope, draft: { requestId: string; environmentUid: string; agentUid: string; message: string; conversationKey?: string; taskRequestId?: string; responseKind?: 'message' | 'task' }, signal?: AbortSignal): Promise<AgentDeliveryRequest> {
    const { scope, key } = this.scope(input), requestId = uuid(draft.requestId), agentUid = uuid(draft.agentUid), environmentUid = uuid(draft.environmentUid);
    if (typeof draft.message !== 'string' || !draft.message.trim() || draft.message.length > 64000) throw new ToolingError('INVALID_REQUEST', 'Enter a message of 1–64000 characters.');
    const conversationKey = draft.conversationKey === undefined ? undefined : uuid(draft.conversationKey);
    const responseKind = draft.responseKind ?? 'message';
    if (!['message', 'task'].includes(responseKind)) throw new ToolingError('INVALID_REQUEST', 'Choose message or task response mode.');
    await this.verify(scope, signal);
    const detail = await this.options.createDispatch(signal)({ action: 'agent-get', backend: scope.backend, expectedAccount: scope.account, environmentUid, agentUid });
    const agent = (detail.data as { agent?: { uid: string; name: string; responseKinds: string[] } })?.agent;
    if (detail.status !== 'success') throw new ToolingError(detail.error?.code || 'API_ERROR', detail.summary);
    if (!agent || agent.uid !== agentUid || !agent.responseKinds.includes(responseKind)) throw new ToolingError('UNSUPPORTED_ACTION', 'This agent does not support the selected response mode.');
    const previousTask = draft.taskRequestId ? await this.get(scope, uuid(draft.taskRequestId), signal) : undefined;
    if (previousTask && (responseKind !== 'task' || previousTask.agentUid !== agentUid || previousTask.environmentUid !== environmentUid || !previousTask.task)) throw new ToolingError('INVALID_REQUEST','Continue only a saved task belonging to this agent and environment.');
    signal?.throwIfAborted();
    return this.locked(key, async state => {
      const same = (r: StoredRequest) => r.agentUid === agentUid && r.environmentUid === environmentUid && r.message === draft.message && (r.responseKind ?? 'message') === responseKind && r.conversationKey === conversationKey && r.taskRequestId === draft.taskRequestId;
      const previous = state.requests[requestId];
      if (previous) { if (!same(previous)) throw new ToolingError('INVALID_REQUEST', 'This request ID already belongs to different immutable content.'); return view(previous); }
      const duplicate = Object.values(state.requests).find(r => same(r) && ['pending', 'preparing', 'sending', 'uncertain'].includes(r.state));
      if (duplicate) return view(duplicate);
      if (Object.keys(state.requests).length >= 256) throw new ToolingError('STORE_ERROR', 'This conversation reached its saved request limit. Existing receipts are retained.');
      const request: StoredRequest = { requestId, messageId: requestId, agentUid, environmentUid, agentName: agent.name.slice(0,300), message: draft.message, responseKind, ...(previousTask ? {taskRequestId:previousTask.requestId,continuationTaskUid:uuid(previousTask.task!.taskUid)} : {}), ...(conversationKey ? { conversationKey } : {}),
        handleId: previousTask?.handleId ?? 'host_' + hash(conversationKey ? [key, environmentUid, agentUid, conversationKey] : [key, environmentUid, agentUid]), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
        state: 'pending', sendAttempts: 0, submission: { attempts: 0, outcome: 'not-submitted' } };
      state.requests[requestId] = request; return view(request);
    });
  }
  async list(input: AgentDeliveryScope, signal?: AbortSignal): Promise<AgentDeliveryRequest[]> {
    const { scope, key } = this.scope(input); await this.verify(scope, signal);
    return this.locked(key, async state => Object.values(state.requests).map(view));
  }
  async get(input: AgentDeliveryScope, id: string, signal?: AbortSignal): Promise<AgentDeliveryRequest> {
    const requestId = uuid(id); const requests = await this.list(input, signal), request = requests.find(r => r.requestId === requestId);
    if (!request) throw new ToolingError('INVALID_REQUEST', 'No saved request with this ID belongs to this account and conversation.');
    return request;
  }
  async submission(input: AgentDeliveryScope, id: string, outcome: 'attempted' | 'acknowledged' | 'unknown', signal?: AbortSignal) {
    if (!['attempted','acknowledged','unknown'].includes(outcome)) throw new ToolingError('INVALID_REQUEST', 'Invalid submission outcome.');
    const { scope, key } = this.scope(input), requestId = uuid(id); await this.verify(scope, signal);
    return this.locked(key, async state => { const r = state.requests[requestId]; if (!r) throw new ToolingError('INVALID_REQUEST', 'Unknown saved request.');
      r.submission.outcome = outcome; if (outcome === 'attempted') r.submission.attempts++; return view(r); });
  }
  async cancel(input: AgentDeliveryScope, id: string, signal?: AbortSignal) {
    const { scope, key } = this.scope(input), requestId = uuid(id); await this.verify(scope, signal);
    return this.locked(key, async state => { const r = state.requests[requestId]; if (!r) throw new ToolingError('INVALID_REQUEST', 'Unknown saved request.');
      if (r.state !== 'pending' && r.state !== 'cancelled') throw new ToolingError('INVALID_REQUEST', 'An accepted or completed message cannot be unsent. Read its saved status.');
      r.state = 'cancelled'; r.reason = 'Cancelled before dispatch.'; return view(r); });
  }
  async deliver(input: AgentDeliveryScope, id: string, signal?: AbortSignal): Promise<AgentDeliveryRequest> {
    const { scope, key } = this.scope(input), requestId = uuid(id); await this.verify(scope, signal);
    const owner = { pid: process.pid, token: randomUUID() };
    const claimed = await this.locked(key, async state => {
      signal?.throwIfAborted();
      const r = state.requests[requestId]; if (!r) throw new ToolingError('INVALID_REQUEST', 'Unknown saved request in this conversation.');
      // Explicit recovery may repeat preparation when the durable marker proves no send began.
      // Ambiguous transport failures remain uncertain and are never eligible.
      if (r.state !== 'pending' && !(r.state === 'failed' && r.sendAttempts === 0)) return false;
      if (Object.values(state.requests).some(other => other.requestId !== requestId && other.agentUid === r.agentUid && other.environmentUid === r.environmentUid && ['preparing','sending','uncertain'].includes(other.state))) {
        throw new ToolingError('PROJECT_BUSY', 'This agent conversation has a running or uncertain delivery. Recover its existing request before sending another.');
      }
      r.state = 'preparing'; r.owner = owner; delete r.reason; return true;
    });
    if (claimed) {
      const jobKey = key + requestId;
      const job = this.run(scope, key, requestId, owner).catch(() => { /* Durable sending marker blocks replay if receipt persistence fails. */ });
      this.jobs.set(jobKey, job); void job.finally(() => { if (this.jobs.get(jobKey) === job) this.jobs.delete(jobKey); });
    }
    return this.wait(scope, requestId, signal);
  }
  async wait(input: AgentDeliveryScope, id: string, signal?: AbortSignal, waitMs = 25000): Promise<AgentDeliveryRequest> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new ToolingError('INVALID_REQUEST', 'Wait must be between zero and 30 seconds.');
    const { scope, key } = this.scope(input), requestId = uuid(id); await this.verify(scope, signal);
    const deadline = Date.now() + waitMs;
    while (true) {
      signal?.throwIfAborted();
      const r = await this.locked(key, async state => { const value = state.requests[requestId]; if (!value) throw new ToolingError('INVALID_REQUEST', 'Unknown saved request.'); return view(value); });
      if (finished(r) || r.state === 'pending' || Date.now() >= deadline) { await this.verify(scope, signal); return r; }
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }
  /** Reads/cancels only a task obtained from this chat's durable receipt; never sends a message. */
  async task(input: AgentDeliveryScope, id: string, action: 'get' | 'wait' | 'cancel', signal?: AbortSignal) {
    if (!['get', 'wait', 'cancel'].includes(action)) throw new ToolingError('INVALID_REQUEST', 'Choose get, wait or cancel.');
    const { scope, key } = this.scope(input), r = await this.get(input, id, signal);
    if (!r.task || !r.sessionUid) throw new ToolingError('INVALID_REQUEST', 'This request has no accepted agent task.');
    const taskUid = uuid(r.task.taskUid);
    const result = await this.options.createDispatch(signal)({ action: action === 'cancel' ? 'agent-task-cancel' : action === 'wait' ? 'agent-task-wait' : 'agent-task-get',
      backend: scope.backend, expectedAccount: scope.account, environmentUid: r.environmentUid, agentUid: r.agentUid, taskUid });
    if (result.status !== 'success') throw new ToolingError(result.error?.code || 'API_ERROR', result.summary);
    const task = result.data as Record<string, unknown>;
    if (task.taskUid !== taskUid || task.sessionUid !== r.sessionUid) throw new ToolingError('API_ERROR', 'The task response does not match this saved request.');
    return this.locked(key, async state => { const record = state.requests[r.requestId];
      // Older responses from concurrent reads must not overwrite newer task progress.
      if (Number(task.eventCursor ?? 0) >= Number(record.task?.eventCursor ?? 0)) {
        record.task = task; record.receipt = { completedAt: new Date().toISOString(), sessionUid: r.sessionUid!, message: JSON.stringify(task) };
      }
      return view(record);
    });
  }
  private async run(scope: AgentDeliveryScope, key: string, id: string, owner: Owner): Promise<void> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12 * 60_000);
    const dispatch = this.options.createDispatch(controller.signal);
    const update = async (fn: (r: StoredRequest) => void) => this.locked(key, async state => {
      const r = state.requests[id]; if (r?.owner?.token !== owner.token) throw failStore(); fn(r); return view(r);
    });
    let sending = false;
    try {
      const r = await update(() => {}), selection = { backend: scope.backend, environmentUid: r.environmentUid, agentUid: r.agentUid, expectedAccount: scope.account };
      const prepared = await dispatch({ action: 'agent-session', ...selection, handleId: r.handleId });
      if (prepared.status !== 'success') throw new ToolingError(prepared.error?.code || 'API_ERROR', prepared.summary);
      const sessionUid = uuid((prepared.data as { sessionUid?: string })?.sessionUid);
      await update(record => { record.sessionUid = sessionUid; });
      const ready = await dispatch({ action: 'agent-readiness', ...selection, sessionUid, timeoutMs: this.options.readinessTimeoutMs ?? 300000 });
      if (ready.status !== 'success') throw new ToolingError(ready.error?.code || 'API_ERROR', ready.summary);
      controller.signal.throwIfAborted();
      await update(record => { record.state = 'sending'; record.sendAttempts = 1; }); sending = true;
      const result = await dispatch({ action: 'agent-send', ...selection, ...(r.continuationTaskUid ? {taskUid:r.continuationTaskUid} : {sessionUid}), message: r.message, messageId: r.messageId, responseKind: r.responseKind ?? 'message' });
      const reply = result.data as { message?: string; sessionUid?: string; responseKind?: string; taskUid?: string } & Record<string, unknown> | undefined;
      await update(record => {
        if (result.status === 'success' && reply?.responseKind === 'task' && r.responseKind === 'task' && reply.sessionUid === sessionUid && reply.taskUid) {
          uuid(reply.taskUid); record.state = 'delivered'; record.task = reply; record.receipt = { completedAt: new Date().toISOString(), sessionUid, message: JSON.stringify(reply) };
        } else if (result.status === 'success' && reply?.responseKind === 'message' && typeof reply.message === 'string' && reply.message.trim() && reply.sessionUid === sessionUid) {
          record.state = 'delivered'; record.receipt = { completedAt: new Date().toISOString(), sessionUid, message: reply.message };
        } else {
          record.state = result.effects || result.status === 'success' ? 'uncertain' : 'failed';
          if (record.state === 'failed') record.sendAttempts = 0; // AgentClient proved its preflight failed before a2a.send_message.
          record.reason = record.state === 'uncertain' ? 'The agent may have received this message. Resend is blocked.' : result.summary.slice(0,2000);
        }
        delete record.owner;
      });
    } catch (error) {
      await update(record => { record.state = sending ? 'uncertain' : 'failed';
        record.reason = sending ? 'Dispatch did not produce a durable reply. Resend is blocked.' : error instanceof ToolingError ? error.message.slice(0,2000) : 'Preparation failed before sending. No agent message was sent.';
        delete record.owner;
      }).catch(() => {});
    } finally { clearTimeout(timer); }
  }
}
