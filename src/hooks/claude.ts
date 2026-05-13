import type { TeamemTools } from '../server/tools/index.js';
import {
  DeferredQueue,
  flushDeferred,
  publishWithRetry,
  type HookContext
} from './core.js';

export type ClaudeHookAdapter = ReturnType<typeof createClaudeHookAdapter>;

export function createClaudeHookAdapter(
  tools: TeamemTools,
  deferred = new DeferredQueue()
) {
  return {
    onSessionStart(context: HookContext) {
      return tools.getBriefing({
        space_id: context.space_id,
        principal: context.principal
      });
    },

    onPostAction(_context: HookContext, payload: unknown) {
      return publishWithRetry(tools, payload, deferred);
    },

    flushDeferred() {
      return flushDeferred(tools, deferred);
    }
  };
}
