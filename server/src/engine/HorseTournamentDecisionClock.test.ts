import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyTournamentRiverSnapshot } from '../services/horseCorrectiveReview/kernelTournamentEligibility.js';
import { horsePlanBatchBindingFromRequest } from './HorsePlanHandIdentity.js';
import type { HandController } from './HandController.js';
import {
  horseTournamentProvenanceIsValid,
  horseTournamentProvenanceMatchesSnapshot,
} from './HorseTournamentContextProvenance.js';
import type {
  FastHorseDecisionResult,
  LiveHorseDecisionSnapshot,
} from './horseDecision/protocol.js';
import * as tournamentContext from '../services/TournamentBrainContext.js';

const { loadTournamentBlinds, loadSeatedPlayers, responses, from } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();
  const from = vi.fn((table: string) => {
    const result = async () => ({
      data: responses.get(table) ?? [],
      error: null,
      count: Array.isArray(responses.get(table))
        ? (responses.get(table) as unknown[]).length
        : null,
    });
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'in', 'range', 'update'])
      chain[method] = () => chain;
    chain.maybeSingle = result;
    chain.then = (resolve: (x: unknown) => unknown, reject: (x: unknown) => unknown) =>
      result().then(resolve, reject);
    return chain;
  });
  return { loadTournamentBlinds: vi.fn(), loadSeatedPlayers: vi.fn(), responses, from };
});
const { decideFast } = vi.hoisted(() => ({
  decideFast: vi.fn(
    (_snapshot: LiveHorseDecisionSnapshot, signal: AbortSignal) =>
      new Promise<FastHorseDecisionResult>((_resolve, reject) => {
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
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw new Error('Unexpected database write');
    },
    rpc: () => {
      throw new Error('Unexpected database RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadTournamentBlinds,
  loadSeatedPlayers,
  supabase: {
    from,
    rpc: vi.fn(async (name, args) => {
      if (name !== 'fn_ca_tournament_admission_snapshot') throw new Error('Unexpected fixture RPC');
      const row = responses.get('tournaments') as any;
      return {
        error: null,
        data: {
          ok: true,
          admission_abi: 'legacy-capacity-v1',
          entries: args.p_tournament_ids.map((id: string) => ({
            tournament_id: id,
            format_contract: row.format_contract,
            effective_max_players: row.max_players,
          })),
        },
      };
    }),
  },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.cancelHorseDecisionWork();
    engine.running = false;
    (ServerTableEngine as any).releaseCurrentEngine(engine.tableId, engine);
    engine.preciseTimer.dispose();
    engine.engineTelemetry.dispose();
  }
  loadTournamentBlinds.mockReset();
  loadSeatedPlayers.mockReset();
  decideFast.mockClear();
  tournamentContext.__clearTournamentBrainCache();
  responses.clear();
  from.mockClear();
  vi.restoreAllMocks();
});

const levelOne = { small_blind: 10, big_blind: 20, ante: 0 };
const levelTwo = { small_blind: 20, big_blind: 40, ante: 4 };

function fixture(count = 2, tableId = 'tournament-decision-clock') {
  const engine = new ServerTableEngine(tableId) as any;
  engines.push(engine);
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.running = true;
  engine.tableInfo = {
    id: engine.tableId,
    game_variant: 'nlh',
    game_type: 'tournament',
    tournament_id: 'tournament-level-boundary',
    max_players: 6,
    ...levelOne,
    ante_enabled: false,
  };
  const seats = Array.from({ length: count }, (_, index) => index + 1).map((seat) => ({
    seat_number: seat,
    user_id: 'u' + seat,
    username: 'Player ' + seat,
    occupancy_id: 'occupancy-' + seat,
    stack: 1000,
    seat_id: '00000000-0000-4000-8000-00000000000' + seat,
    seat_joined_at: '2026-09-10T00:00:00.123456Z',
  }));
  engine.seatedPlayers = seats;
  engine.takePreparedHandNumber = () => 100 + engine.handsDealtThisSession;
  engine.bombPotSchedPersistedJson = 'null';
  engine.eventShadowEnabled = false;
  engine.hub = { emitEvent: vi.fn() };
  // Cash rake is outside this tournament blind-boundary rehearsal.
  engine.refreshRakeConfig = async () => {};
  loadSeatedPlayers.mockResolvedValue(seats);
  loadTournamentBlinds.mockResolvedValue({ ...engine.tableInfo });
  // Run the real deal through configuration and HandController creation.
  // Stop at the first unrelated time-bank read, before settlement or transport.
  const prepared = new Error('hand controller prepared');
  engine.fetchTimeBankExtras = async () => {
    throw prepared;
  };
  async function deal(): Promise<HandController> {
    await expect(engine.dealHand(seats)).rejects.toBe(prepared);
    expect(engine.handController).not.toBeNull();
    return engine.handController;
  }
  return { engine, seats, deal };
}

const NOW = Date.parse('2026-10-29T16:00:00.000Z');
async function warmActualCache(tournamentId: string, seats: any[]) {
  const now = Date.now();
  responses.set('tournaments', {
    format_contract: 'mtt-v1',
    effective_max_players: 100,
    tournament_type: 'MTT',
    status: 'RUNNING',
    game_type: 'NLH',
    variant: 'freezeout',
    max_players: 100,
    table_size: 6,
    payout_structure: [{ place: 1, percentage: 100 }],
    prize_pool: 100,
    bounty_pool: 0,
    is_pko: false,
    is_bounty: false,
    is_mystery_bounty: false,
    blind_structure: [
      {
        level: 1,
        smallBlind: 10,
        bigBlind: 20,
        ante: 0,
        durationMinutes: 10,
      },
    ],
    current_level: 0,
    level_started_at: new Date(now - 60_000).toISOString(),
    started_at: new Date(now - 120_000).toISOString(),
    late_reg_mins: 0,
    late_reg_levels: 0,
    is_reentry: false,
    max_reentries: 0,
    is_rebuy: false,
    rebuy_levels: 0,
    max_rebuys: 0,
    add_on_available: false,
    addon_period_triggered: false,
    prize_pool_finalized: true,
    on_break: false,
    accelerated_mtt: false,
    big_blind_ante: false,
    authorized_to_register: false,
    bubble_protection: false,
    payout_club: { asset: 'chips', is_platform: false, union_id: null },
    buy_in_amount: 0,
    buy_in_fee: 0,
    starting_chips: 1000,
    satellite_seats: 0,
    satellite_target_id: null,
  });
  responses.set(
    'tournament_players',
    seats.map((s) => ({ user_id: s.user_id, chips: s.stack, status: 'active', current_bounty: 0 }))
  );
  tournamentContext.refreshTournamentBrainContext(tournamentId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cached = tournamentContext.getTournamentBrainContextSnapshot(tournamentId);
  expect(cached.status).toBe('complete');
  expect(cached.contextProvenance.source).toBeTruthy();
  return from.mock.calls.length;
}
describe('tournament decision cutoff includes its assembled original cache read', () => {
  it.each([false, true])(
    'keeps original read before cutoff with advancing clock: %s',
    async (advancing) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const { engine, seats, deal } = fixture();
      engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'fixture-lease' });
      const hand = await deal();
      hand.start();
      let actions = 0;
      while (hand.getState().stage !== 'river' && actions++ < 12) {
        const state = hand.getState();
        const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
        const menu = hand.getAuthoritativeActionState(player.user_id)!;
        expect(hand.performAction(player.seat, menu.toCall > 0 ? 'call' : 'check')).toBe(true);
      }
      expect(hand.getState().stage).toBe('river');
      const reads = await warmActualCache(engine.tableInfo.tournament_id, seats);
      let now = NOW;
      vi.mocked(Date.now).mockImplementation(() => (advancing ? ++now : now));
      const state = hand.getState();
      const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
      engine.scheduleHorseAction(
        seats.find((s) => s.user_id === player.user_id)!,
        player.seat,
        player,
        state
      );
      expect(decideFast).toHaveBeenCalledOnce();
      const request = decideFast.mock.calls[0]![0];
      expect(request.gameState.tournament?.contextStatus).toBe('complete');
      expect(horseTournamentProvenanceMatchesSnapshot(request)).toBe(true);
      expect(
        horseTournamentProvenanceIsValid(request.gameState.tournament!.contextProvenance)
      ).toBe(true);
      expect(from.mock.calls.length).toBe(reads);
      const provenance = request.gameState.tournament!.contextProvenance!;
      console.log(
        'clock fixture scalar',
        JSON.stringify({
          advancing,
          cutoff: request.decisionTimeMs,
          readAt: provenance.readAtMs,
          completed: provenance.source!.readCompletedAtMs,
          classification: classifyTournamentRiverSnapshot(request),
        })
      );
      expect(provenance.source!.readCompletedAtMs).toBeLessThanOrEqual(request.decisionTimeMs);
      expect(provenance.readAtMs).toBeLessThanOrEqual(request.decisionTimeMs);
      expect(classifyTournamentRiverSnapshot(request)).toEqual({
        status: 'excluded',
        reason: 'opponent_not_all_in',
      });
      // These independent invalid observations must still be refused. Neither
      // moving the request cutoff nor this fixture weakens the original guards.
      for (const invalid of [
        'future_read',
        'future_source',
        'stale_source',
        'wrong_actor',
      ] as const) {
        const forged = structuredClone(request);
        const p = forged.gameState.tournament!.contextProvenance!;
        if (invalid === 'future_read') {
          p.readAtMs = forged.decisionTimeMs + 1;
          p.ageMs = p.readAtMs - p.source!.readCompletedAtMs;
          forged.gameState.tournament!.sourceAgeMs = p.ageMs;
        }
        if (invalid === 'future_source') {
          p.source!.readCompletedAtMs = forged.decisionTimeMs + 1;
          p.ageMs = 0;
          forged.gameState.tournament!.sourceAgeMs = 0;
        }
        if (invalid === 'stale_source')
          forged.decisionTimeMs = p.source!.readCompletedAtMs + 60_001;
        if (invalid === 'wrong_actor') p.projection.actorId = 'different-actor';
        expect(classifyTournamentRiverSnapshot(forged), invalid).toEqual({
          status: 'gap',
          reason: 'original_provenance_missing_or_mismatched',
        });
      }
    }
  );
});

it('keeps assembly and worker time inside the original visible think delay', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const { engine, seats, deal } = fixture();
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'fixture-lease' });
  const hand = await deal();
  hand.start();
  await warmActualCache(engine.tableInfo.tournament_id, seats);
  let now = NOW;
  vi.mocked(Date.now).mockImplementation(() => ++now);
  let answer!: (value: FastHorseDecisionResult) => void;
  decideFast.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  const timer = vi.spyOn(engine, 'setHandTimeout');
  const state = hand.getState();
  const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
  engine.scheduleHorseAction(
    seats.find((s) => s.user_id === player.user_id)!,
    player.seat,
    player,
    state
  );
  const request = decideFast.mock.calls[0]![0];
  expect(request.decisionTimeMs).toBeGreaterThan(NOW + 1);
  vi.mocked(Date.now).mockReturnValue(NOW + 100);
  answer({
    type: 'FAST_RESULT',
    requestId: 1,
    generation: request.generation,
    fence: request.fence,
    decision: { action: 'call', thinkTime: 3000 },
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 0,
    governorScale: 1,
    effects: [],
    planBinding: horsePlanBatchBindingFromRequest({ ...request, requestId: 1 }),
    planIssueDisposition: 'no_effects',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  // First scheduler clock was NOW+1. Resetting visible think time at the
  // later snapshot cutoff would add assembly time to this exact delay.
  expect(timer).toHaveBeenCalled();
  expect(timer.mock.calls.at(-1)![1]).toBe(2901);
});
