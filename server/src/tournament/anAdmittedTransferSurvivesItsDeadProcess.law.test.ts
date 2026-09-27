import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN ADMITTED TRANSFER SURVIVES ITS DEAD PROCESS (2026-09-27).
 *
 * The 2026-09-26 09:33 UTC lease collapse left 45 RUNNING events whose mixed
 * custody transfer had been ADMITTED (09:34, engine cd5892e8, instance
 * 1-2fe24354) and never completed; that process died at ~13:55. Every later
 * engine asked for the transfer's successor generation - the generation the
 * dead lease still holds - and claim_tournament_lease_v2 takes a stale lease
 * only for a DIFFERENT generation, so it answered owned_elsewhere and the
 * engine stood down, for 31 hours (/health tournamentLease.conflictCount 44).
 *
 * The next owner now claims a FRESH generation and readmits through
 * fn_f06_readmit_mixed_manager_custody. It never reuses the origin, the
 * successor or the admitted holder's generation: every fence is the
 * generation, so a shared one is a shared fence.
 *
 * These run the real GameServer admission; only the database is modelled,
 * with the claim rule production enforces.
 * docs/changelog/2026-09-27-an-admitted-transfer-survives-its-dead-process.md
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  maintenanceSupabase: {},
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

import { GameServer } from '../GameServer.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';
import {
  admitMixedF06Transfer,
  findMixedF06Transfer,
  mixedF06RequestedGeneration,
  type MixedF06Transfer,
} from './mixedF06Custody.js';

const EVENT = 'c1000000-0000-4000-8000-000000000001';
const TRANSFER = 'c2000000-0000-4000-8000-000000000002';
const ORIGIN = 'c3000000-0000-4000-8000-000000000003';
const SUCCESSOR = 'c4000000-0000-4000-8000-000000000004';
const TABLE = 'c5000000-0000-4000-8000-000000000005';

const receipt = {
  transfer_id: TRANSFER,
  tournament_id: EVENT,
  origin_generation: ORIGIN,
  successor_generation: SUCCESSOR,
  local_proof: { engines: [], reservations: [] },
  canonical_proof: { tables: [{ id: TABLE }], pending_original_tables: [], operations: [] },
  created_at: '2026-09-26T09:34:16.000Z',
};

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
 * The lease row as production holds it: the admitted successor generation,
 * last heartbeat 26 hours ago, a dead instance. claim_tournament_lease_v2
 * grants a stale row only to a DIFFERENT generation.
 */
function production(admission: { generation: string; live: boolean } | null | 'absent') {
  const held = {
    generation: SUCCESSOR as string,
    stale: admission !== null && admission !== 'absent' && !admission.live,
  };
  mocks.claim.mockImplementation(async (_t: string, requested: string) => {
    if (requested === held.generation && held.stale)
      return {
        status: 'owned_elsewhere',
        conflict: { tournamentId: EVENT, holder: '1-2fe24354', holderAgeSeconds: 95918, at: 0 },
      };
    if (
      admission !== null &&
      admission !== 'absent' &&
      admission.live &&
      requested !== held.generation
    )
      return {
        status: 'owned_elsewhere',
        conflict: { tournamentId: EVENT, holder: '1-live0000', holderAgeSeconds: 2, at: 0 },
      };
    return {
      status: 'granted',
      leaseGeneration: requested,
      proofDeadlineMonotonicMs: performance.now() + 60_000,
    };
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_f06_find_mixed_manager_custody')
      return {
        error: null,
        data:
          admission === 'absent'
            ? { ok: true, tournament_id: EVENT, receipt }
            : { ok: true, tournament_id: EVENT, receipt, admission },
      };
    if (
      name === 'fn_f06_admit_mixed_manager_custody' ||
      name === 'fn_f06_readmit_mixed_manager_custody'
    )
      // End the admission at the door: what is proved is which door, and with
      // which generation. A refused admission releases what it claimed.
      return { data: null, error: { message: 'STOP_AT_THE_DOOR', code: 'P0001' } };
    throw new Error(`unexpected rpc ${name}`);
  });
}

