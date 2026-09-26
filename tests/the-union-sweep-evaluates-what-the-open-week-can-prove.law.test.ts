/**
 * THE UNION SWEEP EVALUATES WHAT THE OPEN WEEK CAN PROVE (2026-09-26)
 *
 * Three money producers that answered with a refusal, or grew without bound,
 * because they asked for something the data could not give them:
 *
 * 1. fn_union_enforce_stop_loss looped over fn_union_club_exposure, whose
 *    source (the certified weekly P&L) refuses an open week. The first
 *    statement raised every hour, so the NON-PAYMENT leg - which reads only
 *    settlement_invoices - never ran either, and two statements 7+ days past
 *    due were never enforced. The legs are now independent, an exposure that
 *    cannot be evaluated has its own name, and it never releases a club.
 *
 * 2. fn_union_rake_basis_refresh read the open week through now(), while the
 *    earning sources it needs are written behind the rakeback settler's
 *    cursor. It was refused whenever the settler was not idle at :35. It now
 *    reads through that cursor.
 *
 * 3. fn_calculate_cash_rakeback_periods materialised every attribution the
 *    club has ever had to answer two counts that can only see one week.
 *
 * Each law is proved against the body now in force AND refuted against the
 * body it replaced, so it cannot pass by reading nothing.
 *
 * 20260926042119, 20260926042810. docs/changelog/2026-09-26-the-union-sweep-evaluates-what-the-open-week-can-prove.md
 */
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring, readMigration, migrationFiles } from './helpers/migrations';

function bodyIn(fragment: string, fn: string): string {
  const name = migrationFiles().find((f) => f.includes(fragment));
  if (!name) throw new Error(`no migration named like ${fragment}`);
  return functionBody(readMigration(name), fn);
}

function stopLossViolations(body: string): string[] {
  const v: string[] = [];
  if (/FOR\s+r\s+IN\s+SELECT\s+\*\s+FROM\s+public\.fn_union_club_exposure/i.test(body))
    v.push('the club loop is driven by the exposure source, so its refusal stops every leg');
  const ask = body.indexOf('public.fn_union_club_exposure(');
  if (ask < 0) {
    v.push('the exposure leg is never consulted');
  } else {
    const opened = body.lastIndexOf('BEGIN', ask);
    const handler = body.indexOf('EXCEPTION WHEN OTHERS THEN', ask);
    const loop = body.indexOf('FOR r IN', ask);
    if (opened < 0 || handler < 0 || (loop >= 0 && handler > loop))
      v.push('a refusal from the exposure source is not contained in its own subtransaction');
  }
  if (!/FROM public\.union_club_terms t[\s\S]{0,200}WHERE t\.union_id = p_union_id/.test(body))
    v.push('the loop is not over every club with terms on file');
  if (!body.includes("'not_evaluable'"))
    v.push('an exposure that could not be evaluated has no name of its own');
  const restore = body.indexOf("SET status = 'active'");
  const hold = body.lastIndexOf("IF v_exp_state = 'not_evaluable' THEN", restore);
  const suspendBranch = body.lastIndexOf("r.status = 'suspended'", restore);
  if (restore < 0 || hold < 0 || hold < suspendBranch)
    v.push('a suspended club can be released while its exposure is unknown');
  if (!body.includes('si.due_at < now() - make_interval(days => v_grace)'))
    v.push('the non-payment test is not the grace-period test the union configured');
  if (!body.includes('ELSIF v_gate_open AND v_overdue > 0.005 THEN'))
    v.push('non-payment no longer suspends while statements are being issued');
  return v;
}

function refreshViolations(body: string): string[] {
  const v: string[] = [];
  if (!/FROM public\.daemon_state d WHERE d\.daemon = 'rakeback_settler'/.test(body))
    v.push('the snapshot does not read the accrual cursor');
  if (!/v_through := LEAST\(p_end, now\(\), v_accrued\)/.test(body))
    v.push('the snapshot reads past what the accrual has reached');
  if (!body.includes("'accrual_cursor_unknown'"))
    v.push('an unknown cursor is not its own outcome');
  if (/v_through := LEAST\(p_end, now\(\)\);/.test(body))
    v.push('the snapshot reads through now()');
  return v;
}

