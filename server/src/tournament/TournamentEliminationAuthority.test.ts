import { describe, expect, it, vi } from 'vitest';
import { TournamentEliminationScheduler } from './TournamentEliminationScheduler.js';
import {
  bindTournamentDataAuthority,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';

const a = {
  tournamentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leaseGeneration: '11111111-1111-4111-8111-111111111111',
};
const b = {
  tournamentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  leaseGeneration: '22222222-2222-4222-8222-222222222222',
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function fixture() {
  const scheduler = new TournamentEliminationScheduler({
    maxConcurrent: 1,
    startTimers: false,
    sweepWarnMs: 0,
  });
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const authority of [a, b]) {
    runWithTournamentDataAuthority(authority, () =>
      scheduler.register({
        tournamentId: authority.tournamentId,
        isActive: bindTournamentDataAuthority(authority, () => {
          expect(currentTournamentDataAuthority()).toEqual(authority);
          return true;
        }),
        run: bindTournamentDataAuthority(authority, async () => {
          expect(currentTournamentDataAuthority()).toEqual(authority);
          seen.push(authority.tournamentId);
          if (authority === a) await held;
          await Promise.resolve();
          expect(currentTournamentDataAuthority()).toEqual(authority);
          // Cross-authority escalation inside actual manager work is STILL refused.
          expect(() => runWithTournamentDataAuthority(authority === a ? b : a, () => {})).toThrow(
            'cannot be rebound'
          );
        }),
      })
    );
  }
  return { scheduler, seen, release };
}

describe('shared elimination scheduler preserves each registered authority', () => {
  it('can wake B while the caller is A without re-entering B inside A', async () => {
    const f = fixture();
    try {
      expect(() =>
        runWithTournamentDataAuthority(a, () => f.scheduler.wake(b.tournamentId))
      ).not.toThrow();
    } finally {
      f.scheduler.stop();
      f.release();
      await flush();
    }
  });
  it('completion of A dispatches queued B under B, then restores the caller context', async () => {
    const f = fixture();
    try {
      await flush();
      expect(f.seen).toEqual([a.tournamentId]);
      f.release();
      await flush();
      expect(f.seen).toEqual([a.tournamentId, b.tournamentId]);
      expect(f.scheduler.snapshot()).toMatchObject({ running: 0, queued: 0 });
      expect(currentTournamentDataAuthority()).toBeNull();
    } finally {
      f.scheduler.stop();
      f.release();
      await flush();
    }
  });
});

describe('production timer and manager cleanup entry points', () => {
  it('a timer armed by A dispatches B in its registration context', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      startTimers: false,
      sweepWarnMs: 0,
    });
    const seen: string[] = [];
    try {
      for (const authority of [a, b]) {
        runWithTournamentDataAuthority(authority, () =>
          scheduler.register({
            tournamentId: authority.tournamentId,
            isActive: bindTournamentDataAuthority(authority, () => {
              expect(currentTournamentDataAuthority()).toEqual(authority);
              return true;
            }),
            run: bindTournamentDataAuthority(authority, async () => {
              await Promise.resolve();
              expect(currentTournamentDataAuthority()).toEqual(authority);
              seen.push(authority.tournamentId);
            }),
          })
        );
      }
      await flush();
      expect(seen).toEqual([a.tournamentId, b.tournamentId]);
      seen.length = 0;
      // Real Node timer, not a fake clock that loses AsyncLocalStorage context.
      runWithTournamentDataAuthority(a, () => scheduler.wakeAfter(b.tournamentId, 5));
      await vi.waitFor(() => expect(seen).toEqual([b.tournamentId]));
      expect(currentTournamentDataAuthority()).toBeNull();
      expect(scheduler.snapshot()).toMatchObject({ running: 0, queued: 0, pendingWakes: 0 });
    } finally {
      scheduler.stop();
    }
  });

  it('unregistering A inspects queued B under B and retains physical capacity', async () => {
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: 1,
      startTimers: false,
      sweepWarnMs: 0,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    let unregister!: () => void;
    let bChecks = 0;
    try {
      runWithTournamentDataAuthority(a, () => {
        unregister = scheduler.register({
          tournamentId: a.tournamentId,
          run: bindTournamentDataAuthority(a, async () => {
            seen.push(a.tournamentId);
            await held;
          }),
        });
      });
      runWithTournamentDataAuthority(b, () =>
        scheduler.register({
          tournamentId: b.tournamentId,
          isActive: bindTournamentDataAuthority(b, () => {
            bChecks++;
            expect(currentTournamentDataAuthority()).toEqual(b);
            return true;
          }),
          run: bindTournamentDataAuthority(b, async () => {
            seen.push(b.tournamentId);
          }),
        })
      );
      await flush();
      expect(seen).toEqual([a.tournamentId]);
      expect(() => runWithTournamentDataAuthority(a, unregister)).not.toThrow();
      // Removing the logical registration cannot release an unfinished promise's slot.
      expect(scheduler.snapshot()).toMatchObject({ registered: 1, running: 1, queued: 1 });
      release();
      await flush();
      expect(seen).toEqual([a.tournamentId, b.tournamentId]);
      expect(bChecks).toBeGreaterThan(1);
      expect(scheduler.snapshot()).toMatchObject({ registered: 1, running: 0, queued: 0 });
    } finally {
      scheduler.stop();
      release();
      await flush();
    }
  });
});
