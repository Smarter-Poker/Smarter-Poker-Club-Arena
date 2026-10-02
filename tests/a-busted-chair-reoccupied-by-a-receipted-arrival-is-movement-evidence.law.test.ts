/**
 * A BUSTED CHAIR REOCCUPIED BY A RECEIPTED ARRIVAL IS MOVEMENT EVIDENCE (2026-09-28)
 *
 * 494355f1 "Midday Free Buy (NLH)" dealt nothing for a day. Its parked table
 * bf3cb28d (begun break fa83dca8) was refused re-admission with
 * F06_MOVEMENT_SEAT_CHANGED on every attempt: in the proven hand 5562bf52
 * busted from seat row 09b96342, and three minutes later c0129701 was moved
 * INTO that same seat row by a committed move receipt. f06_movement_prior
 * looked the bust up by (seat row, busted user), found the row now carrying
 * the arrival, and refused, although every chip was accounted for.
 *
 * 20260928165716 admits exactly that shape and nothing wider. This law pins
 * the conditions, that the reoccupied bust enters neither the roster nor
 * 'eliminated', that a proof which does not need it is byte-identical to
 * before, and that the migration replaces exactly the body production held.
 *
 * docs/changelog/2026-09-28-a-busted-chair-reoccupied-by-a-receipted-arrival-is-movement-evidence.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20260928165716_a_busted_chair_reoccupied_by_a_receipted_arrival_is_movement.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const LATE_ENTRY =
  '20261002134551_a_late_entry_seated_after_the_proven_hand_is_movement_eviden.sql';
const NEVER_DEALT = '20261001151056_a_table_that_never_dealt_is_moved_from_its_seated_entries.sql';
const ORIGIN = readFileSync(
  join(MIGRATIONS, '20260926091645_a_receipted_chip_is_movement_evidence.sql'),
  'utf8'
);

const TAG = '$movement_prior$';
const PRE_MD5 = 'b69098029169b71482e827e9a59ed55b';
const POST_MD5 = '17cd448464cd6e297dc8927890d1a8ff';
const POST_DEF_MD5 = '7131896d73597c72a2e29b802580ef37';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(');
  expect(start, 'the file defines f06_movement_prior').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${TAG}`, start) + `AS ${TAG}`.length;
  const close = sql.indexOf(TAG, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const NEW_BODY = body(SQL);
const OLD_BODY = body(ORIGIN);
const BRANCH = NEW_BODY.slice(
  NEW_BODY.indexOf(' -- Busted in the proven hand, and the same chair row'),
  NEW_BODY.indexOf(
    ' IF NOT FOUND OR seat.stack IS DISTINCT FROM held OR seat.occupancy_id IS NULL THEN'
  )
);

describe('a busted chair reoccupied by a receipted arrival is movement evidence', () => {
  it('replaces exactly the body production held and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
    expect(SQL).toMatch(new RegExp(`^-- @live-proof: .*md5\\(prosrc\\)='${POST_MD5}'`, 'm'));
  });

  it('changes nothing but the three stated passages', () => {
    const restored = NEW_BODY.replace(
      " reoccupied jsonb:='[]'; arrival public.tournament_seat_move_receipts;\n",
      ''
    )
      .replace(BRANCH, '')
      .replace(
        "'moved',moved)\n ||CASE WHEN reoccupied='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('reoccupied',reoccupied) END) END;",
        "'moved',moved)) END;"
      );
    expect(md5(restored)).toBe(PRE_MD5);
  });

  it('admits only a zero-stack bust with no purchase whose chair a receipted arrival took', () => {
    expect(BRANCH).toContain(
      "IF NOT FOUND AND item ? 'hand' AND (x->>'stack')::numeric=0 AND bought=0 THEN"
    );
    for (const needle of [
      'ON m.destination_seat_id=st.id AND m.user_id=st.user_id AND m.moved_at=st.joined_at',
      'st.table_id=p_table AND st.left_at IS NULL AND st.occupancy_id IS NOT NULL',
      "st.user_id IS DISTINCT FROM (x->>'user_id')::uuid AND st.joined_at>a.committed_at",
      'm.tournament_id=p_tournament AND m.destination_table_id=p_table AND m.destination_seat_number=st.seat_number',
      "registration.status='eliminated' AND registration.eliminated_at IS NOT NULL",
      'registration.eliminated_at>=a.committed_at AND registration.eliminated_at<=arrival.moved_at',
      'registration.chips::numeric=0 AND registration.table_id IS NOT DISTINCT FROM p_table',
      'st.user_id=registration.user_id AND st.left_at IS NULL',
    ]) {
      expect(BRANCH, needle).toContain(needle);
    }
    // Anything else on that path is still the old refusal.
    expect(BRANCH).toMatch(
      /END IF;\n RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000';\n END IF;\n$/
    );
  });

  it('keeps a reoccupied bust out of the roster, the eliminated list and the counts', () => {
    const accepted = BRANCH.slice(BRANCH.indexOf('reoccupied:=reoccupied||'));
    const beforeContinue = accepted.slice(0, accepted.indexOf('CONTINUE;'));
    expect(beforeContinue).not.toMatch(/roster:=|eliminated:=|positive:=|remaining:=|users:=/);
    expect(beforeContinue).toContain(
      "jsonb_build_object('accepted',x,'registration',to_jsonb(registration),'arrival',to_jsonb(arrival))"
    );
  });

  it('leaves every proof that does not need it byte-identical', () => {
    expect(NEW_BODY).toContain(
      "||CASE WHEN reoccupied='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('reoccupied',reoccupied) END"
    );
    expect(NEW_BODY).toContain(
      "CASE WHEN o.state='park_requested' AND purchases='[]'::jsonb AND arrivals='[]'::jsonb THEN '{}'::jsonb"
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
    expect(code).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM)\b/i);
    expect(code).not.toMatch(/cron\./i);
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION smarter_private.f06_movement_prior('
        )
      );
    // 20261001151056 (a table that never dealt) is the one successor, and it
    // refuses to run unless the installed body is exactly this post-image.
    expect(later).toEqual([NEVER_DEALT, LATE_ENTRY]);
    expect(readFileSync(join(MIGRATIONS, NEVER_DEALT), 'utf8')).toContain(
      `md5(p.prosrc) = '${POST_MD5}'`
    );
  });
});
