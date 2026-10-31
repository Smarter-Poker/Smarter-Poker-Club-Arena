/** A retained undealt original owns its number through the real dealHand stop. */
import { afterEach, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({
  original: null as any,
  packet: null as any,
  parked: null as any,
  onRetain: null as null | (() => void),
  decode: null as any,
  calls: [] as string[],
}));
vi.mock('../services/supabase/client.js', () => {
  const rpc = async (name: string, p: any) => {
    wire.calls.push(name);
    if (name === 'save_hand_state_snapshot') return { data: null, error: null };
    if (name === 'fn_f06_retain_hand_continuation') {
      wire.original = wire.decode(p.p_payload, p.p_sha256);
      wire.packet = { payload: p.p_payload, sha256: p.p_sha256 };
      wire.onRetain?.();
      return {
        data: {
          ok: true,
          table_id: p.p_table_id,
          hand_number: p.p_hand_number,
          sequence: p.p_sequence,
          sha256: p.p_sha256,
          writer_generation: p.p_lease_generation,
        },
        error: null,
      };
    }
    if (name === 'fn_park_stopped_time_bank_custody') {
      expect(p.p_unstarted_permit_id ?? null).toBeNull();
      wire.parked = structuredClone(p);
      return {
        data: { ok: true, table_id: p.p_table_id, hand_number: p.p_hand_number },
        error: null,
      };
    }
    throw Error('Unexpected RPC ' + name);
  };
  return {
    supabase: {
      rpc: (name: string, p: any) => {
        const result: any = rpc(name, p);
        result.abortSignal = () => result;
        return result;
      },
      from: (table: string) => {
        const q: any = {
          select: () => q,
          eq: () => q,
          in: () => q,
          abortSignal: () => Promise.resolve({ data: [], error: null }),
          upsert: async () => {
            expect(table).toBe('engine_presence_parked');
            return { error: null };
          },
        };
        return q;
      },
    },
    maintenanceSupabase: {},
  };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import { GameServer } from '../GameServer.js';
import { TournamentManager } from '../tournament/TournamentManager.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { bindTournamentDataAuthorityMethods } from '../services/supabase/dataActorContext.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import {
  decodePrivateHandContinuation,
  encodePrivateHandContinuation,
} from './PrivateHandContinuation.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
const id = (n: number) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const held: any[] = [];
afterEach(async () => {
  for (const e of held.splice(0)) await e.stop();
  setMaintenanceFrozen(false);
  wire.onRetain = null;
  wire.calls.length = 0;
  wire.original = wire.packet = wire.parked = null;
});
it('keeps the exact retained hand and bank custody through native manager stop', async () => {
  const server: any = Object.assign(Object.create(GameServer.prototype), {
    running: true,
    teardownPromise: null,
    lifecycleGeneration: 1,
    tableEngines: new Map(),
    tournamentEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
  });
  const m: any = bindTournamentDataAuthorityMethods(
    { tournamentId: id(1), leaseGeneration: id(2) },
    new TournamentManager(id(1), server, id(2), performance.now() + 600000)
  );
  m.running = true;
  server.tournamentEngines.set(id(1), m);
  const e: any = m.createManagedTableEngine(id(4));
  held.push(e);
  const seats = [1, 2].map((seat) => ({
    seat_number: seat,
    user_id: 'fresh-' + seat,
    username: 'Player ' + seat,
    stack: 1000,
    occupancy_id: id(400 + seat),
    seat_id: id(40 + seat),
    seat_joined_at: '2026-10-29T00:00:00Z',
  }));
  e.tableInfo = {
    id: id(4),
    tournament_id: id(1),
    game_variant: 'nlh',
    small_blind: 10,
    big_blind: 20,
    ante: 0,
  };
  e.seatedPlayers = seats;
  e.handCount = 1000041;
  e.lastButtonSeat = 1;
  e.bombPotSchedPersistedJson = 'null';
  for (const seat of seats) {
    e.timeBankEngine.initializePlayer(e.tableId, seat.user_id, {
      remainingSeconds: 27,
      usesRemaining: 1,
    });
    e.timeBankMeta.set(seat.user_id, {
      initialSeconds: 40,
      baseSeconds: 40,
      dbConsumedSeconds: 13,
    });
    e.timeBankEngine.setAutoActivate(e.tableId, seat.user_id, false);
  }
  const binding = {
    tournament_id: id(1),
    table_id: id(4),
    hand_number: '1000042',
    permit_id: id(14),
    lease_generation: id(2),
    lifecycle: '1',
    custody_id: id(24),
  };
  const permit = new F06HandPermit(
    binding,
    async (name) => {
      wire.calls.push(name);
      expect(name).toBe('fn_f06_begin_hand');
      return { data: { ok: true, state: 'reserved', ...binding, generation: id(2) }, error: null };
    },
    () => e.running && e.isCurrentEngine()
  );
  e.installF06Allocator(
    'fresh-original',
    async () => 1000042,
    () => e.isCurrentEngine(),
    '1'
  );
  e.installF06HandAdmission(() => permit);
  expect(e.claimProcessOwnership()).toBe(true);
  e.running = true;
  m.tableEngines.set(e.tableId, e);
  server.tableEngines.set(e.tableId, e);
  server.tournamentOwnedTables.add(e.tableId);
  wire.decode = decodePrivateHandContinuation;
  // Pause arrives during the actual retention acknowledgement, as in the
  // production race. No dealer/controller/stop method is replaced.
  wire.onRetain = () => e.pauseAfterHand(300000, { beforeNextHand: true, untilResumed: true });
  setMaintenanceFrozen(false);
  e.dealingLoopPromise = e.dealHand(seats);
  await vi.waitFor(() => expect(typeof e.handForHandResolve).toBe('function'));
  const original = wire.original,
    packet = wire.packet,
    controller = e.handController;
  const banks = e.captureParkedTimeBanks();
  expect(e.f06HandPreparation).not.toBeNull();
  expect(e.pendingOriginalContinuation).toBeNull();
  expect(e.retainedPreparedOriginalController).toBe(controller);
  expect(permit.recoveryState()).toBe('attempted');
  expect(JSON.parse(controller.serializeRecoveryState()).handStarted).toBe(false);
  expect(e.isPreparedOriginalParkedForSuccessor()).toBe(true);
  await m.stop().catch((error: any) => {
    throw error.errors?.[0] ?? error;
  });
  expect(e.handCount).toBe(1000042);
  expect(e.stoppedTimeBankCustody.handNumber).toBe(1000042);
  expect(e.stoppedTimeBankCustody.banks).toEqual(banks);
  expect(wire.parked.p_hand_number).toBe(1000042);
  expect(wire.parked.p_players).toEqual(banks);
  expect(e.f06HandPreparation).toBeNull();
  expect(e.f06CurrentPermit).toBe(permit);
  expect(permit.recoveryState()).toBe('attempted');
  expect(permit.binding).toEqual(binding);
  expect(encodePrivateHandContinuation(original)).toEqual(packet);
  expect(controller.serializeRecoveryState()).toBe(original.batch.controller);
  expect(wire.calls).toEqual([
    'fn_f06_begin_hand',
    'fn_f06_retain_hand_continuation',
    'fn_park_stopped_time_bank_custody',
  ]);
});
