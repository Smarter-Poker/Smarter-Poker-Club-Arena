/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REFUSAL THAT CANNOT CHANGE IS NOT RETRIED EVERY SECOND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-10, C-stuck-spins: fn_spin_draw_and_settle_atomic refused every
 * Spin launch with `projected_spin_draw_has_no_funding_proof` and the engine
 * asked it again 87 times a second, for hours (163,460 calls). The draw loop
 * treated every reason as a lost lease, and the seat-first fast lane restarted
 * the stood-down manager one second later.
 *
 * These tests EXECUTE the loop with a fake authority (the pattern of
 * spinRevealWindow.test.ts), then pin the two wiring sites by source, because
 * a park that the fast lane does not consult is a park in name only.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceCall, sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import {
  SPIN_DRAW_TERMINAL_REASONS,
  SPIN_DRAW_TRANSIENT_REASONS,
  SPIN_LAUNCH_PARK_CAP_MS,
  SPIN_LAUNCH_PARKED_ALERT_SOURCE,
  SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS,
  SPIN_LAUNCH_TRANSIENT_PARK_FIRST_MS,
  SpinLaunchParkRegistry,
  classifySpinDrawRefusal,
  proveSpinDrawWithParking,
  spinLaunchParkMs,
  type SpinDrawRpcResult,
} from './spinLaunchParking.js';

const here = new URL('.', import.meta.url).pathname;

/** The reason strings the live function body returns, read 2026-09-10. */
const LIVE_REASONS = [
  'invalid_launch_request',
  'launch_lease_lost',
  'launch_receipt_state_mismatch',
  'entry_purchases_frozen',
  'invalid_spin_contract',
  'spin_field_unproven',
  'spin_entry_escrow_unproven',
  'spin_paid_entry_unproven',
  'spin_receipt_roster_mismatch',
  'legacy_spin_rules_unproven',
  'projected_spin_draw_has_no_funding_proof',
  'spin_rule_manifest_invalid',
];

class AbortedForTest extends Error {}

type Answer = SpinDrawRpcResult | (() => SpinDrawRpcResult);

