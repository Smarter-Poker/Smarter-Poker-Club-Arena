/**
 * A BYSTANDER SEATED AFTER A FINISHED HAND DOES NOT HOLD ITS SETTLEMENT (2026-09-26)
 *
 * Event 8ec7e81d held a finished, retained hand (table c1ee060b, hand
 * 12976717: +75 / -50 / -25, net 0) that its successor could never commit:
 * fn_ca_resume_hand_submission required the table's live chairs to equal the
 * hand's stack rows, and a late registrant sat down after the hand.
 *
 * Two pull requests fixed that refusal. #5320 (20260926091630) is the one
 * production carries, with its own law
 * (tests/a-retained-hand-commits-past-a-seat-taken-after-its-deal.law.test.ts).
 * #5321's migration 20260926091455 pinned the handoff's older body and could
 * never apply, so it was deleted. What it carried that nothing else did is
 * pinned here, from 20260926131050: the abandoned-generation door reads the
 * event's last dealt hand by when it was PLAYED, so the late commit of an old
 * hand never turns the level clock back.
 *
 * docs/changelog/2026-09-26-a-bystander-seated-after-a-finished-hand-does-not-hold-its-settlement.md
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20260926131050_the_abandoned_generation_door_reads_the_last_hand_by_when_it.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const MISDEAL = readFileSync(
  join(
    MIGRATIONS,
    '20260926075505_a_dead_generation_hand_that_never_reached_a_commit_is_a_misdeal.sql'
  ),
  'utf8'
);

const RESUME_LIVE_MD5 = '828edb105fa8d69f089430d7945f5fb9';
const DOOR_PRE_MD5 = 'f7424f0f1d7df2ad0cf44e99541d7235';
const DOOR_POST_MD5 = 'adeba11b33ec9c234c77d8d26c9e2324';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, `the file defines ${name}`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const DOOR = body(SQL, 'public.fn_f06_abort_abandoned_generation');

const OLD_ORDER = `  SELECT hh.small_blind, hh.big_blind, hh.created_at INTO v_hh
    FROM public.hand_history hh WHERE hh.tournament_id = t
   ORDER BY hh.created_at DESC LIMIT 1;`;
const NEW_ORDER_END =
  'ORDER BY COALESCE(hh.ended_at, hh.created_at) DESC, hh.created_at DESC LIMIT 1;';

function playTimeBlock(b: string): string {
  const a = b.indexOf('  -- PLAY TIME, NOT WRITE TIME (2026-09-26)');
  const z = b.indexOf(NEW_ORDER_END, a);
  return a >= 0 && z > a ? b.slice(a, z + NEW_ORDER_END.length) : '';
}

describe('a late-committed hand does not turn the level clock back', () => {
  it('installs exactly the reviewed door body', () => {
    expect(md5(DOOR)).toBe(DOOR_POST_MD5);
  });

  it('changes the door by the play-time ordering and nothing else', () => {
    const block = playTimeBlock(DOOR);
    expect(block).not.toBe('');
    const reverted = DOOR.replace(block, OLD_ORDER);
    expect(md5(reverted), 'reverting the one edit gives back the production pre-image').toBe(
      DOOR_PRE_MD5
    );
    expect(reverted).toBe(body(MISDEAL, 'public.fn_f06_abort_abandoned_generation'));
    expect(DOOR).not.toContain('ORDER BY hh.created_at DESC LIMIT 1;');
    expect(DOOR).toContain('COALESCE(hh.ended_at, hh.created_at) AS created_at INTO v_hh');
  });

  it('refuses a planted return to write-time ordering', () => {
    const planted = DOOR.replace(playTimeBlock(DOOR), OLD_ORDER);
    expect(playTimeBlock(planted)).toBe('');
    expect(md5(planted)).not.toBe(DOOR_POST_MD5);
  });

  it('leaves the live handoff (#5320) alone and says so', () => {
    expect(SQL).not.toContain('CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission');
    expect(SQL).toContain(`md5(p.prosrc) = '${RESUME_LIVE_MD5}'`);
    expect(
      existsSync(
        join(
          MIGRATIONS,
          '20260926091455_a_bystander_seated_after_a_finished_hand_does_not_hold_its_s.sql'
        )
      ),
      'the superseded migration that can never apply is gone'
    ).toBe(false);
  });

  it('is one guarded transaction with explicit service_role grants', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).not.toMatch(/CONCURRENTLY|VACUUM/);
    for (const m of [DOOR_PRE_MD5, DOOR_POST_MD5]) expect(SQL).toContain(`md5(p.prosrc) = '${m}'`);
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid, uuid, uuid, text, boolean)\n  TO service_role;'
    );
    expect(SQL.indexOf('$pre$')).toBeLessThan(SQL.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(SQL.lastIndexOf('$post$')).toBeGreaterThan(
      SQL.lastIndexOf('CREATE OR REPLACE FUNCTION')
    );
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });
});
