import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A FRESH ADOPTION ASKS THE DOOR BEFORE IT HOLDS THE EVENT (2026-09-26).
 *
 * A process that adopts a RUNNING event whose table still carries a reserved
 * F06 hand permit of a dead generation has no drained packet and no durable
 * mixed transfer. The admission used to make it a custody-only recovery owner
 * anyway, waiting for a "strict recovery" that does not exist for it; the
 * abandoned-generation door that DOES own that hand runs inside resume(), which
 * the hold never reached. On engine 778075b4 that left 68 RUNNING events (114
 * tables) holding their lease with no dealer and no hand for over an hour.
 *
 * These run the real GameServer admission into the real TournamentManager
 * resume(): only the database is modelled.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  retained: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase/handHistory.js', async (original) => ({
  ...(await original<any>()),
  resumeRetainedHandSubmission: mocks.retained,
}));
vi.mock('../services/tournamentLease.js', async (original) => ({
  ...(await original<any>()),
  claimTournamentLease: mocks.claim,
  releaseTournaments: mocks.release,
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  reportWarning: vi.fn(),
  describeError: (error: unknown) => String(error),
}));

import { TournamentManager } from './TournamentManager.js';
import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import { f06RecoveryDispositionOwner } from './drainedF06Custody.js';
import { abandonedGenerationReceiptId } from './abandonedGenerationDoor.js';

const EVENT = 'b1000000-0000-4000-8000-000000000001';
const SUCCESSOR = 'b5000000-0000-4000-8000-000000000005';
const DEAD = 'b6000000-0000-4000-8000-000000000006';
const TABLE = 'b2000000-0000-4000-8000-00000000000a';

const managers: any[] = [];

function server(): any {
  const s = Object.create(GameServer.prototype);
  Object.assign(s, {
    running: true,
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    tournamentRetirementCustody: new TournamentRetirementCustody(),
    drainedF06TournamentCustody: new Map(),
    completedF06TournamentCustody: new Map(),
    tournamentManagerRetirementOperations: new WeakMap(),
    tournamentManagerLeaseReleaseOperations: new Map(),
    tournamentManagerPendingLeaseReleases: new Map(),
    tournamentManagerAdmissionLeaseGenerations: new Map(),
    tournamentManagerAdmissionRetryTimers: new Map(),
    discoveryJobs: new Set(),
    directAdmissionIsCurrent: () => true,
    clearTournamentManagerAdmissionRetry: vi.fn(),
    scheduleTournamentManagerAdmissionRetry: vi.fn(),
    finishTournamentManagerAdmission: vi.fn(),
  });
  return s;
}

/**
 * The event as production held it: RUNNING, one table, a reserved permit of a
 * generation that no longer holds the lease. When the door decides, the permit
 * closes and (to end the test at the door) the event reads as finished.
 */
