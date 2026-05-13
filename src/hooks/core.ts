import type { TeamemTools } from '../server/tools/index.js';

export type HookContext = {
  space_id: string;
  principal: string;
  actor: string;
  delegation: string;
};

export type DeferredEvent = {
  payload: unknown;
  reason: string;
};

export class DeferredQueue {
  private readonly queue: DeferredEvent[] = [];

  enqueue(event: DeferredEvent): void {
    this.queue.push(event);
  }

  drain(): DeferredEvent[] {
    const drained = [...this.queue];
    this.queue.length = 0;
    return drained;
  }

  size(): number {
    return this.queue.length;
  }
}

export function publishWithRetry(
  tools: TeamemTools,
  payload: unknown,
  deferred: DeferredQueue,
  retries = 2
): boolean {
  let attempt = 0;
  while (attempt <= retries) {
    const result = tools.publishEvent(payload);
    if (result.ok) {
      return true;
    }
    attempt += 1;
  }

  deferred.enqueue({ payload, reason: 'publish_failed_after_retries' });
  return false;
}

export function flushDeferred(
  tools: TeamemTools,
  deferred: DeferredQueue
): { flushed: number } {
  const items = deferred.drain();
  let flushed = 0;

  for (const item of items) {
    const result = tools.publishEvent(item.payload);
    if (result.ok) {
      flushed += 1;
    }
  }

  return { flushed };
}
