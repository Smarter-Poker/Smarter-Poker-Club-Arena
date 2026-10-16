/**
 * ===========================================================================
 *  THE AUTOLEDGER NEVER JOURNALS AN ACCOUNT TO ITSELF (2026-10-15)
 * ===========================================================================
 *
 * fn_ca_autoledger writes one chip_ledger leg per changed balance column
 * against the counterparty the transaction declared. When one transaction
 * moved chips between two autoledgered columns and declared the destination
 * account itself as counterparty, the destination column's leg was written
 * from that account to that same account:
 *
 *   * 2026-10-06 15:42:39 UTC, KF player -> three club treasuries: three
 *     club_treasury -> club_treasury legs (494,917.55 / 510,990.88 / 6,222.93).
 *   * 2026-09-17 16:39 and 16:41 UTC, treasury -> promo: two
 *     promo_wallet -> promo_wallet legs (clubs.promo_balance).
 *
 * Both sides of such a leg share type, entity and club, so every tally nets it
 * to zero; it only doubled ledger rows and inflated gross flow. Migration
 * 20261015133250 skips it, except where a bare self-leg is the only record of
 * which column moved inside one account key: bbj_pool (fn_bbj_move_between_banks
 * and the fn_bbj_reconcile bank meters), union_wallet, and a promo bank off a
 * club. A labelled counterparty is never skipped.
 *
 * These pins keep the skip exactly that narrow, keep it written from the
 * asserted live preimage, and keep any later redefinition from dropping it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const FIX_VERSION = '20261015133250';
const FIX = '20261015133250_the_autoledger_never_journals_an_account_to_itself.sql';
const PRE_MD5 = '852f2e9b202459d7450407b71b7cb6f8';
const POST_MD5 = '620ce72294bdf8e3c8d3c556c8de35c9';
const read = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The skip, whitespace-normalised. */
const SKIP = ws(`CONTINUE WHEN cp = acct AND cpid IS NOT DISTINCT FROM v_entity AND cplbl IS NULL
              AND acct NOT IN ('bbj_pool', 'union_wallet')
              AND (acct <> 'promo_wallet' OR TG_TABLE_NAME = 'clubs');`);

/** Does this migration text redefine fn_ca_autoledger()? Same shapes the guard-declaration law reads. */
const redefinesAutoledger = (sql: string): boolean =>
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ca_autoledger\s*\(\s*\)/i.test(sql) ||
  (sql.includes('pg_get_functiondef') &&
    /\bEXECUTE\b/.test(sql) &&
    /fn_ca_autoledger\(\)'::regprocedure|p\.proname\s*=\s*'fn_ca_autoledger'/.test(sql));

describe('the autoledger never journals an account to itself', () => {
  const raw = read(FIX);
  const sql = code(raw);

  it('replaces the function from the asserted live preimage, in one short transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect(sql.trim()).toMatch(/COMMIT;$/);
    expect(sql.match(/^\s*BEGIN;/gm)).toHaveLength(1);
    expect(sql).toContain(
      `IF md5(pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure)) IS DISTINCT FROM '${PRE_MD5}' THEN`
    );
    expect(sql).toContain(`IS DISTINCT FROM '${POST_MD5}' THEN`);
    // the preimage check precedes the replacement, the postimage check follows it
    const create = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()');
    expect(sql.indexOf(PRE_MD5)).toBeLessThan(create);
    expect(sql.indexOf(POST_MD5)).toBeGreaterThan(create);
    expect(raw).toMatch(new RegExp(`^-- @live-proof: .*fn_ca_autoledger.*'${POST_MD5}'$`, 'm'));
  });

  it('skips only an unlabelled leg from and to the same account, after the zero-delta skip', () => {
    const body = ws(sql);
    expect(body).toContain(SKIP);
    expect(body.split(SKIP)).toHaveLength(2);
    expect(body.indexOf('CONTINUE WHEN d = 0;')).toBeLessThan(body.indexOf(SKIP));
    expect(body.indexOf(SKIP)).toBeLessThan(body.indexOf('INSERT INTO public.chip_ledger'));
    // a labelled counterparty documents a sub-balance move and is never skipped
    expect(SKIP).toContain('cplbl IS NULL');
    // the multi-column accounts whose bare self-leg is a column record are kept
    expect(SKIP).toContain("acct NOT IN ('bbj_pool', 'union_wallet')");
    expect(SKIP).toContain("(acct <> 'promo_wallet' OR TG_TABLE_NAME = 'clubs')");
  });

  it('changes nothing else: one leg per column, written exactly as before', () => {
    expect(sql.match(/INSERT INTO public\.chip_ledger/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+public\./i);
    expect(sql).not.toMatch(/DROP\s+(FUNCTION|TRIGGER)/i);
    expect(sql).toContain('CASE WHEN d > 0 THEN cp   ELSE acct END,');
    expect(sql).toContain('RAISE;');
  });

  it('declares the watched guard redefinition in the same transaction', () => {
    expect(sql).toContain(
      `SELECT public.fn_ca_declare_guard_redefinition('fn_ca_autoledger', 'migration ${FIX.replace(/\.sql$/, '')}');`
    );
    expect(sql.indexOf('fn_ca_declare_guard_redefinition')).toBeLessThan(
      sql.lastIndexOf('COMMIT;')
    );
  });

  it('no later migration redefines fn_ca_autoledger without the skip', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f) && f.slice(0, 14) > FIX_VERSION)
      .sort();
    const offenders = later.filter((f) => {
      const s = code(read(f));
      return redefinesAutoledger(s) && !ws(s).includes(SKIP);
    });
    expect(offenders).toEqual([]);
  });

  it('the redefinition detector sees both redefinition shapes (negative proof)', () => {
    expect(redefinesAutoledger(sql)).toBe(true);
    expect(
      redefinesAutoledger(
        'CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()\n RETURNS trigger AS $$ $$;'
      )
    ).toBe(true);
    expect(
      redefinesAutoledger(
        "v := pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure); EXECUTE replace(v, 'a', 'b');"
      )
    ).toBe(true);
    expect(redefinesAutoledger('SELECT public.fn_ca_autoledger_delete();')).toBe(false);
  });
});
