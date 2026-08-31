/**
 * ═══ THE RESCUE PATH MUST TERMINATE (Dan 2026-08-31) ═════════════════════════
 *
 * The first version of this reconciliation lived inline in TablePage and could
 * not stop. It grew the players array with NULL rows, so its own early-return
 * guard (`players[seat-1]?.id === userId`) never became true; every pass
 * returned a fresh array identity, the effect's deps changed, and it ran again.
 * An infinite render loop — armed on exactly the path that fires when a player
 * is stranded in a seat their client is not drawing.
 *
 * The first test below is that bug. If it ever fails again, the loop is back.
 */
import { describe, it, expect } from 'vitest';
import { reconcileHeroSeatFromEngine, MAX_SUPPORTED_SEATS } from '@/lib/heroSeatReconcile';
import { SEAT_LAYOUTS, seatLayoutFor } from '@/lib/tableSeatGeometry';

const HERO = 'hero-user-id';

/** Apply a patch the way TablePage's reducer does, so tests mirror reality. */
function apply(
  prev: { players: ({ id?: string } | null)[]; maxPlayers: number; heroSeat: number },
  patch: ReturnType<typeof reconcileHeroSeatFromEngine>
) {
  if (!patch) return prev;
  return {
    players: (patch.players as ({ id?: string } | null)[]) ?? prev.players,
    maxPlayers: patch.maxPlayers ?? prev.maxPlayers,
    heroSeat: patch.heroSeat ?? prev.heroSeat,
  };
}

describe('reconcileHeroSeatFromEngine — it must settle', () => {
  it('REGRESSION: reaches a fixed point instead of looping forever', () => {
    // Six rendered seats, engine says the hero is in seat 8: the stranded case.
    let state = {
      players: Array(6).fill(null) as ({ id?: string } | null)[],
      maxPlayers: 6,
      heroSeat: 0,
    };

    const first = reconcileHeroSeatFromEngine(state, 8, HERO);
    expect(first).not.toBeNull(); // it does act the first time
    state = apply(state, first);

    // ...and having acted, it must have NOTHING further to say. This is the
    // assertion the inline version failed: it returned a new object forever.
    expect(reconcileHeroSeatFromEngine(state, 8, HERO)).toBeNull();

    // Belt and braces: hammer it the way a snapshot stream would.
    for (let i = 0; i < 50; i++) {
      expect(reconcileHeroSeatFromEngine(state, 8, HERO)).toBeNull();
    }
  });

  it('the one pass it does take fixes all three facts at once', () => {
    const state = {
      players: Array(6).fill(null) as ({ id?: string } | null)[],
      maxPlayers: 6,
      heroSeat: 0,
    };
    const next = apply(state, reconcileHeroSeatFromEngine(state, 8, HERO));
    expect(next.players.length).toBe(8);
    expect(next.maxPlayers).toBe(8);
    expect(next.heroSeat).toBe(8);
  });

  it('says nothing when the client already renders the hero there', () => {
    const players: ({ id?: string } | null)[] = Array(9).fill(null);
    players[6] = { id: HERO };
    expect(
      reconcileHeroSeatFromEngine({ players, maxPlayers: 9, heroSeat: 7 }, 7, HERO)
    ).toBeNull();
  });

  it('never trims: a shorter engine seat leaves a longer array alone', () => {
    // A null row renders an empty seat; a dropped row erases a player. Only
    // one of those is recoverable, so this function only ever grows.
    const players: ({ id?: string } | null)[] = Array(9).fill(null);
    players[8] = { id: 'someone-else' };
    const patch = reconcileHeroSeatFromEngine({ players, maxPlayers: 9, heroSeat: 0 }, 2, HERO);
    const next = apply({ players, maxPlayers: 9, heroSeat: 0 }, patch);
    expect(next.players.length).toBe(9);
    expect(next.maxPlayers).toBe(9);
    expect(next.players[8]).toEqual({ id: 'someone-else' });
  });

  it('does not fight an existing seat claim, but still grows the ring for it', () => {
    const state = {
      players: Array(6).fill(null) as ({ id?: string } | null)[],
      maxPlayers: 6,
      heroSeat: 3, // another path already proved a seat; leave that belief alone
    };
    const next = apply(state, reconcileHeroSeatFromEngine(state, 8, HERO));
    expect(next.heroSeat).toBe(3);
    expect(next.players.length).toBe(8);
    // And it settles from there too.
    expect(reconcileHeroSeatFromEngine(next, 8, HERO)).toBeNull();
  });

  it('refuses a garbage seat rather than allocating for it', () => {
    // The seat number comes off the wire. Unbounded growth would turn a
    // rendering disagreement into a hung tab.
    const state = { players: [] as ({ id?: string } | null)[], maxPlayers: 6, heroSeat: 0 };
    for (const bad of [0, -1, 1.5, NaN, 1e9, MAX_SUPPORTED_SEATS + 1]) {
      expect(reconcileHeroSeatFromEngine(state, bad, HERO)).toBeNull();
    }
  });

  it('refuses to act without a user id', () => {
    const state = { players: [] as ({ id?: string } | null)[], maxPlayers: 6, heroSeat: 0 };
    expect(reconcileHeroSeatFromEngine(state, 5, '')).toBeNull();
  });

  it('never grows past a seat the client can actually DRAW', () => {
    /* The bound and the seat rings must be the same number. The first cut of
       this module declared `MAX_SUPPORTED_SEATS = 10` as its own literal for
       "headroom" while SEAT_LAYOUTS stops at 9 — which would have grown ten
       rows of state against nine drawable positions, so seat 10 would exist
       and render nowhere. That is the very bug this module prevents, planted
       one layer up by a copied number. It is derived now; this pins that. */
    const drawable = Object.keys(SEAT_LAYOUTS).reduce((m, k) => Math.max(m, Number(k)), 0);
    expect(MAX_SUPPORTED_SEATS).toBe(drawable);

    // And the largest seat it WILL accept has a ring to be drawn on.
    const state = { players: [] as ({ id?: string } | null)[], maxPlayers: 2, heroSeat: 0 };
    expect(reconcileHeroSeatFromEngine(state, MAX_SUPPORTED_SEATS, HERO)).not.toBeNull();
    expect(seatLayoutFor(MAX_SUPPORTED_SEATS).length).toBeGreaterThanOrEqual(MAX_SUPPORTED_SEATS);
  });
});
