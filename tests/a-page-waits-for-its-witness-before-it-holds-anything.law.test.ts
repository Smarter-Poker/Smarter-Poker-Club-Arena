/**
 * A PAGE RECOMPUTE WAITS BRIEFLY FOR ITS WITNESS, BEFORE IT HOLDS ANYTHING
 * (2026-09-26, migration 20260926133201).
 *
 * 20260926091232 answers a page-scoped fn_rakeback_recompute_periods call from
 * one hand of the club-week with no accrued batch. Once the settler is current
 * the only such hands are the ones dealt since its last page, and a call made
 * a second after that page often finds none for its club. Measured on
 * production: a club's next attributed hand is a median 1.1-1.7 s away (p95
 * 5.3-8.6 s), and every miss paid the full-week calculator for 20-130 s while
 * holding the club-week lock and the request row, which blocked
 * fn_complete_tournament_terminal and, behind it, live hands' post-commit
 * obligations - only to be refused anyway.
 *
 * The fix waits, before any lock and without writing anything, for one such
 * hand to exist (at most 16 x 0.5 s), then lets the unchanged door and the
 * unchanged calculator decide. This law pins what keeps that honest:
 *   1. the wait is only for a page-scoped call of an OPEN week;
 *   2. it happens before the club-week lock and before the request row is
 *      touched, and it writes nothing and takes no lock;
 *   3. it is bounded, at most ten seconds, and stops at its witness;
 *   4. it decides nothing: the 20260926091232 door and the calculator still
 *      stand after it (their own checker is re-run here on the same body).
 */
import { describe, it, expect } from 'vitest';
import { latestDeclaring, functionBody } from './helpers/migrations';
import { recomputeDoorViolations } from './a-page-cannot-certify-an-unfinished-week.law.test';

const FN = 'fn_rakeback_recompute_periods';
const LOCK = "pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'";
const PAGE_GUARD = /IF\s+p_user_ids\s+IS\s+NOT\s+NULL\s+THEN/g;

/** Every way the wait can be wrong, as named findings. Empty means the law holds. */
export function witnessWaitViolations(body: string): string[] {
  const out: string[] = [];
  const b = body.replace(/--[^\n]*/g, '');
  const lock = b.indexOf(LOCK);
  const sleep = b.search(/pg_sleep\s*\(/);
  if (sleep < 0) {
    out.push('there is no witness wait: a page call in the gap pays the full-week read');
    return out;
  }
  if (lock < 0) out.push('the club-week advisory lock is gone');
  if (lock >= 0 && sleep > lock) out.push('the wait runs while the club-week lock is held');
  const request = b.indexOf('INSERT INTO public.accounting_period_recompute_requests');
  if (request >= 0 && sleep > request) out.push('the wait runs after the request row is taken');

  // The block the wait lives in: from the last page-scoped guard before the
  // sleep to the lock (or to the sleep's own END IF when the lock moved).
  let guardAt = -1;
  for (const m of b.slice(0, sleep).matchAll(PAGE_GUARD)) guardAt = m.index ?? -1;
  if (guardAt < 0)
    out.push('the wait is not restricted to a page-scoped call (p_user_ids IS NOT NULL)');
  const end = lock > sleep ? lock : b.indexOf('END LOOP', sleep);
  const block = b.slice(guardAt >= 0 ? guardAt : 0, end >= 0 ? end : b.length);
  if (!/clock_timestamp\(\)\s*<\s*v_to/.test(block))
    out.push('the wait is not restricted to an open week');
  if (/\b(INSERT|UPDATE|DELETE)\b/i.test(block)) out.push('the wait writes');
  if (/pg_advisory|FOR\s+UPDATE|LOCK\s+TABLE/i.test(block)) out.push('the wait takes a lock');

  const nap = /pg_sleep\s*\(\s*([0-9.]+)\s*\)/.exec(block);
  const cap = /waited\s*>=\s*([0-9]+)/.exec(block);
  if (!nap || !cap) out.push('the wait is not bounded');
  else if (Number(nap[1]) * Number(cap[1]) > 10)
    out.push(`the wait can last ${Number(nap[1]) * Number(cap[1])} s, more than 10 s`);
  if (!/EXIT\s+WHEN\s+witnessed/.test(block)) out.push('the wait does not stop at its witness');
  if (
    !/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.accounting_cash_accrual_batches\s+b\s+WHERE\s+b\.rake_record_id\s*=\s*r\.id\s+AND\s+b\.status\s*=\s*'accrued'\s*\)/.test(
      block
    ) ||
    !/JOIN\s+public\.rake_attributions\s+a\s+ON\s+a\.rake_record_id\s*=\s*r\.id\s+AND\s+a\.club_id\s*=\s*p_club_id/.test(
      block
    )
  )
    out.push("the wait's witness is not an unaccrued hand of this club");
  return out;
}

