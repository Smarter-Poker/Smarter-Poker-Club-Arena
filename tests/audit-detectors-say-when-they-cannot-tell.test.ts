import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two audit detectors used to answer confidently when they could not tell,
 * and both would have gone on doing it every single day (CLAUDE.md 10.86:
 * "I could not tell" is a distinct outcome and must have its own name;
 * 10.84: an alarm that is always on is an alarm that gets muted).
 *
 *  - fn_audit_layer_silence blamed the brain for v18_straddle firing zero
 *    times. Ruling R2 retired the straddle lane on cash games, so the layer
 *    has no stage to fire on. Measured 2026-09-07: 0 live cash tables carry
 *    straddle_enabled, all 99 that do are closed.
 *  - fn_audit_tuner_health read horse_self_tune_log for p_day + 1 and called
 *    an empty result "the leak profiles did not move". The audit for day D
 *    runs ~06:05Z on D+1; the tuner writes ~09:00Z on D+1. It was reporting
 *    a race as a defect.
 */
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20260907101200_the_audit_tells_a_retired_lane_from_a_silent_one_and_does_no.sql'
  ),
  'utf8'
);

describe('the audit tells a retired lane from a silent one', () => {
  it('counts the straddle stage instead of assuming it', () => {
    expect(MIGRATION).toContain('select count(*) into v_straddle_stage');
    expect(MIGRATION).toMatch(
      /from tables\s+where straddle_enabled\s+and tournament_id is null\s+and status in \('running','waiting'\)/
    );
  });

  it('reports a stageless v18_straddle as retired, not as silent', () => {
    expect(MIGRATION).toMatch(/if feat\.feature = 'v18_straddle' and v_straddle_stage = 0 then/);
    expect(MIGRATION).toContain("'code','layer_retired'");
    expect(MIGRATION).toContain("'severity','note','category','logic','code','layer_retired'");
  });

  it('names the ruling that removed the stage, so nobody re-wires the flag', () => {
    expect(MIGRATION).toContain('R2 retired the straddle lane on cash games');
    expect(MIGRATION).toContain('fn_cash_apply_ruleset forces straddle_enabled = false');
  });

  it('keeps the warn for every other layer, and for a straddle table that IS live', () => {
    // The layer_silent branch survives - this is a narrowing, not a deletion.
    expect(MIGRATION).toContain("'code','layer_silent'");
    expect(MIGRATION).toContain('Deployed layer ' + "' || feat.feature || '" + ' fired ZERO times');
    // Every watched layer is still in the list.
    for (const feature of [
      'preflop_v7',
      'v15_nut_status',
      'banded_mc_omaha',
      'banded_mc_nlh',
      'icm_real',
      'v16_hu_overlay',
      'v15_eq_capped',
      'v16_reads_cbet',
      'v16_sizecond_bigbet',
      'v16_reads_f3b',
      'v16_reads_tell',
      'v17_pos_behind',
      'v17_river_probe',
      'v17_catch_block',
      'v17_short_deck',
      'v18_straddle',
      'v18_self_image',
      'v18_exploit_size',
      'v19_overbet_polarity',
      'v19_river_bigbet_cap',
    ]) {
      expect(MIGRATION).toContain(`('${feature}',`);
    }
  });

  it('leaves telemetry_dark alone - a dark day still knows nothing about any layer', () => {
    expect(MIGRATION).toContain("'code','telemetry_dark'");
    expect(MIGRATION).toContain('if v_decides < 1000 then');
  });
});

describe('the audit does not race the tuner it is grading', () => {
  it('asks whether the tuner claimed the day before judging an empty result', () => {
    expect(MIGRATION).toMatch(
      /select exists \(\s*select 1 from horse_job_runs\s+where job = 'self_tuner' and run_date = v_run\s*\) into v_claimed;/
    );
  });

  it('an unclaimed day is a note that says nothing is known, not a warn', () => {
    expect(MIGRATION).toContain("'code','tuner_not_yet_run'");
    expect(MIGRATION).toContain("'severity','note','category','logic','code','tuner_not_yet_run'");
    expect(MIGRATION).toContain('its health is unknown');
    // It must not read as a clean bill of health either.
    expect(MIGRATION).toContain('Not a defect and not a clean bill of health');
  });

  it('a claimed day that wrote nothing keeps the original warn', () => {
    expect(MIGRATION).toContain("'code','tuner_no_rows'");
    expect(MIGRATION).toContain("'severity','warn','category','logic','code','tuner_no_rows'");
    expect(MIGRATION).toContain('claimed ' + "' || v_run || '" + ' and wrote no rows');
  });

  it('still studies the day after the audited day - the date was never the bug', () => {
    expect(MIGRATION).toContain('v_run date := p_day + 1;');
  });

  it('keeps the three tuner verdicts that follow a non-empty run', () => {
    expect(MIGRATION).toContain("'code','tuner_regressed_the_fleet'");
    expect(MIGRATION).toContain("'code','tuner_tightened_the_fleet'");
    expect(MIGRATION).toContain("'code','tuner_studied_from_stream'");
    expect(MIGRATION).toContain('v := v || fn_audit_fleet_drop_identity(p_day);');
  });
});

describe('the migration obeys the production DDL policy', () => {
  it('wraps all of its DDL in one transaction', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIGRATION.indexOf('BEGIN;')).toBeLessThan(MIGRATION.indexOf('CREATE OR REPLACE'));
  });

  it('changes exactly the two audit functions and nothing else', () => {
    const created = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [];
    expect(created).toEqual([
      'CREATE OR REPLACE FUNCTION public.fn_audit_layer_silence',
      'CREATE OR REPLACE FUNCTION public.fn_audit_tuner_health',
    ]);
    expect(MIGRATION).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|COLUMN)\b/i);
  });

  it('leaves neither definer function reachable by a caller with no account', () => {
    for (const fn of ['fn_audit_layer_silence', 'fn_audit_tuner_health']) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}(date) FROM PUBLIC, anon, authenticated;`
      );
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(date) TO service_role;`);
    }
  });
});
