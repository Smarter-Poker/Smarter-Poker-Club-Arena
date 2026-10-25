/**
 * THE COMMITMENT REVIEW GRADES THE DECISION THE ENGINE ACTUALLY RECORDED
 * (2026-10-24).
 *
 * fn_horse_commitment_reference_grade (migration 20261024225914) reads three
 * things the engine writes: hand_history.actions (each accepted action with
 * its `publicNode`, `origin` and `isFullRaise`), the forced posts in the same
 * list, and the horse's hole cards from accepted_hand_facts.stats_facts.
 * Its PostgreSQL fixture (scripts/ci/probes/horse-commitment-audit/
 * reference-grade.sql) must therefore hold hands in exactly the shape the
 * live producer writes, not a hand-typed imitation of it.
 *
 * This test plays each fixture hand through the real HandController, maps
 * every FORCED_BETS_POSTED and PLAYER_ACTION event to the persisted record
 * exactly as ServerTableEngineHandEvents does, and requires the JSON embedded
 * in the SQL fixture to be byte-for-byte what the engine produces today. If
 * the action record or the public node changes shape, this fails before the
 * grader can silently stop matching production rows.
 *
 * Regenerate after an intentional producer change:
 *   HORSE_REFERENCE_FIXTURE_PRINT=1 npx vitest run src/services/horseCommitmentReferenceGrade.fixture.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandController } from '../engine/HandController.js';
import type {
  AcceptedActionOrigin,
  ActionType,
  Card,
  GameVariant,
  HandConfig,
  HandEvent,
  SeatPlayer,
} from '../types.js';

const FIXTURE = join(
  __dirname,
  '../../../scripts/ci/probes/horse-commitment-audit/reference-grade.sql'
);

interface Step {
  seat: number;
  action: ActionType;
  /** 'max' raises to the legal maximum (a pot-limit pot raise). */
  amount?: number | 'max';
  origin?: AcceptedActionOrigin;
}
interface Scenario {
  name: string;
  variant: GameVariant;
  tournament: boolean;
  smallBlind: number;
  bigBlind: number;
  dealerSeat: number;
  stacks: Record<number, number>;
  horseSeat: number;
  horseCards: Card[];
  steps: Step[];
}

const uid = (seat: number) => `00000000-0000-4000-8000-0000000000${String(seat).padStart(2, '0')}`;
const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });

