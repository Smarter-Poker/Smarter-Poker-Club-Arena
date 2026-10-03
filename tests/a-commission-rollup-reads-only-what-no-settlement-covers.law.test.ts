/**
 * A COMMISSION ROLLUP READS ONLY WHAT NO SETTLEMENT COVERS (2026-10-03).
 *
 * Pinned on migration 20261003091015_a_commission_rollup_reads_only_what_no_settlement_covers.sql.
 * fn_agent_commission_rollup_recompute counted every open commission row a
 * (club, agent) ever had, each probed against the settlements: 517 s of the
 * 2026-10-01 Midway close. It now merges the pair's settlement periods and
 * reads only the ranges they do not cover, through the open-row index. Same
 * predicate, same rows, same totals (proved on 145 pairs in one snapshot).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003091015_a_commission_rollup_reads_only_what_no_settlement_covers.sql'
  ),
  'utf8'
);
const replacement = sql.slice(sql.indexOf(' r:=$r$'), sql.indexOf('$r$;'));

describe('a commission rollup reads only what no settlement covers', () => {
  it('is one transaction with live proofs', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('edits only the 2026-10-03 preimage, by one exact anchor, and verifies the result', () => {
    expect(sql).toContain("IF md5(d)<>'5df64c45d986b47ceca85d17ecd37e2f' THEN");
    expect(sql).toContain("RAISE EXCEPTION 'rollup recompute anchor 1 count'");
    expect(sql).toContain('IF pg_get_functiondef(s)<>d THEN');
  });

  it('merges the settlement periods that cover anything into the ranges they do not cover', () => {
    expect(replacement).toContain('WHERE s.period_start < s.period_end');
    expect(replacement).toContain(
      'max(s.period_end) OVER (PARTITION BY s.club_id, s.user_id ORDER BY s.period_start, s.period_end'
    );
    expect(replacement).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS reach');
    expect(replacement).toContain(
      "FROM covered c WHERE c.period_start > COALESCE(c.reach, '-infinity'::timestamptz)"
    );
    expect(replacement).toContain("'-infinity'::timestamptz), 'infinity'::timestamptz");
  });

  it('reads open rows only inside those ranges, plus the rows no period can ever cover', () => {
    expect(replacement).toContain('AND ac.created_at >= g.lo AND ac.created_at < g.hi');
    expect(replacement).toContain('AND ac.created_at IS NULL');
    expect(replacement).toContain("AND ac.created_at = 'infinity'::timestamptz");
    expect(replacement.match(/ac\.settled_at IS NULL/g)?.length).toBe(3);
  });

  it('keeps the same totals per pair and the same upsert', () => {
    expect(replacement).toContain('coalesce(sum(r.amount), 0)  AS owed');
    expect(replacement).toContain('count(r.id)                 AS rows_behind');
    expect(replacement).toContain('min(r.created_at)           AS oldest');
    expect(replacement).toContain(
      'LEFT JOIN open_rows r ON r.club_id = pr.club_id AND r.user_id = pr.user_id'
    );
    // The anchor ends at the fresh CTE: the upsert itself is not rewritten.
    expect(replacement).not.toContain('INSERT INTO');
  });

  it('changes no table, index, grant or schedule', () => {
    expect(sql).not.toMatch(/^\s*(CREATE|DROP)\s+(UNIQUE\s+)?INDEX/im);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\s/im);
    expect(sql).not.toMatch(/cron\.(schedule|alter_job|unschedule)\(/);
  });
});