describe('a page waits for its witness before it holds anything', () => {
  const { name, sql } = latestDeclaring(FN);
  const body = functionBody(sql, FN);

  it('the live definition is the one that carries the wait', () => {
    expect(name >= '20260926133201', `${FN} is declared last by ${name}`).toBe(true);
  });

  it('holds all four properties', () => {
    expect(witnessWaitViolations(body)).toEqual([]);
  });

  it('decides nothing: the door and the calculator still stand after it', () => {
    expect(recomputeDoorViolations(body)).toEqual([]);
  });

  it('carries its measurements and its pre- and postimage', () => {
    expect(sql).toMatch(/p95 5\.33 \/ 6\.15 \/ 8\.64 s/);
    expect(sql).toMatch(/37a114ec314e300a5c369c80245fee7b/);
    expect(sql).toMatch(/936ccee154e1b0cf6d88dd3fd653215b/);
  });

  // Planted regressions: each is a way the wait could be broken, and the
  // checker must name it. A law that cannot fail is not a law.
  const plant = (from: RegExp | string, to: string) => {
    const planted = body.replace(from as RegExp, to);
    expect(planted, 'the plant must change the body').not.toBe(body);
    return witnessWaitViolations(planted);
  };
  it('refuses an unbounded wait', () => {
    expect(plant(/waited\s*>=\s*16/, 'waited>=600')).toContain(
      'the wait can last 300 s, more than 10 s'
    );
  });
  it('refuses a wait for a closed week', () => {
    expect(plant(/AND\s+clock_timestamp\(\)\s*<\s*v_to/, '')).toContain(
      'the wait is not restricted to an open week'
    );
  });
  it('refuses a wait for a whole-period call', () => {
    expect(plant(/IF\s+p_user_ids\s+IS\s+NOT\s+NULL\s+THEN/, 'IF true THEN')).toContain(
      'the wait is not restricted to a page-scoped call (p_user_ids IS NOT NULL)'
    );
  });
  it('refuses a wait that holds the lock', () => {
    const lockAt = body.indexOf(LOCK);
    const lineStart = body.lastIndexOf('\n', lockAt) + 1;
    const lineEnd = body.indexOf('\n', lockAt) + 1;
    const lockLine = body.slice(lineStart, lineEnd);
    const without = body.slice(0, lineStart) + body.slice(lineEnd);
    const planted = without.replace(
      /IF\s+p_user_ids\s+IS\s+NOT\s+NULL\s+THEN/,
      lockLine + ' IF p_user_ids IS NOT NULL THEN'
    );
    expect(planted).not.toBe(body);
    expect(witnessWaitViolations(planted)).toContain(
      'the wait runs while the club-week lock is held'
    );
  });
  it('refuses a wait that writes', () => {
    expect(
      plant(
        /PERFORM\s+pg_sleep\(0\.5\);/,
        'UPDATE public.clubs SET name=name WHERE false; PERFORM pg_sleep(0.5);'
      )
    ).toContain('the wait writes');
  });
  it("refuses a wait whose witness is another club's hand", () => {
    expect(
      plant(
        /ON\s+a\.rake_record_id\s*=\s*r\.id\s+AND\s+a\.club_id\s*=\s*p_club_id/,
        'ON a.rake_record_id=r.id'
      )
    ).toContain("the wait's witness is not an unaccrued hand of this club");
  });
  it('refuses a removed wait', () => {
    expect(plant(/PERFORM\s+pg_sleep\(0\.5\);/, 'NULL;')).toContain(
      'there is no witness wait: a page call in the gap pays the full-week read'
    );
  });
});
