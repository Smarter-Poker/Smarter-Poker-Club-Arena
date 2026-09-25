/**
 * KILL AND HALF-KILL POTS, rule manifest kill-v1: the pure arithmetic, the
 * scoop test, the trigger and the per-table ledger.
 *
 * Stakes convention (BettingStructure.ts): the base small bet IS the big blind.
 * A table posting blinds 2/4 is a 4/8 limit game; a half kill plays it 6/12
 * with a 6 kill blind and a full kill plays it 8/16 with an 8 kill blind.
 */
import { describe, it, expect } from 'vitest';
import {
  KILL_RULE_VERSION,
  KILL_THRESHOLDS_BB,
  KillPotSchedule,
  buildKillPotRecord,
  decideKillForDeal,
  evaluateKillTrigger,
  evaluateScoop,
  exactMinorUnits,
  handFixedLimitSmallBet,
  killIneligibility,
  killMultiplier,
  killStakes,
  killThresholdMet,
  pendingKillFromHistoryRow,
  readKillSettings,
  type KillSettings,
  type PendingKill,
  type ScoopAward,
} from './KillPot.js';
import { determineWinners } from './PokerEngine.js';
import type { Card, PerPotAward, SeatPlayer } from '../types.js';

const FULL: KillSettings = { mode: 'full', thresholdBb: 10 };
const HALF: KillSettings = { mode: 'half', thresholdBb: 10 };
const OFF: KillSettings = { mode: 'off', thresholdBb: 10 };

describe('kill stakes are exact integer minor-unit arithmetic', () => {
  it('multipliers: full is 2/1, half is 3/2, off has none', () => {
    expect(killMultiplier('full')).toEqual({ num: 2, den: 1 });
    expect(killMultiplier('half')).toEqual({ num: 3, den: 2 });
    expect(killMultiplier('off')).toBeNull();
  });

  it('a 4/8 limit game (big blind 4): half kill is 6/12, full kill is 8/16', () => {
    const half = killStakes({ baseBigBlind: 4, mode: 'half' });
    const full = killStakes({ baseBigBlind: 4, mode: 'full' });
    expect(half).toMatchObject({ ok: true, smallBet: 6, bigBet: 12, killBlind: 6 });
    expect(full).toMatchObject({ ok: true, smallBet: 8, bigBet: 16, killBlind: 8 });
  });

  it('the kill blind always equals the effective small bet, and the big bet is twice it', () => {
    for (const bb of [0.02, 0.1, 1, 2, 4, 10, 200]) {
      for (const mode of ['half', 'full'] as const) {
        const s = killStakes({ baseBigBlind: bb, mode });
        if (!s.ok) continue;
        expect(s.killBlind).toBe(s.smallBet);
        expect(s.bigBetMinor).toBe(s.smallBetMinor * 2);
      }
    }
  });

  it('refuses a half kill whose base big blind is an odd number of cents', () => {
    expect(killStakes({ baseBigBlind: 0.05, mode: 'half' })).toEqual({
      ok: false,
      reason: 'half_kill_requires_even_minor_units',
    });
    expect(killStakes({ baseBigBlind: 0.25, mode: 'half' })).toMatchObject({ ok: false });
    // The same stakes are fine at full kill.
    expect(killStakes({ baseBigBlind: 0.05, mode: 'full' })).toMatchObject({
      ok: true,
      smallBet: 0.1,
      bigBet: 0.2,
    });
    // Even cents are fine at half kill: 1.00 plays 1.50/3.00.
    expect(killStakes({ baseBigBlind: 1, mode: 'half' })).toMatchObject({
      ok: true,
      smallBet: 1.5,
      bigBet: 3,
    });
  });

  it('Diamonds are whole units: a half kill needs an even big blind', () => {
    expect(killStakes({ baseBigBlind: 5, mode: 'half', asset: 'diamonds' })).toEqual({
      ok: false,
      reason: 'half_kill_requires_even_minor_units',
    });
    expect(killStakes({ baseBigBlind: 4, mode: 'half', asset: 'diamonds' })).toMatchObject({
      ok: true,
      smallBet: 6,
      bigBet: 12,
    });
    expect(killStakes({ baseBigBlind: 5, mode: 'full', asset: 'diamonds' })).toMatchObject({
      ok: true,
      smallBet: 10,
      bigBet: 20,
    });
    // A fractional Diamond big blind is not a valid base at all.
    expect(killStakes({ baseBigBlind: 2.5, mode: 'full', asset: 'diamonds' })).toEqual({
      ok: false,
      reason: 'invalid_base_big_blind',
    });
  });

  it('refuses an unusable base big blind and an off mode', () => {
    for (const bb of [0, -2, Number.NaN, Infinity, 0.005]) {
      expect(killStakes({ baseBigBlind: bb, mode: 'full' })).toEqual({
        ok: false,
        reason: 'invalid_base_big_blind',
      });
    }
    expect(killStakes({ baseBigBlind: 4, mode: 'off' })).toEqual({
      ok: false,
      reason: 'kill_mode_off',
    });
  });

  it('exhaustively, for every chip big blind 0.01..20.00: exact, never rounded', () => {
    for (let cents = 1; cents <= 2000; cents++) {
      const bb = cents / 100;
      expect(exactMinorUnits(bb, 'chips')).toBe(cents);
      const full = killStakes({ baseBigBlind: bb, mode: 'full' });
      expect(full.ok).toBe(true);
      if (full.ok) {
        expect(full.smallBetMinor).toBe(cents * 2);
        expect(Math.round(full.smallBet * 100)).toBe(cents * 2);
        expect(Math.round(full.bigBet * 100)).toBe(cents * 4);
      }
      const half = killStakes({ baseBigBlind: bb, mode: 'half' });
      if (cents % 2 === 0) {
        expect(half.ok).toBe(true);
        if (half.ok) {
          expect(half.smallBetMinor * 2).toBe(cents * 3);
          expect(Math.round(half.smallBet * 100)).toBe((cents * 3) / 2);
          expect(Math.round(half.bigBet * 100)).toBe(cents * 3);
        }
      } else {
        expect(half).toEqual({ ok: false, reason: 'half_kill_requires_even_minor_units' });
      }
    }
  });

  it('the hand sizes from the kill small bet when there is one, else the big blind', () => {
    expect(handFixedLimitSmallBet({ bigBlind: 4 })).toBe(4);
    expect(handFixedLimitSmallBet({ bigBlind: 4, killPot: { smallBet: 6 } })).toBe(6);
  });
});