function productionEvent(door: 'decides' | 'refuses' = 'decides') {
  const db = { reserved: DEAD as string | null, status: 'RUNNING' };
  const calls: string[] = [];
  const written: any = {
    eq: () => written,
    then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }),
  };
  mocks.from.mockImplementation((name: string) => ({
    update: () => {
      calls.push(`write:${name}`);
      return written;
    },
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          calls.push(`read:${name}`);
          return {
            data: {
              id: EVENT,
              format_contract: 'mtt-v1',
              club_id: 'club',
              status: db.status,
              blind_structure: [{ smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 }],
              current_level: 7,
              level_started_at: new Date(Date.now() - 60_000).toISOString(),
              prize_pool_finalized: true,
              on_break: false,
            },
            error: null,
          };
        },
        in: async () => {
          calls.push(`read:${name}`);
          return {
            data: [{ id: TABLE, small_blind: 25, big_blind: 50, ante: 0, stakes: '25/50' }],
            error: null,
          };
        },
      }),
    }),
  }));
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
    calls.push(name);
    if (name === 'fn_f06_find_mixed_manager_custody')
      return { error: null, data: { ok: true, tournament_id: EVENT, receipt: null } };
    if (name === 'fn_f06_assert_drained_manager_custody') {
      const pending = db.reserved ? [TABLE] : [];
      return {
        error: null,
        data: {
          ok: true,
          tournament_id: EVENT,
          lease_generation: args.p_lease_generation,
          recovery_required: pending.length > 0,
          pending_tables: pending,
          proof: { parks: [], originals: [] },
          terminal_proof: [],
        },
      };
    }
    if (name === 'fn_f06_hand_number_state')
      return {
        error: null,
        data: db.reserved
          ? {
              ok: true,
              table_id: TABLE,
              lifecycle: '1',
              used_hand_number_max: '42',
              next_hand_number_candidate: null,
              can_reserve: false,
              blocked_reason: 'hand_permit_unresolved',
              unresolved_permit: {
                permit_id: 'b9000000-0000-4000-8000-000000000009',
                tournament_id: EVENT,
                table_id: TABLE,
                lifecycle: '1',
                hand_number: '42',
                custody_id: 'b8000000-0000-4000-8000-000000000008',
                generation: db.reserved,
                state: 'reserved',
              },
            }
          : {
              ok: true,
              table_id: TABLE,
              lifecycle: '1',
              used_hand_number_max: '42',
              next_hand_number_candidate: '43',
              can_reserve: true,
              blocked_reason: null,
              unresolved_permit: null,
            },
      };
    if (name === 'fn_f06_abort_abandoned_generation') {
      if (door === 'refuses')
        return { data: null, error: { message: 'F06_ABANDONED_ROSTER_CHANGED', code: '55000' } };
      db.reserved = null;
      db.status = 'COMPLETED';
      return {
        error: null,
        data: {
          ok: true,
          outcome: 'aborted_unsettled',
          receipt_id: args.p_receipt_id,
          tournament_id: args.p_tournament_id,
          generation: args.p_generation,
          hands_aborted: 1,
          never_started: 0,
          credit: 0,
        },
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return { db, calls };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.from.mockReset();
  mocks.retained.mockReset().mockResolvedValue(null);
  mocks.claim.mockReset().mockResolvedValue({
    status: 'granted',
    leaseGeneration: SUCCESSOR,
    proofDeadlineMonotonicMs: performance.now() + 60_000,
  });
  mocks.release.mockReset().mockResolvedValue({ status: 'confirmed', attempts: 1 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const proto = TournamentManager.prototype as any;
  vi.spyOn(proto, 'readTournamentClub').mockResolvedValue(undefined);
  vi.spyOn(proto, 'loadMultiDayPlan').mockImplementation(async function (this: any) {
    this.multiDayPlan = { kind: 'none' };
  });
});
afterEach(() => {
  for (const m of managers.splice(0)) m.fenceForTournamentLeaseLoss?.();
  vi.restoreAllMocks();
});

describe('a fresh adoption with a dead generation’s reserved hand', () => {
  it('reaches resume() and asks the abandoned-generation door before any dealer is built', async () => {
    const f = productionEvent('decides');
    const dealer = vi.spyOn(TournamentManager.prototype as any, 'startManagedTableEngine');
    const s = server();

    await s.performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 1);
    const m = s.tournamentEngines.get(EVENT);
    managers.push(m);

    // Not a custody-only owner waiting for a strict recovery that cannot come.
    expect(m.isF06RecoveryOwner()).toBe(false);
    // The retained original submission was still finished first.
    expect(mocks.retained).toHaveBeenCalledWith(TABLE, expect.any(String), SUCCESSOR);
    const doors = mocks.rpc.mock.calls.filter(([n]) => n === 'fn_f06_abort_abandoned_generation');
    expect(doors).toHaveLength(1);
    expect(doors[0][1]).toMatchObject({
      p_tournament_id: EVENT,
      p_generation: DEAD,
      p_receipt_id: abandonedGenerationReceiptId(EVENT, DEAD),
      p_release_current_lease: false,
    });
    // Order: custody read, then the event and its tables, then the door; no
    // dealer before (or, here, after - the event read again as finished).
    const door = f.calls.indexOf('fn_f06_abort_abandoned_generation');
    expect(f.calls.indexOf('fn_f06_assert_drained_manager_custody')).toBeLessThan(door);
    expect(f.calls.indexOf('fn_f06_hand_number_state')).toBeLessThan(door);
    expect(f.calls.lastIndexOf('read:tournaments')).toBeGreaterThan(door);
    expect(dealer).not.toHaveBeenCalled();
    expect(f.db.reserved).toBeNull();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(s.finishTournamentManagerAdmission).toHaveBeenCalledOnce();
  });

  it('a door that refuses by rule leaves the hand reserved, and was still asked before any dealer', async () => {
    const f = productionEvent('refuses');
    const order: string[] = [];
    // Stop the lifecycle at the first dealer it would build: what this proves
    // is the order, and that a refused hand is not touched. The table's own
    // admission (and the database) keep refusing a new hand on it.
    vi.spyOn(TournamentManager.prototype as any, 'createManagedTableEngine').mockImplementation(
      () => {
        order.push(
          f.calls.includes('fn_f06_abort_abandoned_generation')
            ? 'dealer-after-door'
            : 'dealer-before-door'
        );
        throw new Error('stop at the first dealer');
      }
    );
    const s = server();
    s.stopTournamentManagerIfOwned = vi.fn().mockResolvedValue(true);
    // resume() reports a lifecycle failure itself; this test is about order.
    await s
      .performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 1)
      .catch(() => undefined);
    const m = s.tournamentEngines.get(EVENT);
    if (m) managers.push(m);
    expect(m?.isF06RecoveryOwner?.() ?? false).toBe(false);
    expect(f.calls.filter((n) => n === 'fn_f06_abort_abandoned_generation')).toHaveLength(1);
    expect(order).toEqual(['dealer-after-door']);
    expect(f.db.reserved).toBe(DEAD);
  });
});

