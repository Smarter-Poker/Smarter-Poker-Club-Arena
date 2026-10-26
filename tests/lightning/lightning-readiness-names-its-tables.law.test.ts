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

/* THE OTHER DIRECTION (2026-10-25). Naming eight tables only proved the eight
   exist. A ninth lightning_* table granted to service_role would still pass
   here and then turn every cluster's readiness NO_GO in production - the
   2026-10-23 incident this law was written for. So replay every migration in
   order and keep the lightning_* tables service_role is left able to SELECT:
   that set must be exactly the named list, or this file changes on purpose. */
const GRANT_OR_REVOKE =
  /\b(GRANT|REVOKE)\s+([\w\s,()]+?)\s+ON\s+(?:TABLE\s+)?((?:(?:public\.)?"?[a-z_]+"?\s*,\s*)*(?:public\.)?"?[a-z_]+"?)\s+(TO|FROM)\s+([\w\s,"]+?)\s*;/gi;
const serviceReadable = new Set<string>();
for (const file of readdirSync('supabase/migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  const body = readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '');
  for (const [, verb, privileges, targets, , roles] of body.matchAll(GRANT_OR_REVOKE)) {
    if (!/\bservice_role\b/i.test(roles) || !/\b(ALL|SELECT)\b/i.test(privileges)) continue;
    for (const raw of targets.split(',')) {
      const table = raw
        .trim()
        .replace(/^public\./i, '')
        .replace(/"/g, '')
        .toLowerCase();
      if (!table.startsWith('lightning_')) continue;
      if (verb.toUpperCase() === 'GRANT') serviceReadable.add(table);
      else serviceReadable.delete(table);
    }
  }
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

  it('names exactly the lightning_* tables the migrations leave service_role able to read', () => {
    // Both directions: a named table that lost its grant, or a granted table
    // nobody named, fails here before it can fail readiness in production.
    expect([...serviceReadable].sort()).toEqual(named);
  });
});
