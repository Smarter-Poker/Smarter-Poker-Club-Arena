/**
 * TWO CONSERVATION READS KEEP THEIR OWN LEDGER LEGS (2026-10-03).
 *
 * Pinned on migration 20261003051230. ca-conservation-sweep-hourly (job 233)
 * spent most of its run in two serial chip_ledger reads that fetched every
 * heap row in their window: fn_bbj_conservation_check's epoch identity (~61 s)
 * and fn_chip_drift_since_baseline (55.8 s). Each now has a partial index
 * whose predicate is exactly its own leg filter and which carries every column
 * it reads, so each is one index-only scan (4.5 s and 1.8 s). No function
 * body, schedule or grant changes, so each verdict is the same SQL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003051230_two_conservation_reads_keep_their_own_ledger_legs.sql'
  ),
  'utf8'
);

const INDEXES = {
  idx_chip_ledger_bbj_pool_legs:
    "CREATE INDEX idx_chip_ledger_bbj_pool_legs ON public.chip_ledger USING btree (created_at) INCLUDE (amount, to_type, from_type) WHERE ((to_type = ''bbj_pool''::text) OR (from_type = ''bbj_pool''::text))",
  idx_chip_ledger_player_wallet_legs:
    "CREATE INDEX idx_chip_ledger_player_wallet_legs ON public.chip_ledger USING btree (created_at) INCLUDE (club_id, to_type, from_type, to_entity_id, from_entity_id, amount) WHERE ((club_id IS NOT NULL) AND ((to_type = ''player_wallet''::text) OR (from_type = ''player_wallet''::text)))",
};

describe('two conservation reads keep their own ledger legs', () => {
  it('builds each index CONCURRENTLY before the one transaction', () => {
    const begin = sql.search(/^BEGIN;$/m);
    expect(begin).toBeGreaterThan(-1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    for (const ix of Object.keys(INDEXES)) {
      const at = sql.indexOf(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix}`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(begin);
    }
  });

  it('asserts the exact definitions the reads were measured against', () => {
    for (const def of Object.values(INDEXES)) {
      expect(sql).toContain(`'${def}'`);
    }
    expect(sql).toMatch(/i\.indisvalid AND i\.indisready AND i\.indislive/);
    expect(sql).toMatch(/^-- @live-proof: /m);
  });

  it('keys each predicate on exactly the leg filter its read already has', () => {
    expect(sql).toContain(
      "WHERE ((to_type = 'bbj_pool'::text) OR (from_type = 'bbj_pool'::text));"
    );
    expect(sql).toContain(
      "WHERE ((club_id IS NOT NULL) AND ((to_type = 'player_wallet'::text) OR (from_type = 'player_wallet'::text)));"
    );
  });

  it('changes no function body, schedule, grant or constraint', () => {
    const body = sql.slice(sql.search(/^BEGIN;$/m));
    expect(body).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(body).not.toMatch(/cron\.(alter_job|schedule|unschedule)\s*\(/);
    expect(body).not.toMatch(/^\s*(GRANT|REVOKE|ALTER\s+TABLE|DROP)\b/im);
  });
});
