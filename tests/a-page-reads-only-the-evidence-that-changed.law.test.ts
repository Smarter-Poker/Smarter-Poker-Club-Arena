/**
 * A PAGE RECOMPUTE READS ONLY THE EVIDENCE THAT CHANGED
 * (2026-09-27, migration 20260927160709; re-derived 2026-09-30 as
 * 20260930232349 against the calculator production runs, after
 * 20260927155651 changed the certificate loop's agreement instant underneath
 * the original, which was never applied and is deleted).
 *
 * The page path of fn_calculate_cash_rakeback_periods no longer reads the whole
 * club-week for its three evidence counts. It keeps, per club-week, the frozen
 * share of every accrual batch recorded before a commit horizon, and adds the
 * batches recorded since and the records with no batch, in one snapshot. The
 * whole-period path (the weekly close) keeps its full verification.
 *
 * What keeps that exact, pinned here against the body in force:
 *   1. the whole-period path is the predecessor's, byte for byte, and the
 *      certificate loop is untouched;
 *   2. the page path adds the checkpoint AND the counts read since it, for all
 *      three counts, under the club-week lock, and its horizon never goes back;
 *   3. every predicate fn_cash_period_evidence_since applies is the
 *      calculator's own, and the helper reads one snapshot (STABLE);
 *   4. the horizon is the oldest running transaction's start less at least two
 *      minutes, and is unknown (NULL) when it cannot be read;
 *   5. the two facts it rests on are enforced where they are written.
 * Native proof: tests/fixtures/union-weekly-basis/page-evidence-regression.sql.
 */
import { describe, it, expect } from 'vitest';
import { latestDeclaring, functionBody, migrationFiles, readMigration } from './helpers/migrations';

const CALC = 'fn_calculate_cash_rakeback_periods';
const HELPER = 'fn_cash_period_evidence_since';
const HORIZON = 'fn_accounting_commit_horizon';
const PREDECESSOR = '20260926042810_';
const SEGMENT_START = ' -- Tournament fees are earned at terminal recognition.';
const SEGMENT_END =
  " IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;\n";

/**
 * The body the page path replaces is the one production runs: 20260926042810's
 * calculator with the ONE expression 20260927155651 (step 3c) rewrote in the
 * certificate loop. 155651 patches it with replace() over pg_get_functiondef,
 * so its file carries no literal body; the same replacement is applied here,
 * and refused unless 155651 still carries exactly that old and new text.
 */
const AGREEMENT_PATCH = '20260927155651_';
const AGREEMENT_BEFORE =
  "CASE WHEN s.source_type='tournament_fee_accrual' THEN fee.charged_at ELSE s.earned_at END AS agreement_at,";
const AGREEMENT_AFTER =
  "CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,";

function predecessorBody(): string {
  const name = migrationFiles().find((f) => f.startsWith(PREDECESSOR));
  if (!name) throw new Error('the predecessor migration is gone');
  const patch = migrationFiles().find((f) => f.startsWith(AGREEMENT_PATCH));
  if (!patch) throw new Error('the agreement-instant migration is gone');
  const patchSql = readMigration(patch);
  if (
    !patchSql.includes('$old$' + AGREEMENT_BEFORE + '$old$') ||
    !patchSql.includes('$new$' + AGREEMENT_AFTER + '$new$')
  )
    throw new Error('20260927155651 no longer rewrites the agreement instant this law replays');
  const body = functionBody(readMigration(name), CALC);
  if (body.split(AGREEMENT_BEFORE).length !== 2)
    throw new Error('the predecessor does not carry the agreement instant once');
  return body.replace(AGREEMENT_BEFORE, AGREEMENT_AFTER);
}

/** The whole-period segment of a calculator body. */
function wholePeriodSegment(body: string): string {
  const a = body.indexOf(SEGMENT_START);
  const b = body.indexOf(SEGMENT_END);
  if (a < 0 || b < a) return '';
  return body.slice(a, b + SEGMENT_END.length);
}

/** The page segment: from the ELSE after the whole-period segment to the END IF before the certificate loop. */
function pageSegment(body: string): string {
  const whole = wholePeriodSegment(body);
  const at = body.indexOf(whole) + whole.length;
  if (!body.startsWith(' ELSE\n', at)) return '';
  const end = body.indexOf(' END IF;\n\n FOR player IN', at);
  return end < 0 ? '' : body.slice(at + ' ELSE\n'.length, end);
}

