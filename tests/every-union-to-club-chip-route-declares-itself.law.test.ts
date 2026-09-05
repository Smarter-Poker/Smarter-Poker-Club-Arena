/**
 * EVERY UNION TO CLUB CHIP ROUTE DECLARES ITSELF (chip standard, 2026-09-05).
 * Pinned on the migration mirrored byte-exact from production.
 *
 * Why: at 02:51 UTC on 2026-09-05 Dan sent promo from the Midway Union to
 * three clubs and none of it showed in a promo wallet. PR #3065 fixed the
 * routing (the modal called the Club Bank send for a club target, and
 * fn_union_promo_send credited chip_treasury). This law pins what the chip
 * standard learned from the journal that night:
 *
 * LAW 1 - THE CLUB BANK ROUTE WRITES ONE KEYED ROW. fn_union_send_to_club_atomic
 *   declares union_send, union_bank -> club_treasury, keyed on the operation.
 *   Before this it wrote two undeclared adjustments through settlement_suspense,
 *   so a send nobody could find in a wallet was a send nobody could find in
 *   the journal either.
 * LAW 2 - THE JACKPOT SEED FROM UNION PROMO IS A DECLARED DOOR. The bbj_main
 *   branch of fn_union_promo_send declares promo_send, union_wallet ->
 *   bbj_pool, keyed, so the BBJ meter reads it as a seed.
 * LAW 3 - A NEW MONEY DOOR IS REGISTERED. fn_club_promo_wallet_send (new in
 *   #3065) has a ca_money_rpc_registry row; fn_ca_money_rpc_drift files an
 *   incident for any door that does not, and that incident was resolved with
 *   this migration as its correction_ref.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_every_union_to_club_chip_route_declares_itself\.sql$/.test(n)
);
if (!file) throw new Error('the migration is not mirrored');
const sql = readFileSync(resolve(MIG, file), 'utf8');

const body = (name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is re-created in the migration`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end);
};

describe('every union to club chip route declares itself', () => {
  it('LAW 1: the Club Bank route declares union_send, union_bank -> club_treasury, keyed on the op', () => {
    const b = body('fn_union_send_to_club_atomic');
    expect(b).toMatch(
      /fn_ca_declare_ledger\('union_send',\s*'union_bank',\s*p_union_id,\s*NULL,\s*'union_send_to_club:'\s*\|\|\s*v_op::text,\s*ARRAY\['union_wallets'\]\)/
    );
    expect(b).toMatch(/v_op uuid := COALESCE\(p_op_id, gen_random_uuid\(\)\)/);
    expect(b).toMatch(/UPDATE clubs SET chip_treasury = COALESCE\(chip_treasury, 0\) \+ p_amount/);
    expect(b).toMatch(/set_config\('app\.ledger_autoskip_union_wallets', '', true\)/);
  });

  it('LAW 2: the bbj_main branch of fn_union_promo_send declares promo_send, union_wallet -> bbj_pool, keyed', () => {
    const b = body('fn_union_promo_send');
    const branch = b.slice(b.indexOf("-- destination = 'bbj_main'"));
    expect(branch).toMatch(
      /fn_ca_declare_ledger\('promo_send',\s*'union_wallet',\s*p_union_id,\s*NULL,\s*'union_promo_to_bbj:'\s*\|\|\s*p_op_id::text,\s*ARRAY\['union_wallets'\]\)/
    );
    expect(branch).toMatch(
      /UPDATE bbj_pools\s+SET main_balance = COALESCE\(main_balance,0\) \+ v_amt/
    );
    // The club branch from #3065 is kept as it was: promo lands in the club promo wallet.
    expect(b).toMatch(/'union_promo_to_club:'\s*\|\|\s*p_op_id::text/);
    expect(b).toMatch(/UPDATE clubs SET promo_balance = COALESCE\(promo_balance, 0\) \+ v_amt/);
  });

  it('LAW 3: the new door is registered and the drift incident is resolved by this migration', () => {
    expect(sql).toMatch(/\('fn_club_promo_wallet_send', 'approved'/);
    expect(sql).toMatch(/\('fn_union_send_to_club_atomic', 'approved'/);
    expect(sql).toMatch(/\('fn_union_promo_send', 'approved'/);
    expect(sql).toMatch(/dedupe_key = 'rpc-drift:fn_club_promo_wallet_send' AND status = 'open'/);
    expect(sql).toMatch(
      /correction_ref = 'migration 20260905034557_every_union_to_club_chip_route_declares_itself'/
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'money rpc drift is not zero for the chip standard doors/);
  });

  it('the migration is one transaction and every re-created definer states its ACL', () => {
    expect(sql.trim().startsWith('-- 20260905034557')).toBe(true);
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_union_promo_send\(uuid, numeric, text, uuid, uuid, uuid, text\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_union_promo_send\(uuid, numeric, text, uuid, uuid, uuid, text\) TO service_role;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_union_send_to_club_atomic\(uuid, uuid, numeric, text, uuid, uuid\) TO service_role;/
    );
  });
});
