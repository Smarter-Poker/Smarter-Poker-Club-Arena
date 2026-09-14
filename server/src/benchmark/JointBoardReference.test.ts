import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { settleJointBoardReference, type JointReferenceVariant } from './JointBoardReference.js';
import { remainingReferenceDeck } from './RemainingVariantReference.js';
import { createHandStateMachine } from '../engine/StateMachine.js';
import { HandController } from '../engine/HandController.js';
import type { SeatPlayer, GameState, HandEvent } from '../types.js';

describe('independent all-variant multiboard settlement', () => {
  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
    'flh',
    'pineapple',
    'short_deck',
  ] as JointReferenceVariant[])(
    '%s compares complete real-controller board/pot awards, refunds and chip units',
    (variant) => {
      for (const chipUnit of [0.01, 1] as const)
        for (const boardCount of [2, 3] as const)
          for (let trial = 0; trial < 9; trial++) {
            let stream = 13100901 + trial * 239 + boardCount;
            const deck = remainingReferenceDeck(variant === 'short_deck');
            for (let i = deck.length - 1; i > 0; i--) {
              stream = (Math.imul(stream, 1664525) + 1013904223) >>> 0;
              const j = stream % (i + 1);
              [deck[i], deck[j]] = [deck[j], deck[i]];
            }
            const holes =
              variant === 'plo6'
                ? 6
                : variant === 'plo5'
                  ? 5
                  : ['plo4', 'plo8', 'flo8'].includes(variant)
                    ? 4
                    : 2;
            const originalHoles = variant === 'pineapple' ? 3 : holes;
            const maximum = Math.min(
              10,
              Math.floor((deck.length - boardCount * 5) / originalHoles)
            );
            const count = 2 + (trial % (maximum - 1));
            const knownDeadCards: Card[] = [];
            const refs = Array.from({ length: count }, (_, i) => {
              const cards = deck.splice(0, holes);
              if (variant === 'pineapple') knownDeadCards.push(...deck.splice(0, 1));
              return {
                id: 'p' + i,
                seat: i + 1,
                cards,
                contributed:
                  (i === 0 ? 101 : i === 1 ? 233 : i === 2 ? 201 : 31 + 30 * (i % 4)) * chipUnit,
                folded: i > 1 && i % 3 === 0,
              };
            });
            const boards = Array.from({ length: boardCount }, () => deck.splice(0, 5));
            const dealerSeat = (trial % count) + 1;
            const expected = settleJointBoardReference({
              variant,
              players: refs,
              boards,
              knownDeadCards,
              chipUnit,
              dealerSeat,
            });
            const seats: SeatPlayer[] = refs.map((p) => ({
              user_id: p.id,
              username: p.id,
              seat: p.seat,
              cards: p.cards,
              stack: 500 - p.contributed,
              bet: p.contributed,
              totalInvested: p.contributed,
              is_folded: p.folded,
              is_all_in: false,
              is_sitting_out: false,
            }));
            const hc = new HandController(
              {
                tableId: 'phase13-reference',
                handNumber: 1,
                gameVariant: variant,
                smallBlind: chipUnit,
                bigBlind: 2 * chipUnit,
                isTournament: chipUnit === 1,
                rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
              },
              seats,
              dealerSeat
            );
            const internal = hc as unknown as {
              state: GameState;
              activeBoardCount: number;
              handFSM: ReturnType<typeof createHandStateMachine>;
              completeHandInner(): void;
            };
            // This is a terminal settlement fixture. No simulated betting results
            // or production pot/winner outputs are supplied to the independent oracle.
            internal.state.players = seats;
            internal.state.stage = 'showdown';
            internal.state.sawFlop = true;
            internal.handFSM = createHandStateMachine('showdown');
            internal.state.pot = refs.reduce((n, p) => n + p.contributed, 0);
            internal.state.communityCards = boards[0];
            internal.state.communityCards2 = boards[1];
            internal.state.communityCards3 = boards[2] ?? [];
            internal.activeBoardCount = boardCount;
            const events: HandEvent[] = [];
            hc.onEvent((e) => events.push(e));
            internal.completeHandInner();
            const win = events.find((e) => e.type === 'WINNERS') as Extract<
              HandEvent,
              { type: 'WINNERS' }
            >;
            expect(win).toBeDefined();
            const actual = Object.fromEntries(refs.map((p) => [p.id, 0]));
            win.winners.forEach((w) => (actual[w.userId] += w.amount));
            for (const p of refs) {
              expect(actual[p.id]).toBeCloseTo(expected.totals[p.id], 8);
              expect(seats.find((s) => s.user_id === p.id)!.stack).toBeCloseTo(
                500 - p.contributed + (expected.refunds[p.id] ?? 0) + expected.totals[p.id],
                8
              );
            }
            expect(seats.reduce((n, p) => n + p.stack, 0)).toBeCloseTo(500 * count, 8);
            expect(
              win.perPotAwards?.every(
                (a) => Math.abs(a.amount / chipUnit - Math.round(a.amount / chipUnit)) < 1e-6
              )
            ).toBe(true);
            const actualAwards = win
              .perPotAwards!.filter((a) => a.amount > 0)
              .map((a) => ({
                playerId: a.userId,
                potIndex: a.potIndex,
                boardIndex: a.board! - 1,
                half: a.low ? 'low' : 'high',
                units: Math.round(a.amount / chipUnit),
              }));
            const referenceAwards = expected.awards.map((a) => ({
              playerId: a.playerId,
              potIndex: a.potIndex,
              boardIndex: a.boardIndex,
              half: a.half,
              units: Math.round(a.amount / chipUnit),
            }));
            const order = (a: object, b: object) =>
              JSON.stringify(a).localeCompare(JSON.stringify(b));
            expect(actualAwards.sort(order)).toEqual(referenceAwards.sort(order));
            expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toHaveLength(1);
          }
    }
  );
});
