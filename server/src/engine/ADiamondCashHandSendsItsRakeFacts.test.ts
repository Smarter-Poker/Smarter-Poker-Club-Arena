/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND CASH HAND SENDS ITS RAKE FACTS (2026-10-05, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Migration 20261005183028_diamond_cash_rake_reads_the_owner_settings is
 * applied to production, and `cash_rake_enabled` reads `yes`. From that
 * moment `fn_poker_diamond_settle_cash_hand` refuses by name every Diamond
 * cash hand whose stacks payload does not carry `contributed`, `dealt_in` and
 * `hand_saw_flop` on every element - `diamond_cash_rake_facts_required` -
 * whether or not a rake is actually taken. The engine sent none of the three.
 *
 * These pins hold the engine to the contract the migration states. If one goes
 * red, the Diamond felt is about to refuse every hand it deals; fix the
 * change, never the pin.
 *
 * THE CHIP PAYLOAD IS BYTE-IDENTICAL. The last pin in this file compares a
 * chip hand's roster element keys exactly, not loosely, because "the chip path
 * probably ignores them" is not the same claim as "the chip path is sent the
 * same bytes it was sent yesterday".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  obligations: vi.fn(),
  leaves: vi.fn(),
  recount: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  logHandHistory: mocks.commit,
  processHandPostCommitObligations: mocks.obligations,
  processLeavePending: mocks.leaves,
  reconcileTableSeatCount: mocks.recount,
}));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (error: unknown) => String(error),
}));
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase/client.js';
import { HandController } from './HandController.js';
import { diamondCashRakeFactsFor } from './diamondCashRakeFacts.js';
import type { HandConfig, SeatPlayer } from '../types.js';

const TABLE = '00000000-0000-0000-0000-0000000005aa';
const HAND_ID = '00000000-0000-0000-0000-0000001005aa';
const JOINED_AT = '2026-10-05T01:00:00.000Z';

/* ── the engine, holding one finished three-handed hand ──────────────────── */
function engineAndPlayers(
  options: {
    asset?: 'diamonds' | 'chips';
    contributions?: Array<[string, number]>;
    dealtStacks?: Array<[string, number]>;
    sawFlop?: boolean;
    stacks?: Record<string, number>;
  } = {}
) {
  const asset = options.asset ?? 'diamonds';
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = {
    id: TABLE,
    club_id: 'arena',
    tournament_id: null,
    game_variant: 'nlh',
    ...(asset === 'diamonds'
      ? { arena: { id: 'arena', kind: 'diamond_arena', asset: 'diamonds' } }
      : {}),
    small_blind: 1,
    big_blind: 2,
    max_players: 6,
    min_buy_in: 20,
    max_buy_in: 200,
  };
  /* A HORSE IS A PLAYER (CLAUDE.md 10.5). Seat 'b' is a horse and seat 'a' and
     'c' are people, and every assertion below treats the three identically -
     this roster exists so that a branch on is_horse could not pass. */
  const ending = options.stacks ?? { a: 70, b: 140, c: 90 };
  const players = [
    { user_id: 'a', seat_number: 1, is_horse: false },
    { user_id: 'b', seat_number: 2, is_horse: true },
    { user_id: 'c', seat_number: 3, is_horse: false },
  ].map((p) => ({
    ...p,
    seat_id: `seat-${p.user_id}`,
    seat_joined_at: JOINED_AT,
    occupancy_id: `occupancy-${p.user_id}`,
    stack: ending[p.user_id],
  }));
  engine.seatedPlayers = players;
  engine.handCount = 1000500;
  engine.currentHandVariant = 'nlh';
  engine.currentHandPotSize = 100;
  engine.currentHandRake = 0;
  engine.currentHandBBJFee = 0;
  engine.currentHandInsuranceNet = 0;
  engine.currentHandContributions = new Map(
    options.contributions ?? [
      ['a', 30],
      ['b', 40],
      ['c', 10],
    ]
  );
  engine.currentHandDealtStacks = new Map(
    options.dealtStacks ?? [
      ['a', 100],
      ['b', 100],
      ['c', 100],
    ]
  );
  engine.currentHandSawFlopForMoney = options.sawFlop ?? true;
  engine.currentHandSeatGenerations = new Map(
    players.map((p) => [p.user_id, { seat_id: p.seat_id, seat_joined_at: p.seat_joined_at }])
  );
  engine.currentHandWinners = [{ userId: 'b', amount: 100 }];
  engine.currentHandStartedAt = Date.now() - 1000;
  engine.lifecycleCanMutate = () => true;
  engine.hasCurrentEngineLeaseAuthority = () => true;
  engine.getEngineLeaseAuthority = () => ({
    verified: true,
    generation: 'generation',
    scope: 'cash',
  });
  engine.finishTerminalBoundaryPersistence = vi.fn();
  engine.announceEnvelopeResolvedAddOns = vi.fn().mockResolvedValue(undefined);
  engine.executePendingSeatMoves = vi.fn().mockResolvedValue(undefined);
  engine.wakeClusterGame = vi.fn();
  engine.killForRestart = vi.fn();
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn() };
  return { engine, players };
}

