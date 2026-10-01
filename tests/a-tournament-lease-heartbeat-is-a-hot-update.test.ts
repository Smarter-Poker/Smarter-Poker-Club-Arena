/**
 * A TOURNAMENT LEASE HEARTBEAT IS A HOT UPDATE
 *
 * 2026-10-01: one-shot union-close cron jobs held single transactions for
 * 38-45 minutes, pinning the xmin horizon. Every lease heartbeat sets
 * heartbeat_at, which was indexed, so 0 of 19.4M heartbeats were HOT;
 * engine_tournament_leases piled up ~142k dead tuples, heartbeat RPCs hit
 * 8 s and ~1,650 tournament leases expired at the 20 s proof window.
 * Measured against a native PG17 fixture built from the live catalogue:
 * 1,500 heartbeats, 0 HOT before; 1,316 HOT after on the old full pages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = '20261001200224_tournament_lease_heartbeats_are_hot_updates_and_no_long_back.sql';
const SQL = readFileSync(resolve(DIR, FILE), 'utf8');

describe('the tournament lease heartbeat', () => {
  it('changes no indexed column: the heartbeat_at index is dropped and pages keep room for HOT', () => {
    expect(SQL).toMatch(/^DROP INDEX IF EXISTS public\.idx_engine_tournament_leases_heartbeat;$/m);
    expect(SQL).toMatch(/^ALTER TABLE public\.engine_tournament_leases SET \(fillfactor = 50\);$/m);
    expect(SQL).toContain('lease_hot_postimage: % index(es) still cover heartbeat_at');
    expect(SQL).toContain('lease_hot_postimage: expected exactly the primary key index');
  });

  it('is applied only against the inspected heartbeat and table, in one transaction, without queueing heartbeats', () => {
    expect(SQL).toContain("IF p.m <> '19e8332821e7a9af9605e63917ceadaf'");
    expect(SQL).toContain('lease_hot_preimage: uninspected index(es) on engine_tournament_leases');
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL).toMatch(/^SET LOCAL lock_timeout = '2s';$/m);
    expect(SQL.match(/^-- @live-proof: /gm)?.length).toBe(3);
  });

  it('unschedules every midway one-shot close so none fires into live play again', () => {
    expect(SQL).toContain(
      "FOR j IN SELECT jobid, jobname FROM cron.job WHERE jobname LIKE 'midway-0921-close-once-%'"
    );
    expect(SQL).toContain('PERFORM cron.unschedule(j.jobid);');
    expect(SQL).toContain('lease_hot_postimage: a midway one-shot close job is still scheduled');
  });

  it('is not undone by any later migration re-indexing heartbeat_at', () => {
    const later = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > FILE);
    for (const f of later) {
      const body = readFileSync(resolve(DIR, f), 'utf8');
      expect(body, f).not.toMatch(
        /CREATE\s+(UNIQUE\s+)?INDEX[^;]*ON\s+(public\.)?engine_tournament_leases[^;]*heartbeat_at/i
      );
    }
  });
});
