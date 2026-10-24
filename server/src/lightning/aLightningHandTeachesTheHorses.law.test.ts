/**
 * LAW (Dan, 2026-10-24): EVERY LIGHTNING HAND TEACHES THE HORSES, AND A SHOVE
 * IS AGGRESSION.
 *
 * "HORSES NEED TO MAKE REAL TIME READS, AND USE ANY AND ALL PLAYER DATA ON THE
 * VERY FIRST HAND EVERY SINGLE TIME THEY START A NEW HAND AT A NEW TABLE WITH
 * NEW PLAYERS."
 *
 *   1. A settled Lightning hand reaches the live horse lane as the same
 *      completed-hand observation a physical table sends (observeCompletedHand):
 *      table:hand key, a table:hand:lease:observe fence, the committed hand id,
 *      the accepted actions, the showdown and the V45 read scope - and the
 *      actors' durable profiles, read after the commit, in the hand's own
 *      size bucket. Before this, no Lightning hand was ever observed.
 *   2. An all-in that is a full raise carries `isFullRaise: true` in the
 *      accepted action, as at a table. Without it both learners counted every
 *      Lightning shove as neither aggression nor passivity.
 *   3. Teaching the horses never holds or endangers the hand: a lane that
 *      throws still leaves the hand settled exactly once.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning law fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning law fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const { readScopeOf } = await import('../engine/HorseMind.js');
const kit = await import('../testing/lightningHostTestKit.js');

/** The first voluntary actor shoves; everyone after folds. */
function shoveThenFold() {
  let shoved = false;
  return (_user: string, legal: string[]) => {
    if (!shoved && legal.includes('all_in')) {
      shoved = true;
      return 'all_in';
    }
    return legal.includes('fold') ? 'fold' : 'check';
  };
}

async function playHand(base: number, opts: Parameters<typeof kit.buildHost>[2] = {}, n = 3) {
  const formed = kit.formedHand(n, base);
  const t = kit.buildHost(
    formed,
    Array.from({ length: n }, () => 100),
    opts
  );
  await t.host.start();
  await kit.playOut(t.host, mulberry32(base), shoveThenFold());
  await kit.flush(40);
  return t;
}

describe('LAW: every Lightning hand teaches the horses', () => {
  it('a settled hand is observed once, exactly as a physical table observes it', async () => {
    const t = await playHand(8100);
    expect(t.host.lifecycle).toBe('complete');
    expect(t.calls.settle.length).toBe(1);
    expect(t.horseLane.observed.length).toBe(1);
    const o = t.horseLane.observed[0]!;
    const h = t.host as any;
    expect(o.handKey).toBe(`${h.hostTableId}:${h.handNumber}`);
    expect(o.fence).toBe(`${h.hostTableId}:${h.handNumber}:${kit.uid(4242)}:observe`);
    expect(o.generation).toBe(h.handNumber);
    expect(o.committedHandId).toBe(kit.uid(7777));
    expect(o.bigBlind).toBeGreaterThan(0);
    expect(o.scope).toBe(readScopeOf('nlh', 3));
    // The accepted action stream, every actor named.
    expect(o.actions!.length).toBe(h.actions.length);
    expect(o.actions!.every((a) => typeof a.userId === 'string' && a.userId.length > 0)).toBe(true);
    // No durable schema in this fixture: no profile read, and none claimed.
    expect(o.durableOpponentProfiles).toBeUndefined();
  });

  it('the actors’ durable profiles ride the observation, read in the hand’s own bucket', async () => {
    const reads: unknown[][] = [];
    const t = await playHand(8200, {
      deps: {
        horseObservation: {
          schema: async () => 'installed',
          readProfiles: async (...args: unknown[]) => {
            reads.push(args);
            return [];
          },
          report: () => {},
        },
      },
    });
    expect(t.horseLane.observed.length).toBe(1);
    expect(reads.length).toBe(1);
    const [ids, variant, mode, size] = reads[0] as [string[], string, string, string];
    expect(new Set(ids)).toEqual(
      new Set((t.host as any).actions.map((a: { userId: string }) => a.userId))
    );
    expect([variant, mode, size]).toEqual(['nlh', 'cash', 'short']);
    expect(t.horseLane.observed[0]!.durableOpponentProfiles).toEqual([]);
  });

  it('a game with no durable memory is still observed (fixed-limit, FLO8, short deck)', async () => {
    const readProfiles = vi.fn(async () => []);
    const t = await playHand(8300, {
      rules: { game_variant: 'short_deck' },
      deps: {
        horseObservation: { schema: async () => 'installed', readProfiles, report: () => {} },
      },
    });
    expect(t.horseLane.observed.length).toBe(1);
    expect(readProfiles).not.toHaveBeenCalled();
    expect(t.horseLane.observed[0]!.scope).toBe(readScopeOf('short_deck', 3));
  });

  it('a failing lane never holds or repeats the settled hand', async () => {
    const report = vi.fn();
    const formed = kit.formedHand(3, 8400);
    const t = kit.buildHost(formed, [100, 100, 100], {
      deps: { horseObservation: { schema: async () => 'unavailable', report } },
    });
    (t.horseLane.raw.observeCompletedHand as any).mockImplementation(() => {
      throw new Error('lane down');
    });
    await t.host.start();
    await kit.playOut(t.host, mulberry32(8400), shoveThenFold());
    await kit.flush(40);
    expect(t.host.lifecycle).toBe('complete');
    expect(t.calls.settle.length).toBe(1);
    expect(report).toHaveBeenCalled();
  });
});

describe('LAW: a Lightning shove is aggression', () => {
  it('a full-raise all-in carries isFullRaise: true into the accepted action', async () => {
    const t = await playHand(8500);
    const actions = (t.host as any).actions as Array<Record<string, unknown>>;
    const shoves = actions.filter((a) => a.action === 'all_in');
    expect(shoves.length).toBe(1);
    expect(shoves[0]!.isFullRaise).toBe(true);
    // ...and the observation the horses learn from says the same.
    const observed = t.horseLane.observed[0]!.actions!.filter((a) => a.action === 'all_in');
    expect(observed[0]!.isFullRaise).toBe(true);
  });
});

describe('LAW: a Lightning action carries the price it was taken at', () => {
  it('every voluntary action carries the controller public action node, as at a table', async () => {
    const t = await playHand(8600);
    const actions = (t.host as any).actions as Array<Record<string, any>>;
    const voluntary = actions.filter((a) => a.origin !== 'forced' && a.action !== 'return');
    expect(voluntary.length).toBeGreaterThan(0);
    for (const a of voluntary) {
      expect(a.publicNode).toBeTruthy();
      expect(a.publicNode.status).toBe('captured');
      expect(a.publicNode.street).toBe(a.stage);
      expect(a.publicNode.actorSeat).toBe(a.seat);
    }
    const observed = t.horseLane.observed[0]!.actions!.filter((a) => a.publicNode);
    expect(observed.length).toBe(voluntary.length);
  });
});

describe('LAW: a Lightning hand carries its results to the winner read', () => {
  it('every dealt player net, from settlement, conserving the pot less the drop', async () => {
    const t = await playHand(8700);
    const o = t.horseLane.observed[0]!;
    const settled = t.calls.settle[0]!;
    expect(o.results!.length).toBe(settled.results.length);
    for (const r of settled.results)
      expect(o.results!.find((x) => x.user_id === r.playerId)!.net).toBeCloseTo(
        r.won - r.contributed,
        2
      );
    const sum = o.results!.reduce((a, r) => a + r.net, 0);
    expect(sum).toBeCloseTo(-(settled.rake + settled.bbj), 2);
  });
});