/** A fake authority that answers from a script and counts every call. */
function harness(answers: Answer[], opts: { start?: number } = {}) {
  let clock = opts.start ?? 1_700_000_000_000;
  const calls: number[] = [];
  const sleeps: number[] = [];
  const alerts: Array<{ severity: string; source: string; message: string; context: any }> = [];
  const warns: string[] = [];
  const reports: Array<{ message: string; context: string }> = [];
  const parks = new SpinLaunchParkRegistry();
  let aborted = false;
  const deps = () => ({
    tournamentId: 'a9c5e229-001b-4a49-af0a-f1b703f29dfa',
    launchId: 'launch-1',
    callDraw: async () => {
      calls.push(clock);
      const next = answers.shift();
      if (!next) throw new Error('script exhausted');
      return typeof next === 'function' ? next() : next;
    },
    readReceipt: (data: unknown) => data as { ok: true; multiplier: number },
    assertLifecycleCurrent: () => {
      if (aborted) throw new AbortedForTest('fenced');
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
    parks,
    raiseAlert: async (severity: string, source: string, message: string, context: any) => {
      alerts.push({ severity, source, message, context });
      return { persisted: true, alertId: 'alert-1' };
    },
    warn: (message: string) => {
      warns.push(message);
    },
    reportError: (error: Error, context: string) => {
      reports.push({ message: error.message, context });
    },
  });
  return {
    deps,
    calls,
    sleeps,
    alerts,
    warns,
    reports,
    parks,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    abort: () => {
      aborted = true;
    },
    id: 'a9c5e229-001b-4a49-af0a-f1b703f29dfa',
  };
}

const refused = (reason: string): SpinDrawRpcResult => ({
  data: { ok: false, reason },
  error: null,
});
const granted: SpinDrawRpcResult = { data: { ok: true, multiplier: 2 }, error: null };

describe('the classification of fn_spin_draw_and_settle_atomic refusals', () => {
  it('names every reason the live function can return, and no reason twice', () => {
    for (const reason of LIVE_REASONS) {
      const terminal = SPIN_DRAW_TERMINAL_REASONS.has(reason);
      const transient = SPIN_DRAW_TRANSIENT_REASONS.has(reason);
      expect(terminal || transient, `${reason} is classified`).toBe(true);
      expect(terminal && transient, `${reason} is classified once`).toBe(false);
    }
  });

  it('holds the eight reasons the incident named as terminal', () => {
    for (const reason of [
      'projected_spin_draw_has_no_funding_proof',
      'spin_rule_manifest_invalid',
      'invalid_spin_contract',
      'legacy_spin_rules_unproven',
      'spin_entry_escrow_unproven',
      'spin_paid_entry_unproven',
      'spin_field_unproven',
      'spin_receipt_roster_mismatch',
    ]) {
      expect(classifySpinDrawRefusal(reason)).toBe('terminal');
    }
  });

  it('keeps the lease, receipt-state and freeze refusals transient, and unknowns too', () => {
    for (const reason of [
      'launch_lease_lost',
      'launch_receipt_state_mismatch',
      'entry_purchases_frozen',
    ]) {
      expect(classifySpinDrawRefusal(reason)).toBe('transient');
    }
    expect(classifySpinDrawRefusal('a_reason_nobody_has_written_yet')).toBe('transient');
    expect(classifySpinDrawRefusal(undefined)).toBe('transient');
    expect(classifySpinDrawRefusal(null)).toBe('transient');
  });
});

describe('the park schedule', () => {
  it('starts at 30 s for a terminal reason, doubles, and never exceeds the cap', () => {
    const none = () => 0;
    expect(spinLaunchParkMs(1, 'terminal', none)).toBe(SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS);
    expect(spinLaunchParkMs(2, 'terminal', none)).toBe(60_000);
    expect(spinLaunchParkMs(3, 'terminal', none)).toBe(120_000);
    expect(spinLaunchParkMs(5, 'terminal', none)).toBe(480_000);
    expect(spinLaunchParkMs(6, 'terminal', none)).toBe(SPIN_LAUNCH_PARK_CAP_MS);
    expect(spinLaunchParkMs(40, 'terminal', none)).toBe(SPIN_LAUNCH_PARK_CAP_MS);
    expect(spinLaunchParkMs(40, 'terminal', () => 1)).toBeLessThanOrEqual(SPIN_LAUNCH_PARK_CAP_MS);
  });

  it('starts at 5 s for a transient reason and follows the same doubling', () => {
    const none = () => 0;
    expect(spinLaunchParkMs(1, 'transient', none)).toBe(SPIN_LAUNCH_TRANSIENT_PARK_FIRST_MS);
    expect(spinLaunchParkMs(2, 'transient', none)).toBe(10_000);
    expect(spinLaunchParkMs(9, 'transient', none)).toBe(SPIN_LAUNCH_PARK_CAP_MS);
  });

  it('jitters DOWN by at most twenty percent, so a park never outlives its step', () => {
    for (const r of [0, 0.25, 0.5, 0.999, 1]) {
      const ms = spinLaunchParkMs(1, 'terminal', () => r);
      expect(ms).toBeLessThanOrEqual(SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS);
      expect(ms).toBeGreaterThanOrEqual(SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS * 0.8);
    }
  });
});

describe('a terminal refusal', () => {
  it('calls the authority ONCE, parks the tournament, raises one alert, warns once', async () => {
    const h = harness([refused('projected_spin_draw_has_no_funding_proof')]);
    const result = await proveSpinDrawWithParking(h.deps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('terminal');
    expect(result.reason).toBe('projected_spin_draw_has_no_funding_proof');
    expect(result.attempts).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);

    expect(h.parks.isParked(h.id, h.now())).toBe(true);
    expect(h.parks.parkedUntil(h.id, h.now())).toBe(h.now() + SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS);

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].severity).toBe('critical');
    expect(h.alerts[0].source).toBe(SPIN_LAUNCH_PARKED_ALERT_SOURCE);
    expect(h.alerts[0].context.tournament_id).toBe(h.id);
    expect(h.alerts[0].context.reason).toBe('projected_spin_draw_has_no_funding_proof');
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain('projected_spin_draw_has_no_funding_proof');
  });

  it('stands the park up even when the alert itself fails, and reports the failure instead of throwing', async () => {
    const h = harness([refused('spin_field_unproven')]);
    const deps = {
      ...h.deps(),
      raiseAlert: async () => {
        throw new Error('alerts table unreachable');
      },
    };
    const result = await proveSpinDrawWithParking(deps);

    expect(result.ok).toBe(false);
    expect(h.parks.isParked(h.id, h.now())).toBe(true);
    expect(h.parks.get(h.id)?.alertedReason).toBe('spin_field_unproven');
    expect(h.reports.map((r) => r.context)).toEqual([
      'Tournament.spin_draw_refused_terminal',
      'Tournament.spin_launch_parked_alert_failed',
    ]);
    expect(h.reports[1].message).toContain('alerts table unreachable');
  });

  it('is not retried inside the window, and the second park after it doubles without a second alert', async () => {
    const h = harness([
      refused('spin_rule_manifest_invalid'),
      refused('spin_rule_manifest_invalid'),
      refused('spin_rule_manifest_invalid'),
    ]);
    await proveSpinDrawWithParking(h.deps());
    const firstUntil = h.parks.parkedUntil(h.id, h.now())!;

    // The fast lane asks every second; inside the window the answer is "parked".
    for (let s = 1; s < 30; s++) {
      h.advance(1000);
      expect(h.parks.isParked(h.id, h.now())).toBe(true);
    }
    expect(h.calls).toHaveLength(1);

    // Window over. The next attempt is one call, then a doubled park.
    h.advance(1000);
    expect(h.now()).toBe(firstUntil);
    expect(h.parks.isParked(h.id, h.now())).toBe(false);
    await proveSpinDrawWithParking(h.deps());
    expect(h.calls).toHaveLength(2);
    expect(h.parks.get(h.id)!.strikes).toBe(2);
    expect(h.parks.parkedUntil(h.id, h.now())).toBe(h.now() + 60_000);

    h.advance(60_000);
    await proveSpinDrawWithParking(h.deps());
    expect(h.calls).toHaveLength(3);
    expect(h.parks.parkedUntil(h.id, h.now())).toBe(h.now() + 120_000);

    // One alert and one warning for the whole streak of one reason.
    expect(h.alerts).toHaveLength(1);
    expect(h.warns).toHaveLength(1);
    expect(
      h.reports.filter((r) => r.context === 'Tournament.spin_draw_refused_terminal')
    ).toHaveLength(1);
  });

  it('raises a second alert only when the reason changes', async () => {
    const h = harness([
      refused('projected_spin_draw_has_no_funding_proof'),
      refused('spin_field_unproven'),
      refused('spin_field_unproven'),
    ]);
    await proveSpinDrawWithParking(h.deps());
    h.advance(SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS);
    await proveSpinDrawWithParking(h.deps());
    h.advance(60_000);
    await proveSpinDrawWithParking(h.deps());
    expect(h.alerts.map((a) => a.context.reason)).toEqual([
      'projected_spin_draw_has_no_funding_proof',
      'spin_field_unproven',
    ]);
    expect(h.warns).toHaveLength(2);
  });

  it('never drives more than one call a second at a tournament over a long refusal', async () => {
    const h = harness(Array.from({ length: 200 }, () => refused('invalid_spin_contract')));
    const started = h.now();
    // Simulate the fast lane: every second, if not parked, run the launch.
    for (let tick = 0; tick < 3 * 60 * 60; tick++) {
      if (!h.parks.isParked(h.id, h.now())) await proveSpinDrawWithParking(h.deps());
      h.advance(1000);
    }
    const hours = (h.now() - started) / 3_600_000;
    expect(hours).toBeCloseTo(3, 5);
    // 30+60+120+240+480 s = 15.5 min of doubling, then 15-minute parks: well
    // under twenty calls in three hours, against ~3,000 before this change.
    expect(h.calls.length).toBeLessThan(20);
    expect(h.calls.length).toBeGreaterThan(10);
    expect(h.alerts).toHaveLength(1);
  });
});

