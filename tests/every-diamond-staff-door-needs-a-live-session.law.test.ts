/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - EVERY DIAMOND STAFF DOOR NEEDS A LIVE SESSION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Diamond Phase 11, line 7 ("expired/revoked sessions"). A session revoked
 * elsewhere keeps a token that verifies until it expires, because PostgREST
 * checks the signature and never the session row, so only a door that asks
 * public.fn_caller_session_is_live() can refuse it. Five of the Diamond Staff
 * Desk's writers asked; ten asked only fn_is_platform_admin(), which reads a
 * role and never a session, so a staff session signed out on another device
 * could still open tables, change their rules, settle a Diamond correction and
 * close incidents. Migration 20260930131500 gives the ten the same check at
 * the same place, each in its own refusal style, and nothing else.
 *
 * The migration half of this file pins that edit. The law half reads the Staff
 * Desk's own service files for every door it calls and requires the latest
 * definition of each WRITER in the migration corpus to ask for a live session,
 * so a door added to the desk later cannot arrive without it. The desk's three
 * reads were closed the same day by line 1's migration 20260930120000, built on
 * this one and pinned by its own law.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationCorpus, migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_every_diamond_staff_door_needs_a_live_session.sql'))
  .at(-1);
if (!NAME) throw new Error('the staff-session migration is missing');
const MIG = migrationText(NAME);

const TABLE_DOORS = [
  'fn_poker_diamond_open_cash_table',
  'fn_poker_diamond_set_table_straddle',
  'fn_poker_diamond_set_table_run_it_twice',
  'fn_poker_diamond_set_table_bomb_pot',
];
const ADJUSTMENT_DOORS = [
  'fn_ca_diamond_adjustment_propose',
  'fn_ca_diamond_adjustment_approve',
  'fn_ca_diamond_adjustment_reject',
  'fn_ca_diamond_adjustment_settle',
];
const INCIDENT_DOORS = ['fn_ca_diamond_incident_review', 'fn_ca_diamond_incident_resolve_family'];
const EDITED = [...TABLE_DOORS, ...ADJUSTMENT_DOORS, ...INCIDENT_DOORS];

/** The body of one CREATE of `fn` in `sql`, or '' when there is none. */
function bodies(sql: string, fn: string): string[] {
  const head = new RegExp(
    `CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\([\\s\\S]*?\\bAS (\\$\\w*\\$)`,
    'g'
  );
  const out: string[] = [];
  for (const m of sql.matchAll(head)) {
    const start = (m.index ?? 0) + m[0].length;
    out.push(sql.slice(start, sql.indexOf(m[1], start)));
  }
  return out;
}

/** The latest definition of a function anywhere in the corpus. */
function latestBody(fn: string): string {
  let body = '';
  for (const { sql } of migrationCorpus()) for (const b of bodies(sql, fn)) body = b;
  if (!body) throw new Error(`${fn} has no definition in the corpus`);
  return body;
}

/**
 * The desk's three reads. Line 1's migration 20260930120000 (a forged request
 * is refused) guards them by asserted substitution, so their latest LITERAL
 * body in the corpus predates the check; tests/a-forged-request-is-refused
 * .law.test.ts pins that edit. This law holds every door the desk writes
 * through, whose guard is written out in full.
 */
const READS = new Set([
  'fn_ca_diamond_incident_board',
  'fn_ca_diamond_incident_trail',
  'fn_ca_diamond_staff_books',
]);

const SESSION_CHECK = 'IF NOT public.fn_caller_session_is_live() THEN';
const STAFF_CHECK = 'IF NOT public.fn_is_platform_admin() THEN';

