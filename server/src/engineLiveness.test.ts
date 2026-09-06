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
  /**
   * 2026-09-05: dealable, unpaused tables — the DENOMINATOR of the stall
   * verdict. Defaults to deadStalledCount so a caller that supplies only a
   * stall count still describes a whole-fleet stall, which is what every test
   * written before this date meant by it.
   */
  dealableTableCount?: number;
}): boolean {
  const discoveryLoopDead =
    !o.stillBooting &&
    (o.discoveryLoopStalledMs > 900_000 ||
      (o.discoveryLoopStalledMs > 60_000 && !o.anyTableProgressedRecently));
  const barrenLeaderDead =
    !o.stillBooting && (o.activeTables ?? 1) === 0 && (o.discoveryStaleMs ?? 0) > 600_000;
  const dealableTableCount = o.dealableTableCount ?? o.deadStalledCount;
  const wholeFleetStalled = dealableTableCount > 0 && o.deadStalledCount >= dealableTableCount;
  return wholeFleetStalled || discoveryLoopDead || barrenLeaderDead || o.dbConfirmedDead;
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

  it('still dies when the WHOLE dealable fleet has out-stalled recovery', () => {
    // The only table that can be dealt is the stalled one. A restart voids
    // nothing that was working, so it is the right answer.
    expect(
      isDead({
        deadStalledCount: 1,
        dealableTableCount: 1,
        discoveryLoopStalledMs: 1_000,
        dbConfirmedDead: false,
      })
    ).toBe(true);
  });

  /**
   * ── A MINORITY STALL IS NOT A DEAD PROCESS (2026-09-05) ──────────────────
   *
   * This test used to assert the opposite: `deadStalledCount: 1` was dead,
   * full stop, whatever else the fleet was doing. It is replaced deliberately
   * and in the same commit as the code, because production measured the cost.
   *
   * 763 consecutive minutes of Prometheus on 2026-09-05:
   *   liveness == 0 for 139 minutes (18% of the day)
   *   stalled tables > 0 in 136 of those 139 (98%)
   *   stalled tables > 0 in 0 of the 624 healthy minutes
   *   modal stalled count during a dead minute: ONE
   *
   * sp-autoheal acted on that verdict five times that day - 16:06, 16:42,
   * 17:49, 18:26, 19:04 UTC - each an unannounced restart outside the §13
   * break, each voiding live hands on ~312 tables to fix one, and each also
   * resetting uptime and so coalescing the deploy pipeline into shipping
   * nothing (see tests/the-deploy-can-always-ship.law.test.ts).
   *
   * The single stalled table already has a cheaper remedy: watchdog Tier 1-3
   * -> killForRestart -> zombie reaper -> discovery rebuild, which rebuilds
   * that table alone. Killing the container is not an escalation of that, it
   * is a strictly worse version of it applied to 311 innocent tables.
   */
  it('does NOT die because one table out of a dealing fleet is stalled (2026-09-05)', () => {
    expect(
      isDead({
        deadStalledCount: 1,
        dealableTableCount: 312,
        discoveryLoopStalledMs: 1_000,
        dbConfirmedDead: false,
      })
    ).toBe(false);
  });

  it('does NOT die on a large but partial stall - 79 of 312 was a real reading', () => {
    // The worst minute measured on 2026-09-05 had 79 stalled tables. 233 were
    // dealing. Restarting would have voided all 233 to fix the 79, which the
    // per-table recovery was already working on.
    expect(
      isDead({
        deadStalledCount: 79,
        dealableTableCount: 312,
        discoveryLoopStalledMs: 1_000,
        dbConfirmedDead: false,
      })
    ).toBe(false);
  });

  it('an idle fleet with nothing dealable is not dead either', () => {
    // Zero dealable tables is the overnight/empty-lobby state, not a stall.
    // Guarding the denominator is what stops 0 >= 0 reading as "everything is
    // stalled" and restarting an engine with nothing wrong with it.
    expect(
      isDead({
        deadStalledCount: 0,
        dealableTableCount: 0,
        discoveryLoopStalledMs: 1_000,
        dbConfirmedDead: false,
      })
    ).toBe(false);
  });

  it('the fleet-wide detector still fires - the database is the one that cannot be fooled', () => {
    // Whole-fleet silence is what dbConfirmedDead is FOR, asked of Postgres
    // rather than of this process's opinion of its own work. Narrowing the
    // stall clause does not narrow this one.
    expect(
      isDead({
        deadStalledCount: 0,
        dealableTableCount: 312,
        discoveryLoopStalledMs: 1_000,
        dbConfirmedDead: true,
      })
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

    // 2026-09-05: the stall clause is FLEET-WIDE. `deadStalledCount > 0` in
    // the liveness expression is the regression that had sp-autoheal restart
    // production five times in one day on the word of a single table, and it
    // must not come back by any spelling.
    expect(
      expr,
      'liveness must not condemn the process on a raw stall count - see wholeFleetStalled'
    ).not.toMatch(/deadStalledCount\s*>\s*0/);
    expect(expr).toMatch(/wholeFleetStalled/);
    const sdef = sliceStatement(src, 'const wholeFleetStalled');
    expect(sdef, 'wholeFleetStalled definition missing').toBeTruthy();
    // Both halves are the safety argument: a denominator that must be
    // non-zero (an idle fleet is not a stalled one), and a comparison that
    // requires EVERY dealable table to have out-stalled recovery.
    expect(sdef).toMatch(/dealableTableCount > 0/);
    expect(sdef).toMatch(/deadStalledCount >= dealableTableCount/);
  });

  it('the prometheus gauge agrees with getStatus', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./GameServer.ts', import.meta.url), 'utf8');
    const i = src.indexOf('poker_engine_liveness ${');
    expect(i).toBeGreaterThan(-1);
    // The gauge is multi-line since 2026-08-30; read to the closing backtick.
    const expr = sliceBetween(src, 'poker_engine_liveness ${', '`,');
    expect(expr).toMatch(/lastDiscoveryAttemptAt/);
    // 2026-09-05: the gauge read the 120s VISIBILITY list (`stalled`) while
    // getStatus() killed on the 300s one - two thresholds under one name, so
    // the series anybody alerted on was not the series Docker acted on. Both
    // read the same fleet-wide verdict now.
    expect(
      expr,
      'the gauge must not key on the 120s visibility list - use the same fleet verdict as getStatus()'
    ).not.toMatch(/stalled\.length === 0/);
    expect(expr).toMatch(/fleetStalled/);
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
