import { Rpc } from '@opencode/plugin/rpc';

const id = { type: 'object', properties: { id: { type: 'string', maxLength: 100 } }, required: ['id'], additionalProperties: false };
const result = { type: 'object', properties: {
  schemaVersion: { const: 1 }, action: { type: 'string' }, status: { enum: ['success', 'failure', 'cancelled'] }, summary: { type: 'string' }, data: {},
  error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'], additionalProperties: false },
  effects: { type: 'object', properties: { state: { const: 'partial-or-uncertain' }, message: { type: 'string' } }, required: ['state', 'message'], additionalProperties: false },
}, required: ['schemaVersion', 'action', 'status', 'summary'], additionalProperties: false };
const operation = { type: /** @type {const} */ ('object'), properties: {
  id: { type: 'string' }, command: { type: 'string' }, status: { enum: ['running', 'success', 'failure', 'cancelled'] }, progress: { type: 'string' }, result, display: { type: 'string' },
}, required: ['id', 'command', 'status', 'progress'], additionalProperties: false };
const state = { type: 'object', properties: { directory: { type: 'string' }, operations: { type: 'array', items: operation },
  actions: { type: 'array', items: { type: 'object', properties: { action: { type: 'string' }, title: { type: 'string' }, group: { type: 'string' } }, required: ['action', 'title', 'group'], additionalProperties: false } },
}, required: ['directory', 'operations', 'actions'], additionalProperties: false };
export const MainSequence = Rpc.define({
  id: 'mainsequence',
  methods: {
    start: { input: { type: 'object', properties: { command: { type: 'string', maxLength: 10000 } }, required: ['command'], additionalProperties: false }, output: operation },
    get: { input: id, output: { anyOf: [operation, { type: 'null' }] } },
    cancel: { input: id, output: { type: 'boolean' } },
    state: { input: { type: 'object', additionalProperties: false }, output: state },
    refresh: { input: { type: 'object', additionalProperties: false }, output: result },
  },
  events: { updated: { schema: operation } },
});
