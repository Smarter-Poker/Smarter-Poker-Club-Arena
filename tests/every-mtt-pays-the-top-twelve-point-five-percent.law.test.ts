/**
 * Dan, 2026-10-21, verbatim: "STARTING TOMORROW ALL MTT TOURNAMENTS MUST PAY OUT
 * THE TOP 12.5% OF THE FIELD. ANYTHING LESS IS WRONG. CORRECT THIS AND MAKE SURE
 * ALL FUTURE TOURNAMENTS HAVE THIS IMPLEMENTED. (STAND ALONE CLUBS CAN SET IT TO
 * WHAT EVER THEY WANT, BUT THE DEFAULT SHOULD BE 12.5%)"
 *
 * The database is the authority: tournaments.payout_depth_percent, written by
 * trigger ca_mtt_payout_depth_guard on every insert, and read by both ladder
 * builders (entry close and start lock). These pins keep that shape, and keep
 * every creator surface defaulting to 12.5.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MTT_DEFAULT_PAYOUT_DEPTH,
  MTT_PAYOUT_DEPTH_CHOICES,
  mttPayoutDepthColumn,
  legacyPayoutPercentColumn,
} from '../server/src/tournament/mttPayoutDepth';

const DIR = join(process.cwd(), 'supabase/migrations');
const read = (prefix: string) => {
  const file = readdirSync(DIR).find((name) => name.startsWith(prefix));
  if (!file) throw new Error(`${prefix} migration missing`);
  return readFileSync(join(DIR, file), 'utf8');
};
const DDL = read('20261022014607_every_mtt_pays_the_top_twelve_point_five_percent');
const BACKFILL = read('20261022014651_live_mtts_move_to_the_twelve_point_five_percent_depth');

describe('every MTT pays the top 12.5 percent of the field', () => {
  it('union, Midway and Diamond Arena MTTs are forced to 12.5', () => {
    expect(DDL).toContain('CREATE TRIGGER ca_mtt_payout_depth_guard');
    expect(DDL).toContain('BEFORE INSERT OR UPDATE OF payout_depth_percent, payout_percent');
    expect(DDL).toMatch(/IF v_enforced THEN\s+v_depth := 12\.5;/);
    for (const scope of [
      'NEW.union_id IS NOT NULL',
      'v_club_union IS NOT NULL',
      "v_asset = 'diamonds'",
      "'fade0000-0000-0000-0000-000000000001'::uuid",
    ]) {
      expect(DDL).toContain(scope);
    }
  });

  it('standalone clubs choose, with 12.5 as the default', () => {
    expect(DDL).toMatch(/CASE WHEN NEW\.payout_percent IN \(15, 20\)[\s\S]*?12\.5\);/);
  });

  it('only MTTs: satellites, Spins and Sit & Gos keep their own terms', () => {
    expect(DDL).toContain("NOT IN ('spin','sng','satellite')");
    expect(DDL).toMatch(/IF NOT v_is_mtt THEN\s+NEW\.payout_depth_percent := NULL;/);
  });

  it('both ladder builders read the depth, and committed terms never move', () => {
    expect(DDL).toContain(
      'public.fn_ca_effective_payout_depth(v_t.payout_depth_percent,v_t.payout_percent)'
    );
    expect(DDL).toContain(
      'public.fn_ca_effective_payout_depth(NEW.payout_depth_percent,NEW.payout_percent)'
    );
    expect(DDL).toMatch(/COALESCE\(OLD\.prize_pool_finalized, false\) THEN\s+NEW\.payout_depth_percent := OLD\.payout_depth_percent;/);
    expect(BACKFILL).toContain('NOT public.fn_tournament_payout_terms_committed_v1(t.id)');
  });

  it('paid places round up: ceil(field * depth / 100), never more than the field', () => {
    expect(DDL).toContain(
      'v_places := GREATEST(1, LEAST(p_entrants, ceil(p_entrants * v_pct / 100.0)::int));'
    );
    const places = (field: number) => Math.max(1, Math.min(field, Math.ceil((field * 12.5) / 100)));
    expect([8, 9, 16, 17, 100, 137].map(places)).toEqual([1, 2, 2, 3, 13, 18]);
  });

  it('every creator surface defaults to 12.5 and keeps the legacy column valid', () => {
    expect(MTT_DEFAULT_PAYOUT_DEPTH).toBe(12.5);
    expect(MTT_PAYOUT_DEPTH_CHOICES[0]).toMatchObject({ value: 'payout2', percent: 12.5 });
    expect(mttPayoutDepthColumn(undefined)).toBe(12.5);
    expect(mttPayoutDepthColumn('15')).toBe(15);
    expect(legacyPayoutPercentColumn(12.5)).toBe(10);
  });

  it('is one transaction each, with live proofs', () => {
    for (const sql of [DDL, BACKFILL]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(sql).toMatch(/^-- @live-proof: \(SELECT /m);
    }
  });
});