export function wholePeriodViolations(body: string, before: string): string[] {
  const out: string[] = [];
  const segment = wholePeriodSegment(before);
  if (!segment) return ['the predecessor has no whole-period segment to compare'];
  if (!body.includes(' IF p_user_ids IS NULL THEN\n' + segment + ' ELSE\n'))
    out.push('the whole-period path is not the predecessor, byte for byte');
  const page = pageSegment(body);
  if (!page) {
    out.push('the page path is not a branch beside the whole-period path');
    return out;
  }
  const restored = body
    .replace(' IF p_user_ids IS NULL THEN\n' + segment + ' ELSE\n' + page + ' END IF;\n', segment)
    .replace(/\n digest_now text;[^\n]*\n base_horizon[^\n]*\n/, '\n');
  if (restored !== before)
    out.push('something outside the page branch changed (the certificate loop must be untouched)');
  return out;
}

export function pagePathViolations(body: string): string[] {
  const out: string[] = [];
  const page = pageSegment(body);
  if (!page) return ['there is no page path'];
  const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'");
  if (lock < 0 || lock > body.indexOf(page))
    out.push('the page path runs outside the club-week lock');
  if (
    !/FROM public\.accounting_rakeback_period_evidence_checkpoints cp[\s\S]{0,120}FOR UPDATE/.test(
      page
    )
  )
    out.push('the checkpoint is not read under a row lock');
  if (!/evidence_cp\.clubs_digest=digest_now/.test(page))
    out.push('a checkpoint taken under another clubs union shape can be reused');
  if (
    !/public\.fn_cash_period_evidence_since\(p_club_id,v_from,v_to,scope_union,base_horizon,next_horizon\)/.test(
      page
    )
  )
    out.push('the page does not read what changed since its checkpoint');
  for (const [total, base, part] of [
    ['evidence_issues', 'base_evidence', 'o_evidence'],
    ['incomplete_issues', 'base_incomplete', 'o_incomplete'],
    ['drifted_issues', 'base_drifted', 'o_drifted'],
  ])
    if (!page.includes(` ${total}:=${base}+counts.${part};`))
      out.push(`${total} is not the checkpoint plus what changed`);
  for (const col of [
    'settled_evidence',
    'settled_incomplete',
    'settled_drifted',
    'settled_records',
  ])
    if (!new RegExp(`${col}=EXCLUDED\\.${col}`).test(page))
      out.push(`the checkpoint does not keep ${col}`);
  if (
    !/IF next_horizon IS NULL OR next_horizon<base_horizon THEN next_horizon:=base_horizon; END IF;/.test(
      page
    )
  )
    out.push('the horizon can move backwards or be unknown');
  const gate = page.indexOf('public.fn_accounting_tournament_week_quality(');
  if (gate < 0) out.push('the page never asks the tournament gate');
  for (const reason of [
    'cash_earning_evidence_incomplete',
    'legacy_or_paid_period_requires_reconciliation',
    'cash_source_receipts_incomplete',
    'cash_source_receipts_drifted',
  ]) {
    const at = page.lastIndexOf(`'${reason}'`);
    if (at < 0) out.push(`the page never refuses with ${reason}`);
    else if (gate >= 0 && at > gate) out.push(`${reason} is decided after the gate`);
  }
  return out;
}

const norm = (s: string) =>
  s
    .replace(/\bscope_union\b/g, 'p_scope_union')
    .replace(/\bv_from\b/g, 'p_from')
    .replace(/\bv_to\b/g, 'p_to')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Predicate fragments the helper must carry exactly as the calculator does. */
