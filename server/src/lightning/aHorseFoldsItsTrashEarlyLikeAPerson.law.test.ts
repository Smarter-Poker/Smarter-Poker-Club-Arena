/**
 * LAW (2026-10-24): A HORSE FOLDS ITS TRASH EARLY, LIKE A PERSON.
 *
 * Production, three hours of Lightning: 130,681 horse seats, 101,314 horse
 * folds, zero early. A person who notices that nobody ever folds out of turn
 * has found every horse. The law pins:
 *
 *   1. PARITY. Every hand that qualifies for an early fold is a hand the real
 *      brain folds from that seat: across seeded mixed tables (real
 *      HandController, real HorseLogic, random human opponents), no qualifying
 *      hand was ever played at its first preflop decision.
 *   2. THE PERSON'S DOOR. The fold goes through handlePlayerAction 'fast_fold'
 *      with the hand's own context, after a person's delay (0.45-4 s), before
 *      the horse's turn - and never once its turn has come.
 *   3. NEVER a blind, never a VPIP-floor table, never a client-driven seat,
 *      never a hand above the ceiling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const kit = await import('../testing/lightningHostTestKit.js');
const ef = await import('./LightningHorseEarlyFold.js');

afterEach(() => vi.useRealTimers());
const fake = () =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Plays mixed tables; returns every horse's first preflop decision with its strength. */
async function playMixed(variant: string, hands: number, base: number) {
  const rows: Array<{ s: number; role: string; a: string; qualified: boolean }> = [];
  for (let h = 0; h < hands; h++) {
    const n = 3 + (h % 4);
    const formed = kit.formedHand(n, base + h * 100);
    const humans = new Set(formed.players.filter((_, i) => (h + i) % 3 === 0));
    const t = kit.buildHost(
      formed,
      Array.from({ length: n }, (_, i) => 40 + ((h * 37 + i * 53) % 160)),
      {
        horses: new Set(formed.players.filter((p) => !humans.has(p))),
        rules: { game_variant: variant, big_blind: 1, small_blind: 0.5 },
      }
    );
    const lane = t.horseLane.raw;
    const decide = lane.decideFast.getMockImplementation()!;
    lane.decideFast.mockImplementation(async (snap: any) => {
      const res = await decide(snap);
      const me = snap.player;
      const part = (t.host as any).participants.get(me.user_id);
      const first = !(snap.gameState.actionHistory ?? []).some(
        (a: any) => a.userId === me.user_id && a.origin !== 'forced'
      );
      if (snap.gameState.stage === 'preflop' && first && snap.gameState.toCall > 0)
        rows.push({
          s: ef.horsePreflopStrength(me.cards, variant),
          role: part.blindRole,
          a: res.decision.action,
          qualified: ef.qualifiesForEarlyFold({
            cards: me.cards,
            variant,
            blindRole: part.blindRole,
            vpipFloor: 0,
            clientControlled: false,
          }),
        });
      return res;
    });
    const rnd = lcg(base + h);
    await t.host.start();
    for (let i = 0; i < 600 && t.host.lifecycle === 'dealing'; i++) {
      const st = t.host.peekState();
      const cur = st?.players.find((x: any) => x.seat === st.currentPlayerSeat);
      if (
        cur &&
        humans.has(cur.user_id) &&
        ['preflop', 'flop', 'turn', 'river'].includes(st!.stage)
      ) {
        const auth = (t.host as any).hc.getAuthoritativeActionState(cur.user_id);
        const legal: string[] = auth?.legalActions ?? [];
        if (legal.length) {
          const r = rnd();
          const a =
            r < 0.3 && legal.includes('call')
              ? 'call'
              : r < 0.5 && legal.includes('raise')
                ? 'raise'
                : r < 0.6 && legal.includes('all_in')
                  ? 'all_in'
                  : r < 0.75 && legal.includes('check')
                    ? 'check'
                    : legal.includes('fold')
                      ? 'fold'
                      : legal[0]!;
          const amount =
            a === 'raise'
              ? Math.min(auth.maxRaiseTo ?? 0, (auth.minRaiseTo ?? 0) * (1 + 3 * rnd()))
              : undefined;
          const res = t.host.handlePlayerAction(cur.user_id, a, amount);
          if (!res.success)
            t.host.handlePlayerAction(cur.user_id, legal.includes('check') ? 'check' : 'fold');
        }
      }
      await vi.advanceTimersByTimeAsync(400);
    }
    await t.host.abort('law_done').catch(() => undefined);
  }
  return rows;
}

