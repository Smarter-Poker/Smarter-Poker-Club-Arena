import { describe, it, expect } from 'vitest';
import { HandController, scaleMultiBoardWinnerUnits } from './HandController.js';
import type { Card, HandEvent, SeatPlayer, GameState } from '../types.js';
import {
  OMAHA_RULES,
  referenceDeck,
  settleOmahaReference,
  type OmahaVariant,
} from '../benchmark/OmahaReference.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';

describe('Phase 9 multiboard Omaha awards keep the configured chip unit', () => {
  for (const boardCount of [2, 3] as const) {
    for (const gameVariant of ['plo4', 'plo5', 'plo6', 'plo8', 'flo8'] as OmahaVariant[]) {
      for (const currency of ['tournament', 'diamonds', 'cash'] as const) {
        const chipUnit = currency === 'cash' ? 0.01 : 1;
        it(`${gameVariant}: ${boardCount} ${currency} boards agree with independent chip allocation`, () => {
          const events: HandEvent[] = [];
          const players: SeatPlayer[] = [1, 2, 3].map((seat) => ({
            seat,
            user_id: 'p' + seat,
            username: 'P' + seat,
            stack: 100,
            bet: 0,
            totalInvested: 0,
            cards: [],
            is_folded: false,
            is_all_in: false,
            is_sitting_out: false,
          }));
          const createController = () =>
            new HandController(
              {
                tableId: 'phase9-units',
                handNumber: 1,
                gameVariant,
                smallBlind: 1,
                bigBlind: 1,
                isTournament: currency === 'tournament',
                asset: currency === 'diamonds' ? 'diamonds' : 'chips',
                bombPot: { anteMultiplier: 1, boardCount },
                rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
              },
              players,
              1
            );
          /* THE DIAMOND ARM USED TO RETURN HERE (2026-09-12). It asserted the
             refusal instead of the arithmetic, because Diamond cash admitted
             plain NLH only, and the note said "the settlement repair does not
             enable Omaha" - which was true of that repair and is no longer
             true of this arena. Now that the nine chip variants are admitted,
             this case runs for all five Omaha variants over two and three boards, checked
             against an INDEPENDENT reference allocator rather than against the
             engine's own opinion of itself. plo8 and flo8 are the hi-lo games,
             so the split this line newly reaches is covered here twice over. */
          const controller = createController();
          controller.onEvent((event) => events.push(event));
          controller.start();
          const state = (controller as unknown as { state: GameState }).state;
          // The production deal is replaced only in this isolated fixture.
          // A legal unique fixed deck makes high/low and ties reproducible.
          const deck = referenceDeck();
          const take = (n: number): Card[] => deck.splice(0, n);
          state.players.forEach((p) => {
            expect(p.cards).toHaveLength(OMAHA_RULES[gameVariant].holes);
            p.cards = take(OMAHA_RULES[gameVariant].holes);
          });
          const boards = Array.from({ length: boardCount }, () => take(5));
          while (state.stage !== 'river') {
            expect(controller.performAction(state.currentPlayerSeat, 'check')).toBe(true);
          }
          state.communityCards = boards[0];
          state.communityCards2 = boards[1];
          if (boardCount === 3) state.communityCards3 = boards[2];
          // A three-chip main pot split over two boards exposes half-chip
          // awards. Add a legal five-chip contribution profile for three boards
          // through a fresh settled snapshot below, keeping the real controller.
          if (boardCount === 3) {
            state.players[0].totalInvested = 2;
            state.players[0].stack--;
            state.players[1].totalInvested = 2;
            state.players[1].stack--;
            state.pot = 5;
          }
          const snapshot = state.players.map((p) => ({
            id: p.user_id,
            seat: p.seat,
            cards: p.cards,
            contributed: p.totalInvested,
            folded: p.is_folded,
          }));
          const expected = settleOmahaReference({
            variant: gameVariant,
            players: snapshot,
            boards,
            chipUnit,
            dealerSeat: 1,
          });
          let remaining = 10;
          while (controller.getState().stage !== 'showdown' && remaining-- > 0)
            expect(controller.performAction(state.currentPlayerSeat, 'check')).toBe(true);
          const win = events.find((e) => e.type === 'WINNERS') as Extract<
            HandEvent,
            { type: 'WINNERS' }
          >;
          expect(win).toBeDefined();
          expect(
            win.perPotAwards?.every(
              (a) => Math.abs(a.amount / chipUnit - Math.round(a.amount / chipUnit)) < 1e-6
            )
          ).toBe(true);
          const totals = Object.fromEntries(snapshot.map((p) => [p.id, 0]));
          win.winners.forEach((w) => {
            totals[w.userId] += w.amount;
          });
          for (const id of Object.keys(totals))
            expect(totals[id]).toBeCloseTo(expected.totals[id], 8);
          expect(state.players.reduce((s, p) => s + p.stack, 0)).toBe(300);
          expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toHaveLength(1);
        });
      }
    }
  }
});

