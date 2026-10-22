/**
 * LAW: A MIGRATION NEVER HOLDS THE LIVE TABLES HOSTAGE (2026-10-22).
 *
 * At 02:34 and 02:48 UTC on 2026-10-22 the Midway rake-cap migration looped
 * for up to 300 s on LOCK TABLE clubs, tables, hand_history IN ACCESS
 * EXCLUSIVE MODE. Each queued request froze every live reader and writer
 * behind it; hand commits timed out and 32 table engines killed themselves in
 * 15 minutes ("Engine Restart Storm").
 *
 * What this pins:
 *   1. The database cancels, every 5 seconds, any direct session older than
 *      15 s that queues or holds a writer-blocking lock on a public table while
 *      it is queued or actually blocking someone. PostgREST traffic is never a
 *      target. Every cancel is recorded and raised.
 *   2. No migration written after this one retries a table lock in a loop.
 *      Take the lock in one short try; if it is refused, apply again later.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.cwd(), 'supabase/migrations');
const SELF = '20261022030326_a_migration_never_holds_the_live_tables_hostage.sql';
const MIG = readFileSync(resolve(DIR, SELF), 'utf8');
const code = MIG.replace(/--[^\n]*/g, ' ');

describe('a migration never holds the live tables hostage', () => {
  it('is one transaction', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('cancels a direct session that keeps live writers waiting on a table lock', () => {
    expect(code).toContain(
      "'ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'"
    );
    expect(code).toContain("a.usename IS DISTINCT FROM 'authenticator'");
    expect(code).toContain("a.backend_type = 'client backend'");
    expect(code).toContain('a.pid <> pg_backend_pid()');
    expect(code).toContain('CONTINUE WHEN NOT r.waiting AND v_blk = 0;');
    expect(code).toContain('pg_catalog.pg_cancel_backend(r.pid)');
    expect(code).toContain('INSERT INTO public.ca_writer_lock_sentinel_cancels');
    expect(code).toContain("'fn_ca_writer_lock_sentinel'");
  });

  it('runs every 5 seconds with a 15 second ceiling', () => {
    expect(code).toMatch(
      /cron\.schedule\('ca-writer-lock-sentinel-5s', '5 seconds',\s*\$job\$SELECT public\.fn_ca_writer_lock_sentinel\(15\)\$job\$\)/
    );
    expect(MIG).toMatch(/^-- periodic-work: /m);
  });

  it('no later migration retries a table lock in a loop', () => {
    const later = readdirSync(DIR).filter(
      (f) => f.endsWith('.sql') && /^\d{14}_/.test(f) && f > SELF
    );
    for (const f of later) {
      const sql = readFileSync(resolve(DIR, f), 'utf8').replace(/--[^\n]*/g, ' ');
      const loops = sql.match(/\bLOOP\b[\s\S]*?\bEND\s+LOOP\b/gi) ?? [];
      for (const body of loops)
        expect(/\bLOCK\s+TABLE\b/i.test(body), `${f} retries LOCK TABLE in a loop`).toBe(false);
    }
  });
});
