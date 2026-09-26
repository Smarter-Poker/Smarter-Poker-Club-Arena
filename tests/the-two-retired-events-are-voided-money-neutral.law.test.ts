/**
 * THE TWO RETIRED MIXED-CUSTODY EVENTS ARE VOIDED, AND EVERY DOLLAR GOES HOME (2026-09-26)
 *
 * 5a387a75 and 615783bf are pinned to dead engine 778075b4 by mixed-custody
 * admissions no lease claim can take (F06_RETIRED_PARTIAL_PROCESS_CHANGED).
 * The reviewed ruling closes them as VOIDED and money-neutral: the guarantee
 * overlays go back to the union bank (100.00) and club 2a1132b9 (250.00), the
 * 39 add-ons go back through their entitlements, the 82.52 of recorded but
 * unpaid prizes are void, RexSr's elimination is recorded, and the stale
 * lease, chairs and tables are released.
 *
 * These laws pin that the door can only ever touch those two events, that
 * the f06_source_guard bypass exists only inside this migration's own
 * transaction and is restored byte for byte, and that the migration can
 * never wait while it holds the settlement lane.
 *
 * 20260926131948. docs/changelog/2026-09-26-the-two-retired-events-are-voided-money-neutral.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const SQL_A = readFileSync(
  join(
    MIGRATIONS,
    '20260926131948_the_two_retired_mixed_custody_events_are_voided_and_every_do.sql'
  ),
  'utf8'
);
const SQL_B = readFileSync(
  join(
    MIGRATIONS,
    '20260926142646_the_retired_noon_freeroll_is_voided_and_the_source_guard_is_.sql'
  ),
  'utf8'
);
/** Both transactions of the void, in apply order. */
const SQL = SQL_A + '\n' + SQL_B;

