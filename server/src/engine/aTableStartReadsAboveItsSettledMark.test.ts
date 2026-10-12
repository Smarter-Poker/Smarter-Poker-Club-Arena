/**
 * 2026-10-02 07:46-08:16 UTC: 62 table starts refused with
 * "retained_hand_submission_readback_failed: canceling statement due to
 * statement timeout" and 37 Spin/SNG tournament leases expired.
 *
 * The start-time readback walked every submission the table ever retained
 * (23,405 on one cash table) to answer "nothing unfinished"; every Spin and SNG
 * start locked the hot union-wallet or club row although only a guarantee can
 * debit it. These pins hold the shipped migration to the two corrections.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  resolve(
    HERE,
    '../../../supabase/migrations/20261002102307_a_table_start_reads_two_hundred_hands_at_a_time_inside_two_s.sql'
  ),
  'utf8'
);
const GUARD_SQL = readFileSync(
  resolve(
    HERE,
    '../../../supabase/migrations/20261002083400_a_table_start_reads_only_the_hands_after_its_settled_mark_an.sql'
  ),
  'utf8'
);
const betweenIn = (sql: string, from: string, to: string) =>
  sql.slice(sql.indexOf(from), sql.indexOf(to, sql.indexOf(from)));
const between = (from: string, to: string) =>
  SQL.slice(SQL.indexOf(from), SQL.indexOf(to, SQL.indexOf(from)));

describe('a table start reads only the hands after its settled mark', () => {
  const resume = between(
    'CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission',
    'DO $post$'
  );

  it('never asks the whole history: every submission read is bounded above the mark', () => {
    const reads = resume.match(/FROM smarter_private\.hand_submissions j[\s\S]*?LIMIT \d+/g) ?? [];
    expect(reads.length).toBe(3);
    for (const read of reads) expect(read).toMatch(/j\.hand_number>lo/);
    expect(resume).toContain('ORDER BY j.hand_number LIMIT 200) w;');
    // A call stops, saves its mark and answers pending inside a 3 s budget.
    expect(resume).toContain(
      "IF clock_timestamp()-statement_timestamp()>interval '2 seconds' THEN"
    );
    expect(resume).toContain("'reason','resume_scan_continues'");
  });

  it('keeps its progress and never moves the mark down', () => {
    expect(resume).toMatch(
      /settled_through=greatest\(hand_submission_resume_marks\.settled_through,EXCLUDED\.settled_through\)/
    );
  });
});

describe('a start without a guarantee locks no bank', () => {
  const guard = betweenIn(
    GUARD_SQL,
    'CREATE OR REPLACE FUNCTION public.fn_guard_tournament_start_readiness',
    'DO $post$'
  );

  it('takes the bank lock only under a guarantee, and never as FOR UPDATE', () => {
    expect(guard).toContain(
      'AND (COALESCE(NEW.guaranteed_prize, 0) > 0 OR COALESCE(NEW.satellite_seats, 0) > 0) THEN'
    );
    expect(guard).not.toMatch(/FOR UPDATE;/);
    expect(guard.match(/FOR NO KEY UPDATE;/g)?.length).toBe(2);
  });
});
