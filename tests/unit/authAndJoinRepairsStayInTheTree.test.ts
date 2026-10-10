import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Five repairs were applied to production on 2026-09-01 and every one of them
 * fixed something a real user could feel: the Auth Admin API failing for 295
 * accounts, listUsers failing project-wide, and club joining failing for
 * EVERYONE because fn_join_club_atomic reads a table that never shipped.
 *
 * The join outage existed precisely because a migration lived in the repo and
 * never reached the database. These pins guard the mirror image - a migration
 * that reached the database and could drift back out of the repo - which is
 * the same defect #2200 was about.
 */
const mig = (f: string) => readFileSync(join(__dirname, '../../supabase/migrations', f), 'utf8');

const LIVE = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

describe('the 2026-09-01 auth, join and delete repairs stay in the tree', () => {
  it('keeps the auth token repair, which unbroke 129 human accounts', () => {
    const s = LIVE(mig('20260831_auth_null_tokens_break_the_admin_api.sql'));
    for (const col of [
      'confirmation_token',
      'email_change',
      'email_change_token_new',
      'email_change_token_current',
      'recovery_token',
      'phone_change',
      'phone_change_token',
      'reauthentication_token',
    ]) {
      expect(s, `${col} must be repaired`).toContain(`SET ${col}`);
    }
    expect(s).toContain('POST-APPLY');
  });

  it('keeps the system-row repair that unbroke listUsers', () => {
    const s = LIVE(mig('20260831_the_system_row_breaks_list_users.sql'));
    expect(s).toMatch(/SET instance_id = '00000000-0000-0000-0000-000000000000'::uuid/);
    expect(s).toContain('WHERE instance_id IS NULL');
  });

  /**
   * The load-bearing one. Without this table nobody can join any club.
   */
  it('keeps the rate_limits table fn_join_club_atomic depends on', () => {
    const s = LIVE(mig('20260831_club_join_needs_the_rate_limits_table_that_never_shipped.sql'));
    /* Anchored to the open paren. A plain toContain on the table name also
       matches `public.rate_limits_renamed`, so renaming the table away left
       this pin green - caught by mutation. */
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS public\.rate_limits\s*\(/);
    expect(s).toMatch(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\)/);
    expect(s).toContain('action      text NOT NULL');
    expect(s).toContain('ENABLE ROW LEVEL SECURITY');
  });

  /**
   * The allowlist is an ADDITION. A future edit that swaps Deep Stack Society
   * in for one of the house boards would silently evict a live fleet, so all
   * four uuids are pinned together.
   */
  it('keeps all four boards on the automated-member allowlist', () => {
    const s = LIVE(mig('20260902013000_deep_stack_society_is_a_house_board.sql'));
    /* Scoped to the CHECK's own IN list. The verify block at the foot of the
       migration names all four uuids too, so a whole-file search stayed green
       with a board deleted from the constraint - caught by mutation. */
    const list = s.slice(s.indexOf('OR club_id IN ('), s.indexOf(') NOT VALID'));
    for (const id of [
      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
      'a0000000-0000-0000-0000-000000000001',
      'fade0000-0000-0000-0000-000000000001',
      '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
    ]) {
      expect(list, `${id} must stay allowlisted`).toContain(id);
    }
    // The guard itself must survive: bots stay out of every other user club.
    expect(s).toContain('NOT COALESCE(is_bot, false)');
  });

  it('keeps the delete guard, and only skips the already-gone case', () => {
    const s = LIVE(mig('20260902014000_a_deleted_user_cannot_be_told_its_dashboard_changed.sql'));
    expect(s).toContain('EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_user_id)');
    // A live user's dashboard must still be bumped - the guard is a filter,
    // not a removal of the behaviour.
    expect(s).toContain('INSERT INTO public.daily_challenge_dashboard_revisions');
    expect(s).toContain('revision + 1');
  });
});