describe('Phase 9 full cash table multi-board independent payouts', () => {
  for (const gameVariant of ['plo5', 'plo6'] as const)
    for (const boardCount of [2, 3] as const)
      for (const chipUnit of [0.01, 1] as const)
        it(`${gameVariant} ${maxSeatsForVariant(gameVariant)} seats, ${boardCount} boards, unit ${chipUnit}: folds, short all-in, side pots and refund`, () => {
          const seats = maxSeatsForVariant(gameVariant);
          const initialStacks = Array.from(
            { length: seats },
            (_, i) => (i === 0 ? 3 : 100) * chipUnit
          );
          const players: SeatPlayer[] = initialStacks.map((stack, i) => ({
            user_id: `p${i + 1}`,
            username: `P${i + 1}`,
            seat: i + 1,
            stack,
            cards: [],
            bet: 0,
            totalInvested: 0,
            is_folded: false,
            is_all_in: false,
            is_sitting_out: false,
          }));
          const events: HandEvent[] = [];
          const controller = new HandController(
            {
              tableId: 'phase9-full-cash-payout',
              handNumber: 1,
              gameVariant,
              smallBlind: chipUnit,
              bigBlind: chipUnit,
              asset: chipUnit === 1 ? 'diamonds' : 'chips',
              bombPot: { anteMultiplier: 1, boardCount },
              rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
            },
            players,
            1
          );
          controller.onEvent((event) => events.push(event));
          controller.start();
          const state = (controller as unknown as { state: GameState }).state;
          let steps = seats * 3;
          while (state.stage !== 'river' && steps-- > 0)
            expect(controller.performAction(state.currentPlayerSeat, 'check')).toBe(true);
          expect(state.stage).toBe('river');
          // Inject a balanced settled-state fixture, not an alleged legal betting
          // history. The real controller still executes the final actions,
          // refunds, pot construction, multi-board allocation and completion.
          const deck = referenceDeck();
          const contributedUnits = [3, 5, 8, 5, 8, 11, 8].slice(0, seats);
          state.players.forEach((p, i) => {
            expect(p.cards).toHaveLength(OMAHA_RULES[gameVariant].holes);
            p.cards = deck.splice(0, OMAHA_RULES[gameVariant].holes);
            p.totalInvested = contributedUnits[i] * chipUnit;
            p.stack = Math.round((initialStacks[i] - p.totalInvested) * 100) / 100;
            p.bet = 0;
            p.is_all_in = i === 0;
            p.is_folded = i === 2;
          });
          const boards = Array.from({ length: boardCount }, () => deck.splice(0, 5));
          state.communityCards = boards[0];
          state.communityCards2 = boards[1];
          if (boardCount === 3) state.communityCards3 = boards[2];
          state.pot =
            Math.round(contributedUnits.reduce((sum, n) => sum + n, 0) * chipUnit * 100) / 100;
          state.currentBet = 0;
          const beforePayout = state.players.map((p) => p.stack);
          const expected = settleOmahaReference({
            variant: gameVariant,
            players: state.players.map((p) => ({
              id: p.user_id,
              seat: p.seat,
              cards: p.cards.map((c) => ({ ...c })),
              contributed: p.totalInvested,
              folded: p.is_folded,
            })),
            boards,
            chipUnit,
            dealerSeat: 1,
          });
          expect(expected.refunds.p6).toBeCloseTo(3 * chipUnit, 8);
          expect(expected.pots).toHaveLength(3);
          expect(expected.totals.p3).toBe(0);
          steps = seats * 2;
          while (controller.getState().stage !== 'showdown' && steps-- > 0)
            expect(controller.performAction(state.currentPlayerSeat, 'check')).toBe(true);
          expect(state.stage).toBe('showdown');
          const win = events.find((event) => event.type === 'WINNERS') as Extract<
            HandEvent,
            { type: 'WINNERS' }
          >;
          expect(win).toBeDefined();
          const actual = Object.fromEntries(players.map((p) => [p.user_id, 0]));
          for (const award of win.winners) actual[award.userId] += award.amount;
          state.players.forEach((p, i) => {
            expect(actual[p.user_id]).toBeCloseTo(expected.totals[p.user_id], 8);
            expect(p.stack).toBeCloseTo(
              beforePayout[i] + expected.totals[p.user_id] + (expected.refunds[p.user_id] ?? 0),
              8
            );
            expect(p.returnedUncalled ?? 0).toBeCloseTo(expected.refunds[p.user_id] ?? 0, 8);
            expect(p.stack / chipUnit).toBeCloseTo(Math.round(p.stack / chipUnit), 8);
          });
          expect(state.players.reduce((sum, p) => sum + p.stack, 0)).toBeCloseTo(
            initialStacks.reduce((sum, n) => sum + n, 0),
            8
          );
          expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toHaveLength(1);
        });
});