describe('the threshold is measured in BASE big blinds, exactly', () => {
  for (const threshold of KILL_THRESHOLDS_BB) {
    it(`threshold ${threshold}bb at a 4 big blind: below, equal and above`, () => {
      const at = threshold * 4;
      const t = (total: number) =>
        killThresholdMet({ contestedTotal: total, baseBigBlind: 4, thresholdBb: threshold });
      expect(t(at - 0.01)?.met).toBe(false);
      expect(t(at)?.met).toBe(true);
      expect(t(at + 0.01)?.met).toBe(true);
    });
  }

  it('float drift in a summed pot does not decide the threshold', () => {
    // 0.1 + 0.2 territory: a pot that is exactly 1.00 must meet 10bb at 0.10.
    const total = [0.3, 0.3, 0.4].reduce((a, b) => a + b, 0) - 0.0000000001;
    expect(
      killThresholdMet({ contestedTotal: total, baseBigBlind: 0.1, thresholdBb: 10 })?.met
    ).toBe(true);
  });

  it('cannot be measured against an unusable big blind', () => {
    expect(killThresholdMet({ contestedTotal: 50, baseBigBlind: 0, thresholdBb: 10 })).toBeNull();
  });
});

describe('table settings', () => {
  it('a row without the columns (old shape) is off', () => {
    expect(readKillSettings({})).toEqual(OFF);
    expect(readKillSettings(null)).toEqual(OFF);
    expect(readKillSettings(undefined)).toEqual(OFF);
  });
  it('reads half and full with every allowed threshold', () => {
    for (const t of KILL_THRESHOLDS_BB) {
      expect(readKillSettings({ kill_mode: 'half', kill_threshold_bb: t })).toEqual({
        mode: 'half',
        thresholdBb: t,
      });
      expect(readKillSettings({ kill_mode: 'full', kill_threshold_bb: t })).toEqual({
        mode: 'full',
        thresholdBb: t,
      });
    }
    expect(readKillSettings({ kill_mode: 'full' })).toEqual({ mode: 'full', thresholdBb: 10 });
  });
  it('a value the database would refuse never switches money rules on', () => {
    expect(readKillSettings({ kill_mode: 'double', kill_threshold_bb: 10 })).toEqual(OFF);
    expect(readKillSettings({ kill_mode: 'full', kill_threshold_bb: 9 })).toEqual(OFF);
    expect(readKillSettings({ kill_mode: 'FULL' })).toEqual(OFF);
  });
  it('only fixed-limit cash hands that are not bomb pots can kill', () => {
    const base = { mode: 'full' as const, isTournament: false, isBombHand: false };
    expect(killIneligibility({ ...base, variant: 'flh' })).toBeNull();
    expect(killIneligibility({ ...base, variant: 'flo8' })).toBeNull();
    expect(killIneligibility({ ...base, variant: 'nlh' })).toBe('not_fixed_limit');
    expect(killIneligibility({ ...base, variant: 'plo8' })).toBe('not_fixed_limit');
    expect(killIneligibility({ ...base, variant: 'flh', isTournament: true })).toBe('tournament');
    expect(killIneligibility({ ...base, variant: 'flh', isBombHand: true })).toBe('bomb_pot_hand');
    expect(killIneligibility({ ...base, mode: 'off', variant: 'flh' })).toBe('kill_mode_off');
  });
});

