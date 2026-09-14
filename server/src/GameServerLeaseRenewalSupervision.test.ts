/**
 * THE LOOP THAT RENEWS EVERY LEASE IS RESTARTED WHEN IT DIES (2026-09-12).
 *
 * `runOwnershipLeaseRenewalLoop` is launched once per admission generation and
 * is the only thing in the process that renews a lease. On 2026-09-12 it
 * stopped: `heartbeat_table_leases_v4` sat at exactly 27,886 calls while
 * `claim_table_lease_v2` took 233 a minute, 73 of 76 live leases had
 * `heartbeat_at = acquired_at`, and every table in the fleet spent two hours
 * being killed by its own 20-second proof, re-claimed, and killed again -
 * 26,129 times, 1,483 hands abandoned mid-play, hand volume down 61%.
 *
 * `launchServerLifecycleJob` reports and forgets, so there was nothing to
 * restart it. These are the behaviours of the thing that does.
 *
 * The companion law pins the SHAPE in source
 * (`observability/theLoopThatRenewsEveryLeaseCannotStopSilently.law.test.ts`);
 * this runs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from './GameServer.js';
import {
  alwaysOnRegistry,
  leaseRenewalLoopRelaunchesTotal,
  leaseRenewalLoopRunning,
} from './observability/engineInstruments.js';
import * as errorReporter from './services/errorReporter.js';

/** One cadence: a quarter of the shorter conservative proof window. */
const CADENCE_MS = 5_000;

function bareServer(): any {
  const server = Object.create(GameServer.prototype) as any;
  server.running = true;
  server.lifecycleGeneration = 7;
  server.serverLifecycleJobs = new Set<Promise<void>>();
  server.discoveryJobs = new Set<Promise<void>>();
  server.ownershipLeaseRenewalOperation = null;
  return server;
}

/** The counter's current value, read the way Prometheus would. */
function relaunches(): number {
  for (const line of alwaysOnRegistry.renderPrometheus().split('\n')) {
    const m = /^poker_lease_renewal_loop_relaunches_total(?:\{[^}]*\})?\s+([0-9.e+-]+)/.exec(
      line.trim()
    );
    if (m) return Number(m[1]);
  }
  throw new Error('poker_lease_renewal_loop_relaunches_total publishes no series');
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the ownership lease renewal loop is supervised', () => {
  it('relaunches the loop and counts it when the loop throws on its first pass', async () => {
    const server = bareServer();
    const before = relaunches();
    let entries = 0;
    server.runOwnershipLeaseRenewalLoop = vi.fn(async () => {
      entries++;
      if (entries === 1) throw new Error('renewal loop died');
      // The successor behaves like the real one: it stays until the generation
      // moves on, so the supervisor is not spinning.
      await new Promise<void>(() => {});
    });

    const supervised = server.superviseOwnershipLeaseRenewal(7) as Promise<void>;
    await Promise.resolve();
    expect(entries).toBe(1);

    // Within ONE cadence a second loop is running, and the relaunch is a number.
    await vi.advanceTimersByTimeAsync(CADENCE_MS);
    expect(entries).toBe(2);
    expect(relaunches()).toBe(before + 1);
    // The gauge is back up: a supervised loop reads as running, because it is.
    expect(alwaysOnRegistry.renderPrometheus()).toMatch(
      /poker_lease_renewal_loop_running(?:\{[^}]*\})?\s+1/
    );

    // Tear the harness down without leaving the pending loop hanging on a timer.
    server.running = false;
    void supervised;
  });

  it('keeps relaunching for as long as the loop keeps dying', async () => {
    const server = bareServer();
    const before = relaunches();
    let entries = 0;
    server.runOwnershipLeaseRenewalLoop = vi.fn(async () => {
      entries++;
      throw new Error(`renewal loop died (${entries})`);
    });

    const supervised = server.superviseOwnershipLeaseRenewal(7) as Promise<void>;
    await vi.advanceTimersByTimeAsync(CADENCE_MS * 3);

    expect(entries).toBeGreaterThanOrEqual(4);
    expect(relaunches()).toBeGreaterThanOrEqual(before + 3);
    // ...and it is paced, not a hot spin: one entry per cadence, not thousands.
    expect(entries).toBeLessThanOrEqual(6);

    server.running = false;
    await vi.advanceTimersByTimeAsync(CADENCE_MS);
    await supervised;
  });

  it('survives a reportError that throws, which is how the loop died', async () => {
    /* `reportError` writes to stderr before anything else. On a saturated
       container pipe that write throws EPIPE, and it used to escape the
       function - so the catch handler written to keep the loop alive was the
       thing that killed it. errorReporter guards its own console write now;
       this proves the supervisor survives even if reporting fails outright. */
    const server = bareServer();
    const before = relaunches();
    vi.spyOn(errorReporter, 'reportError').mockImplementation(() => {
      throw new Error('EPIPE: broken pipe');
    });
    let entries = 0;
    server.runOwnershipLeaseRenewalLoop = vi.fn(async () => {
      entries++;
      if (entries <= 2) throw new Error('renewal loop died');
      await new Promise<void>(() => {});
    });

    const supervised = server.superviseOwnershipLeaseRenewal(7) as Promise<void>;
    await vi.advanceTimersByTimeAsync(CADENCE_MS * 2);

    expect(entries).toBe(3);
    expect(relaunches()).toBe(before + 2);

    server.running = false;
    void supervised;
  });

  it('stops for good when its admission generation moves on', async () => {
    const server = bareServer();
    const before = relaunches();
    let entries = 0;
    server.runOwnershipLeaseRenewalLoop = vi.fn(async () => {
      entries++;
      // The real loop's clean exit: its generation is no longer current.
      server.lifecycleGeneration = 8;
    });

    await server.superviseOwnershipLeaseRenewal(7);

    expect(entries).toBe(1);
    // A clean exit is not a fault, so it is not counted and not relaunched.
    expect(relaunches()).toBe(before);
    /* The 0 on the way out belongs to the LOOP's own finally, not to the
       supervisor - the loop is stubbed here, so this test cannot speak for it.
       That half is pinned in
       theLoopThatRenewsEveryLeaseCannotStopSilently.law.test.ts, which requires
       the literal `} finally { leaseRenewalLoopRunning.set(0);`. */
  });

  it('does not relaunch after the server stops, even if the loop threw', async () => {
    const server = bareServer();
    const before = relaunches();
    let entries = 0;
    server.runOwnershipLeaseRenewalLoop = vi.fn(async () => {
      entries++;
      server.running = false;
      throw new Error('renewal loop died during shutdown');
    });

    await server.superviseOwnershipLeaseRenewal(7);

    expect(entries).toBe(1);
    expect(relaunches()).toBe(before);
  });
});

describe('the relaunch counter is publishable before anything has gone wrong', () => {
  it('renders a zero-seeded series on a cold engine', () => {
    expect(leaseRenewalLoopRelaunchesTotal).toBeDefined();
    expect(leaseRenewalLoopRunning).toBeDefined();
    expect(alwaysOnRegistry.renderPrometheus()).toContain(
      'poker_lease_renewal_loop_relaunches_total'
    );
  });
});