async function stacksSent(
  options: Parameters<typeof engineAndPlayers>[0] = {}
): Promise<Array<Record<string, unknown>>> {
  const { engine, players } = engineAndPlayers(options);
  await engine.postHandTasks(players, 1);
  expect(mocks.commit).toHaveBeenCalledTimes(1);
  return mocks.commit.mock.calls[0][0].atomicCommit.stacks;
}

beforeEach(() => {
  mocks.commit.mockReset().mockResolvedValue({ handId: HAND_ID, settlementCommitted: true });
  mocks.obligations.mockReset().mockResolvedValue({ ok: true, pending_addons: 0 });
  mocks.leaves.mockReset().mockResolvedValue([]);
  mocks.recount.mockReset().mockResolvedValue(3);
  vi.spyOn(supabase, 'rpc').mockImplementation(mocks.rpc);
  vi.spyOn(supabase, 'from').mockImplementation((() => {
    const chain: any = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    return chain;
  }) as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  mocks.rpc.mockReset();
});

describe('the Diamond cash settlement payload carries the settler’s three facts', () => {
  it('sends contributed, dealt_in and hand_saw_flop on every element', async () => {
    const stacks = await stacksSent();
    expect(stacks).toHaveLength(3);
    expect(stacks).toEqual([
      {
        user_id: 'a',
        seat_id: 'seat-a',
        seat_joined_at: JOINED_AT,
        stack_before: 100,
        stack: 70,
        contributed: 30,
        dealt_in: true,
        hand_saw_flop: true,
      },
      {
        user_id: 'b',
        seat_id: 'seat-b',
        seat_joined_at: JOINED_AT,
        stack_before: 100,
        stack: 140,
        contributed: 40,
        dealt_in: true,
        hand_saw_flop: true,
      },
      {
        user_id: 'c',
        seat_id: 'seat-c',
        seat_joined_at: JOINED_AT,
        stack_before: 100,
        stack: 90,
        contributed: 10,
        dealt_in: true,
        hand_saw_flop: true,
      },
    ]);
  });

  it('declares the pot the settler will add up: the contributions the engine already kept', async () => {
    const stacks = await stacksSent();
    const pot = stacks.reduce((sum, row) => sum + Number(row.contributed), 0);
    expect(pot).toBe(80);
    // Every Diamond of every loss is inside somebody's contribution, which is
    // the bound the settler enforces before it trusts the weights.
    for (const row of stacks) {
      const loss = Math.max(Number(row.stack_before) - Number(row.stack), 0);
      expect(Number(row.contributed)).toBeGreaterThanOrEqual(loss);
    }
  });

  it('rides hand_saw_flop on every element and never lets them disagree', async () => {
    for (const sawFlop of [true, false]) {
      mocks.commit.mockClear();
      const stacks = await stacksSent({ sawFlop });
      expect(new Set(stacks.map((row) => row.hand_saw_flop))).toEqual(new Set([sawFlop]));
    }
  });

  it('reads dealt_in from the stacks the hand was dealt from, horse and human alike', async () => {
    const stacks = await stacksSent({
      // 'c' was at the table but not dealt this hand, and put nothing in.
      dealtStacks: [
        ['a', 100],
        ['b', 100],
      ],
      contributions: [
        ['a', 30],
        ['b', 40],
      ],
      stacks: { a: 70, b: 130, c: 100 },
    });
    expect(stacks.map((row) => [row.user_id, row.dealt_in, row.contributed])).toEqual([
      ['a', true, 30],
      ['b', true, 40],
      ['c', false, 0],
    ]);
  });

  it('refuses a fractional contribution by name rather than rounding it into the rake', async () => {
    const { engine, players } = engineAndPlayers({
      contributions: [
        ['a', 30.5],
        ['b', 40],
        ['c', 10],
      ],
    });
    await expect(engine.postHandTasks(players, 1)).rejects.toThrow();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('refuses a contribution from a seat that was never dealt a hand', () => {
    expect(() =>
      diamondCashRakeFactsFor({
        userId: 'a',
        contributions: new Map([['a', 10]]),
        dealtStacks: new Map(),
        handSawFlop: true,
      })
    ).toThrow('diamond_contribution_without_a_dealt_hand');
  });

  it('removes float dust at the cent scale without inventing a Diamond', () => {
    expect(
      diamondCashRakeFactsFor({
        userId: 'a',
        contributions: new Map([['a', 29.999999999999996]]),
        dealtStacks: new Map([['a', 100]]),
        handSawFlop: false,
      })
    ).toEqual({ contributed: 30, dealt_in: true, hand_saw_flop: false });
  });
});

/* ── THE HAND'S FLOP FACT HAS ONE DEFINITION ─────────────────────────────── */
function mkController(over: Partial<HandConfig> = {}): HandController {
  const players: SeatPlayer[] = [1, 2, 3].map((seat) => ({
    seat,
    user_id: `u${seat}`,
    username: `P${seat}`,
    stack: 1000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hc = new HandController(
    {
      tableId: TABLE,
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 10, cap: 100, noFlopNoDrop: true },
      bbjConfig: { enabled: false, feeBB: 0, minPotBB: 10, minPlayersDealt: 3 },
      ...over,
    } as HandConfig,
    players,
    1
  );
  hc.start();
  return hc;
}
function giveFlop(hc: HandController): void {
  (hc as unknown as { state: { communityCards: unknown[] } }).state.communityCards = [
    { rank: 'A', suit: 'spades' },
    { rank: '7', suit: 'hearts' },
    { rank: '2', suit: 'clubs' },
  ];
}
function setSawFlopFlag(hc: HandController, value: boolean): void {
  (hc as unknown as { state: { sawFlop: boolean } }).state.sawFlop = value;
}

describe('handSawFlopForMoney is the same fact priceDeductions prices with', () => {
  it('is false on a hand with no flop, and the pricer takes nothing', () => {
    const hc = mkController();
    setSawFlopFlag(hc, false);
    expect(hc.handSawFlopForMoney()).toBe(false);
    expect(hc.priceDeductions(false, 500).rake).toBe(0);
  });

  it('is true once the board corroborates the flag, and the pricer rakes', () => {
    const hc = mkController();
    giveFlop(hc);
    setSawFlopFlag(hc, true);
    expect(hc.handSawFlopForMoney()).toBe(true);
    expect(hc.priceDeductions(true, 500).rake).toBeGreaterThan(0);
  });

  it('agrees with the pricer when the flag is true and NO board exists', () => {
    // The 2026-08-31 rake-law incident: a true flag over an empty board. The
    // pricer refuses the drop, so the fact the hand reports must refuse it too
    // - otherwise the engine would tell the database it saw a flop while
    // charging itself as though it had not.
    const hc = mkController();
    setSawFlopFlag(hc, true);
    expect(hc.handSawFlopForMoney()).toBe(false);
    expect(hc.priceDeductions(true, 500).rake).toBe(0);
  });
});

/* ── THE CHIP PATH IS UNTOUCHED ──────────────────────────────────────────── */
describe('a chip hand sends exactly the keys it sent before', () => {
  it('carries no rake facts, and the same five keys per element', async () => {
    const stacks = await stacksSent({ asset: 'chips' });
    expect(stacks).toHaveLength(3);
    for (const row of stacks) {
      expect(Object.keys(row).sort()).toEqual([
        'seat_id',
        'seat_joined_at',
        'stack',
        'stack_before',
        'user_id',
      ]);
      expect('contributed' in row).toBe(false);
      expect('dealt_in' in row).toBe(false);
      expect('hand_saw_flop' in row).toBe(false);
    }
  });

  it('refuses nothing a chip table used to accept: a fractional contribution still commits', async () => {
    // The whole-Diamond refusal is a Diamond rule. A chip contribution of
    // 30.50 is ordinary money and must still settle exactly as it did.
    const stacks = await stacksSent({
      asset: 'chips',
      contributions: [
        ['a', 30.5],
        ['b', 40],
        ['c', 10],
      ],
    });
    expect(stacks).toHaveLength(3);
  });
});
