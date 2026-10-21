// @ts-check
import { Plugin } from '@opencode/plugin/tui';
import * as presentation from './ui/opencodePresentation.mjs';
import { MainSequence } from './rpc.mjs';

/** @param {unknown} value @returns {any} */
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const title = 'MainSequence';

export default Plugin.define({
  id: 'mainsequence.devtools.ui',
  setup(context) {
    const rpc = context.client.rpc(MainSequence);
    const location = () => context.location ?? context.data.location.default();
    const requestOptions = () => ({ location: location() });
    let disposed = false;
    let activeDialog = '';
    /** @type {Map<string, any>} */
    const operations = new Map();
    /** @type {Set<string>} */
    const watched = new Set();
    const toast = (/** @type {string} */ message, /** @type {'success' | 'error' | 'info'} */ variant = 'info') => context.ui.toast.show({ title, message: presentation.cleanText(message), variant, duration: 4000 });
    const unsubscribe = rpc.events.on('updated', event => {
      const here = location();
      if (event.location.directory !== here.directory) return;
      const operation = record(event.data);
      const previous = operations.get(operation.id);
      operations.set(operation.id, operation);
      if (operation.status === 'running' && operation.progress !== previous?.progress && watched.has(operation.id)) toast(operation.progress);
      if (operation.status !== 'running' && !watched.has(operation.id)) toast(operation.progress, operation.status === 'success' ? 'success' : 'error');
    });
    /** @param {string} command @param {boolean} showResult */
    async function execute(command, showResult = true) {
      const operation = record(await rpc.start({ command }, requestOptions()));
      operations.set(operation.id, operation);
      watched.add(operation.id);
      let view = operation;
      const dialogID = operation.id;
      activeDialog = dialogID;
      context.ui.dialog.set({ size: 'large' });
      const selection = context.ui.dialog.select({ title: `${title} · Running ${command.split(/\s/)[0] || 'action'}`,
        options: [
          { title: 'Continue working', value: 'background', description: 'The action keeps running. View it in MainSequence → Recent actions.' },
          { title: 'Cancel action', value: 'cancel', description: 'Stop the operation and report any incomplete changes.' },
        ],
        actions: [{ bind: 'ctrl+c', title: 'Cancel action', selection: 'none', onTrigger: () => { void rpc.cancel({ id: dialogID }, requestOptions()).catch(() => toast('Could not request cancellation.', 'error')); } }],
      }).then(async choice => {
        if (activeDialog === dialogID) activeDialog = '';
        if (choice === 'cancel') await rpc.cancel({ id: dialogID }, requestOptions());
        return choice;
      }).catch(() => { toast('Could not request cancellation.', 'error'); });
      try {
        // Events provide live progress; polling also recovers completions missed on reconnect.
        while (!disposed && view.status === 'running') {
          const latest = await rpc.get({ id: operation.id }, requestOptions());
          if (!latest) throw new Error('Action no longer available.');
          view = record(latest); operations.set(operation.id, view);
          if (view.status === 'running') await new Promise(resolve => setTimeout(resolve, 350));
        }
        if (disposed) return undefined;
        const ownDialog = activeDialog === dialogID;
        if (ownDialog) { activeDialog = ''; context.ui.dialog.clear(); }
        await selection;
        toast(view.progress, view.status === 'success' ? 'success' : 'error');
        if (showResult && ownDialog) await context.ui.dialog.alert({ title: `${title} · ${view.status === 'success' ? 'Completed' : view.status === 'cancelled' ? 'Cancelled' : 'Failed'}`,
          message: view.display || 'The action finished.' });
        return view.result;
      } finally {
        watched.delete(operation.id);
        if (activeDialog === dialogID) { activeDialog = ''; context.ui.dialog.clear(); }
      }
    }
    /** @param {string} command */
    async function discover(command) {
      let baseCommand = command.replace(/\s--offset\s+\d+/, '');
      let queryCommand = command;
      let offset = Number(command.match(/\s--offset\s+(\d+)/)?.[1] || 0);
      while (!disposed) {
        const result = await execute(queryCommand, false);
        if (!result || result.status !== 'success') { if (result) await context.ui.dialog.alert({ title, message: presentation.displayOpenCodeResult(result) }); return; }
        const page = record(result.data);
        const rows = Array.isArray(page.results) ? page.results : [];
        /** @type {any[]} */
        const options = rows.map((/** @type {any} */ row) => ({ title: presentation.connectionLabel(row),
          value: row, description: `Release ${row.resource_release_uid}`, category: 'Available project MCPs' }));
        if (page.count > offset + rows.length && rows.length > 0) options.push({ title: 'Next page', value: 'next', category: 'Browse' });
        options.push({ title: 'Search projects', value: 'search', category: 'Browse' });
        const choice = await context.ui.dialog.select({ title: `${title} · Connect an MCP`, options });
        if (!choice) return;
        if (choice === 'search') {
          const search = await context.ui.dialog.prompt({ title: `${title} · Search MCPs`, placeholder: 'Project or Environment name' });
          if (search === undefined) return;
          offset = 0; baseCommand = `mcp-discover --search ${JSON.stringify(search)}`; queryCommand = baseCommand; continue;
        }
        if (choice === 'next') { offset += rows.length; queryCommand = baseCommand + ` --offset ${offset}`; continue; }
        await execute(`mcp-add --uid ${choice.resource_release_uid} --backend ${JSON.stringify(choice.backend)}`);
        return;
      }
    }
    async function manage() {
      const result = await execute('mcp-list', false);
      if (!result || result.status !== 'success') { if (result) await context.ui.dialog.alert({ title, message: presentation.displayOpenCodeResult(result) }); return; }
      const rows = Array.isArray(result.data) ? result.data : [];
      if (!rows.length) { await context.ui.dialog.alert({ title, message: 'No project MCPs connected. Choose “Connect a project MCP” to get started.' }); return; }
      const choice = await context.ui.dialog.select({ title: `${title} · Connected MCPs`, options: rows.map((/** @type {any} */ row) => ({ title: presentation.connectionLabel(row), value: row, description: `Release ${row.resource_release_uid}` })) });
      if (!choice) return;
      const action = await context.ui.dialog.select({ title: presentation.connectionLabel(choice), options: [
        { title: 'View current tools', value: 'mcp-tools' }, { title: 'Disconnect', value: 'mcp-remove', description: 'Forget this selection. Keep your developer login.' },
      ] });
      if (action) await execute(`${action} --uid ${choice.resource_release_uid} --backend ${JSON.stringify(choice.backend)}`);
    }
    async function history() {
      const state = record(await rpc.state({}, requestOptions()));
      const items = Array.isArray(state.operations) ? state.operations : [];
      if (!items.length) { await context.ui.dialog.alert({ title, message: 'No actions yet. Enter /ms to get started.' }); return; }
      const choice = await context.ui.dialog.select({ title: `${title} · Recent actions`, options: items.slice().reverse().map((/** @type {any} */ op) => ({ title: op.command || 'Help', value: op, description: `${op.status} · ${op.progress}` })) });
      if (!choice) return;
      if (choice.status === 'running') {
        const cancel = await context.ui.dialog.confirm({ title: `${title} · Action running`, message: choice.progress, label: { confirm: 'Cancel action', cancel: 'Keep running' } });
        if (cancel) await rpc.cancel({ id: choice.id }, requestOptions());
      } else await context.ui.dialog.alert({ title, message: choice.display || 'The action finished.' });
    }
    /** @param {string | undefined} input */
    async function dispatch(input) {
      try {
        const command = (input || '').replace(/^\/ms(?:\s+|$)/, '').trim();
        if (!command) {
          const choice = await context.ui.dialog.select({ title: `${title} · Developer tools`, placeholder: 'Choose an action…', options: presentation.openCodeActions.map(action => ({ title: action.title, value: action.action, category: action.group })) });
          if (!choice) return;
          if (choice === 'setup') {
            const args = await context.ui.dialog.prompt({ title: `${title} · Set up a project`, placeholder: '--uid UID --branch BRANCH --base-dir DIR' });
            if (args !== undefined) await execute(`setup ${args}`);
          } else await dispatch(choice);
          return;
        }
        if (command === 'history') return await history();
        if (command === 'mcp-list') return await manage();
        if (/^mcp-discover(?:\s|$)/.test(command)) return await discover(command);
        await execute(command);
      } catch { toast('Could not reach the MainSequence server plugin. Check the installation and reconnect or restart OpenCode.', 'error'); }
    }
    context.keymap.layer(() => ({ mode: 'global', commands: [
      { id: 'mainsequence.ms', title: 'MainSequence developer tools', group: title, palette: true, slash: { name: 'ms', arguments: true }, run: dispatch },
      { id: 'mainsequence.sync', title: 'Refresh project dependencies', group: title, palette: true, run: () => dispatch('sync') },
      { id: 'mainsequence.account', title: 'MainSequence account status', group: title, palette: true, run: () => dispatch('auth-status') },
      { id: 'mainsequence.mcp', title: 'Connect a MainSequence project MCP', group: title, palette: true, run: () => dispatch('mcp-discover') },
      { id: 'mainsequence.history', title: 'MainSequence recent actions', group: title, palette: true, run: history },
    ] }));
    return () => { disposed = true; unsubscribe(); if (activeDialog) context.ui.dialog.clear(); };
  },
});
