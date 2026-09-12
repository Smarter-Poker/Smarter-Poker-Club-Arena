/**
 * LAW: THE TABLE'S FEEL IS MEASURED (Realtime programme Phase 1, 2026-09-04)
 *
 * poker_act_to_broadcast_latency_ms - the time from a player's action being
 * accepted to every seat seeing it - was recorded for months and scraped
 * never: it lives in the ENGINE_METRICS-gated registry, which is off in
 * production (engine-01 /metrics carried zero lines of it on 2026-09-04).
 * So nobody could say whether a Call took 40 ms or 400 ms, or whether a
 * deploy made it worse.
 *
 * PINS
 *   1. The always-on registry carries poker_act_to_broadcast_ms and
 *      poker_actions_fleet_total, and GameServer renders it on every scrape.
 *   2. Two series, not two hundred: audience=human|horse. Never table_id.
 *   3. The alert reads the HUMAN series - a fleet p95 is a horse number.
 *   4. Observing never throws, and the exposition is valid Prometheus text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actToBroadcastFleet,
  actionsFleetTotal,
  alwaysOnPrometheusLines,
} from './engineInstruments.js';
import { sliceYamlEntry, sliceMethod } from '../testHelpers/sourceWindow.js';
import { deriveContext, seatsAtOneTable } from '../services/TournamentBrainContext.js';

const ROOT = join(__dirname, '..', '..', '..');

describe('LAW 1/2/4 - the always-on registry', () => {
  it('renders both instruments with only the audience label', () => {
    actToBroadcastFleet.observe(42, { audience: 'human' });
    actToBroadcastFleet.observe(1200, { audience: 'horse' });
    actionsFleetTotal.inc(1, { audience: 'human' });
    const text = alwaysOnPrometheusLines().join('\n');
    expect(text).toContain('# TYPE poker_act_to_broadcast_ms histogram');
    expect(text).toMatch(/poker_act_to_broadcast_ms_bucket\{[^}]*audience="human"[^}]*le="50"\} 1/);
    expect(text).toMatch(/poker_act_to_broadcast_ms_count\{audience="horse"\} 1/);
    expect(text).toMatch(/poker_actions_fleet_total\{audience="human"\} 1/);
    expect(text).not.toContain('table_id=');
  });

  it('GameServer renders it on the always-on exposition, not the gated one', () => {
    const gs = readFileSync(join(ROOT, 'server', 'src', 'GameServer.ts'), 'utf8');
    expect(gs).toContain('...alwaysOnPrometheusLines()');
  });

  it('a hand ending disarms the clock: the gap between hands is not latency', () => {
    const eng = readFileSync(join(ROOT, 'server', 'src', 'engine', 'ServerTableEngine.ts'), 'utf8');
    const idleAt = eng.indexOf('if (!this.handController) {');
    expect(idleAt).toBeGreaterThan(0);
    const idleBlock = eng.slice(idleAt, eng.indexOf('this.publishIdleState();', idleAt));
    expect(idleBlock).toContain('this.lastActionAcceptedAtMs = 0;');
  });

  it('the engine observes the fleet twin wherever it observes the gated one', () => {
    const eng = readFileSync(join(ROOT, 'server', 'src', 'engine', 'ServerTableEngine.ts'), 'utf8');
    const turns = readFileSync(
      join(ROOT, 'server', 'src', 'engine', 'ServerTableEngineTurns.ts'),
      'utf8'
    );
    expect(eng).toContain('actToBroadcastFleet.observe(');
    expect(eng).toMatch(/audience: this\.humansSeated\(\) > 0 \? 'human' : 'horse'/);
    expect(turns).toContain('actionsFleetTotal.inc(');
    // A horse's action is timed like a human's (CLAUDE.md 10.5). The horse
    // path calls handController.performAction directly and bypasses
    // _handlePlayerActionInner, so the clock must be started there too -
    // verified on production 2026-09-04: before this, zero samples with no
    // human seated.
    const horseAt = turns.search(
      /handControllerRef\.performAction\(\s*seat,\s*action as any,\s*amount,/
    );
    expect(horseAt).toBeGreaterThan(0);
    const afterHorse = turns.slice(horseAt);
    expect(afterHorse.indexOf('this.lastActionAcceptedAtMs = Date.now()')).toBeGreaterThan(0);
    expect(afterHorse.indexOf('actionsFleetTotal.inc(')).toBeGreaterThan(0);

    // AUDIT 2026-09-05: the instrumentation must sit BELOW the check/fold
    // degrade, not above it. Above it, a horse whose intended action was
    // rejected still reached the felt through the fallback and was neither
    // counted nor timed - a silent hole in the horse series, and unequal
    // treatment (CLAUDE.md 10.5). Keying on the same `applied` that
    // markProgress() uses is what makes it whichever-attempt-landed.
    const degradeAt = afterHorse.indexOf("performAction(seat, 'fold' as any)");
    const countAt = afterHorse.indexOf('actionsFleetTotal.inc(');
    expect(degradeAt).toBeGreaterThan(0);
    expect(
      countAt,
      'the horse counter must come AFTER the check/fold degrade, so a degraded action is still counted'
    ).toBeGreaterThan(degradeAt);
    // And it must be in the same block that marks progress.
    const progressAt = afterHorse.indexOf('this.markProgress();');
    expect(Math.abs(progressAt - countAt)).toBeLessThan(900);
  });
});

describe('LAW 7 - the clock measures action-to-broadcast, not the gap between actions', () => {
  // THE BUG THIS PINS (2026-09-05). performAction emits PLAYER_ACTION
  // synchronously and its handler calls broadcastCurrentState, so the
  // broadcast for an action happens INSIDE performAction. The clock used to
  // be armed AFTER that call, so every broadcast observed the clock left by
  // the PREVIOUS action and the histogram recorded the interval between two
  // actions. Production reported "median 808ms act-to-broadcast" for a day;
  // it was really the median turn pacing, and the event loop was healthy the
  // whole time (p99 54ms), which is what made the number look like a mystery.
  const turns = readFileSync(
    join(ROOT, 'server', 'src', 'engine', 'ServerTableEngineTurns.ts'),
    'utf8'
  );

  it('the human path arms the clock BEFORE performAction', () => {
    const seg = sliceMethod(turns, 'protected _handlePlayerActionInner');
    const arm = seg.indexOf('this.lastActionAcceptedAtMs = Date.now();');
    const act = seg.indexOf('const actionApplied = this.handController.performAction(');
    expect(arm).toBeGreaterThan(0);
    expect(act).toBeGreaterThan(0);
    expect(
      arm,
      'arming must precede performAction, or the sample is the previous action'
    ).toBeLessThan(act);
  });

  it('a rejected action does not leave a live clock behind', () => {
    const seg = sliceMethod(turns, 'protected _handlePlayerActionInner');
    expect(seg).toContain('if (!actionApplied) {');
    expect(seg).toMatch(/this\.lastActionAcceptedAtMs = actClockWasArmed;/);
  });

  it('the horse path arms before its action and restores when nothing lands', () => {
    const seg = sliceMethod(turns, 'protected scheduleHorseAction(');
    expect(seg).toContain('const horseClockWasArmed');
    const arm = seg.indexOf('this.lastActionAcceptedAtMs = Date.now();');
    const act = seg.search(/handControllerRef\.performAction\(\s*seat,\s*action as any,\s*amount,/);
    expect(arm).toBeGreaterThan(-1);
    expect(act).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(act);
    // the degrade re-arms, and total failure restores
    expect(seg).toMatch(/performAction\(\s*seat,\s*'fold' as any,\s*undefined,\s*'horse_fallback'/);
    expect(turns).toMatch(/this\.lastActionAcceptedAtMs = horseClockWasArmed;/);
  });

  it('the counter blocks no longer re-arm the clock after the broadcast', () => {
    // Both counter sites sit after the broadcast has gone out. If either one
    // arms the clock, the bug is back.
    // Bound by the method, not a byte count: within the human action method,
    // the ONLY arming may be the one before performAction.
    const human = sliceMethod(turns, 'protected _handlePlayerActionInner');
    expect(human.split('this.lastActionAcceptedAtMs = Date.now();').length - 1).toBe(1);
    const horse = sliceMethod(turns, 'protected scheduleHorseAction(');
    // Horse arms once before the action and once before the check/fold degrade.
    expect(horse.split('this.lastActionAcceptedAtMs = Date.now();').length - 1).toBe(2);
  });
});

describe('LAW 5 - every format is measured, not just cash (Dan 2026-09-05)', () => {
  it('both instruments carry a format label at every observation site', () => {
    const eng = readFileSync(join(ROOT, 'server', 'src', 'engine', 'ServerTableEngine.ts'), 'utf8');
    const turns = readFileSync(
      join(ROOT, 'server', 'src', 'engine', 'ServerTableEngineTurns.ts'),
      'utf8'
    );
    // The human HTTP path, the horse path, and the latency observation.
    expect(turns.split('format: this.tableFormat()').length - 1).toBe(2);
    expect(eng.split('format: this.tableFormat()').length - 1).toBe(1);
  });

  it('tableFormat derives cash, spin, heads-up and mtt - and never guesses cash', () => {
    const base = readFileSync(
      join(ROOT, 'server', 'src', 'engine', 'ServerTableEngineBase.ts'),
      'utf8'
    );
    expect(base).toMatch(/protected tableFormat\(\): 'cash' \| 'spin' \| 'hu_sng' \| 'mtt'/);
    // A tournament whose context has not loaded must NOT fall back to 'cash' -
    // that would file Spins and MTTs under cash and hide exactly what Dan
    // asked to be able to see.
    const fn = base.slice(
      base.indexOf('protected tableFormat()'),
      base.indexOf('protected isTournamentTable()')
    );
    expect(fn).toContain("return 'cash';");
    expect(fn).toMatch(/ctx\?\.format \?\? 'mtt'/);
    expect(fn.split("return 'cash'").length - 1).toBe(1);
  });

  it('the shared derivation really does separate spin, heads-up and mtt', () => {
    const row = (o: Record<string, unknown>) =>
      ({
        id: 't',
        tournament_type: null,
        variant: null,
        starting_stack: 1000,
        ...o,
      }) as never;
    expect(deriveContext(row({ tournament_type: 'SPIN' }), 2, 3, 3000).format).toBe('spin');
    expect(deriveContext(row({ variant: 'spin' }), 2, 3, 3000).format).toBe('spin');
    // Heads-up is derived from seats at one table, not from a type string.
    expect(seatsAtOneTable({ table_size: 2 })).toBe(2);
    expect(seatsAtOneTable({})).toBe(9);
    expect(deriveContext(row({ tournament_type: 'SNG', table_size: 2 }), 2, 2, 2000).format).toBe(
      'hu_sng'
    );
    expect(
      deriveContext(row({ tournament_type: 'MTT', table_size: 9 }), 50, 200, 200000).format
    ).toBe('mtt');
  });

  it('the alerts group by format, so a slow Spin cannot hide inside a cash average', () => {
    const rules = readFileSync(join(ROOT, 'infra', 'monitoring', 'alert-rules.yml'), 'utf8');
    for (const name of ['ActionLatencyDegraded', 'ActionLatencyCritical']) {
      const block = sliceYamlEntry(rules, `alert: ${name}`);
      expect(block, name).toContain('sum by (le, format)');
      expect(block, name).toContain('sum by (format)');
      expect(block, name).toContain('{{ $labels.format }}');
    }
  });
});

describe('LAW 6 - the thresholds come from the measurement, and one action cannot alarm', () => {
  // Measured on production 2026-09-05, first hour of real data, 24.3 actions/s:
  //   p50 808ms   p90 1541ms   p95 1843ms   p99 3755ms
  // The first version of these rules guessed 500ms/1500ms before any data
  // existed - below the MEDIAN and below the normal p95 respectively, so both
  // would have fired permanently and been muted, which is the exact failure
  // this programme keeps finding in other people's monitors.
  const rules = readFileSync(join(ROOT, 'infra', 'monitoring', 'alert-rules.yml'), 'utf8');

  it('warning sits above the normal p95, critical is unambiguous', () => {
    const deg = sliceYamlEntry(rules, 'alert: ActionLatencyDegraded');
    const crit = sliceYamlEntry(rules, 'alert: ActionLatencyCritical');
    const degMs = Number(deg.match(/\)\s*>\s*(\d+)/)![1]);
    const critMs = Number(crit.match(/\)\s*>\s*(\d+)/)![1]);
    expect(degMs, 'warning must sit above the measured p95 of 1843ms').toBeGreaterThan(1843);
    expect(critMs, 'critical must sit above the measured p99 of 3755ms').toBeGreaterThan(3755);
    expect(critMs).toBeGreaterThan(degMs);
  });

  it('a single human action cannot raise a p95 alarm', () => {
    // Humans are rare here: 15 hours with a human seat in 14 days. With a
    // `> 0` guard, ONE action in the window produced a p95 from a sample of
    // one and could page on it.
    for (const name of ['ActionLatencyDegraded', 'ActionLatencyCritical']) {
      const block = sliceYamlEntry(rules, `alert: ${name}`);
      const guard = block.match(/ms_count\{audience="human"\}\[10m\]\)\)\s*>\s*([\d.]+)/);
      expect(guard, `${name} must guard on a minimum action rate`).not.toBeNull();
      expect(Number(guard![1]), `${name} guard must be more than a single sample`).toBeGreaterThan(
        0
      );
    }
  });
});

describe('LAW 3 - the alert reads the human series and respects the break', () => {
  it('two rules, human audience, break-guarded', () => {
    const rules = readFileSync(join(ROOT, 'infra', 'monitoring', 'alert-rules.yml'), 'utf8');
    for (const name of ['ActionLatencyDegraded', 'ActionLatencyCritical']) {
      // Bounded by the rule's own YAML entry, never by a byte count.
      const block = sliceYamlEntry(rules, `alert: ${name}`);
      expect(block, name).toContain('poker_act_to_broadcast_ms_bucket{audience="human"}');
      expect(block, name).toContain('poker_maintenance_break_active');
    }
  });
});
