/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ZERO IS NOT SUCCESS — the rake attribution watchdog can see its own blind spot
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found by the 2026-08-31 spins end-to-end audit, in production data rather
 * than in code.
 *
 * `fn_settle_tournament_rake` banks a tournament's rake and then calls
 * `fn_attribute_tournament_rake` to turn it into VIP credit, agent commission
 * and rakeback basis for the players who generated it. It stamped
 * `attributed_at` whenever attribution returned `ok:true` — and attribution
 * returns `ok:true` when it credits NOBODY.
 *
 * `fn_repair_tournament_rake_attribution`, the standing 15-minute remedy,
 * selects on `attributed_at IS NULL`. So the one shape it could never see was
 * the one that had actually happened: 21,562 settlements holding 21,080 chips
 * of banked rake that earned nobody anything, back to 2026-08-19, every one of
 * them recorded as a completed attribution.
 *
 * This is the same failure as the 2026-08-27 horse-rake incident that CLAUDE.md
 * 10.5 was written for — a zero reported as correct behaviour — reached by a
 * different route.
 *
 * WHAT MADE THE ZEROES. Until 2026-08-31 ~10:00 UTC `fn_award_vip_credit`
 * dropped any credit that did not round to a whole VIP point. A Spin's rake is
 * 8% of three buy-ins split three ways — 0.08 x buy-in each — so a Spin at a
 * buy-in of 10 or less credited 0.80 or less and vanished. Measured across
 * three days: buy-ins 1-10 attributed 4-9% of the time, buy-ins 20-100
 * attributed 100%. The fractional-carry fix (vip_points_carry) closed that;
 * these pins are about the accounting that hid it for twelve days.
 *
 * These read the migration rather than execute it, in the house style of
 * spinNoExtraRake and spinReserveOwnership. The live behaviour was verified
 * against production within six minutes of apply — every settlement written
 * after the change carries attributed_users 2-3 — and is recorded under APPLY
 * HISTORY in the migration itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260831135007_zero_attribution_is_not_success.sql';
const migration = sqlCode(read(MIGRATION));

const bodyOf = (name: string) => {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} is not in the migration`).toBeGreaterThan(-1);
  const end = migration.indexOf('$fn$;', start);
  return migration.slice(start, end);
};

describe('attribution can tell "credited nobody" from "nobody to credit"', () => {
  const attribute = bodyOf('fn_attribute_tournament_rake');

  it('counts the members it could have credited', () => {
    // Without this the two cases are indistinguishable, and the repair queue
    // cannot decide whether retrying a row is worth anything.
    expect(attribute).toMatch(/SELECT count\(\*\) INTO v_members/);
    expect(attribute).toMatch(/FROM public\.tournament_players tp/);
  });

  it('returns members alongside attributed_users', () => {
    expect(attribute).toMatch(/'attributed_users', v_users/);
    expect(attribute).toMatch(/'members', v_members/);
  });

  it('still spreads userless rake across every seat — horses included', () => {
    // CLAUDE.md 10.5: a horse pays the same buy-in and generates the same rake,
    // so it earns the same credit. There must be no is_horse anywhere here.
    expect(attribute).not.toMatch(/is_horse/);
    expect(attribute).toMatch(/CROSS JOIN members m/);
  });
});

describe('the settle path refuses to record zero as done', () => {
  const settle = bodyOf('fn_settle_tournament_rake');

  it('only stamps attributed_at when somebody was credited, or nobody could be', () => {
    expect(settle).toMatch(/v_done := v_att_ok AND \(v_users > 0 OR v_members = 0\)/);
    expect(settle).toMatch(/attributed_at = CASE WHEN v_done THEN now\(\) ELSE NULL END/);
  });

  it('never stamps attributed_at on the bare result of attribution again', () => {
    // The exact line this migration exists to delete:
    //   attributed_at = CASE WHEN v_att_ok THEN now() ELSE NULL END
    expect(settle).not.toMatch(/attributed_at = CASE WHEN v_att_ok THEN/);
  });

  it('records the measurement so nothing has to reconstruct it', () => {
    // Reconstructing this from vip_points_ledger is a 45-second scan of a
    // 3.8M-row table. That cost is why nothing watched it.
    expect(settle).toMatch(/attributed_users = v_users/);
  });

  it('names the failure, so the row is diagnosable and not merely queued', () => {
    expect(settle).toMatch(/v_att_err := 'attributed_nobody'/);
  });

  it('keeps the no-rake branch terminal', () => {
    // Nothing to attribute is CLOSED, not queued - a row that can never be
    // attributed must not sit at the head of the repair queue forever.
    expect(settle).toMatch(/attributed_at = now\(\),\s*\n\s*attributed_users = 0/);
  });
});

describe('the repair applies the same rule', () => {
  const repair = bodyOf('fn_repair_tournament_rake_attribution');

  it('requires a credited user before it marks a row repaired', () => {
    expect(repair).toMatch(/AND \(v_users > 0 OR v_members = 0\)/);
  });

  it('keeps no_club terminal', () => {
    // 'no_club' pins the head of the queue if it is retried forever.
    expect(repair).toMatch(/IF v_att->>'reason' = 'no_club' THEN/);
  });
});

describe('the back-pay is bounded, monotone and idempotent', () => {
  const backpay = bodyOf('fn_backpay_tournament_rake_attribution');

  it('drains on the measurement column, not on a ledger probe', () => {
    // Every row it touches gets a non-null attributed_users, so the queue
    // shrinks on every pass and a re-run never revisits finished work.
    expect(backpay).toMatch(/WHERE attributed_users IS NULL AND amount > 0/);
    expect(backpay).toMatch(/LIMIT GREATEST\(p_limit, 1\)/);
  });

  it('puts a settlement that credited nobody back into the repair queue', () => {
    expect(backpay).toMatch(/attributed_at = CASE WHEN v_users = 0 AND v_members > 0/);
  });

  it('marks a throwing row -1 rather than leaving it NULL', () => {
    // NULL would be retried forever at the head of the queue; -1 is measured,
    // so it cannot pin the drain and still shows in the gap view.
    expect(backpay).toMatch(/SET attributed_users = -1/);
  });

  it('is not reachable from a browser', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_backpay_tournament_rake_attribution\(integer\) FROM anon, authenticated;/
    );
  });
});

describe('the gap is visible now', () => {
  it('the view exists and separates the three failure shapes', () => {
    expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.v_tournament_rake_attribution_gaps/);
    for (const verdict of ['never_measured', 'attribution_threw', 'credited_nobody']) {
      expect(migration, `the gap view would not report ${verdict}`).toContain(verdict);
    }
  });

  it('is not a public API', () => {
    // 2026-08-31 phase 3 closed 852 definer/exposure lints; a reconciliation
    // view is operator data, not client data.
    expect(migration).toMatch(
      /REVOKE ALL ON public\.v_tournament_rake_attribution_gaps FROM anon, authenticated;/
    );
  });

  it('has an index so the drain queue stays cheap as it shrinks', () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_rake_settlements_unmeasured/);
    expect(migration).toMatch(/WHERE attributed_users IS NULL AND amount > 0/);
  });
});
