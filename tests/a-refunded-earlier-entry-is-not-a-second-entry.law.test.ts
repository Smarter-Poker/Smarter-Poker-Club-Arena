/**
 * AN EARLIER REFUNDED ENTRY IS NOT A SECOND ENTRY (2026-10-24)
 *
 * Happy Hour Bounty Table 20 was parked before it dealt with one late entrant
 * seated. Its never-dealt proof counted the player's funding receipts in the
 * event by registration OR user and required exactly one. An earlier
 * pre-start registration, since refunded and gone, left a second receipt, so
 * every re-admission refused with F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN and
 * the player could neither play, move nor bust.
 *
 * 20261024232734 keeps the count at exactly one receipt for THIS
 * registration, and admits any other receipt of the player only as a whole
 * earlier chip entry whose registration no longer exists and whose buy-in
 * the posted refund legs returned in full. Anything else still refuses.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const FILE = '20261024232734_a_refunded_earlier_entry_is_not_a_second_entry.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const CODE = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('an earlier refunded entry is not a second entry', () => {
  it('edits the installed never-dealt proof only from its exact pre-image', () => {
    expect(SQL).toContain(
      "'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure"
    );
    // The pre-image is 20261021172832's post-image.
    expect(SQL).toContain("IF md5(v_src) <> '1952ea35ef547fd1102a4eca7ae1427e' THEN");
    expect(
      readFileSync(
        join(MIGRATIONS, '20261021172832_never_dealt_arrivals_keep_their_committed_move.sql'),
        'utf8'
      )
    ).toContain("md5(pg_get_functiondef(p.oid))='1952ea35ef547fd1102a4eca7ae1427e'");
    // One anchor, found exactly once, and the proved post-image asserted
    // before and after the install.
    expect(SQL).toContain(
      "AND (f.registration_id=registration.id OR f.user_id=registration.user_id))<>1' || chr(10);"
    );
    expect(SQL).toMatch(/IF v_n <> 1 THEN RAISE EXCEPTION 'F06_REFUNDED_ENTRY_ANCHOR/);
    expect(SQL).toContain("IF md5(v_src) <> '631844035961b4995aab130e8e53e6b6' THEN");
    expect(SQL).toContain("<> 'e0677c7a9a3e1bbed2cd00026caee54a'");
    expect(SQL).toContain(
      "-- @live-proof: (SELECT md5(prosrc)='e0677c7a9a3e1bbed2cd00026caee54a' AND md5(pg_get_functiondef(oid))='631844035961b4995aab130e8e53e6b6' AND proacl::text='{postgres=X/postgres}'"
    );
  });

  it('still requires exactly one receipt for this registration', () => {
    expect(SQL).toContain("' AND f.registration_id=registration.id)<>1' || chr(10)");
  });

  it('admits another receipt only as a refunded whole chip entry of a vanished registration', () => {
    for (const clause of [
      "f.operation IS DISTINCT FROM ''entry''",
      "f.asset IS DISTINCT FROM ''chips''",
      'f.amount IS NULL OR f.amount<=0',
      'f.observed_at>=fund.observed_at',
      'f.registration_id IS NULL',
      'EXISTS(SELECT 1 FROM public.tournament_players q WHERE q.id=f.registration_id)',
      "l.category=''refund'' AND l.status=''posted'' AND l.from_entity_id=p_tournament AND l.to_entity_id=registration.user_id",
      'l.created_at<fund.observed_at',
    ]) {
      expect(SQL).toContain(clause);
    }
    // The refund must return exactly what those entries paid.
    expect(SQL).toMatch(
      /registration_id IS DISTINCT FROM registration\.id\),0\)' \|\| chr\(10\)\s*\|\| ' IS DISTINCT FROM COALESCE\(\(SELECT sum\(l\.amount\)/
    );
  });

  it('is one transaction that writes nothing and schedules nothing', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toMatch(/SET LOCAL lock_timeout = '2s';/);
    expect(CODE).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(public|smarter_private)\.)/i
    );
    expect(CODE).not.toMatch(/cron\./i);
    expect(CODE).not.toMatch(/^GRANT |^REVOKE /m);
    // Owner, ACL, SECURITY DEFINER and search_path are asserted unchanged.
    for (const k of ['v_acl', 'v_owner', 'v_secdef', 'v_config'])
      expect(CODE).toContain(`IS DISTINCT FROM ${k}`);
  });

  it('is redefined only by the one successor that starts from its post-image', () => {
    const later = readdirSync(MIGRATIONS).filter(
      (f) =>
        f.endsWith('.sql') &&
        f > FILE &&
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION smarter_private.f06_movement_never_dealt_prior('
        )
    );
    expect(later).toEqual([
      '20261025030421_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql',
      '20261025082356_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql',
    ]);
    const next = readFileSync(join(MIGRATIONS, later[0]), 'utf8');
    expect(next).toContain("IF md5(v_pre) <> '631844035961b4995aab130e8e53e6b6'");
    expect(next).toContain("<> 'e0677c7a9a3e1bbed2cd00026caee54a'");
  });
});