function calculatorViolations(body: string): string[] {
  const v: string[] = [];
  const cte = /club_attributions AS MATERIALIZED \(([\s\S]*?)\n \), week_batches/.exec(body);
  if (!cte) return ['the club_attributions slice is gone'];
  if (
    !/FROM week_records w JOIN public\.rake_attributions a ON a\.rake_record_id=w\.id/.test(cte[1])
  )
    v.push("club_attributions reads the club's whole history instead of the week");
  if (!/WHERE a\.club_id=p_club_id/.test(cte[1]))
    v.push('club_attributions is not scoped to the club');
  // Its only readers must still join it to the week, which is what makes the slice exact.
  if (!body.includes('OR EXISTS(SELECT 1 FROM club_attributions a WHERE a.rake_record_id=w.id)'))
    v.push('scoped_records no longer reads club_attributions by week record');
  if (!body.includes('FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id'))
    v.push('the incomplete count no longer joins club_attributions to the week');
  return v;
}

describe('the stop-loss evaluates each leg on its own', () => {
  it('holds for the body in force', () => {
    const { name, sql } = latestDeclaring('fn_union_enforce_stop_loss');
    expect(name >= '20260926042119').toBe(true);
    expect(stopLossViolations(functionBody(sql, 'fn_union_enforce_stop_loss'))).toEqual([]);
  });
  it('refutes the body that stopped enforcing non-payment (negative proof)', () => {
    const old = bodyIn('20260907183130_', 'fn_union_enforce_stop_loss');
    const v = stopLossViolations(old);
    expect(v).toContain(
      'the club loop is driven by the exposure source, so its refusal stops every leg'
    );
    expect(v).toContain('an exposure that could not be evaluated has no name of its own');
    expect(v).toContain('a suspended club can be released while its exposure is unknown');
  });
});

describe('the open-week rake basis reads through the accrual cursor', () => {
  it('holds for the body in force', () => {
    const { name, sql } = latestDeclaring('fn_union_rake_basis_refresh');
    expect(name >= '20260926042119').toBe(true);
    expect(refreshViolations(functionBody(sql, 'fn_union_rake_basis_refresh'))).toEqual([]);
  });
  it('refutes the body that read through now() (negative proof)', () => {
    const v = refreshViolations(bodyIn('20260908020401_', 'fn_union_rake_basis_refresh'));
    expect(v).toContain('the snapshot does not read the accrual cursor');
    expect(v).toContain('the snapshot reads through now()');
  });
});

describe('the period calculator reads one week of attributions', () => {
  it('holds for the body in force', () => {
    const { name, sql } = latestDeclaring('fn_calculate_cash_rakeback_periods');
    expect(name >= '20260926042810').toBe(true);
    expect(calculatorViolations(functionBody(sql, 'fn_calculate_cash_rakeback_periods'))).toEqual(
      []
    );
  });
  it('refutes the body that read the club lifetime (negative proof)', () => {
    const v = calculatorViolations(bodyIn('20260925205938_', 'fn_calculate_cash_rakeback_periods'));
    expect(v).toEqual(["club_attributions reads the club's whole history instead of the week"]);
  });
  it('changes nothing else in the body', () => {
    const now = functionBody(
      latestDeclaring('fn_calculate_cash_rakeback_periods').sql,
      'fn_calculate_cash_rakeback_periods'
    );
    const before = bodyIn('20260925205938_', 'fn_calculate_cash_rakeback_periods');
    const strip = (s: string) =>
      s.replace(
        /club_attributions AS MATERIALIZED \([\s\S]*?\n \), week_batches/,
        'club_attributions AS MATERIALIZED (<slice>\n ), week_batches'
      );
    expect(strip(now)).toBe(strip(before));
  });
});