function predicates(text: string): Record<string, string> {
  const body = text.replace(/--[^\n]*/g, '');
  const grab = (re: RegExp) => {
    const m = re.exec(body);
    return m ? norm(m[1]) : '';
  };
  return {
    record: grab(
      /AND r\.is_tournament IS NOT TRUE AND r\.tournament_id IS NULL\s+AND \((r\.hand_id IS NOT NULL OR NOT public\.fn_rake_record_is_ghost_twin\(r\.hand_id,r\.table_id,r\.metadata\))\)/
    ),
    scope: grab(
      /scoped_records AS \(\s*SELECT w\.\* FROM week_records w\s+WHERE ([\s\S]*?)\n \), checks AS/
    ),
    invalid: grab(
      /count\(a\.id\) FILTER\(WHERE (a\.hand_id IS DISTINCT FROM r\.hand_id[\s\S]*?)\) AS invalid_count/
    ),
    evidence: grab(
      /FROM checks WHERE (hand_id IS NULL[\s\S]*?rake_amount<>round\(rake_amount,2\))/
    ),
    incomplete: grab(
      /LEFT JOIN week_batches b ON b\.rake_record_id=r\.id\s+WHERE ([\s\S]*?s\.c_club IS DISTINCT FROM a\.club_id::text)/
    ),
    drifted: grab(
      /AND \((r\.id IS NULL OR a\.id IS NULL[\s\S]*?to_jsonb\(s\.coordinator_union_id\))\)/
    ),
  };
}

export function helperViolations(helperSql: string, calculatorBody: string): string[] {
  const out: string[] = [];
  const open = helperSql.indexOf(`CREATE FUNCTION public.${HELPER}(`);
  if (open < 0) return ['the helper is not declared'];
  const header = helperSql.slice(open, helperSql.indexOf('$function$', open));
  if (!/\bSTABLE\b/.test(header))
    out.push('the helper does not read one snapshot (it is not STABLE)');
  const helper = functionBody(helperSql, HELPER);
  const want = predicates(calculatorBody);
  const have = predicates(helper);
  for (const k of Object.keys(want)) {
    if (!want[k]) out.push(`the calculator has no ${k} predicate to compare`);
    else if (want[k] !== have[k]) out.push(`the helper's ${k} predicate is not the calculator's`);
  }
  if (
    !/NOT EXISTS\(SELECT 1 FROM public\.accounting_cash_accrual_batches b\s+WHERE b\.earned_at=r\.created_at AND b\.rake_record_id=r\.id/.test(
      helper
    )
  )
    out.push('the batchless records are not every record with no batch');
  if (!/b\.recorded_at>=p_batched_from/.test(helper))
    out.push('the frozen set is not the batches since the checkpoint');
  if (!/JOIN frozen f ON f\.id=s\.rake_record_id/.test(helper))
    out.push('drifted sources are not read from the frozen set');
  return out;
}

export function horizonViolations(horizon: string): string[] {
  const out: string[] = [];
  if (!/min\(a\.xact_start\)[\s\S]*pg_stat_activity/.test(horizon))
    out.push('the horizon is not the oldest running transaction');
  const margin = /-\s*interval '(\d+) minutes?'/.exec(horizon);
  if (!margin || Number(margin[1]) < 2)
    out.push('the horizon keeps less than two minutes of margin');
  if (!/pg_prepared_xacts\)\s*THEN\s+RETURN\s+NULL/.test(horizon))
    out.push('a prepared transaction does not make the horizon unknown');
  if (!/pg_read_all_stats[^;]*THEN\s+RETURN\s+NULL/.test(horizon))
    out.push('a reader that cannot see every session does not make the horizon unknown');
  return out;
}

