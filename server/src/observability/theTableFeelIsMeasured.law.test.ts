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
import { sliceYamlEntry } from '../testHelpers/sourceWindow.js';

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
    const horseAt = turns.indexOf('handControllerRef.performAction(seat, action as any, amount)');
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
