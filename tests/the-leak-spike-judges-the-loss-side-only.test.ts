import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The daily audit's leak-spike loop judged the `_won` WIN mirrors as if they
 * were leaks. On 2026-10-30 plo_set_stackoff_won (268 tags, every sampled hand
 * a win) was raised as a CRITICAL leak_tag_spike beside its loss side,
 * plo_set_stackoff. The loss side is judged under its own name and the mirrored
 * EV already pairs both outcomes, so the mirror must never enter the loop.
 */
const ROOT = path.resolve(__dirname, '..');
const FILE = 'supabase/migrations/20261031200256_leak_spike_judges_the_loss_side_only.sql';
const MIGRATION = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

describe('the leak spike judges the loss side only', () => {
  it('excludes the _won mirrors from the spike loop', () => {
    expect(MIGRATION).toMatch(/where d\.cnt >= 20\s+(--[^\n]*\n\s*)*and d\.tag not like '%\\_won'/);
  });

  it('replaces only the body it was written against', () => {
    expect(MIGRATION).toContain("IS DISTINCT FROM 'f7bcaef328aa885d8f9a4dd99603c6be'");
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
  });

  it('keeps every spike verdict and the mirrored-EV pairing', () => {
    for (const code of [
      "'code','leak_tag_spike'",
      "'code','leak_tag_spike_positive_ev'",
      "'code','leak_tag_spike_unresolved'",
      "'code','leak_tag_detector_new'",
      'from fn_horse_tag_ev(p_day - 6) e',
    ]) {
      expect(MIGRATION).toContain(code);
    }
  });

  it('is the latest definition of fn_run_horse_daily_audit', () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const defining = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        /CREATE OR REPLACE FUNCTION\s+(public\.)?fn_run_horse_daily_audit\s*\(/i.test(
          fs.readFileSync(path.join(dir, f), 'utf8')
        )
      )
      .sort();
    expect(defining[defining.length - 1]).toBe(path.basename(FILE));
  });
});