const claimed = () => mocks.claim.mock.calls.map(([, g]) => g as string);
const doors = () =>
  mocks.rpc.mock.calls
    .filter(([n]) => String(n).includes('mit_mixed_manager_custody'))
    .map(([n, a]) => [n as string, a.p_lease_generation as string]);

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.from.mockReset();
  mocks.claim.mockReset();
  mocks.release.mockReset().mockResolvedValue({ status: 'confirmed', attempts: 1 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('an admitted transfer whose process died', () => {
  it('is readmitted under a fresh generation, never the dead holder’s (the 45 events of 2026-09-26)', async () => {
    production({ generation: SUCCESSOR, live: false });
    const s = server();
    await s
      .performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 1)
      .catch(() => undefined);

    expect(claimed()).toHaveLength(1);
    const fresh = claimed()[0];
    expect([ORIGIN, SUCCESSOR]).not.toContain(fresh);
    expect(doors()).toEqual([['fn_f06_readmit_mixed_manager_custody', fresh]]);
    // The door refused here, so the claimed generation is returned.
    expect(mocks.release).toHaveBeenCalled();
  });

  it('a live admitted holder is not taken over: the successor is asked for and the admit door is used', async () => {
    production({ generation: SUCCESSOR, live: true });
    const s = server();
    await s
      .performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 1)
      .catch(() => undefined);
    expect(claimed()).toEqual([SUCCESSOR]);
    expect(doors()).toEqual([['fn_f06_admit_mixed_manager_custody', SUCCESSOR]]);
  });

  it('a transfer nobody admitted is admitted by its successor alone', async () => {
    production(null);
    const s = server();
    await s
      .performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 1)
      .catch(() => undefined);
    expect(claimed()).toEqual([SUCCESSOR]);
    expect(doors()).toEqual([['fn_f06_admit_mixed_manager_custody', SUCCESSOR]]);
  });

  it('a database without the readmission door reads as before (no admission key)', async () => {
    production('absent');
    const s = server();
    await s
      .performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 1)
      .catch(() => undefined);
    expect(claimed()).toEqual([SUCCESSOR]);
    expect(doors()).toEqual([['fn_f06_admit_mixed_manager_custody', SUCCESSOR]]);
  });

  it('a holder that dies after the first read is re-read on the next attempt, not remembered alive', async () => {
    production({ generation: SUCCESSOR, live: true });
    const s = server();
    await s
      .performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 1)
      .catch(() => undefined);
    expect(claimed()).toEqual([SUCCESSOR]);
    mocks.claim.mockReset();
    mocks.rpc.mockReset();
    production({ generation: SUCCESSOR, live: false });
    await s
      .performTournamentManagerAdmission(EVENT, 'resume', 'Resuming tournament', 2)
      .catch(() => undefined);
    const fresh = claimed()[0];
    expect([ORIGIN, SUCCESSOR]).not.toContain(fresh);
    expect(doors()).toEqual([['fn_f06_readmit_mixed_manager_custody', fresh]]);
  });
});

describe('the generation a readmission asks for', () => {
  const dead: MixedF06Transfer = Object.freeze({
    transferId: TRANSFER,
    successorGeneration: SUCCESSOR,
    local: {},
    canonical: {},
    receipt,
    admittedGeneration: 'c6000000-0000-4000-8000-000000000006',
    readmit: true,
  });

  it('is never the origin, the successor or the admitted holder, even when retained', () => {
    for (const retained of [ORIGIN, SUCCESSOR, dead.admittedGeneration!]) {
      const g = mixedF06RequestedGeneration(
        dead,
        retained,
        () => 'c7000000-0000-4000-8000-000000000007'
      );
      expect(g).toBe('c7000000-0000-4000-8000-000000000007');
    }
    expect(() => mixedF06RequestedGeneration(dead, undefined, () => SUCCESSOR)).toThrow(
      'f06_mixed_readmission_generation_reused'
    );
  });

  it('keeps an exact retained fresh generation (an uncertain claim is retried with it)', () => {
    const retained = 'c8000000-0000-4000-8000-000000000008';
    expect(mixedF06RequestedGeneration(dead, retained, () => 'unused')).toBe(retained);
  });

  it('is the successor for every transfer that is not being readmitted', () => {
    const own: MixedF06Transfer = { ...dead, readmit: false };
    expect(
      mixedF06RequestedGeneration(own, 'c8000000-0000-4000-8000-000000000008', () => 'x')
    ).toBe(SUCCESSOR);
  });
});

