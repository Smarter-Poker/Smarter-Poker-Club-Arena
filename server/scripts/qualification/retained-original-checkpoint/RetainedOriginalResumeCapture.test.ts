import { afterEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../services/supabase/client.js', () => {
  const query = () => {
    const q: any = new Proxy(
      {},
      { get: (_, k) => (k === 'then' ? (r: any) => r({ data: [], error: null }) : () => q) }
    );
    return q;
  };
  return {
    supabase: {
      from: (n: string) => {
        io.calls.push(n);
        return query();
      },
      rpc: (n: string) => {
        io.calls.push('rpc:' + n);
        throw Error('Unexpected RPC');
      },
    },
    maintenanceSupabase: {},
  };
});
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { F06HandPermit } from '../services/F06HandPermit.js';
import {
  encodePrivateHandContinuation,
  decodePrivateHandContinuation,
} from './PrivateHandContinuation.js';
const held: any[] = [];
afterEach(async () => {
  for (const e of held.splice(0)) {
    await e.stop();
    e.preciseTimer.dispose();
    e.engineTelemetry.dispose();
  }
  io.calls.length = 0;
});
it('actual EED resume restores exact original capture before its physical pause gate', async () => {
  const tableId = 'c0ffee00-0000-4000-8000-000000000871',
    tournamentId = 'c0ffee00-0000-4000-8000-000000000872';
  const seats = [1, 2].map((seat) => ({
    seat,
    user_id: 'resume-user-' + seat,
    username: 'Player ' + seat,
    stack: 1000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    seat_number: seat,
    seat_id: `c0ffee00-0000-4000-8000-00000000088${seat}`,
    occupancy_id: `c0ffee00-0000-4000-8000-00000000089${seat}`,
    seat_joined_at: '2026-10-29T00:00:00Z',
  }));
  // Producer-side fixture creates durable bytes; the receiving engine starts empty.
  const donor: any = new ServerTableEngine(tableId);
  held.push(donor);
  const hc = new HandController(
    {
      tableId,
      handNumber: 42,
      gameVariant: 'nlh',
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
      isTournament: true,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    seats,
    1
  );
  hc.start();
  donor.handController = hc;
  donor.currentHandDealerSeat = hc.getState().dealerSeat;
  donor.currentHandSeatGenerations = new Map(
    seats.map((s) => [s.user_id, { seat_id: s.seat_id, seat_joined_at: s.seat_joined_at }])
  );
  donor.currentHandDealtStacks = new Map(seats.map((s) => [s.user_id, s.stack]));
  for (const s of seats) {
    donor.timeBankEngine.initializePlayer(tableId, s.user_id, {
      remainingSeconds: 27 + s.seat,
      usesRemaining: 1,
    });
    donor.timeBankMeta.set(s.user_id, {
      initialSeconds: 40,
      baseSeconds: 40,
      dbConsumedSeconds: 12 - s.seat,
    });
  }
  const binding = {
    tournament_id: tournamentId,
    table_id: tableId,
    hand_number: '42',
    permit_id: 'c0ffee00-0000-4000-8000-000000000873',
    lease_generation: 'c0ffee00-0000-4000-8000-000000000874',
    lifecycle: '1',
    custody_id: 'c0ffee00-0000-4000-8000-000000000875',
  };
  const durable = encodePrivateHandContinuation({
    version: 1,
    original: binding,
    seats: seats.map((s) => ({
      user_id: s.user_id,
      seat_id: s.seat_id,
      seat_joined_at: s.seat_joined_at,
      stack_before: s.stack,
    })),
    batch: {
      version: 1,
      sequence: 3,
      controller: hc.serializeRecoveryState(),
      events: [],
      engine: donor.captureContinuationEngine(),
    },
  });
  const original = decodePrivateHandContinuation(durable.payload, durable.sha256);
  const e: any = new ServerTableEngine(tableId);
  held.push(e);
  e.engineLeaseScope = 'tournament';
  e.engineLeaseTournamentId = tournamentId;
  e.tableInfo = {
    id: tableId,
    tournament_id: tournamentId,
    small_blind: 100,
    big_blind: 200,
    ante: 25,
  };
  e.seatedPlayers = seats;
  const permit = new F06HandPermit(
    binding,
    async () => {
      throw Error('Unexpected reservation');
    },
    () => e.isCurrentEngine(),
    () => false,
    binding.lease_generation
  );
  e.installOriginalHandContinuation(original, permit);
  expect(e.handController).toBeNull();
  expect(e.pendingOriginalContinuation).toBe(original);
  expect(e.captureContinuationEngine().timeBanks).toEqual([]);
  expect(e.captureContinuationEngine().timeBankMeta.size).toBe(0);
  expect(e.claimProcessOwnership()).toBe(true);
  e.running = true;
  e.pauseAfterHand(120000, { beforeNextHand: true, untilResumed: true });
  const resumed = e.resumeOriginalController();
  e.dealingLoopPromise = resumed;
  await vi.waitFor(() => expect(typeof e.handForHandResolve).toBe('function'));
  expect(e.pendingOriginalContinuation).toBe(original);
  expect(encodePrivateHandContinuation(original)).toEqual(durable);
  expect(e.handController.serializeRecoveryState()).toBe(original.batch.controller);
  expect(e.handContinuation).toBeNull(); // Lane creation and replay occur AFTER the gate.
  expect(e.handCount).toBe(42);
  expect([e.tableInfo.small_blind, e.tableInfo.big_blind, e.tableInfo.ante]).toEqual([10, 20, 0]);
  const captured = e.captureContinuationEngine();
  expect(captured.fields).toEqual(original.batch.engine.fields);
  expect(captured.timeBankMeta).toEqual(original.batch.engine.timeBankMeta);
  expect(captured.timeBankDebits).toEqual(original.batch.engine.timeBankDebits);
  expect(captured.timeBanks).toEqual(original.batch.engine.timeBanks);
  expect(e.timeBankAccountingPending.size).toBe(0);
  expect(e.timeBankAccountingUnconfirmed).toBe(false);
  expect(e.unresolvedTimeBankDebits.size).toBe(0);
  expect(e.running).toBe(true);
  expect(e.terminal).toBe(false);
  expect(io.calls.filter((n) => n.startsWith('rpc:'))).toEqual([]);
  // Use the real stop, controller, pause and resume methods throughout.
  await e.stop();
  await resumed;
  expect(e.pendingOriginalContinuation).toBe(original);
  expect(encodePrivateHandContinuation(original)).toEqual(durable);
  expect(e.terminalTeardownComplete).toBe(true);
  expect(e.handController).toBeNull();
  expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  expect(Object.keys(e.stoppedTimeBankCustody.banks)).toHaveLength(2);
});
