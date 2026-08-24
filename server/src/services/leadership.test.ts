import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * ONE LEADER, AND NEVER ZERO.
 *
 * Leadership gates whether ANY table deals, so the tests that matter most are
 * the fail-open ones. A database blip must never leave the fleet with nobody
 * running it -- and being wrong in that direction lands on today's behaviour,
 * one instance doing everything, which is survivable. Being wrong the other way
 * stops the platform.
 *
 * The second-most-important case is losing leadership while holding it. That
 * can only happen if our own heartbeat lapsed past the staleness window, i.e.
 * this process was wedged long enough for another instance to take over. Two
 * engines both believing they lead is the one outcome worse than a restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('./tableLease.js', () => ({ INSTANCE_ID: 'me', INSTANCE_VERSION: 'v1' }));
vi.mock('./errorReporter.js', () => ({ reportError: () => {} }));

const granted = { data: [{ granted: true, holder: 'me', holder_age_seconds: 0 }], error: null };
const refused = {
  data: [{ granted: false, holder: 'other', holder_age_seconds: 3 }],
  error: null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => exitSpy.mockRestore());

const load = async () => await import('./leadership.js');

describe('a standby must NOT promote itself when it cannot reach the database', () => {
  /**
   * "Always fail to leader" is wrong, and dangerously so, because claimTable()
   * fails open too:
   *
   *   outage -> standby cannot reach the RPC -> promotes itself
   *          -> claimTable() also answers true -> TWO engines on one table.
   *
   * That is the corruption the leases exist to prevent, manufactured on every
   * outage. Live evidence it is not hypothetical: with the engine up 48
   * minutes, engine_table_leases had ZERO rows heartbeated in the last 45
   * seconds -- the lease RPCs were timing out while the engine ran perfectly.
   */
  it('holds standby through an RPC error', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership, isLeader } = await load();
    expect(await renewLeadership()).toBe('standby');

    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    expect(await renewLeadership()).toBe('standby');
    expect(isLeader()).toBe(false);
  });

  it('holds standby through a thrown RPC', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership } = await load();
    await renewLeadership();
    rpc.mockRejectedValue(new Error('ETIMEDOUT'));
    expect(await renewLeadership()).toBe('standby');
  });

  it('does not exit when it merely cannot ask — it was never the leader', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership } = await load();
    await renewLeadership();
    rpc.mockRejectedValue(new Error('down'));
    await renewLeadership();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('an incumbent leader keeps leading when it cannot reach the database', () => {
  /**
   * These four cases used to assert that a process which has NEVER been
   * granted anything leads anyway, because the boot default was 'leader'.
   *
   * That is not a fail-open, it is an assumption, and on 2026-08-23 it cost
   * hours of production: two containers served engine.smarter.poker at once,
   * BOTH reporting leadership.role='leader', with the fleet split 14 tables to
   * 10 — the exact 404 / close-4404 state the Caddyfile exists to prevent. The
   * second container booted while the database was saturated, so its first
   * claim did not resolve for a long time, and for all of that time it
   * answered /health with 200 and Caddy routed players to it.
   *
   * The fail-open these tests are really about is worth keeping and is kept:
   * an instance that HAS been granted leadership holds it through a blip. What
   * changes is where the process starts. The asymmetry is the point — an
   * incumbent retains, a newcomer does not assume.
   */
  const becomeLeader = async () => {
    rpc.mockResolvedValue(granted);
    const mod = await load();
    expect(await mod.renewLeadership()).toBe('leader');
    return mod;
  };

  it('leads when the RPC errors', async () => {
    const { renewLeadership, isLeader } = await becomeLeader();
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    await expect(renewLeadership()).resolves.toBe('leader');
    expect(isLeader()).toBe(true);
  });

  it('leads when the RPC throws', async () => {
    const { renewLeadership } = await becomeLeader();
    rpc.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(renewLeadership()).resolves.toBe('leader');
  });

  it('leads when the RPC returns nothing usable', async () => {
    const { renewLeadership } = await becomeLeader();
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(renewLeadership()).resolves.toBe('leader');
  });
});

