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
 *      certificate loop permits only exact separately qualified rate/payer expressions;
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
import {
  latestDeclaring,
  latestNamed,
  functionBody,
  migrationFiles,
  readMigration,
} from './helpers/migrations';

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

// Qualified changes to the certificate loop, separate from its evidence reads:
// 20261015163632 gives an agent's explicit zero its actual meaning;
// 20261019154457 preserves the existing club-funded direct-owner 70% deal;
// 20261019213557 retains each historical payer on one unchanged entitlement.
// Undo ONLY these exact expressions for the predecessor comparison below.
const QUALIFIED_CERTIFICATE_EXPRESSIONS: ReadonlyArray<readonly [string, string]> = [
  [
    "SELECT r.*,NULLIF(r.member->>'agent_id','')::uuid AS member_agent,",
    "SELECT r.*,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid\n     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,",
  ],
  [
    'CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer',
    'CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer',
  ],
  [
    'CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate',
    'CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate',
  ],
  [
    "IF player.payer_count<>1 THEN RAISE EXCEPTION 'multiple_historical_payers_require_split_period' USING ERRCODE='55000'; END IF;",
    "IF player.payer_count<1 THEN RAISE EXCEPTION 'historical_rakeback_payer_required' USING ERRCODE='55000'; END IF;",
  ],
  [
    'total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=player.payer_user;coordinator_union:=player.coordinator_union;',
    'total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=CASE WHEN player.payer_count>1 THEN NULL ELSE player.payer_user END;coordinator_union:=player.coordinator_union;',
  ],
  [
    "payer_kind:=CASE WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;",
    "payer_kind:=CASE WHEN player.payer_count>1 THEN 'split' WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;",
  ],
];

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
  // Delimiters are SQL syntax, not calculator bytes. The only later admitted
  // change is the exact launch window floor already independently qualified.
  body = body.replace(/^\$\w*\$/, '');
  before = before.replace(/^\$\w*\$/, '');
  const launch = " v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);\n";
  if (body.includes(launch)) {
    const placement =
      " v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';\n" +
      launch +
      ' SELECT starts_at INTO cutover';
    if (body.split(launch).length !== 2 || !body.includes(placement))
      out.push('the launch floor is not the exact single window-boundary assignment');
    body = body.replace(launch, '');
  }
  // Admit only the exact qualified launch waiver; all other predecessor bytes remain checked.
  const waiver = ' AND public.fn_ca_launch_rakeback_period_waived(rp.id) IS NOT TRUE';
  const waivedReuse =
    "  IF FOUND AND public.fn_ca_launch_rakeback_period_waived(existing.id) THEN\n   period_id:=existing.id;\n   UPDATE public.rakeback_periods SET status='pending',paid_at=NULL,deferred_reason=NULL,deferred_at=NULL,\n    rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,\n    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric\n    WHERE id=period_id;\n  ELSIF FOUND THEN";
  if (body.includes(waiver) || body.includes('fn_ca_launch_rakeback_period_waived(existing.id)')) {
    if (body.split(waiver).length !== 3 || body.split(waivedReuse).length !== 2)
      out.push('the launch waiver is not the exact two exclusions and unpaid-period reuse');
    body = body.replaceAll(waiver, '').replace(waivedReuse, '  IF FOUND THEN');
  }
  // 20261021193318 qualifies this one immutable payer-receipt repair before
  // confirming an unchanged certificate. Normalize only its exact branch.
  const confirmedBefore =
    "   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;";
  const confirmedAfter = confirmedBefore.replace(
    'THEN confirmed:=',
    'THEN PERFORM smarter_private.ensure_rakeback_payer_contracts(certificate.id); confirmed:='
  );
  if (body.includes('ensure_rakeback_payer_contracts')) {
    if (
      body.split(confirmedAfter).length !== 2 ||
      body.split('ensure_rakeback_payer_contracts').length !== 2
    )
      out.push('the confirmed payer repair is not the exact single qualified branch');
    body = body.replace(confirmedAfter, confirmedBefore);
  }
  const explicitRate =
    "CASE WHEN COALESCE((p.member->>'player_rakeback_explicit')::boolean,false) OR p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer";
  if (body.includes(explicitRate)) {
    if (body.split(explicitRate).length !== 2)
      out.push('the explicit player agreement rate expression is duplicated');
    body = body.replace(
      explicitRate,
      'CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer'
    );
  }
  const historicalPayers = body.includes("'historical_rakeback_payer_required'");
  for (const [original, qualified] of QUALIFIED_CERTIFICATE_EXPRESSIONS) {
    if (body.includes(qualified) || historicalPayers) {
      if (body.split(qualified).length !== 2 || body.includes(original))
        out.push('the qualified certificate expression is missing, duplicated or mixed');
      body = body.replace(qualified, original);
    }
  }
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
  const origin = latestNamed('_a_page_recompute_reads_only_changed_evidence_rederived');

  it('the live definition is the one that carries the checkpoint', () => {
    expect(name >= '20260927160709', `${CALC} is declared last by ${name}`).toBe(true);
    expect(latestDeclaring(HELPER).name <= name).toBe(true);
    expect(latestDeclaring(HELPER).name >= '20260927160709').toBe(true);
  });
  it('keeps every whole-period and certificate byte except exact qualified rate and payer expressions', () => {
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
    expect(origin.sql).toMatch(
      /CREATE TRIGGER accounting_cash_batch_is_placed_in_time BEFORE INSERT ON public\.accounting_cash_accrual_batches/
    );
    expect(origin.sql).toMatch(
      /CREATE TRIGGER accounting_cash_source_matches_its_batch BEFORE INSERT ON public\.accounting_cash_rake_sources/
    );
    expect(
      functionBody(
        latestDeclaring('fn_accounting_cash_batch_is_placed_in_time').sql,
        'fn_accounting_cash_batch_is_placed_in_time'
      )
    ).toMatch(/NEW\.recorded_at<now\(\)/);
    expect(
      functionBody(
        latestDeclaring('fn_accounting_cash_batch_is_placed_in_time').sql,
        'fn_accounting_cash_batch_is_placed_in_time'
      )
    ).toMatch(/r\.created_at=NEW\.earned_at/);
    expect(
      functionBody(
        latestDeclaring('fn_accounting_cash_source_matches_its_batch').sql,
        'fn_accounting_cash_source_matches_its_batch'
      )
    ).toMatch(/b\.earned_at=NEW\.earned_at/);
  });
  it('carries its measurements, preimage and postimage', () => {
    // The preimage is the live body (20260926042810 + 20260927155651 step 3c).
    expect(origin.sql).toMatch(/md5\(p\.prosrc\)='adea66332439cb1c0071f37ce12165b9'/);
    expect(origin.sql).toMatch(/md5\(prosrc\)='[0-9a-f]{32}'/);
    expect(origin.sql).toMatch(/60,276 ms/);
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
  it('does not excuse any launch-window expression besides the qualified single assignment', () => {
    const floor = " v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);\n";
    expect(body).toContain(floor);
    expect(wholePeriodViolations(plant(body, floor, floor + floor), before)).toContain(
      'the launch floor is not the exact single window-boundary assignment'
    );
    expect(
      wholePeriodViolations(
        plant(body, floor, floor.replace('p_club_id,v_from', 'p_club_id,v_to')),
        before
      )
    ).toContain(
      'something outside the page branch changed (the certificate loop must be untouched)'
    );
  });
  it('refuses altered waiver and paid-period reuse', () => {
    for (const [from, to] of [
      [
        'fn_ca_launch_rakeback_period_waived(rp.id) IS NOT TRUE',
        'fn_ca_launch_rakeback_period_waived(rp.id) IS TRUE',
      ],
      ["SET status='pending',paid_at=NULL", "SET status='paid',paid_at=NULL"],
    ])
      expect(wholePeriodViolations(plant(body, from, to), before).length).toBeGreaterThan(0);
  });
  it('does not excuse a different payer threshold, owner rule, rate cap or coordinator', () => {
    for (const [from, to] of [
      [
        "payer_kind:=CASE WHEN player.payer_count>1 THEN 'split'",
        "payer_kind:=CASE WHEN player.payer_count>2 THEN 'split'",
      ],
      [
        "owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid",
        "owner_club.owner_id<>NULLIF(r.member->>'agent_id','')::uuid",
      ],
      ['greatest(r.cap_rate-0.10,0)', 'greatest(r.cap_rate-0.20,0)'],
      ['IF player.coordinator_count<>1 THEN', 'IF player.coordinator_count<1 THEN'],
    ]) {
      expect(wholePeriodViolations(plant(body, from, to), before).length).toBeGreaterThan(0);
    }
  });
  it('admits only the exact single qualified unchanged-certificate payer repair', () => {
    const ensure = 'PERFORM smarter_private.ensure_rakeback_payer_contracts(certificate.id);';
    expect(body.split(ensure)).toHaveLength(2);
    for (const replacement of [
      ensure + ' ' + ensure,
      ensure.replace('certificate.id', 'period_id'),
      ensure + ' confirmed:=confirmed+1;',
      'CONTINUE; ' + ensure,
    ])
      expect(
        wholePeriodViolations(plant(body, ensure, replacement), before).length
      ).toBeGreaterThan(0);
  });
  it('refuses altered explicit-zero agreement semantics', () => {
    const explicit = "COALESCE((p.member->>'player_rakeback_explicit')::boolean,false) OR p.deal>0";
    expect(body).toContain(explicit);
    for (const altered of [
      explicit.replace(',false)', ',true)'),
      explicit.replace(' OR ', ' AND '),
    ])
      expect(wholePeriodViolations(plant(body, explicit, altered), before).length).toBeGreaterThan(
        0
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
