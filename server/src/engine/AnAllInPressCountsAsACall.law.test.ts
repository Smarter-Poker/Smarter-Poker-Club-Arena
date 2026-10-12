/**
 * LAW: AN ALL-IN PRESS IS NEVER REFUSED WHERE A CALL IS LEGAL.
 *
 * Owner ruling, 2026-10-04, from live mobile play in a tournament:
 *
 *   "IF A PLAYER IS FACING A LARGE BET, AND CLICKS 'ALL IN' INSTEAD OF CALL
 *    THE BET, (EVEN IF THEY ARE LAST ACTION) THE 'ALL IN' CLICK COUNTS AS A
 *    'CALL'. IT CURRENTLY SILENTLY FAILS, AND FORCES YOU TO CLICK CALL.
 *    EITHER ONE SHOULD WORK."
 *
 * The defect: HandController.performAction returned false for an `all_in`
 * that could not be a legal raise - a covered player who may not reopen
 * betting (TDA 44/47), or a pot-limit shove whose clamp lands on an illegal
 * raise. The action bar stayed up and the player had to press Call.
 *
 * The rule now: whenever the seat on the clock may call, an all_in is either
 * a genuine shove (exactly as before) or it is executed as a plain CALL of
 * min(toCall, stack) - a CHECK when nothing is owed. The record, the history
 * and the PLAYER_ACTION broadcast say `call`; the rest of the stack stays
 * behind; betting is not reopened; lastRaise / minRaise / lastAggressorSeat
 * do not move. A `raise` with an explicit illegal amount is still refused,
 * and the advertised menu still withholds all_in where it is not a real
 * shove, so nothing that chooses from the menu changes its meaning.
 */
import { describe, it, expect, vi } from 'vitest';
import { HandController } from './HandController.js';
import { fuzzOneHand } from './HandFuzzer.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('./ServerTableEngine.js');

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