describe('the scoop: one player receives every award of the hand', () => {
  const pot = (index: number, amount: number) => ({ index, amount });
  const aw = (userId: string, potIndex: number, extra: Partial<ScoopAward> = {}): ScoopAward => ({
    userId,
    potIndex,
    ...extra,
  });

  it('one pot, one winner is a scoop', () => {
    expect(evaluateScoop([pot(0, 40)], [aw('a', 0)])).toMatchObject({
      scooper: 'a',
      reason: 'scoop',
    });
  });
  it('a chopped pot is not', () => {
    expect(evaluateScoop([pot(0, 40)], [aw('a', 0), aw('b', 0)])).toMatchObject({
      scooper: null,
      reason: 'split',
    });
  });
  it('side pots won by different players are not', () => {
    expect(evaluateScoop([pot(0, 30), pot(1, 20)], [aw('a', 0), aw('b', 1)]).scooper).toBeNull();
  });
  it('side pots all won by the same player are', () => {
    expect(evaluateScoop([pot(0, 30), pot(1, 20)], [aw('a', 0), aw('a', 1)]).scooper).toBe('a');
  });
  it('both halves of a hi-lo pot to one player is a scoop; different halves are not', () => {
    expect(evaluateScoop([pot(0, 40)], [aw('a', 0), aw('a', 0, { low: true })]).scooper).toBe('a');
    expect(evaluateScoop([pot(0, 40)], [aw('a', 0), aw('b', 0, { low: true })]).scooper).toBeNull();
  });
  it('run it twice: the same winner of every run scoops, different run winners do not', () => {
    expect(
      evaluateScoop([pot(0, 40)], [aw('a', 0, { board: 1 }), aw('a', 0, { board: 2 })])
    ).toMatchObject({ scooper: 'a', boards: [1, 2] });
    expect(
      evaluateScoop([pot(0, 40)], [aw('a', 0, { board: 1 }), aw('b', 0, { board: 2 })]).scooper
    ).toBeNull();
  });
  it('a pot with money and no award is never claimed as a scoop', () => {
    expect(evaluateScoop([pot(0, 30), pot(1, 20)], [aw('a', 0)])).toMatchObject({
      scooper: null,
      reason: 'uncovered_pot',
    });
    expect(evaluateScoop([pot(0, 30)], [])).toMatchObject({ scooper: null, reason: 'no_awards' });
  });
});