/**
 * NATURAL-EVIDENCE F2 (2026-10-03): THE ODD CENT OF A RAKED MULTI-BOARD POT.
 *
 * Hand 177246036add, a two-board bomb pot: gross 18.00, rake 1.80, BBJ drop
 * 0.50, net 15.70. One player won board 1 outright; two players split board 2.
 * The exact net shares are 9/18, 4.5/18 and 4.5/18 of 15.70: 7.85, 3.925 and
 * 3.925. Production paid 7.84 / 3.93 / 3.93 - both split halves rounded up and
 * the overshoot was pulled from the board-1 winner, who is first in the merged
 * winner list. 91 two-board bombs carried a player exactly a cent off.
 *
 * Correct: the sole board winner gets exactly 7.85, and the one indivisible
 * cent between the two 3.925 shares goes by the engine's odd-chip rule - the
 * first winner clockwise of the button (distributePot, Bible V8 2.7). With the
 * button on seat 1 that is seat 2. Expected values are this arithmetic.
 */
describe('Phase 9 raked two-board bomb: each player within a cent, odd cent by seat order', () => {
  const suitOf = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
  const cards = (list: string[]): Card[] =>
    list.map((c) => ({ rank: c[0], suit: suitOf[c[1] as keyof typeof suitOf] }) as Card);

  it('hand 177246036add: 15.70 net pays 7.85 to the board-1 winner and 3.93 / 3.92 to the board-2 split', () => {
    const events: HandEvent[] = [];
    const players: SeatPlayer[] = [1, 2, 3].map((seat) => ({
      seat,
      user_id: 'p' + seat,
      username: 'P' + seat,
      stack: 100,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    }));
    const controller = new HandController(
      {
        tableId: 'phase9-f2-odd-cent',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 0.5,
        bigBlind: 1,
        bombPot: { anteMultiplier: 6, boardCount: 2 },
        rakeConfig: { percent: 10, cap: 5, noFlopNoDrop: true },
        bbjConfig: { enabled: true, feeBB: 0.5, minPotBB: 0, minPlayersDealt: 3 },
      },
      players,
      1
    );
    controller.onEvent((event) => events.push(event));
    controller.start();
    const state = (controller as unknown as { state: GameState }).state;
    expect(state.pot).toBe(18);
    let steps = 12;
    while (state.stage !== 'river' && steps-- > 0)
      expect(controller.performAction(state.currentPlayerSeat, 'check')).toBe(true);
    expect(state.stage).toBe('river');
    // Seat 1 (button) and seat 2 hold the same T-6; seat 3 holds aces.
    state.players.find((p) => p.seat === 1)!.cards = cards(['Ts', '6c']);
    state.players.find((p) => p.seat === 2)!.cards = cards(['Td', '6h']);
    state.players.find((p) => p.seat === 3)!.cards = cards(['As', 'Ad']);
    // Board 1: seat 3's trip aces win alone. Board 2: both T-6 make the same
    // ten-high straight and split; aces-up loses.
    state.communityCards = cards(['Ah', 'Kd', 'Qc', '4s', '3h']);
    state.communityCards2 = cards(['9s', '8d', '7c', '2h', '2d']);
    steps = 6;
    while (controller.getState().stage !== 'showdown' && steps-- > 0)
      expect(controller.performAction(state.currentPlayerSeat, 'check')).toBe(true);

    const complete = events.find((e) => e.type === 'HAND_COMPLETE') as Extract<
      HandEvent,
      { type: 'HAND_COMPLETE' }
    >;
    expect(complete.rake).toBe(1.8);
    expect(complete.bbjFee).toBe(0.5);
    const win = events.find((e) => e.type === 'WINNERS') as Extract<HandEvent, { type: 'WINNERS' }>;
    const paid = Object.fromEntries(win.winners.map((w) => [w.userId, w.amount]));
    expect(paid).toEqual({ p3: 7.85, p2: 3.93, p1: 3.92 });
    expect(state.players.map((p) => p.stack)).toEqual([97.92, 97.93, 101.85]);
    expect(Math.round(state.players.reduce((s, p) => s + p.stack, 0) * 100)).toBe(29770);
  });
});

