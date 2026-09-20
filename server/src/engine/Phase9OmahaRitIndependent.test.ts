/**
 * Actual RIT consent, runout, pot splitting and completion against an independent
 * Omaha reference. The balanced all-in contributions are injected after reaching
 * the standing street; these cases do not prove the prior wagering trajectory,
 * event-to-offer dispatch, persistence or natural Horse use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import {
  OMAHA_RULES,
  settleOmahaReference,
  type OmahaVariant,
} from '../benchmark/OmahaReference.js';
import { reportError } from '../services/errorReporter.js';
import type { Card, GameState, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
}));
const TABLE = '99199919-9919-4919-8919-999191991999';
const variants = ['plo4', 'plo5', 'plo6', 'plo8', 'flo8'] as const;
const engines: Record<string, any>[] = [];
const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
const parse = (text: string): Card[] =>
  text.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: suits[c[1] as keyof typeof suits],
  }));
const key = (c: Card) => c.rank + ':' + c.suit;
const wire = (board: Card[]) => board.map((c) => c.rank + c.suit);
const units = (amount: number, unit: number) => Math.round(amount / unit);
function sorted<T>(rows: T[]): T[] {
  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network is not admitted in this isolated settlement test');
    })
  );
});
afterEach(() => {
  for (const engine of engines.splice(0)) engine.runItTwiceEngine.disposeAll();
  vi.unstubAllGlobals();
});

function fixture(variant: OmahaVariant, prefix: 0 | 3 | 4, runs: 2 | 3) {
  const shared = parse('3c 4d 8h Kc').slice(0, prefix);
  const boards =
    prefix === 0
      ? [parse('3c 4d 8h Kc Qh'), parse('5c 6d 9h Th Jc'), parse('7c Tc Ad 5h 6h')].slice(0, runs)
      : prefix === 3
        ? [parse('Kc Qh'), parse('Th Jc'), parse('Ks Qs')]
            .slice(0, runs)
            .map((suffix) => [...shared, ...suffix])
        : [parse('Qh'), parse('Th'), parse('Jc')]
            .slice(0, runs)
            .map((suffix) => [...shared, ...suffix]);
  const baseHands = ['As 2s Jh Td', 'Kh Kd Qc Qd', 'Ah 2h 9s 9d', 'Ac 2c 7s 7d'].map(parse);
  const physicalBoards =
    prefix === 0 ? boards.flat() : [...shared, ...boards.flatMap((b) => b.slice(prefix))];
  const reserved = [...baseHands.flat(), ...physicalBoards];
  expect(new Set(reserved.map(key)).size).toBe(reserved.length);
  const used = new Set(reserved.map(key));
  const free: Card[] = [];
  for (const suit of Object.values(suits))
    for (const rank of '23456789TJQKA') {
      const c = { rank: rank as Card['rank'], suit };
      if (!used.has(key(c))) free.push(c);
    }
  const hands = baseHands.map((hand) => [
    ...hand,
    ...free.splice(0, OMAHA_RULES[variant].holes - 4),
  ]);
  const remaining = [...boards.flatMap((b) => b.slice(prefix)), ...free];
  const physical = [...hands.flat(), ...shared, ...remaining];
  expect(physical).toHaveLength(52);
  expect(new Set(physical.map(key)).size).toBe(52);
  return { hands, boards, shared, remaining };
}

function engineFor(
  variant: OmahaVariant,
  asset: 'chips' | 'diamonds',
  tableSeats = 4,
  tournament = false
) {
  const engine = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  engines.push(engine);
  engine.running = true;
  engine.handCount = 1;
  engine.tableInfo = {
    game_variant: variant,
    small_blind: 1,
    big_blind: 2,
    max_players: tableSeats,
    tournament_id: tournament ? '99111111-1111-4111-8111-111111111111' : null,
    game_type: tournament ? 'tournament' : 'cash',
    run_it_twice: true,
    allow_run_it_twice: true,
    run_it_twice_enabled: false,
    run_it_mode: 'player_choice',
    insurance_enabled: false,
    arena: { id: 'synthetic-arena', asset, is_platform: true, union_id: null },
  };
  engine.safeContinueRunout = vi.fn();
  engine.killForRestart = vi.fn();
  return engine;
}

for (const variant of variants) {
  describe(variant + ' actual RIT producer versus independent settlement', () => {
    for (const prefix of [0, 3, 4] as const)
      for (const runs of [2, 3] as const)
        for (const asset of ['chips', 'diamonds'] as const)
          it(`${prefix} shared cards, ${runs} runs, ${asset}`, async () => {
            const unit = asset === 'diamonds' ? 1 : 0.01;
            const physical = fixture(variant, prefix, runs);
            const contributions = [13, 29, 47, 29].map((n) => n * unit);
            const players: SeatPlayer[] = contributions.map((stack, i) => ({
              user_id: 'p' + i,
              username: 'P' + i,
              seat: i + 1,
              stack,
              bet: 0,
              totalInvested: 0,
              cards: [],
              is_folded: false,
              is_all_in: false,
              is_sitting_out: false,
            }));
            const handEvents: HandEvent[] = [];
            const controller = new HandController(
              {
                tableId: TABLE,
                handNumber: 1,
                gameVariant: variant,
                smallBlind: unit,
                bigBlind: 2 * unit,
                asset,
                ritEnabled: true,
                rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
              },
              players,
              2
            );
            controller.onEvent((e) => handEvents.push(e));
            controller.start();
            // Advance the actual controller to the standing street with legal
            // calls/checks, then inject the balanced all-in contribution/card
            // fixture. This is NOT proof of that prior wagering trajectory.
            const stage = prefix === 0 ? 'preflop' : prefix === 3 ? 'flop' : 'turn';
            let steps = 20;
            while (controller.getState().stage !== stage && steps-- > 0) {
              const state = controller.getState();
              const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
              expect(
                controller.performAction(
                  actor.seat,
                  actor.bet < state.currentBet ? 'call' : 'check'
                )
              ).toBe(true);
            }
            expect(controller.getState().stage).toBe(stage);
            const state = (controller as unknown as { state: GameState }).state;
            state.players.forEach((p, i) => {
              expect(p.cards).toHaveLength(OMAHA_RULES[variant].holes);
              p.cards = physical.hands[i].map((c) => ({ ...c }));
              p.totalInvested = contributions[i];
              p.bet = contributions[i];
              p.stack = 0;
              p.is_folded = i === 3;
              p.is_all_in = i !== 3;
            });
            state.pot = Math.round(contributions.reduce((s, n) => s + n, 0) * 100) / 100;
            state.currentBet = contributions[2];
            state.communityCards = physical.shared.map((c) => ({ ...c }));
            // Actual Deck/getRemainingDeck APIs remain in the production path;
            // only the isolated deck's private physical ordering is fixed.
            const deck = new Deck();
            (deck as unknown as { cards: Card[] }).cards = physical.remaining.map((c) => ({
              ...c,
            }));
            state.deck = deck as any;
            const input = {
              variant,
              players: state.players.map((p) => ({
                id: p.user_id,
                seat: p.seat,
                cards: p.cards.map((c) => ({ ...c })),
                contributed: p.totalInvested,
                folded: p.is_folded,
              })),
              boards: physical.boards,
              sharedPrefixLength: prefix,
              chipUnit: unit,
              dealerSeat: 2,
            } as const;
            const expected = settleOmahaReference(input);
            expect(expected.refunds.p2).toBeCloseTo(18 * unit, 10);
            expect(expected.pots.map((p) => units(p.amount, unit))).toEqual([52, 48]);
            const engine = engineFor(variant, asset);
            engine.handController = controller;
            engine.tableInfo.small_blind = unit;
            engine.tableInfo.big_blind = 2 * unit;
            engine.seatedPlayers = state.players.map((p) => ({
              user_id: p.user_id,
              seat_number: p.seat,
              stack: p.stack,
              is_horse: true,
            }));
            const emitted: Record<string, any>[] = [];
            engine.hub = {
              emitEvent: (_table: string, event: Record<string, unknown>) =>
                emitted.push(structuredClone(event)),
            };
            expect(engine.applyRunItTwiceConfig()).toEqual({
              ritEffective: true,
              insuranceEnabled: false,
            });
            const ids = state.players.filter((p) => !p.is_folded).map((p) => p.user_id);
            engine.runItTwiceEngine.offer(TABLE, `${TABLE}:1`, ids[0], ids, state.pot);
            engine.runItTwiceEngine.chooserDecides(TABLE, ids[0], runs);
            for (const id of ids.slice(1)) engine.runItTwiceEngine.accept(TABLE, id);
            expect(engine.runItTwiceEngine.getChosenRuns(TABLE)).toBe(runs);
            const accepted = engine.runItTwiceEngine.getState(TABLE);
            expect(accepted.status).toBe('accepted');
            expect(accepted.handId).toBe(`${TABLE}:1`);
            expect(accepted.pot).toBe(state.pot);
            expect([...accepted.allPlayerIds].sort()).toEqual([...ids].sort());
            expect([...accepted.acceptedBy].sort()).toEqual([...ids].sort());
            expect(accepted.chosenRuns).toBe(runs);
            await engine.dealAndResolveRIT(state.players.filter((p) => !p.is_folded));
            const actualAwards = sorted(
              engine.currentHandPerPotAwards
                .filter((a: any) => a.amount > 0)
                .map((a: any) => ({
                  board: a.board,
                  potIndex: a.potIndex,
                  playerId: a.userId,
                  low: a.low === true,
                  units: units(a.amount, unit),
                }))
            );
            const expectedAwards = sorted(
              expected.awards.map((a) => ({
                board: a.boardIndex + 1,
                potIndex: a.potIndex,
                playerId: a.playerId,
                low: a.half === 'low',
                units: units(a.amount, unit),
              }))
            );
            const result = emitted.find((e) => e.type === 'rit_result');
            expect(engine.safeContinueRunout).not.toHaveBeenCalled();
            expect(engine.killForRestart).not.toHaveBeenCalled();
            expect(reportError).not.toHaveBeenCalled();
            expect(actualAwards).toEqual(expectedAwards);
            expect(result).toBeDefined();
            expect(result!.boards).toEqual(physical.boards.map(wire));
            expect(result!.base_board_count).toBe(prefix);
            expect(result!.runs).toBe(runs);
            expect(engine.currentHandCommunityCards).toEqual(wire(physical.boards[0]));
            expect(engine.currentHandRitExtraBoards).toEqual(physical.boards.slice(1).map(wire));
            expect(engine.currentHandRitBaseBoardCount).toBe(prefix);
            expect(engine.currentHandRitBoards).toBe(runs);
            expect(
              engine.currentHandPots.map((p: any) => ({
                amount: units(p.amount, unit),
                eligible: [...p.eligible].sort(),
              }))
            ).toEqual(
              expected.pots.map((p) => ({
                amount: units(p.amount, unit),
                eligible: [...p.eligible].sort(),
              }))
            );
            const expectedPaid = Object.fromEntries(
              Object.entries(expected.totals)
                .filter(([, n]) => n > 0)
                .map(([id, n]) => [id, units(n, unit)])
            );
            expect(
              Object.fromEntries(
                engine.currentHandWinners.map((w: any) => [w.userId, units(w.amount, unit)])
              )
            ).toEqual(expectedPaid);
            expect(
              Object.fromEntries(
                Object.entries(result!.distribution).map(([id, n]) => [
                  id,
                  units(n as number, unit),
                ])
              )
            ).toEqual(expectedPaid);
            for (const p of state.players) {
              expect(units(p.returnedUncalled ?? 0, unit)).toBe(
                units(expected.refunds[p.user_id] ?? 0, unit)
              );
              expect(units(p.stack, unit)).toBe(
                units(expected.totals[p.user_id] + (expected.refunds[p.user_id] ?? 0), unit)
              );
              expect(p.cards).toEqual(physical.hands[p.seat - 1]);
            }
            // Exact physical identities of every highlighted award: two own
            // cards and three on that specific run, including low awards.
            for (const award of result!.per_board_awards) {
              const own = new Set(physical.hands[Number(award.user_id.slice(1))].map(key));
              const board = new Set(physical.boards[award.board - 1].map(key));
              expect(award.cards).toHaveLength(5);
              expect(new Set(award.cards.map(key)).size).toBe(5);
              expect(award.cards.filter((c: Card) => own.has(key(c)))).toHaveLength(2);
              expect(award.cards.filter((c: Card) => board.has(key(c)))).toHaveLength(3);
            }
            expect(
              units(
                state.players.reduce((s, p) => s + p.stack, 0),
                unit
              )
            ).toBe(118);
            expect(handEvents.filter((e) => e.type === 'HAND_COMPLETE')).toEqual([
              expect.objectContaining({ handNumber: 1, rake: 0, bbjFee: 0 }),
            ]);
            expect(engine.ritResolutionOwner).toBeNull();
            expect(engine.runoutPayoutMutationUnsafe).toBe(false);
            expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(false);
          });

    for (const asset of ['chips', 'diamonds'] as const)
      for (const exclusion of ['tournament', 'two-seat-cash'] as const)
        it(`${asset} ${exclusion} does not enable RIT through production configuration`, () => {
          const engine = engineFor(
            variant,
            asset,
            exclusion === 'two-seat-cash' ? 2 : 4,
            exclusion === 'tournament'
          );
          expect(engine.applyRunItTwiceConfig()).toEqual({
            ritEffective: false,
            insuranceEnabled: false,
          });
          expect(engine.runItTwiceEngine.isEnabled(TABLE)).toBe(false);
        });
  });
}