/** Each hand the PostgreSQL fixture grades. The horse is always uid(horseSeat). */
export const SCENARIOS: Scenario[] = [
  {
    // Tournament, 12 BB, folded to the button: the chart jams A5s 96.4%.
    name: 'open_jam_agreed',
    variant: 'nlh',
    tournament: true,
    smallBlind: 50,
    bigBlind: 100,
    dealerSeat: 4,
    stacks: { 1: 1200, 2: 1200, 3: 1200, 4: 1200, 5: 1200, 6: 1200 },
    horseSeat: 4,
    horseCards: [card('A', 'spades'), card('5', 'spades')],
    steps: [
      { seat: 1, action: 'fold', origin: 'player' },
      { seat: 2, action: 'fold', origin: 'player' },
      { seat: 3, action: 'fold', origin: 'player' },
      { seat: 4, action: 'all_in', origin: 'horse_policy' },
      { seat: 5, action: 'fold', origin: 'player' },
      { seat: 6, action: 'call', origin: 'player' },
    ],
  },
  {
    // Same spot from the cutoff with 72o, which the chart never jams.
    name: 'open_jam_deviation',
    variant: 'nlh',
    tournament: true,
    smallBlind: 50,
    bigBlind: 100,
    dealerSeat: 4,
    stacks: { 1: 1200, 2: 1200, 3: 1200, 4: 1200, 5: 1200, 6: 1200 },
    horseSeat: 3,
    horseCards: [card('7', 'hearts'), card('2', 'clubs')],
    steps: [
      { seat: 1, action: 'fold', origin: 'player' },
      { seat: 2, action: 'fold', origin: 'player' },
      { seat: 3, action: 'all_in', origin: 'horse_policy' },
      { seat: 4, action: 'fold', origin: 'player' },
      { seat: 5, action: 'fold', origin: 'player' },
      { seat: 6, action: 'call', origin: 'player' },
    ],
  },
  {
    // Big blind horse with 15 BB facing a 13 BB small-blind jam, calls K9o.
    name: 'bb_defend_agreed',
    variant: 'nlh',
    tournament: true,
    smallBlind: 50,
    bigBlind: 100,
    dealerSeat: 4,
    stacks: { 1: 1500, 2: 1500, 3: 1500, 4: 1500, 5: 1300, 6: 1500 },
    horseSeat: 6,
    horseCards: [card('K', 'diamonds'), card('9', 'clubs')],
    steps: [
      { seat: 1, action: 'fold', origin: 'player' },
      { seat: 2, action: 'fold', origin: 'player' },
      { seat: 3, action: 'fold', origin: 'player' },
      { seat: 4, action: 'fold', origin: 'player' },
      { seat: 5, action: 'all_in', origin: 'player' },
      { seat: 6, action: 'call', origin: 'horse_policy' },
    ],
  },
  {
    // 100 BB cash: opens, faces a 3-bet, four-bets all in. No chart covers it.
    name: 'deep_cash_out_of_domain',
    variant: 'nlh',
    tournament: false,
    smallBlind: 1,
    bigBlind: 2,
    dealerSeat: 4,
    stacks: { 1: 200, 2: 200, 3: 200, 4: 200, 5: 200, 6: 200 },
    horseSeat: 1,
    horseCards: [card('Q', 'hearts'), card('Q', 'diamonds')],
    steps: [
      { seat: 1, action: 'raise', amount: 6, origin: 'horse_policy' },
      { seat: 2, action: 'fold', origin: 'player' },
      { seat: 3, action: 'fold', origin: 'player' },
      { seat: 4, action: 'raise', amount: 20, origin: 'player' },
      { seat: 5, action: 'fold', origin: 'player' },
      { seat: 6, action: 'fold', origin: 'player' },
      { seat: 1, action: 'all_in', origin: 'horse_policy' },
      { seat: 4, action: 'call', origin: 'player' },
    ],
  },
  {
    // PLO4 cash: pot, re-pot, call. No PLO reference exists.
    name: 'plo4_out_of_domain',
    variant: 'plo4',
    tournament: false,
    smallBlind: 1,
    bigBlind: 2,
    dealerSeat: 2,
    stacks: { 1: 200, 2: 200, 3: 200 },
    horseSeat: 2,
    horseCards: [
      card('A', 'spades'),
      card('K', 'spades'),
      card('Q', 'hearts'),
      card('J', 'hearts'),
    ],
    steps: [
      { seat: 2, action: 'raise', amount: 'max', origin: 'horse_policy' },
      { seat: 3, action: 'fold', origin: 'player' },
      { seat: 1, action: 'raise', amount: 'max', origin: 'player' },
      { seat: 2, action: 'call', origin: 'horse_policy' },
    ],
  },
];

type PersistedAction = Record<string, unknown>;

/** Play one scenario through HandController; return the persisted action list
 * (ServerTableEngineHandEvents' mapping) and the accepted contributions. */