describe('the scoop on real Omaha Hi-Lo awards (determineWinners)', () => {
  const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
  const seat = (user_id: string, s: number, cards: Card[]) =>
    ({ user_id, seat: s, is_folded: false, cards }) as unknown as SeatPlayer;
  const awards = (players: SeatPlayer[], board: Card[]): PerPotAward[] => {
    const out: PerPotAward[] = [];
    determineWinners(
      players,
      board,
      [{ amount: 60, eligiblePlayers: players.map((p) => p.user_id) }],
      'flo8',
      1,
      out
    );
    return out;
  };
  const scoopOf = (out: PerPotAward[]) =>
    evaluateScoop(
      [{ index: 0, amount: 60 }],
      out.map((a) => ({ userId: a.userId, potIndex: a.potIndex, low: a.low }))
    ).scooper;

  it('the wheel takes high and low: a scoop', () => {
    const board = [
      card('2', 'spades'),
      card('3', 'diamonds'),
      card('4', 'clubs'),
      card('9', 'hearts'),
      card('K', 'spades'),
    ];
    const out = awards(
      [
        seat('wheel', 1, [
          card('A', 'hearts'),
          card('5', 'hearts'),
          card('Q', 'clubs'),
          card('J', 'clubs'),
        ]),
        seat('kings', 2, [
          card('K', 'diamonds'),
          card('K', 'clubs'),
          card('Q', 'diamonds'),
          card('Q', 'hearts'),
        ]),
      ],
      board
    );
    expect(out.some((a) => a.low)).toBe(true);
    expect(scoopOf(out)).toBe('wheel');
  });

  it('high to one player and the qualifying low to another: no scoop', () => {
    const board = [
      card('2', 'spades'),
      card('3', 'diamonds'),
      card('4', 'clubs'),
      card('9', 'hearts'),
      card('K', 'spades'),
    ];
    const out = awards(
      [
        seat('kings', 1, [
          card('K', 'diamonds'),
          card('K', 'clubs'),
          card('Q', 'diamonds'),
          card('Q', 'hearts'),
        ]),
        seat('low', 2, [
          card('A', 'clubs'),
          card('6', 'diamonds'),
          card('J', 'spades'),
          card('J', 'diamonds'),
        ]),
      ],
      board
    );
    expect(new Set(out.map((a) => a.userId))).toEqual(new Set(['kings', 'low']));
    expect(scoopOf(out)).toBeNull();
  });

  it('no qualifying low: the pot is wholly the high winner, which is a scoop', () => {
    const board = [
      card('K', 'spades'),
      card('K', 'hearts'),
      card('9', 'diamonds'),
      card('3', 'spades'),
      card('2', 'clubs'),
    ];
    const out = awards(
      [
        seat('aces', 1, [
          card('A', 'spades'),
          card('A', 'diamonds'),
          card('7', 'clubs'),
          card('8', 'clubs'),
        ]),
        seat('diamonds', 2, [
          card('4', 'diamonds'),
          card('5', 'diamonds'),
          card('6', 'diamonds'),
          card('7', 'diamonds'),
        ]),
      ],
      board
    );
    expect(out.every((a) => !a.low)).toBe(true);
    expect(scoopOf(out)).toBe('aces');
  });
});

