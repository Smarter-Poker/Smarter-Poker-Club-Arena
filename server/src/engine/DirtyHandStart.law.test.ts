/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HAND THAT IS STARTING MUST BE A BLANK HAND (2026-09-01, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-31 the rake-law alarm filed no_flop_no_drop criticals: live cash
 * hands that ended PREFLOP were charged rake. The board was empty, there was
 * no showdown, and there was nothing to drop on.
 *
 * The cause was not the rake arithmetic. A STALE runout continuation from the
 * PREVIOUS hand had already driven the controller to showdown - sawFlop true,
 * a phantom board dealt into the void - before start() ever ran, and start()
 * did not reset the stage. Live betting then proceeded inside the corpse: no
 * street could deal (advanceStage has no 'showdown' case), big blinds were
 * walked through folds on uncontested pots, and the fold-out settlement
 * priced rake on sawFlop=true.
 *
 * THREE LAYERS now stop that, and only the third was pinned by a test:
 *
 *   1. start() refuses to begin inside a dirty controller. It reports the
 *      corruption loudly and deals a clean preflop hand instead of a broken
 *      one.                                          <- pinned here
 *   2. refuseUnlessRunout makes the runout entry points reject an unstarted
 *      or still-bettable hand, which is the only known way to get dirty.
 *                                                    <- pinned here
 *   3. priceDeductions will not take a drop without a real board, whatever
 *      the flag says.        <- already pinned by RakeBBJCollection.law.test
 *
 * Layer 3 refuses to CHARGE for the corruption. Layers 1 and 2 stop the
 * corruption happening, and a hand played inside a dead controller is a
 * correctness bug well beyond rake - walked big blinds, streets that cannot
 * deal. Those two had nothing holding them in place. This file is that hold.
 *
 * If a pin here goes red you are re-shipping the 2026-08-31 leak. Fix the
 * change, never the pin.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, SeatPlayer } from '../types.js';

const TABLE = 'aaaaaaaa-1111-2222-3333-444444444444';

function mkPlayers(n: number, stack = 1000): SeatPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
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
  })) as SeatPlayer[];
}

function mkController(players = 3): HandController {
  const cfg = {
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 10, minPlayersDealt: 3 },
  } as HandConfig;
  return new HandController(cfg, mkPlayers(players), 1);
}

/** Reach into the pre-start controller the way a stale continuation did. */
function dirty(hc: HandController, over: Record<string, unknown>): void {
  Object.assign((hc as unknown as { state: Record<string, unknown> }).state, over);
}

describe('a hand that is starting must be a blank hand', () => {
  it('resets a controller left at showdown by a stale continuation', () => {
    const hc = mkController();
    dirty(hc, {
      stage: 'showdown',
      sawFlop: true,
      communityCards: [
        { rank: 'A', suit: 's' },
        { rank: 'K', suit: 'd' },
        { rank: '7', suit: 'h' },
      ],
    });

    hc.start();

    const s = hc.getState();
    expect(s.stage).toBe('preflop');
    expect(s.sawFlop).toBe(false);
    expect(s.communityCards).toHaveLength(0);
  });

  it('clears every board copy, not just the first', () => {
    const hc = mkController();
    const card = { rank: 'A', suit: 's' };
    dirty(hc, {
      sawFlop: true,
      communityCards: [card, card, card],
      communityCards2: [card, card, card],
      communityCards3: [card, card, card],
    });

    hc.start();

    const s = hc.getState() as unknown as {
      communityCards: unknown[];
      communityCards2?: unknown[];
      communityCards3?: unknown[];
    };
    expect(s.communityCards).toHaveLength(0);
    expect(s.communityCards2 ?? []).toHaveLength(0);
    expect(s.communityCards3 ?? []).toHaveLength(0);
  });

  it('leaves an already-clean hand completely alone', () => {
    const hc = mkController();

    hc.start();

    const s = hc.getState();
    expect(s.stage).toBe('preflop');
    expect(s.sawFlop).toBe(false);
    expect(s.communityCards).toHaveLength(0);
  });

  it('refuses markFlopSeen on a hand that never started', () => {
    const hc = mkController();

    // markFlopSeen is the RIT path's way of saying "a board exists outside
    // this state". On an unstarted controller it is a stale continuation from
    // the previous hand, and honouring it is what authorised the drop.
    hc.markFlopSeen();

    expect(hc.getState().sawFlop).toBe(false);
  });

  it('still lets markFlopSeen through on a real all-in runout', () => {
    const hc = mkController(2);
    hc.start();
    // Everyone all-in: nobody can still bet, which is exactly the state the
    // RIT runout legitimately arrives in.
    const st = (hc as unknown as { state: { players: SeatPlayer[] } }).state;
    st.players.forEach((p) => {
      p.is_all_in = true;
      p.stack = 0;
    });

    hc.markFlopSeen();

    expect(hc.getState().sawFlop).toBe(true);
  });
});
