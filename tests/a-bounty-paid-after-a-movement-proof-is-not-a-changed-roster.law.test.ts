/**
 * A BOUNTY PAID AFTER A MOVEMENT PROOF IS NOT A CHANGED ROSTER (2026-09-28)
 *
 * 0733bfe8 "Sunday Funday High Roller PKO" dealt nothing from 07:47 UTC. Its
 * park 60da314a (break 528777f8) carried a movement proof captured at
 * 07:54:43.327; the PKO bounty for the bust in the proven hand was paid 62 ms
 * later, moving four bounty columns on two registrations and no chip on the
 * felt. smarter_private.f06_assert_movement compared whole registration rows,
 * so every successor re-admission was refused F06_MOVEMENT_ROSTER_CHANGED.
 *
 * 20260928170557 compares the roster and elimination registrations without
 * exactly those four columns. This law pins the column list, that nothing
 * else in the assert moved, and that the release contract pins carry the
 * post-image the migration installs.
 *
 * docs/changelog/2026-09-28-a-bounty-paid-after-a-movement-proof-is-not-a-changed-roster.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20260928170557_a_bounty_paid_after_a_movement_proof_is_not_a_changed_roster.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(
    MIGRATIONS,
    '20260926043127_a_column_added_after_a_movement_proof_was_taken_is_not_a_cha.sql'
  ),
  'utf8'
);

const TAG = '$movement_proof$';
const PRE_MD5 = '0cbea76808f835945a63f91f03e7d91c';
const PRE_DEF_MD5 = '611ab479ccb52d5211145e8ffc0ec912';
const POST_MD5 = 'bbab37373518b7dcc520ae2bf3e5d1b5';
const POST_DEF_MD5 = 'ad99e13122447e117d9769d28019cb7f';
const BOUNTY = "'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]";

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(');
  expect(start, 'the file defines f06_assert_movement').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${TAG}`, start) + `AS ${TAG}`.length;
  const close = sql.indexOf(TAG, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const NEW_BODY = body(SQL);
const OLD_BODY = body(ORIGIN);
const compare = (reason: string) =>
  ` IF jsonb_set(actual,'{registration}',(actual->'registration')-${BOUNTY}) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-${BOUNTY}) THEN RAISE EXCEPTION '${reason}' USING ERRCODE='55000'; END IF;`;
const strict = (reason: string) =>
  ` IF actual IS DISTINCT FROM r THEN RAISE EXCEPTION '${reason}' USING ERRCODE='55000'; END IF;`;

describe('a bounty paid after a movement proof is not a changed roster', () => {
  it('replaces exactly the body production held and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(oid)) = '${PRE_DEF_MD5}'`);
    expect(SQL).toContain(`md5(prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(oid)) = '${POST_DEF_MD5}'`);
    expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*md5\\(prosrc\\)='${POST_MD5}'`, 'm'));
  });

  it('changes only the roster and elimination comparisons, and only by the four bounty columns', () => {
    for (const reason of ['F06_MOVEMENT_ROSTER_CHANGED', 'F06_MOVEMENT_ELIMINATION_CHANGED']) {
      expect(NEW_BODY).toContain(compare(reason));
      expect(NEW_BODY).not.toContain(strict(reason));
    }
    const restored = NEW_BODY.replace(
      compare('F06_MOVEMENT_ROSTER_CHANGED'),
      strict('F06_MOVEMENT_ROSTER_CHANGED')
    ).replace(
      compare('F06_MOVEMENT_ELIMINATION_CHANGED'),
      strict('F06_MOVEMENT_ELIMINATION_CHANGED')
    );
    expect(md5(restored)).toBe(PRE_MD5);
    // Chips, status, table and seat are never among the dropped columns.
    for (const kept of [
      'chips',
      'status',
      'table_id',
      'seat_number',
      'eliminated_at',
      'rebuys',
      'add_on',
    ]) {
      expect(BOUNTY).not.toContain(kept);
    }
  });

  it('keeps the release contract pins on the post-image', () => {
    const publisher = readFileSync(
      join(ROOT, 'server/scripts/engine-release-database-proof.py'),
      'utf8'
    );
    const fixture = JSON.parse(
      readFileSync(
        join(ROOT, 'tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json'),
        'utf8'
      )
    ) as { functions: { signature: string; body_md5: string; definition_md5: string }[] };
    const pinned = fixture.functions.find(
      (f) => f.signature === 'smarter_private.f06_assert_movement(uuid)'
    );
    expect(pinned?.body_md5).toBe(POST_MD5);
    expect(pinned?.definition_md5).toBe(POST_DEF_MD5);
    expect(publisher).toContain(`'body_md5': '${POST_MD5}'`);
    expect(publisher).toContain(`'definition_md5': '${POST_DEF_MD5}'`);
    expect(publisher).not.toContain(PRE_MD5);
    const lane = readFileSync(
      join(ROOT, 'scripts/ci/probes/f06-shared-hand-lane/historical_bank_qualification.py'),
      'utf8'
    );
    expect(lane).toContain(FILE);
    expect(lane).toContain(`smarter_private.f06_assert_movement(uuid) ${POST_MD5} ${POST_DEF_MD5}`);
  });

  it('is one transaction that writes no row, keeps the ACL, and is the newest definition', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_assert_movement(uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SQL).not.toMatch(/^GRANT /m);
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i);
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION smarter_private.f06_assert_movement('
        )
      );
    expect(later).toEqual([]);
  });
});
