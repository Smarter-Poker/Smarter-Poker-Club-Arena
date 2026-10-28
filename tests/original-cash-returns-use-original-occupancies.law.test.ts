import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Original cash return witnesses choose the same original occupancy', () => {
  it('preserves every original return predicate and bounds only its candidate receipts', () => {
    const sql = readFileSync(
      'supabase/migrations/20261027184348_original_cash_returns_use_their_original_occupancy_keys.sql',
      'utf8'
    );
    const rows = JSON.parse(
      readFileSync('scripts/ci/fixtures/original-flow-occupancy/original-authorities.json', 'utf8')
    ) as { signature: string; definition: string; md5: string }[];
    for (const row of rows.slice(0, 2)) {
      const start = row.definition.indexOf('   WHERE r.table_id=');
      const end = row.definition.indexOf('  ) ret ON true', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      expect(sql).toContain(row.definition.slice(start, end));
      expect(sql).toContain(row.md5);
    }
    expect(
      sql.match(
        /JOIN public\.cash_participant_funding_receipts r ON r\.occupancy_id=original_occupancies\.occupancy_id/g
      )
    ).toHaveLength(2);
    expect(sql.match(/UNION\n {4}SELECT original\.occupancy_id/g)).toHaveLength(2);
    expect(sql).toContain("to_jsonb(p)-'prosrc'");
    expect(sql).toContain('after_meta IS DISTINCT FROM before_meta');
    expect(sql).not.toMatch(
      /CREATE\s+(?:UNIQUE\s+)?INDEX|UPDATE\s+public\.(?:clubs|club_members|agents)|INSERT\s+INTO\s+public\.chip_ledger/i
    );
    expect(
      readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8')
    ).toContain(
      '--original-occupancy-flow-migration supabase/migrations/20261027184348_original_cash_returns_use_their_original_occupancy_keys.sql'
    );
  });
});
