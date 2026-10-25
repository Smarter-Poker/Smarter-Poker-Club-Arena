/**
 * AN OWNER SWITCH-OFF FINDS ITS REQUEST BY INDEX
 *
 * fn_cash_game_switch_off looks up an earlier answer to the same request by
 * (game_id, kind = 'game_switched_off_by_owner', request_id). With only the
 * (game_id, at) index on a 5M-row event log, that read every event of a busy
 * game and ran past 8 s: 20261024213143 was refused twice on 2026-10-25.
 * 20261025022430 adds a partial index for exactly that lookup, built
 * CONCURRENTLY through the applier's preamble.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20261025022430_an_owner_switch_off_finds_its_request_by_index.sql'
);

describe('an owner switch-off finds its request by index', () => {
  const sql = readFileSync(FILE, 'utf8');
  const begin = sql.indexOf('\nBEGIN;');

  it('builds the lookup index concurrently, before the transaction', () => {
    const create = sql.indexOf(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_cluster_events_owner_switch_off_request'
    );
    expect(create).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(create);
    const statement = sql.slice(create, sql.indexOf(';', create));
    expect(statement).toContain('ON public.cash_cluster_events (game_id, request_id)');
    expect(statement).toContain("WHERE kind = 'game_switched_off_by_owner'");
  });

  it('the transaction only proves the index is valid, ready and exact', () => {
    // The expected definition is quoted text the guard compares, not DDL.
    const tx = sql.slice(begin).replace(/\$expected\$[\s\S]*?\$expected\$/g, "''");
    expect(tx).toContain('i.indisvalid');
    expect(tx).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
    expect(tx).not.toMatch(/\bDROP\b/i);
    expect(tx).toMatch(/SET LOCAL lock_timeout = '1s'/);
  });
});
