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
import { sliceEnclosingBlock, sliceStatement, sliceBetween } from './testHelpers/sourceWindow.js';

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
  /** 2026-08-30: ms since discovery last SUCCEEDED (not merely ran). */
  discoveryStaleMs?: number;
  /** 2026-08-30: tables this instance has actually adopted. */
  activeTables?: number;
}): boolean {
  const discoveryLoopDead =
    !o.stillBooting &&
    (o.discoveryLoopStalledMs > 900_000 ||
      (o.discoveryLoopStalledMs > 60_000 && !o.anyTableProgressedRecently));
  const barrenLeaderDead =
    !o.stillBooting && (o.activeTables ?? 1) === 0 && (o.discoveryStaleMs ?? 0) > 600_000;
  return o.deadStalledCount > 0 || discoveryLoopDead || barrenLeaderDead || o.dbConfirmedDead;
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

  it('table progress cannot veto forever - 15 minutes without a discovery attempt is dead', () => {
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

  it('a stalled TABLE still counts during boot - that is real, not startup', () => {
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

describe('a barren leader is dead, however busy its loop looks (2026-08-30)', () => {
  /**
   * The exact production payload, 2026-08-30. Nineteen RUNNING tournaments,
   * ~3,000 seated players, not one hand for twenty minutes, and this process
   * answering 'ok' the whole time while holding the lease that would have let
   * a working instance take the fleet.
   */
  it('dies on the observed signature: leader, zero tables, discovery never succeeding', () => {
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 4_496, // loop ticking, so the old rule saw health
        discoveryStaleMs: 101_563 + 600_000, // and not one success since
        activeTables: 0,
        dbConfirmedDead: false,
      })
    ).toBe(true);
  });

  it('does NOT die when the database is slow but tables are adopted', () => {
    // The 2026-08-23 regression. Discovery failing for an hour, but this
    // engine owns tables and is dealing on them: restarting voids real hands.
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 2_000,
        discoveryStaleMs: 3_600_000,
        activeTables: 123,
        anyTableProgressedRecently: true,
        dbConfirmedDead: false,
      })
    ).toBe(false);
  });

  it('does NOT die on an idle fleet, because idle discovery still SUCCEEDS', () => {
    // Nothing to deal at 4am is not the same as being unable to ask. A
    // successful empty answer keeps the ok-clock at zero.
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 2_000,
        discoveryStaleMs: 1_000,
        activeTables: 0,
        dbConfirmedDead: false,
      })
    ).toBe(false);
  });

  it('does NOT die while still booting with nothing adopted yet', () => {
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 2_000,
        discoveryStaleMs: 900_000,
        activeTables: 0,
        stillBooting: true,
        dbConfirmedDead: false,
      })
    ).toBe(false);
  });

  it('waits out a long outage rather than restarting on a blip', () => {
    // Nine minutes of failure with nothing adopted is not yet a verdict.
    expect(
      isDead({
        deadStalledCount: 0,
        discoveryLoopStalledMs: 2_000,
        discoveryStaleMs: 540_000,
        activeTables: 0,
        dbConfirmedDead: false,
      })
    ).toBe(false);
  });
});

describe('the rule in the source matches the rule tested here', () => {
  it('getStatus keys liveness on the loop, never on the last successful rpc', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
    const i = src.indexOf('liveness:');
    expect(i, 'liveness field missing from getStatus').toBeGreaterThan(-1);
    const expr = sliceEnclosingBlock(src, 'liveness:');
    // 2026-08-24: the discovery clause moved into `discoveryLoopDead`, which
    // is vetoed by recent table progress and capped at 15 minutes. The
    // liveness expression must use it, and its definition must keep the boot
    // grace, the 60s stall floor, the progress veto, and the hard cap.
    expect(expr).toMatch(/discoveryLoopDead/);
    const d = src.indexOf('const discoveryLoopDead');
    expect(d, 'discoveryLoopDead definition missing').toBeGreaterThan(-1);
    const def = sliceStatement(src, 'const discoveryLoopDead');
    expect(def).toMatch(/stillBooting/);
    expect(def).toMatch(/discoveryLoopStalledMs > 60_000/);
    expect(def).toMatch(/anyTableProgressedRecently/);
    expect(def).toMatch(/discoveryLoopStalledMs > 900_000/);
    // The regression this guards: reinstating the ok-based signal AS THE
    // GENERAL RULE would make a slow database restart the container again.
    // The 60s ok-clock threshold specifically must never come back.
    expect(sliceEnclosingBlock(src, 'liveness:')).not.toMatch(/discoveryStaleMs > 60_000/);

    // 2026-08-30: the ok-clock IS readable again in one narrow place —
    // `barrenLeaderDead`, which additionally requires zero adopted tables, so
    // it cannot void an in-flight hand. Both halves must be present: the
    // zero-table clause is the entire safety argument for reading it at all.
    expect(expr).toMatch(/barrenLeaderDead/);
    const bdef = sliceStatement(src, 'const barrenLeaderDead');
    expect(bdef, 'barrenLeaderDead definition missing').toBeTruthy();
    expect(bdef).toMatch(/stillBooting/);
    expect(bdef).toMatch(/tableEngines\.size === 0/);
    expect(bdef).toMatch(/discoveryStaleMs > 600_000/);
  });

  it('the prometheus gauge agrees with getStatus', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
    const i = src.indexOf('poker_engine_liveness ${');
    expect(i).toBeGreaterThan(-1);
    // The gauge is multi-line since 2026-08-30; read to the closing backtick.
    const expr = sliceBetween(src, 'poker_engine_liveness ${', '`,');
    expect(expr).toMatch(/lastDiscoveryAttemptAt/);
    // It may read the ok-clock ONLY as part of the barren clause (zero tables
    // adopted). Bare use of it as the liveness signal is the 2026-08-23
    // regression and stays banned.
    if (/lastDiscoveryOkAt/.test(expr)) {
      expect(expr).toMatch(/tableEngines\.size === 0/);
      expect(expr).toMatch(/600_000/);
      expect(expr).not.toMatch(/lastDiscoveryOkAt\s*>\s*60_000/);
    }
  });
});
