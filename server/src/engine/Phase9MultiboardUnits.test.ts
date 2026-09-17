import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
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
