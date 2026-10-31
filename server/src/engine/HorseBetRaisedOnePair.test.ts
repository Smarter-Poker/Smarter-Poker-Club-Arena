/**
 * V66 (2026-10-31): a hold'em one-pair (or air) hand that BET the flop or
 * turn and was RAISED is a bluff-catcher facing the strongest "they have it"
 * signal in the game, and it was priced as a committed hand because its own
 * wager counted toward the commitment test. Measured over 7 days of NLH
 * review hands (12% sample, |net| >= 20bb): flop bet, raised, call with one
 * pair or air won 32.8% in cash (n=1,040, about -241,000bb a week) and 33.8%
 * in tournaments (n=805, -163,000bb); the turn line won 33.1% / 36.0%
 * (-179,000 / -111,000bb); the horse folded 15 of 1,196 flop decisions.
 *
 * V66: hero's own wager this street no longer counts toward commitment (the
 * post-call SPR decides), the call carries a raise shade of up to ten equity
 * points scaled by the raise size, and the class calls or folds at that price
 * without jamming. Real draws, two pair of hero's own cards and better, the
 * river and Omaha keep their paths.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic, v66BetRaisedShade, holdemRealDraw } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

type Fixture = {
  variant?: string;
  hole: string;
  board: string;
  street: 'flop' | 'turn' | 'river';
  mode?: string;
  /** chips each player started the hand with (bb = 2) */
  stackChips?: number;
  /** hero's wager this street, and villain's raise-to */
  heroBet?: number;
  raiseTo?: number;
};

/**
 * Hero opened preflop, villain called (pot 12). On every street before the
 * decision street both checked. On the decision street hero bet 2/3 pot
 * (8 into 12) and villain raised 3x (to 24): toCall 16 into a pot of 44.
 */
function betRaised(f: Fixture) {
  const stackChips = f.stackChips ?? 200;
  const heroBet = f.heroBet ?? 8;
  const raiseTo = f.raiseTo ?? 24;
  const players: SeatPlayer[] = [
    {
      seat: 1,
      user_id: 'hero',
      username: 'h',
      stack: stackChips - 6 - heroBet,
      bet: heroBet,
      totalInvested: 6 + heroBet,
      cards: cards(f.hole),
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 2,
      user_id: 'villain',
      username: 'v',
      stack: stackChips - 6 - raiseTo,
      bet: raiseTo,
      totalInvested: 6 + raiseTo,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
  ];
  const history: Array<Record<string, unknown>> = [
    { stage: 'preflop', seat: 1, userId: 'hero', action: 'raise', amount: 6, timestamp: 1 },
    { stage: 'preflop', seat: 2, userId: 'villain', action: 'call', amount: 4, timestamp: 2 },
  ];
  const streets: Array<'flop' | 'turn' | 'river'> = ['flop', 'turn', 'river'];
  for (const st of streets) {
    if (st === f.street) break;
    history.push({ stage: st, seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 3 });
    history.push({ stage: st, seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 4 });
  }
  history.push({ stage: f.street, seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 5 });
  history.push({ stage: f.street, seat: 1, userId: 'hero', action: 'bet', amount: heroBet, timestamp: 6 });
  history.push({ stage: f.street, seat: 2, userId: 'villain', action: 'raise', amount: raiseTo, timestamp: 7 });
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: cards(f.board),
      pot: 12 + heroBet + raiseTo,
      currentBet: raiseTo,
      minRaise: raiseTo - heroBet,
      stage: f.street,
      gameVariant: f.variant ?? 'nlh',
      gameMode: f.mode ?? 'cash',
      bigBlind: 2,
      dealerSeat: 2,
      actionHistory: history,
    },
  };
}

type Freq = { call: number; fold: number; raise: number; fired: number; n: number };

/** Action frequencies over `seeds` seeded decisions, telemetry drained per seed. */
function frequencies(f: Fixture, opts: Record<string, unknown>, seeds = 40): Freq {
  const out: Freq = { call: 0, fold: 0, raise: 0, fired: 0, n: seeds };
  for (let i = 0; i < seeds; i++) {
    seedFastRandom(0x66000 + i);
    HorseMind.reset();
    drainFires();
    const s = betRaised(f);
    const d = HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      ...opts,
    } as never);
    if (d.action === 'call') out.call++;
    else if (d.action === 'fold') out.fold++;
    else out.raise++;
    if (fires()['v66_bet_raised_one_pair']) out.fired++;
  }
  return out;
}

const show = (name: string, on: Freq, off: Freq) =>
  `${name}: V66 on call=${on.call}/${on.n} fold=${on.fold} raise/jam=${on.raise} fired=${on.fired}; ` +
  `V66 off call=${off.call}/${off.n} fold=${off.fold} raise/jam=${off.raise} fired=${off.fired}`;

const OFF = { v66BetRaisedOnePair: false };

