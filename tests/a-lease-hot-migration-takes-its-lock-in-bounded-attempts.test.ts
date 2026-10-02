/**
 * THE LEASE HOT MIGRATION TAKES ITS TABLE LOCK IN BOUNDED ATTEMPTS
 *
 * 20261001200224 was refused on apply (55P03 lock timeout after 2.2 s):
 * every PostgREST request locks engine_tournament_leases through the
 * pre-request hook and tournament RPCs hold it for up to ~3 s, so a single
 * ACCESS EXCLUSIVE wait never found its gap. The successor takes the lock
 * first, alone, in short bounded attempts, so no tournament RPC waits more
 * than one attempt behind it. Measured on a native PG17 fixture of the live
 * catalogue with a 4 s competing holder: locked on attempt 3, then the same
 * end state; a replay locks on attempt 1 and changes nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const SQL = readFileSync(
  resolve(DIR, '20261001204429_tournament_lease_heartbeat_hot_update_takes_its_table_lock_i.sql'),
  'utf8'
);
const PREDECESSOR = readFileSync(
  resolve(DIR, '20261001200224_tournament_lease_heartbeats_are_hot_updates_and_no_long_back.sql'),
  'utf8'
);

describe('the lease HOT migration lock', () => {
  it('takes ACCESS EXCLUSIVE before any other statement, in at most 40 waits of 1.5 s', () => {
    expect(SQL).toMatch(/^SET LOCAL lock_timeout = '1500ms';$/m);
    expect(SQL).toContain('FOR attempt IN 1..40 LOOP');
    expect(SQL).toContain('LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE;');
    expect(SQL).toContain('EXCEPTION WHEN lock_not_available THEN\n      PERFORM pg_sleep(0.4);');
    const lockAt = SQL.indexOf('LOCK TABLE public.engine_tournament_leases');
    expect(lockAt).toBeGreaterThan(SQL.indexOf('BEGIN;'));
    expect(lockAt).toBeLessThan(SQL.indexOf('DO $pre$'));
    expect(lockAt).toBeLessThan(SQL.indexOf('\nDROP INDEX IF EXISTS'));
  });

  it('reaches exactly the end state its predecessor declared, behind the same guards', () => {
    const tail = (s: string) => s.slice(s.indexOf('DO $pre$'));
    expect(tail(SQL)).toBe(tail(PREDECESSOR));
    const proofs = (s: string) => [...s.matchAll(/^-- @live-proof: (.*)$/gm)].map((m) => m[1]);
    expect(proofs(SQL)).toEqual(proofs(PREDECESSOR));
    expect(proofs(SQL)).toHaveLength(3);
  });
});
