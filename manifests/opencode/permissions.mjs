// @ts-check
import { Plugin } from '@opencode/plugin/effect';
import { fromPromise } from '@opencode/plugin/promise/adapter';
import { Context, Effect, Option, Schema } from 'effect';

// The host supplies effect, but does not expose @opencode/schema as a runtime
// import. Match the public Tool.Error shape without installing another package.
/** @type {new (props: {message: string}) => import('@opencode/schema/tool').Error} */
const ToolError = /** @type {any} */ (Schema.TaggedError()('Tool.Error', { message: Schema.String }));

/** @typedef {{assert: (input: object) => import('effect').Effect.Effect<void, unknown>}} NativePermissionService */
/** @type {import('effect').Context.Service<NativePermissionService, NativePermissionService>} */
const NativePermission = Context.Service('@opencode/Permission');

/** @param {import('@opencode/plugin').Plugin.Plugin} server */
export function withNativePermissions(server) {
  return Plugin.define({
    id: server.id,
    effect: ctx => Effect.gen(function* () {
      yield* fromPromise(server).effect(ctx);
      // Replay after the server's registrations on every catalog reload. Resolve
      // permission in the executing tool fiber, not the restricted setup context.
      yield* ctx.tool.transform(editor => {
        for (const tool of editor.list()) {
          const action = tool.options?.permission;
          if (!action?.startsWith('mainsequence_')) continue;
          editor.update(tool.id, draft => {
            draft.execute = (input, context) => Effect.gen(function* () {
              const service = Option.getOrUndefined(yield* Effect.serviceOption(NativePermission));
              if (!service || typeof service.assert !== 'function') return yield* Effect.fail(new ToolError({
                message: 'This OpenCode version cannot enforce native project-tool permissions. No tool was executed.',
              }));
              yield* service.assert({ action, resources: ['*'], save: ['*'], metadata: {}, sessionID: context.sessionID, agent: context.agent,
                source: { type: 'tool', messageID: context.messageID, id: context.id } }).pipe(
                  Effect.catch(error => Effect.fail(new ToolError({ message: 'OpenCode did not permit this tool: ' + String(error) }))));
              return yield* tool.execute(input, context);
            });
          });
        }
      });
    }),
  });
}
