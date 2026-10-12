/**
 * Dan, 2026-10-05, verbatim: "MYSTERY BOUNTY OF 10 OR FEWER DON'T GET CHESTS,
 * ITS TREATING LIKE A SINGLE TABLE TOURNAMENTS WITH 50 30 20 PAYOUT
 * PERCENTAGES".
 *
 * The ladder an MTT is paid by is written at entry close by
 * fn_finalize_tournament_entry_pool_locked (and provisionally at start by
 * fn_ca_fund_overlay_on_lock). Both now pay 50/30/20 for a mystery bounty of
 * 1..10 total entries (rows plus rebuys) with at least three players, and the
 * unchanged top-N% field ladder for everything else. The migration was executed
 * end to end against a disposable PostgreSQL 16 with stand-in callers; these
 * pins keep its shape.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = readdirSync(DIR).find((name) =>
  name.startsWith('20261006002326_a_mystery_bounty_of_ten_or_fewer_entries')
);
if (!FILE) throw new Error('small-field mystery bounty migration missing');
const SQL = readFileSync(join(DIR, FILE), 'utf8');

const LADDER =
  '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]';
const COUNT = '(SELECT (count(*)+COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0))::integer';
const replacements = SQL.slice(SQL.indexOf('ARRAY[$n$'));

describe('a mystery bounty of 10 or fewer entries pays 50/30/20', () => {
  it('the ladder is 50/30/20 and sums to exactly 100', () => {
    const ladder = JSON.parse(LADDER) as Array<{ place: number; percentage: number }>;
    expect(ladder.map((p) => p.percentage)).toEqual([50, 30, 20]);
    expect(ladder.reduce((sum, p) => sum + p.percentage, 0)).toBe(100);
    // Entry close (jsonb) and the start trigger (text) write the same ladder.
    expect(replacements).toContain(`THEN '${LADDER}'::jsonb\n`);
    expect(replacements).toContain(`THEN '${LADDER}'::jsonb::text\n`);
    expect(replacements).toContain('THEN 3\n');
  });

  it('applies only to a mystery bounty of 1..10 entries with at least 3 players', () => {
    expect(replacements).toContain('WHEN COALESCE(v_t.is_mystery_bounty,false) AND v_field>=3');
    expect(
      replacements.split('WHEN COALESCE(NEW.is_mystery_bounty,false) AND v_entrants >= 3').length -
        1
    ).toBe(2);
    expect(replacements.split(') BETWEEN 1 AND 10').length - 1).toBe(3);
    // Everything else, 11+ entries and every non-mystery event, is the
    // existing generator called exactly as before.
    expect(replacements).toContain(
      'ELSE public.fn_ca_payout_structure(\n      v_field,COALESCE(v_t.payout_percent,10)) END;'
    );
    expect(replacements).toContain(
      'ELSE public.fn_ca_payout_structure(\n                                  v_entrants, COALESCE(NEW.payout_percent,10))::text END;'
    );
  });

  it('counts entries the way the engine does: rows plus every rebuy and re-entry', () => {
    expect(replacements.split(COUNT).length - 1).toBe(3);
  });

  it('rewrites both callers by pinned exact substitution, nothing else', () => {
    expect(SQL).toContain(
      "'public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)',\n  'd8aa6508707a5da0b3b61cc85b644e2f', '4b536704f1210d9a94efb1a8c7be4467'"
    );
    expect(SQL).toContain(
      "'public.fn_ca_fund_overlay_on_lock()',\n  '52773a5c7b5011bb82e0518f50b461b5', '3f55869778cc3c02ca1406fa22c908d4'"
    );
    expect(SQL).toContain("RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1'");
    expect(SQL).toContain("RAISE EXCEPTION '%: owner, security, settings or grants moved'");
  });

  it('is one transaction with a live proof', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/^-- @live-proof: \(SELECT md5\(/m);
    expect(SQL).not.toContain('cron.schedule(');
    // No new object: the gate that refuses unapplied objects has nothing new
    // to look for, and the two changed functions are pinned by md5 above.
    expect(SQL).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\./);
  });
});
