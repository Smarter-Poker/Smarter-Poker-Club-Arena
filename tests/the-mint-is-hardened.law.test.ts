/**
 * THE MINT IS HARDENED (chip standard, 2026-09-04). Pinned on the migration
 * text mirrored byte-exact from production (20260904194036_the_mint_hardened).
 *
 * LAW 1 - THE REGISTER IS APPEND-ONLY. ca_mint_ledger refuses UPDATE and
 *   DELETE on the same terms as the journal; the one permitted update is
 *   linking a row to its journal leg (chip_ledger_id NULL -> value, nothing
 *   else changed). One register row per leg is a unique index, not a habit.
 * LAW 2 - THE DOORS LINK BY KEY. fn_ca_mint and fn_ca_burn declare their leg
 *   with an idempotency key ('mint:' / 'burn:' + op id) and find it by that
 *   key; a balance that moves with no leg under the key aborts the door.
 * LAW 3 - THERE IS A CEILING, AND IT HOLDS FOR EVERY DOOR. ca_mint_policy
 *   (per-operation and rolling 24h caps) is refused with a readable reason in
 *   fn_ca_mint and refused again AT COMMIT by the constraint trigger on
 *   chip_ledger for any mint leg from any door. Raising it is a recorded
 *   change with a reason (fn_ca_mint_policy_set -> ca_mint_policy_changes).
 * LAW 4 - THE OVERVIEW RECONCILES. fn_ca_mint_overview carries the register
 *   against the supply meter as of the meter's snapshot, issuance since the
 *   baseline and in 24h, the policy with headroom, and a per-origin breakdown.
 * LAW 5 - A FREE MINT IS CLOSED. mint_club_chips (no journal, no register)
 *   and mint_club_promo are revoked from every client role and registered
 *   closed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) => /^\d{14}_the_mint_hardened\.sql$/.test(n));
if (!file) throw new Error('the mint hardening migration is missing');
const sql = readFileSync(resolve(MIG, file), 'utf8');

describe('LAW 1: the register is append-only, one row per leg', () => {
  it('refuses UPDATE and DELETE on ca_mint_ledger except linking a row to its leg', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER trg_ca_mint_register_append_only\s+BEFORE DELETE OR UPDATE ON public\.ca_mint_ledger/
    );
    expect(sql).toMatch(/OLD\.chip_ledger_id IS NULL AND NEW\.chip_ledger_id IS NOT NULL/);
    expect(sql).toMatch(/NEW\.amount IS NOT DISTINCT FROM OLD\.amount/);
    expect(sql).toMatch(/the mint register is append-only/);
    expect(sql).toMatch(/USING ERRCODE = 'P0403'/);
  });
  it('a bypass under the maintenance door is logged and raised, never silent', () => {
    expect(sql).toMatch(/INSERT INTO public\.ca_ledger_mutation_log/);
    expect(sql).toMatch(/'register-bypass:' \|\| TG_OP/);
  });
  it('one register row per journal leg is a unique index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ca_mint_ledger_chip_ledger_id_key\s+ON public\.ca_mint_ledger \(chip_ledger_id\) WHERE chip_ledger_id IS NOT NULL/
    );
    expect(sql).toMatch(/the register already links % leg\(s\) twice/);
  });
});

describe('LAW 2: the doors link their leg by key', () => {
  it('fn_ca_mint declares and finds its leg by mint:<op id>', () => {
    expect(sql).toMatch(
      /fn_ca_declare_ledger\('mint', 'issuance_reserve', NULL, NULL, 'mint:' \|\| p_op_id, NULL\)/
    );
    expect(sql).toMatch(
      /SELECT id INTO v_chip_id FROM public\.chip_ledger WHERE idempotency_key = 'mint:' \|\| p_op_id;/
    );
    expect(sql).toMatch(/refusing to register an issuance the journal does not carry/);
  });
  it('fn_ca_burn declares and finds its leg by burn:<op id>', () => {
    expect(sql).toMatch(
      /fn_ca_declare_ledger\('burn', 'chip_retirement', NULL, NULL, 'burn:' \|\| p_op_id, NULL\)/
    );
    expect(sql).toMatch(
      /SELECT id INTO v_chip_id FROM public\.chip_ledger WHERE idempotency_key = 'burn:' \|\| p_op_id;/
    );
    expect(sql).toMatch(/refusing to register a retirement the journal does not carry/);
  });
  it('neither door finds a leg by shape any more', () => {
    expect(sql).not.toMatch(/AND to_entity_id = p_target_id AND amount = p_amount/);
    expect(sql).not.toMatch(/AND from_entity_id = p_target_id AND amount = p_amount/);
  });
});

describe('LAW 3: the ceiling holds for every door', () => {
  it('the policy is a row with measured defaults', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_mint_policy/);
    expect(sql).toMatch(/VALUES \(1, 10000000, 25000000, 1000000, 2000000,/);
  });
  it('fn_ca_mint refuses over the caps with a reason the operator can read', () => {
    expect(sql).toMatch(
      /'reason', 'amount_over_the_single_mint_cap',\s+'cap', v_cap, 'requested', p_amount/
    );
    expect(sql).toMatch(/'reason', 'over_the_rolling_24h_issuance_ceiling'/);
    // No literal thousand-million cap survives.
    expect(sql).not.toMatch(/p_amount > 1000000000/);
  });
  it('the constraint trigger on chip_ledger refuses a mint leg over the ceiling at commit, whatever the door', () => {
    const trig = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()')
    );
    expect(trig).toMatch(/NEW\.amount > v_pol\.per_operation_cap_chips/);
    expect(trig).toMatch(
      /v_24h := public\.fn_ca_mint_issued_24h\('chips', NEW\.id\) \+ NEW\.amount;/
    );
    expect(trig).toMatch(/IF v_24h > v_pol\.rolling_24h_cap_chips THEN/);
    expect(trig).toMatch(/PERFORM public\.fn_ca_register_issuance_leg\(NEW\.id\);/);
  });
  it('raising the ceiling is a recorded change with a reason', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_mint_policy_changes/);
    expect(sql).toMatch(/'reason', 'a_policy_change_needs_a_real_reason'/);
    expect(sql).toMatch(
      /INSERT INTO public\.ca_mint_policy_changes \(changed_by, reason, before, after\)/
    );
  });
});

describe('LAW 4: the overview reconciles', () => {
  it('the register is compared to the meter as of the meter snapshot', () => {
    expect(sql).toMatch(/m\.created_at <= s\.taken_at/);
    expect(sql).toMatch(/round\(s\.total - ra\.net, 2\)/);
  });
  it('the overview carries reconciliation, issuance, policy and by_origin', () => {
    for (const k of [
      "'reconciliation'",
      "'register_net_at_meter'",
      "'unexplained_since_baseline'",
      "'balanced'",
      "'issuance'",
      "'issued_since_baseline'",
      "'policy'",
      "'headroom_24h_chips'",
      "'by_origin'",
    ]) {
      expect(sql).toContain(k);
    }
  });
  it('every register row says where it came from', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS origin text GENERATED ALWAYS AS \(/);
    for (const o of [
      "'journal'",
      "'baseline'",
      "'diamond-mint'",
      "'opening-grant'",
      "'restoration'",
      "'seed'",
      "'deletion'",
      "'operator'",
    ]) {
      expect(sql).toContain(o);
    }
  });
});

describe('LAW 5: the free mint is closed', () => {
  it('mint_club_chips and mint_club_promo are revoked from every client role and registered closed', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.mint_club_chips\(uuid, numeric, uuid, numeric, text\) FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.mint_club_promo\(uuid, numeric, text\) FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(sql).toMatch(/\('mint_club_chips', 'closed',/);
    expect(sql).toMatch(/\('mint_club_promo', 'closed',/);
    expect(sql).toMatch(/a closed door is still executable by a client role/);
  });
});
