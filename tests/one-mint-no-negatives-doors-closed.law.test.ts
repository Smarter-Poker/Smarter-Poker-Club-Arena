/**
 * ONE MINT, NO NEGATIVES, LEGACY DOORS CLOSED (chip standard Phase 3,
 * 2026-09-04). Three laws, each pinned on the migration text that is
 * mirrored byte-exact from production.
 *
 * LAW 1 - THE REGISTER FOLLOWS THE JOURNAL. Every journal leg whose source is
 *   a non-circulating store (a mint) or whose destination is one (a burn) has
 *   a ca_mint_ledger row linked to it by the time the transaction commits: a
 *   DEFERRABLE INITIALLY DEFERRED constraint trigger on chip_ledger writes one
 *   if the door did not. No door, present or future, can issue or retire a
 *   chip the register does not see, because the journal is the door. The
 *   register carries a labelled OPENING BASELINE per estate so that its net
 *   equals the supply meter's total from that instant; fn_ca_mint_register_vs_supply
 *   reports the difference, which must be the meter's own unexplained drift
 *   and nothing else.
 *
 * LAW 2 - A BALANCE CANNOT GO NEGATIVE. CHECK (col >= 0), validated, on every
 *   balance column the supply meter counts.
 *
 * LAW 3 - A LEGACY MONEY DOOR NOBODY CALLS IS CLOSED. EXECUTE revoked from
 *   every client role and the registry row set to closed, so
 *   fn_ca_money_rpc_drift files an incident if it is ever re-opened.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const find = (re: RegExp): string => {
  const f = readdirSync(MIG).find((n) => re.test(n));
  if (!f) throw new Error(`no migration matches ${re}`);
  return readFileSync(resolve(MIG, f), 'utf8');
};

describe('LAW 1: the register follows the journal', () => {
  const sql = find(/^\d{14}_phase_3_1_one_mint_the_register_follows_the_journal\.sql$/);

  it('a deferred constraint trigger on chip_ledger registers every issuance leg at commit', () => {
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER zz_ca_issuance_leg_is_registered/);
    expect(sql).toMatch(/AFTER INSERT ON public\.chip_ledger\s+DEFERRABLE INITIALLY DEFERRED/);
    // The store list is the non-circulating vocabulary of fn_ca_noncirculating_chip_stores.
    expect(sql).toMatch(
      /NEW\.from_type IN \('system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement'\)/
    );
    expect(sql).toMatch(/EXECUTE FUNCTION public\.fn_ca_issuance_leg_is_registered\(\)/);
  });

  it('a door that wrote its own register row is adopted, never doubled', () => {
    expect(sql).toMatch(
      /IF EXISTS \(SELECT 1 FROM public\.ca_mint_ledger m WHERE m\.chip_ledger_id = l\.id\) THEN\s+RETURN false;/
    );
    expect(sql).toMatch(/SET chip_ledger_id = l\.id/);
  });

  it('the opening baseline is labelled as a baseline, per estate, and sized to the meter', () => {
    expect(sql).toMatch(/'register-opening-baseline:' \|\| v_est\.id::text \|\| ':2026-09-04'/);
    expect(sql).toMatch(/'register-opening-baseline:circulation:2026-09-04'/);
    expect(sql).toMatch(/OPENING BASELINE, not issuance/);
    expect(sql).toMatch(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;/);
    expect(sql).toMatch(/PERFORM public\.fn_ca_supply_snapshot\(\);/);
    expect(sql).toMatch(/IF round\(v_register_net, 2\) <> round\(v_total, 2\) THEN/);
  });

  it('the diamond mint declares the Mint, and a browser cannot mint club chips by another door', () => {
    expect(sql).toMatch(
      /fn_ca_declare_ledger\('mint', 'issuance_reserve', null, null,\s+'diamond-mint:' \|\| v_op_id::text, null\)/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_mint_club_chips\(uuid, numeric, text, text\) FROM PUBLIC, anon, authenticated;/
    );
  });

  it('the register is checked against the meter and the migration asserts zero difference', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_mint_register_vs_supply\(\)/);
    expect(sql).toMatch(/IF v\.difference <> 0 THEN/);
  });

  it('the trigger is created LAST so the lock on chip_ledger is held for milliseconds', () => {
    const trig = sql.indexOf('CREATE CONSTRAINT TRIGGER zz_ca_issuance_leg_is_registered');
    const baseline = sql.indexOf("'register-opening-baseline:circulation:2026-09-04'");
    const diamond = sql.indexOf("'diamond-mint:'");
    expect(trig).toBeGreaterThan(baseline);
    expect(trig).toBeGreaterThan(diamond);
  });
});

describe('LAW 2: a balance cannot go negative', () => {
  const sql = find(/^\d{14}_phase_3_2_a_balance_cannot_go_negative\.sql$/);
  const columns: Array<[string, string[]]> = [
    ['clubs', ['chip_treasury', 'chip_pool', 'promo_balance', 'insurance_balance']],
    ['club_members', ['chip_balance', 'promo_balance']],
    [
      'union_wallets',
      [
        'chip_balance',
        'rake_wallet',
        'bbj_wallet',
        'promo_wallet',
        'insurance_wallet',
        'spin_reserve_wallet',
      ],
    ],
    ['agents', ['agent_wallet_balance', 'promo_wallet_balance']],
    ['table_seats', ['stack']],
    ['bbj_pools', ['main_balance', 'backup_balance', 'promo_balance']],
  ];

  it('every balance column the meter counts carries CHECK (col >= 0), added NOT VALID then VALIDATED', () => {
    for (const [table, cols] of columns) {
      for (const col of cols) {
        const name = `${table}_${col}_nonneg`;
        expect(sql).toMatch(new RegExp(`ADD CONSTRAINT ${name} CHECK \\(${col} >= 0\\) NOT VALID`));
        expect(sql).toMatch(new RegExp(`VALIDATE CONSTRAINT ${name}`));
      }
    }
    expect(sql).toMatch(/IF v_n <> 18 THEN/);
  });
});

describe('LAW 3: a legacy money door nobody calls is closed', () => {
  const sql = find(/^\d{14}_phase_3_3_legacy_money_doors_nobody_calls_are_closed\.sql$/);
  const closed = [
    'atomic_tournament_register',
    'atomic_tournament_unregister',
    'deduct_chip_balance',
    'distribute_chips',
    'fn_admin_close_table',
    'fn_agent_approve_cashout',
    'fn_ca_settle_hand_stacks',
    'fn_mint_club_chips',
    'fn_mint_club_chips_zd3core',
    'fn_resolve_bbj_pool',
    'fn_tournament_atomic_register',
    'fn_tournament_unregister_counter',
    'increment_rake_generated',
    'increment_union_chip_balance',
    'mass_fund_horses',
    'spin_pool_deposit',
    'spin_pool_draw',
  ];

  it('the seventeen names are revoked from every client role and registered as closed', () => {
    for (const n of closed) expect(sql).toContain(`'${n}'`);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.%I\(%s\) FROM PUBLIC, anon, authenticated, service_role/
    );
    expect(sql).toMatch(/VALUES \(r\.proname, 'closed',/);
    expect(sql).toMatch(/RAISE EXCEPTION 'a closed door is still executable by a client role';/);
  });

  it('the doors with a live caller are named as left open, not silently skipped', () => {
    for (const n of [
      'add_chips',
      'fn_credit_chips',
      'fn_debit_chips',
      'fn_mint_chips_from_diamonds',
      'fn_admin_kick_player',
      'fn_leave_seat_and_refund',
    ]) {
      expect(sql).toContain(n);
    }
  });
});
