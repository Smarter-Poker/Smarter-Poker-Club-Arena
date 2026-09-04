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

  it('the engine observes the fleet twin wherever it observes the gated one', () => {
    const eng = readFileSync(join(ROOT, 'server', 'src', 'engine', 'ServerTableEngine.ts'), 'utf8');
    const turns = readFileSync(
      join(ROOT, 'server', 'src', 'engine', 'ServerTableEngineTurns.ts'),
      'utf8'
    );
    expect(eng).toContain('actToBroadcastFleet.observe(');
    expect(eng).toMatch(/audience: this\.humansSeated\(\) > 0 \? 'human' : 'horse'/);
    expect(turns).toContain('actionsFleetTotal.inc(');
  });
});

describe('LAW 3 - the alert reads the human series and respects the break', () => {
  it('two rules, human audience, break-guarded', () => {
    const rules = readFileSync(join(ROOT, 'infra', 'monitoring', 'alert-rules.yml'), 'utf8');
    for (const name of ['ActionLatencyDegraded', 'ActionLatencyCritical']) {
      const at = rules.indexOf(`alert: ${name}`);
      expect(at, name).toBeGreaterThan(0);
      const block = rules.slice(at, at + 900);
      expect(block).toContain('poker_act_to_broadcast_ms_bucket{audience="human"}');
      expect(block).toContain('poker_maintenance_break_active');
    }
  });
});
