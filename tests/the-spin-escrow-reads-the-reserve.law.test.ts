/**
 * THE SPIN ESCROW READS THE RESERVE (chip standard Phase 5.2, 2026-09-05).
 * Pinned on the migration mirrored byte-exact from production.
 *
 * Why: under the Phase 5.1 meter, four hourly supply snapshots read -614.93,
 * -75.45, -85.37 and -156.92 unexplained. Decomposed per account class against
 * the journal, only tournament_liability disagreed, and per event only SPINS
 * did: the meter read a spin from its counters (the multiplier prize from
 * creation to completion) while the journal moves a spin's money in five
 * legs through spin_reserve. The two agree at no instant.
 *
 * LAW 1 - THE ESCROW KNOWS THE RESERVE. tournament_escrow carries reserve_out
 *   (spin_entry legs, prize_liability -> spin_reserve when the pool fills) and
 *   reserve_in (spin_prize legs, the draw), and the prize bank is
 *   (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in
 *   - reserve_out + reserve_in - prize_out - refund_prize.
 * LAW 2 - THE LEGS FEED IT IN THE SAME TRANSACTION, through one trigger on
 *   chip_ledger and the one door (fn_ca_escrow_apply), and a spin opened at
 *   first sight reads its reserve legs too, the firing leg included.
 * LAW 3 - THE METER READS THE ESCROW FOR EVERY EVENT WITH A ROW, and the
 *   counters only for an event with no row yet. The step it took when it
 *   stopped believing the spin counters is a labelled register correction,
 *   mint or burn by sign, bounded; every closed spin is asserted at zero.
 * LAW 4 - THE SHADOW COMPARISON LEARNS THE RESERVE TERMS, so a spin is not a
 *   permanent disagreement.
 * LAW 5 - SPINS STAY TRACKED, NOT REFUSED (enforced = false) until a soak of
 *   measured non-negative live banks; the exactness is what makes the flip
 *   possible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_phase_5_2_the_spin_escrow_reads_the_reserve\.sql$/.test(n)
);
if (!file) throw new Error('the Phase 5.2 migration is not mirrored');
const sql = readFileSync(resolve(MIG, file), 'utf8');

const body = (name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the spin escrow reads the reserve', () => {
  it('LAW 1: reserve_out and reserve_in are components and the prize bank subtracts and adds them', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reserve_out numeric NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reserve_in\s+numeric NOT NULL DEFAULT 0/);
    const apply = body('fn_ca_escrow_apply');
    expect(apply).toMatch(
      /SET prize_balance\s+= round\(\(gross_in - fee_entries_in - bounty_in\) \+ overlay_in \+ satellite_in - reserve_out \+ reserve_in - prize_out - refund_prize, 2\)/
    );
    expect(apply).toMatch(
      /reserve_out = reserve_out \+ COALESCE\(p_reserve_out, 0\), reserve_in = reserve_in \+ COALESCE\(p_reserve_in, 0\)/
    );
    // a reserve_out is an outflow: it is judged where enforced
    expect(apply).toMatch(/OR COALESCE\(p_reserve_out, 0\) > 0;/);
  });

  it('LAW 2: one trigger on the spin legs, through the one door, and first sight reads the legs', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER zz_ca_escrow_reserve_leg AFTER INSERT ON public\.chip_ledger\s+FOR EACH ROW WHEN \(NEW\.category IN \('spin_entry', 'spin_prize'\)\)\s+EXECUTE FUNCTION public\.fn_ca_escrow_on_reserve_leg\(\)/
    );
    const trg = body('fn_ca_escrow_on_reserve_leg');
    expect(trg).toMatch(
      /IF NEW\.category = 'spin_entry' THEN\s+PERFORM public\.fn_ca_escrow_apply\(NEW\.from_entity_id, 'spin pool to reserve', p_reserve_out => round\(NEW\.amount, 2\)\)/
    );
    expect(trg).toMatch(
      /ELSIF NEW\.category = 'spin_prize' THEN\s+PERFORM public\.fn_ca_escrow_apply\(NEW\.to_entity_id, 'spin prize from reserve', p_reserve_in => round\(NEW\.amount, 2\)\)/
    );
    const apply = body('fn_ca_escrow_apply');
    expect(apply).toMatch(
      /FILTER \(WHERE l\.category = 'spin_entry' AND l\.from_entity_id = p_tournament_id\)/
    );
    expect(apply).toMatch(
      /FILTER \(WHERE l\.category = 'spin_prize' AND l\.to_entity_id = p_tournament_id\)/
    );
    expect(apply).toMatch(
      /round\(e\.prize_balance - r_out \+ r_in, 2\), e\.bounty_balance, e\.fee_balance/
    );
    expect(sql).toMatch(/\('chip_ledger', 'zz_ca_escrow_reserve_leg'/);
    // the trigger on the hot table is the last statement before COMMIT
    expect(sql.indexOf('CREATE TRIGGER zz_ca_escrow_reserve_leg')).toBeGreaterThan(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot')
    );
  });

  it('LAW 3: the meter reads the escrow for every event with a row; the step is a bounded, sign-aware register correction; closed spins are asserted at zero', () => {
    const snap = body('fn_ca_supply_snapshot');
    expect(snap).toMatch(
      /COALESCE\(sum\(COALESCE\(e\.prize_balance \+ e\.bounty_balance \+ e\.fee_balance,\s+COALESCE\(t\.prize_pool,0\) \+ COALESCE\(t\.bounty_pool,0\)/
    );
    expect(snap).not.toMatch(/CASE WHEN e\.enforced THEN e\.prize_balance/);
    expect(sql).toMatch(/IF abs\(v_delta\) > 1500 THEN/);
    expect(sql).toMatch(/CASE WHEN v_delta >= 0 THEN 'burn' ELSE 'mint' END/);
    expect(sql).toMatch(
      /'register-opening-baseline-correction:supply-meter-redefinition:2026-09-05-spins'/
    );
    expect(sql).toMatch(/RAISE EXCEPTION '% closed spins do not read zero with the reserve terms'/);
    expect(sql).toMatch(
      /RAISE EXCEPTION '% spin prize banks read negative with the reserve terms'/
    );
  });

  it('LAW 4: the shadow comparison adds the reserve terms', () => {
    const drift = body('fn_ca_escrow_balance_drift');
    expect(drift).toMatch(
      /abs\(r\.prize_balance - \(e\.prize_balance - r\.reserve_out \+ r\.reserve_in\)\) > 0\.01/
    );
  });

  it('LAW 5: spins stay tracked, not refused, and the refusal still reads enforced', () => {
    const apply = body('fn_ca_escrow_apply');
    expect(apply).toMatch(/\(p_tournament_id, NOT v_spin,/);
    expect(apply).toMatch(/IF v\.enforced AND v_outflow/);
  });

  it('is one transaction, restates every definer ACL, and drops the 12-argument door before creating the 14-argument one', () => {
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
    expect(sql).toMatch(
      /DROP FUNCTION public\.fn_ca_escrow_apply\(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric\);/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_escrow_apply\(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric\) TO service_role;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_escrow_on_reserve_leg\(\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_supply_snapshot\(\) TO service_role;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_escrow_balance_drift\(integer\) TO service_role;/
    );
  });
});
