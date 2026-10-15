/**
 * LAW: THE WEEK'S ORIGINAL FLOWS ARE PROVED TWO HOURS AT A TIME (2026-10-15).
 *
 * After 20261015021138 the original week (union fade0000, 2026-10-05 ->
 * 2026-10-12) committed its closing boundary at 02:38:56 UTC and then every
 * job 272 visit (26 in a row, 02:40 to 06:09) was cancelled by the 240 s
 * statement timeout. Each died inside fn_union_pnl_original_flow_evidence over
 * the whole week (814,510 flows, 162 s alone, 2 GB of temporary files): the one
 * whole-week step of the report with no chunking, so the attempt that reached
 * it could never commit.
 *
 * Root: fn_accounting_union_earned_plan_advance proves the flows one plan
 * window at a time with a window proof that is the week proof plus one
 * predicate (and without the two whole-week return families), and assembles
 * the windows and the families into the certificate the report reads, in an
 * attempt of its own. Production, read-only: 84 windows + families = the week
 * proof (814,543 rows, equal multiset hash, 22 invalid on both sides).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const SQL = read(
  'supabase/migrations/20261015061812_the_week_s_original_flows_are_proved_two_hours_at_a_time.sql'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');
const WEEK_PROOF = read(
  'supabase/migrations/20261013084856_original_flow_proofs_run_only_for_their_eligible_receipts.sql'
);

const body = (text: string, header: string) => {
  const start = text.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('AS $function$', start) + 'AS $function$'.length;
  return text.slice(open, text.indexOf('$function$;', open));
};

const WINDOW = body(SQL, 'CREATE FUNCTION smarter_private.union_pnl_original_flow_evidence_window(');
const WEEK = body(WEEK_PROOF, 'CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_flow_evidence(');
const ADVANCE = body(SQL, 'CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_advance(');

describe("the week's original flows are proved two hours at a time", () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL.split('\n')[0]).toMatch(/^-- @live-proof: \(SELECT md5\(pg_get_functiondef\(/);
    expect(SQL.split('\n')[0]).toContain("='f24bac9808f16258b30ee227427dabcc'");
    expect(SQL.split('\n')[0]).toContain("='8a625319f1aeeef9446feabff82262ef'");
    expect(SQL.split('\n')[0]).toContain("'pnl_flows_window''::text");
    for (const preimage of [
      "<>'42d6add347b1b942aa79c95d0ec169c7' THEN RAISE EXCEPTION 'flow_windows_advance_preimage_refused'",
      "<>'09745f78c6cc2ae57f403419020fd1ab' THEN RAISE EXCEPTION 'flow_windows_week_proof_preimage_refused'",
      "<>'edecfc5273ee4c96b608baa0ea863578' THEN RAISE EXCEPTION 'flow_windows_report_preimage_refused'",
      "<>'f24bac9808f16258b30ee227427dabcc' THEN RAISE EXCEPTION 'flow_windows_advance_postimage_refused'",
      "<>'8a625319f1aeeef9446feabff82262ef' THEN RAISE EXCEPTION 'flow_windows_window_proof_postimage_refused'",
      'flow_windows_advance_security_refused',
      'flow_windows_window_proof_security_refused',
      'flow_windows_partial_kinds_preimage_refused',
    ]) {
      expect(CODE).toContain(preimage);
    }
  });

  it('installs only while the weekly scheduler is idle and never replays', () => {
    expect(CODE).toContain(
      "IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'flow_windows_reader_owned'"
    );
    expect(CODE).toContain("WHERE version='20261015061812') THEN RAISE EXCEPTION 'flow_windows_history_replay'");
    expect(CODE).toContain("current_setting('ca.break_window_migration_override',true)");
    expect(CODE).toContain("SET LOCAL lock_timeout='2s';");
  });

  it('proves a window with the week proof itself: one added predicate, the two week-only families removed', () => {
    const predicate =
      '   AND q.recognized_at>=p_start AND q.recognized_at<p_end\n';
    const windowed =
      predicate + '   AND q.recognized_at>=p_window_start AND q.recognized_at<p_window_end\n';
    const families =
      ' UNION ALL SELECT * FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end)\n' +
      ' UNION ALL SELECT * FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end);\n';
    expect(WEEK.split(predicate)).toHaveLength(2);
    expect(WEEK.endsWith(families)).toBe(true);
    const expected = WEEK.replace(predicate, windowed).slice(0, -families.length) + ';\n';
    expect(WINDOW).toBe(expected);
    expect(SQL).toContain(
      ' RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO \'public\', \'pg_temp\''
    );
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION smarter_private\.union_pnl_original_flow_evidence_window\([^)]*\) FROM PUBLIC,anon,authenticated,service_role;/
    );
  });

  it('windows only while the report and the week proof are the reviewed definitions', () => {
    expect(ADVANCE).toContain(
      "md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'09745f78c6cc2ae57f403419020fd1ab'"
    );
    expect(ADVANCE).toContain(
      "md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'edecfc5273ee4c96b608baa0ea863578'"
    );
    // the same generation rule as the report
    expect(ADVANCE).toContain(
      "IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_end>='2026-10-12 07:00Z'::timestamptz THEN\n  v_generation:=COALESCE(smarter_private.original_inventory_basis_generation(),'original-inventory-245:unqualified');"
    );
  });

  it('ends the attempt after proving windows, and assembles the certificate in an attempt of its own', () => {
    const flows = ADVANCE.slice(ADVANCE.indexOf("THE WEEK'S ORIGINAL FLOWS ARE PROVED"));
    const loopEnd = flows.indexOf('END LOOP;');
    const stop = flows.indexOf('IF proved THEN RETURN false; END IF;', loopEnd);
    const assemble = flows.indexOf('WITH parts AS MATERIALIZED');
    expect(loopEnd).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(loopEnd);
    expect(assemble).toBeGreaterThan(stop);
    expect(flows).toContain("inventory_basis_cache_write(v_generation,'pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows))");
    expect(flows).toContain("inventory_basis_cache_write(v_generation,'pnl_flows_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows))");
    expect(flows.trimEnd().endsWith('RETURN false;\nEND')).toBe(true);
    // the two week-only families are added exactly once, under the week proof's column names
    expect(flows.match(/original_restoration_cash_returns\(p_union_id,p_start,p_end\) t\(ledger_id,club_id,user_id,buyins,cashouts,kind,valid\)/g)).toHaveLength(1);
    expect(flows.match(/original_erased_cash_discharge_returns\(p_union_id,p_start,p_end\) t\(ledger_id,club_id,user_id,buyins,cashouts,kind,valid\)/g)).toHaveLength(1);
    // a window that found a problem is re-proved after an hour, like the report's problem steps
    expect(flows).toContain("(p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')");
  });

  it('stops each proving loop a minute before the statement itself is cancelled', () => {
    expect(ADVANCE).toContain(
      "stop_at:=LEAST(stop_at,statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds');"
    );
    expect(ADVANCE.match(/IF proved AND clock_timestamp\(\)>stop_at THEN RETURN false; END IF;/g)).toHaveLength(2);
    expect(ADVANCE).not.toContain("began+interval '120 seconds' THEN");
  });

  it('keeps an attempt that proved an earned-plan window a whole attempt (20261015021138)', () => {
    const earned = ADVANCE.slice(0, ADVANCE.indexOf("THE WEEK'S ORIGINAL FLOWS ARE PROVED"));
    expect(earned).toContain('IF proved THEN RETURN false; END IF;');
    expect(earned).toContain("p.kind='earned_plan_window'");
  });

  it('writes only the close caches, never money', () => {
    const writes = CODE.match(/\b(?:INSERT INTO|DELETE FROM|(?<!DO )UPDATE)\s+[\w.]+/gi) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).toMatch(/accounting_close_partials$/);
    }
  });
});
