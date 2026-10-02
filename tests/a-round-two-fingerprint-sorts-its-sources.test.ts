/**
 * A ROUND-TWO FINGERPRINT SORTS ITS SOURCES INSTEAD OF WALKING A TEMP INDEX
 *
 * The commission stage fingerprinted its routed sources with an ordered
 * aggregate the planner fed from the temp table's primary key: 623 s of random
 * temp-file reads in Midway's 2026-09-21 close. Ordering by source_type||''
 * keeps the same order and fingerprint and lets the planner sort.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SQL = readFileSync(
  resolve(__dirname, '..', 'supabase/migrations/20261001200328_a_round_two_fingerprint_sorts_its_sources_instead_of_walking.sql'),
  'utf8',
);

describe('the round-two source fingerprint', () => {
  it('is patched only from the exact live version, in one transaction', () => {
    expect(SQL).toContain("IF md5(d)<>'017cc76b047124788a3c83e931b17d77' THEN RAISE EXCEPTION");
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });

  it('orders by an expression no index supplies, with the same sort keys', () => {
    expect(SQL).toContain("string_agg(row_md5,'' ORDER BY source_type||'',source_id)");
    expect(SQL).toContain("string_agg(row_md5,'' ORDER BY source_type,source_id)");
  });
});
