/**
 * LAW: TWO DETECTORS READ WHAT REALLY HAPPENED (2026-10-11).
 *
 * 1. fn_ca_absent_tournament_players filed a critical ("2 player(s) are still
 *    in this event with no chips and no chair, the oldest for 0.6 hour(s)")
 *    while every player it counted was inside a 30 second rebuy decision.
 *    table_seats keeps one row per chair and the seating path reuses a vacated
 *    row, so the chair a player just lost stops naming them seconds later and
 *    the detector clocked them from an earlier table or from registering.
 *    Absence is now clocked from the latest trace that is never reused: the
 *    knockout candidate (from the end of its rebuy prompt) and the seat move
 *    receipt, as well as any seat row that still names the player.
 * 2. fn_ca_midway_burnin_gate timed out 8 of 24 hourly runs: its settlement
 *    check read the heap of every ca_settlements row updated in 24 hours (47 s
 *    on a 25 GB table). It now proves "no old row is non-final" with two
 *    index-only counts in one snapshot and runs the exact query only when that
 *    proof fails.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const hit = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_two_detectors_read_what_really_happened.sql'));
const SQL = hit.length === 1 ? fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8') : '';
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const between = (from: string, to: string): string => {
  const a = SQL.indexOf(from);
  const b = SQL.indexOf(to, a + from.length);
  expect(a, `missing ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing ${to}`).toBeGreaterThan(a);
  return SQL.slice(a, b);
};

describe('two detectors read what really happened', () => {
  it('is exactly one recorded migration with one transaction and live proofs', () => {
    expect(hit).toHaveLength(1);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL.match(/^-- @live-proof: .+$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect([...SQL].filter((ch) => (ch.codePointAt(0) ?? 0) > 127)).toEqual([]);
  });

  it('edits both detectors by exact anchors against measured preimages, idempotently', () => {
    expect(SQL).toContain("md5(v_src) <> '054e2ef927791833ca6dc8946d7bbfe6'");
    expect(SQL).toContain("md5(v_src) <> 'd5135c555bbb6ae2a0e58a3e96a13286'");
    expect(SQL.match(/TWO_DETECTORS_PREIMAGE_CHANGED/g)?.length).toBe(2);
    expect(SQL).toContain('IF v_n IS DISTINCT FROM 1 THEN');
    expect(SQL.match(/already carries the change; skipping/g)?.length).toBe(2);
    expect(SQL).toContain('DO $prove$');
  });

  it('clocks absence from the latest trace that a reused chair cannot erase', () => {
    const absent = between('A SEAT ROW IS NOT A DEPARTURE (2026-10-11)', '$w$,');
    expect(absent).toContain('FROM public.tournament_knockout_candidates k');
    expect(absent).toContain('k.tournament_id = t.id AND k.eliminated_user_id = p.user_id');
    expect(absent).toContain('FROM public.tournament_seat_move_receipts m');
    expect(absent).toContain('m.tournament_id = t.id AND m.user_id = p.user_id');
    expect(absent).toContain('(SELECT max(s.left_at)');
    expect(absent).toMatch(/COALESCE\(\s*GREATEST\(/);
  });

  it('treats a pending rebuy decision as presence, but never for more than 5 minutes', () => {
    const absent = between('A SEAT ROW IS NOT A DEPARTURE (2026-10-11)', '$w$,');
    expect(absent).toContain('LEAST(COALESCE(k.rebuy_prompt_until, k.created_at),');
    expect(absent).toContain("k.created_at + interval '5 minutes')");
  });

  it('never drops a player from the count and keeps the maintenance clause', () => {
    expect(CODE).not.toMatch(/is_horse/);
    expect(SQL).toContain("'public.fn_ca_engine_live_minutes(a.lost_chair_at, now())'");
    expect(SQL).toContain("'THEN p.registered_at END) AS lost_chair_at'");
  });

  it('proves the settlement window clean from two index-only counts in one statement', () => {
    const gate = between(
      'THE GATE COUNTS SETTLEMENTS WITHOUT READING THE TABLE (2026-10-11)',
      '$w$,'
    );
    expect(gate).toContain("v_settled_by := now() - interval '10 minutes';");
    expect(gate).toMatch(
      /SELECT \(SELECT count\(\*\) FROM public\.ca_settlements\s+WHERE updated_at > v_since AND updated_at <= v_settled_by\)\s+- \(SELECT count\(\*\) FROM public\.ca_settlements\s+WHERE state = 'final' AND updated_at > v_since AND updated_at <= v_settled_by\)\s+INTO v_open_before;/
    );
    expect(gate).toContain('IF v_open_before = 0 THEN');
    expect(gate).toContain('c_stuck_settlements := 0;');
    expect(gate).toContain('WHERE updated_at > GREATEST(v_since, v_settled_by);');
  });

  it('falls back to the original exact query whenever a non-final row is old enough to matter', () => {
    const gate = between(
      'THE GATE COUNTS SETTLEMENTS WITHOUT READING THE TABLE (2026-10-11)',
      '$w$,'
    );
    const fallback = gate.slice(gate.indexOf('  ELSE'));
    expect(fallback).toContain("count(*) FILTER (WHERE state = 'failed'),");
    expect(fallback).toContain(
      "count(*) FILTER (WHERE state NOT IN ('final','failed') AND updated_at < now() - interval '10 minutes')"
    );
    expect(fallback).toContain('FROM public.ca_settlements WHERE updated_at > v_since;');
  });

  it('builds no index, schedules nothing and writes no row', () => {
    expect(CODE).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
    expect(CODE).not.toMatch(/cron\.(?:schedule|alter_job|unschedule)/i);
    expect(CODE).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|DROP)\b/i);
  });
});