describe('a transient refusal', () => {
  it('keeps the three in-attempt tries at 250/500 ms, then parks for 5 s', async () => {
    const h = harness([
      refused('launch_lease_lost'),
      refused('launch_lease_lost'),
      refused('launch_lease_lost'),
    ]);
    const result = await proveSpinDrawWithParking(h.deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
    expect(result.attempts).toBe(3);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 500]);
    expect(h.parks.isParked(h.id, h.now())).toBe(true);
    expect(h.parks.parkedUntil(h.id, h.now())).toBe(h.now() + SPIN_LAUNCH_TRANSIENT_PARK_FIRST_MS);
    // No financial alert for a transient refusal; error reporting gets today's report.
    expect(h.alerts).toHaveLength(0);
    expect(h.warns).toHaveLength(0);
    expect(h.reports.map((r) => r.context)).toEqual(['Tournament.spin_draw_unavailable']);
  });

  it('backs off the restart cadence as consecutive stand-downs accumulate', async () => {
    const h = harness(Array.from({ length: 12 }, () => refused('launch_receipt_state_mismatch')));
    await proveSpinDrawWithParking(h.deps());
    expect(h.parks.parkedUntil(h.id, h.now())! - h.now()).toBe(5_000);
    h.advance(5_000);
    await proveSpinDrawWithParking(h.deps());
    expect(h.parks.parkedUntil(h.id, h.now())! - h.now()).toBe(10_000);
    h.advance(10_000);
    await proveSpinDrawWithParking(h.deps());
    expect(h.parks.parkedUntil(h.id, h.now())! - h.now()).toBe(20_000);
    expect(h.calls).toHaveLength(9);
  });

  it('treats an RPC transport error the way it always did: retried, then parked', async () => {
    const h = harness([
      { data: null, error: { message: 'fetch failed' } },
      () => {
        throw new Error('socket hang up');
      },
      refused('entry_purchases_frozen'),
    ]);
    const result = await proveSpinDrawWithParking(h.deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
    expect(result.reason).toBe('entry_purchases_frozen');
    expect(h.calls).toHaveLength(3);
  });

  it('recovers inside the attempt when the second try is granted', async () => {
    const h = harness([refused('launch_lease_lost'), granted]);
    const result = await proveSpinDrawWithParking(h.deps());
    expect(result.ok).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.parks.isParked(h.id, h.now())).toBe(false);
  });

  it('a terminal answer on a later try still ends the attempt at once', async () => {
    const h = harness([refused('launch_lease_lost'), refused('spin_receipt_roster_mismatch')]);
    const result = await proveSpinDrawWithParking(h.deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('terminal');
    expect(h.calls).toHaveLength(2);
    expect(h.alerts).toHaveLength(1);
  });
});

