/**
 * A WEEKLY STATEMENT FITS ITS CLOSE ATTEMPT (2026-10-17)
 *
 * The 2026-10-05 Midway close paid rounds 1-3 and then could not finish: every
 * job 272 attempt timed out at 240 s inside the first club statement, because
 * each statement proved the whole union's tournament week (more than 175 s,
 * reading history instead of the week) and fingerprinted 1.2M sources by their
 * full contract text under a collated sort (90 s), for two clubs in one
 * attempt. Pinned on 20261017223358:
 *   - the tournament week proof reads the week, by key, with the same tests;
 *   - the rake record fingerprint inline is the function's exact jsonb object;
 *   - the statement fingerprints immutable sources by identity (v3 key);
 *   - a chunked close proves one club per attempt and keeps the READY proof as
 *     a close certificate before anything is settled or issued;
 *   - those certificates never count as a re-proof of the P&L report.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017223358_a_weekly_statement_fits_its_close_attempt.sql',
  'utf8'
);

const block = (tag: string) => {
  const start = sql.indexOf(`DO $${tag}$`);
  const end = sql.indexOf(`$${tag}$;`, start + 1);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
};
const pairs = (body: string) => {
  const out: Array<[string, string]> = [];
  for (let i = 0; ; i += 1) {
    const o = body.split(`$o${i}$`)[1];
    const n = body.split(`$n${i}$`)[1];
    if (o === undefined) break;
    expect(n).toBeDefined();
    out.push([o, n as string]);
  }
  return out;
};

const FIELDS = [
  'id', 'hand_id', 'table_id', 'club_id', 'rake_amount', 'bbj_contribution', 'pot_size',
  'num_players', 'created_at', 'player_contributions', 'global_hand_id', 'is_tournament',
  'tournament_id', 'source', 'metadata', 'rake_method', 'returned_uncalled',
];

describe('a weekly statement fits its close attempt', () => {
  it('is one guarded transaction over four exact bodies', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('fn_ca_break_window_refuses_migrations(now())');
    expect(sql).toContain('fn_platform_frozen() IS DISTINCT FROM false');
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(4);
    for (const [pre, post] of [
      ['f7679646772ffde0a3c659fbe214fa0f', 'a3835ceb0138f097a2130970e3eab34a'],
      ['d758a70fe31aa3fa828704a0ee1788cd', 'f65b242882b9fed2f93fb4acbc9c91b9'],
      ['c10eaa893fb7b59e073d5687b4437bdd', '88417415bde34f4d8ea462950aa7f20f'],
      ['981a3fdf3bdba29ed736f8656a9e544b', '58a9a79da50f36fa5fbc4242e8cec8f7'],
    ]) {
      expect(sql).toContain(`IF md5(v_def) <> '${pre}' THEN`);
      expect(sql).toContain(`IF md5(v_def) = '${post}' THEN RETURN; END IF;`);
      expect(sql).toContain(`IF md5(v_def) <> '${post}' THEN`);
    }
    expect(sql.match(/IF pg_get_functiondef\(v_oid\) IS DISTINCT FROM v_def THEN/g)?.length).toBe(4);
    expect(sql.match(/p\.proacl::text IS NOT DISTINCT FROM v_acl/g)?.length).toBe(4);
    expect(sql).toContain('smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true');
  });

  it('proves the tournament week by key, with the same tests and the same fingerprint', () => {
    const q = pairs(block('quality'));
    expect(q.length).toBe(10);
    const after = q.map(([, n]) => n).join('\n');
    // History-wide sets are gone; each test is a per-event index probe.
    expect(q[0][0]).toContain('club_sourced AS (');
    expect(q[0][1]).not.toContain('club_sourced');
    expect(after).not.toMatch(/FROM club_(sourced|refunded)/);
    expect(after).toContain(
      'cs.tournament_id=s.tournament_id\n        AND (cs.club_id=p_club_id OR (scope_union IS NOT NULL AND cs.coordinator_union_id=scope_union)) OFFSET 0)'
    );
    expect(after).toContain('cr.tournament_id=s.tournament_id\n        AND cr.refund_wallet_club_id=p_club_id OFFSET 0)');
    expect(after).toContain('WHERE b0.tournament_id=c.tournament_id OFFSET 0) b ON true');
    expect(after).toContain('WHERE s.tournament_id=ANY((SELECT array_agg(c.tournament_id) FROM candidates c)::uuid[])');
    // The four unknown-scope EXISTS keep their text and gain only OFFSET 0.
    for (const [o, n] of q.slice(5, 9)) {
      expect(n.replace(/ OFFSET 0/g, '')).toBe(o);
    }
    // The inline fingerprint is exactly the function's 17 fields, in its order.
    expect(q[9][0]).toBe('public.fn_accounting_tournament_fee_fingerprint(r) AS fp');
    const keys = [...q[9][1].matchAll(/'([a-z_]+)',r\.([a-z_]+)/g)];
    expect(keys.map((m) => m[1])).toEqual(FIELDS);
    expect(keys.every((m) => m[1] === m[2])).toBe(true);
    expect(q[9][1]).toMatch(/^md5\(jsonb_build_object\(.*\)::text\) AS fp$/);
    // ... and is checked against the function itself on install.
    const check = block('fingerprint');
    expect(check).toContain('public.fn_accounting_tournament_fee_fingerprint(r) IS DISTINCT FROM');
    expect(check).toContain(q[9][1].replace(' AS fp', ''));
    // The fingerprint function itself is not touched (an admission guard pins it).
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_accounting_tournament_fee_fingerprint/);
  });

  it('fingerprints a statement by immutable source identity, under a new key', () => {
    const s = pairs(block('summary'));
    expect(s.length).toBe(3);
    expect(s[0][0]).toContain('s.rake_credit,s.contract)::text');
    expect(s[0][1]).toContain(
      "md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit)::text),'' ORDER BY s.source_id,s.source_type COLLATE \"C\""
    );
    expect(s[1]).toEqual([
      "'source_count',source_count,'source_fingerprint_v2',source_fingerprint,",
      "'source_count',source_count,'source_fingerprint_v3',source_fingerprint,",
    ]);
    // A ready certificate, read only for a union period, else proved as before.
    expect(s[2][1]).toContain(
      "quality:=CASE WHEN period.union_id IS NOT NULL THEN public.fn_accounting_close_certificate(\n  'club_statement_quality:'||period.club_id::text,period.union_id,period.start_at,period.end_at) END;"
    );
    expect(s[2][1]).toContain(
      "IF quality->>'status' IS DISTINCT FROM 'ready' THEN\n  quality:=public.fn_accounting_tournament_week_quality(period.club_id,period.start_at,period.end_at);"
    );
  });

  it('keeps one club proof per chunked attempt, before anything is settled or issued', () => {
    const c = pairs(block('cascade'));
    expect(c.length).toBe(2);
    const stage = c[1][1];
    expect(c[1][0]).toBe('  -- The period is an accounting object, not a by-product of invoicing.\n');
    expect(stage.endsWith(c[1][0])).toBe(true);
    expect(stage).toContain('  IF v_chunked THEN');
    expect(stage).toContain(
      "CONTINUE WHEN public.fn_accounting_close_certificate('club_statement_quality:'||v_credit_club.club_id::text,"
    );
    expect(stage).toContain('PERFORM public.fn_weekly_accounting_deadline_check();');
    expect(stage).toContain(
      "RAISE EXCEPTION 'club_weekly_statement_requires_reconciliation' USING ERRCODE='23514',"
    );
    expect(stage).toContain(
      "PERFORM public.fn_accounting_close_certify('club_statement_quality:'||v_credit_club.club_id::text,"
    );
    // A chunk is committed only when the proof reads back as kept.
    const certify = stage.indexOf('fn_accounting_close_certify(');
    const readback = stage.indexOf('fn_accounting_close_certificate(', certify);
    const ret = stage.indexOf("'chunk_committed', true, 'committed_round', 3,", readback);
    expect(certify).toBeGreaterThan(0);
    expect(readback).toBeGreaterThan(certify);
    expect(ret).toBeGreaterThan(readback);
    expect(stage).toContain("'stage', 'statement_evidence'");
    expect(stage.indexOf('EXIT;')).toBeGreaterThan(ret);
    // Nothing that settles, issues or pays is in the stage.
    expect(stage).not.toMatch(/fn_mark_scope_accounting_settled|fn_issue_|fn_union_issue_|fn_credit|INSERT|UPDATE/);
  });

  it('never treats a statement proof as a re-proof of the P&L report', () => {
    const r = pairs(block('seed'));
    expect(r).toEqual([
      [
        '       AND c.certified_at>r.computed_at);',
        "       AND c.certified_at>r.computed_at AND c.kind NOT LIKE 'club\\_statement\\_quality:%');",
      ],
    ]);
  });
});
