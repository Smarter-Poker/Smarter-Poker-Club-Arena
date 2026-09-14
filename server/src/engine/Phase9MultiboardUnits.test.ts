import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { Card, HandEvent, SeatPlayer, GameState } from '../types.js';
import {
  referenceDeck,
  settleOmahaReference,
  type OmahaVariant,
} from '../benchmark/OmahaReference.js';

describe('Phase 9 multiboard Omaha awards keep the configured chip unit', () => {
  for (const boardCount of [2, 3] as const) {
    for (const gameVariant of ['plo4', 'plo8', 'flo8'] as OmahaVariant[]) {
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
             this case runs, and it is the strongest per-variant evidence there
             is: plo4, plo8 and flo8, over two and three boards, checked
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
            p.cards = take(4);
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