describe('V66: a hold em one pair that bet and was raised is priced against the raise', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed66);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  describe('flop: hero c-bets 2/3 pot, villain raises 3x', () => {
    const flop = (hole: string, board = 'Qh7d2s') =>
      ({ hole, board, street: 'flop' }) as const;

    it('top pair top kicker calls less with V66 on than off, and the receipt fires', () => {
      // a 3x raise (toCall 16 into 44, r = 0.36): priced, and still mostly a call
      const on = frequencies(flop('AsQd'), {});
      const off = frequencies(flop('AsQd'), OFF);
      const msg = show('flop TPTK AsQd on Qh7d2s vs 3x', on, off);
      expect(on.fired, msg).toBe(on.n);
      expect(off.fired, msg).toBe(0);
      expect(on.call, msg).toBeLessThanOrEqual(off.call);
      expect(on.raise, msg).toBe(0);
      // a 4x raise (toCall 24 into 52, r = 0.46): the full shade, and TPTK folds some
      const onBig = frequencies({ ...flop('AsQd'), raiseTo: 32 }, {});
      const offBig = frequencies({ ...flop('AsQd'), raiseTo: 32 }, OFF);
      const msgBig = show('flop TPTK AsQd on Qh7d2s vs 4x', onBig, offBig);
      expect(onBig.fired, msg + ' | ' + msgBig).toBe(onBig.n);
      expect(onBig.call, msg + ' | ' + msgBig).toBeLessThan(offBig.call);
      expect(onBig.raise, msgBig).toBe(0);
    });

    it('an under pair folds most of the time with V66 on', () => {
      const on = frequencies(flop('7s6d'), {});
      const off = frequencies(flop('7s6d'), OFF);
      const msg = show('flop under pair 7s6d on Qh7d2s', on, off);
      expect(on.fold, msg).toBeGreaterThan(on.n / 2);
      expect(on.call, msg).toBeLessThanOrEqual(off.call);
    });

    it('air with no draw folds most of the time with V66 on', () => {
      const on = frequencies(flop('Ks9d'), {});
      const off = frequencies(flop('Ks9d'), OFF);
      const msg = show('flop air Ks9d on Qh7d2s', on, off);
      expect(on.fold, msg).toBeGreaterThan(on.n / 2);
      expect(on.call, msg).toBeLessThanOrEqual(off.call);
    });

    it('two pair of hero own cards, a set and a flush draw are unchanged', () => {
      for (const [hole, board] of [
        ['Qs7c', 'Qh7d2s'],
        ['7s7c', 'Qh7d2s'],
        ['AhJh', 'Qh7h2s'],
        ['Jh9h', 'Qh7h2s'],
      ]) {
        const on = frequencies({ hole, board, street: 'flop' }, {});
        const off = frequencies({ hole, board, street: 'flop' }, OFF);
        const msg = show(`flop ${hole} on ${board}`, on, off);
        expect(on.fired, msg).toBe(0);
        expect(on, msg).toEqual(off);
      }
    });

    it('an open-ended straight draw keeps today path; a gutshot is air', () => {
      const oesd = frequencies(flop('Ts9d', 'Jh8d2s'), {});
      expect(oesd.fired, show('flop OESD Ts9d on Jh8d2s', oesd, oesd)).toBe(0);
      const gut = frequencies(flop('Ts6d', 'Jh8d2s'), {});
      expect(gut.fired, show('flop gutshot Ts6d on Jh8d2s', gut, gut)).toBe(gut.n);
    });
  });

  describe('turn: hero bets 2/3 pot, villain raises 3x', () => {
    const turn = (hole: string, board = 'Qh7d2s4c') =>
      ({ hole, board, street: 'turn' }) as const;

    it('top pair top kicker calls less with V66 on than off', () => {
      const on = frequencies(turn('AsQd'), {});
      const off = frequencies(turn('AsQd'), OFF);
      const msg = show('turn TPTK AsQd on Qh7d2s4c vs 3x', on, off);
      expect(on.fired, msg).toBe(on.n);
      expect(on.call, msg).toBeLessThanOrEqual(off.call);
      expect(on.raise, msg).toBe(0);
      const onBig = frequencies({ ...turn('AsQd'), raiseTo: 32 }, {});
      const offBig = frequencies({ ...turn('AsQd'), raiseTo: 32 }, OFF);
      const msgBig = show('turn TPTK AsQd on Qh7d2s4c vs 4x', onBig, offBig);
      expect(onBig.call, msg + ' | ' + msgBig).toBeLessThan(offBig.call);
      expect(onBig.raise, msgBig).toBe(0);
    });

    it('an under pair and air fold most of the time with V66 on', () => {
      const under = frequencies(turn('7s6d'), {});
      const underOff = frequencies(turn('7s6d'), OFF);
      expect(under.fold, show('turn under pair', under, underOff)).toBeGreaterThan(under.n / 2);
      const air = frequencies(turn('Ks9d'), {});
      const airOff = frequencies(turn('Ks9d'), OFF);
      expect(air.fold, show('turn air', air, airOff)).toBeGreaterThan(air.n / 2);
    });

    it('two pair of hero own cards and a flush draw are unchanged', () => {
      for (const [hole, board] of [
        ['Qs7c', 'Qh7d2s4c'],
        ['AhJh', 'Qh7h2s4c'],
      ]) {
        const on = frequencies({ hole, board, street: 'turn' }, {});
        const off = frequencies({ hole, board, street: 'turn' }, OFF);
        const msg = show(`turn ${hole} on ${board}`, on, off);
        expect(on.fired, msg).toBe(0);
        expect(on, msg).toEqual(off);
      }
    });

    it('applies in tournaments too', () => {
      const on = frequencies({ ...turn('AsQd'), mode: 'tournament' }, {});
      const off = frequencies({ ...turn('AsQd'), mode: 'tournament' }, OFF);
      const msg = show('turn TPTK tournament', on, off);
      expect(on.fired, msg).toBe(on.n);
      expect(on.call, msg).toBeLessThanOrEqual(off.call);
    });

    it('a short stack whose call leaves under one pot behind is still committed, at the shaded price', () => {
      // 40bb: hero has 66 behind facing 16 into 44; post-call SPR 50/60 < 1
      const on = frequencies({ ...turn('AsQd'), stackChips: 80 }, {});
      const off = frequencies({ ...turn('AsQd'), stackChips: 80 }, OFF);
      const msg = show('turn TPTK 40bb', on, off);
      expect(on.fired, msg).toBe(on.n);
      expect(on.raise, msg).toBe(0);
      expect(on.call, msg).toBeLessThanOrEqual(off.call);
    });
  });

  describe('what V66 leaves alone', () => {
    it('the river committed path is identical on and off', () => {
      const river = { hole: 'AsQd', board: 'Qh7d2s4c9h', street: 'river', stackChips: 80 } as const;
      const on = frequencies(river, {});
      const off = frequencies(river, OFF);
      const msg = show('river TPTK 40bb', on, off);
      expect(on.fired, msg).toBe(0);
      expect(on, msg).toEqual(off);
    });

    it('Omaha is unchanged', () => {
      const plo = { variant: 'plo4', hole: 'AsQdJc3h', board: 'Qh7d2s', street: 'flop' } as const;
      const on = frequencies(plo, {});
      const off = frequencies(plo, OFF);
      const msg = show('plo4 flop', on, off);
      expect(on.fired, msg).toBe(0);
      expect(on, msg).toEqual(off);
    });

    it('a one-pair hand that did not bet this street is unchanged', () => {
      // villain bet, hero faces it: no raisedAfterAggr
      const s = betRaised({ hole: 'AsQd', board: 'Qh7d2s', street: 'flop' });
      const history = s.gs.actionHistory.filter((a) => a.stage !== 'flop');
      history.push({ stage: 'flop', seat: 2, userId: 'villain', action: 'bet', amount: 24, timestamp: 5 });
      const hero = { ...s.hero, bet: 0, stack: 194, totalInvested: 6 };
      const gs = { ...s.gs, players: [hero, s.gs.players[1]], pot: 36, actionHistory: history };
      let fired = 0;
      for (let i = 0; i < 10; i++) {
        seedFastRandom(0x66100 + i);
        HorseMind.reset();
        drainFires();
        HorseLogic.decide(hero, gs as never, 'balanced', {}, { telemetry: true } as never);
        if (fires()['v66_bet_raised_one_pair']) fired++;
      }
      expect(fired).toBe(0);
    });
  });
});

