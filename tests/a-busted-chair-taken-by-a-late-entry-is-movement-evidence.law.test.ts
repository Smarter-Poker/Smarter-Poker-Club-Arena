/**
 * A BUSTED CHAIR TAKEN BY A LATE ENTRY IS MOVEMENT EVIDENCE (2026-10-03)
 *
 * 64c9e949 "Morning Free Buy (NLH)": table 77b326dc dealt nothing from 13:50
 * UTC with nine players seated. Its sealed hand busted 8b3b6f26 from seat 5;
 * 39 s later 47965354 late-registered and was seated straight into that same
 * chair row, then bought the add-on. 20261002134551 admits 47965354 as an
 * entry, but the busted player's hand item then found its chair taken, and the
 * reoccupied-chair branch accepted only a MOVE receipt as the taker, so park
 * b3677b93's admission refused F06_MOVEMENT_SEAT_CHANGED on every
 * re-admission (MttPlayStopped, 2026-10-03 16:18).
 *
 * 20261003163015 lets that branch accept, as the taker, the late entry the
 * arrival loop already admitted into exactly that chair row. This law pins
 * the conditions, that only two passages change, that the arrival path and
 * every refusal are unchanged, and that the migration replaces exactly the
 * body production held.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20261003163015_a_busted_chair_taken_by_a_late_entry_is_movement_evidence.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(
    MIGRATIONS,
    '20261002134551_a_late_entry_seated_after_the_proven_hand_is_movement_eviden.sql'
  ),
  'utf8'
);

const PRE_MD5 = 'c63825076c08ec077a480a57cc8ae79a';
const PRE_DEF_MD5 = 'c2d61153a39a8ccac8f923205124daa7';
const POST_MD5 = '862440fc437b25c7c10b96f9ed603283';
const POST_DEF_MD5 = '458a9e5135824e03d4188e43bc7c9c84';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, tag: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(');
  expect(start, 'the file defines f06_movement_prior').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const close = sql.indexOf(tag, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

/** The passages the post-image check restores, read from the file itself. */
function passages(sql: string): [string, string][] {
  const check = sql.slice(sql.indexOf('DO $busted_entry_postimage$'));
  const quoted = [...check.matchAll(/\$r\$([\s\S]*?)\$r\$/g)].map((m) => m[1]);
  expect(quoted.length).toBe(4);
  const pairs: [string, string][] = [];
  for (let i = 0; i < quoted.length; i += 2) pairs.push([quoted[i], quoted[i + 1]]);
  return pairs;
}

const NEW_BODY = body(SQL, '$busted_entry_prior$');
const OLD_BODY = body(ORIGIN, '$late_entry_prior$');
const BRANCH = NEW_BODY.slice(
  NEW_BODY.indexOf(' arrival:=NULL; taken:=NULL;'),
  NEW_BODY.indexOf(" RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000';\n END IF;")
);

describe('a busted chair taken by a late entry is movement evidence', () => {
  it('replaces exactly the body production held and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${PRE_DEF_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
    expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*md5\\(prosrc\\)='${POST_MD5}'`, 'm'));
  });

  it('changes only two passages, and restoring them reproduces the pre-image', () => {
    let restored = NEW_BODY;
    for (const [now, before] of passages(SQL)) {
      expect(NEW_BODY.split(now).length, now).toBe(2);
      restored = restored.replace(now, before);
    }
    expect(restored).toBe(OLD_BODY);
  });

  it('accepts as the taker only the entry already admitted into exactly that chair row', () => {
    expect(BRANCH.length).toBeGreaterThan(0);
    for (const condition of [
      // the arrival path is unchanged and still tried first
      'AND m.tournament_id=p_tournament AND m.destination_table_id=p_table AND m.destination_seat_number=st.seat_number;',
      'IF arrival.request_id IS NULL THEN',
      // the entry is one the arrival loop admitted on its own funding receipt
      "FROM jsonb_array_elements(items) e JOIN public.table_seats st ON st.id=(e.value#>>'{entry,seat_id}')::uuid",
      "WHERE e.value ? 'entry' AND st.id=(x->>'seat_id')::uuid AND st.table_id=p_table AND st.left_at IS NULL AND st.occupancy_id IS NOT NULL",
      "AND st.user_id=(e.value#>>'{entry,user_id}')::uuid AND st.user_id IS DISTINCT FROM (x->>'user_id')::uuid",
      "AND st.joined_at=(e.value#>>'{entry,joined_at}')::timestamptz AND st.joined_at>a.committed_at;",
      // the busted registration is proven exactly as before
      "AND registration.status='eliminated' AND registration.eliminated_at IS NOT NULL",
      "AND registration.eliminated_at>=a.committed_at AND registration.eliminated_at<=COALESCE(arrival.moved_at,(taken->>'joined_at')::timestamptz)",
      'AND registration.chips::numeric=0 AND registration.table_id IS NOT DISTINCT FROM p_table',
      'WHERE t.tournament_id=p_tournament AND st.user_id=registration.user_id AND st.left_at IS NULL) THEN',
      "ELSE jsonb_build_object('entry',taken) END);",
    ])
      expect(BRANCH, condition).toContain(condition);
    // The entry loop runs before the hand items are proven, so the entry the
    // branch reads was already held to its own funding-receipt conditions.
    expect(
      NEW_BODY.indexOf("items:=items||jsonb_build_array(jsonb_build_object('entry'")
    ).toBeLessThan(NEW_BODY.indexOf(' arrival:=NULL; taken:=NULL;'));
    for (const reason of [
      'F06_MOVEMENT_ORIGINAL_PROOF_MISSING',
      'F06_MOVEMENT_PRIOR_INCOMPLETE',
      'F06_MOVEMENT_SEAT_CHANGED',
      'F06_MOVEMENT_REGISTRATION_CHANGED',
      'F06_MOVEMENT_ROSTER_CHANGED',
      'F06_MOVEMENT_ELIMINATION_UNPROVEN',
      'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED',
    ])
      expect(NEW_BODY.split(reason).length, reason).toBe(OLD_BODY.split(reason).length);
  });

  it('is one transaction that writes no row, keeps the ACL, and is the newest definition', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;'
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
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION smarter_private.f06_movement_prior('
        )
      );
    expect(later).toEqual([]);
  });
});