describe('LAW: a horse folds its trash early, like a person', () => {
  it.each(['nlh', 'plo5', 'short_deck'])(
    'parity (%s): the brain folds every qualifying hand it is asked about',
    async (variant) => {
      fake();
      const rows = await playMixed(variant, 160, 40_000 + variant.length * 10_000);
      const qualified = rows.filter((r) => r.qualified);
      expect(rows.length).toBeGreaterThan(150);
      expect(qualified.length).toBeGreaterThan(20);
      for (const r of qualified) expect(r.a).toBe('fold');
    },
    120_000
  );

  it('folds through the person door after a person delay, before the turn', async () => {
    fake();
    let early = 0;
    for (let h = 0; h < 12; h++) {
      const formed = kit.formedHand(6, 50_000 + h * 100);
      const t = kit.buildHost(formed, [100, 100, 100, 100, 100, 100], {
        horses: new Set(formed.players),
        deps: { earlyFoldRandom: () => 0 },
      });
      const original = t.host.handlePlayerAction.bind(t.host);
      const startedAt = Date.now();
      const foldedAt = new Map<string, number>();
      const spy = vi
        .spyOn(t.host, 'handlePlayerAction')
        .mockImplementation((...args: Parameters<typeof original>) => {
          if (args[1] === 'fast_fold') foldedAt.set(args[0], Date.now() - startedAt);
          return original(...args);
        });
      await t.host.start();
      for (let i = 0; i < 40 && t.host.lifecycle === 'dealing'; i++)
        await vi.advanceTimersByTimeAsync(250);
      const hole = (t.host as any).holeCards as Map<string, { cards: any[] }>;
      for (const [userId, at] of foldedAt) {
        early++;
        const part = (t.host as any).participants.get(userId);
        expect(part.blindRole).toBe('none');
        expect(at).toBeGreaterThanOrEqual(450);
        expect(ef.horsePreflopStrength(hole.get(userId)!.cards, 'nlh')).toBeLessThan(
          ef.EARLY_FOLD_MAX.holdem
        );
        // Folded before its turn: the brain was never asked for this seat preflop.
        const asked = t.horseLane.calls.filter(
          (c: any) => c.player.user_id === userId && c.gameState.stage === 'preflop'
        );
        expect(asked).toEqual([]);
      }
      const ctxs = spy.mock.calls.filter((c) => c[1] === 'fast_fold').map((c) => c[3]);
      for (const ctx of ctxs) expect(ctx).toBe(`lightning-hand:${(t.host as any).handId}`);
      await t.host.abort('law_done').catch(() => undefined);
    }
    expect(early).toBeGreaterThan(0);
  });

  it('never a blind, a VPIP floor, a client-driven seat or a hand above the ceiling', () => {
    const trash = [
      { rank: '7', suit: 'hearts' },
      { rank: '2', suit: 'clubs' },
    ] as any;
    const aces = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'A', suit: 'clubs' },
    ] as any;
    const seat = {
      cards: trash,
      variant: 'nlh',
      blindRole: 'none',
      vpipFloor: 0,
      clientControlled: false,
    };
    expect(ef.horsePreflopStrength(trash, 'nlh')).toBeLessThan(ef.EARLY_FOLD_MAX.holdem);
    expect(ef.qualifiesForEarlyFold(seat)).toBe(true);
    expect(ef.qualifiesForEarlyFold({ ...seat, blindRole: 'bb' })).toBe(false);
    expect(ef.qualifiesForEarlyFold({ ...seat, blindRole: 'sb' })).toBe(false);
    expect(ef.qualifiesForEarlyFold({ ...seat, vpipFloor: 50 })).toBe(false);
    expect(ef.qualifiesForEarlyFold({ ...seat, clientControlled: true })).toBe(false);
    expect(ef.qualifiesForEarlyFold({ ...seat, cards: aces })).toBe(false);
    expect(ef.qualifiesForEarlyFold({ ...seat, variant: 'pineapple' })).toBe(false);
    // A person's delay: never under 450 ms or over 4 s, median near 1.3 s.
    const r = lcg(7);
    const d = Array.from({ length: 2000 }, () => ef.earlyFoldDelayMs(r)).sort((a, b) => a - b);
    expect(d[0]).toBeGreaterThanOrEqual(450);
    expect(d[d.length - 1]).toBeLessThanOrEqual(4000);
    expect(d[1000]).toBeGreaterThan(1000);
    expect(d[1000]).toBeLessThan(1700);
    // Not every qualifying hand: a person sometimes waits.
    expect(ef.planEarlyFold(seat, () => 0.9)).toBeNull();
    expect(ef.planEarlyFold(seat, () => 0.1)).not.toBeNull();
  });
});
