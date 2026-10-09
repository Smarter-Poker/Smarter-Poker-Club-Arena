/**
 * LAW: THE CHIP MONITORS READ CHIPS (2026-10-09).
 *
 * Three chip monitors misread Diamond Arena or house activity: the nightly
 * ledger replay counted Diamond seats in the chip felt (and tripped the kill
 * switch three nights running), the reconcile escalator could not re-measure a
 * Diamond rake finding and re-filed it hourly, and the integrity sweep read a
 * house horse as an agent's winning player.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const FELT = read('supabase/migrations/20261009164317_the_chip_felt_counts_no_diamond_seat.sql');
const RAKE = read(
  'supabase/migrations/20261009180352_a_diamond_rake_finding_is_measured_again.sql'
);
const ROSTER = read('supabase/migrations/20261009180401_an_agent_roster_counts_no_horse.sql');

const isDiamond = "WHERE cl.id = t.club_id AND cl.asset = 'diamonds'";

describe('the chip monitors read chips', () => {
  for (const [name, sql] of [
    ['felt', FELT],
    ['rake finding', RAKE],
    ['roster', ROSTER],
  ] as const) {
    it(`${name}: one transaction, a live proof, a pinned preimage and a proof block`, () => {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
      expect(sql).toMatch(/^-- @live-proof: /m);
      expect(sql).toMatch(/_PREIMAGE_CHANGED/);
      expect(sql).toMatch(/DO \$prove\$/);
      expect(sql).toMatch(/v_n <> 1 THEN\s*RAISE EXCEPTION '[A-Z_]+_ANCHOR_CHANGED/);
      expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
        /\b(?:DROP|cron\.(?:schedule|alter_job|unschedule)|GRANT|REVOKE)\b/i
      );
    });
  }

  it('the felt reader counts no Diamond seat, exactly as the supply meter does', () => {
    // The reader, the new reading and the proof all use the same test.
    expect(FELT.split(isDiamond).length - 1).toBe(3);
    expect(FELT).toContain(
      "public.fn_ca_account_balance('table_stack', '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack')"
    );
    expect(FELT).toContain('IF v_fn IS DISTINCT FROM v_meter THEN');
  });

  it('the felt gets one new reading, taken with the snapshot it read under, on the same basis', () => {
    expect(FELT).toMatch(
      /INSERT INTO public\.ca_account_snapshots[\s\S]*?clock_timestamp\(\), true, NULL, 0, 'one-snapshot-v4',[\s\S]*?pg_current_snapshot\(\)::text;/
    );
    expect(FELT.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it('a Diamond rake finding is measured by its receipts; a chip one is still unmeasurable', () => {
    expect(RAKE).toContain("IF p_entity_type = 'rake_law' AND p_entity_id IS NOT NULL");
    expect(RAKE).toContain("c.asset = 'diamonds'");
    expect(RAKE).toContain("(SELECT (r.receipt->>'rake')::numeric");
    expect(RAKE).toContain("THEN 'critical' ELSE 'ok' END");
    expect(RAKE).toContain(
      "RAISE EXCEPTION 'DIAMOND_REMEASURE_RESULT_CHANGED: a chip rake_law entity was measured'"
    );
  });

  it('an agent roster counts no horse', () => {
    expect(ROSTER).toMatch(
      /AND NOT EXISTS \(SELECT 1 FROM public\.profiles hp\s+WHERE hp\.id = m\.user_id AND COALESCE\(hp\.is_horse, false\)\)/
    );
  });
});