describe('a newcomer does not assume what it has not been granted', () => {
  it('starts as a standby, so it answers 503 until it wins the election', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const { isLeader } = await load();
    // Before any claim resolves. This is the window the second container sat
    // in while Caddy sent it traffic.
    expect(isLeader()).toBe(false);
  });

  it('will not promote while another instance is known to hold it', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership, isLeader } = await load();
    expect(await renewLeadership()).toBe('standby');
    // Now the database goes away entirely. 'other' was named as holder, so
    // silence is not evidence that it went away.
    rpc.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 10; i++) await renewLeadership();
    expect(isLeader()).toBe(false);
  });
});

describe('but a fleet with nobody running it is worse than either', () => {
  /**
   * The cost of starting humble is that a single-engine deployment on an
   * unreachable database would stay a standby for ever and serve 503 —
   * "degraded" turned into "down". So genuine silence, and only genuine
   * silence, still promotes: no answer has ever named a holder.
   */
  it('promotes a lone instance after three unanswerable claims', async () => {
    rpc.mockRejectedValue(new Error('down'));
    const { renewLeadership, isLeader } = await load();
    expect(await renewLeadership()).toBe('standby');
    expect(await renewLeadership()).toBe('standby');
    expect(await renewLeadership()).toBe('leader');
    expect(isLeader()).toBe(true);
  });

  it('promotes when the claim keeps resolving to nobody at all', async () => {
    // An empty row set used to promote on the FIRST call: `if (!row || ...)`.
    // No row is not a grant — but sustained silence is still an empty fleet.
    rpc.mockResolvedValue({ data: [], error: null });
    const { renewLeadership } = await load();
    expect(await renewLeadership()).toBe('standby');
    expect(await renewLeadership()).toBe('standby');
    expect(await renewLeadership()).toBe('leader');
  });

  it('a grant resets the streak, so an intermittent database cannot stack it', async () => {
    rpc.mockRejectedValue(new Error('down'));
    const { renewLeadership } = await load();
    await renewLeadership();
    await renewLeadership();
    rpc.mockResolvedValue(refused); // somebody answered: 'other' holds it
    expect(await renewLeadership()).toBe('standby');
    rpc.mockRejectedValue(new Error('down'));
    // Streak restarts AND a holder is now known, so no promotion.
    expect(await renewLeadership()).toBe('standby');
    expect(await renewLeadership()).toBe('standby');
  });
});

