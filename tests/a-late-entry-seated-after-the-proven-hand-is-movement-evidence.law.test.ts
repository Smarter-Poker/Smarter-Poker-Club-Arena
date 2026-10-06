/**
 * A LATE ENTRY SEATED AFTER THE PROVEN HAND IS MOVEMENT EVIDENCE (2026-10-02)
 *
 * 4d2afa41 "Morning Free Buy (NLH)": table a2953558 dealt nothing from 13:05
 * UTC with seven players seated. Its only sealed hand dealt six; the seventh
 * (a497dbb8) late-registered while that hand ran and was seated straight into
 * seat 7, then bought the add-on. Park be7a4f4f's movement admission was
 * refused F06_MOVEMENT_WHOLE_ROSTER_REQUIRED on every re-admission because
 * f06_movement_prior admitted an undealt seat only through a move receipt,
 * and a late entry is never moved.
 *
 * 20261002134551 admits exactly that shape: the player's latest entry funding
 * receipt, recorded no earlier than the chair was taken, whose registration
 * image is playing on exactly this table and seat with exactly the entry
 * grant, with no move since and never dealt here since. This law pins the
 * conditions, that only six passages change, that a proof which does not need
 * an entry is byte-identical to before, and that the migration replaces
 * exactly the body production held.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20261002134551_a_late_entry_seated_after_the_proven_hand_is_movement_eviden.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(MIGRATIONS, '20261001151056_a_table_that_never_dealt_is_moved_from_its_seated_entries.sql'),
  'utf8'
);

const PRE_MD5 = '493026caf75bb03a336db56bac008009';
const PRE_DEF_MD5 = '847ab696563b25d097636b078a54982e';
const POST_MD5 = 'c63825076c08ec077a480a57cc8ae79a';
const POST_DEF_MD5 = 'c2d61153a39a8ccac8f923205124daa7';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, tag: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(');
  expect(start, 'the file defines f06_movement_prior').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const close = sql.indexOf(tag, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

/** The six passages the post-image check restores, read from the file itself. */
function passages(sql: string): [string, string][] {
  const check = sql.slice(sql.indexOf('DO $late_entry_postimage$'));
  const quoted = [...check.matchAll(/\$r\$([\s\S]*?)\$r\$/g)].map((m) => m[1]);
  expect(quoted.length).toBe(12);
  const pairs: [string, string][] = [];
  for (let i = 0; i < quoted.length; i += 2) pairs.push([quoted[i], quoted[i + 1]]);
  return pairs;
}

const NEW_BODY = body(SQL, '$late_entry_prior$');
const OLD_BODY = body(ORIGIN, '$never_dealt_prior$');
const BRANCH = NEW_BODY.slice(
  NEW_BODY.indexOf(' -- No move receipt: a late entry'),
  NEW_BODY.indexOf(
    ' IF NOT FOUND OR seat.user_id IS NULL OR seat.occupancy_id IS NULL OR movement.'
  )
);

describe('a late entry seated after the proven hand is movement evidence', () => {
  it('replaces exactly the body production held and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${PRE_DEF_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
    expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*md5\\(prosrc\\)='${POST_MD5}'`, 'm'));
  });

  it('changes only six passages, and restoring them reproduces the pre-image', () => {
    let restored = NEW_BODY;
    for (const [now, before] of passages(SQL)) {
      expect(NEW_BODY.split(now).length, now).toBe(2);
      restored = restored.replace(now, before);
    }
    expect(restored).toBe(OLD_BODY);
  });

  it('admits an undealt seat with no move receipt only by its own entry receipt', () => {
    expect(BRANCH.length).toBeGreaterThan(0);
    for (const condition of [
      "f.operation IN ('entry','reentry')",
      'ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;',
      'OR fund.observed_at<seat.joined_at',
      "OR fund.registration_snapshot->>'table_id' IS DISTINCT FROM p_table::text",
      "OR fund.registration_snapshot->>'seat_number' IS DISTINCT FROM seat.seat_number::text",
      "OR fund.registration_snapshot->>'status' IS DISTINCT FROM 'playing'",
      "OR fund.registration_snapshot->>'eliminated_at' IS NOT NULL",
      "THEN (fund.tournament_snapshot->>'starting_chips')::numeric",
      'm.tournament_id=p_tournament AND m.user_id=seat.user_id AND m.moved_at>=seat.joined_at',
      'c.table_id=p_table AND c.committed_at>=seat.joined_at',
      "RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'",
    ])
      expect(BRANCH, condition).toContain(condition);
    // The entry's proven stack is its grant at the receipt time, so only a
    // receipted purchase after it is credited, and the seat it names is read
    // back open at exactly the time it sat.
    expect(NEW_BODY).toContain(
      "held:=(item#>>'{entry,chips}')::numeric; since:=(item#>>'{entry,observed_at}')::timestamptz; lim:='infinity';"
    );
    expect(NEW_BODY).toContain(
      "AND user_id=(x->>'user_id')::uuid AND joined_at=(item#>>'{entry,joined_at}')::timestamptz AND left_at IS NULL FOR UPDATE;"
    );
    // Every refusal the function had, it still has (the branch adds one more
    // WHOLE_ROSTER refusal for an entry that is not exactly this shape).
    for (const reason of [
      'F06_MOVEMENT_ORIGINAL_PROOF_MISSING',
      'F06_MOVEMENT_PRIOR_INCOMPLETE',
      'F06_MOVEMENT_SEAT_CHANGED',
      'F06_MOVEMENT_REGISTRATION_CHANGED',
      'F06_MOVEMENT_ROSTER_CHANGED',
      'F06_MOVEMENT_ELIMINATION_UNPROVEN',
    ])
      expect(NEW_BODY.split(reason).length).toBe(OLD_BODY.split(reason).length);
    expect(NEW_BODY.split('F06_MOVEMENT_WHOLE_ROSTER_REQUIRED').length).toBe(
      OLD_BODY.split('F06_MOVEMENT_WHOLE_ROSTER_REQUIRED').length + 1
    );
  });

  it('keeps every proof that needs no entry byte-identical', () => {
    expect(NEW_BODY).toContain(
      "CASE WHEN o.state='park_requested' AND purchases='[]'::jsonb AND arrivals='[]'::jsonb AND entries='[]'::jsonb THEN '{}'::jsonb"
    );
    expect(NEW_BODY).toContain(
      "||CASE WHEN entries='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('entries',entries) END) END;"
    );
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
    // 20261003163015 (a busted chair taken by a late entry) is the one
    // successor, and it refuses to run unless the installed body is exactly
    // this post-image.
    expect(later).toEqual([
      '20261003163015_a_busted_chair_taken_by_a_late_entry_is_movement_evidence.sql',
    ]);
    expect(readFileSync(join(MIGRATIONS, later[0]), 'utf8')).toContain(
      `md5(p.prosrc) = '${POST_MD5}'`
    );
  });
});
