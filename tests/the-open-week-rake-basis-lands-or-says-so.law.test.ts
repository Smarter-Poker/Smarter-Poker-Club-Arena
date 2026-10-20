/**
 * THE OPEN-WEEK RAKE BASIS LANDS, OR SAYS SO, ONCE (2026-10-20)
 *
 * Pinned on migration 20261020010133_the_open_week_rake_basis_lands_or_says_so.sql.
 *
 * Job 123's open-week rake basis snapshot for Midway Union stopped at
 * 2026-10-19 15:43 and nothing said so: the refresh answered
 * 'windows_in_progress' every hour and the sweep counted that as skipped.
 * It never caught up because every saved window was stamped with a digest of
 * every club on the platform (a release certification club invalidated them
 * all), and the newest windows were read by nested loops over materialized
 * CTEs (105 s for one window). Native proof:
 * scripts/qualification/union-rake-basis-lands.py.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261020010133_the_open_week_rake_basis_lands_or_says_so.sql'
  ),
  'utf8'
);
const body = (tag: string) => {
  const open = sql.indexOf(`$${tag}$`);
  return sql.slice(open + tag.length + 2, sql.indexOf(`$${tag}$`, open + 1));
};
const windowFn = body('win');
const windowed = body('wnd');
const sweep = body('swp');

describe('the open-week rake basis lands, or says so once', () => {
  it('is one transaction that refuses the break window and any unpinned preimage', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('public.fn_ca_break_window_refuses_migrations(now())');
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(3);
    for (const md5 of [
      '102e5be492a144a705a2882d91675069',
      '2c2bbb252ef5d119bc6e9813bcc9354b',
      '12861fc647dd2b033ecc875f7b5fa3f7',
    ]) {
      expect(sql).toContain(`'${md5}'`);
    }
    expect(sql).toContain('IF md5(t.body) <> t.post THEN');
    expect(sql).toContain('IF pg_get_functiondef(v_oid) IS DISTINCT FROM t.body THEN');
  });

  it('joins the window by hash and reads only the window of recognitions', () => {
    expect(windowFn).toContain(" SET enable_indexscan TO 'off'\n SET enable_nestloop TO 'off'\n");
    expect(windowFn).toContain(
      "AND r.status='recognized' AND rs.recognized_at=r.recognized_at AND r.union_id=$1\n     AND r.recognized_at>=$2 AND r.recognized_at<$3\n"
    );
    // The six proofs are untouched.
    for (const q of ['AS q1,', 'AS q2,', 'AS q3,', 'AS q4,', 'AS q5,', 'AS q6']) {
      expect(windowFn).toContain(q);
    }
  });

  it("stamps a window with its own union's clubs, not every club on the platform", () => {
    expect(windowed).toContain("'clubs',digest))");
    expect(windowed).toContain(
      'FROM public.clubs c WHERE c.union_id=p_union_id OR c.id=p_union_id);'
    );
    expect(windowed).not.toContain('\n digest:=public.fn_accounting_clubs_scope_digest();');
    // A window saved under the platform digest is reused only while that digest is unchanged.
    expect(windowed).toContain('\n platform_digest:=public.fn_accounting_clubs_scope_digest();');
    expect(windowed).toContain(
      "AND (b.input_stamp=st OR b.input_stamp=st||jsonb_build_object('clubs',platform_digest));"
    );
  });

  it("installs over either production text or PR #7090's held postimage", () => {
    expect(sql).toContain(
      "ARRAY['2c2bbb252ef5d119bc6e9813bcc9354b', 'a68ecf97f457970970e97518d378e70c']"
    );
    expect(sql).toContain('IF NOT md5(v_def) = ANY (t.pre) THEN');
  });

  it('proves at least one window in every call before the budget can stop it', () => {
    expect(windowed).toContain(
      "IF n_computed>0 AND clock_timestamp()>began+(CASE WHEN closed THEN interval '120 seconds' ELSE interval '180 seconds' END) THEN"
    );
  });

  it('counts only a written or unchanged snapshot as landed', () => {
    expect(sweep).toContain(
      "AND (NOT COALESCE((v_rb->>'skipped')::boolean, false) OR v_rb->>'reason' = 'inputs_unchanged') THEN"
    );
    expect(sweep).toContain("v_kind := 'not_landed';");
    expect(sweep).toContain("v_kind := 'out_of_time';");
    expect(sweep).toContain("v_kind := 'failed';");
    // The unions a timeout leaves unreached are told too.
    expect(sweep).toContain("'not_attempted', true");
  });

  it('holds one open warning per union and kind, and a landing closes all three', () => {
    expect(sweep).toContain("AND COALESCE(a.context->>'kind', 'failed') = v_kind");
    expect(sweep).toContain("'repeats', COALESCE((a.context->>'repeats')::int, 0) + 1)");
    expect(sweep).toContain(
      "AND COALESCE(a.context->>'kind', 'failed') IN ('out_of_time', 'not_landed', 'failed')"
    );
    // Exactly one INSERT of a refresh warning, reached only when none is open.
    expect(sweep.match(/VALUES \('fn_union_rake_basis_refresh', 'warning', v_msg,/g)?.length).toBe(
      1
    );
    expect(sweep).toContain('IF v_alert IS NULL THEN');
  });

  it('builds no repair job and changes no money path', () => {
    expect(sql).not.toMatch(/cron\.(schedule|alter_job)/);
    expect(sql).not.toMatch(/fn_\w*_(repair|backpay|redrive|catchup|heal)_\w*/);
    // Exactly the three functions; the refresh itself is not replaced.
    expect(
      sql.match(/^\s+\('public\.fn_[a-z_]+\((?:uuid,timestamptz,timestamptz|integer)\)',$/gm)
    ).toEqual([
      "      ('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)',",
      "      ('public.fn_union_rake_basis_windowed(uuid,timestamptz,timestamptz)',",
      "      ('public.fn_union_integrity_sweep_all(integer)',",
    ]);
  });
});