describe('the deal decision', () => {
  const pending = (over: Partial<PendingKill> = {}): PendingKill => ({
    ruleVersion: KILL_RULE_VERSION,
    triggerHandId: 'trigger-row',
    triggerHandNumber: 1000,
    killerUserId: 'k',
    killerSeat: 4,
    mode: 'full',
    thresholdBb: 10,
    chained: false,
    contestedTotal: 60,
    ...over,
  });
  const roster = [1, 2, 3, 4, 5].map((s) => ({ userId: s === 4 ? 'k' : `u${s}`, seat: s }));
  const base = {
    settings: FULL,
    variant: 'flh',
    isTournament: false,
    isBombHand: false,
    baseBigBlind: 4,
    roster,
    sbSeat: 2,
    bbSeat: 3,
  };

  it('nothing pending: a base-limit hand', () => {
    expect(decideKillForDeal({ ...base, pending: null })).toEqual({ kind: 'none' });
  });

  it('killer dealt in: a kill hand with frozen effective limits', () => {
    const d = decideKillForDeal({ ...base, pending: pending() });
    expect(d.kind).toBe('kill');
    if (d.kind !== 'kill') return;
    expect(d.hand).toMatchObject({
      mode: 'full',
      smallBet: 8,
      bigBet: 16,
      killBlind: 8,
      killerSeat: 4,
      killerBlindSlot: 'none',
      triggerHandId: 'trigger-row',
      triggerHandNumber: 1000,
    });
    expect(Object.isFrozen(d.hand)).toBe(true);
  });

  it('records which blind the killer holds', () => {
    const inSb = decideKillForDeal({ ...base, pending: pending(), sbSeat: 4, bbSeat: 5 });
    const inBb = decideKillForDeal({ ...base, pending: pending(), sbSeat: 3, bbSeat: 4 });
    expect(inSb.kind === 'kill' && inSb.hand.killerBlindSlot).toBe('sb');
    expect(inBb.kind === 'kill' && inBb.hand.killerBlindSlot).toBe('bb');
  });

  it('killer not dealt in (left, sitting out, waiting for the big blind, moved): cancelled', () => {
    const d = decideKillForDeal({
      ...base,
      pending: pending(),
      roster: roster.filter((p) => p.userId !== 'k'),
    });
    expect(d).toMatchObject({ kind: 'cancel', cancellation: { reason: 'killer_not_dealt_in' } });
  });

  it('the killer is found by who they are, at whatever seat they are dealt in', () => {
    const moved = roster
      .map((p) => (p.userId === 'k' ? { ...p, seat: 5 } : p))
      .filter((p) => p.seat !== 5 || p.userId === 'k');
    const d = decideKillForDeal({ ...base, pending: pending(), roster: moved });
    expect(d.kind === 'kill' && d.hand.killerSeat).toBe(5);
  });

  it("'off', non-fixed-limit, tournament and bomb hands never kill", () => {
    expect(decideKillForDeal({ ...base, settings: OFF, pending: pending() })).toMatchObject({
      cancellation: { reason: 'kill_mode_off' },
    });
    expect(decideKillForDeal({ ...base, variant: 'nlh', pending: pending() })).toMatchObject({
      cancellation: { reason: 'not_fixed_limit' },
    });
    expect(decideKillForDeal({ ...base, isTournament: true, pending: pending() })).toMatchObject({
      cancellation: { reason: 'tournament' },
    });
    expect(decideKillForDeal({ ...base, isBombHand: true, pending: pending() })).toMatchObject({
      cancellation: { reason: 'bomb_pot_hand' },
    });
  });

  it('invalid half-kill precision cancels with the precise reason', () => {
    const d = decideKillForDeal({
      ...base,
      baseBigBlind: 0.05,
      settings: HALF,
      pending: pending({ mode: 'half' }),
    });
    expect(d).toMatchObject({
      kind: 'cancel',
      cancellation: { reason: 'half_kill_requires_even_minor_units' },
    });
  });

  it('the pending kill plays at its FROZEN mode, whatever the table says now', () => {
    const d = decideKillForDeal({ ...base, settings: HALF, pending: pending({ mode: 'full' }) });
    expect(d.kind === 'kill' && [d.hand.smallBet, d.hand.bigBet]).toEqual([8, 16]);
  });
});

