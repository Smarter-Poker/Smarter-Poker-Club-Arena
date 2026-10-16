import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * LAW: A LAYER COLLAPSE IS MEASURED AGAINST THE LAYER'S OWN POPULATION
 * (2026-09-28).
 *
 * fn_audit_layer_drift section 2 used to divide every layer by fleet-wide
 * decides. A shift in table mix then "collapsed" every layer of every
 * shrinking variant at once: 113 of 135 warns on 2026-09-27, while the FLH
 * layers it named fired MORE reliably per FLH hand (98.5%) than the day
 * before. The flood hid a real V15 decay the same day.
 *
 * Replayed read-only on 2026-09-23..27, the rule below reported 4/23/4/9/10
 * collapse warns where the old one reported 14/50/5/21/113.
 *
 * This reads the NEWEST migration that defines the function, so a later
 * rewrite that goes back to fleet decides fails here.
 */
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'supabase/migrations');
const DEFINES = 'CREATE OR REPLACE FUNCTION public.fn_audit_layer_drift(';

function newestDefinition(): { file: string; sql: string } {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = fs.readFileSync(path.join(DIR, files[i]), 'utf8');
    if (sql.includes(DEFINES)) return { file: files[i], sql };
  }
  throw new Error('no migration defines fn_audit_layer_drift');
}

function collapseSection(sql: string): string {
  const at = sql.indexOf('-- 2. A layer that collapsed without going silent');
  expect(at, 'section 2 of fn_audit_layer_drift is missing').toBeGreaterThan(-1);
  return sql.slice(at);
}

describe('layer_fire_collapse reads each layer against its own population', () => {
  const { sql } = newestDefinition();
  const s2 = collapseSection(sql);

  it('does not judge population counters as layers', () => {
    expect(s2).toContain("when feature ~ '^decide(_|$)'");
    expect(s2).toContain("or feature ~ '^phase[0-9]+_(variant|format|objective)_'");
    expect(s2).toContain("or feature ~ '_seen$' then null");
  });

  it('divides variant-scoped counters by their variant', () => {
    expect(s2).toContain("'\\1_variant_\\2'");
    expect(s2).toContain("when feature ~ '^v15_' then 'decide_omaha'");
  });

  it('divides cash counters by cash decisions, not the whole fleet', () => {
    expect(s2).toContain("when '#cash'   then x.decide - x.tourn");
    expect(s2).toContain("when feature ~ '^phase13_' then '#cash'");
  });

  it('suppresses a layer whose own population fell at least as far', () => {
    expect(s2).toMatch(
      /and not \(p\.prev_den is not null and p\.prev_fires > 0\s+and c\.cur_den \/ p\.prev_den <= c\.cur_fires \/ p\.prev_fires\)/
    );
  });

  it('names the denominator it used, so a reader can check the ratio', () => {
    expect(s2).toContain("'denominator', r.den_key");
    expect(s2).toContain("'denominator_today', r.cur_den");
  });

  it('does not judge a lane reason / refusal / miss breakdown as a layer (2026-10-05)', () => {
    // Every phaseN decision notes one *_reason_*, the V44 second look one
    // v44_declined_* per refusal. A drop in one is a shift inside the lane;
    // on 2026-10-03 thirty-six of them read as collapses. The lane is judged
    // on its own *_fired / *_eligible counters instead.
    expect(s2).toContain("when feature ~ '(_reason_|unavailable|_skip_|_miss_|^v44_declined_)'");
    expect(s2).toContain('or feature = any(v_fallback_exact) then null');
    // ...and the layers themselves are still judged.
    expect(s2).not.toMatch(/_fired[^\n]*then null/);
  });

  it('measures the river showdown reads per cash decision (2026-10-05)', () => {
    expect(s2).toContain("when feature in ('v43_tempo_read', 'v16_reads_tell') then '#cash'");
  });

  it('keeps the step-must-be-new and must-have-fallen guards', () => {
    expect(s2).toContain('and (p.prev_rate is null or p.prev_rate >= b.med_rate * 0.40)');
    expect(s2).toContain('and (p.prev_fires is null or c.cur_fires < p.prev_fires)');
  });
});

/**
 * 2026-10-16: section 1 (layer_went_silent) raised about 110 warns on
 * 2026-10-15 and none was a layer that stopped: renamed or retired reason
 * codes, and reason / refusal / population counters. A retired key the
 * engine registers in horse_data_ledger (receipt, legacy_unused) is reported
 * as one info line, and the counters section 2 already does not judge as
 * layers are reported as one info line, never one warn each.
 */
describe('layer_went_silent reads retired and outcome counters for what they are', () => {
  const { sql } = newestDefinition();
  const at = sql.indexOf(DEFINES);
  const s1 = sql.slice(at, sql.indexOf('-- 2. A layer that collapsed without going silent', at));

  it('skips a key the engine registered as retired, and lists it once', () => {
    expect(s1).toContain("where l.kind = 'receipt' and l.cadence = 'legacy_unused'");
    expect(s1).toContain("and split_part(l.key, ':', 2) = r.feature");
    expect(s1).toContain("'code', 'retired_counters_quiet'");
  });

  it('reports reason, refusal and population counters as one info line, with the section 2 patterns', () => {
    expect(s1).toContain(
      "or r.feature ~ '(_reason_|unavailable|_skip_|_miss_|^v44_declined_)' then"
    );
    expect(s1).toContain("if r.feature ~ '^decide(_|$)'");
    expect(s1).toContain("'code', 'outcome_counters_quiet'");
    // a real layer still warns
    expect(s1).toContain("'code', 'layer_went_silent'");
  });

  it('judges the named fallbacks before the outcome patterns (gto_miss_ is a fallback)', () => {
    expect(s1.indexOf('v_is_fallback := r.feature')).toBeLessThan(
      s1.indexOf("or r.feature ~ '(_reason_|unavailable")
    );
  });
});
