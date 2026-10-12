/** Native commit, WAL, crash and equivalence proof: scripts/dev/test-inventory-seal-bounded.py. */
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
const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
describe('the inventory seal commits bounded pages before publishing an immutable checkpoint', () => {
  it('uses one bounded installation transaction and exact source prerequisites', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout='5s'");
    expect(sql).toContain("'6deca79658f44ffb149316167441b2bf'");
    expect(sql).toContain("'01288c36118e1e26e7673fc71f155bf6'");
    expect(sql).toContain("'929cc88e98cd027e821f871f8adbe935'");
  });
  it('preserves historical foreign keys and immutability instead of writing partial historical rows', () => {
    expect(sql).not.toMatch(/ALTER TABLE public\.union_pnl_inventory_checkpoint_(?:rows|issues)/);
    expect(sql).not.toMatch(/DROP (?:CONSTRAINT|TRIGGER)/);
    expect(sql).not.toContain('INSERT INTO public.union_pnl_inventory_checkpoint_rows');
    expect(sql).not.toContain('INSERT INTO public.union_pnl_inventory_checkpoint_issues');
    expect(sql).toContain('REFERENCES public.union_pnl_inventory_seal_builds(boundary)');
    expect(sql).toContain('inventory_build_is_immutable');
  });
  it('bounds count and encoded volume before writing and advances a durable forward-only cursor', () => {
    expect(sql).toContain('LIMIT 32768');
    expect(sql).toContain('WHERE used<=33554432');
    expect(sql).toContain(
      '512+4*GREATEST(COALESCE(pg_column_size(s.o_after_row),0),COALESCE(octet_length(s.o_after_row::text),0))'
    );
    expect(sql).toContain(
      '(NEW.last_kind,NEW.last_source,NEW.last_row,NEW.last_event)>(OLD.last_kind,OLD.last_source,OLD.last_row,OLD.last_event)'
    );
    expect(sql).toContain('-- Publication always uses a separate tick');
  });
  it('publishes only after independent durable-set and checksum readback', () => {
    expect(sql).toContain('EXCEPT ALL');
    expect(sql).toContain('inventory_build_checksum_disagrees_with_original_source');
    expect(sql).toContain('JOIN public.union_pnl_inventory_checkpoints c ON c.boundary=r.boundary');
    expect(sql).toContain(
      'JOIN public.union_pnl_inventory_seal_builds b ON b.boundary=r.boundary AND b.ready'
    );
    expect(sql).toContain('complete_inventory_build_required');
    expect(sql).toContain('FROM PUBLIC,anon,authenticated,service_role');
  });
  it('continues through the existing close callers and enforces native regression in required accounting qualification', () => {
    expect(sql).toContain('-- One bounded seal operation per original close transaction.');
    expect(sql).toContain('inventory_seal_receipt_invalid');
    expect(sql).toContain('public.union_pnl_inventory_seal_builds b');
    expect(workflow).toContain('python3 scripts/dev/test-inventory-seal-bounded.py');
  });
});
