/**
 * A RENEWAL PASS THAT NEVER SETTLES MUST NOT POISON EVERY LATER PASS.
 *
 * This is the behaviour, not the source text. `renewOwnedEngineLeaseProofs`
 * serialises on `ownershipLeaseRenewalOperation` and hands the in-flight
 * promise to any later caller, which is right while a pass finishes. On
 * 2026-09-12 one did not finish, and every later tick awaited that same hung
 * promise: `heartbeat_table_leases_v4` did not move for hours while
 * `claim_table_lease_v2` ran at 233 a minute, every one of the 78 cash tables
 * dying on its twenty second proof and being re-claimed, three quarters of
 * those engine lives dealing no hands.
 *
 * The test that would have caught it is this one: hang a pass, and check that
 * the NEXT tick still gets to run.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

type Renewer = {
  ownershipLeaseRenewalOperation: Promise<void> | null;
  ownershipLeaseRenewalCompletedAtMs: number;
  performOwnedEngineLeaseProofRenewal: () => Promise<void>;
  renewOwnedEngineLeaseProofs: () => Promise<void>;
};

async function buildRenewer(pass: () => Promise<void>): Promise<Renewer> {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  const { GameServer } = await import('./GameServer.js');
  return Object.assign(Object.create(GameServer.prototype), {
    ownershipLeaseRenewalOperation: null,
    ownershipLeaseRenewalCompletedAtMs: Date.now(),
    performOwnedEngineLeaseProofRenewal: pass,
  }) as Renewer;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a wedged lease renewal pass does not stop every later pass', () => {
  it('serialises while a pass is genuinely in flight', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    let started = 0;
    const server = await buildRenewer(() => {
      started += 1;
      return inFlight;
    });

    const first = server.renewOwnedEngineLeaseProofs();
    const second = server.renewOwnedEngineLeaseProofs();

    expect(started, 'a second caller must not start a second pass').toBe(1);
    expect(second).toBe(first);

    release();
    await first;
    expect(server.ownershipLeaseRenewalOperation).toBeNull();
  });

  it('releases the slot when a pass never settles, so the next tick runs', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let started = 0;
    const server = await buildRenewer(() => {
      started += 1;
      return new Promise<void>(() => {
        /* never settles - this is the whole bug */
      });
    });

    void server.renewOwnedEngineLeaseProofs();
    expect(started).toBe(1);
    expect(server.ownershipLeaseRenewalOperation).not.toBeNull();

    // Still inside the proof window: the slot is correctly still held.
    await vi.advanceTimersByTimeAsync(19_000);
    void server.renewOwnedEngineLeaseProofs();
    expect(started, 'must not start a second pass inside the window').toBe(1);

    // Past the window the answer could not renew anything anyway, so the slot
    // is released rather than held for the life of the process.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      server.ownershipLeaseRenewalOperation,
      'a pass that outlived the proof window must not still own the slot'
    ).toBeNull();

    void server.renewOwnedEngineLeaseProofs();
    expect(started, 'the next tick must get a fresh pass').toBe(2);
  });

  it('a late pass cannot clear the slot its successor now owns', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: () => void;
    let started = 0;
    const server = await buildRenewer(() => {
      started += 1;
      if (started === 1) return new Promise<void>((r) => (release = r));
      return new Promise<void>(() => {});
    });

    void server.renewOwnedEngineLeaseProofs();
    await vi.advanceTimersByTimeAsync(21_000); // first pass abandoned
    void server.renewOwnedEngineLeaseProofs(); // successor takes the slot
    expect(started).toBe(2);
    const successor = server.ownershipLeaseRenewalOperation;
    expect(successor).not.toBeNull();

    release(); // the abandoned pass finally lands
    await vi.advanceTimersByTimeAsync(0);

    expect(
      server.ownershipLeaseRenewalOperation,
      'the abandoned pass settling must not evict its successor'
    ).toBe(successor);
  });
});
