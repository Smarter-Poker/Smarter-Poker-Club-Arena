import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseFleetManager } from './HorseFleetManager.js';
import { supabase } from './supabase.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';

type Page = { data: { id: string }[] | null; error: unknown };
type Harness = {
  isRunning: boolean;
  lifecycleGeneration: number;
  seeding: boolean;
  launchSeedCycle(generation: number, context: string): void;
  publishFleetState(beat: { reason: string }, duration: number): Promise<void>;
  stop(): Promise<void>;
  humansWaitingByTable(ids: Set<string>, current: () => boolean): Promise<unknown>;
  pruneHorseWaitlist(ids: Set<string>, current: () => boolean): Promise<void>;
  claimOfferedSeats(...args: unknown[]): Promise<number>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setMaintenanceFrozen(false);
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  setMaintenanceFrozen(false);
});

describe('cash seeding withdraws reads without abandoning its final write', () => {
  it.each(['full', 'empty', 'failed'] as const)(
    'stops after a %s table page and keeps the heartbeat owned',
    async (kind) => {
      const page = deferred<Page>();
      const beat = deferred<void>();
      const builder: Record<string, unknown> = {};
      for (const name of ['select', 'is', 'in', 'order', 'limit', 'gt'])
        builder[name] = () => builder;
      let reads = 0;
      builder.then = (resolve: (value: Page) => unknown, reject: (error: unknown) => unknown) => {
        reads++;
        return (reads === 1 ? page.promise : Promise.resolve({ data: [], error: null })).then(
          resolve,
          reject
        );
      };
      const from = vi.spyOn(supabase, 'from').mockReturnValue(builder as never);
      const fleet = new HorseFleetManager() as unknown as Harness;
      const publish = vi.spyOn(fleet, 'publishFleetState').mockReturnValue(beat.promise);
      fleet.isRunning = true;
      fleet.lifecycleGeneration = 7;
      fleet.launchSeedCycle(7, 'test.seed');
      await vi.waitFor(() => expect(reads).toBe(1));
      let stopped = false;
      const stop = fleet.stop().then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);
      page.resolve({
        data:
          kind === 'failed'
            ? null
            : kind === 'empty'
              ? []
              : Array.from({ length: 1000 }, (_, index) => ({ id: String(index) })),
        error: kind === 'failed' ? new Error('timeout') : null,
      });
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
      expect(stopped).toBe(false);
      beat.resolve();
      await stop;
      expect(from).toHaveBeenCalledOnce();
      expect(reads).toBe(1);
      expect(publish.mock.calls[0][0].reason).toBe('lifecycle_stopped');
      expect(fleet.seeding).toBe(false);
    }
  );

  it.each(['human queue', 'horse queue', 'seat offers'] as const)(
    'withdraws the %s read before acting on its rows',
    async (kind) => {
      const page = deferred<Page>();
      const builder: Record<string, unknown> = {};
      for (const name of ['select', 'is', 'in', 'eq', 'order', 'limit', 'gt'])
        builder[name] = () => builder;
      let reads = 0;
      builder.then = (resolve: (value: Page) => unknown, reject: (error: unknown) => unknown) => {
        reads++;
        return (reads === 1 ? page.promise : Promise.resolve({ data: [], error: null })).then(
          resolve,
          reject
        );
      };
      const from = vi.spyOn(supabase, 'from').mockReturnValue(builder as never);
      const fleet = new HorseFleetManager() as unknown as Harness;
      fleet.isRunning = true;
      fleet.lifecycleGeneration = 7;
      const current = () => fleet.isRunning && fleet.lifecycleGeneration === 7;
      const ids = new Set(['horse']);
      const work =
        kind === 'human queue'
          ? fleet.humansWaitingByTable(ids, current)
          : kind === 'horse queue'
            ? fleet.pruneHorseWaitlist(ids, current)
            : fleet.claimOfferedSeats(
                [],
                [],
                new Map(),
                false,
                ids,
                {},
                new Set(),
                Infinity,
                undefined,
                undefined,
                current
              );
      await vi.waitFor(() => expect(reads).toBe(1));
      await fleet.stop();
      page.resolve({
        data: Array.from({ length: 1000 }, (_, index) => ({
          id: String(index),
          user_id: 'horse',
          table_id: 'table',
        })),
        error: null,
      });
      await work;
      expect(reads).toBe(1);
      expect(from).toHaveBeenCalledOnce();
    }
  );
});