describe('a page recompute reads only the evidence that changed', () => {
  const { name, sql } = latestDeclaring(CALC);
  const body = functionBody(sql, CALC);
  const before = predecessorBody();

  it('the live definition is the one that carries the checkpoint', () => {
    expect(name >= '20260927160709', `${CALC} is declared last by ${name}`).toBe(true);
    expect(latestDeclaring(HELPER).name).toBe(name);
  });
  it('keeps the whole-period verification and the certificate loop byte for byte', () => {
    expect(wholePeriodViolations(body, before)).toEqual([]);
  });
  it('adds the checkpoint and what changed since it, under the lock, before the gate', () => {
    expect(pagePathViolations(body)).toEqual([]);
  });
  it("counts with the calculator's own predicates, in one snapshot", () => {
    expect(helperViolations(latestDeclaring(HELPER).sql, body)).toEqual([]);
  });
  it('takes a horizon no running transaction can be behind', () => {
    expect(horizonViolations(functionBody(latestDeclaring(HORIZON).sql, HORIZON))).toEqual([]);
  });
  it('enforces the two facts it rests on where they are written', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER accounting_cash_batch_is_placed_in_time BEFORE INSERT ON public\.accounting_cash_accrual_batches/
    );
    expect(sql).toMatch(
      /CREATE TRIGGER accounting_cash_source_matches_its_batch BEFORE INSERT ON public\.accounting_cash_rake_sources/
    );
    expect(sql).toMatch(/NEW\.recorded_at<now\(\)/);
    expect(sql).toMatch(/r\.created_at=NEW\.earned_at/);
    expect(sql).toMatch(/b\.earned_at=NEW\.earned_at/);
  });
  it('carries its measurements, preimage and postimage', () => {
    // The preimage is the live body (20260926042810 + 20260927155651 step 3c).
    expect(sql).toMatch(/md5\(p\.prosrc\)='adea66332439cb1c0071f37ce12165b9'/);
    expect(sql).toMatch(/md5\(prosrc\)='[0-9a-f]{32}'/);
    expect(sql).toMatch(/60,276 ms/);
  });

  // Planted regressions: each is a way the page could stop being exact, and
  // its checker must name it. A law that cannot fail is not a law.
  const plant = (text: string, from: RegExp | string, to: string) => {
    const planted = text.replace(from as RegExp, to);
    expect(planted, 'the plant must change the text').not.toBe(text);
    return planted;
  };
  it('refuses a page that trusts its checkpoint alone', () => {
    expect(
      pagePathViolations(
        plant(
          body,
          ' evidence_issues:=base_evidence+counts.o_evidence;',
          ' evidence_issues:=base_evidence;'
        )
      )
    ).toContain('evidence_issues is not the checkpoint plus what changed');
  });
  it('refuses a horizon that can move backwards', () => {
    expect(
      pagePathViolations(
        plant(
          body,
          /IF next_horizon IS NULL OR next_horizon<base_horizon THEN next_horizon:=base_horizon; END IF;/,
          'NULL;'
        )
      )
    ).toContain('the horizon can move backwards or be unknown');
  });
  it('refuses a checkpoint reused across a clubs change', () => {
    expect(
      pagePathViolations(plant(body, 'evidence_cp.clubs_digest=digest_now', 'true'))
    ).toContain('a checkpoint taken under another clubs union shape can be reused');
  });
  it('refuses a page that asks the gate before its cash evidence', () => {
    const gateLine =
      " tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);\n IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN\n  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;\n";
    const page = pageSegment(body);
    expect(page.endsWith(gateLine)).toBe(true);
    const moved = body.replace(page, gateLine + page.slice(0, page.length - gateLine.length));
    expect(pagePathViolations(moved)).toContain(
      'cash_earning_evidence_incomplete is decided after the gate'
    );
  });
  it('refuses a changed whole-period path', () => {
    expect(
      wholePeriodViolations(
        plant(body, 'OR invalid_count>0 OR attributed<>rake_amount', 'OR attributed<>rake_amount'),
        before
      )
    ).toContain('the whole-period path is not the predecessor, byte for byte');
  });
  it('refuses a helper whose predicate drifted from the calculator', () => {
    const helperSql = latestDeclaring(HELPER).sql;
    expect(
      helperViolations(
        plant(
          helperSql,
          /OR a\.weighted_rake_credit IS NULL OR a\.weighted_rake_credit<0\n/,
          'OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<=0\n'
        ),
        body
      )
    ).toContain("the helper's invalid predicate is not the calculator's");
  });
  it('refuses a helper that reads two snapshots', () => {
    const helperSql = latestDeclaring(HELPER).sql;
    const at = helperSql.indexOf(`CREATE FUNCTION public.${HELPER}(`);
    const planted =
      helperSql.slice(0, at) +
      helperSql.slice(at).replace('STABLE SECURITY DEFINER', 'VOLATILE SECURITY DEFINER');
    expect(helperViolations(planted, body)).toContain(
      'the helper does not read one snapshot (it is not STABLE)'
    );
  });
  it('refuses a horizon without margin', () => {
    const h = functionBody(latestDeclaring(HORIZON).sql, HORIZON);
    expect(horizonViolations(plant(h, "-interval '2 minutes'", ''))).toContain(
      'the horizon keeps less than two minutes of margin'
    );
  });
});
