/**
 * LAW: A UNION WALLET SIDE ALWAYS NAMES ITS COLUMN (2026-10-04, chip drift).
 *
 * A union_wallets row holds six balances. A leg whose union_wallet side does
 * not say which one moved cannot be keyed by the ledger replay: on 2026-10-04
 * 1,489,358.47 of rake payments written that way read as kill-switch drift on
 * Midway's rake wallet (fixed at those payers in 20261004124640).
 *
 * The same bare side was still reachable wherever a payer declares a union
 * wallet as the AUTOLEDGER counterparty, because the trigger labels only the
 * balance it watched. This pins the class closed:
 *   1. fn_ca_declare_ledger clears app.ledger_counterparty_label; the
 *      autoledger writes it on the counterparty side, and only when it can
 *      belong to that counterparty; save/restore carry it;
 *   2. every payer that declares a union wallet (or a club promo bank) whose
 *      own side is not a promo bank names the column it moves;
 *   3. a union_wallet side labelled union_wallets.chip_balance is the
 *      union_bank account in all three journal readers;
 *   4. chip_ledger refuses a bare union_wallet side, with exactly the replay's
 *      promo rule and the journal-only correction as exceptions.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGS = resolve(process.cwd(), 'supabase/migrations');
const files = () =>
  readdirSync(MIGS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const SQL = (() => {
  const hit = files().filter((f) => f.endsWith('_a_union_wallet_side_always_names_its_column.sql'));
  expect(hit).toHaveLength(1);
  return readFileSync(resolve(MIGS, hit[0]), 'utf8');
})();
function latest(name: string): { file: string; body: string } {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`);
  for (const f of files().reverse()) {
    const sql = readFileSync(resolve(MIGS, f), 'utf8');
    const m = re.exec(sql);
    if (m) return { file: f, body: sql.slice(m.index, sql.indexOf('$function$;', m.index)) };
  }
  throw new Error(`${name} is never declared`);
}
const setLabel = (value: string) =>
  `PERFORM set_config('app.ledger_counterparty_label', ${value}, true);`;

describe('a union wallet side always names its column', () => {
  it('a declaration forgets the last column; the autoledger writes the declared one on the counterparty side', () => {
    expect(SQL).toContain(setLabel("''"));
    expect(SQL).toContain('  cat text; cp text; cpid uuid; cplbl text;\n');
    expect(SQL).toContain(
      "    WHEN cp = 'union_wallet' AND cplbl LIKE 'union_wallets.%' THEN cplbl\n"
    );
    expect(SQL).toContain(
      "        CASE WHEN d > 0 THEN cplbl ELSE TG_TABLE_NAME || '.' || col END,\n"
    );
    expect(SQL).toContain(
      "        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE cplbl END,\n"
    );
    // the counterparty side never reverts to a hard NULL label
    expect(SQL).not.toMatch(/\$n\d+\$[^$]*CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME/);
    expect(SQL).toContain('counterparty_entity|counterparty_label|autoskip_');
    expect(SQL).toContain(
      "'app.ledger_counterparty_label',  COALESCE(current_setting('app.ledger_counterparty_label', true), ''));"
    );
    expect(SQL).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_autoledger',"
    );
  });

  it('every payer that declared a bare union wallet names the column it moves', () => {
    // promo rain, promo disbursement, BBJ backup to promo, union promo sends
    expect(SQL.split(setLabel("'union_wallets.promo_wallet'")).length - 1).toBe(5);
    // the club promo bank of a rain or a disbursement
    expect(SQL.split(setLabel("'clubs.promo_balance'")).length - 1).toBe(2);
    // the union bank funding the jackpot, and the union player P&L
    expect(SQL.split(setLabel("'union_wallets.chip_balance'")).length - 1).toBe(2);
    // union send: the promo path, then the source the operator chose
    expect(SQL).toContain(
      "case when p_kind = 'promo' then 'union_wallets.promo_wallet' else '' end, true);"
    );
    expect(SQL).toContain("case v_source when 'chips' then 'union_wallets.chip_balance'");
    expect(SQL).toContain("when 'rake' then 'union_wallets.rake_wallet'");
    // spin seed repayment names the owner wallet it returns to
    expect(SQL).toContain(
      "CASE WHEN v_kind = 'union' THEN 'union_wallets.' || v_wallet ELSE '' END, true);"
    );
    // the P&L restores its declaration without leaving its column behind
    expect(SQL).toContain("PERFORM set_config('app.ledger_counterparty_label','',true);");
  });

  for (const fn of [
    'fn_ca_leg_accounts',
    'fn_ca_leg_accounts_since_snapshot',
    'fn_ca_leg_accounts_since_snapshot_for',
  ]) {
    it(`the newest ${fn} reads the union bank as one account whoever names it`, () => {
      const live = latest(fn);
      const norm =
        "CASE WHEN k.t = 'union_wallet' AND k.col = 'union_wallets.chip_balance' THEN 'union_bank' ELSE k.t END";
      expect(live.body.split(norm), live.file).toHaveLength(3); // key and type
      expect(live.body).toContain('GROUP BY 1, 2, 3, 4, 5');
    });
  }

  it('chip_ledger refuses a bare union wallet side, with the replay rule and journal-only corrections excepted', () => {
    expect(SQL).toContain(
      'ADD CONSTRAINT chip_ledger_a_union_wallet_side_names_its_column CHECK ('
    );
    expect(SQL).toMatch(/\)\s+NOT VALID;/);
    for (const side of [
      ["from_type IS DISTINCT FROM 'union_wallet'", 'from_label IS NOT NULL', "COALESCE(to_label, '') LIKE '%promo%'"],
      ["to_type IS DISTINCT FROM 'union_wallet'", 'to_label IS NOT NULL', "COALESCE(from_label, '') LIKE '%promo%'"],
    ])
      for (const c of side) expect(SQL).toContain(c);
    // NULL never satisfies the check by accident: every nullable read is coalesced
    expect(SQL.match(/COALESCE\(metadata ->> 'posted_via', ''\) = 'fn_ca_post_correction'/g)).toHaveLength(2);
    expect(SQL).not.toMatch(/OR (to|from)_label LIKE/);
  });

  it('is one pinned transaction with asserted preimages, results and grants', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '3s';");
    expect(SQL).toContain('UNION_SIDE_LABEL_NEEDS_20261004124640');
    for (const c of ['PREIMAGE_CHANGED', 'RESULT_CHANGED', 'AUTHORITY_CHANGED'])
      expect(SQL).toContain('UNION_SIDE_LABEL_' + c);
    expect(SQL.match(/^GRANT EXECUTE ON FUNCTION public\.fn_ca_leg_accounts/gm)).toHaveLength(3);
    expect(SQL.match(/^GRANT /gm)).toHaveLength(3);
    // records nothing and moves nothing
    expect(SQL).not.toMatch(/INSERT INTO public\.chip_ledger|UPDATE public\./);
  });
});
