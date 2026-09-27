/**
 * A NEVER-STARTED DEAD HAND LEAVES ITS OWN PRE-MANIFEST PARK TO THE SUCCESSOR (2026-09-27)
 *
 * Event 41eb379e: the dead generation 4e797b51 asked to break its only table
 * (break 62269022, park_requested, nothing moved) and then reserved hand
 * 14656452, which it never dealt. The abandoned-generation door refused
 * F06_ABANDONED_PARK_CHANGED at every ask, because a park of the dead
 * generation's own origin could only be withdrawn against a hand receipt
 * with a snapshot. The door now leaves that park exactly as it leaves a
 * foreign one, only when the hand never started.
 *
 * docs/changelog/2026-09-27-stranded-f06-doors.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const SQL = readFileSync(
  join(
    MIGRATIONS,
    '20260927145416_a_never_started_dead_hand_leaves_its_own_premanifest_park_to.sql'
  ),
  'utf8'
);
const PRIOR = readFileSync(
  join(
    MIGRATIONS,
    '20260926131050_the_abandoned_generation_door_reads_the_last_hand_by_when_it.sql'
  ),
  'utf8'
);

const DOOR_PRE_MD5 = 'adeba11b33ec9c234c77d8d26c9e2324';
const DOOR_POST_MD5 = '79b411db1991b00e04e6cfce647843a0';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_f06_abort_abandoned_generation(');
  expect(start, 'the file defines the door').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const DOOR = body(SQL);
const NEW_GATE = '      IF (o.origin_generation IS DISTINCT FROM g OR (n = 0 AND NOT v_misdeal))\n';
const OLD_GATE = '      IF o.origin_generation IS DISTINCT FROM g\n';

describe('a never-started dead hand leaves its own pre-manifest park to the successor', () => {
  it('installs exactly the reviewed door body over the production pre-image', () => {
    expect(md5(body(PRIOR))).toBe(DOOR_PRE_MD5);
    expect(md5(DOOR)).toBe(DOOR_POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${DOOR_PRE_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${DOOR_POST_MD5}'`);
  });

  it('changes only the foreign-park gate, and only for a hand that never started', () => {
    expect(DOOR.split(NEW_GATE)).toHaveLength(2);
    const a = DOOR.indexOf('      -- ITS OWN PARK OVER A HAND THAT NEVER STARTED (2026-09-27).');
    const z = DOOR.indexOf(NEW_GATE) + NEW_GATE.length;
    expect(a).toBeGreaterThan(0);
    const reverted = DOOR.slice(0, a) + OLD_GATE + DOOR.slice(z);
    expect(md5(reverted), 'reverting the one edit gives back the production pre-image').toBe(
      DOOR_PRE_MD5
    );
  });

  it('still refuses its own park over a hand that started, and moves no money', () => {
    // The withdrawal gate is unchanged: a started or misdealt hand's own park
    // is only ever withdrawn against its snapshot receipt.
    expect(DOOR).toContain('IF v_break IS NOT NULL OR n = 0 OR v_misdeal');
    expect(DOOR).toContain("RAISE EXCEPTION 'F06_ABANDONED_PARK_CHANGED'");
    // A park left for the successor is untouched and reported.
    expect(DOOR).toContain('v_foreign_parks := v_foreign_parks || o.break_id;');
    expect(DOOR).toContain("'credit', 0);");
    expect(DOOR).not.toMatch(/UPDATE public\.(table_seats|tournament_players)\b/);
    expect(DOOR).not.toMatch(/INSERT INTO public\.(chip_ledger|wallet_transactions)\b/);
  });

  it('keeps the door service_role only', () => {
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_f06_abort_abandoned_generation[^;]*FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_f06_abort_abandoned_generation[^;]*TO service_role;/
    );
  });
});
