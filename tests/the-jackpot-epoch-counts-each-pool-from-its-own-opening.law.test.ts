/**
 * THE JACKPOT EPOCH COUNTS EACH POOL FROM ITS OWN OPENING (2026-10-02,
 * incident f3e82f59).
 *
 * fn_bbj_open_pool_baseline opens a pool created after the 2026-09-04 epoch at
 * taken_at = GREATEST(created_at, epoch), and its opening balance holds every
 * leg up to that instant - including the 100.00 welcome seed leg, which is
 * written in the same transaction as the pool and so carries the pool's own
 * created_at. fn_bbj_conservation_check summed those baselines AND the journal
 * since the single global epoch, so 46 welcome seeds were counted twice and
 * the check reported a -4,609.82 shortfall (-4,400.00 at the incident's 12:52
 * reading) that was no chip and no unpaid jackpot.
 *
 * The law: a pool opened after the epoch is measured from its own opening
 * (the legs its baseline absorbed are added back), and its journalled seeds
 * and burns are inside the lifetime identity. An ORIGINAL pool is still
 * measured from the epoch, so a seed or burn on one of those stays loud.
 * The migration asserts the absorbed figure equals exactly the seed legs at
 * the later pools' openings, and that both verdicts close at the residues
 * already recorded (-9.82 epoch, 45.80 lifetime) - nothing is rebaselined.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const name = readdirSync(MIG).find((n) =>
  /^\d{14}_the_jackpot_epoch_counts_each_pool_from_its_own_opening\.sql$/.test(n)
);
const sql = name ? readFileSync(resolve(MIG, name), 'utf8') : '';

describe('the jackpot epoch counts each pool from its own opening', () => {
  it('the migration exists and runs as one transaction', () => {
    expect(name, 'migration file').toBeTruthy();
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
  });

  it('it edits only the reviewed pre-image of fn_bbj_conservation_check', () => {
    expect(sql).toMatch(/IF v_md5 IS DISTINCT FROM 'cd515fb20589a20ba6b930a6831610b8' THEN/);
    expect(sql).toMatch(/AND md5\(pg_get_functiondef\(p\.oid\)\) <> v_md5\) THEN/);
    expect(sql).toMatch(/p\.prosecdef = v_secdef/);
    expect(sql).not.toMatch(/DROP\s+(TRIGGER|POLICY|FUNCTION|TABLE)/i);
  });

  it('a pool opened after the epoch is windowed from its own baseline, the same instant the meter used', () => {
    expect(sql).toMatch(/HAVING min\(s\.taken_at\) > v_epoch_at\) o/);
    expect(sql).toMatch(/CASE WHEN l\.created_at <= o\.opened_at/);
    expect(sql).toMatch(/v_epoch_unexp := round\(v_epoch_unexp \+ v_absorbed, 2\);/);
  });

  it("a later pool's journalled seeds and burns are inside the lifetime identity", () => {
    expect(sql).toMatch(/l\.category = 'club_opening_allocation'/);
    expect(sql).toMatch(/l\.category = 'burn'/);
    expect(sql).toMatch(/v_in := v_in \+ v_late_seeds;/);
    expect(sql).toMatch(/v_out := v_out \+ v_late_burns;/);
    // and they are inserted IN FRONT OF the balances read, i.e. before the
    // lifetime gap is computed from v_in/v_out
    expect(sql).toMatch(
      /v_new := replace\(v_new, v_anchor, \$a\$ {2}\/\* A POOL OPENED AFTER THE EPOCH[\s\S]*v_out := v_out \+ v_late_burns;\n\n\$a\$ \|\| v_anchor\);/
    );
  });

  it('a pool the meter has not opened yet is inside the lifetime identity from its creation', () => {
    const f = readdirSync(MIG).find((n) =>
      /^\d{14}_the_jackpot_lifetime_counts_an_unopened_pool\.sql$/.test(n)
    );
    expect(f, 'follow-up migration').toBeTruthy();
    const s = readFileSync(resolve(MIG, f!), 'utf8');
    expect(s).toMatch(/IF v_md5 IS DISTINCT FROM 'b1fb89dc98aaad152bd5b2085b88bbfa' THEN/);
    expect(s).toMatch(/WHERE COALESCE\(b\.opened_at, p\.created_at\) > v_epoch_at\) o/);
    // only a pool WITH a baseline gives legs back to the epoch residue
    expect(s).toMatch(/CASE WHEN o\.opened_at IS NOT NULL AND l\.created_at <= o\.opened_at/);
    expect(s).toMatch(/lifetime_healthy'\)::boolean, false\) IS NOT TRUE/);
    expect(s).not.toMatch(
      /SET\s+(epoch_residue|lifetime_residue|baseline_gap|opening_seeds|pre_ledger_payouts)\s*=/
    );
  });

  it("a later pool's journalled legs are the complement of what is already counted", () => {
    // 2026-10-03. The first version of the follow-up named ONE category each
    // way, and refused by its own assertion at 200.00 - post-EXECUTE, so its
    // own new body did not reconcile. Across every post-epoch pool the journal
    // carries club_opening_allocation in and, out, either 'burn' (86 legs) or
    // 'treasury_transfer' (2 legs): a certification seed returned to the club
    // treasury instead of burned in place, each conserved and each followed by
    // the treasury being burned whole. Naming only 'burn' read those two
    // 100.00 seeds as inflow against no outflow. So the journalled legs are
    // now the COMPLEMENT of what the rest of the identity already holds -
    // v_in has 'bbj_contribution', v_out has 'bbj_payout' and 'promo' - which
    // a new retirement category cannot fall outside (CLAUDE.md 10.86 rule 4).
    const f = readdirSync(MIG).find((n) =>
      /^\d{14}_the_jackpot_lifetime_counts_an_unopened_pool\.sql$/.test(n)
    );
    expect(f, 'follow-up migration').toBeTruthy();
    const s = readFileSync(resolve(MIG, f!), 'utf8');
    // the enumerated filters are the ANCHORS, so they appear in the file; what
    // matters is that each is REPLACED by the complement.
    expect(s).toMatch(
      /v_new := replace\(v_new, v_anchor, \$a\$\s+AND l\.category NOT IN \('bbj_payout', 'promo'\)\), 0\) AS burned\$a\$\);/
    );
    expect(s).toMatch(
      /v_new := replace\(v_new, v_anchor, \$a\$\s+AND l\.category <> 'bbj_contribution'\), 0\) AS seeded,\$a\$\);/
    );
    // and each anchor's absence is a refusal, not a silent no-op
    expect(s).toMatch(/anchor C \(journalled inflow\) not found/);
    expect(s).toMatch(/anchor D \(journalled outflow\) not found/);
    // the journalled legs must net to zero, and NO tolerance is widened to
    // make that true: a stranded seed is refused, not absorbed.
    expect(s).toMatch(/a later pool holds seed the journal does not account for/);
    expect(s).toMatch(/abs\(\(v_res->'epoch'->>'moved_since_recorded'\)::numeric\) > 0\.01/);
    expect(s).toMatch(/abs\(\(v_res->'lifetime'->>'moved_since_resolution'\)::numeric\) > 1\.00/);
    expect(s).not.toMatch(/UPDATE public\.bbj_conservation_baseline\s+SET tolerance/);
  });

  it('the numbers are asserted at apply time, and nothing is rebaselined or moved', () => {
    expect(sql).toMatch(
      /AND l\.category = 'club_opening_allocation' AND l\.created_at = o\.opened_at;/
    );
    expect(sql).toMatch(/IF v_absorbed IS DISTINCT FROM round\(v_seed_at_open, 2\) THEN/);
    expect(sql).toMatch(/abs\(\(v_res->'epoch'->>'moved_since_recorded'\)::numeric\) > 0\.01/);
    expect(sql).toMatch(/abs\(\(v_res->'lifetime'->>'moved_since_resolution'\)::numeric\) > 1\.00/);
    expect(sql).not.toMatch(
      /SET\s+(epoch_residue|lifetime_residue|baseline_gap|opening_seeds|pre_ledger_payouts)\s*=/
    );
    expect(sql).not.toMatch(
      /INSERT INTO public\.chip_ledger|UPDATE public\.bbj_pools|fn_credit_and_log/
    );
  });
});
