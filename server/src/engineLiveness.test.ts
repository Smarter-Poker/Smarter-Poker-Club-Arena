/**
 * A SLOW DATABASE IS NOT A DEAD PROCESS.
 *
 * `liveness` is the hard signal: 'dead' fails the Docker healthcheck, which
 * makes sp-autoheal kill the container, which voids every in-flight hand on
 * every table it owns. Getting it wrong is expensive in exactly the way this
 * whole effort was about.
 *
 * It used `discoveryStaleMs > 60_000`, and `lastDiscoveryOkAt` only advances
 * when the discovery RPC comes back CLEAN. So one minute of database trouble
 * declared the whole process dead while the loop was running perfectly and
 * simply being told "no" each time.
 *
 * Verified in production before this fix: club-arena-engine-2 was marked
 * unhealthy four times between 05:35 and 05:43 UTC while running a healthcheck
 * that connects fine -- so the probe reached the engine and was TOLD 'dead'.
 * The container was restarted for the database's sake.
 *
 * Same mistake as the dealing-loop watchdog in #281, one level up, and the same
 * shape of fix: ask whether the loop is RUNNING, not whether its last answer
 * was good.
 */
import { describe, it, expect } from 'vitest';

/**
 * The liveness expression from GameServer.getStatus(), isolated. Kept as a
 * pure function so the rule can be tested without booting an engine; it is
 * asserted against the real source below so the two cannot drift.
 */
function isDead(o: {
  deadStalledCount: number;
  discoveryLoopStalledMs: number;
  dbConfirmedDead: boolean;
}): boolean {
  return o.deadStalledCount > 0 || o.discoveryLoopStalledMs > 60_000 || o.dbConfirmedDead;
}

describe('engine liveness', () => {
  it('does NOT die because the database is slow', () => {
    // The loop ran 2s ago; the database has been failing it for ten minutes.
    // The engine is alive and must not be restarted.
    expect(
      isDead({ deadStalledCount: 0, discoveryLoopStalledMs: 2_000, dbConfirmedDead: false })
    ).toBe(false);
  });

  it('DOES die when the discovery loop itself stops running', () => {
    // Nothing has attempted discovery for two minutes: the loop is gone, and a
    // restart is the correct answer.
    expect(
      isDead({ deadStalledCount: 0, discoveryLoopStalledMs: 120_000, dbConfirmedDead: false })
    ).toBe(true);
  });

  it('still dies on a genuinely stalled table', () => {
    expect(
      isDead({ deadStalledCount: 1, discoveryLoopStalledMs: 1_000, dbConfirmedDead: false })
    ).toBe(true);
  });

  it('still dies when the database itself confirms no hands are being dealt', () => {
    expect(
      isDead({ deadStalledCount: 0, discoveryLoopStalledMs: 1_000, dbConfirmedDead: true })
    ).toBe(true);
  });
});

describe('the rule in the source matches the rule tested here', () => {
  it('getStatus keys liveness on the loop, never on the last successful rpc', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
    const i = src.indexOf('liveness:');
    expect(i, 'liveness field missing from getStatus').toBeGreaterThan(-1);
    const expr = src.slice(i, i + 260);
    expect(expr).toMatch(/discoveryLoopStalledMs > 60_000/);
    // The regression this guards: reinstating the ok-based signal would make a
    // slow database restart the container again.
    expect(expr).not.toMatch(/discoveryStaleMs > 60_000/);
  });

  it('the prometheus gauge agrees with getStatus', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
    const i = src.indexOf('poker_engine_liveness ${');
    expect(i).toBeGreaterThan(-1);
    const expr = src.slice(i, i + 160);
    expect(expr).toMatch(/lastDiscoveryAttemptAt/);
    expect(expr).not.toMatch(/lastDiscoveryOkAt/);
  });
});