function harness(stacks: number[], over: Partial<HandConfig> = {}) {
  const config = {
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
  const events: HandEvent[] = [];
  const hc = new HandController(config, mkPlayers(stacks), 1);
  let complete = false;
  let rake = 0;
  let runoutPending = false;
  let runoutSeen = false;
  hc.onEvent((e) => {
    events.push(e);
    if (e.type === 'HAND_COMPLETE') {
      complete = true;
      rake = (e.rake ?? 0) + (e.bbjFee ?? 0);
    }
    if (e.type === 'ALL_IN_RUNOUT') {
      runoutPending = true;
      runoutSeen = true;
    }
  });
  const start = stacks.reduce((n, s) => n + s, 0);
  const st = () => (hc as unknown as { state: any }).state;
  const seat = (s: number) => st().players.find((p: SeatPlayer) => p.seat === s) as SeatPlayer;
  const cents = (n: number) => Math.round(n * 100) / 100;
  /** Chips on the table: every stack plus the pot (plus the drop once settled). */
  const chips = () =>
    cents(
      st().players.reduce((n: number, p: SeatPlayer) => n + p.stack, 0) +
        (complete ? rake : st().pot)
    );
  const act = (s: number, action: string, amount = 0) => hc.performAction(s, action as any, amount);
  const last = () => st().actionHistory.at(-1);
  const lastBroadcast = () => events.filter((e) => e.type === 'PLAYER_ACTION').at(-1) as any;
  const menu = (s: number): string[] => {
    const tcs = events.filter((e: any) => e.type === 'TURN_CHANGE' && e.seat === s);
    return tcs.length ? ((tcs.at(-1) as any).availableActions as string[]) : [];
  };
  const uncalled = () => events.filter((e) => e.type === 'UNCALLED_BET_RETURNED') as any[];
  /** Check or call the hand down to its settlement. */
  const finish = () => {
    for (let n = 0; n < 60 && !complete; n++) {
      if (runoutPending) {
        runoutPending = false;
        hc.continueRunout();
        continue;
      }
      const s = st();
      const p = seat(s.currentPlayerSeat);
      expect(p, `nobody to act at stage ${s.stage}`).toBeTruthy();
      expect(act(p.seat, p.bet < s.currentBet ? 'call' : 'check')).toBe(true);
      expect(chips()).toBe(start);
    }
    expect(complete).toBe(true);
    expect(chips()).toBe(start);
  };
  return {
    hc,
    st,
    seat,
    chips,
    start,
    act,
    last,
    lastBroadcast,
    menu,
    uncalled,
    finish,
    /** The hand ended or went to an all-in runout: no betting round is open. */
    roundClosed: () => complete || runoutSeen,
  };
}

/** The exact fingerprint of "this press was a call, nothing more". */
function expectPlainCall(
  h: ReturnType<typeof harness>,
  s: number,
  before: {
    stack: number;
    bet: number;
    lastRaise: number;
    minRaise: number;
    aggressor: number;
    stage: string;
  },
  toCall: number
) {
  expect(h.last()).toMatchObject({ seat: s, action: 'call', amount: toCall });
  expect(h.last().isFullRaise).toBeUndefined();
  expect(h.lastBroadcast()).toMatchObject({ seat: s, action: 'call', amount: toCall });
  expect(h.lastBroadcast().record).toMatchObject({ action: 'call', amount: toCall });
  expect(h.seat(s).stack).toBe(Math.round((before.stack - toCall) * 100) / 100);
  expect(h.seat(s).is_all_in).toBe(false);
  expect(h.st().actionHistory.some((a: any) => a.seat === s && a.action === 'all_in')).toBe(false);
  // A press that closes the betting round lets the engine reset its own
  // raise bookkeeping; while the round is still open none of it may move.
  if (h.st().stage === before.stage && !h.roundClosed()) {
    expect(h.st().lastAggressorSeat).toBe(before.aggressor);
    expect(h.st().lastRaise).toBe(before.lastRaise);
    expect(h.st().minRaise).toBe(before.minRaise);
  }
  expect(h.chips()).toBe(h.start);
}

function snapshot(h: ReturnType<typeof harness>, s: number) {
  return {
    stack: h.seat(s).stack,
    bet: h.seat(s).bet,
    lastRaise: h.st().lastRaise,
    minRaise: h.st().minRaise,
    aggressor: h.st().lastAggressorSeat,
    stage: h.st().stage,
  };
}

// Seats: 1=Dealer, 2=SB (short), 3=BB, 4=UTG. Preflop order: 4, 1, 2, 3.
// UTG raises to 6, Dealer calls, SB shoves 8 total: a 2 increment against a
// last raise of 4, so it is a SHORT all-in and reopens betting to nobody who
// has already acted.
function shortAllInSpot(over: Partial<HandConfig> = {}, stacks = [200, 8, 200, 200]) {
  const h = harness(stacks, over);
  h.hc.start();
  expect(h.act(4, 'raise', 6)).toBe(true);
  expect(h.act(1, 'call')).toBe(true);
  expect(h.act(2, 'all_in')).toBe(true);
  expect(h.st().currentBet).toBe(8);
  return h;
}

describe('an ALL IN press where only a call is legal is the call (owner ruling 2026-10-04)', () => {
  it('no-limit: a covered player who already acted presses all_in mid-round -> call', () => {
    const h = shortAllInSpot();
    expect(h.act(3, 'call')).toBe(true);
    expect(h.st().currentPlayerSeat).toBe(4);
    // The menu is unchanged: all_in is still not advertised here.
    expect(h.menu(4)).toEqual(['fold', 'call']);
    const before = snapshot(h, 4);
    expect(h.act(4, 'all_in')).toBe(true);
    expectPlainCall(h, 4, before, 2);
    expect(h.seat(4).stack).toBe(192);
    expect(h.seat(4).bet).toBe(8);
    // Betting was not reopened and the round is still open for the Dealer.
    expect(h.st().stage).toBe('preflop');
    expect(h.st().currentBet).toBe(8);
    expect(h.st().lastRaise).toBe(before.lastRaise);
    expect(h.st().minRaise).toBe(before.minRaise);
    expect(h.st().currentPlayerSeat).toBe(1);
    expect(h.menu(1)).toEqual(['fold', 'call']);
  });

  it('no-limit: the same press from the LAST player to act closes the street', () => {
    const h = shortAllInSpot();
    expect(h.act(3, 'call')).toBe(true);
    expect(h.act(4, 'all_in')).toBe(true);
    const before = snapshot(h, 1);
    expect(h.act(1, 'all_in')).toBe(true);
    expectPlainCall(h, 1, before, 2);
    expect(h.seat(1).stack).toBe(192);
    // Round complete: the flop is dealt and the three covered players, none of
    // them all-in, still have a betting round to play.
    expect(h.st().stage).toBe('flop');
    expect(h.st().pot).toBe(32);
    expect([1, 3, 4].every((s) => !h.seat(s).is_all_in && h.seat(s).stack === 192)).toBe(true);
    expect(h.st().currentPlayerSeat).toBe(3);
    expect(h.menu(3)).toContain('bet');
    h.finish();
  });

  it('heads-up: the opponent is all-in for less, hero presses all_in -> call, board runs out', () => {
    // Heads-up the Dealer is the SB and acts first. Hero raises to 6; the BB
    // shoves 9 total (a 3 increment against a last raise of 4: short).
    const h = harness([200, 9]);
    h.hc.start();
    expect(h.act(1, 'raise', 6)).toBe(true);
    expect(h.act(2, 'all_in')).toBe(true);
    expect(h.st().currentPlayerSeat).toBe(1);
    expect(h.menu(1)).toEqual(['fold', 'call']);
    const before = snapshot(h, 1);
    expect(h.act(1, 'all_in')).toBe(true);
    expectPlainCall(h, 1, before, 3);
    expect(h.seat(1).stack).toBe(191);
    // Nothing was over-committed, so there is nothing to hand back.
    h.finish();
    expect(h.uncalled()).toEqual([]);
    expect(h.seat(1).stack).toBeGreaterThanOrEqual(191);
    expect(
      h
        .st()
        .actionHistory.filter((a: any) => a.seat === 1)
        .map((a: any) => a.action)
    ).toEqual(['raise', 'call']);
  });

  it('pot-limit: an over-cap shove from a player who cannot reopen -> call', () => {
    const h = shortAllInSpot({ gameVariant: 'plo4' as HandConfig['gameVariant'] });
    expect(h.act(3, 'call')).toBe(true);
    expect(h.menu(4)).toEqual(['fold', 'call']);
    const before = snapshot(h, 4);
    // 194 behind is far over the pot: the clamp turns this into a pot raise,
    // which this seat may not make. It used to be refused outright.
    expect(h.act(4, 'all_in')).toBe(true);
    expectPlainCall(h, 4, before, 2);
    expect(h.st().currentBet).toBe(8);
    expect(h.st().currentPlayerSeat).toBe(1);
    expect(h.act(1, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 1, action: 'call', amount: 2 });
    expect(h.st().stage).toBe('flop');
    h.finish();
  });

  it.each(['nlh', 'plo4'])(
    '%s: a stack just over the call keeps its last chips behind',
    (variant) => {
      // Dealer has 9: 6 in, 3 behind, 2 to call. A shove would be a 1-chip
      // raise this seat may not make, so it calls 2 and keeps 1.
      const h = shortAllInSpot(
        { gameVariant: variant as HandConfig['gameVariant'] },
        [9, 8, 200, 200]
      );
      expect(h.act(3, 'call')).toBe(true);
      expect(h.act(4, 'call')).toBe(true);
      const before = snapshot(h, 1);
      expect(h.act(1, 'all_in')).toBe(true);
      expectPlainCall(h, 1, before, 2);
      expect(h.seat(1).stack).toBe(1);
      h.finish();
    }
  );

  it.each(['flh', 'flo8'])(
    '%s: the fixed-limit degrade (2026-08-23) still calls for a deep stack',
    (variant) => {
      const h = harness([200, 2.99, 200, 200], { gameVariant: variant as any });
      h.hc.start();
      expect(h.act(4, 'call')).toBe(true);
      expect(h.act(1, 'call')).toBe(true);
      expect(h.act(2, 'all_in')).toBe(true); // 0.99 over: under half a bet
      expect(h.act(3, 'call')).toBe(true);
      // Fixed limit has advertised this press since 2026-08-23, because its
      // structure clamp already turned it into the call.
      expect(h.menu(4)).toEqual(['fold', 'call', 'all_in']);
      const before = snapshot(h, 4);
      expect(h.act(4, 'all_in')).toBe(true);
      expectPlainCall(h, 4, before, 0.99);
      expect(h.seat(4).stack).toBe(197.01);
      expect(h.act(1, 'all_in')).toBe(true);
      expect(h.last()).toMatchObject({ seat: 1, action: 'call', amount: 0.99 });
      h.finish();
    }
  );

  it.each(['flh', 'flo8'])(
    '%s: a short fixed-limit stack that fits under the bet but may not reopen -> call',
    (variant) => {
      // UTG has 4.5: 2 in, 2.5 behind, 0.99 to call. The shove fits under the
      // fixed bet, so the structure clamp leaves it alone - it was the reopen
      // rule that used to refuse it.
      const h = harness([200, 2.99, 200, 4.5], { gameVariant: variant as any });
      h.hc.start();
      expect(h.act(4, 'call')).toBe(true);
      expect(h.act(1, 'call')).toBe(true);
      expect(h.act(2, 'all_in')).toBe(true);
      expect(h.act(3, 'call')).toBe(true);
      const before = snapshot(h, 4);
      expect(h.act(4, 'all_in')).toBe(true);
      expectPlainCall(h, 4, before, 0.99);
      expect(h.seat(4).stack).toBe(1.51);
      h.finish();
    }
  );
});

describe('nothing owed: the same principle gives a check', () => {
  it('pot-limit, a pot smaller than the minimum bet: the press checks and commits nothing', () => {
    const h = harness([200, 200, 200, 200], { gameVariant: 'plo4' as HandConfig['gameVariant'] });
    h.hc.start();
    for (const s of [4, 1, 2]) expect(h.act(s, 'call')).toBe(true);
    expect(h.act(3, 'check')).toBe(true);
    expect(h.st().stage).toBe('flop');
    const s = h.st().currentPlayerSeat;
    // No natural hand leaves a pot-limit pot under one big blind with players
    // still to act, so the state is forced: with a pot of 1 the largest legal
    // bet (1) is below the minimum bet (2) and no wager exists at all.
    h.st().pot = 1;
    const stack = h.seat(s).stack;
    expect(h.act(s, 'bet', 1)).toBe(false);
    expect(h.act(s, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: s, action: 'check', amount: 0 });
    expect(h.lastBroadcast()).toMatchObject({ seat: s, action: 'check', amount: 0 });
    expect(h.seat(s)).toMatchObject({ stack, bet: 0, is_all_in: false });
    expect(h.st().pot).toBe(1);
    expect(h.st().currentBet).toBe(0);
    expect(h.st().stage).toBe('flop');
    expect(h.st().currentPlayerSeat).not.toBe(s);
  });
});

describe('what the ruling does NOT change', () => {
  it('a genuinely legal shove still goes all-in as a raise', () => {
    const h = shortAllInSpot();
    // The BB has not acted yet, so it may raise over the short all-in.
    expect(h.menu(3)).toContain('all_in');
    expect(h.act(3, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 3, action: 'all_in', amount: 200, isFullRaise: true });
    expect(h.lastBroadcast()).toMatchObject({ seat: 3, action: 'all_in', amount: 200 });
    expect(h.seat(3)).toMatchObject({ stack: 0, bet: 200, is_all_in: true });
    expect(h.st().currentBet).toBe(200);
    expect(h.st().lastAggressorSeat).toBe(3);
    expect(h.chips()).toBe(h.start);
    // And that full raise reopens betting for UTG, whose own shove is real too.
    expect(h.menu(4)).toContain('all_in');
    expect(h.act(4, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 4, action: 'all_in' });
    expect(h.seat(4).is_all_in).toBe(true);
  });

  it('a short stack whose all-in IS the call still goes all-in', () => {
    const h = shortAllInSpot({}, [8, 8, 200, 200]);
    expect(h.act(3, 'call')).toBe(true);
    expect(h.act(4, 'call')).toBe(true);
    expect(h.menu(1)).toContain('all_in');
    expect(h.act(1, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 1, action: 'all_in', amount: 8 });
    expect(h.seat(1)).toMatchObject({ stack: 0, is_all_in: true });
    expect(h.chips()).toBe(h.start);
  });

  it('heads-up facing a FULL all-in raise: the over-the-top shove is accepted and the excess returned', () => {
    // Nobody is left to respond, but the shove is a legal raise today and
    // stays one; the uncalled 150 comes straight back at settlement.
    const h = harness([200, 50]);
    h.hc.start();
    expect(h.act(1, 'raise', 6)).toBe(true);
    expect(h.act(2, 'all_in')).toBe(true); // 50 total: a full raise
    expect(h.menu(1)).toContain('all_in');
    expect(h.act(1, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 1, action: 'all_in', amount: 200 });
    expect(h.chips()).toBe(h.start);
    h.finish();
    expect(h.uncalled()).toMatchObject([{ seat: 1, amount: 150 }]);
    expect(h.seat(1).stack).toBeGreaterThanOrEqual(150);
  });

  it('pot-limit: a shove from a player who MAY raise is still clamped to a pot raise', () => {
    const h = shortAllInSpot({ gameVariant: 'plo4' as HandConfig['gameVariant'] });
    expect(h.act(3, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 3, action: 'raise' });
    expect(h.seat(3).is_all_in).toBe(false);
    expect(h.seat(3).stack).toBeGreaterThan(0);
    expect(h.st().currentBet).toBeGreaterThan(8);
    expect(h.chips()).toBe(h.start);
  });

  it('a `raise` with an explicit illegal amount is still refused, and moves nothing', () => {
    const h = shortAllInSpot();
    expect(h.act(3, 'call')).toBe(true);
    const frozen = JSON.stringify(h.hc.getState());
    expect(h.act(4, 'raise', 20)).toBe(false); // may not reopen
    expect(h.act(4, 'raise', 200)).toBe(false); // not even for the whole stack
    expect(h.act(4, 'raise', 9)).toBe(false);
    expect(h.act(4, 'bet', 20)).toBe(false);
    expect(h.act(4, 'check')).toBe(false);
    expect(JSON.stringify(h.hc.getState())).toBe(frozen);
    expect(h.st().currentPlayerSeat).toBe(4);
    expect(h.act(4, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 4, action: 'call', amount: 2 });
  });

  it('all-in-or-fold preflop has no call, so the press is never turned into one', () => {
    const h = harness([200, 200, 200, 200], { allInOrFold: true } as Partial<HandConfig>);
    h.hc.start();
    expect(h.menu(4)).toEqual(['fold', 'all_in']);
    expect(h.act(4, 'call')).toBe(false);
    expect(h.act(4, 'all_in')).toBe(true);
    expect(h.last()).toMatchObject({ seat: 4, action: 'all_in', amount: 200 });
  });

  it('the advertised menu and legalActions still withhold all_in where it is only a call', () => {
    const h = shortAllInSpot();
    expect(h.act(3, 'call')).toBe(true);
    expect(h.hc.getAuthoritativeActionState('u4')).toMatchObject({
      canAct: true,
      legalActions: ['fold', 'call'],
      toCall: 2,
      minRaiseTo: null,
      maxRaiseTo: null,
    });
  });
});

describe('the press reaches the engine from a real client request', () => {
  function tableEngine(h: ReturnType<typeof harness>, tableInfo: Record<string, unknown>) {
    const engine = new ServerTableEngine('all-in-press') as any;
    engine.handController = h.hc;
    engine.tableInfo = { big_blind: 2, small_blind: 1, max_players: 4, ...tableInfo };
    engine.showHandCards = new Map();
    engine.hub = { publish: vi.fn(), emitEvent: vi.fn() };
    engine.lifecycleCanMutate = () => true;
    engine.requestSnapshot = vi.fn();
    return engine;
  }

  it.each(['allin', 'all_in', 'all-in', 'ALLIN'])(
    'handlePlayerAction(%s) answers success and the hand records a call',
    (wire) => {
      const h = shortAllInSpot();
      expect(h.act(3, 'call')).toBe(true);
      const engine = tableEngine(h, { game_variant: 'nlh' });
      try {
        engine.turnFSM.transition('timer_running');
        const before = snapshot(h, 4);
        // The client sends the hero's stack as the amount.
        expect(engine.handlePlayerAction('u4', wire, 194)).toEqual({ success: true });
        expectPlainCall(h, 4, before, 2);
        expect(h.st().currentPlayerSeat).toBe(1);
      } finally {
        engine.preciseTimer?.dispose();
      }
    }
  );

  it('a sized raise of the whole stack is NOT given the all-in button tolerance', () => {
    const h = shortAllInSpot();
    expect(h.act(3, 'call')).toBe(true);
    const engine = tableEngine(h, { game_variant: 'nlh' });
    try {
      engine.turnFSM.transition('timer_running');
      const frozen = JSON.stringify(h.hc.getState());
      // raise-to 200 is this seat's whole stack; the request path promotes
      // that to all_in, and it must still be refused as the illegal raise it is.
      expect(engine.handlePlayerAction('u4', 'raise', 200)).toMatchObject({
        success: false,
        code: 'INVALID_ACTION',
      });
      expect(JSON.stringify(h.hc.getState())).toBe(frozen);
      expect(engine.handlePlayerAction('u4', 'allin', 194)).toEqual({ success: true });
      expect(h.last()).toMatchObject({ seat: 4, action: 'call', amount: 2 });
    } finally {
      engine.preciseTimer?.dispose();
    }
  });

  it('a capped table: the press that the cap rewrites into an illegal raise is the call', () => {
    const h = shortAllInSpot();
    expect(h.act(3, 'call')).toBe(true);
    // Cap of 50 BB = 100 chips a hand. UTG has 6 in, so the cap would rewrite
    // the shove into a raise to 100 - a raise this seat may not make.
    const engine = tableEngine(h, { game_variant: 'nlh', cap_enabled: true, cap_bb: 50 });
    try {
      engine.turnFSM.transition('timer_running');
      const before = snapshot(h, 4);
      expect(engine.handlePlayerAction('u4', 'allin', 194)).toEqual({ success: true });
      expectPlainCall(h, 4, before, 2);
    } finally {
      engine.preciseTimer?.dispose();
    }
  });

  it('a capped table: a press that IS a legal capped raise still raises to the cap', () => {
    const h = shortAllInSpot();
    const engine = tableEngine(h, { game_variant: 'nlh', cap_enabled: true, cap_bb: 50 });
    try {
      engine.turnFSM.transition('timer_running');
      // The BB has not acted: 2 in, cap leaves 98 more -> raise to 100.
      expect(engine.handlePlayerAction('u3', 'allin', 198)).toEqual({ success: true });
      expect(h.last()).toMatchObject({ seat: 3, action: 'raise', amount: 100 });
      expect(h.seat(3)).toMatchObject({ stack: 100, is_all_in: false });
      expect(h.chips()).toBe(h.start);
    } finally {
      engine.preciseTimer?.dispose();
    }
  });
});

describe('property: across random hands the press is always exactly the passive action', () => {
  // The fuzzer presses all_in wherever the menu offers call/check but not
  // all_in, asserts INV-ALLIN-IS-CALL on each press, and keeps every one of
  // its chip-conservation invariants running across the rest of the hand.
  it('never refuses and never moves a chip more than the call (every variant, kill pots too)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let presses = 0;
    let hands = 0;
    try {
      for (let seed = 20261004; seed < 20261004 + 4000; seed++) {
        const r = fuzzOneHand(seed, { pressAllIn: true, kill: seed % 5 === 0 });
        presses += r.allInPresses;
        hands++;
      }
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    expect(hands).toBe(4000);
    // The corpus must actually reach the spot, or this proves nothing.
    expect(presses).toBeGreaterThan(50);
  }, 120_000);
});
