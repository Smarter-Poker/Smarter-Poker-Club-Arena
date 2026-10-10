/**
 * A RESOLVED REFUSAL IS NOT AN OPEN REFUSAL (2026-09-27).
 *
 * `fn_ca_hand_commit_refusals` counts public.financial_alerts rows for
 * source = 'ServerTableEngine.authoritative_hand_semantic_refusal' inside its
 * rolling window, but never checked whether the row was `resolved`. Measured
 * 2026-09-27: 6,657 of 6,663 rows of this source were already resolved (0
 * inconsistent against resolved_at), most proven by their own resolution text
 * to have moved no chips. ca_drift_incidents 07d0babb restated exactly the 68
 * refusals of 2026-09-26 15:06-15:07 UTC - every one already resolved - as a
 * fresh finding, because the 2026-09-10 watermark
 * (a_detector_does_not_report_what_it_already_answered_for) narrows WHEN the
 * detector looks, not WHETHER a row it is looking at was already answered. A
 * row resolved between sweeps moves no correction_ref for this detector's own
 * incident, so the watermark never advances and the same healed refusal keeps
 * counting until it ages out of the 24h window on its own.
 *
 * THE RULE: the detector also requires `a.resolved = false`. A refusal proven
 * to have moved no chips is not an open finding for a sweep that reports open
 * problems. The floor of 25, the rolling window, and the 2026-09-10 watermark
 * are unchanged - this narrows WHICH rows count, never WHEN it looks or HOW
 * LOUD it must be.
 *
 * docs/changelog/2026-09-27-a-resolved-refusal-is-not-an-open-refusal.md
 */
import { describe, it, expect } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const NAME = '20260927160903_a_resolved_refusal_is_not_an_open_refusal.sql';

const migration = () => {
  const hit = migrationCorpus().find((m) => m.name === NAME);
  expect(hit, `${NAME} must exist`).toBeDefined();
  return hit!.sql;
};

describe('a resolved refusal is not an open refusal', () => {
  it('the detector excludes resolved financial_alerts rows', () => {
    const sql = migration();
    expect(sql).toContain(
      "WHERE a.source = ''ServerTableEngine.authoritative_hand_semantic_refusal''"
    );
    expect(sql).toContain('AND a.resolved = false');
  });

  it('the floor, rolling window and 2026-09-10 watermark all survive', () => {
    const sql = migration();
    expect(sql).toContain('the refusal detector lost its floor of 25');
    expect(sql).toContain('the refusal detector lost its rolling window');
    expect(sql).toContain('the refusal detector lost its 2026-09-10 correction watermark');
  });

  it('the substitution is asserted exactly once, never guessed', () => {
    const sql = migration();
    expect(sql).toContain('the refusal detector carries % source-anchor(s), expected 1');
  });

  it('a genuinely unresolved refusal is proved to still count', () => {
    const sql = migration();
    // the migration checks `resolved = false` against `NOT a.resolved` before
    // trusting the filter, so a NULL-handling regression in the column cannot
    // silently turn the filter into a silence
    expect(sql).toContain('resolved is not a plain boolean on financial_alerts');
    expect(sql).toContain('those are genuinely open and the incident stays as-is');
  });
});
