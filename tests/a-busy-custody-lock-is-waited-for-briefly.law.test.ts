/**
 * A BUSY CUSTODY LOCK IS WAITED FOR, BRIEFLY (2026-09-26)
 *
 * fn_park_stopped_time_bank_custody (#5323) took the tournament's
 * retired-origin lock with a try-lock and answered custody_transfer_busy the
 * instant a sibling held it. Every terminal engine of a tournament asks at the
 * same :53 fan-out, so siblings refused each other (123 busy at 13:53Z), the
 * engine recorded no acknowledgement, and each busy table held the restart
 * certificate shut for the break. Migration 20260926145903 asks again, at most
 * 40 times 25 ms apart, and changes nothing else. These laws pin the bound and
 * that every refusal and the lock-before-read order survive.
 *
 * docs/changelog/2026-09-26-a-fenced-managers-stopped-custody-goes-through-the-process-write.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const FILE = readFileSync(
  join(DIR, '20260926145903_a_busy_custody_lock_is_waited_for_briefly.sql'),
  'utf8'
);
const PRIOR = readFileSync(
  join(DIR, '20260926090846_a_terminal_engines_frozen_time_bank_is_not_manager_authority.sql'),
  'utf8'
);
const APPLIED_MD5 = '329f934a634f3702ab3442baeedaa2dc';

function body(sql: string): string {
  const start = sql.indexOf('FUNCTION public.fn_park_stopped_time_bank_custody(');
  expect(start).toBeGreaterThanOrEqual(0);
  const tag = sql.slice(sql.indexOf('AS $', start) + 3).match(/^\$[a-z_]*\$/)?.[0] ?? '$$';
  const open = sql.indexOf(tag, start) + tag.length;
  return sql.slice(open, sql.indexOf(tag, open));
}
const FN = body(FILE);

describe('a busy custody lock is waited for, briefly', () => {
  it('is the file production applied, in one transaction', () => {
    expect(createHash('md5').update(FILE, 'utf8').digest('hex')).toBe(APPLIED_MD5);
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('asks for the lock at most 40 times, 25 ms apart, then answers busy', () => {
    expect(FN).toContain('PERFORM smarter_private.f06_retired_origin_lock(p_tournament_id);');
    expect(FN).toContain('IF v_attempt >= 40 THEN');
    expect(FN).toContain('PERFORM pg_sleep(0.025);');
    expect(FN.match(/pg_sleep/g)).toHaveLength(1);
    expect(FN).toMatch(/'refused', 'custody_transfer_busy'/);
  });

  it('takes the lock before it reads or writes anything', () => {
    const lock = FN.indexOf('f06_retired_origin_lock(p_tournament_id)');
    expect(lock).toBeGreaterThan(0);
    expect(FN.indexOf('FOR UPDATE')).toBeGreaterThan(lock);
    expect(FN.indexOf('UPDATE public.engine_presence_parked')).toBeGreaterThan(lock);
    expect(FN.indexOf('INSERT INTO public.engine_presence_parked')).toBeGreaterThan(lock);
  });

  it('keeps every refusal and write path of #5323', () => {
    for (const refusal of [
      'STOPPED_CUSTODY_SERVICE_REQUIRED',
      "'table_not_in_tournament'",
      "'mixed_transfer_recorded'",
      "'mixed_custody_adopted'",
      "'existing_park_unreadable'",
      "'newer_park'",
      "'hand_after_custody'",
      "'concurrent_park'",
      'ON CONFLICT (table_id) DO NOTHING',
    ]) {
      expect(FN).toContain(refusal);
      expect(PRIOR).toContain(refusal);
    }
    expect(FN).not.toMatch(/ON CONFLICT \(table_id\) DO UPDATE/);
  });
});
