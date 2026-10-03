import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AN AGREEMENT BASELINE IS IN FORCE FROM INCEPTION (Dan, 2026-09-27).
 *
 * accounting_agreement_history opened with one baseline snapshot at
 * 2026-09-14 12:09:27Z. Every reader asked for the row observed AT OR BEFORE
 * an instant, so a fee charged earlier had no terms and 18 tournaments
 * (741.86 chips) were parked in legacy fee custody. The rule is now: when a
 * key has no row at or before the instant and its EARLIEST row is its
 * baseline, that baseline is in force. It lives in one function,
 * fn_accounting_history_in_force_from_inception, and every producer AND
 * verifier of agreement receipts uses it. A producer that accepted the
 * baseline while a verifier still demanded observed_at <= terms_at would write
 * receipts the union close and the weekly rakeback refuse.
 *
 * Native proof: scripts/dev/test-accounting-agreement-history.sh installs the
 * verbatim production preimages, applies the migration, and runs
 * tests/fixtures/accounting-agreement-history/baseline-inception-regression.sql
 * (it raises accounting_terms_not_observed without the migration).
 * Registry: docs/laws.d/an-agreement-baseline-is-in-force-from-inception.md
 */

const root = resolve(__dirname, '..');
const MIGRATION =
  'supabase/migrations/20260927221954_an_agreement_baseline_is_in_force_from_inception.sql';
const PREIMAGE = 'tests/fixtures/accounting-agreement-history/baseline-inception-preimage.sql';
const REGRESSION = 'tests/fixtures/accounting-agreement-history/baseline-inception-regression.sql';
const RUNNER = 'scripts/dev/test-accounting-agreement-history.sh';
const RULE = 'public.fn_accounting_history_in_force_from_inception(';

const read = (p: string) => readFileSync(join(root, p), 'utf8');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

type Edit = { signature: string; pre: string; post: string; olds: string[]; news: string[] };

/** The migration's VALUES rows: signature, preimage md5, postimage md5, edits. */
function edits(): Edit[] {
  const sql = read(MIGRATION);
  const body = sql.slice(
    sql.indexOf('FOR item IN SELECT * FROM (VALUES'),
    sql.indexOf(') AS t(signature')
  );
  return body
    .split(/\n {2}\('/)
    .slice(1)
    .map((row) => {
      const head = /^(public\.[^']+)','([0-9a-f]{32})','([0-9a-f]{32})'/.exec(row);
      if (!head) throw new Error('unparsable migration row: ' + row.slice(0, 80));
      const arrays = row.split(/\n {3}ARRAY\[/).slice(1);
      const literals = (a: string) => [...a.matchAll(/\$r\$([\s\S]*?)\$r\$/g)].map((m) => m[1]);
      return {
        signature: head[1],
        pre: head[2],
        post: head[3],
        olds: literals(arrays[0]),
        news: literals(arrays[1]),
      };
    });
}

/** Each verbatim preimage in the fixture, keyed by function name. */
function preimages(): Map<string, { md5: string; definition: string }> {
  const out = new Map<string, { md5: string; definition: string }>();
  const text = read(PREIMAGE);
  for (const block of text.split('\n-- preimage md5 ').slice(1)) {
    const declared = block.slice(0, 32);
    const definition = block.slice(33, block.indexOf('$function$\n;') + '$function$\n'.length);
    const name = /FUNCTION public\.(\w+)\(/.exec(definition)![1];
    out.set(name, { md5: declared, definition });
  }
  return out;
}

const nameOf = (signature: string) => /public\.(\w+)\(/.exec(signature)![1];

describe('an agreement baseline is in force from inception', () => {
  const rows = edits();
  const pre = preimages();

  it('edits every producer and verifier of agreement receipts, and nothing else', () => {
    expect(rows.map((r) => nameOf(r.signature)).sort()).toEqual([
      'fn_accounting_agent_terms_at',
      'fn_accounting_earning_contract',
      'fn_accounting_terms_at',
      'fn_accounting_union_earned_plan',
      'fn_calculate_cash_rakeback_periods',
    ]);
  });

  it('the fixture preimages are the production definitions the migration asserts', () => {
    for (const r of rows) {
      const p = pre.get(nameOf(r.signature))!;
      expect(p, r.signature).toBeDefined();
      expect(md5(p.definition), r.signature).toBe(p.md5);
      expect(p.md5, r.signature).toBe(r.pre);
    }
  });

  it('every edit is one exact occurrence, adds the single rule, and yields the asserted postimage', () => {
    for (const r of rows) {
      let text = pre.get(nameOf(r.signature))!.definition;
      expect(r.olds.length, r.signature).toBe(r.news.length);
      r.olds.forEach((old, i) => {
        expect(text.split(old).length - 1, `${r.signature} edit ${i}`).toBe(1);
        expect(r.news[i], `${r.signature} edit ${i}`).toContain(RULE);
        expect(r.news[i]).not.toMatch(/—/);
        text = text.split(old).join(r.news[i]);
      });
      expect(md5(text), r.signature).toBe(r.post);
      expect(read(MIGRATION)).toContain(
        `-- @live-proof: (SELECT md5(pg_get_functiondef('${r.signature}'::regprocedure)) = '${r.post}')`
      );
    }
  });

  it('the rule is a first-row baseline only, and stays private', () => {
    const sql = read(MIGRATION);
    const rule = sql.slice(
      sql.indexOf('CREATE FUNCTION public.fn_accounting_history_in_force_from_inception'),
      sql.indexOf('$fn$;')
    );
    expect(rule).toContain("b.event_type='baseline'");
    expect(rule).toMatch(/NOT EXISTS\(SELECT 1 FROM public\.accounting_agreement_history e/);
    expect(rule).toContain(
      'e.observed_at<b.observed_at OR (e.observed_at=b.observed_at AND e.id<b.id)'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_history_in_force_from_inception(bigint) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('the native runner proves it on the production preimages, in order', () => {
    const runner = read(RUNNER);
    const at = (p: string) => runner.indexOf(p);
    expect(at(PREIMAGE)).toBeGreaterThan(0);
    expect(at(MIGRATION)).toBeGreaterThan(at(PREIMAGE));
    expect(at(REGRESSION)).toBeGreaterThan(at(MIGRATION));
  });

  it('NEGATIVE: the preimage reader refuses the instant before a baseline', () => {
    const terms = pre.get('fn_accounting_terms_at')!.definition;
    expect(terms).toContain('observed_at<=p_at');
    expect(terms).toContain(
      " IF NOT FOUND THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;"
    );
    expect(terms).not.toContain(RULE);
    const regression = read(REGRESSION);
    expect(regression).toContain('a membership charged before the baseline reads its baseline');
    expect(regression).toContain('a key first seen by INSERT is unobserved before the baseline');
  });
});