describe('an ok answer', () => {
  it('clears the park and the strike count', async () => {
    const h = harness([
      refused('projected_spin_draw_has_no_funding_proof'),
      refused('projected_spin_draw_has_no_funding_proof'),
      granted,
      refused('projected_spin_draw_has_no_funding_proof'),
    ]);
    await proveSpinDrawWithParking(h.deps());
    h.advance(SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS);
    await proveSpinDrawWithParking(h.deps());
    expect(h.parks.get(h.id)!.strikes).toBe(2);

    // The migration lands; the authority says ok.
    h.advance(60_000);
    const ok = await proveSpinDrawWithParking(h.deps());
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.receipt).toEqual({ ok: true, multiplier: 2 });
    expect(h.parks.isParked(h.id, h.now())).toBe(false);
    expect(h.parks.get(h.id)).toBeNull();

    // A later refusal starts a fresh streak at 30 s with a fresh alert.
    h.advance(1000);
    await proveSpinDrawWithParking(h.deps());
    expect(h.parks.get(h.id)!.strikes).toBe(1);
    expect(h.parks.parkedUntil(h.id, h.now())).toBe(h.now() + SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS);
    expect(h.alerts).toHaveLength(2);
  });

  it('is granted immediately when the authority never refused', async () => {
    const h = harness([granted]);
    const result = await proveSpinDrawWithParking(h.deps());
    expect(result.ok).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.alerts).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });

  it('treats a malformed ok payload as transient, never as a receipt', async () => {
    const h = harness([granted, granted, granted]);
    const deps = h.deps();
    deps.readReceipt = () => {
      throw new Error('funded receipt shape rejected');
    };
    const result = await proveSpinDrawWithParking(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('transient');
    expect(result.reason).toBe('funded receipt shape rejected');
    expect(h.calls).toHaveLength(3);
  });
});

describe('the lifecycle fence', () => {
  it('propagates the abort untouched and parks nothing', async () => {
    const h = harness([refused('launch_lease_lost')]);
    const deps = h.deps();
    deps.callDraw = async () => {
      h.abort();
      return refused('launch_lease_lost');
    };
    await expect(proveSpinDrawWithParking(deps)).rejects.toBeInstanceOf(AbortedForTest);
    expect(h.parks.size).toBe(0);
    expect(h.alerts).toHaveLength(0);
  });
});