export function playScenario(s: Scenario): {
  actions: PersistedAction[];
  contributions: Record<string, number>;
  dealtSeats: number[];
} {
  const config: HandConfig = {
    tableId: `fixture-${s.name}`,
    handNumber: 1,
    gameVariant: s.variant,
    isTournament: s.tournament,
    smallBlind: s.smallBlind,
    bigBlind: s.bigBlind,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players: SeatPlayer[] = Object.entries(s.stacks).map(([seat, stack]) => ({
    seat: Number(seat),
    user_id: uid(Number(seat)),
    username: `seat-${seat}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(config, players, s.dealerSeat);
  const actions: PersistedAction[] = [];
  controller.onEvent((event: HandEvent) => {
    if (event.type === 'FORCED_BETS_POSTED') {
      for (const p of event.postings) {
        if (!(p.amount > 0)) continue;
        actions.push({
          seat: p.seat,
          userId: p.userId ?? '',
          action: p.kind,
          amount: p.amount,
          timestamp: Date.now(),
          stage: 'preflop',
          origin: 'forced',
          dead: p.dead === true,
        });
      }
    } else if (event.type === 'PLAYER_ACTION') {
      actions.push({
        seat: event.seat,
        userId: event.record?.userId ?? '',
        action: event.action,
        amount: event.amount,
        timestamp: event.record?.timestamp ?? Date.now(),
        stage: event.stage ?? 'preflop',
        ...(event.publicNode ? { publicNode: event.publicNode } : {}),
        ...(event.origin ? { origin: event.origin } : {}),
        isFullRaise: event.record?.isFullRaise,
      });
    }
  });
  controller.start();
  for (const step of s.steps) {
    const state = controller.getState();
    expect(state.currentPlayerSeat, `${s.name}: seat ${step.seat} to act`).toBe(step.seat);
    let amount: number | undefined;
    if (step.amount === 'max') {
      amount = controller.getAuthoritativeActionState(uid(step.seat))!.maxRaiseTo ?? undefined;
    } else amount = step.amount;
    expect(
      controller.performAction(step.seat, step.action, amount, step.origin ?? 'unknown'),
      `${s.name}: ${step.action} by seat ${step.seat}`
    ).toBe(true);
  }
  const state = controller.getState();
  const contributions: Record<string, number> = {};
  for (const p of state.players) contributions[p.user_id] = p.totalInvested;
  return {
    actions: JSON.parse(JSON.stringify(actions)) as PersistedAction[],
    contributions,
    dealtSeats: state.players.map((p) => p.seat).sort((a, b) => a - b),
  };
}

function buildFixtureHands() {
  return SCENARIOS.map((s) => {
    const played = playScenario(s);
    return {
      name: s.name,
      variant: s.variant,
      tournament: s.tournament,
      bigBlind: s.bigBlind,
      horse: uid(s.horseSeat),
      horseCards: s.horseCards,
      players: played.dealtSeats.map((seat) => ({ userId: uid(seat), seat })),
      contributions: played.contributions,
      actions: played.actions,
    };
  });
}

function embeddedHands(): unknown {
  const sql = readFileSync(FIXTURE, 'utf8');
  const match = /\$engine_hands\$(\[[\s\S]*?\])\$engine_hands\$/.exec(sql);
  if (!match) throw new Error('reference-grade.sql has no $engine_hands$ block');
  return JSON.parse(match[1]);
}

describe('the commitment review fixture is what the engine writes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('every horse decision carries the origin and public node the grader reads', () => {
    for (const s of SCENARIOS) {
      const { actions } = playScenario(s);
      const horse = actions.filter((a) => a.userId === uid(s.horseSeat) && a.origin !== 'forced');
      expect(horse.length, s.name).toBeGreaterThan(0);
      for (const a of horse) {
        expect(a.origin).toBe('horse_policy');
        const node = a.publicNode as Record<string, unknown>;
        expect(node.status).toBe('captured');
        expect(node.variant).toBe(s.variant);
        expect(node.actorSeat).toBe(s.horseSeat);
        expect(node.dealerSeat).toBe(s.dealerSeat);
        expect(node.bigBlind).toBe(s.bigBlind);
        expect(node.mode).toBe(s.tournament ? 'tournament' : 'cash');
        // [seat, behind, street wager, invested, dead, ante, flags]
        for (const seat of node.seats as unknown[][]) expect(seat).toHaveLength(7);
      }
      // Forced posts are in the same list, marked forced.
      expect(actions.some((a) => a.origin === 'forced' && a.action === 'bb')).toBe(true);
    }
  });

  it('the PostgreSQL fixture embeds exactly these engine-produced hands', () => {
    const hands = buildFixtureHands();
    if (process.env.HORSE_REFERENCE_FIXTURE_PRINT === '1') {
      process.stdout.write(JSON.stringify(hands, null, 1) + '\n');
    }
    expect(embeddedHands()).toEqual(hands);
  });
});
