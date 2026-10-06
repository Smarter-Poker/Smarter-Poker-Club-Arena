/**
 * A HOUSE MINT CARRIES ITS REASON (2026-10-02, launch money sweep).
 *
 * Pinned on migration 20261002134346. The house funds a club only through
 * fn_ca_fund_club, which now writes its own mint-register row with its reason
 * and clears its declaration. At commit, fn_ca_issuance_leg_is_registered
 * refuses a leg that issues chips into circulation without an operation key,
 * and a system_mint / system_burn leg that no door registered: a raw UPDATE
 * under a hand-set system_mint declaration no longer commits. The BBJ payout
 * self-test counts shares the payer returns to the pool, so a conserved
 * payout reads green and a pool that grows still reads red. The twelve pools
 * stranded by six deleted certification clubs are retired through the journal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(
  HERE,
  '../supabase/migrations/20261002134346_a_house_mint_carries_its_reason_and_stranded_certification_p.sql'
);
const sql = readFileSync(FILE, 'utf8');
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('a house mint carries its reason', () => {
  it('is one transaction with a preimage on every body it replaces', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    for (const f of [
      'fn_ca_fund_club',
      'fn_ca_issuance_leg_is_registered',
      'fn_bbj_selftest_payout_conservation',
    ]) {
      expect(sql).toMatch(new RegExp(`\\('${f}',\\s+'[0-9a-f]{32}'\\)`));
    }
    expect(sql).not.toMatch(/^\s*DROP\b/im);
  });

  it('fn_ca_fund_club writes its reason into the register, linked to its leg, and clears its declaration', () => {
    const f = body('fn_ca_fund_club');
    expect(f).toMatch(/fn_ca_declare_ledger\('mint', 'system_mint', NULL, NULL, v_key\)/);
    expect(f).toMatch(
      /SELECT id INTO v_leg FROM public\.chip_ledger WHERE idempotency_key = v_key;/
    );
    expect(f).toMatch(/INSERT INTO public\.ca_mint_ledger/);
    expect(f).toMatch(/v_before, v_after, v_supply, left\(v_reason, 2000\),/);
    expect(f).toMatch(/'fn_ca_fund_club', v_leg\)/);
    expect(f).toMatch(/set_config\('app\.ledger_counterparty', '', true\)/);
    expect(f).toMatch(/refusing to mint what the journal does not carry/);
  });

  it('the commit-time check refuses keyless issuance and a house mint no door registered', () => {
    const f = body('fn_ca_issuance_leg_is_registered');
    // the existing ceilings stay
    expect(f).toMatch(/NEW\.amount > v_pol\.per_operation_cap_chips/);
    expect(f).toMatch(/IF v_24h > v_pol\.rolling_24h_cap_chips THEN/);
    expect(f).toMatch(/PERFORM public\.fn_ca_register_issuance_leg\(NEW\.id\);/);
    // the new refusals
    expect(f).toMatch(/NEW\.idempotency_key IS NULL OR btrim\(NEW\.idempotency_key\) = ''/);
    expect(f).toMatch(/REFUSED: issuance_without_an_operation_key/);
    expect(f).toMatch(/m\.chip_ledger_id = NEW\.id AND m\.op_id NOT LIKE 'ledger:%'/);
    expect(f).toMatch(/REFUSED: house_issuance_without_its_door/);
    expect(f).toMatch(/NEW\.category <> 'correction'/);
  });

  it('the BBJ self-test nets returned shares and still asserts conservation on both hits', () => {
    const f = body('fn_bbj_selftest_payout_conservation');
    expect(f).toMatch(
      /category = 'bbj_payout'\s+AND to_type = 'bbj_pool' AND to_entity_id = v_pool AND from_type <> 'bbj_pool'/
    );
    expect(f).toMatch(/RESERVE FUNDED A PAYOUT/);
    expect(f).toMatch(/NOT CONSERVED on full hit/);
    expect(f).toMatch(/NOT CONSERVED on partial hit/);
    expect(f).toMatch(/RESERVE MOVED ON A PARTIAL HIT/);
    expect(f).toMatch(/5800 - \(paid_full - back_full\)/);
    expect(f).toMatch(/6000 - \(paid_part - back_part\)/);
  });

  it('retires exactly the twelve stranded pools through the journal and proves the refusal before commit', () => {
    expect(sql).toMatch(/'cert-orphan-pool-retired:' \|\| r\.id::text/);
    expect(sql).toMatch(/fn_ca_declare_ledger\('burn', 'chip_retirement', NULL, NULL,/);
    expect(sql).toMatch(/IF v_n <> 12 OR v_total <> 1800\.00 OR v_legs <> 1800\.00 THEN/);
    expect(sql).toMatch(/IF v_door <> 'ok' OR v_hand <> 'refused' OR v_test <> 'ok' THEN/);
  });
});