describe('the registry', () => {
  it('forgets an entry idle past twice the cap, so strikes reset for a board that came back', () => {
    const parks = new SpinLaunchParkRegistry();
    let now = 1_000_000;
    parks.park('t1', 'invalid_spin_contract', 'terminal', now, () => 0);
    parks.park('t2', 'invalid_spin_contract', 'terminal', now, () => 0);
    now += 2 * SPIN_LAUNCH_PARK_CAP_MS + 1;
    expect(parks.isParked('t1', now)).toBe(false);
    const again = parks.park('t2', 'invalid_spin_contract', 'terminal', now, () => 0);
    expect(again.park.strikes).toBe(1);
    expect(again.firstForReason).toBe(true);
    expect(parks.get('t1')).toBeNull();
  });

  it('drops a park whose tournament has left the REGISTERING board, and keeps one written after the read', () => {
    const parks = new SpinLaunchParkRegistry();
    const readAt = 1_000_000;
    parks.park('completed', 'invalid_spin_contract', 'terminal', readAt - 10, () => 0);
    parks.park('cancelled', 'spin_field_unproven', 'terminal', readAt - 10, () => 0);
    parks.park('still-registering', 'spin_field_unproven', 'terminal', readAt - 10, () => 0);
    // Parked AFTER the board was read: the board it is absent from is older
    // than the park, so it is not judged by it.
    parks.park('created-mid-pass', 'invalid_spin_contract', 'terminal', readAt + 10, () => 0);

    const dropped = parks.retain(new Set(['still-registering']), readAt);

    expect(dropped).toBe(2);
    expect(parks.get('completed')).toBeNull();
    expect(parks.get('cancelled')).toBeNull();
    expect(parks.get('still-registering')).not.toBeNull();
    expect(parks.get('created-mid-pass')).not.toBeNull();
    expect(parks.size).toBe(2);
  });

  it('counts the parked launches and ages the oldest streak from its first strike, for /metrics and /health', () => {
    const parks = new SpinLaunchParkRegistry();
    expect(parks.metrics(0)).toEqual({ parked: 0, terminal: 0, oldestAgeMs: 0 });

    parks.park('t1', 'invalid_spin_contract', 'terminal', 1_000, () => 0);
    parks.park('t2', 'launch_lease_lost', 'transient', 2_000, () => 0);
    // A second strike on t1 renews the window but not the streak's start.
    parks.park('t1', 'invalid_spin_contract', 'terminal', 31_000, () => 0);

    expect(parks.metrics(32_000)).toEqual({ parked: 1, terminal: 1, oldestAgeMs: 31_000 });
    // Inside both windows.
    expect(parks.metrics(3_000)).toEqual({ parked: 2, terminal: 1, oldestAgeMs: 2_000 });
    // Every window closed: nothing is parked, nothing is old.
    expect(parks.metrics(200_000)).toEqual({ parked: 0, terminal: 0, oldestAgeMs: 0 });
    // An ok clears the streak, so the age starts over on the next strike.
    parks.clear('t1');
    parks.park('t1', 'invalid_spin_contract', 'terminal', 300_000, () => 0);
    expect(parks.metrics(300_500).oldestAgeMs).toBe(500);
  });

  it('reports only live parks in its snapshot', () => {
    const parks = new SpinLaunchParkRegistry();
    parks.park('t1', 'invalid_spin_contract', 'terminal', 0, () => 0);
    parks.park('t2', 'launch_lease_lost', 'transient', 0, () => 0);
    expect(
      parks
        .snapshot(1)
        .map((p) => p.tournamentId)
        .sort()
    ).toEqual(['t1', 't2']);
    expect(parks.snapshot(6_000).map((p) => p.tournamentId)).toEqual(['t1']);
    expect(parks.snapshot(31_000)).toEqual([]);
  });
});

/**
 * The wiring. A registry nobody consults is a registry, not a fix: the draw
 * path must go through the classified loop, and every start door must ask
 * the registry before it restarts a manager.
 */
