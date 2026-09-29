/**
 * KILL POTS, rule manifest kill-v1: the engine glue.
 *
 * Runs the REAL dealHand through configuration and HandController creation on
 * a fixed-limit cash table, stopping at the first unrelated time-bank read, so
 * the hand the engine builds is the hand these assertions read. Settlement is
 * exercised through settleKillPot on the controller's own captures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandController } from './HandController.js';

const { loadSeatedPlayers, fromCalls, lastRow, decideFast } = vi.hoisted(() => ({
  loadSeatedPlayers: vi.fn(),
  fromCalls: [] as string[],
  lastRow: { value: null as unknown },
  decideFast: vi.fn(
    (_snapshot: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('fixture turn retired')), {
          once: true,
        });
      })
  ),
}));
vi.mock('./horseDecision/index.js', async (original) => ({
  ...(await original<typeof import('./horseDecision/index.js')>()),
  getLiveHorseDecisionWorker: () => ({ decideFast }),
}));
vi.mock('../services/supabase/client.js', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: lastRow.value, error: null }),
  };
  return {
    supabase: {
      from: (table: string) => {
        fromCalls.push(table);
        if (table === 'hand_history') return chain;
        throw new Error(`Unexpected database access: ${table}`);
      },
      rpc: () => {
        throw new Error('Unexpected database RPC');
      },
    },
    maintenanceSupabase: {},
  };
});
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadSeatedPlayers,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { KILL_RULE_VERSION, type PendingKill } from './KillPot.js';

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.cancelHorseDecisionWork();
    engine.running = false;
    (ServerTableEngine as any).releaseCurrentEngine(engine.tableId, engine);
    engine.preciseTimer.dispose();
    engine.engineTelemetry.dispose();
  }
  loadSeatedPlayers.mockReset();
  decideFast.mockClear();
  fromCalls.length = 0;
  lastRow.value = null;
  vi.restoreAllMocks();
});

function fixture(opts: { count?: number; table?: Record<string, unknown> } = {}) {
  const count = opts.count ?? 5;
  const engine = new ServerTableEngine('kill-engine-' + Math.random().toString(36).slice(2)) as any;
  engines.push(engine);
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.running = true;
  engine.tableInfo = {
    id: engine.tableId,
    game_variant: 'flh',
    game_type: 'cash',
    tournament_id: null,
    max_players: 9,
    small_blind: 2,
    big_blind: 4,
    ante_enabled: false,
    kill_mode: 'full',
    kill_threshold_bb: 10,
    ...opts.table,
  };
  const seats = Array.from({ length: count }, (_, index) => index + 1).map((seat) => ({
    seat_number: seat,
    user_id: 'u' + seat,
    username: 'Player ' + seat,
    occupancy_id: 'occupancy-' + seat,
    stack: 400,
    seat_id: '00000000-0000-4000-8000-00000000000' + seat,
    seat_joined_at: '2026-09-10T00:00:00.123456Z',
  }));
  engine.seatedPlayers = seats;
  engine.dealtInUserIds = new Set(seats.map((s) => s.user_id));
  engine.lastButtonSeat = count; // next button: seat 1 -> SB 2, BB 3, UTG 4
  engine.takePreparedHandNumber = () => 5000 + engine.handsDealtThisSession;
  engine.bombPotSchedPersistedJson = 'null';
  engine.eventShadowEnabled = false;
  engine.hub = { emitEvent: vi.fn() };
  engine.refreshRakeConfig = async () => {};
  loadSeatedPlayers.mockResolvedValue(seats);
  const prepared = new Error('hand controller prepared');
  engine.fetchTimeBankExtras = async () => {
    throw prepared;
  };
  async function deal(players = seats): Promise<HandController> {
    await expect(engine.dealHand(players)).rejects.toBe(prepared);
    expect(engine.handController).not.toBeNull();
    // The deal stops before the engine starts the controller; post the forced
    // money here exactly as start() does in production.
    engine.handController.start();
    return engine.handController;
  }
  return { engine, seats, deal };
}

const pending = (over: Partial<PendingKill> = {}): PendingKill => ({
  ruleVersion: KILL_RULE_VERSION,
  triggerHandId: 'trigger-row',
  triggerHandNumber: 4999,
  killerUserId: 'u4',
  killerSeat: 4,
  mode: 'full',
  thresholdBb: 10,
  chained: false,
  contestedTotal: 48,
  ...over,
});

describe('the deal builds the kill hand from the pending kill', () => {
  it('killer dealt in: HandConfig carries the frozen kill; every reader agrees on 8/16', async () => {
    const { engine, deal } = fixture();
    engine.killSchedule.restore(pending());
    const hc = await deal();
    const kill = hc.getKillHandState();
    expect(kill).toMatchObject({
      mode: 'full',
      smallBet: 8,
      bigBet: 16,
      killBlind: 8,
      killerUserId: 'u4',
      killerSeat: 4,
      killerBlindSlot: 'none',
      triggerHandId: 'trigger-row',
    });
    const state = hc.getState();
    expect(state.currentBet).toBe(8);
    // The published betting structure, the controller and the snap agree.
    expect(engine.bettingStructureFields(state)).toMatchObject({
      betting_structure: 'fixed_limit',
      fixed_bet_size: 8,
      fixed_raise_size: 8,
    });
    expect(hc.getAuthoritativeActionState('u4')?.fixedBetSize).toBe(8);
    // Base blinds unchanged in the hand's own blind snapshot.
    expect(hc.getBlindSnapshot()).toMatchObject({ smallBlind: 2, bigBlind: 4 });
    // Snapshot fields for the felt.
    expect(engine.killPotSnapshotFields()).toEqual({
      kill_hand: {
        mode: 'full',
        small_bet: 8,
        big_bet: 16,
        kill_blind: 8,
        killer_seat: 4,
        killer_user_id: 'u4',
        killer_blind_slot: 'none',
        chained: false,
      },
      kill_next: null,
    });
    // The kill stays pending while its hand is in flight.
    expect(engine.killSchedule.getPending()?.triggerHandNumber).toBe(4999);
    expect(engine.currentHandKillCancellation).toBeNull();
  });

  it('the killer in the small blind is recorded as posting in that slot', async () => {
    const { engine, deal } = fixture();
    engine.killSchedule.restore(pending({ killerUserId: 'u2', killerSeat: 2 }));
    const hc = await deal();
    expect(hc.getKillHandState()?.killerBlindSlot).toBe('sb');
    expect(hc.getState().players.find((p) => p.seat === 2)?.bet).toBe(8);
  });

  it('a newly seated player cannot be a killer they never were; the killer not dealt in cancels', async () => {
    const { engine, seats, deal } = fixture();
    engine.killSchedule.restore(pending());
    // u4 is sitting out (not in the roster this hand is dealt to).
    const hc = await deal(seats.filter((s) => s.user_id !== 'u4'));
    expect(hc.getKillHandState()).toBeNull();
    expect(hc.getState().currentBet).toBe(4);
    expect(engine.currentHandKillCancellation).toMatchObject({ reason: 'killer_not_dealt_in' });
    expect(engine.killSchedule.getPending()).toBeNull();
  });

  it("a table switched to 'off' cancels the pending kill at the next hand", async () => {
    const { engine, deal } = fixture({ table: { kill_mode: 'off' } });
    engine.killSchedule.restore(pending());
    const hc = await deal();
    expect(hc.getKillHandState()).toBeNull();
    expect(engine.currentHandKillCancellation).toMatchObject({ reason: 'kill_mode_off' });
  });

  it('a row without the kill columns (old shape) is off and never kills', async () => {
    const { engine, deal } = fixture({
      table: { kill_mode: undefined, kill_threshold_bb: undefined },
    });
    const hc = await deal();
    expect(hc.getKillHandState()).toBeNull();
    expect(engine.currentHandKillSettings.mode).toBe('off');
  });

  it('a no-limit table never kills', async () => {
    const { engine, deal } = fixture({ table: { game_variant: 'nlh' } });
    engine.killSchedule.restore(pending());
    const hc = await deal();
    expect(hc.getKillHandState()).toBeNull();
    expect(engine.currentHandKillCancellation).toMatchObject({ reason: 'not_fixed_limit' });
  });

  it('a human on a kill hand is offered the kill sizes', async () => {
    const { engine, deal } = fixture();
    engine.killSchedule.restore(pending());
    const hc = await deal();
    const state = hc.getState();
    const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    expect(actor.seat).toBe(4);
    const legal = engine.getPlayerActions(actor.user_id);
    expect(legal).toMatchObject({ structure: 'fixed_limit', betSize: 8, toCall: 0 });
    expect(legal.minRaise).toBe(16);
  });

  it('a horse on a kill hand is handed exactly the same sizes (CLAUDE.md 10.5)', async () => {
    const { engine, seats, deal } = fixture();
    engine.killSchedule.restore(pending());
    const hc = await deal();
    const state = hc.getState();
    const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    const seated = { ...seats.find((p) => p.user_id === player.user_id)!, is_horse: true };
    // The horse turn is fenced on the engine lease, as every turn is.
    engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'fixture-lease' });
    engine.scheduleHorseAction(seated, player.seat, player, state);
    expect(decideFast).toHaveBeenCalledOnce();
    const snapshot = decideFast.mock.calls[0]![0] as any;
    expect(snapshot.gameState).toMatchObject({
      bettingStructure: 'fixed_limit',
      fixedBetSize: 8,
      fixedLimitSmallBet: 8,
      minRaiseTo: 16,
      maxRaiseTo: 16,
      toCall: 0,
      currentBet: 8,
      // The base big blind still anchors depth and every BB-denominated read.
      bigBlind: 4,
    });
  });
});

describe('settlement sets, spends and records the kill', () => {
  it('a kill hand settles: the kill is spent, its facts are recorded, a scoop chains the next', async () => {
    const { engine, deal } = fixture();
    engine.killSchedule.restore(pending());
    const hc = await deal();
    engine.currentHandPots = [{ index: 0, amount: 64, eligible: ['u1', 'u2', 'u3', 'u4', 'u5'] }];
    engine.currentHandPerPotAwards = [{ userId: 'u5', potIndex: 0, low: false, amount: 64 }];
    engine.settleKillPot();
    expect(engine.currentHandKillRecord).toMatchObject({
      rule_version: 'kill-v1',
      kill_hand: { killer_user_id: 'u4', kill_blind: 8, trigger_hand_id: 'trigger-row' },
      next_kill: { killer_user_id: 'u5', killer_seat: 5, chained: true, contested_total: 64 },
    });
    expect(engine.killSchedule.getPending()).toMatchObject({
      killerUserId: 'u5',
      triggerHandNumber: engine.handCount,
      triggerHandId: null,
    });
    // The id is minted by settlement and bound once, to the pending kill and the row.
    const row = engine.killSchedule.bindTriggerHandId(
      engine.handCount,
      'minted-id',
      engine.currentHandKillRecord
    );
    expect(row.next_kill.trigger_hand_id).toBe('minted-id');
    expect(engine.killSchedule.getPending()?.triggerHandId).toBe('minted-id');
    // The felt is told about the NEXT kill as soon as it is set.
    expect(engine.killPotSnapshotFields().kill_next).toMatchObject({
      killer_user_id: 'u5',
      small_bet: 8,
      big_bet: 16,
    });
    expect(hc.getKillHandState()?.killerUserId).toBe('u4');
  });

  it('a duplicate settlement event does not schedule a second kill', async () => {
    const { engine, deal } = fixture();
    await deal();
    engine.currentHandPots = [{ index: 0, amount: 44, eligible: ['u1', 'u2'] }];
    engine.currentHandPerPotAwards = [{ userId: 'u1', potIndex: 0, low: false, amount: 44 }];
    engine.settleKillPot();
    const first = engine.currentHandKillRecord;
    engine.currentHandPerPotAwards = [{ userId: 'u2', potIndex: 0, low: false, amount: 44 }];
    engine.settleKillPot();
    expect(engine.currentHandKillRecord).toEqual(first);
    expect(engine.killSchedule.getPending()?.killerUserId).toBe('u1');
  });

  it('below the threshold, a split, or a bomb hand never sets a kill', async () => {
    const { engine, deal } = fixture();
    await deal();
    engine.currentHandPots = [{ index: 0, amount: 39.99, eligible: ['u1', 'u2'] }];
    engine.currentHandPerPotAwards = [{ userId: 'u1', potIndex: 0, low: false, amount: 39.99 }];
    engine.settleKillPot();
    expect(engine.currentHandKillRecord).toBeNull();
    expect(engine.killSchedule.getPending()).toBeNull();
  });

  it('the settings a hand was dealt under decide its trigger, not a mid-hand change', async () => {
    const { engine, deal } = fixture({ table: { kill_threshold_bb: 15 } });
    await deal();
    engine.tableInfo.kill_threshold_bb = 8; // owner changes it mid-hand
    engine.currentHandPots = [{ index: 0, amount: 44, eligible: ['u1', 'u2'] }];
    engine.currentHandPerPotAwards = [{ userId: 'u1', potIndex: 0, low: false, amount: 44 }];
    engine.settleKillPot();
    expect(engine.killSchedule.getPending()).toBeNull(); // 44 < 15bb (60)
  });

  it('the next hand after a trigger publishes the pending kill', async () => {
    const { engine, deal } = fixture({ table: { kill_mode: 'half' } });
    await deal();
    engine.currentHandPots = [{ index: 0, amount: 48, eligible: ['u1', 'u3'] }];
    engine.currentHandPerPotAwards = [{ userId: 'u3', potIndex: 0, low: false, amount: 48 }];
    engine.settleKillPot();
    expect(engine.killPotSnapshotFields()).toEqual({
      kill_hand: null,
      kill_next: {
        mode: 'half',
        small_bet: 6,
        big_bet: 12,
        kill_blind: 6,
        killer_seat: 3,
        killer_user_id: 'u3',
      },
    });
  });
});

describe('restart restores the pending kill from the last settled hand', () => {
  it("reads kill_pot.next_kill from the table's last hand_history row, keyed to its id", async () => {
    const { engine } = fixture();
    lastRow.value = {
      id: 'row-77',
      hand_number: 77,
      kill_pot: {
        rule_version: 'kill-v1',
        kill_hand: null,
        next_kill: {
          killer_user_id: 'u2',
          killer_seat: 2,
          mode: 'full',
          multiplier: '2/1',
          threshold_bb: 10,
          threshold_amount: 40,
          contested_total: 52,
          trigger_hand_id: null,
          trigger_hand_number: 77,
          chained: false,
          scoop: { winner: 'u2', pots: 1, awards: 1, boards: [1], low_awards: 0 },
        },
        cancelled: null,
      },
    };
    await engine.restoreKillFromHistory();
    expect(fromCalls).toEqual(['hand_history']);
    expect(engine.killSchedule.getPending()).toMatchObject({
      killerUserId: 'u2',
      triggerHandId: 'row-77',
      triggerHandNumber: 77,
      mode: 'full',
    });
  });

  it('an in-flight kill hand abandoned by a crash leaves the trigger row last: still the kill hand', async () => {
    const { engine, deal } = fixture();
    // The kill hand never wrote a row; the last row is still the trigger's.
    lastRow.value = {
      id: 'row-trigger',
      hand_number: 90,
      kill_pot: {
        rule_version: 'kill-v1',
        kill_hand: null,
        next_kill: {
          killer_user_id: 'u4',
          killer_seat: 4,
          mode: 'half',
          multiplier: '3/2',
          threshold_bb: 10,
          threshold_amount: 40,
          contested_total: 44,
          trigger_hand_id: 'row-trigger',
          trigger_hand_number: 90,
          chained: false,
          scoop: { winner: 'u4', pots: 1, awards: 1, boards: [1], low_awards: 0 },
        },
        cancelled: null,
      },
    };
    await engine.restoreKillFromHistory();
    const hc = await deal();
    expect(hc.getKillHandState()).toMatchObject({
      killerUserId: 'u4',
      killBlind: 6,
      triggerHandId: 'row-trigger',
    });
  });

  it('never reads history at a table that is not fixed limit', async () => {
    const { engine } = fixture({ table: { game_variant: 'nlh' } });
    await engine.restoreKillFromHistory();
    expect(fromCalls).toEqual([]);
    expect(engine.killSchedule.getPending()).toBeNull();
  });

  it("a pending kill restored at a table switched 'off' is cancelled, and says so", async () => {
    const { engine, deal } = fixture({ table: { kill_mode: 'off' } });
    lastRow.value = {
      id: 'row-5',
      hand_number: 5,
      kill_pot: {
        rule_version: 'kill-v1',
        kill_hand: null,
        next_kill: {
          killer_user_id: 'u4',
          killer_seat: 4,
          mode: 'full',
          multiplier: '2/1',
          threshold_bb: 10,
          threshold_amount: 40,
          contested_total: 40,
          trigger_hand_id: 'row-5',
          trigger_hand_number: 5,
          chained: false,
          scoop: { winner: 'u4', pots: 1, awards: 1, boards: [1], low_awards: 0 },
        },
        cancelled: null,
      },
    };
    await engine.restoreKillFromHistory();
    const hc = await deal();
    expect(hc.getKillHandState()).toBeNull();
    expect(engine.currentHandKillCancellation).toMatchObject({
      reason: 'kill_mode_off',
      pending: { triggerHandId: 'row-5' },
    });
  });
});

describe('run it twice: every run is a board of the scoop', () => {
  it('the same winner of both runs of every pot triggers', async () => {
    const { engine, deal } = fixture();
    await deal();
    engine.currentHandPots = [
      { index: 0, amount: 30, eligible: ['u1', 'u2', 'u3'] },
      { index: 1, amount: 20, eligible: ['u1', 'u2'] },
    ];
    engine.currentHandPerPotAwards = [
      { userId: 'u1', potIndex: 0, low: false, amount: 15, board: 1 },
      { userId: 'u1', potIndex: 1, low: false, amount: 10, board: 1 },
      { userId: 'u1', potIndex: 0, low: false, amount: 15, board: 2 },
      { userId: 'u1', potIndex: 1, low: false, amount: 10, board: 2 },
    ];
    engine.settleKillPot();
    expect(engine.currentHandKillRecord?.next_kill).toMatchObject({
      killer_user_id: 'u1',
      contested_total: 50,
      scoop: { boards: [1, 2], pots: 2 },
    });
  });

  it('different run winners, or a side pot to someone else, do not', async () => {
    const { engine, deal } = fixture();
    await deal();
    engine.currentHandPots = [{ index: 0, amount: 60, eligible: ['u1', 'u2'] }];
    engine.currentHandPerPotAwards = [
      { userId: 'u1', potIndex: 0, low: false, amount: 30, board: 1 },
      { userId: 'u2', potIndex: 0, low: false, amount: 30, board: 2 },
    ];
    engine.settleKillPot();
    expect(engine.killSchedule.getPending()).toBeNull();

    const second = fixture();
    await second.deal();
    second.engine.currentHandPots = [
      { index: 0, amount: 40, eligible: ['u1', 'u2', 'u3'] },
      { index: 1, amount: 20, eligible: ['u1', 'u2'] },
    ];
    second.engine.currentHandPerPotAwards = [
      { userId: 'u3', potIndex: 0, low: false, amount: 40 },
      { userId: 'u1', potIndex: 1, low: false, amount: 20 },
    ];
    second.engine.settleKillPot();
    expect(second.engine.killSchedule.getPending()).toBeNull();
  });
});

describe('the wiring that has no behaviour of its own to run here (source pins)', () => {
  const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
  const settlement = read('ServerTableEngineSettlement.ts');

  it('the trigger is evaluated once from settlement, before the record is captured', () => {
    const evaluate = settlement.indexOf('this.settleKillPot();');
    const post = settlement.indexOf('const postTasks = this.postHandTasks(players');
    expect(evaluate).toBeGreaterThan(-1);
    expect(evaluate).toBeLessThan(post);
    expect(settlement).toMatch(/killPot: this\.currentHandKillRecord,/);
  });

  it('the pending kill is keyed to the minted hand id and written in that same row', () => {
    const mint = settlement.indexOf('const v_handId = randomUUID();');
    const bind = settlement.search(
      /this\.killSchedule\.bindTriggerHandId\(\s*snap\.handNumber,\s*v_handId,\s*snap\.killPot\s*\)/
    );
    expect(mint).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(mint);
    expect(settlement).toMatch(/killPot: killPotRecord,/);
  });

  it('hand history, BBJ detection and the BBJ tier stay on the BASE big blind', () => {
    expect(settlement).toMatch(/smallBlind: tableInfo\.small_blind,/);
    expect(settlement).toMatch(/bigBlind: tableInfo\.big_blind,/);
    expect(settlement).toMatch(/getTierIdForBB\(this\.tableInfo\.big_blind\)/);
    expect(settlement).not.toMatch(/killPot\??\.(smallBet|bigBet|killBlind)/);
  });
});
