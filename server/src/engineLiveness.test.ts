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
  stillBooting?: boolean;
  /** 2026-08-24: any table made observable progress in the last 2 minutes. */
  anyTableProgressedRecently?: boolean;
}): boolean {
  const discoveryLoopDead =
    !o.stillBooting &&
    (o.discoveryLoopStalledMs > 900_000 ||
      (o.discoveryLoopStalledMs > 60_000 && !o.anyTableProgressedRecently));
  return o.deadStalledCount > 0 || discoveryLoopDead || o.dbConfirmedDead;
}

describe('engine liveness', () => {
  it('does NOT die because the database is slow', () => {
    // The loop ran 2s ago; the database has been failing it for ten minutes.
    // The engine is alive and must not be restarted.
    expect(
      isDead({ deadStalledCount: 0, discoveryLoopStalledMs: 2_000, dbConfirmedDead: false })
    ).toBe(false);
  });

  it('DOES die when the discovery loop stops running AND nothing is progressing', () => {
    // Nothing has attempted discovery for two minutes and no table has made
    // progress either: the process is gone, and a restart is the correct answer.
    expect(
      isDead({ deadStalledCount: 0, discoveryLoopStalledMs: 120_000, dbConfirmedDead: false })
    ).toBe(true);
  });

  it('does NOT die on a discovery stall while tables are demonstrably dealing (2026-08-24)', () => {
    // OBSERVED LIVE: one discovery cycle blocked 87s inside a slow database
    // call while 123 tables played on and hand_history grew every second.
    // Restarting that engine would have voided every table to fix nothing.
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 120_000,
        dbConfirmedDead: false,
        anyTableProgressedRecently: true,
      })
    ).toBe(false);
  });

  it('table progress cannot veto forever — 15 minutes without a discovery attempt is dead', () => {
    // A discovery loop wedged on a hung await must still be restarted even
    // while horses keep tables busy, or new tables never adopt again.
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 901_000,
        dbConfirmedDead: false,
        anyTableProgressedRecently: true,
      })
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

describe('booting is not dead', () => {
  /**
   * The discovery loop does not start until start() has finished
   * cleanupStaleData, the horse fleet and HorseMind hydration -- which on a
   * busy database takes longer than 60s. OBSERVED LIVE on the 2026-08-23
   * leader/standby rollout: /health returned 'dead' at ~60s uptime on a
   * container that was booting perfectly and read 'ok' thirty seconds later.
   *
   * Docker's 90s start-period covers the usual case, but a boot slower than
   * 90s is a boot against a struggling database -- the worst possible moment
   * to have autoheal kill the container.
   */
  it('does not die while still booting, even with no discovery yet', () => {
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 120_000,
        dbConfirmedDead: false,
        stillBooting: true,
      })
    ).toBe(false);
  });

  it('starts judging discovery once the boot window has passed', () => {
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 120_000,
        dbConfirmedDead: false,
        stillBooting: false,
      })
    ).toBe(true);
  });

  it('a stalled TABLE still counts during boot — that is real, not startup', () => {
    expect(
      isDead({
        deadStalledCount: 1,
        discoveryLoopStalledMs: 0,
        dbConfirmedDead: false,
        stillBooting: true,
      })
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
    // 2026-08-24: the discovery clause moved into `discoveryLoopDead`, which
    // is vetoed by recent table progress and capped at 15 minutes. The
    // liveness expression must use it, and its definition must keep the boot
    // grace, the 60s stall floor, the progress veto, and the hard cap.
    expect(expr).toMatch(/discoveryLoopDead/);
    const d = src.indexOf('const discoveryLoopDead');
    expect(d, 'discoveryLoopDead definition missing').toBeGreaterThan(-1);
    const def = src.slice(d, d + 300);
    expect(def).toMatch(/stillBooting/);
    expect(def).toMatch(/discoveryLoopStalledMs > 60_000/);
    expect(def).toMatch(/anyTableProgressedRecently/);
    expect(def).toMatch(/discoveryLoopStalledMs > 900_000/);
    // The regression this guards: reinstating the ok-based signal would make a
    // slow database restart the container again.
    expect(src.slice(i, i + 260)).not.toMatch(/discoveryStaleMs > 60_000/);
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
