/**
 * THE WRITE PATH KEEPS ONLY THE INDEXES IT READS (2026-10-03, launch-gate sweep).
 *
 * Pinned on migration 20261003031000. The database is saturated on WAL
 * (1.31 TB in 4.4 days, 294.7M full-page images, ~28 backends waiting on
 * WALWrite at peak). Ten indexes that no reader used, or that were strict
 * prefixes of another index with the same predicate, are dropped from hot
 * write tables; two club_member_daily_stats covering indexes that carried the
 * per-hand counters (so no per-hand update could be HOT) are replaced by the
 * same keys without them; and the treasury debit-leg index is finally built.
 * No unique index, constraint, function body, grant or schedule changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003031000_the_write_path_keeps_only_the_indexes_it_reads.sql'
  ),
  'utf8'
);

const DROPPED = [
  'idx_agent_commissions_club_id',
  'idx_agent_commissions_user',
  'agent_commissions_unsettled_idx',
  'ca_horse_fleet_state_state_idx',
  'ca_horse_fleet_state_club_idx',
  'ca_horse_fleet_state_stuck_idx',
  'horse_mind_pairs_updated_at_idx',
  'idx_ca_hand_facts_allin',
  'idx_cmds_club_date_user',
  'idx_cmds_user_stat_date',
];

describe('the write path keeps only the indexes it reads', () => {
  it('builds every new index CONCURRENTLY before the one transaction', () => {
    const begin = sql.search(/^BEGIN;$/m);
    expect(begin).toBeGreaterThan(-1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    for (const ix of [
      'idx_cmds_club_date_hot',
      'idx_cmds_user_stat_date_hot',
      'idx_chip_ledger_treasury_out',
    ]) {
      const at = sql.indexOf(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix}`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(begin);
    }
    expect(sql).toMatch(
      /ON public\.chip_ledger \(from_entity_id, created_at\) INCLUDE \(amount\)\n\s+WHERE from_type = 'club_treasury' AND from_entity_id IS NOT NULL;/
    );
  });

  it('the replacement club_member_daily_stats indexes carry no per-hand column', () => {
    expect(sql).toMatch(
      /ON public\.club_member_daily_stats \(club_id, stat_date\) INCLUDE \(user_id\);/
    );
    expect(sql).toMatch(
      /ON public\.club_member_daily_stats \(user_id, stat_date DESC\) INCLUDE \(table_id\);/
    );
    expect(sql).toMatch(/still carries a per-hand column/);
  });

  it('drops exactly the ten, each guarded against a unique or constraint index', () => {
    const drops = [...sql.matchAll(/^DROP INDEX IF EXISTS public\.([a-z0-9_]+);$/gm)].map(
      (m) => m[1]
    );
    expect(drops.sort()).toEqual([...DROPPED].sort());
    expect(sql).toMatch(/i\.indisunique OR i\.indisprimary OR i\.indisexclusion/);
    expect(sql).toMatch(/pg_constraint c WHERE c\.conindid/);
    // never a unique or primary-key index, never anything but an index
    expect(sql).not.toMatch(/DROP INDEX[^;]*(pkey|uq_|_key\b)/);
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|FUNCTION|TRIGGER|CONSTRAINT)/im);
  });

  it('refuses unless every covering index is valid with its exact definition', () => {
    for (const ix of [
      'idx_agent_commissions_club_created',
      'agent_commissions_user_recent_idx',
      'agent_commissions_open_idx',
      'idx_ca_hand_facts_user_time',
      'horse_mind_pairs_opps_idx',
    ]) {
      expect(sql).toContain(`'public.${ix}'`);
    }
    expect(sql).toMatch(/i\.indisvalid AND i\.indisready AND i\.indislive/);
    expect(sql).toMatch(/pg_get_indexdef\(i\.indexrelid\) = r\.def/);
  });

  it('changes no behaviour: no function, grant, schedule or table option', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\b/im);
    expect(sql).not.toMatch(/cron\.(schedule|alter_job|unschedule)\s*\(/);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/im);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '2s';/);
  });

  it('states that every CONCURRENTLY statement ran outside the transaction', () => {
    expect(sql).toMatch(/ran in production\n-- OUTSIDE any transaction, one statement per session/);
    expect(sql).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS of step 3 below/);
    expect(sql).toMatch(/as the whole command of its own one-shot pg_cron job/);
    for (const ix of DROPPED) {
      expect(sql).toMatch(new RegExp(`to_regclass\\('public\\.${ix}'\\) IS NULL`));
    }
  });
});
