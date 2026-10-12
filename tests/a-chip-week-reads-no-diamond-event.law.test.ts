/**
 * A CHIP WEEK READS NO DIAMOND EVENT (2026-10-12).
 *
 * Pinned on migration 20261012113542_a_chip_week_reads_no_diamond_event.sql.
 * A Diamond Arena event's fee goes to the Diamond house and has no chip
 * recognition, so fn_accounting_tournament_week_quality read it as an event of
 * unknown scope and refused every chip club's week with
 * tournament_terminal_recognition_missing. The week's candidates now leave out
 * Diamond Arena events by fn_poker_diamond_tournament's own definition.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261012113542_a_chip_week_reads_no_diamond_event.sql'),
  'utf8'
);

describe('a chip week reads no Diamond event', () => {
  it('is one transaction with a live proof and a pinned preimage', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("'0d3dc681a14fa6b6b027f8ee6677bb41'");
  });

  it('filters the candidates by the Diamond event definition, and nothing else', () => {
    expect(sql).toContain('  WITH candidates_all AS (');
    expect(sql).toContain('SELECT a.tournament_id FROM candidates_all a');
    expect(sql).toContain(
      "WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL)"
    );
    // Horses are players: the filter names an asset, never a player.
    expect(sql).not.toMatch(/is_horse/);
  });
});