/**
 * The allocator against exact rational arithmetic. Each case is a seeded
 * random multi-board hand: 2 or 3 boards, every board share chopped among one
 * to three winners the way distributePot chops it, then a rake + drop taken
 * off the gross. The oracle is the exact share entitlement * net / gross,
 * computed here in integers; nothing is read back from the engine.
 */
describe('Phase 9 multi-board rake scaling against the exact pro-rata share', () => {
  it('known case: 900 / 450 / 450 cents of gross over a 1570 net', () => {
    // Odd-chip ranks: index 1 is first clockwise of the button.
    expect(scaleMultiBoardWinnerUnits([9, 4.5, 4.5], 15.7, 100, [3, 2, 1])).toEqual([
      785, 392, 393,
    ]);
    expect(scaleMultiBoardWinnerUnits([9, 4.5, 4.5], 15.7, 100, [3, 1, 2])).toEqual([
      785, 393, 392,
    ]);
    // No deduction is the identity, whatever the order.
    expect(scaleMultiBoardWinnerUnits([9, 4.5, 4.5], 18, 100, [1, 2, 3])).toEqual([900, 450, 450]);
    // Whole-unit (Diamond) awards stay whole.
    expect(scaleMultiBoardWinnerUnits([9, 5, 4], 16, 1, [1, 2, 3])).toEqual([8, 4, 4]);
  });

  it('500 seeded hands: conservation, within one unit, capped at entitlement, whole shares exact', () => {
    let seed = 20261003;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let c = 0; c < 500; c++) {
      const boards = 2 + rand(2);
      const players = 2 + rand(5);
      const grossCents = 200 + rand(50000);
      const owed = new Array(players).fill(0);
      for (let b = 0; b < boards; b++) {
        const share = Math.floor(grossCents / boards) + (b < grossCents % boards ? 1 : 0);
        const chop = 1 + rand(Math.min(3, players));
        const start = rand(players);
        for (let k = 0; k < chop; k++)
          owed[(start + k) % players] += Math.floor(share / chop) + (k < share % chop ? 1 : 0);
      }
      const deduction = rand(Math.min(500, Math.floor(grossCents / 10)) + 1);
      const net = grossCents - deduction;
      const ranks = Array.from({ length: players }, (_, i) => i + 1);
      const paid = scaleMultiBoardWinnerUnits(
        owed.map((u) => u / 100),
        net / 100,
        100,
        ranks
      );
      expect(paid.reduce((s, u) => s + u, 0)).toBe(net);
      const gross = owed.reduce((s, u) => s + u, 0);
      owed.forEach((u, i) => {
        // |paid - u * net / gross| < 1, multiplied through by gross.
        expect(Math.abs(paid[i] * gross - u * net)).toBeLessThan(gross);
        expect(paid[i]).toBeLessThanOrEqual(u);
        if ((u * net) % gross === 0) expect(paid[i]).toBe((u * net) / gross);
      });
    }
  });
});
