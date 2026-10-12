/**
 * THE INVENTORY SEAL HASHES ITS ROWS BUCKET BY BUCKET (2026-10-12).
 *
 * Pinned on migration 20261012113248_the_inventory_seal_hashes_rows_by_bucket.sql.
 * rows_md5 was md5(string_agg(<every row>)): one text value, and the week
 * ending 2026-10-12 (3,352,453 rows) passed the 1 GB limit of a value, so the
 * seal died with 54000 on every tick and the union week could not close. Both
 * seals now hash per bucket (one source, the first two hex digits of row_id)
 * and hash the bucket hashes in order; no value is larger than one bucket.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261012113248_the_inventory_seal_hashes_rows_by_bucket.sql'
  ),
  'utf8'
);

describe('the inventory seal hashes its rows bucket by bucket', () => {
  it('is one transaction with a live proof and pinned preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("'52a411ca25dc73c6fa077835613f1fc8'");
    expect(sql).toContain("'54e7ef8cfe674dc59489c530e644a39c'");
  });

  it('never builds one string of every row again', () => {
    expect(sql).toContain('GROUP BY 1,2) x$q$ INTO v_rows_md5;');
    expect(sql).toContain('left(o_row_id::text,2) b');
    expect(sql).toContain("string_agg(x.h,E'\\n' ORDER BY x.sn,x.b)");
    // Both seals lose the whole-string rows hash from their shared statement.
    expect(sql).toContain("'advance whole rows hash'");
    expect(sql).toContain("'one-go whole rows hash'");
  });

  it('verifies a week sealed whole by the hash it was sealed with', () => {
    expect(sql).toContain("IF p_verify AND p_at<='2026-10-05 07:00:00+00'::timestamptz THEN");
  });
});