describe('the trigger', () => {
  const input = (over: Partial<Parameters<typeof evaluateKillTrigger>[0]> = {}) => ({
    handNumber: 2000,
    settings: FULL,
    variant: 'flh',
    isTournament: false,
    isBombHand: false,
    baseBigBlind: 4,
    killHand: null,
    pots: [{ index: 0, amount: 40 }],
    awards: [{ userId: 'a', potIndex: 0 }],
    contestedTotal: 40,
    seatOf: (u: string) => (u === 'a' ? 3 : null),
    ...over,
  });

  it('a scoop of exactly the threshold triggers, keyed by the hand number', () => {
    const r = evaluateKillTrigger(input());
    expect(r.outcome).toBe('triggered');
    expect(r.pending).toMatchObject({
      killerUserId: 'a',
      killerSeat: 3,
      mode: 'full',
      thresholdBb: 10,
      triggerHandNumber: 2000,
      triggerHandId: null,
      chained: false,
      contestedTotal: 40,
    });
  });
  it('below the threshold does not', () => {
    expect(evaluateKillTrigger(input({ contestedTotal: 39.99 })).outcome).toBe('below_threshold');
  });
  it('a split does not, however big', () => {
    const r = evaluateKillTrigger(
      input({
        awards: [
          { userId: 'a', potIndex: 0 },
          { userId: 'b', potIndex: 0 },
        ],
        contestedTotal: 400,
      })
    );
    expect(r.outcome).toBe('no_scoop');
  });
  it('a bomb hand never triggers', () => {
    expect(evaluateKillTrigger(input({ isBombHand: true })).outcome).toBe('bomb_pot_hand');
  });
  it('an off table never triggers', () => {
    expect(evaluateKillTrigger(input({ settings: OFF })).outcome).toBe('kill_mode_off');
  });
  it('a kill hand can trigger the next kill: chained, at the configured mode, never escalated', () => {
    const killHand = decideKillForDeal({
      pending: {
        ruleVersion: KILL_RULE_VERSION,
        triggerHandId: 'x',
        triggerHandNumber: 1999,
        killerUserId: 'a',
        killerSeat: 3,
        mode: 'full',
        thresholdBb: 10,
        chained: false,
        contestedTotal: 40,
      },
      settings: FULL,
      variant: 'flh',
      isTournament: false,
      isBombHand: false,
      baseBigBlind: 4,
      roster: [{ userId: 'a', seat: 3 }],
      sbSeat: 1,
      bbSeat: 2,
    });
    if (killHand.kind !== 'kill') throw new Error('expected a kill hand');
    const r = evaluateKillTrigger(input({ killHand: killHand.hand, contestedTotal: 200 }));
    expect(r.pending).toMatchObject({ chained: true, mode: 'full' });
    // The next kill hand is priced off the BASE big blind again: 8/16, not 16/32.
    const next = decideKillForDeal({
      pending: r.pending,
      settings: FULL,
      variant: 'flh',
      isTournament: false,
      isBombHand: false,
      baseBigBlind: 4,
      roster: [{ userId: 'a', seat: 3 }],
      sbSeat: 1,
      bbSeat: 2,
    });
    expect(next.kind === 'kill' && [next.hand.smallBet, next.hand.bigBet]).toEqual([8, 16]);
  });
  it('the threshold of a chained kill is still measured in base big blinds', () => {
    // 10bb at base 4 is 40, not 80 at the kill hand's 8.
    const r = evaluateKillTrigger(input({ contestedTotal: 40 }));
    expect(r.thresholdAmount).toBe(40);
  });
});

