import type { TeamemEvent } from '../../domain/events/types.js';

export type EventStore = {
  append(event: TeamemEvent): void;
  getById(eventId: string): TeamemEvent | null;
  getUpdates(
    repoId: string,
    sinceTimestamp?: string,
    limit?: number
  ): TeamemEvent[];
};