describe('the wiring', () => {
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const BASE = code(readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8'));
  const SERVER = code(readFileSync(join(here, '..', 'GameServer.ts'), 'utf8'));

  it('the manager proves the draw through the classified loop and nowhere else', () => {
    expect(BASE).toContain("import { proveSpinDrawWithParking } from './spinLaunchParking.js';");
    expect(BASE).toContain("import { raiseFinancialAlert } from '../services/financialAlerts.js';");
    const site = BASE.indexOf("supabase.rpc('fn_spin_draw_and_settle_atomic'");
    expect(site).toBeGreaterThan(0);
    expect(BASE.lastIndexOf("supabase.rpc('fn_spin_draw_and_settle_atomic'")).toBe(site);
    const call = BASE.lastIndexOf('proveSpinDrawWithParking<FundedSpinDraw>({', site);
    expect(call).toBeGreaterThan(0);
    expect(site - call).toBeLessThan(400);
    // The whole call, however many deps it grows: bounded by its closing paren.
    expect(sliceCall(BASE, 'proveSpinDrawWithParking<FundedSpinDraw>(')).toContain(
      'raiseAlert: raiseFinancialAlert'
    );
    // The hand-rolled three-attempt loop is gone.
    expect(BASE).not.toContain('attempt <= 3 && !fundedSpin');
  });

  it('the fast lane skips a parked id before it stops or starts anything', () => {
    expect(SERVER).toContain(
      "import { spinLaunchParks } from './tournament/spinLaunchParking.js';"
    );
    const lane = SERVER.indexOf('private async discoverSeatFirstStarts(');
    expect(lane).toBeGreaterThan(0);
    const gate = SERVER.indexOf('if (spinLaunchParks.isParked(id)) continue;', lane);
    const stop = SERVER.indexOf("'GameServer.seat_first_fast_stale_manager_stop_failed'", lane);
    const start = SERVER.indexOf("'GameServer.seat_first_fast_start_failed'", lane);
    expect(gate).toBeGreaterThan(lane);
    expect(gate).toBeLessThan(stop);
    expect(stop).toBeLessThan(start);
  });

  it('the main discovery loop bounds the registry to the REGISTERING board it just read', () => {
    const loop = SERVER.indexOf('private async discoverTournaments(');
    expect(loop).toBeGreaterThan(0);
    const readAt = SERVER.indexOf('const registeringReadAt = Date.now();', loop);
    const read = SERVER.indexOf(".eq('status', 'REGISTERING')", loop);
    const retain = SERVER.indexOf(
      'spinLaunchParks.retain(stillRegistering, registeringReadAt);',
      loop
    );
    expect(readAt).toBeGreaterThan(loop);
    expect(readAt).toBeLessThan(read);
    expect(retain).toBeGreaterThan(read);
  });

  it('the fully-paid stall watchdog leaves a parked id alone without dropping its clock', () => {
    // The loop body the watchdog judges each fully-paid game in, bounded by
    // its own braces.
    const body = sliceEnclosingBlock(SERVER, "'GameServer.seat_first_fully_paid_never_started'");
    const gate = body.indexOf('if (spinLaunchParks.isParked(id, stallNow)) continue;');
    const armed = body.indexOf('this.seatFirstFullSince.set(id, stallNow);');
    const report = body.indexOf("'GameServer.seat_first_fully_paid_never_started'");
    expect(gate).toBeGreaterThan(0);
    // The gate sits after the clock is armed and before the force-start is reported.
    expect(gate).toBeGreaterThan(armed);
    expect(gate).toBeLessThan(report);
  });

  it('an operator can see a parked Spin on /metrics and /health without reading logs', () => {
    const scrape = SERVER.indexOf('getPrometheusMetrics(): string {');
    expect(scrape).toBeGreaterThan(0);
    for (const gauge of [
      'poker_spin_launches_parked',
      'poker_spin_launches_parked_terminal',
      'poker_spin_launch_park_oldest_age_ms',
    ]) {
      expect(SERVER.indexOf(`# TYPE ${gauge} gauge`, scrape)).toBeGreaterThan(scrape);
      expect(SERVER.indexOf(`\`${gauge} \${parks.`, scrape)).toBeGreaterThan(scrape);
    }
    const status = SERVER.indexOf('\n  getStatus(');
    expect(status).toBeGreaterThan(0);
    const field = SERVER.indexOf('spinLaunchParks: (() => {', status);
    expect(field).toBeGreaterThan(status);
    expect(field).toBeLessThan(scrape);
    // The field's own IIFE, bounded by the paren that wraps it.
    expect(sliceCall(SERVER, 'spinLaunchParks: (() => {')).toContain('oldestAgeMs: m.oldestAgeMs');
  });

  it('the one admission front door refuses a parked start, so the watchdog and the main loop hold too', () => {
    const door = SERVER.indexOf('private ensureTournamentManagerAdmission(');
    expect(door).toBeGreaterThan(0);
    const gate = SERVER.indexOf(
      "if (mode === 'start' && spinLaunchParks.isParked(tournamentId))",
      door
    );
    const perform = SERVER.indexOf('this.performTournamentManagerAdmission(', door);
    expect(gate).toBeGreaterThan(door);
    expect(gate).toBeLessThan(perform);
  });
});
