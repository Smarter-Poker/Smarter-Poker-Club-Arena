/**
 * A PAGE CANNOT CERTIFY AN UNFINISHED WEEK, SO IT MUST NOT PAY TO BE TOLD SO
 * (2026-09-26, migration 20260926091232).
 *
 * The rakeback settler calls fn_rakeback_recompute_periods once per
 * (club, week) after every page of rake_records. While the settler is behind,
 * the hands after its own cursor have no accrued batch, so the calculator's
 * `incomplete` count is non-zero and the call is refused with written=0 - but
 * only after a full read of the club-week. Measured on production: 20-138 s per
 * call, three calls on the first page after every engine restart (11 restarts
 * in six hours), 209 s for a page whose siblings took 67-86 s, and 14,428 s of
 * database time since 09-10, as much as every source-credit batch combined.
 *
 * The fix answers a page-scoped call from one unaccrued hand when one is in
 * view, and otherwise calls the unchanged calculator. This law pins the three
 * properties that keep that honest:
 *   1. the door is taken only for a page-scoped call (p_user_ids IS NOT NULL),
 *      so fn_prepare_accounting_week and every whole-period call still run the
 *      full calculator;
 *   2. the door is decided BEFORE the calculator is called and replaces it
 *      only when it found an attribution of this club on a hand with no
 *      accrued batch - positive evidence of the calculator's own refusal;
 *   3. the door answers with the calculator's refusal shape (status blocked,
 *      written 0, reason cash_source_receipts_incomplete, source_count) under
 *      the same advisory lock and request-row bookkeeping, so the settler's
 *      receipt check and its openWeekIncomplete lower bound read it unchanged.
 */
import { describe, it, expect } from 'vitest';
import { latestDeclaring, functionBody } from './helpers/migrations';

const FN = 'fn_rakeback_recompute_periods';

/** Every way the door can be wrong, as named findings. Empty means the law holds. */
export function recomputeDoorViolations(body: string): string[] {
  const out: string[] = [];
  const b = body.replace(/--[^\n]*/g, '');
  const lock = b.indexOf("pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'");
  const guard = b.search(/IF\s+p_user_ids\s+IS\s+NOT\s+NULL\s+THEN/);
  const probe = b.search(
    /NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.accounting_cash_accrual_batches\s+b\s+WHERE\s+b\.rake_record_id\s*=\s*w\.id\s+AND\s+b\.status\s*=\s*'accrued'\s*\)/
  );
  const clubScope =
    /JOIN\s+public\.rake_attributions\s+a\s+ON\s+a\.rake_record_id\s*=\s*w\.id\s+AND\s+a\.club_id\s*=\s*p_club_id/.test(
      b
    );
  const door = b.search(/IF\s+unaccrued\s*>\s*0\s+THEN/);
  const calc = b.indexOf('public.fn_calculate_cash_rakeback_periods(');
  if (lock < 0) out.push('the club-week advisory lock is gone');
  if (guard < 0)
    out.push('the door is not restricted to a page-scoped call (p_user_ids IS NOT NULL)');
  if (probe < 0) out.push('the door does not require a hand with no accrued batch');
  if (!clubScope) out.push('the door does not require an attribution to THIS club');
  if (door < 0) out.push('there is no door: every page call pays for the full-week read');
  if (calc < 0) out.push('the unchanged calculator is no longer called');
  if (lock >= 0 && guard >= 0 && guard < lock)
    out.push('the door runs before the club-week lock is held');
  if (door >= 0 && calc >= 0 && calc < door)
    out.push('the calculator runs before the door is decided');
  if (guard >= 0 && probe >= 0 && probe < guard)
    out.push('the probe is outside the page-scoped guard');
  const ret = b.slice(door, calc);
  for (const piece of [
    "'status','blocked'",
    "'written',0",
    "'reason','cash_source_receipts_incomplete'",
    "'source_count',unaccrued",
  ]) {
    if (door >= 0 && calc > door && !ret.replace(/\s+/g, '').includes(piece.replace(/\s+/g, '')))
      out.push(`the door's answer is not the calculator's refusal shape (missing ${piece})`);
  }
  if (
    !/ELSE\s+result\s*:=\s*public\.fn_calculate_cash_rakeback_periods\(p_club_id,p_period_start,p_period_end,p_user_ids\)/.test(
      b
    )
  )
    out.push('the fall-through does not call the calculator with the original arguments');
  if (
    !/UPDATE\s+public\.accounting_period_recompute_requests\s+SET\s+status\s*=\s*request_state/.test(
      b
    )
  )
    out.push('the request row is no longer written for every answer');
  return out;
}

describe('a page cannot certify an unfinished week', () => {
  const { name, sql } = latestDeclaring(FN);
  const body = functionBody(sql, FN);

  it('the live definition is the one that carries the door', () => {
    expect(name >= '20260926091232', `${FN} is declared last by ${name}`).toBe(true);
  });

  it('holds all three properties', () => {
    expect(recomputeDoorViolations(body)).toEqual([]);
  });

  it('pins its own performance evidence in the migration header', () => {
    expect(sql).toMatch(/209,364 ms/);
    expect(sql).toMatch(/RECOMPUTE_PREIMAGE_CHANGED/);
    expect(sql).toMatch(/RECOMPUTE_POSTIMAGE/);
  });

  // Planted regressions: each one is a way the door could be broken, and the
  // checker must name it. A law that cannot fail is not a law.
  const plant = (from: RegExp | string, to: string) => {
    const planted = body.replace(from as RegExp, to);
    expect(planted, 'the plant must change the body').not.toBe(body);
    return recomputeDoorViolations(planted);
  };
  it('refuses a door that is open to whole-period calls', () => {
    expect(plant(/IF\s+p_user_ids\s+IS\s+NOT\s+NULL\s+THEN/, 'IF true THEN')).toContain(
      'the door is not restricted to a page-scoped call (p_user_ids IS NOT NULL)'
    );
  });
  it('refuses a door that answers without an unaccrued hand', () => {
    expect(plant(/AND\s+b\.status\s*=\s*'accrued'/, '')).toContain(
      'the door does not require a hand with no accrued batch'
    );
  });
  it("refuses a door that counts another club's hands", () => {
    expect(plant(/AND\s+a\.club_id\s*=\s*p_club_id/, '')).toContain(
      'the door does not require an attribution to THIS club'
    );
  });
  it('refuses a removed door', () => {
    expect(plant(/IF\s+unaccrued\s*>\s*0\s+THEN/, 'IF false THEN')).toContain(
      'there is no door: every page call pays for the full-week read'
    );
  });
  it('refuses a door whose answer is not a refusal', () => {
    expect(
      plant(
        "'status','blocked','reason','cash_source_receipts_incomplete'",
        "'status','ready','reason','cash_source_receipts_incomplete'"
      )
    ).toContain(
      "the door's answer is not the calculator's refusal shape (missing 'status','blocked')"
    );
  });
});
