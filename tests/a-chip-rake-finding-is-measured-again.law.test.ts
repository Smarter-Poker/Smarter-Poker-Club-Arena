/**
 * A CHIP RAKE FINDING IS MEASURED AGAIN (2026-10-16).
 *
 * The Lightning pilot's 2026-10-15 rake-law storm kept 52 drift incidents open
 * past their deadline after its cause was fixed, for two reasons:
 *
 * LAW 1 - THE RAKE LAW PRICES A HAND WITH EVERY PLAYER DEALT IN.
 *   fn_rake_law_violations reads GREATEST(rake_records.num_players,
 *   jsonb_array_length(hand_history.players)): num_players can undercount a
 *   hand (148 settled Lightning rows) and never overcounts it.
 * LAW 2 - A CHIP rake_law ENTITY CAN BE RE-MEASURED. fn_ca_remeasure_entity
 *   measures a chip cash table over the escalator's 36-hour lookback with the
 *   same pricing functions, so a fixed condition is superseded at the next
 *   tick instead of re-filed for 36 hours as "could not tell". A flopped hand
 *   with no dealt count is a finding, never ok.
 * LAW 3 - NOTHING IS CLOSED ON SILENCE. The migration closes the storm only
 *   after the new re-measure says ok for each table, inside the same
 *   transaction, and moves no chips.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_a_chip_rake_finding_is_measured_again\.sql$/.test(n)
);
if (!file) throw new Error('the migration is not in the tree');
const sql = readFileSync(resolve(MIG, file), 'utf8');

describe('a chip rake finding is measured again', () => {
  it('LAW 1: the rake law prices with the larger of num_players and the dealt list', () => {
    expect(sql).toContain("'public.fn_rake_law_violations(interval)'");
    expect(sql).toContain(
      "ARRAY[$o$COALESCE(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,$o$]"
    );
    expect(sql).toMatch(
      /GREATEST\(rr\.num_players, jsonb_array_length\(CASE WHEN jsonb_typeof\(hh\.players\) = 'array' THEN hh\.players END\)\) AS dealt,\$n\$\]/
    );
  });

  it('LAW 2: fn_ca_remeasure_entity measures a chip cash rake_law table before it gives up', () => {
    expect(sql).toContain("'public.fn_ca_remeasure_entity(text,uuid)'");
    const at = sql.indexOf('A CHIP RAKE FINDING IS MEASURED AGAIN (2026-10-16). On a chip cash table');
    expect(at).toBeGreaterThan(-1);
    const branch = sql.slice(at, sql.indexOf('$n$]', at));
    expect(branch).toMatch(/COALESCE\(c\.asset = 'diamonds', false\) = false/);
    expect(branch).toMatch(/t\.tournament_id IS NULL/);
    expect(branch).toMatch(/hh\.created_at > now\(\) - interval '36 hours'/);
    expect(branch).toMatch(/public\.fn_effective_rake\(/);
    expect(branch).toMatch(/public\.fn_effective_bbj_drop\(/);
    expect(branch).toMatch(/bool_or\(fb\.dealt IS NULL/);
    // the "could not tell" fallback still follows the new branch
    expect(branch).toMatch(/RETURN;\s+END IF;\s+ {2}RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;\s*$/);
  });

  it('LAW 3: the storm is closed only on a fresh ok, with evidence, and no chips move', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'rake_law % re-measures as % \(measurable %\), not ok: refusing to close'/);
    expect(sql).toMatch(/closure_basis = 'verified_remeasured'/);
    expect(sql).not.toMatch(/fn_credit_and_log|chip_ledger\s*\(|INSERT INTO public\.chip_/);
    expect(sql).toMatch(/@live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_rake_law_violations\(interval\)'/);
    expect(sql).toMatch(/@live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_ca_remeasure_entity\(text,uuid\)'/);
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
  });
});
