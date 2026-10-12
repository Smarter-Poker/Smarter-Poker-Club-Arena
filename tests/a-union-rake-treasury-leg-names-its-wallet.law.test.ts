/**
 * A UNION RAKE TREASURY LEG NAMES ITS WALLET (2026-10-04).
 *
 * The nightly ledger replay resolves a union_wallet leg to a balance column by
 * its label. An unlabeled leg is keyed only when its counterparty is a promo
 * store; anything else is 'unkeyable' and left out of every account. The
 * weekly union close (each club's rakeback and the retained share) and the
 * legacy cascade debit union_wallets.rake_wallet through hand-written legs that
 * carried no from_label, so the first close the replay ever judged
 * (2026-10-01, week 09-21) read as -1,489,348.47 of rake-treasury drift and
 * tripped the kill switch on 2026-10-04 although every chip was journaled.
 *
 * Migration 20261004123650 names the column on each of those legs. This law
 * pins that, and refuses any later migration that hand-writes a chip_ledger
 * leg out of 'union_wallet' without saying which wallet column it debits.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const VERSION = '20261004123650';
const SLUG = 'a_union_rake_treasury_leg_names_its_wallet';
const sorted = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const M = fs.readFileSync(path.join(MIGRATIONS, `${VERSION}_${SLUG}.sql`), 'utf8');

/** Every `INSERT INTO public.chip_ledger (...) VALUES (...)` statement text. */
const chipLedgerInserts = (sql: string): string[] => {
  const out: string[] = [];
  const re = /INSERT\s+INTO\s+(?:public\.)?chip_ledger\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const end = sql.indexOf(';', m.index);
    out.push(sql.slice(m.index, end < 0 ? undefined : end));
  }
  return out;
};

describe('a union rake treasury leg names its wallet', () => {
  it('edits the three writers against pinned preimages and checks each postimage', () => {
    for (const [fn, md5] of [
      ['fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)', '6cb1cce06a2f553697e434d8004d64b8'],
      ['fn_union_close_post_rake_debit(jsonb)', 'ecbe8d54d177c002b4bd9c76770ac11a'],
      ['fn_accounting_legacy_pay_week(uuid)', 'c2d44f4f6462a307228673452cf993dc'],
    ]) {
      expect(M).toContain(`'public.${fn}'::regprocedure`);
      expect(M).toContain(`'${md5}'`);
    }
    expect(M.match(/postimage differs from the substituted text/g)?.length).toBe(3);
    expect(M).toMatch(/^BEGIN;/m);
    expect(M).toMatch(/^COMMIT;/m);
  });

  it('labels each club rakeback leg of the weekly close with the rake treasury', () => {
    expect(M).toContain(
      "metadata,pre_to_balance,post_to_balance,from_label)\n      VALUES(v_actor,'union_wallet',p_union_id,'club_treasury',"
    );
    expect(M).toContain(
      "(v_credit->>'balance_after')::numeric,'union_wallets.rake_wallet') RETURNING id INTO v_ledger_id;"
    );
  });

  it('labels the retained-share transfer out of the rake treasury', () => {
    expect(M).toContain('idempotency_key, metadata, from_label)');
    expect(M).toContain(
      "'clubs_paid', (p->>'clubs_paid')::int), 'union_wallets.rake_wallet') RETURNING id INTO v_ledger_id;"
    );
  });

  it('labels legacy round 1 always and round 3 exactly when the union pays', () => {
    expect(M).toContain(
      "(v_credit->>'balance_after')::numeric,'union_wallets.rake_wallet') RETURNING id INTO ledger_id;"
    );
    expect(M).toContain(
      "CASE r.payer_kind WHEN 'club' THEN NULL WHEN 'agent' THEN NULL ELSE 'union_wallets.rake_wallet' END) RETURNING id INTO ledger_id;"
    );
  });

  it('no later migration hand-writes a union_wallet leg without naming its wallet column', () => {
    // A file the repo marks as never-to-run (header or aliases row) is not a writer.
    const aliases = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'scripts/ci/applied-migration-aliases.json'), 'utf8')
    ) as { superseded?: { file: string }[] };
    const superseded = new Set(
      (aliases.superseded ?? []).map((row) => path.basename(row.file))
    );
    const later = sorted().filter(
      (f) =>
        f.slice(0, 14) > VERSION &&
        !superseded.has(f) &&
        // the marker lives in the file's leading comment block
        !/^--\s*SUPERSEDED BY\s+\d{14}\b/m.test(
          /^(?:--[^\n]*\n)*/.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))?.[0] ?? ''
        )
    );
    const offenders: string[] = [];
    for (const f of later) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      for (const stmt of chipLedgerInserts(sql)) {
        if (!/'union_wallet'/.test(stmt)) continue;
        const cols = stmt.slice(0, stmt.search(/\bVALUES\b|\bSELECT\b/i));
        if (!/from_label|to_label/.test(cols)) offenders.push(`${f}: ${stmt.split('\n')[0]}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
