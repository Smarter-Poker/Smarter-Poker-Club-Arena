/**
 * A SESSION CANNOT OUTLIVE ITS SEAT (2026-09-10).
 *
 * cash_player_session carries a player's stay clock for one table. Three
 * defects in one night, all the same shape - a derived row diverging from the
 * authoritative one:
 *
 *   1. Table teardown closed the seats and left the sessions open. 40 open
 *      sessions for players holding no seat; 657 opened vs 497 closed in six
 *      hours. Fixed by a trigger on tables: status -> closed closes them.
 *   2. A seat move re-pointed a live session onto a destination that already
 *      held a leftover, violating cash_player_session_one_open and killing the
 *      whole post-hand leave_pending step. Fixed by closing the leftover as
 *      superseded_by_move immediately before the re-point, both swap re-points
 *      included.
 *   3. (The underlying source of 2 is 1.)
 *
 * These pin the properties: the trigger exists and fires on the transition
 * into closed/deleted; every re-point is preceded by its guard; and the
 * migrations refuse to finish unless they can prove it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationNamed = (slug: string): string => {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const CLOSE = migrationNamed('a_closed_table_closes_its_sessions');
const REPOINT = migrationNamed('a_re_point_is_not_allowed_to_collide');

describe('a closed table closes its sessions', () => {
  it('installs an AFTER UPDATE trigger on tables for status and is_deleted', () => {
    expect(CLOSE).toContain('CREATE TRIGGER zz_close_sessions_when_table_closes');
    expect(CLOSE).toContain('AFTER UPDATE OF status, is_deleted ON public.tables');
  });

  it('fires only on the transition INTO closed or deleted', () => {
    expect(CLOSE).toContain("NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed'");
    expect(CLOSE).toContain(
      'COALESCE(NEW.is_deleted,false) AND NOT COALESCE(OLD.is_deleted,false)'
    );
  });

  it('closes every open session scoped to that table, with a reason that is not a leave', () => {
    expect(CLOSE).toContain("closed_reason = 'table_closed'");
    expect(CLOSE).toContain("scope_type = 'table' AND scope_id = NEW.id AND closed_at IS NULL");
    // A player whose game ended under them did not LEAVE and must not be barred.
    expect(CLOSE).not.toContain('fn_cash_session_close(');
  });

  it('gives the trigger a scope-led index over the open set', () => {
    expect(CLOSE).toContain('cash_player_session_open_by_scope');
    expect(CLOSE).toContain('(scope_id) WHERE closed_at IS NULL');
  });

  it('refuses to finish while any session is still open with no seat', () => {
    expect(CLOSE).toContain('still open with no seat. Nothing written.');
    expect(CLOSE).toContain('the trigger is not installed. Nothing written.');
  });
});

describe('a re-point is not allowed to collide', () => {
  it('closes a leftover on the destination before the move re-points', () => {
    expect(REPOINT).toContain("closed_reason = ''superseded_by_move''");
    expect(REPOINT).toContain('scope_id = dst.id AND closed_at IS NULL');
  });

  it('guards BOTH re-points in a swap, and the migration counts them', () => {
    expect(REPOINT).toContain("closed_reason = ''superseded_by_swap''");
    expect(REPOINT).toContain("/length('superseded_by_swap') <> 2");
  });

  it('does not touch fn_cash_session_open, which already carries ON CONFLICT', () => {
    expect(REPOINT).not.toContain("proname='fn_cash_session_open'");
  });
});