describe('nothing is admitted without a disposition owner', () => {
  const modes = ['start', 'resume', 'stage_resume'] as const;
  it.each(modes)('%s with nothing reserved needs no owner', (mode) => {
    for (const hasDrainedPacket of [false, true])
      for (const hasMixedTransfer of [false, true])
        expect(
          f06RecoveryDispositionOwner({
            recoveryRequired: false,
            hasDrainedPacket,
            hasMixedTransfer,
            mode,
          })
        ).toBe('none_required');
  });
  it.each(modes)('%s with a mixed transfer keeps strict mixed recovery', (mode) => {
    for (const hasDrainedPacket of [false, true])
      expect(
        f06RecoveryDispositionOwner({
          recoveryRequired: true,
          hasDrainedPacket,
          hasMixedTransfer: true,
          mode,
        })
      ).toBe('mixed_transfer');
  });
  it.each(modes)('%s with a drained packet keeps its original engines as owner', (mode) => {
    expect(
      f06RecoveryDispositionOwner({
        recoveryRequired: true,
        hasDrainedPacket: true,
        hasMixedTransfer: false,
        mode,
      })
    ).toBe('drained_originals');
  });
  it('only a resume, which asks the door before any dealer, may own a hand with no custody', () => {
    expect(
      f06RecoveryDispositionOwner({
        recoveryRequired: true,
        hasDrainedPacket: false,
        hasMixedTransfer: false,
        mode: 'resume',
      })
    ).toBe('abandoned_generation_door');
    for (const mode of ['start', 'stage_resume'] as const)
      expect(
        f06RecoveryDispositionOwner({
          recoveryRequired: true,
          hasDrainedPacket: false,
          hasMixedTransfer: false,
          mode,
        })
      ).toBe('no_owner');
  });
});