describe('the migration gives ten Diamond staff doors a live-session check, and nothing else', () => {
  it('pins every door to its live text before it touches one', () => {
    const pins = [...MIG.matchAll(/\('public\.(\w+)\([^)]*\)', '([0-9a-f]{32})'\)/g)];
    expect(pins.map((m) => m[1]).sort()).toEqual([...EDITED].sort());
    const pinBlock = MIG.indexOf("RAISE EXCEPTION '% is not the pinned text");
    expect(pinBlock).toBeGreaterThan(0);
    expect(pinBlock).toBeLessThan(MIG.indexOf('CREATE OR REPLACE FUNCTION'));
  });

  it('redefines exactly those ten and creates, grants or opens nothing', () => {
    const created = [...MIG.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/gm)];
    expect(created.map((m) => m[1]).sort()).toEqual([...EDITED].sort());
    expect(MIG).not.toMatch(/^\s*(GRANT|REVOKE)\b/m);
    expect(MIG).not.toMatch(/^\s*CREATE (TABLE|INDEX|TRIGGER|POLICY|VIEW)\b/m);
    expect(MIG).not.toMatch(/UPDATE\s+public\.ca_arena_settings/);
  });

  it('asks for the session once, directly after the staff check, in each door’s own words', () => {
    const expected: Record<string, RegExp> = {};
    for (const fn of TABLE_DOORS)
      expected[fn] =
        /RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE ?= ?'28000';\s*END IF;/;
    for (const fn of ADJUSTMENT_DOORS)
      expected[fn] =
        /RETURN jsonb_build_object\('ok', false, 'refused_reason', 'diamond_staff_session_required'\);\s*END IF;/;
    for (const fn of INCIDENT_DOORS)
      expected[fn] =
        /RETURN jsonb_build_object\('success', false, 'error', 'authentication_required'\);\s*END IF;/;
    for (const fn of EDITED) {
      const [body, ...more] = bodies(MIG, fn);
      expect(more, fn).toEqual([]);
      expect(body.split('fn_caller_session_is_live()').length - 1, fn).toBe(1);
      const staff = body.indexOf(STAFF_CHECK);
      const live = body.indexOf(SESSION_CHECK);
      expect(staff, fn).toBeGreaterThan(0);
      // Nothing but the staff check's own refusal sits between the two.
      const between = body.slice(staff, live);
      expect(between.match(/END IF;/g)?.length, fn).toBe(1);
      expect(body.slice(live, live + 220), fn).toMatch(expected[fn]);
    }
  });

  it('declares one live proof per door and ends by proving the estate unchanged', () => {
    const proofs = [
      ...MIG.matchAll(
        /^-- @live-proof: position\('fn_caller_session_is_live\(\)' in pg_get_functiondef\('public\.(\w+)\(/gm
      ),
    ];
    expect(proofs.map((m) => m[1]).sort()).toEqual([...EDITED].sort());
    const final = sliceBetween(MIG, '-- 4. EVERY EDIT LANDED', 'RAISE NOTICE');
    expect(final).toContain("has_function_privilege('anon', r.sig::regprocedure, 'EXECUTE')");
    expect(final).toContain('tournaments_enabled OR cash_games_enabled');
    expect(final).toContain('fn_ca_diamond_register_vs_supply()');
    expect(final).toContain('fn_ca_guard_watchlist()');
  });
});

describe('LAW: every door the Diamond Staff Desk writes through asks for a live session', () => {
  const services = [
    'src/services/DiamondStaffDeskService.ts',
    'src/services/DiamondAdjustmentService.ts',
    'src/services/DiamondIncidentReviewService.ts',
  ].map((p) => readFileSync(resolve(__dirname, '..', p), 'utf8'));
  const doors = [
    ...new Set(
      services.flatMap((s) =>
        [...s.matchAll(/'(fn_(?:poker_diamond|ca_diamond)_\w+)'/g)].map((m) => m[1])
      )
    ),
  ].sort();

  it('finds the desk’s doors in its own service files', () => {
    expect(doors.length).toBeGreaterThanOrEqual(17);
    for (const fn of EDITED) expect(doors).toContain(fn);
  });

  it.each(doors.filter((fn) => !READS.has(fn)))('%s asks for a live session', (fn) => {
    expect(latestBody(fn)).toContain('public.fn_caller_session_is_live()');
  });
});
