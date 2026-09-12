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

type LoopRunner = Renewer & {
  runOwnershipLeaseRenewalLoop: (generation: number) => Promise<void>;
};

/**
 * The loop needs two more collaborators than a single pass does: the admission
 * check that ends it, and `sleep`, which is real so the fake clock drives it.
 */
async function buildLoopRunner(
  pass: () => Promise<void>,
  isCurrent: () => boolean
): Promise<LoopRunner> {
  const server = (await buildRenewer(pass)) as LoopRunner;
  return Object.assign(server, {
    directAdmissionIsCurrent: () => isCurrent(),
  }) as LoopRunner;
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

/**
 * AND THE LOOP ITSELF HAS TO BE RELEASED, NOT JUST THE SLOT.
 *
 * The abandon timer above frees `ownershipLeaseRenewalOperation` so a new pass
 * CAN start. This loop is the only thing that ever starts one, and it was
 * still awaiting the promise that timer had just given up on, so the slot
 * opened and nobody walked through it.
 *
 * Measured on production 2026-09-12, on the release carrying the abandon
 * timer:
 *
 *     10:30  passes_total{abandoned} 0 -> 1
 *     10:30  passes_total{completed} frozen at 374
 *     10:31  cash_lease_proof_expired resumes at ~113 a minute
 *     10:45  still frozen at 374; only a restart cleared it
 *
 * `loop_running` read 1 throughout and `threw` stayed 0, so the loop was alive
 * and had simply stopped iterating on one await that never returned. No second
 * pass was ever abandoned either, which is the proof that none was started.
 */
describe('the loop does not wait for a pass that was already abandoned', () => {
  it('starts the next pass after the abandon deadline, even though the first never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    let started = 0;
    let live = true;
    const server = await buildLoopRunner(
      () => {
        started += 1;
        // EVERY pass hangs. The loop must still keep starting them.
        return new Promise<void>(() => {});
      },
      () => live
    );

    const loop = server.runOwnershipLeaseRenewalLoop(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started, 'the first pass runs immediately').toBe(1);

    // Inside the abandon deadline the loop is right to still be waiting.
    await vi.advanceTimersByTimeAsync(19_000);
    expect(started, 'must not start a second pass inside the proof window').toBe(1);

    // Past abandon + one cadence, the loop must have moved on.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      started,
      'the loop stayed awaiting a pass the abandon timer had already given up on'
    ).toBeGreaterThan(1);

    live = false;
    await vi.advanceTimersByTimeAsync(60_000);
    /* Bounded on purpose. Without the fix the loop is still stuck on its very
       first pass and never re-reads the admission check, so awaiting it here
       would turn the clear assertion failure above into a file-level timeout
       and hide which pin actually broke. */
    await Promise.race([loop, vi.advanceTimersByTimeAsync(1)]);
  });

  it('still runs back-to-back at the ordinary cadence when passes settle', async () => {
    vi.useFakeTimers();
    let started = 0;
    let live = true;
    const server = await buildLoopRunner(
      () => {
        started += 1;
        return Promise.resolve();
      },
      () => live
    );

    const loop = server.runOwnershipLeaseRenewalLoop(1);
    await vi.advanceTimersByTimeAsync(21_000);
    // A healthy pass must not be paced by the abandon deadline: at a 5s cadence
    // twenty-one seconds is four or five passes, never one.
    expect(started).toBeGreaterThan(3);

    live = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await loop;
  });
});