describe('the ledger: normal, kill, normal; chains; duplicates; restore', () => {
  const roster = [
    { userId: 'a', seat: 1 },
    { userId: 'b', seat: 2 },
    { userId: 'c', seat: 3 },
  ];
  const dealInput = (settings: KillSettings = FULL, r = roster) => ({
    settings,
    variant: 'flh',
    isTournament: false,
    isBombHand: false,
    baseBigBlind: 4,
    roster: r,
    sbSeat: 2,
    bbSeat: 3,
  });
  const settle = (
    ledger: KillPotSchedule,
    handNumber: number,
    winners: string[],
    total: number,
    killHand: ReturnType<KillPotSchedule['decide']> | null,
    settings: KillSettings = FULL
  ) =>
    ledger.settle({
      handNumber,
      settings,
      variant: 'flh',
      isTournament: false,
      isBombHand: false,
      baseBigBlind: 4,
      killHand: killHand && killHand.kind === 'kill' ? killHand.hand : null,
      pots: [{ index: 0, amount: total }],
      awards: winners.map((w) => ({ userId: w, potIndex: 0 })),
      contestedTotal: total,
      seatOf: (u) => roster.find((p) => p.userId === u)?.seat ?? null,
      cancellation: killHand && killHand.kind === 'cancel' ? killHand.cancellation : null,
    });

  it('normal -> kill -> normal', () => {
    const ledger = new KillPotSchedule();
    // Hand 1: a normal hand; a scooped 12bb pot sets a kill for b.
    let d = ledger.decide(dealInput());
    expect(d.kind).toBe('none');
    ledger.commitDeal(d);
    const r1 = settle(ledger, 1, ['b'], 48, d);
    expect(r1.record?.next_kill).toMatchObject({ killer_user_id: 'b', killer_seat: 2 });
    ledger.bindTriggerHandId(1, 'row-1', r1.record);
    // Hand 2: the kill hand.
    d = ledger.decide(dealInput());
    expect(d.kind).toBe('kill');
    expect(d.kind === 'kill' && d.hand.triggerHandId).toBe('row-1');
    ledger.commitDeal(d);
    const r2 = settle(ledger, 2, ['a', 'c'], 100, d);
    expect(r2.record).toMatchObject({
      kill_hand: { killer_user_id: 'b', trigger_hand_id: 'row-1', chained: false },
      next_kill: null,
    });
    // Hand 3: a normal hand again.
    d = ledger.decide(dealInput());
    expect(d.kind).toBe('none');
  });

  it('chained kill without escalation', () => {
    const ledger = new KillPotSchedule();
    let d = ledger.decide(dealInput());
    ledger.commitDeal(d);
    settle(ledger, 1, ['a'], 40, d);
    d = ledger.decide(dealInput());
    ledger.commitDeal(d);
    const r2 = settle(ledger, 2, ['c'], 160, d);
    expect(r2.record?.kill_hand?.killer_user_id).toBe('a');
    expect(r2.record?.next_kill).toMatchObject({
      killer_user_id: 'c',
      chained: true,
      mode: 'full',
    });
    d = ledger.decide(dealInput());
    expect(d.kind === 'kill' && [d.hand.killerUserId, d.hand.smallBet, d.hand.chained]).toEqual([
      'c',
      8,
      true,
    ]);
  });

  it('a duplicate settlement event for the same hand schedules nothing twice', () => {
    const ledger = new KillPotSchedule();
    const d = ledger.decide(dealInput());
    ledger.commitDeal(d);
    const first = settle(ledger, 7, ['a'], 40, d);
    const second = settle(ledger, 7, ['b'], 400, d);
    expect(second.duplicate).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(ledger.getPending()?.killerUserId).toBe('a');
    // And the kill hand is not spent by a duplicate of ITS settlement either.
    const k = ledger.decide(dealInput());
    ledger.commitDeal(k);
    settle(ledger, 8, ['b', 'c'], 40, k);
    settle(ledger, 8, ['b', 'c'], 40, k);
    expect(ledger.getPending()).toBeNull();
  });

  it('a cancellation is final and recorded; the killer returning later gets nothing', () => {
    const ledger = new KillPotSchedule();
    let d = ledger.decide(dealInput());
    ledger.commitDeal(d);
    settle(ledger, 1, ['a'], 40, d);
    // a sat out: not in the roster.
    d = ledger.decide(
      dealInput(
        FULL,
        roster.filter((p) => p.userId !== 'a')
      )
    );
    expect(d).toMatchObject({ kind: 'cancel', cancellation: { reason: 'killer_not_dealt_in' } });
    ledger.commitDeal(d);
    const r = settle(ledger, 2, ['b', 'c'], 20, d);
    expect(r.record).toMatchObject({
      kill_hand: null,
      next_kill: null,
      cancelled: { reason: 'killer_not_dealt_in', killer_user_id: 'a' },
    });
    // Back from sit-out on the next hand: no kill is owed or played.
    expect(ledger.decide(dealInput()).kind).toBe('none');
  });

  it('a prepared but never started deal changes nothing', () => {
    const ledger = new KillPotSchedule();
    const d0 = ledger.decide(dealInput());
    ledger.commitDeal(d0);
    settle(ledger, 1, ['a'], 40, d0);
    ledger.decide(
      dealInput(
        FULL,
        roster.filter((p) => p.userId !== 'a')
      )
    ); // not committed
    expect(ledger.decide(dealInput()).kind).toBe('kill');
  });

  it('an in-flight kill hand abandoned before settlement leaves the kill pending', () => {
    const ledger = new KillPotSchedule();
    const d0 = ledger.decide(dealInput());
    ledger.commitDeal(d0);
    settle(ledger, 1, ['a'], 40, d0);
    const k = ledger.decide(dealInput());
    ledger.commitDeal(k); // dealt, then voided / crashed: never settles
    const again = ledger.decide(dealInput());
    expect(again.kind === 'kill' && again.hand.killerUserId).toBe('a');
  });

  it('config change mid-chain: the pending kill keeps its mode; the next trigger uses the new one', () => {
    const ledger = new KillPotSchedule();
    const d0 = ledger.decide(dealInput(FULL));
    ledger.commitDeal(d0);
    settle(ledger, 1, ['a'], 40, d0, FULL);
    // Owner switches to half before the kill hand is dealt.
    const k = ledger.decide(dealInput(HALF));
    expect(k.kind === 'kill' && [k.hand.mode, k.hand.smallBet]).toEqual(['full', 8]);
    ledger.commitDeal(k);
    // The kill hand was dealt under HALF, so its own trigger is a half kill.
    const r = settle(ledger, 2, ['b'], 40, k, HALF);
    expect(r.record?.next_kill).toMatchObject({ killer_user_id: 'b', mode: 'half', chained: true });
    const n = ledger.decide(dealInput(HALF));
    expect(n.kind === 'kill' && [n.hand.mode, n.hand.smallBet, n.hand.bigBet]).toEqual([
      'half',
      6,
      12,
    ]);
    // And switching OFF cancels a pending kill at the next boundary.
    ledger.commitDeal(n);
    settle(ledger, 3, ['c'], 40, n, HALF);
    const off = ledger.decide(dealInput(OFF));
    expect(off).toMatchObject({ kind: 'cancel', cancellation: { reason: 'kill_mode_off' } });
  });

  it('restart restore: the trigger row brings the pending kill back, keyed to its id', () => {
    const ledger = new KillPotSchedule();
    const d0 = ledger.decide(dealInput(HALF));
    ledger.commitDeal(d0);
    const r = settle(ledger, 41, ['c'], 52, d0, HALF);
    const written = ledger.bindTriggerHandId(41, 'row-41', r.record);
    expect(written?.next_kill?.trigger_hand_id).toBe('row-41');
    // A fresh engine reads the table's last row back.
    const fresh = new KillPotSchedule();
    fresh.restore(
      pendingKillFromHistoryRow({
        id: 'row-41',
        hand_number: 41,
        kill_pot: JSON.parse(JSON.stringify(written)),
      })
    );
    expect(fresh.getPending()).toEqual(ledger.getPending());
    const k = fresh.decide(dealInput(HALF));
    expect(
      k.kind === 'kill' && [k.hand.killerUserId, k.hand.triggerHandId, k.hand.killBlind]
    ).toEqual(['c', 'row-41', 6]);
  });

  it('restore reads nothing from a row without a next kill or a malformed one', () => {
    expect(pendingKillFromHistoryRow(null)).toBeNull();
    expect(pendingKillFromHistoryRow({ id: 'r', hand_number: 1, kill_pot: null })).toBeNull();
    expect(
      pendingKillFromHistoryRow({
        id: 'r',
        hand_number: 1,
        kill_pot: {
          rule_version: KILL_RULE_VERSION,
          kill_hand: null,
          next_kill: null,
          cancelled: null,
        },
      })
    ).toBeNull();
    expect(
      pendingKillFromHistoryRow({
        id: 'r',
        hand_number: 1,
        kill_pot: {
          rule_version: 'kill-v0',
          next_kill: { killer_user_id: 'a', killer_seat: 1, mode: 'full' },
        },
      })
    ).toBeNull();
    expect(
      pendingKillFromHistoryRow({
        id: 'r',
        hand_number: 1,
        kill_pot: {
          rule_version: KILL_RULE_VERSION,
          next_kill: { killer_user_id: 'a', killer_seat: 0, mode: 'full' },
        },
      })
    ).toBeNull();
  });

  it('the record is null on a hand with no kill facts', () => {
    expect(buildKillPotRecord({ killHand: null, trigger: null, cancellation: null })).toBeNull();
  });
});
