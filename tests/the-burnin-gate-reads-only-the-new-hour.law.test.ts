/**
 * LAW: THE BURN-IN GATE READS ONLY THE NEW HOUR (2026-10-12).
 *
 * The Midway burn-in gate (cron ca-burnin-gate-hourly, 120 s statement
 * timeout) must prove "no failed or stuck settlement in 24 hours" without
 * reading 24 hours of ca_settlements every hour. Its two "index-only" counts
 * (20261011200626) were index-only in name only: pruned pages are refilled,
 * so the last day's pages are rarely all-visible, and every settlement state
 * transition leaves a dead entry in idx_ca_settlements_updated_at. The run
 * crept from 2 s back to 74 s within a day.
 *
 * 'final' is terminal and every other transition stamps updated_at := now(),
 * so the non-final rows of a range read with no writer still open inside it
 * can only shrink. Each run stores that set (from, before, open ids) in its
 * ca_gate_runs row and the next run reads only the open ids and the rows
 * dated since. The proof ends at a horizon no open transaction can write
 * behind, read from pg_stat_activity before the gate's snapshot.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const hit = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_the_burnin_gate_reads_only_the_new_hour.sql'));
const SQL = hit.length === 1 ? fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8') : '';
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const between = (from: string, to: string): string => {
  const a = SQL.indexOf(from);
  const b = SQL.indexOf(to, a + from.length);
  expect(a, `missing ${from}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing ${to}`).toBeGreaterThan(a);
  return SQL.slice(a, b);
};

const gate = (): string =>
  between(
    'THE GATE READS ONLY THE NEW HOUR (2026-10-12). The two counts above',
    "$w$, 'gate settlement check'"
  );

describe('the burn-in gate reads only the new hour', () => {
  it('is exactly one recorded migration with one transaction and a live proof', () => {
    expect(hit).toHaveLength(1);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL.match(/^-- @live-proof: .+$/gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect([...SQL].filter((ch) => (ch.codePointAt(0) ?? 0) > 127)).toEqual([]);
  });

  it('edits the gate and its tick by exact anchors against measured preimages, idempotently', () => {
    expect(SQL).toContain("md5(v_src) <> '54cdadc56b6f49d38971ffc11374f90f'");
    expect(SQL).toContain("md5(v_src) <> '2eae5f518ef55299491fb05303356c6d'");
    expect(SQL.match(/NEW_HOUR_GATE_PREIMAGE_CHANGED/g)?.length).toBe(2);
    expect(SQL).toContain('IF v_n IS DISTINCT FROM 1 THEN');
    expect(SQL.match(/already carries the change; skipping/g)?.length).toBe(2);
    expect(SQL).toContain('DO $prove$');
    expect(SQL).toContain('the gate is no longer STABLE');
  });

  it('ends the proof at a horizon no open client transaction can write behind', () => {
    const g = gate();
    expect(g).toContain('v_horizon := LEAST(v_settled_by,');
    expect(g).toContain('SELECT min(a.xact_start)');
    expect(g).toContain('FROM pg_catalog.pg_stat_activity a');
    expect(g).toContain("WHERE a.backend_type = 'client backend'");
    expect(g).toContain('AND a.pid <> pg_backend_pid()');
    expect(g).toContain("v_settled_by := now() - interval '10 minutes';");
  });

  it('reads pg_stat_activity in the tick before the statement that takes the gate snapshot', () => {
    const tick = between(
      'THE ACTIVITY READING COMES FIRST (2026-10-12).',
      "$w$, 'tick activity reading'"
    );
    const read = tick.indexOf('PERFORM count(*) FROM pg_catalog.pg_stat_activity;');
    const call = tick.indexOf('v_gate := public.fn_ca_midway_burnin_gate(24);');
    expect(read).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(read);
  });

  it('carries the previous proof only when it covers the window, and re-reads its open ids by key', () => {
    const g = gate();
    expect(g).toContain("SELECT r.result->'checks'->'no_failed_or_stuck_settlements'->'proof'");
    expect(g).toContain('FROM public.ca_gate_runs r');
    expect(g).toContain('ORDER BY r.run_at DESC');
    expect(g).toContain("OR (v_prev->>'from')::timestamptz > v_since");
    expect(g).toContain('OR v_before IS NULL OR v_before <= v_since OR v_before > now() THEN');
    expect(g).toContain('v_before := v_since;');
    expect(g).toContain(
      "WHERE s.id IN (SELECT o.v::uuid FROM jsonb_array_elements_text(v_prev->'open') AS o(v))"
    );
    expect(g).toContain("AND s.state <> 'final'");
  });

  it('reads only the rows dated since the proof, as all rows minus final rows in one statement', () => {
    const g = gate();
    expect(g).toMatch(
      /SELECT \(SELECT count\(\*\) FROM public\.ca_settlements\s+WHERE updated_at >= v_before AND updated_at > v_since AND updated_at < v_horizon\)\s+- \(SELECT count\(\*\) FROM public\.ca_settlements\s+WHERE state = 'final'\s+AND updated_at >= v_before AND updated_at > v_since AND updated_at < v_horizon\)\s+INTO v_open_before;/
    );
    expect(g).toContain('IF v_open_before <> 0 THEN');
    expect(g).toContain('v_before := v_horizon;');
  });

  it('keeps the exact meaning of failed and stuck', () => {
    const g = gate();
    expect(g.match(/FILTER \(WHERE s\.state = 'failed'\)/g)?.length).toBe(2);
    expect(
      g.match(
        /FILTER \(WHERE s\.state NOT IN \('final','failed'\) AND s\.updated_at < now\(\) - interval '10 minutes'\)/g
      )?.length
    ).toBe(2);
    expect(g).toContain(
      'WHERE s.id = ANY (v_open) AND s.updated_at > v_since AND s.updated_at < v_before;'
    );
    expect(g).toContain('WHERE s.updated_at >= v_before AND s.updated_at > v_since;');
  });

  it('publishes the proof beside the counts, bounded', () => {
    expect(SQL).toContain(
      "'failed', c_failed_settlements, 'stuck', c_stuck_settlements, 'proof', v_proof),"
    );
    expect(gate()).toContain('IF cardinality(v_open) <= 1000 THEN');
    expect(gate()).toContain(
      "v_proof := jsonb_build_object('from', v_since, 'before', v_before, 'open', to_jsonb(v_open));"
    );
  });

  it('builds no index, schedules nothing, writes no row and drops no player', () => {
    expect(CODE).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
    expect(CODE).not.toMatch(/cron\.(?:schedule|alter_job|unschedule)/i);
    expect(CODE).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|DROP)\b/i);
    expect(CODE).not.toMatch(/is_horse/);
  });
});
