import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { GameState, HandEvent, SeatPlayer } from '../types.js';
import {
  OMAHA_RULES,
  referenceDeck,
  settleOmahaReference,
  type OmahaVariant,
} from '../benchmark/OmahaReference.js';

describe('Phase 9 whole-controller independent settlement', () => {
  for (const variant of Object.keys(OMAHA_RULES) as OmahaVariant[])
    for (const unit of [1, 0.01] as const)
      it(`${variant} resolves independent pots, folds, short all-ins, uncalled refunds and ${unit} chip units`, () => {
        for (let trial = 0; trial < 32; trial++) {
          let seed = 900901 + trial * 37;
          const deck = referenceDeck();
          for (let i = 51; i > 0; i--) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            const j = (seed >>> 0) % (i + 1);
            [deck[i], deck[j]] = [deck[j], deck[i]];
          }
          const events: HandEvent[] = [];
          const players: SeatPlayer[] = [31, 72, 104, 72].map((n, i) => ({
            user_id: `p${i}`,
            username: `p${i}`,
            seat: i + 1,
            stack: 0,
            cards: [],
            totalInvested: (n + trial) * unit,
            bet: (n + trial) * unit,
            is_folded: (i === 0 && trial % 3 === 0) || (i === 3 && trial % 5 === 0),
            is_all_in: true,
            is_sitting_out: false,
          }));
          const controller = new HandController(
            {
              tableId: 'phase9-independent-controller',
              handNumber: 1,
              gameVariant: variant,
              smallBlind: unit,
              bigBlind: 2 * unit,
              isTournament: unit === 1,
              rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
            },
            players,
            (trial % 4) + 1
          );
          controller.onEvent((e) => events.push(e));
          const internal = controller as unknown as {
            state: GameState;
            handFSM: { transition(stage: string): void };
            completeHandInner(): void;
          };
          internal.state.players = players;
          for (const p of players) p.cards = deck.splice(0, OMAHA_RULES[variant].holes);
          internal.state.communityCards = deck.splice(0, 5);
          internal.state.stage = 'river';
          for (const stage of [
            'posting_blinds',
            'dealing',
            'preflop',
            'flop',
            'turn',
            'river',
            'showdown',
          ])
            internal.handFSM.transition(stage);
          internal.state.pot = players.reduce((sum, p) => sum + p.totalInvested, 0);
          const initial = players.map((p) => ({
            id: p.user_id,
            seat: p.seat,
            cards: p.cards,
            contributed: p.totalInvested,
            folded: p.is_folded,
          }));
          const expected = settleOmahaReference({
            variant,
            players: initial,
            boards: [internal.state.communityCards],
            chipUnit: unit,
            dealerSeat: (trial % 4) + 1,
          });
          internal.completeHandInner();
          const winnerEvent = events.find((e) => e.type === 'WINNERS') as Extract<
            HandEvent,
            { type: 'WINNERS' }
          >;
          expect(winnerEvent).toBeDefined();
          for (const p of players) {
            expect(p.stack).toBeCloseTo(
              expected.totals[p.user_id] + (expected.refunds[p.user_id] ?? 0),
              8
            );
            expect(p.returnedUncalled ?? 0).toBeCloseTo(expected.refunds[p.user_id] ?? 0, 8);
          }
          expect(players.reduce((sum, p) => sum + p.stack, 0)).toBeCloseTo(expected.contributed, 8);
          expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toHaveLength(1);
        }
      });
});
