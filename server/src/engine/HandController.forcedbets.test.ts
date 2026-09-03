/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FORCED MONEY HAS TO REACH THE HAND RECORD (2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `postBlinds` moved chips for the small blind, the big blind, dead blinds,
 * "post BB to enter", antes and straddles — into the pot, into
 * `totalInvested`, and into NO action record. `actions` is the only per-hand
 * log that is persisted, so every consumer rebuilding a pot, an investment or
 * a stack from `hand_history` was short by exactly the forced money on every
 * hand that had any.
 *
 * Measured before the fix: reconstructing the 4,000 most recent live hands
 * lands on the stored `pot_size` on 99.18%, and every single miss is a hand
 * carrying an ante or a straddle.
 *
 * `FORCED_BETS_POSTED` closes that. What it must get right:
 *
 *   1. EVERY posting path is covered, including ones added later. The amounts
 *      are differenced from `totalInvested` snapshots rather than instrumented
 *      per branch, so a new kind of forced bet lands in whichever bucket it
 *      sits between and is recorded whether or not anyone remembered to.
 *
 *   2. DEAD money is flagged. An ante is in the pot but is not part of the live
 *      bet level, so it must never be differenced against a raise-TO level. A
 *      reader that folds the ante into "what this seat already has in"
 *      understates every raise made by anyone who posted one — which in a
 *      tournament is everybody.
 *
 *   3. The totals reconcile with the pot the engine itself banked. If they do
 *      not, the record disagrees with the money, which is the whole failure
 *      this exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

interface Posting {
  seat: number;
  userId: string;
  kind: string;
  amount: number;
  dead: boolean;
}

function start(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  hc.start();
  const forced = events
    .filter((e) => (e as { type: string }).type === 'FORCED_BETS_POSTED')
    .flatMap((e) => (e as unknown as { postings: Posting[] }).postings ?? []);
  const state = (hc as unknown as { state: { pot: number; players: SeatPlayer[] } }).state;
  return { hc, events, forced, state };
}

describe('FORCED_BETS_POSTED - the blinds', () => {
  const { forced, state } = start(mkConfig(), mkPlayers([1000, 1000, 1000]), 1);

  it('records the small blind and the big blind', () => {
    const sb = forced.find((p) => p.kind === 'sb')!;
    const bb = forced.find((p) => p.kind === 'bb')!;
    expect(sb.amount).toBe(5);
    expect(bb.amount).toBe(10);
  });

  it('marks a live blind as live, not dead', () => {
    for (const p of forced.filter((x) => x.kind === 'sb' || x.kind === 'bb')) {
      expect(p.dead).toBe(false);
    }
  });

  it('adds up to the pot the engine actually banked', () => {
    const total = forced.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(state.pot);
  });

  it('carries a user id, so the record can name who posted', () => {
    for (const p of forced) expect(p.userId).toMatch(/^u\d+$/);
  });
});

describe('FORCED_BETS_POSTED - antes are recorded AND flagged dead', () => {
  const { forced, state } = start(mkConfig({ ante: 2 }), mkPlayers([1000, 1000, 1000]), 1);

  it('records one ante per player', () => {
    const antes = forced.filter((p) => p.kind === 'ante');
    expect(antes).toHaveLength(3);
    for (const a of antes) expect(a.amount).toBe(2);
  });

  it('flags every ante as dead money', () => {
    // This is the flag that keeps a reader from differencing a raise-TO level
    // against money that was never part of the live bet.
    for (const a of forced.filter((p) => p.kind === 'ante')) expect(a.dead).toBe(true);
  });

  it('still reconciles with the banked pot', () => {
    const total = forced.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(state.pot);
    expect(state.pot).toBe(5 + 10 + 2 * 3);
  });

  it('never folds the ante into the blind row', () => {
    // The BB posted 10 live and 2 dead. Those are two facts and two rows; one
    // row of 12 would be unusable for rebuilding a bet level.
    const bb = forced.find((p) => p.kind === 'bb')!;
    expect(bb.amount).toBe(10);
  });
});

describe('FORCED_BETS_POSTED - the big blind ante is dead money too', () => {
  // Bible V8 4.3: the BB fronts the whole table's ante. It is dead in the pot,
  // and the 2026-07-21 refund bug happened precisely because something treated
  // it as a live bet.
  const { forced, state } = start(
    mkConfig({ ante: 2, bigBlindAnte: true }),
    mkPlayers([1000, 1000, 1000]),
    1
  );

  it('records it once, against the big blind, as dead', () => {
    const antes = forced.filter((p) => p.kind === 'ante');
    expect(antes).toHaveLength(1);
    expect(antes[0].dead).toBe(true);
    expect(antes[0].amount).toBe(6); // 2 x 3 players, fronted by the BB
  });

  it('reconciles with the banked pot', () => {
    const total = forced.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(state.pot);
  });
});

describe('FORCED_BETS_POSTED - a straddle is live and raises the bet level', () => {
  const players = mkPlayers([1000, 1000, 1000]);
  const { forced, state } = start(
    mkConfig({ straddles: [{ seat: 3, amount: 20 }] } as Partial<HandConfig>),
    players,
    1
  );

  it('records the straddle', () => {
    const s = forced.find((p) => p.kind === 'straddle')!;
    expect(s.amount).toBe(20);
    expect(s.seat).toBe(3);
  });

  it('marks it LIVE - it is a blind that raises, not dead money', () => {
    expect(forced.find((p) => p.kind === 'straddle')!.dead).toBe(false);
  });

  it('reconciles with the banked pot', () => {
    const total = forced.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(state.pot);
    expect(state.pot).toBe(5 + 10 + 20);
  });
});

describe('FORCED_BETS_POSTED - every posting path at once', () => {
  // Blinds + antes + a straddle on the same hand. This is the shape that used
  // to be unreconstructible: the log showed one raise and nothing else.
  const { forced, state } = start(
    mkConfig({ ante: 1, straddles: [{ seat: 3, amount: 20 }] } as Partial<HandConfig>),
    mkPlayers([1000, 1000, 1000]),
    1
  );

  it('accounts for the entire pot before a single voluntary action', () => {
    const total = forced.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(state.pot);
  });

  it('separates live from dead across the whole hand', () => {
    const live = forced.filter((p) => !p.dead).reduce((s, p) => s + p.amount, 0);
    const dead = forced.filter((p) => p.dead).reduce((s, p) => s + p.amount, 0);
    expect(dead).toBe(3); // three 1-chip antes
    expect(live).toBe(35); // 5 + 10 + a 20 straddle
    expect(live + dead).toBe(state.pot);
  });

  it('emits nothing that is zero or negative', () => {
    for (const p of forced) expect(p.amount).toBeGreaterThan(0);
  });
});
