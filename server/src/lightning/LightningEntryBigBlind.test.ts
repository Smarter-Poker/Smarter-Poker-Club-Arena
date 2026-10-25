/**
 * THE ENTRY BIG BLIND, DEALT (20261025050528). Dan 2026-10-24: "NEW PLAYERS
 * SHOULD ALWAYS BE BB FIRST." When holding a newcomer would leave a Lightning
 * pass no hand, the barrier seats them as blind_role 'entry_bb' and the host
 * has HandController post a LIVE big blind from their seat: one big blind, in
 * the pot, counted toward their call, and they keep the option exactly as the
 * big blind does. The real big blind and everybody else's blinds are
 * unchanged; an entry poster who holds seat 1 (a pool with nobody else to
 * hold it) posts that instead of the small blind, which is dead. Settlement
 * conserves chips like any hand. Horses are players (CLAUDE.md 10.5): the
 * fixtures mix them and nothing here branches on one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning host fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning host fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { LIGHTNING_ENTRY_BIG_BLIND_ROLE } = await import('./LightningHandHost.js');
const { buildHost, formedHand, flush, playOut } = kit;

afterEach(() => {
  vi.useRealTimers();
});

type Participant = Parameters<
  NonNullable<Parameters<typeof buildHost>[2]>['participantsOverride'] & {}
>[0][number];

/** The barrier's roles, with the given seats posting an entry big blind. */
const entryAt =
  (...seats: number[]) =>
  (ps: Participant[]) =>
    ps.map((p) =>
      seats.includes(p.seat) ? { ...p, blindRole: LIGHTNING_ENTRY_BIG_BLIND_ROLE } : p
    );

const bySeat = (host: any, seat: number) =>
  host.peekState()!.players.find((p: any) => p.seat === seat)!;
const legalFor = (host: any, userId: string): string[] =>
  host.hc.getAuthoritativeActionState(userId)?.legalActions ?? [];

function conserve(settle: any, before: Map<string, number>) {
  const total = [...before.values()].reduce((a, b) => a + b, 0);
  const after = settle.results.reduce((a: number, r: any) => a + r.stackAfter, 0);
  expect(Math.round((after + settle.rake + settle.bbj) * 100)).toBe(Math.round(total * 100));
  for (const r of settle.results) {
    expect(Math.round((before.get(r.playerId)! - r.contributed + r.won) * 100)).toBe(
      Math.round(r.stackAfter * 100)
    );
  }
}

