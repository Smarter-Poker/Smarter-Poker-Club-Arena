/**
 * THE INVENTORY SEAL ASSEMBLES ITS WEEK BUCKET BY BUCKET (2026-10-12).
 *
 * Pinned on migration 20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql.
 *
 * Supabase Realtime shuts replication down when one open writing transaction
 * is more than 1.5 GB of WAL behind. The seal wrote a whole week's checkpoint
 * (3,352,453 rows on 2026-10-12, growing every week) in one statement, which is
 * over that cutoff by itself. The week is now assembled one bucket (one source,
 * the first two hex digits of row_id) at a time, capped per call, and the
 * checkpoint row (which every reader finds a week through) is written last
 * with the same rows hash formula as 20261012113248.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql'
  ),
  'utf8'
);

describe('the inventory seal assembles its week bucket by bucket', () => {
  it('is one transaction with a live proof and pinned pre and post images', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("'6deca79658f44ffb149316167441b2bf'");
    expect(sql).toContain("'47b1a3a80eec9fc6a593e99ebef27c27'");
    // never installed under a week that is mid-seal
    expect(sql).toContain("'an inventory seal is in progress; install between seals'");
  });

  it('caps the rows one call writes', () => {
    expect(sql).toContain(
      "IF did_bucket AND (n_tick>=400000 OR clock_timestamp()>began+interval '75 seconds') THEN"
    );
    // ~500 bytes a row in the checkpoint: 400,000 rows is ~200 MB, far under 1.5 GB
    expect(400000 * 500).toBeLessThan(1.5 * 1024 ** 3 * 0.25);
    expect(sql).toContain(
      '-- The checkpoint row gets a call of its own once the last bucket is in.'
    );
  });

  it('hashes the assembled week exactly as the whole-week seal does', () => {
    expect(sql).toContain(
      "md5(COALESCE(string_agg(b.rows_md5,E'\\n' ORDER BY b.source_name,b.bucket) FILTER(WHERE b.row_count>0),''))"
    );
    expect(sql).toContain(
      "(SELECT md5(string_agg(concat_ws('|',k.source_name,w.rid,w.eid,w.fop,COALESCE(w.after_row::text,'~')),E'\\n' ORDER BY w.rid)) FROM w)"
    );
    expect(sql).toContain(
      "SELECT md5(COALESCE(string_agg(concat_ws('|',i.source_name,i.row_id,i.event_id),E'\\n' ORDER BY i.source_name,i.row_id,i.event_id),''))"
    );
  });

  it('drops a partial assembly when its week restarts, never a sealed week', () => {
    expect(sql).toContain(
      '  IF NOT p_verify THEN\n   TRUNCATE public.union_pnl_inventory_seal_buckets;'
    );
    expect(sql).toContain(
      'DELETE FROM public.union_pnl_inventory_checkpoint_rows WHERE boundary=p_at;'
    );
    expect(sql).toContain('CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_buckets');
  });
});
