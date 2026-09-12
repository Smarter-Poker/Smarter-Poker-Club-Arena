import { describe, expect, it } from 'vitest';
import type { SeatPlayer } from '../types.js';
import { remainingReferenceDeck, settleRemainingReference } from './RemainingVariantReference.js';
import { HandController } from '../engine/HandController.js';
import { calculatePots, determineWinners } from '../engine/PokerEngine.js';
import { remainingVariantReferenceSpots } from './RemainingVariantReferenceSpots.js';

describe('independent remaining-variant refunds, pot layers and settlement', () => {
  it('contrasts value, protected ties, known-discard losses and low-only quarters in the real policy', () => {
    const spots = remainingVariantReferenceSpots();
    expect(spots).toHaveLength(8);
    expect(
      spots.find((s) => s.name === 'pineapple-known-discard-cannot-make-quads')?.policy.proposal
        .action
    ).toBe('fold');
    expect(spots.find((s) => s.name === 'flo8-quartered-low')?.policy.proposal.action).toBe('call');
    expect(spots.find((s) => s.name === 'flh-board-royal-tie')?.policy.proposal.action).toBe(
      'call'
    );
    expect(
      spots.find((s) => s.name === 'short-deck-flush-beats-full-house')?.policy.proposal.action
    ).toBe('raise');
  });
  it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
    '%s matches independently constructed layers, card rules and awards',
    (variant) => {
      for (const chipUnit of [0.01, 1] as const)
        for (let trial = 0; trial < 48; trial++) {
          const deck = remainingReferenceDeck(variant === 'short_deck');
          let seed = (12101201 + trial * 193) >>> 0;
          for (let i = deck.length - 1; i > 0; i--) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const j = seed % (i + 1);
            [deck[i], deck[j]] = [deck[j], deck[i]];
          }
          const count = 2 + (trial % 7),
            holes = variant === 'flo8' ? 4 : 2;
          const players = Array.from({ length: count }, (_, i) => ({
            id: `p${i}`,
            seat: i + 1,
            cards: deck.splice(0, holes),
            contributed:
              (i === 0 ? 101 : i === 1 ? 233 : i === 2 ? 201 : 31 + 30 * (i % 4)) * chipUnit,
            folded: i > 1 && i % 3 === 0,
          }));
          const board = deck.splice(0, 5),
            dealerSeat = (trial % count) + 1;
          const ref = settleRemainingReference({ variant, players, board, chipUnit, dealerSeat });
          const seats: SeatPlayer[] = players.map((p) => ({
            seat: p.seat,
            user_id: p.id,
            username: p.id,
            cards: p.cards,
            is_folded: p.folded,
            stack: 0,
            bet: p.contributed,
            totalInvested: p.contributed,
            is_all_in: true,
            is_sitting_out: false,
          }));
          const controller = new HandController(
            {
              tableId: 'phase12-independent-settlement',
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
          const internal = controller as unknown as {
            state: { players: SeatPlayer[]; pot: number };
            returnUncalledBet(): number;
          };
          internal.state.players = seats;
          internal.state.pot = players.reduce((n, p) => n + p.contributed, 0);
          internal.returnUncalledBet();
          const refunds = Object.fromEntries(
            seats.filter((p) => p.stack > 0).map((p) => [p.user_id, p.stack])
          );
          for (const p of players)
            expect(refunds[p.id] ?? 0).toBeCloseTo(ref.refunds[p.id] ?? 0, 8);
          const pots = calculatePots(seats);
          expect(
            pots.map((p) => ({
              amount: Math.round(p.amount / chipUnit),
              eligible: [...p.eligiblePlayers].sort(),
            }))
          ).toEqual(
            ref.pots.map((p) => ({
              amount: Math.round(p.amount / chipUnit),
              eligible: [...p.eligible].sort(),
            }))
          );
          const actual = Object.fromEntries(players.map((p) => [p.id, 0]));
          determineWinners(
            seats,
            board,
            pots,
            variant,
            dealerSeat,
            undefined,
            undefined,
            chipUnit
          ).forEach((w) => (actual[w.userId] += w.amount));
          for (const p of players)
            expect(
              actual[p.id],
              JSON.stringify({ variant, trial, chipUnit, players, board })
            ).toBeCloseTo(ref.totals[p.id], 8);
          expect(ref.distributed).toBeCloseTo(ref.contributed, 8);
        }
    }
  );
});