describe('a Lightning entry big blind is one live big blind, posted from the seat', () => {
  it('posts the big blind from seat 3: stack, pot and the price for everyone else', async () => {
    const formed = formedHand(6, 300);
    const t = buildHost(formed, [200, 200, 200, 200, 200, 200], {
      participantsOverride: entryAt(3),
      horses: new Set([formed.players[2], formed.players[4]]),
    });
    await t.host.start();
    expect(t.host.lifecycle).toBe('dealing');
    const st = t.host.peekState()!;
    // The barrier's blinds are unchanged: small blind 1 in seat 1, big blind 2 in seat 2.
    expect(bySeat(t.host, 1).bet).toBe(1);
    expect(bySeat(t.host, 2).bet).toBe(2);
    // The entry poster: one big blind, live, out of their stack.
    expect(bySeat(t.host, 3).bet).toBe(2);
    expect(bySeat(t.host, 3).stack).toBe(198);
    expect(bySeat(t.host, 3).totalInvested).toBe(2);
    // Nobody else posted, and the price to play is still one big blind.
    for (const seat of [4, 5, 6]) expect(bySeat(t.host, seat).bet).toBe(0);
    expect(st.pot).toBe(5);
    expect(st.currentBet).toBe(2);
    // The felt shows it in front of the seat, like the big blind's.
    const blinds = t.hub.frames.find((f) => f.payload.type === 'blinds_posted')!.payload;
    expect(blinds.postings).toEqual(
      expect.arrayContaining([
        { seat: 1, type: 'small_blind', amount: 1 },
        { seat: 2, type: 'big_blind', amount: 2 },
        { seat: 3, type: 'entry_big_blind', amount: 2 },
      ])
    );
    // The hand record carries the post as forced money (not dead).
    const posts = (t.host as any).actions.filter((a: any) => a.origin === 'forced');
    expect(posts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seat: 3, action: 'post', amount: 2, dead: false }),
      ])
    );
  });

  it('keeps the option: first to act with nothing owed, it may check or raise, and the street waits for it', async () => {
    const formed = formedHand(6, 320);
    const t = buildHost(formed, [200, 200, 200, 200, 200, 200], {
      participantsOverride: entryAt(3),
    });
    await t.host.start();
    const st = t.host.peekState()!;
    expect(st.currentPlayerSeat).toBe(3);
    const entry = bySeat(t.host, 3).user_id;
    const legal = legalFor(t.host, entry);
    expect(legal).toContain('check');
    expect(legal).not.toContain('call');
    expect(legal.some((a) => a === 'raise' || a === 'bet' || a === 'all_in')).toBe(true);
    expect(t.host.handlePlayerAction(entry, 'check').success).toBe(true);
    // Everyone behind folds; the big blind still has the option and the pot holds both posts.
    for (const seat of [4, 5, 6, 1]) {
      await flush(4);
      const p = bySeat(t.host, seat);
      expect(t.host.peekState()!.currentPlayerSeat).toBe(seat);
      expect(t.host.handlePlayerAction(p.user_id, 'fold').success).toBe(true);
    }
    await flush(4);
    expect(t.host.peekState()!.stage).toBe('preflop');
    expect(t.host.peekState()!.currentPlayerSeat).toBe(2);
    expect(legalFor(t.host, bySeat(t.host, 2).user_id)).toContain('check');
    expect(t.host.handlePlayerAction(bySeat(t.host, 2).user_id, 'check').success).toBe(true);
    await flush(4);
    const flop = t.host.peekState()!;
    expect(flop.stage).toBe('flop');
    expect(flop.pot).toBe(5);
  });

  it('a raise behind it costs the raise less the live post, as it costs the big blind', async () => {
    const formed = formedHand(6, 340);
    const t = buildHost(formed, [200, 200, 200, 200, 200, 200], {
      participantsOverride: entryAt(5),
    });
    await t.host.start();
    // Seat 3 raises all in for 200; seat 4 folds; the entry poster (seat 5) faces 198 more.
    const s3 = bySeat(t.host, 3).user_id;
    expect(t.host.handlePlayerAction(s3, 'all_in').success).toBe(true);
    await flush(4);
    expect(t.host.handlePlayerAction(bySeat(t.host, 4).user_id, 'fold').success).toBe(true);
    await flush(4);
    expect(t.host.peekState()!.currentPlayerSeat).toBe(5);
    const entry = bySeat(t.host, 5);
    expect(entry.bet).toBe(2);
    const before = entry.stack;
    expect(t.host.handlePlayerAction(entry.user_id, 'call').success).toBe(true);
    await flush(4);
    // 198 more, never 200: the live post counts toward the call.
    expect(Math.round((before - bySeat(t.host, 5).stack) * 100)).toBe(19800);
  });

  it('a short entry poster is all in for less, and the price for everyone else does not move', async () => {
    const formed = formedHand(6, 360);
    const t = buildHost(formed, [200, 200, 1.5, 200, 200, 200], {
      participantsOverride: entryAt(3),
    });
    await t.host.start();
    const short = t.participants.find((p) => p.seat === 3)!;
    expect(short.stackBefore).toBe(1.5);
    expect(bySeat(t.host, 3).bet).toBe(1.5);
    expect(bySeat(t.host, 3).is_all_in).toBe(true);
    expect(t.host.peekState()!.currentBet).toBe(2);
    expect(t.host.peekState()!.pot).toBe(4.5);
  });

  it('an entry poster in seat 1 posts the big blind, the small blind is dead, and seat 1 still acts first after the flop', async () => {
    const formed = formedHand(6, 380);
    const t = buildHost(formed, [200, 200, 200, 200, 200, 200], {
      participantsOverride: entryAt(1, 3, 4, 5, 6),
    });
    await t.host.start();
    expect(t.host.lifecycle).toBe('dealing');
    expect(bySeat(t.host, 1).bet).toBe(2);
    expect(bySeat(t.host, 1).stack).toBe(198);
    for (const seat of [2, 3, 4, 5, 6]) expect(bySeat(t.host, seat).bet).toBe(2);
    expect(t.host.peekState()!.pot).toBe(12);
    expect(t.host.peekState()!.currentPlayerSeat).toBe(3);
    const blinds = t.hub.frames.find((f) => f.payload.type === 'blinds_posted')!.payload;
    expect(blinds.postings.find((p: any) => p.type === 'small_blind')).toBeUndefined();
    // Everyone checks preflop; on the flop the first seat left of the button acts.
    for (const seat of [3, 4, 5, 6, 1, 2]) {
      await flush(4);
      expect(t.host.peekState()!.currentPlayerSeat).toBe(seat);
      expect(t.host.handlePlayerAction(bySeat(t.host, seat).user_id, 'check').success).toBe(true);
    }
    await flush(4);
    expect(t.host.peekState()!.stage).toBe('flop');
    expect(t.host.peekState()!.currentPlayerSeat).toBe(1);
  });
});

