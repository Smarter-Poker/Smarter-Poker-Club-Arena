/**
 * AN ADD-ON BOUGHT AFTER A MOVEMENT PROOF IS NOT A CHANGED ROSTER (2026-10-02)
 *
 * f8c6f298 dealt nothing on table 199a1efc from 04:51 UTC: park 7ef06537's
 * movement proof was taken at 04:57 during the add-on break, and 1c7fc49a
 * then bought the event's add-on (2,500 chips: seat stack 2755 -> 5255,
 * chips 2755 -> 5255, add_on false -> true). f06_assert_movement compared
 * the live roster with the immutable proof and refused
 * F06_MOVEMENT_ROSTER_CHANGED on every begin and every re-admission.
 *
 * 20261002055945 admits exactly the add-on shape and nothing wider. This law
 * pins that the migration replaces exactly the body production held, that
 * only four passages change, that the admitted difference is the event's
 * addon_chips on a registration that bought the add-on, and the release pins.
 *
 * docs/changelog/2026-10-02-an-add-on-bought-after-a-movement-proof-is-not-a-changed-roster.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261002055945_an_add_on_bought_after_a_movement_proof_is_not_a_changed_ros.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(MIGRATIONS, '20261001151056_a_table_that_never_dealt_is_moved_from_its_seated_entries.sql'),
  'utf8'
);

const TAG = '$movement_proof$';
const PRE_MD5 = 'df656e0490a6a8f570f409916fc2f643';
const PRE_DEF_MD5 = '6fd0cf3d598211408d165117fd8c32fe';
const POST_MD5 = 'a0e369a33e735ba728b72228a3134b01';
const POST_DEF_MD5 = 'e3355bb05eecda8aed293f155f1ddfef';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(');
  expect(start, 'the file defines f06_assert_movement').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${TAG}`, start) + `AS ${TAG}`.length;
  const close = sql.indexOf(TAG, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

/** The four passages the post-image check restores, read from the file itself. */
function passages(sql: string): [string, string][] {
  const check = sql.slice(sql.indexOf('DO $addon_assert_postimage$'));
  const quoted = [...check.matchAll(/\$r\$([\s\S]*?)\$r\$/g)].map((m) => m[1]);
  expect(quoted.length).toBe(6);
  return [
    [quoted[0], ''],
    [quoted[1], ''],
    [quoted[2], quoted[3]],
    [quoted[4], quoted[5]],
  ];
}

const NEW_BODY = body(SQL);
const OLD_BODY = body(ORIGIN);

describe('an add-on bought after a movement proof is not a changed roster', () => {
  it('replaces exactly the body production held and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${PRE_DEF_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
    expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*md5\\(prosrc\\)='${POST_MD5}'`, 'm'));
  });

  it('changes only four passages, and restoring them reproduces the pre-image', () => {
    let restored = NEW_BODY;
    for (const [now, before] of passages(SQL)) {
      expect(NEW_BODY.split(now).length, now).toBe(2);
      restored = restored.replace(now, before);
    }
    expect(restored).toBe(OLD_BODY);
  });

  it('admits only the event add-on on a registration that bought it', () => {
    // The live row is credited back by exactly addon_chips, on the seat stack
    // and the registration chips, and only when add_on moved false -> true.
    expect(NEW_BODY).toContain(
      "credited:=CASE WHEN addon>0 AND r#>'{registration,add_on}'='false'::jsonb AND actual#>'{registration,add_on}'='true'::jsonb"
    );
    expect(NEW_BODY).toContain(
      "to_jsonb((actual#>>'{seat,stack}')::numeric-addon)),\n '{registration,chips}',to_jsonb((actual#>>'{registration,chips}')::numeric-addon)),'{registration,add_on}','false'::jsonb) END;"
    );
    expect(NEW_BODY).toContain(
      'SELECT COALESCE(t.addon_chips,0) INTO addon FROM public.tournaments t WHERE t.id=a.tournament_id;'
    );
    // A refusal still follows any other difference, and a missing row
    // (credited NULL) still refuses.
    expect(NEW_BODY).toContain(
      "AND (credited IS NULL OR jsonb_set(credited,'{registration}',(credited->'registration')-strip) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-strip)) THEN\n RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED'"
    );
    // A moved member's receipt may carry the add-on only if the registration bought it.
    expect(NEW_BODY).toContain(
      "AND (winner->>'stack')::numeric=(r#>>'{seat,stack}')::numeric+addon\n AND EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=a.tournament_id AND p.user_id=(r#>>'{seat,user_id}')::uuid AND p.add_on IS TRUE)))"
    );
    for (const reason of [
      'F06_MOVEMENT_CUSTODY_CHANGED',
      'F06_MOVEMENT_BOUNDARY_CHANGED',
      'F06_MOVEMENT_WINNER_CHANGED',
      'F06_MOVEMENT_ELIMINATION_CHANGED',
      'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
    ])
      expect(NEW_BODY.split(reason).length).toBe(OLD_BODY.split(reason).length);
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
    expect(code).not.toMatch(/cron\./i);
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
