/**
 * REOPENING RULE — Bible V8 §4.14 / TDA Rule 44 (FIX-A1, 2026-07-19).
 *
 * A raise or all-in of LESS THAN a full raise does not reopen the betting to a
 * player who has already voluntarily acted this street and is not now facing a
 * full raise made since their last action. Such a player may only call or fold.
 *
 * These drive the real HandController and assert both the advertised action menu
 * (TURN_CHANGE.availableActions) and the authoritative server enforcement
 * (performAction rejects an illegal raise/shove, still accepts a legal call).
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
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  const cur = () => st().currentPlayerSeat;
  const actSeat = (s: number, action: string, amount = 0) =>
    hc.performAction(s, action as any, amount);
  // latest advertised action menu for a seat (from its most recent TURN_CHANGE)
  const menu = (s: number): string[] => {
    const tcs = events.filter((e: any) => e.type === 'TURN_CHANGE' && e.seat === s);
    return tcs.length ? ((tcs[tcs.length - 1] as any).availableActions as string[]) : [];
  };
  return { hc, events, st, cur, actSeat, menu };
}

describe('REOPENING RULE - sub-full-raise all-in does not reopen betting', () => {
  // Seats: 1=Dealer, 2=SB, 3=BB, 4=UTG. Preflop order: 4, 1, 2, 3.
  // Seat 2 has a short stack so its all-in is a partial (non-reopening) raise.
  function setup() {
    const h = harness(mkConfig(), mkPlayers([200, 8, 200, 200]), 1);
    h.hc.start();
    // Preflop: SB=2 posts 1, BB=3 posts 2, UTG=4 first to act.
    expect(h.cur()).toBe(4);
    expect(h.actSeat(4, 'raise', 6)).toBe(true); // UTG full raise to 6 (lastRaise=4)
    expect(h.actSeat(1, 'call', 6)).toBe(true); // Dealer calls 6
    // SB (seat 2) all-in: 1 posted + 7 stack = 8 total. Increment 2 < lastRaise 4
    // → SHORT all-in, does not reopen.
    expect(h.actSeat(2, 'all_in')).toBe(true);
    expect(h.st().currentBet).toBe(8);
    return h;
  }

  it('an unacted player (BB) facing the short all-in MAY still raise', () => {
    const h = setup();
    expect(h.cur()).toBe(3); // BB to act, has not voluntarily acted yet
    expect(h.menu(3)).toContain('raise');
    // BB legitimately re-raises to 16 (facing the action for the first time)
    expect(h.actSeat(3, 'raise', 16)).toBe(true);
  });

  it('the original full-raiser (UTG), already acted, may NOT re-raise over the short all-in', () => {
    const h = setup();
    expect(h.actSeat(3, 'call', 8)).toBe(true); // BB just calls the 8
    // Action returns to UTG (bet 6 < 8). UTG already raised; only a short all-in
    // has happened since → UTG may call or fold, NOT re-raise.
    expect(h.cur()).toBe(4);
    expect(h.menu(4)).not.toContain('raise');
    expect(h.actSeat(4, 'raise', 20)).toBe(false); // server rejects the illegal raise
    expect(h.actSeat(4, 'call', 8)).toBe(true); // call is legal
  });

  it('a prior caller (Dealer), already acted, may NOT re-raise over the short all-in', () => {
    const h = setup();
    expect(h.actSeat(3, 'call', 8)).toBe(true); // BB calls
    expect(h.actSeat(4, 'call', 8)).toBe(true); // UTG calls
    // Dealer had called 6; faces the short all-in to 8. Already acted, no full
    // raise since → call/fold only.
    expect(h.cur()).toBe(1);
    expect(h.menu(1)).not.toContain('raise');
    expect(h.hc.getAuthoritativeActionState('u1')).toMatchObject({
      schemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: 1,
      canAct: true,
      legalActions: ['fold', 'call'],
      toCall: 2,
      minRaiseTo: null,
      maxRaiseTo: null,
      structure: 'no_limit',
      wagersCapped: false,
    });
    expect(h.actSeat(1, 'raise', 20)).toBe(false);
    expect(h.menu(1)).not.toContain('all_in');
    expect(h.actSeat(1, 'all_in')).toBe(false); // a shove is still a raise
    expect(h.actSeat(1, 'call', 8)).toBe(true);
  });
});

describe('authoritative action bounds', () => {
  it('represents a stack below the minimum only as all-in, never min greater than max', () => {
    const h = harness(mkConfig(), mkPlayers([1, 200]), 1);
    h.st().currentPlayerSeat = 1;
    h.st().currentBet = 0;
    h.st().minRaise = 2;
    const actionState = h.hc.getAuthoritativeActionState('u1');
    expect(actionState?.legalActions).toEqual(['fold', 'check', 'all_in']);
    expect(actionState?.minRaiseTo).toBeNull();
    expect(actionState?.maxRaiseTo).toBeNull();
  });
});

describe('REOPENING RULE - a FULL raise still reopens betting normally', () => {
  it('a player facing a full re-raise may re-raise again', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200, 200]), 1);
    h.hc.start();
    expect(h.actSeat(4, 'raise', 6)).toBe(true); // UTG raise to 6 (lastRaise 4)
    expect(h.actSeat(1, 'raise', 12)).toBe(true); // Dealer full re-raise to 12 (lastRaise 6)
    expect(h.actSeat(2, 'fold')).toBe(true); // SB folds
    expect(h.actSeat(3, 'fold')).toBe(true); // BB folds
    // Back to UTG, now facing a FULL raise made after its action → may re-raise.
    expect(h.cur()).toBe(4);
    expect(h.menu(4)).toContain('raise');
    expect(h.actSeat(4, 'raise', 24)).toBe(true);
  });

  it('preflop BB with the option may raise when everyone limps', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200, 200]), 1);
    h.hc.start();
    expect(h.actSeat(4, 'call', 2)).toBe(true); // UTG limps
    expect(h.actSeat(1, 'call', 2)).toBe(true); // Dealer limps
    expect(h.actSeat(2, 'call', 2)).toBe(true); // SB completes
    // BB has the option — has not voluntarily acted → may raise.
    expect(h.cur()).toBe(3);
    expect(h.menu(3)).toContain('raise');
    expect(h.actSeat(3, 'raise', 8)).toBe(true);
  });
});

describe('reopening follows the wager faced by this player', () => {
  it('cumulative short all-ins reopen after a full increment without changing that increment', () => {
    const h = harness(mkConfig(), mkPlayers([200, 8, 10, 200, 200]), 1);
    h.hc.start();
    expect(h.actSeat(4, 'raise', 6)).toBe(true);
    expect(h.actSeat(5, 'call', 6)).toBe(true);
    expect(h.actSeat(1, 'call', 6)).toBe(true);
    expect(h.actSeat(2, 'all_in')).toBe(true);
    expect(h.actSeat(3, 'all_in')).toBe(true);
    expect(h.cur()).toBe(4);
    expect(h.st().lastRaise).toBe(4);
    expect(h.menu(4)).toContain('raise');
    expect(h.actSeat(4, 'raise', 14)).toBe(true);
  });
  it('an intervening caller does not inherit another player cumulative reopening', () => {
    const h = harness(mkConfig(), mkPlayers([10, 200, 200, 200, 8, 200]), 1);
    h.hc.start();
    expect(h.actSeat(4, 'raise', 6)).toBe(true);
    expect(h.actSeat(5, 'all_in')).toBe(true);
    expect(h.actSeat(6, 'call', 8)).toBe(true);
    expect(h.actSeat(1, 'all_in')).toBe(true);
    expect(h.actSeat(2, 'fold')).toBe(true);
    expect(h.actSeat(3, 'fold')).toBe(true);
    expect(h.actSeat(4, 'call', 10)).toBe(true);
    expect(h.cur()).toBe(6);
    expect(h.menu(6)).not.toContain('raise');
    expect(h.menu(6)).not.toContain('all_in');
    expect(h.actSeat(6, 'all_in')).toBe(false);
    expect(h.actSeat(6, 'call', 10)).toBe(true);
  });
  it('a short all-in expressed as raise does not become a full raise', () => {
    const h = harness(mkConfig(), mkPlayers([200, 8, 200, 200]), 1);
    h.hc.start();
    expect(h.actSeat(4, 'raise', 6)).toBe(true);
    expect(h.actSeat(1, 'call', 6)).toBe(true);
    expect(h.actSeat(2, 'raise', 8)).toBe(true);
    expect(h.st().actionHistory.at(-1).isFullRaise).toBe(false);
    expect(h.actSeat(3, 'call', 8)).toBe(true);
    expect(h.menu(4)).not.toContain('raise');
    expect(h.actSeat(4, 'raise', 20)).toBe(false);
  });
});

describe.each(['nlh', 'plo4'])('closed %s betting and short stacks', (variant) => {
  it.each([8, 9])(
    'only permits an all-in that does not raise the standing bet (stack %s)',
    (stack) => {
      const h = harness(
        mkConfig({ gameVariant: variant as HandConfig['gameVariant'] }),
        mkPlayers([stack, 8, 200, 200]),
        1
      );
      h.hc.start();
      expect(h.actSeat(4, 'raise', 6)).toBe(true);
      expect(h.actSeat(1, 'call', 6)).toBe(true);
      expect(h.actSeat(2, 'all_in')).toBe(true);
      expect(h.actSeat(3, 'call', 8)).toBe(true);
      expect(h.actSeat(4, 'call', 8)).toBe(true);
      expect(h.cur()).toBe(1);
      if (stack === 8) {
        expect(h.menu(1)).toContain('all_in');
        expect(h.actSeat(1, 'all_in')).toBe(true);
      } else {
        expect(h.menu(1)).not.toContain('all_in');
        const pot = h.st().pot;
        expect(h.actSeat(1, 'all_in')).toBe(false);
        expect(h.st().pot).toBe(pot);
        expect(h.actSeat(1, 'call', 8)).toBe(true);
      }
    }
  );
});

describe('fixed-limit reopening uses half the street bet', () => {
  for (const gameVariant of ['flh', 'flo8'] as const) {
    for (const [shortTotal, reopens] of [
      [2.99, false],
      [3, true],
      [3.01, true],
    ] as const) {
      it(`${gameVariant}: a prior caller facing ${shortTotal - 2} more has reopen=${reopens}`, () => {
        const h = harness(mkConfig({ gameVariant }), mkPlayers([200, shortTotal, 200, 200]), 1);
        h.hc.start();
        expect(h.actSeat(4, 'call')).toBe(true);
        expect(h.actSeat(1, 'call')).toBe(true);
        expect(h.actSeat(2, 'all_in')).toBe(true);
        expect(h.menu(3)).toContain('raise');
        expect(h.actSeat(3, 'call')).toBe(true);
        expect(h.cur()).toBe(4);
        expect(h.menu(4).includes('raise')).toBe(reopens);
        expect(h.actSeat(4, 'raise', shortTotal + 2)).toBe(reopens);
        if (!reopens) expect(h.actSeat(4, 'call')).toBe(true);
      });
    }
  }
});

describe('fixed-limit reopening tracks street size and individual action', () => {
  for (const gameVariant of ['flh', 'flo8'] as const) {
    for (const [total, reopens] of [
      [5.99, false],
      [6, true],
      [6.01, true],
    ] as const) {
      it(`${gameVariant}: turn all-in to ${total} uses half the big bet`, () => {
        const h = harness(mkConfig({ gameVariant }), mkPlayers([200, 200, 2 + total, 200]), 1);
        h.hc.start();
        for (const seat of [4, 1, 2]) expect(h.actSeat(seat, 'call')).toBe(true);
        expect(h.actSeat(3, 'check')).toBe(true);
        expect(h.st().stage).toBe('flop');
        for (const seat of [2, 3, 4, 1]) expect(h.actSeat(seat, 'check')).toBe(true);
        expect(h.st().stage).toBe('turn');
        expect(h.actSeat(2, 'bet', 4)).toBe(true);
        expect(h.actSeat(3, 'all_in')).toBe(true);
        expect(h.actSeat(4, 'call')).toBe(true);
        expect(h.actSeat(1, 'call')).toBe(true);
        expect(h.cur()).toBe(2);
        expect(h.menu(2).includes('raise')).toBe(reopens);
        expect(h.actSeat(2, 'raise', total + 4)).toBe(reopens);
        if (!reopens) expect(h.actSeat(2, 'call')).toBe(true);
      });
    }
    it(`${gameVariant}: intervening callers do not inherit earlier reopening rights`, () => {
      const h = harness(mkConfig({ gameVariant }), mkPlayers([200, 3, 200, 200, 2.5]), 1);
      h.hc.start();
      expect(h.actSeat(4, 'call')).toBe(true);
      expect(h.actSeat(5, 'all_in')).toBe(true);
      expect(h.actSeat(1, 'call')).toBe(true);
      expect(h.actSeat(2, 'all_in')).toBe(true);
      expect(h.actSeat(3, 'call')).toBe(true);
      expect(h.menu(4)).toContain('raise');
      expect(h.actSeat(4, 'call')).toBe(true);
      expect(h.cur()).toBe(1);
      expect(h.menu(1)).not.toContain('raise');
      expect(h.actSeat(1, 'raise', 5)).toBe(false);
      expect(h.actSeat(1, 'call')).toBe(true);
    });
  }
});