describe('V66 shade shape', () => {
  it('is zero below a quarter of the pot and ten points from 0.45', () => {
    expect(v66BetRaisedShade(20, 100)).toBe(0);
    expect(v66BetRaisedShade(25, 100)).toBe(0);
    expect(v66BetRaisedShade(35, 100)).toBeCloseTo(0.05, 6);
    expect(v66BetRaisedShade(45, 100)).toBeCloseTo(0.1, 6);
    expect(v66BetRaisedShade(90, 100)).toBeCloseTo(0.1, 6);
    expect(v66BetRaisedShade(0, 100)).toBe(0);
    expect(v66BetRaisedShade(45, 100, 0.06)).toBeCloseTo(0.06, 6);
  });
});

describe('V66 real-draw classification', () => {
  it('flush draws with a hole card and eight-out straight draws are real; gutshots and backdoors are not', () => {
    expect(holdemRealDraw(cards('AhJh'), cards('Qh7h2s'))).toBe(true);
    expect(holdemRealDraw(cards('Ah2d'), cards('Qh7h2h'))).toBe(true);
    expect(holdemRealDraw(cards('AsJd'), cards('Qh7h2h'))).toBe(false);
    expect(holdemRealDraw(cards('Ts9d'), cards('Jh8d2s'))).toBe(true);
    expect(holdemRealDraw(cards('Ts6d'), cards('Jh8d2s'))).toBe(false);
    expect(holdemRealDraw(cards('Jd9d'), cards('KhTs7c'))).toBe(true);
    expect(holdemRealDraw(cards('AhJh'), cards('Qh7d2s'))).toBe(false);
    expect(holdemRealDraw(cards('Ts9d'), cards('Jh8d7s'))).toBe(false);
    expect(holdemRealDraw(cards('AsQd'), cards('Qh7d2s4c9h'))).toBe(false);
  });
});