describe('the admission doors refuse the wrong generation before the database is asked', () => {
  it('a readmission with the successor or the admitted generation, and an admission with a fresh one', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'not reached' } });
    const dead: MixedF06Transfer = {
      transferId: TRANSFER,
      successorGeneration: SUCCESSOR,
      local: { engines: [] },
      canonical: {},
      receipt,
      admittedGeneration: SUCCESSOR,
      readmit: true,
    };
    await expect(admitMixedF06Transfer(EVENT, SUCCESSOR, dead)).rejects.toThrow(
      'f06_mixed_readmission_generation_reused'
    );
    await expect(admitMixedF06Transfer(EVENT, ORIGIN, dead)).rejects.toThrow(
      'f06_mixed_readmission_generation_reused'
    );
    await expect(
      admitMixedF06Transfer(EVENT, 'c9000000-0000-4000-8000-000000000009', {
        ...dead,
        readmit: false,
      })
    ).rejects.toThrow('f06_mixed_successor_generation_changed');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('a readmission answer that does not say readmitted, from a named prior generation, is unproven', async () => {
    const fresh = 'c9000000-0000-4000-8000-000000000009';
    const dead: MixedF06Transfer = {
      transferId: TRANSFER,
      successorGeneration: SUCCESSOR,
      local: { engines: [] },
      canonical: {},
      receipt,
      admittedGeneration: SUCCESSOR,
      readmit: true,
    };
    const answer = (extra: Record<string, unknown>) => ({
      error: null,
      data: {
        ok: true,
        custody_only: true,
        transfer_id: TRANSFER,
        tournament_id: EVENT,
        lease_generation: fresh,
        receipt,
        admission: {
          transfer_id: TRANSFER,
          generation: fresh,
          prior_generation: SUCCESSOR,
          terminal_proof: [],
        },
        ...extra,
      },
    });
    mocks.rpc.mockResolvedValueOnce(answer({}));
    await expect(admitMixedF06Transfer(EVENT, fresh, dead)).rejects.toThrow(
      'f06_mixed_successor_custody_unproven'
    );
    mocks.rpc.mockResolvedValueOnce(answer({ readmitted: true }));
    await expect(admitMixedF06Transfer(EVENT, fresh, dead)).resolves.toMatchObject({
      recoveryRequired: true,
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      'fn_f06_readmit_mixed_manager_custody',
      expect.objectContaining({ p_lease_generation: fresh, p_transfer_id: TRANSFER })
    );
  });
});

describe('discovery reads who holds the admitted custody', () => {
  it('readmits only when the holder is named and not live; a malformed answer is unproven', async () => {
    const answer = (admission: unknown) =>
      mocks.rpc.mockResolvedValueOnce({
        error: null,
        data: { ok: true, tournament_id: EVENT, receipt, admission },
      });
    answer({ generation: SUCCESSOR, live: false });
    expect(await findMixedF06Transfer(EVENT)).toMatchObject({
      readmit: true,
      admittedGeneration: SUCCESSOR,
    });
    answer({ generation: SUCCESSOR, live: true });
    expect(await findMixedF06Transfer(EVENT)).toMatchObject({ readmit: false });
    answer(null);
    expect(await findMixedF06Transfer(EVENT)).toMatchObject({
      readmit: false,
      admittedGeneration: null,
    });
    answer({ generation: SUCCESSOR, live: 'no' });
    await expect(findMixedF06Transfer(EVENT)).rejects.toThrow(
      'f06_mixed_transfer_discovery_unproven'
    );
    answer({ generation: 'not-a-uuid', live: false });
    await expect(findMixedF06Transfer(EVENT)).rejects.toThrow(
      'f06_mixed_transfer_discovery_unproven'
    );
  });
});