describe('election', () => {
  it('leads when granted', async () => {
    rpc.mockResolvedValue(granted);
    const { renewLeadership, leadershipDiagnostics } = await load();
    expect(await renewLeadership()).toBe('leader');
    expect(leadershipDiagnostics().holder).toBe('me');
  });

  it('stands by when another instance holds it', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership, isLeader, leadershipDiagnostics } = await load();
    expect(await renewLeadership()).toBe('standby');
    expect(isLeader()).toBe(false);
    expect(leadershipDiagnostics().holder).toBe('other');
  });

  it('a standby promotes the moment the lease is granted', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership, isLeader } = await load();
    expect(await renewLeadership()).toBe('standby');
    rpc.mockResolvedValue(granted);
    expect(await renewLeadership()).toBe('leader');
    expect(isLeader()).toBe(true);
  });

  it('a standby that never led does NOT exit — it is doing its job', async () => {
    rpc.mockResolvedValue(refused);
    const { renewLeadership } = await load();
    await renewLeadership();
    await renewLeadership();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('losing leadership while holding it', () => {
  it('stands down hard rather than risk two leaders', async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValue(granted);
    const { renewLeadership } = await load();
    expect(await renewLeadership()).toBe('leader');

    // Our heartbeat lapsed past the staleness window and someone took over.
    rpc.mockResolvedValue(refused);
    expect(await renewLeadership()).toBe('standby');

    vi.advanceTimersByTime(500);
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });
});


/**
 * A LEADER THAT DOES NOTHING (2026-08-24).
 *
 * GameServer.start() returns early for a standby: no discovery loop, no horse
 * fleet, no stale-data cleanup. Every promotion path in leadership.ts flipped
 * `role` in memory, which turned that inert process into a leader by name only.
 * It then held the lease so no healthy instance could take over, while its
 * discoveryLoopStalledMs climbed in lockstep with uptime until liveness read
 * 'dead' and Docker killed it — a restart loop that never deals a hand.
 *
 * Production signature, 2026-08-24:
 *   up=188s activeTables=0 liveness=dead discStall=188115ms
 * discStall equal to uptime is the tell: the loop never ran once.
 *
 * These are source guards. The promotion paths call process.exit, which cannot
 * be exercised in-process without killing the runner.
 */
describe('a promoted standby restarts instead of leading in name only', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/services/leadership.ts'), 'utf8');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('exposes markBootedAsStandby so the early-return can be recorded', () => {
    expect(code).toMatch(/export function markBootedAsStandby\(\)/);
  });

  it('guards the restart on having actually booted as a standby', () => {
    // Without this, a process that booted as leader and merely re-won its
    // lease would restart itself on every renewal.
    const fn = code.slice(code.indexOf('function restartIntoLeaderBoot'));
    expect(fn).toMatch(/if \(!bootedAsStandby\) return;/);
  });

  it('restarts on EVERY promotion path, not just the exotic ones', () => {
    // Four sites flip role to leader: unanswerable claim, row resolved to
    // nobody, an ordinary granted lease, and a thrown claim. The ordinary
    // grant is the common one and was the easiest to miss.
    const calls = code.match(/restartIntoLeaderBoot\(/g) || [];
    expect(calls.length).toBe(5); // 4 call sites + the declaration
  });

  it('covers the ordinary granted-lease promotion specifically', () => {
    const granted = code.slice(code.indexOf('if (row.granted)'));
    expect(granted).toMatch(/wasStandby/);
    expect(granted.slice(0, granted.indexOf('return role;'))).toMatch(/restartIntoLeaderBoot\(/);
  });

  it('clears the flag on reset so tests cannot leak state into each other', () => {
    const reset = code.slice(code.indexOf('export function __resetLeadership'));
    expect(reset.slice(0, 200)).toMatch(/bootedAsStandby = false/);
  });
});

/**
 * THE RESTART LOOP (2026-08-24). The promotion-restart fix above, shipped
 * without releasing the lease, put production into a loop within minutes:
 *
 *   STANDBY — 1-fc708d24 holds leadership
 *   1-fc708d24 is now the LEADER — taking the fleet
 *   1-fc708d24 promoted (lease granted) ... exiting
 *   (repeat with a new id, RestartCount 4 in 20 minutes, 0 tables throughout)
 *
 * Being promoted makes this instance the recorded holder. Exiting while still
 * holding leaves a lease only seconds old, so the replacement boots INSIDE the
 * LEADERSHIP_STALE_SECONDS window, sees a live holder, and starts as a standby
 * — which is promoted moments later, and does the same thing again.
 */
describe('the promotion restart releases the lease first', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/services/leadership.ts'), 'utf8');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.slice(
    code.indexOf('function restartIntoLeaderBoot'),
    code.indexOf('export function isLeader')
  );

  it('calls releaseLeadership before exiting', () => {
    expect(fn).toMatch(/releaseLeadership\(\)/);
  });

  it('chains the exit off the release rather than racing it on a timer', () => {
    // A bare setTimeout alongside an un-awaited release can exit first, which
    // leaves the fresh lease behind and re-creates the loop.
    const rel = fn.indexOf('releaseLeadership()');
    const exit = fn.indexOf('process.exit');
    expect(rel).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(rel);
    expect(fn.slice(rel, exit)).toMatch(/\.finally\(/);
  });

  it('schedules the restart only once, however many renewals land', () => {
    expect(fn).toMatch(/if \(restartScheduled\) return;/);
    expect(fn).toMatch(/restartScheduled = true/);
  });

  it('clears the once-guard on reset', () => {
    const reset = code.slice(code.indexOf('export function __resetLeadership'));
    expect(reset.slice(0, 260)).toMatch(/restartScheduled = false/);
  });
});
