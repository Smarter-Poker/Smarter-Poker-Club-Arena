/**
 * LAW: THE DAILY MISSION OUTBOX ROW IS LOCKED ONCE (2026-10-04).
 *
 * public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)
 * read its outbox row FOR UPDATE inside the drain's per-player subtransaction
 * and deleted it inside its own subtransaction, so every drained row died
 * with a MultiXact xmax: one MultiXact per booked event, index entries that
 * could never be marked dead, and a MultiXact lookup on every later read of
 * the row. The player lock (fn_lock_daily_mission_user, the function's first
 * statement) already serializes every writer of a player's outbox rows, so
 * the read drops FOR UPDATE.
 *
 * What this pins: the exact fragment removed and what replaces it, both md5s,
 * that the fixture is the live pre-image, that the player lock still comes
 * before the row read, one transaction with its guards, and that the
 * disposable-cluster proof ships:
 * scripts/ci/test-the-daily-mission-outbox-row-is-locked-once.py
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261004003924_the_daily_mission_outbox_row_is_locked_once.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');
const FIX = 'scripts/ci/fixtures/daily-mission-outbox-lock';
const PRE = readFileSync(resolve(process.cwd(), FIX, 'enqueue_daily_challenge_event.sql'), 'utf8');
const BEFORE = '1131a47e5e916b94ab0383ee570d4a60';
const AFTER = 'fb7a950cdbbc657b2b6a4b52b65443bf';
const OLD =
  '  FROM public.daily_challenge_event_outbox\n' +
  '  WHERE user_id = p_user_id\n' +
  '    AND event_key = p_event_key\n' +
  '  FOR UPDATE;\n';
const NEW =
  '  FROM public.daily_challenge_event_outbox\n' +
  '  WHERE user_id = p_user_id\n' +
  '    AND event_key = p_event_key;\n';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function decoded(name: string): string {
  const start = MIG.indexOf(`${name} constant text :=`);
  expect(start, `${name} is declared`).toBeGreaterThan(-1);
  const seg = MIG.slice(start, MIG.indexOf(';\n', MIG.indexOf("\\n'", start) + 1) + 1);
  return [...seg.matchAll(/E'((?:[^'\\]|\\.)*)'/g)]
    .map((p) => p[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .join('');
}

describe('the daily mission outbox row is locked once', () => {
  it('removes exactly the outbox FOR UPDATE, from the exact live text', () => {
    expect(md5(PRE)).toBe(BEFORE);
    expect(decoded('c_old')).toBe(OLD);
    expect(decoded('c_new')).toBe(NEW);
    expect(PRE.split(OLD)).toHaveLength(2);
    const after = PRE.replace(OLD, NEW);
    expect(md5(after)).toBe(AFTER);
    expect(md5(after.replace(NEW, OLD))).toBe(BEFORE);
    // The receipt read keeps its FOR UPDATE; only the outbox read changes.
    expect(after.match(/FOR UPDATE;/g)).toHaveLength(1);
    expect(after).toContain('FROM public.daily_challenge_progress_events\n  WHERE user_id = p_user_id\n    AND event_key = p_event_key\n  FOR UPDATE;');
  });

  it('pins both md5s, the live proof and the guards in one transaction', () => {
    expect(MIG).toContain(`c_before constant text := '${BEFORE}';`);
    expect(MIG).toContain(`c_after constant text := '${AFTER}';`);
    expect(MIG).toContain(
      `-- @live-proof: (SELECT md5(pg_get_functiondef('public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'::regprocedure)) = '${AFTER}')`
    );
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '3s';");
    expect(MIG).toContain("SET LOCAL statement_timeout = '60s';");
    expect(MIG).toContain('/ length(c_old) <> 1 THEN');
    expect(MIG).toContain('EXECUTE replace(v_def, c_old, c_new);');
    expect(MIG).toContain('md5(replace(v_after, c_new, c_old)) <> c_before');
    expect(MIG).toContain('p.proacl::text IS NOT DISTINCT FROM v_acl');
    expect(MIG).toContain("has_function_privilege('anon', c_sig::regprocedure, 'EXECUTE')");
    expect(MIG).toContain("has_function_privilege('authenticated', c_sig::regprocedure, 'EXECUTE')");
    // Only this function, and no change to the drain itself.
    expect(MIG).not.toMatch(/sp_drain_daily_challenge_event_outbox\(integer/);
    expect(MIG).not.toMatch(/^\s*(CREATE|ALTER|DROP|GRANT|REVOKE)\b/m);
  });

  it('keeps the player lock ahead of the row read that loses its row lock', () => {
    const lock = PRE.indexOf('PERFORM public.fn_lock_daily_mission_user(p_user_id);');
    const read = PRE.indexOf(OLD);
    const del = PRE.indexOf('DELETE FROM public.daily_challenge_event_outbox');
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(del).toBeGreaterThan(read);
  });

  it('ships the disposable-cluster proof with the md5-pinned live chain', () => {
    expect(existsSync(resolve(process.cwd(), 'scripts/ci/test-the-daily-mission-outbox-row-is-locked-once.py'))).toBe(true);
    const pins: Record<string, string> = {
      enqueue_daily_challenge_event: BEFORE,
      record_daily_challenge_event: '1e59c130b38fbe6d9c4728e9bac0a17e',
      fn_lock_daily_mission_user: '0e9d2905374930bda4529a8febc6eff6',
      fn_drain_daily_challenge_event_outbox_user: '1f9a8c14027257664a61830770854b0b',
      sp_drain_daily_challenge_event_outbox: '8d827eb13fb07f3d212ff3af839819f6',
    };
    for (const [name, pin] of Object.entries(pins)) {
      expect(md5(readFileSync(resolve(process.cwd(), FIX, `${name}.sql`), 'utf8')), name).toBe(pin);
    }
  });
});
