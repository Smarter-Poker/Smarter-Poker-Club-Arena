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