const GUARD_LIVE_MD5 = 'be484837a5103b3c0ac78a1d6d5d0bf2';
const GUARD_VOID_MD5 = '77a6d6505ecb318845d280176881e0f0';
const DOOR_MD5 = '1d8fe29089e20bb6dedd54fe00b46818';
const NOON = '5a387a75-754a-416e-8fee-b85b15fc2702';
const AFTERNOON = '615783bf-15e3-40b7-9368-75f21b6ac53b';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function bodies(name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`, from);
    if (start < 0) return out;
    const open = SQL.indexOf('AS $function$', start) + 'AS $function$'.length;
    const close = SQL.indexOf('$function$', open);
    out.push(SQL.slice(open, close));
    from = close;
  }
}

const [GUARD_VOID, GUARD_RESTORED] = bodies('smarter_private.f06_source_guard');
const [DOOR] = bodies('smarter_private.f06_void_retired_mixed_custody_event');

const CLAUSE_START = ' -- A REVIEWED VOID (2026-09-26).';
const CLAUSE_END = 'THEN moving:=true; END IF;\n';

function withoutVoidClause(b: string): string {
  const a = b.indexOf(CLAUSE_START);
  if (a < 0) return b;
  const z = b.indexOf(CLAUSE_END, b.indexOf("'615783bf", a)) + CLAUSE_END.length;
  return b.slice(0, a) + b.slice(z);
}

describe('the two retired events are voided money-neutral', () => {
  it('installs exactly the reviewed bodies', () => {
    expect(bodies('smarter_private.f06_source_guard')).toHaveLength(2);
    expect(md5(GUARD_VOID)).toBe(GUARD_VOID_MD5);
    expect(md5(GUARD_RESTORED)).toBe(GUARD_LIVE_MD5);
    expect(md5(DOOR)).toBe(DOOR_MD5);
  });

  it('edits the source guard by the one void clause and restores it byte for byte', () => {
    expect(md5(withoutVoidClause(GUARD_VOID))).toBe(GUARD_LIVE_MD5);
    const at = GUARD_VOID.indexOf(CLAUSE_START);
    const clause = GUARD_VOID.slice(at, GUARD_VOID.indexOf(CLAUSE_END, at) + CLAUSE_END.length);
    expect(clause).toContain(`t IN ('${NOON}'::uuid,'${AFTERNOON}'::uuid)`);
    expect(clause).toContain('v.xid=txid_current() AND v.completed_at IS NULL');
    // The restore comes after the void ran, and the post-image checks it.
    expect(SQL.indexOf('$void$;')).toBeLessThan(
      SQL.lastIndexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()')
    );
    expect(SQL.slice(SQL.indexOf('DO $post$'))).toContain(`md5(p.prosrc) = '${GUARD_LIVE_MD5}'`);
  });

  it('can only ever void the two reviewed events, once, with every fact pinned', () => {
    expect(DOOR).toContain(`c_noon constant uuid := '${NOON}'`);
    expect(DOOR).toContain(`c_afternoon constant uuid := '${AFTERNOON}'`);
    expect(DOOR).toContain('p_tournament_id NOT IN (c_noon, c_afternoon)');
    expect(DOOR).toContain("RAISE EXCEPTION 'F06_VOID_A_HUMAN_IS_ENTERED'");
    expect(DOOR).toContain("RAISE EXCEPTION 'F06_VOID_MONEY_ALREADY_MOVED'");
    expect(DOOR).toContain("RAISE EXCEPTION 'F06_VOID_LEASE_IS_LIVE'");
    expect(DOOR).toContain('fn_settle_tournament_refund_exact(');
    expect(DOOR).toContain("'tourney:' || p_tournament_id::text || ':void:overlay-return'");
    expect(SQL).toContain(
      `CONSTRAINT f06_retired_event_voids_reviewed_events CHECK (tournament_id IN (\n    '${NOON}'::uuid, '${AFTERNOON}'::uuid))`
    );
  });

  it('takes the settlement lane only when it is free, in each transaction', () => {
    expect(DOOR.indexOf('fn_ca_lock_settlement_lane_global()')).toBeGreaterThan(0);
    expect(SQL_A).toContain(
      " SET statement_timeout TO '20s'\n SET lock_timeout TO '5s'\nAS $function$"
    );
    expect(SQL).not.toMatch(/break_window_migration_override/);
    for (const [file, cap] of [
      [SQL_A, '15s'],
      [SQL_B, '20s'],
    ] as const) {
      expect(file).toContain("SET LOCAL lock_timeout = '5s';");
      const lane = file.indexOf('DO $lane$');
      const voidAt = file.indexOf('DO $void$');
      expect(lane).toBeGreaterThan(0);
      expect(lane).toBeLessThan(voidAt);
      expect(file.slice(lane, voidAt)).toContain(
        "EXIT WHEN pg_try_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1', 0));"
      );
      expect(file.slice(voidAt, voidAt + 600)).toContain(
        "EXIT WHEN pg_try_advisory_xact_lock(hashtextextended('ca:hand-settlement-barrier:v1', 0));"
      );
      expect(file.slice(lane, voidAt)).toContain(`SET LOCAL statement_timeout = '${cap}';`);
      expect(file.replace(DOOR, '')).not.toMatch(/pg_advisory_xact_lock\(/);
    }
    // One event per transaction: the 195-entrant event first, the 351-entrant one alone.
    const a = SQL_A.slice(SQL_A.indexOf('DO $void$'), SQL_A.indexOf('$void$;'));
    const b = SQL_B.slice(SQL_B.indexOf('DO $void$'), SQL_B.indexOf('$void$;'));
    expect(a).toContain(`f06_void_retired_mixed_custody_event('${AFTERNOON}'`);
    expect(a).not.toContain(`f06_void_retired_mixed_custody_event('${NOON}'`);
    expect(b).toContain(`f06_void_retired_mixed_custody_event('${NOON}'`);
    expect(b).not.toContain(`f06_void_retired_mixed_custody_event('${AFTERNOON}'`);
  });

  it('never rewrites a vacated chair that already reads left', () => {
    expect(DOOR).toContain(
      "AND (s.status IS DISTINCT FROM 'left' OR s.leave_pending IS DISTINCT FROM false"
    );
  });

  it('is one guarded transaction with explicit service_role grants and private receipts', () => {
    for (const file of [SQL_A, SQL_B]) {
      expect(file.match(/^BEGIN;$/gm)?.length).toBe(1);
      expect(file.match(/^COMMIT;$/gm)?.length).toBe(1);
      expect(file).not.toMatch(/CONCURRENTLY|VACUUM/);
      expect(file).toMatch(/^-- @live-proof: /m);
      expect(file.indexOf('DO $pre$')).toBeGreaterThan(0);
    }
    expect(SQL_A.indexOf('DO $pre$')).toBeLessThan(SQL_A.indexOf('CREATE TABLE'));
    // Between the two, the clause is installed; the second pins it and restores the guard.
    expect(SQL_A.slice(SQL_A.indexOf('DO $post$'))).toContain(
      `md5(p.prosrc) = '${GUARD_VOID_MD5}'`
    );
    expect(SQL_B.slice(0, SQL_B.indexOf('DO $lane$'))).toContain(
      `md5(p.prosrc) = '${GUARD_VOID_MD5}'`
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION smarter_private.f06_void_retired_mixed_custody_event(uuid, text)\n  TO service_role;'
    );
    expect(SQL).toContain(
      'REVOKE ALL ON TABLE smarter_private.f06_retired_event_voids FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });

  it('refuses planted regressions', () => {
    expect(md5(GUARD_VOID.replace('AND v.completed_at IS NULL', ''))).not.toBe(GUARD_VOID_MD5);
    expect(md5(DOOR.replace('NOT IN (c_noon, c_afternoon)', 'IS NULL'))).not.toBe(DOOR_MD5);
    expect(withoutVoidClause(GUARD_RESTORED)).toBe(GUARD_RESTORED);
  });
});
