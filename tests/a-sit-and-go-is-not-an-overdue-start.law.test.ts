/**
 * LAW: A SIT AND GO IS NOT AN OVERDUE START (2026-10-15).
 *
 * A Spin or heads-up Sit and Go carries a start_time but starts when its last
 * seat is bought. fn_ca_launch_health counts only a scheduled event (MTT or
 * SATELLITE) still registering 15 minutes after its start as overdue.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015141135_a_sit_and_go_is_not_an_overdue_start.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');

describe('a sit and go is not an overdue start', () => {
  it('is one transaction with a live proof and exact pre and post images', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/^-- @live-proof: .*'cebc498df2a40d8cbfdde241da836d19'$/m);
    expect(CODE).toContain("md5(src) <> 'de2ad3b6be750edf134abc93fe53f12a'");
    expect(CODE).toContain('launch_health_sng_security_refused');
  });

  it('only a scheduled event can be late to start', () => {
    expect(CODE).toContain(
      "AND t.tournament_type IN ('MTT', 'SATELLITE') AND t.start_time < now() - interval '15 minutes')"
    );
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});