describe('the host deals only the roles it posts', () => {
  for (const [what, override] of [
    [
      'an entry poster in the big blind',
      (ps: Participant[]) => ps.map((p) => (p.seat === 2 ? { ...p, blindRole: 'entry_bb' } : p)),
    ],
    [
      'a role this host does not deal (both)',
      (ps: Participant[]) => ps.map((p) => (p.seat === 4 ? { ...p, blindRole: 'both' } : p)),
    ],
    [
      'a second small blind',
      (ps: Participant[]) => ps.map((p) => (p.seat === 5 ? { ...p, blindRole: 'sb' } : p)),
    ],
  ] as const) {
    it(`abandons a formation with ${what}, unplayed`, async () => {
      const t = buildHost(formedHand(6, 400), [200, 200, 200, 200, 200, 200], {
        participantsOverride: override as never,
      });
      await t.host.start();
      expect(t.calls.abandon).toEqual(['formation_blinds_disagree']);
      expect(t.calls.settle).toEqual([]);
    });
  }
});

describe('every hand with entry big blinds settles and conserves chips', () => {
  it('forty seeded hands, entry posters anywhere outside the big blind, horses and humans', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(9000 + seed);
      const n = 5 + (seed % 2);
      const formed = formedHand(n, 500 + seed * 10);
      const stacks = Array.from({ length: n }, () => 20 + Math.floor(rnd() * 300));
      const entrySeats = [1, 3, 4, 5, 6].filter((s) => s <= n && rnd() < 0.5);
      if (entrySeats.length === 0) entrySeats.push(3);
      const t = buildHost(formed, stacks, {
        participantsOverride: entryAt(...entrySeats),
        horses: new Set(formed.players.filter((_, i) => i % 2 === 1)),
      });
      await t.host.start();
      expect(t.host.lifecycle, `seed ${seed}`).toBe('dealing');
      for (const seat of entrySeats) {
        const p = bySeat(t.host, seat);
        expect(p.totalInvested, `seed ${seed} seat ${seat}`).toBe(
          Math.min(2, t.participants.find((x) => x.seat === seat)!.stackBefore)
        );
      }
      await playOut(t.host, rnd);
      await flush();
      expect(t.host.lifecycle, `seed ${seed}`).toBe('complete');
      expect(t.calls.settle).toHaveLength(1);
      const s = t.calls.settle[0] as any;
      conserve(s, new Map(t.participants.map((p) => [p.playerId, p.stackBefore])));
      for (const seat of entrySeats) {
        const id = t.participants.find((p) => p.seat === seat)!.playerId;
        const r = s.results.find((x: any) => x.playerId === id);
        expect(
          r.contributed,
          `seed ${seed}: the entry post reaches the books`
        ).toBeGreaterThanOrEqual(
          Math.min(2, t.participants.find((x) => x.seat === seat)!.stackBefore)
        );
      }
    }
  });
});
