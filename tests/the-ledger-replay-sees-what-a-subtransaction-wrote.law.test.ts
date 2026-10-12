/**
 * LAW: THE LEDGER REPLAY SEES WHAT A SUBTRANSACTION WROTE, AND A UNION RAKE
 * PAYMENT NAMES ITS COLUMN (2026-10-04, chip drift).
 *
 * The 2026-10-04 06:40 replay tripped the kill switch at -1,489,348.47 on
 * Midway's union rake wallet and filed 190.00 on a player wallet and a 6.21
 * pair across a jackpot pool and a club promo bank. No chip was lost.
 *
 * 1. A union_wallets row holds six balances, so a union_wallet side of a leg
 *    must say which one moved. The weekly close, its retained-share transfer
 *    and the legacy week wrote theirs with no label; the replay could not key
 *    them, and the rake wallet was judged with its rake in and none of its
 *    1,489,358.47 of payments out.
 * 2. A leg inserted inside a BEGIN ... EXCEPTION block carries the
 *    SUBTRANSACTION's id as xmin, and pg_visible_in_snapshot cannot judge a
 *    subtransaction id. A leg whose parent straddled a reading came back
 *    "visible" to that reading, so the next window skipped it while the
 *    balance moved. Every leg now records pg_current_xact_id() (the top-level
 *    transaction) and both journal readers judge that.
 *
 * What this pins: the column and who stamps it; both readers, newest on disk,
 * judging COALESCE(top_xid, xmin) and never xmin alone; the three payers'
 * union side naming the rake wallet; and both migrations as single pinned
 * transactions with asserted pre- and post-images.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGS = resolve(process.cwd(), 'supabase/migrations');
const files = () =>
  readdirSync(MIGS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const named = (slug: string): string => {
  const hit = files().filter((f) => f.endsWith(`_${slug}.sql`));
  expect(hit, `exactly one migration carries ${slug}`).toHaveLength(1);
  return readFileSync(resolve(MIGS, hit[0]), 'utf8');
};
/** The newest CREATE OR REPLACE of a function anywhere in the corpus. */
function latest(name: string): { file: string; body: string } {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`);
  for (const f of files().reverse()) {
    const sql = readFileSync(resolve(MIGS, f), 'utf8');
    const m = re.exec(sql);
    if (m) return { file: f, body: sql.slice(m.index, sql.indexOf('$function$;', m.index)) };
  }
  throw new Error(`${name} is never declared`);
}

const FIX = named('the_ledger_replay_sees_what_a_subtransaction_wrote_and_a_uni');
const RECORDS = named('the_drift_the_replay_misread_is_rebaselined_and_its_incident');

const JUDGED_BY_TOP =
  'AND NOT pg_visible_in_snapshot(COALESCE(l.top_xid, public.fn_ca_xid8(l.xmin)), p_prev_snapshot)';
const JUDGED_BY_XMIN = 'pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin)';

describe('the ledger replay sees what a subtransaction wrote', () => {
  it('every leg records the top-level transaction, stamped by the journal, never by the writer', () => {
    expect(FIX).toContain('ALTER TABLE public.chip_ledger ADD COLUMN top_xid xid8;');
    // no default: a catalogue change, never a rewrite of the journal
    expect(FIX).not.toMatch(/ADD COLUMN top_xid xid8\s+DEFAULT/);
    expect(FIX).toContain('  NEW.top_xid := pg_current_xact_id();\n');
    expect(FIX).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_chip_ledger_enrich',"
    );
  });

  for (const fn of ['fn_ca_leg_accounts_since_snapshot', 'fn_ca_leg_accounts_since_snapshot_for']) {
    it(`the newest ${fn} judges a leg by the transaction that commits it`, () => {
      const live = latest(fn);
      expect(live.body.split(JUDGED_BY_TOP), `${live.file}: both sides of a leg`).toHaveLength(3);
      expect(live.body, `${live.file} judges a subtransaction id again`).not.toContain(
        JUDGED_BY_XMIN
      );
      // the scan is still bounded by created_at, and only bounded by it
      expect(live.body).toContain("WHERE l.created_at > p_prev_at - interval '15 minutes'");
    });
  }

  it('a union rake payment names the column it leaves, on every payer that wrote one bare', () => {
    // the retained share, the weekly close's club legs, and both legacy rounds
    expect(FIX).toContain(
      "(v_actor, 'union_wallet', u, 'union_wallets.rake_wallet', 'union_bank', u,"
    );
    expect(FIX).toContain(
      "VALUES(v_actor,'union_wallet',p_union_id,'union_wallets.rake_wallet','club_treasury',"
    );
    expect(FIX).toContain(
      "'union_wallet',op.union_id,'union_wallets.rake_wallet','club_treasury',"
    );
    expect(FIX).toContain(
      "CASE r.payer_kind WHEN 'club' THEN NULL WHEN 'agent' THEN NULL ELSE 'union_wallets.rake_wallet' END,"
    );
    // each column list gained from_label exactly where its value was added
    expect(FIX.match(/from_entity_id, ?from_label, ?to_type/g)).toHaveLength(4);
  });

  it('the fix is one pinned transaction with asserted pre-images, results and grants', () => {
    expect(FIX.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FIX.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FIX).toContain("SET LOCAL lock_timeout = '3s';");
    for (const m of [
      'ec36a30011e62e266e3385ef407fe064', // full reader before
      '2994dc949e5ed22c3f8f0ef832652cb8', // entity reader before
      '5931f47d922eea26ab1ea2b12f3f7c8c', // enrich before
      'ecbe8d54d177c002b4bd9c76770ac11a', // retained share before
      '6cb1cce06a2f553697e434d8004d64b8', // weekly close before
      'c2d44f4f6462a307228673452cf993dc', // legacy week before
      'cf5ae457ca0f7543d26f2f65b6812916', // full reader after
      'fddb201e23c57a4f1de95940325ea646', // entity reader after
      '8d2fc088741a7cc63a9ea6adcb2a9e29', // enrich after
      '59de5c620c40dc3acb319c3f6b2b82e3', // retained share after
      '051c8a58a9092aa912e11e5391cf8e73', // weekly close after
      '87c4c1050d711ec8f65a3949e0171b24', // legacy week after
    ])
      expect(FIX).toContain(`'${m}'`);
    for (const c of ['PREIMAGE_CHANGED', 'RESULT_CHANGED', 'AUTHORITY_CHANGED'])
      expect(FIX).toContain('SUBXACT_LEG_' + c);
    // the readers stay closed to every browser role; nothing else is granted
    for (const sig of [
      'fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot)',
      'fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[])',
    ]) {
      expect(FIX).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(FIX).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
    expect(FIX.match(/^GRANT /gm)).toHaveLength(2);
  });

  it('the misread accounts are rebaselined as a first reading is, and nothing moves', () => {
    expect(RECORDS.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(RECORDS.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(RECORDS).toContain('DRIFT_MISREAD_FIX_NOT_INSTALLED');
    // the balance and its snapshot in one statement, a baseline with no residue
    expect(RECORDS).toMatch(
      /public\.fn_ca_account_balance\(s\.account_type, s\.entity_id, s\.club_id, s\.column_name\),\s+clock_timestamp\(\), true, NULL, 0, 'one-snapshot-v4',[\s\S]*?pg_current_snapshot\(\)::text/
    );
    // closed through the platform's own door, each with its root cause
    expect(RECORDS.match(/'resolve',/g)).toHaveLength(1);
    expect(RECORDS).toContain('public.fn_ca_incident_action(r.id, \'resolve\',');
    // records only: no balance column is written
    expect(RECORDS).not.toMatch(
      /UPDATE public\.(club_members|clubs|union_wallets|bbj_pools|agents|table_seats)\b/
    );
    expect(RECORDS).not.toMatch(/INSERT INTO public\.chip_ledger/);
  });
});
