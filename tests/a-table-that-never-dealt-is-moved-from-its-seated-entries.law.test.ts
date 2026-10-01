/**
 * A TABLE THAT NEVER DEALT IS MOVED FROM ITS SEATED ENTRIES (2026-10-01)
 *
 * 21ada05e "Early Bird Freeroll (NLH)" dealt nothing after 06:29 UTC. Its two
 * late registrants sat on c0b95966, a table that never dealt a hand and was
 * the source of park e1f15079. f06_movement_prior proved a park only from the
 * table's last hand_atomic_commits row and raised F06_MOVEMENT_PRIOR_INCOMPLETE
 * when there was none, so the table could never be consolidated.
 *
 * 20261001151056 admits exactly that shape and nothing wider. This law pins
 * the conditions, the proof shape, that every other proof takes the old path
 * byte for byte, and that the migration replaces exactly the bodies
 * production held.
 *
 * docs/changelog/2026-10-01-a-table-that-never-dealt-is-moved-from-its-seated-entries.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261001151056_a_table_that_never_dealt_is_moved_from_its_seated_entries.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const PRIOR_ORIGIN = readFileSync(
  join(
    MIGRATIONS,
    '20260928165716_a_busted_chair_reoccupied_by_a_receipted_arrival_is_movement.sql'
  ),
  'utf8'
);
const ASSERT_ORIGIN = readFileSync(
  join(
    MIGRATIONS,
    '20260928170557_a_bounty_paid_after_a_movement_proof_is_not_a_changed_roster.sql'
  ),
  'utf8'
);

const PRIOR_PRE = '17cd448464cd6e297dc8927890d1a8ff';
const PRIOR_POST = '493026caf75bb03a336db56bac008009';
const ASSERT_PRE = 'bbab37373518b7dcc520ae2bf3e5d1b5';
const ASSERT_POST = 'df656e0490a6a8f570f409916fc2f643';
const ASSERT_POST_DEF = '6fd0cf3d598211408d165117fd8c32fe';
const HELPER_POST = 'c0da72045d9c661631484a4d7c9dc922';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, create: string, tag: string): string {
  const start = sql.indexOf(create);
  expect(start, create).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const close = sql.indexOf(tag, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const PRIOR = body(
  SQL,
  'CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(',
  '$never_dealt_prior$'
);
const ASSERT = body(
  SQL,
  'CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(',
  '$movement_proof$'
);
const HELPER = body(
  SQL,
  'CREATE FUNCTION smarter_private.f06_movement_never_dealt_prior(',
  '$never_dealt_helper$'
);
const OLD_PRIOR = body(
  PRIOR_ORIGIN,
  'CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(',
  '$movement_prior$'
);
const OLD_ASSERT = body(
  ASSERT_ORIGIN,
  'CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(',
  '$movement_proof$'
);

const ROUTE = PRIOR.slice(
  PRIOR.indexOf(' -- A park of a table that never dealt'),
  PRIOR.indexOf(' SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=p_table ORDER BY')
);
const OPEN = ASSERT.slice(
  ASSERT.indexOf(" -- A never-dealt park's proof"),
  ASSERT.indexOf(
    ' IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)\n OR smarter_private.f06_movement_permits('
  )
);
const OLD_BOUNDARY_END =
  "a.proof->'history') THEN\n RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;\n";

describe('a table that never dealt is moved from its seated entries', () => {
  it('replaces exactly the bodies production held and states the ones it installs', () => {
    expect(md5(OLD_PRIOR)).toBe(PRIOR_PRE);
    expect(md5(OLD_ASSERT)).toBe(ASSERT_PRE);
    expect(md5(PRIOR)).toBe(PRIOR_POST);
    expect(md5(ASSERT)).toBe(ASSERT_POST);
    expect(md5(HELPER)).toBe(HELPER_POST);
    for (const digest of [PRIOR_PRE, ASSERT_PRE, PRIOR_POST, ASSERT_POST, HELPER_POST])
      expect(SQL).toContain(`md5(p.prosrc) = '${digest}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${ASSERT_POST_DEF}'`);
  });

  it('changes nothing in f06_movement_prior but the route to the never-dealt proof', () => {
    expect(ROUTE.length).toBeGreaterThan(0);
    expect(md5(PRIOR.replace(ROUTE, ''))).toBe(PRIOR_PRE);
    // Only a park, only a table with no committed hand; a begun break or any
    // table that has a commit takes the old path.
    expect(ROUTE).toContain(
      "IF o.state='park_requested' AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table) THEN"
    );
    expect(ROUTE).toContain(
      'RETURN smarter_private.f06_movement_never_dealt_prior(p_tournament,p_table,o.break_id); END IF;'
    );
    // It sits after the one-open-break check, so that check still governs it.
    expect(PRIOR.indexOf(ROUTE)).toBeGreaterThan(
      PRIOR.indexOf("RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING'")
    );
  });

  it('keeps the old boundary of f06_assert_movement byte for byte as the ELSE', () => {
    expect(OPEN).toMatch(/ ELSE\n$/);
    const restored = ASSERT.replace(OPEN, '').replace(
      `${OLD_BOUNDARY_END} END IF;\n`,
      OLD_BOUNDARY_END
    );
    expect(md5(restored)).toBe(ASSERT_PRE);
    expect(OPEN).toContain("IF a.proof->'first_hand'='true'::jsonb THEN");
    for (const needle of [
      "a.proof->'atomic' IS DISTINCT FROM 'null'::jsonb OR a.proof->'history' IS DISTINCT FROM 'null'::jsonb",
      "a.proof->'permits' IS DISTINCT FROM '[]'::jsonb",
      'f06_lifecycle=a.lifecycle',
      'smarter_private.f06_hand_permits WHERE table_id=a.table_id',
      'public.hand_atomic_commits WHERE table_id=a.table_id)',
      'public.hand_history WHERE table_id=a.table_id)',
      'public.hand_private_state WHERE table_id=a.table_id)',
      'public.table_hole_cards WHERE table_id=a.table_id)',
      'public.hand_state_snapshots WHERE table_id=a.table_id)',
    ])
      expect(OPEN, needle).toContain(needle);
  });

  it('admits a never-dealt park only from exact entries and the whole roster', () => {
    for (const needle of [
      "o.state IS DISTINCT FROM 'park_requested' OR o.manifest IS NOT NULL",
      't.f06_lifecycle=op.lifecycle',
      'EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table)',
      'EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table)',
      'EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table)',
      'EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table)',
      'EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table)',
      'EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table)',
      "registration.status IS DISTINCT FROM 'playing' OR registration.eliminated_at IS NOT NULL",
      '(registration.table_id,registration.seat_number) IS DISTINCT FROM (seat.table_id,seat.seat_number)',
      'registration.chips::numeric IS DISTINCT FROM seat.stack',
      'COALESCE(registration.rebuys,0)<>0 OR COALESCE(registration.add_on,false)',
      "fund.operation IS DISTINCT FROM 'entry'",
      "(fund.tournament_snapshot->>'starting_chips')::numeric IS DISTINCT FROM seat.stack",
      "(fund.registration_snapshot->>'chips')::numeric IS DISTINCT FROM seat.stack",
      '(f.registration_id=registration.id OR f.user_id=registration.user_id))<>1',
      "l.category IN ('rebuy','addon')",
      "status IN ('playing','registered'))<>n",
      "RAISE EXCEPTION 'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'",
      "RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'",
    ])
      expect(HELPER, needle).toContain(needle);
    // The proof is the park shape with no hand, and the roster entries are
    // the {seat, registration} images f06_assert_movement compares.
    expect(HELPER).toContain(
      "jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration))"
    );
    expect(HELPER).toContain(
      "jsonb_build_object('atomic',NULL::jsonb,'history',NULL::jsonb,'roster',roster,'eliminated','[]'::jsonb,'permits',permits,'first_hand',true,"
    );
  });

  it('keeps the release contract pins on the new f06_assert_movement', () => {
    const publisher = readFileSync(
      join(ROOT, 'server/scripts/engine-release-database-proof.py'),
      'utf8'
    );
    expect(publisher).toContain(`'body_md5': '${ASSERT_POST}'`);
    expect(publisher).toContain(`'definition_md5': '${ASSERT_POST_DEF}'`);
    expect(publisher).not.toContain(ASSERT_PRE);
    const fixture = JSON.parse(
      readFileSync(
        join(ROOT, 'tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json'),
        'utf8'
      )
    ) as { functions: { signature: string; body_md5: string; definition_md5: string }[] };
    const pinned = fixture.functions.find(
      (f) => f.signature === 'smarter_private.f06_assert_movement(uuid)'
    );
    expect(pinned?.body_md5).toBe(ASSERT_POST);
    expect(pinned?.definition_md5).toBe(ASSERT_POST_DEF);
    const lane = readFileSync(
      join(ROOT, 'scripts/ci/probes/f06-shared-hand-lane/historical_bank_qualification.py'),
      'utf8'
    );
    expect(lane).toContain(FILE);
    expect(lane).toContain(
      `smarter_private.f06_assert_movement(uuid) ${ASSERT_POST} ${ASSERT_POST_DEF}`
    );
  });

  it('is one transaction that writes no row, keeps the ACLs, and is the newest definition', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    for (const sig of [
      'f06_movement_never_dealt_prior(uuid,uuid,uuid)',
      'f06_movement_prior(uuid,uuid)',
      'f06_assert_movement(uuid)',
    ])
      expect(SQL).toContain(
        `REVOKE ALL ON FUNCTION smarter_private.${sig} FROM PUBLIC, anon, authenticated, service_role;`
      );
    expect(SQL).not.toMatch(/^GRANT /m);
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(public|smarter_private)\.)/i
    );
    expect(code).not.toMatch(/cron\./i);
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) => {
        const text = readFileSync(join(MIGRATIONS, f), 'utf8');
        return (
          text.includes('FUNCTION smarter_private.f06_movement_prior(') ||
          text.includes('FUNCTION smarter_private.f06_assert_movement(') ||
          text.includes('FUNCTION smarter_private.f06_movement_never_dealt_prior(')
        );
      });
    expect(later).toEqual([]);
  });
});
