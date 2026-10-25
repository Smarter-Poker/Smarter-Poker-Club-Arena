import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* The readiness invariant `seven_tables` counted the lightning_* tables that
   service_role reads directly, and went false when a correctly service-only
   eighth (lightning_horse_fill) was added. It now names that exact set. The
   other lightning_* tables carry no direct grant at all and are reached only
   through definer functions, so they are outside this set by design. */
const MIGRATION =
  'supabase/migrations/20261024224758_lightning_readiness_names_its_eight_service_only_tables.sql';
const sql = readFileSync(MIGRATION, 'utf8');
const arrayBlock = /ARRAY\[([^\]]+)\]::text\[\]/.exec(sql)?.[1] ?? '';
const named = [...arrayBlock.matchAll(/'(lightning_[a-z_]+)'/g)].map((m) => m[1]).sort();

const created = new Set<string>();
for (const file of readdirSync('supabase/migrations')) {
  if (!file.endsWith('.sql')) continue;
  const body = readFileSync(`supabase/migrations/${file}`, 'utf8');
  for (const m of body.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?"?(lightning_[a-z_]+)"?/gi
  ))
    created.add(m[1].toLowerCase());
}

describe('Lightning readiness names every lightning_* table', () => {
  it('replaces the live count only when the source is the qualified one', () => {
    expect(sql).toMatch(/md5\(s\) <> '[0-9a-f]{32}'/);
    expect(sql).toContain(
      "replace(s, 'SELECT count(*) = 7 FROM information_schema.role_table_grants'"
    );
    expect(sql).toMatch(/^-- @live-proof: .*lightning_horse_fill/m);
  });

  it('names the eight service-read tables, each one a table the migrations create', () => {
    expect(named).toEqual([
      'lightning_blind_ledger',
      'lightning_hand',
      'lightning_hand_player',
      'lightning_horse_fill',
      'lightning_instance',
      'lightning_pool_session',
      'lightning_pool_slot',
      'lightning_reservation',
    ]);
    for (const table of named) expect(created.has(table), table).toBe(true);
  });
});
