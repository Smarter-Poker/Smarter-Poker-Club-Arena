/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN ENGINE THAT SERVES ONE FLEET AND NOT THE OTHER (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read off production 2026-09-09 05:52 UTC:
 *
 *     /health   activeTables: 102, activeTournaments: 0, liveness: "ok"
 *     /metrics  poker_tournaments_running 120
 *               poker_tournament_elimination_scheduler_registered 0
 *
 * A full cash fleet and not one of a hundred and twenty tournaments, reporting
 * itself healthy - correctly, by every rule it had. `wholeFleetStalled` was
 * false because the cash tables were dealing. `discoveryLoopDead` was false
 * because the loop was attempting every five seconds. `barrenLeaderDead`
 * requires `tables.length === 0`, and a hundred and two is not zero.
 *
 * Thirteen RUNNING tournaments had dealt no hand for over an hour, the oldest
 * for fifteen hours, with 183 players sitting in them. Nothing anywhere said
 * so, and it was found by hand.
 *
 * `TournamentMetrics`' own header had already reasoned to the edge of this:
 * "an engine reporting only on tournaments it OWNS can never see it: the
 * failure IS the absence of a manager". True - and the fix it shipped
 * published only the database half. These pins are the other half and the
 * three states in which it must refuse to answer.
 */

import { describe, it, expect } from 'vitest';
import { TournamentMetrics, FLEET_SNAPSHOT_MAX_AGE_SECONDS } from './TournamentMetrics.js';

type Snapshot = ReturnType<TournamentMetrics['get']>;

/** Seed a metrics instance with a snapshot, the way a refresh would. */
const withSnapshot = (patch: Partial<Snapshot>): TournamentMetrics => {
  const metrics = new TournamentMetrics();
  Object.assign(metrics.get(), {
    running: 0,
    registering: 0,
    overdueStart: 0,
    seatFirstWaiting: 0,
    stuckCompleting: 0,
    seatlessPhantoms: 0,
    unpaidCompleted: 0,
    collectedAt: Date.now(),
    ...patch,
  });
  return metrics;
};

const gauge = (lines: string[], name: string): number => {
  const line = lines.find((l) => l.startsWith(`${name} `));
  if (!line) throw new Error(`${name} is not exported at all`);
  return Number(line.slice(name.length + 1));
};

const SERVING = { owned: 4, isLeader: true, stillBooting: false };
const BARREN = { owned: 0, isLeader: true, stillBooting: false };

describe('an engine that serves one fleet and not the other says so', () => {
  it('publishes what this process owns, not only what the database wants', () => {
    // The whole defect was that one of these two numbers did not exist, so no
    // rule could compare them.
    const lines = withSnapshot({ running: 120 }).toPrometheus(SERVING);
    expect(gauge(lines, 'poker_tournaments_running')).toBe(120);
    expect(gauge(lines, 'poker_tournaments_owned')).toBe(4);
  });

  it('reports unserved when the leader owns none and the database says RUNNING', () => {
    // The exact production shape: 120 running, 0 owned, liveness happily ok.
    const lines = withSnapshot({ running: 120 }).toPrometheus(BARREN);
    expect(gauge(lines, 'poker_tournament_fleet_unserved')).toBe(1);
  });

  it('is silent while any manager is held - one is enough to prove adoption works', () => {
    const lines = withSnapshot({ running: 120 }).toPrometheus({ ...BARREN, owned: 1 });
    expect(gauge(lines, 'poker_tournament_fleet_unserved')).toBe(0);
  });

  it('is silent when nothing is running, so an empty board is not an outage', () => {
    const lines = withSnapshot({ running: 0 }).toPrometheus(BARREN);
    expect(gauge(lines, 'poker_tournament_fleet_unserved')).toBe(0);
  });

  it('never fires on a STANDBY instance, which owns nothing by design', () => {
    const lines = withSnapshot({ running: 120 }).toPrometheus({ ...BARREN, isLeader: false });
    expect(gauge(lines, 'poker_tournament_fleet_unserved')).toBe(0);
  });

  it('never fires while BOOTING, which has not finished adopting', () => {
    const lines = withSnapshot({ running: 120 }).toPrometheus({ ...BARREN, stillBooting: true });
    expect(gauge(lines, 'poker_tournament_fleet_unserved')).toBe(0);
  });

  it('refuses on a STALE snapshot rather than asserting from a number nobody re-read', () => {
    // CLAUDE.md 10.86 rule 1: "I could not tell" is its own outcome and must
    // never be folded into a confident one. `running` is kept from the last
    // good read on purpose, so past the age limit it is not evidence.
    const stale = withSnapshot({
      running: 120,
      collectedAt: Date.now() - (FLEET_SNAPSHOT_MAX_AGE_SECONDS + 60) * 1000,
    });
    expect(gauge(stale.toPrometheus(BARREN), 'poker_tournament_fleet_unserved')).toBe(0);
    // ...and the staleness itself stays visible, which is what proves the
    // silence above is a refusal and not health.
    expect(
      gauge(stale.toPrometheus(BARREN), 'poker_tournament_metrics_stale_seconds')
    ).toBeGreaterThan(FLEET_SNAPSHOT_MAX_AGE_SECONDS);
  });

  it('has never collected: reports stale, and therefore does not accuse', () => {
    const lines = new TournamentMetrics().toPrometheus(BARREN);
    expect(gauge(lines, 'poker_tournament_metrics_stale_seconds')).toBe(86_400);
    expect(gauge(lines, 'poker_tournament_fleet_unserved')).toBe(0);
  });

  it('defaults refuse: a caller that passes nothing cannot accidentally page', () => {
    // The parameter has a default so the signature change cannot silently turn
    // some other caller into an alarm source.
    const lines = withSnapshot({ running: 120 }).toPrometheus();
    expect(gauge(lines, 'poker_tournament_fleet_unserved')).toBe(0);
    expect(gauge(lines, 'poker_tournaments_owned')).toBe(0);
  });
});
