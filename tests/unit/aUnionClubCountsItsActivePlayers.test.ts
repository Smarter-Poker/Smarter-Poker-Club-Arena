/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A UNION CLUB'S ACTIVE PLAYERS SIT AT UNION TABLES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-03, binding: "SHARK CLUB & CLUB JAQK AREN'T DISPLAYING THE
 * 'ACTIVE PLAYERS' THIS BUG NEEDS TO BE FIXED." Both club cards read MEMBERS
 * 593 / 584 and ACTIVE 0.
 *
 * Measured against production the same morning:
 *
 *   club          members   t.club_id = club   club OR its union
 *   SHARK CLUB        593                  0                 475
 *   Club JAQK         584                  0                 471
 *   Deep Stack        417                234                 234   (standalone)
 *
 * Both are member clubs of Midway Union, and a union floor's tables are stamped
 * with the UNION's id - that is the whole point of a union: one shared floor
 * every member club's players sit at. fn_batch_club_realtime_active_counts
 * required `t.club_id = requested.club_id`, so for a club inside a union the
 * join could never match and the answer was structurally 0 forever, however
 * busy the floor.
 *
 * The club card was the last reader still counting that way: get_club_home and
 * get_club_players_playing both already resolve the union scope.
 *
 * This pins the SQL, because the defect is a single missing OR arm and nothing
 * about its absence looks wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../../supabase/migrations');

function migration(fragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  if (!file) throw new Error(`no applied migration mirrored for "${fragment}"`);
  return readFileSync(resolve(MIGRATIONS, file), 'utf8');
}

describe('the club card counts a union club floor', () => {
  const sql = migration('a_union_clubs_active_players_sit_at_union_tables');

  it('a member seated on the club OWN tables still counts', () => {
    expect(sql).toMatch(/t\.club_id = requested\.club_id/);
  });

  it('and so does one seated on the union floor the club belongs to', () => {
    expect(sql).toMatch(/cl\.union_id IS NOT NULL AND t\.union_id = cl\.union_id/);
  });

  it('the union is read from the club row, never from a parameter', () => {
    // A caller-supplied union id is a caller-supplied answer.
    expect(sql).toMatch(/LEFT JOIN public\.clubs cl ON cl\.id = requested\.club_id/);
  });

  it('a standalone club is untouched: NULL union_id can never widen the join', () => {
    // The guard is the IS NOT NULL, and without it the second arm would be
    // NULL rather than false - which is not the same thing in a join.
    const arm = sql.slice(sql.indexOf('OR ('), sql.indexOf('OR (') + 120);
    expect(arm).toContain('cl.union_id IS NOT NULL');
  });

  it('a finished table is still excluded, on both arms', () => {
    expect(sql).toMatch(
      /lower\(COALESCE\(t\.status, ''\)\) NOT IN \('closed','completed','cancelled','finished'\)/
    );
  });

  it('an away or departed seat is still not an active player', () => {
    expect(sql).toMatch(/ts\.left_at IS NULL AND COALESCE\(ts\.is_away, false\) = false/);
  });

  it('the function keeps its shape: STABLE, definer, same signature', () => {
    expect(sql).toMatch(/fn_batch_club_realtime_active_counts\(p_club_ids uuid\[\]\)/);
    expect(sql).toMatch(/RETURNS TABLE\(club_id uuid, active_count bigint\)/);
    expect(sql).toMatch(/STABLE SECURITY DEFINER/);
  });

  it('and it states who may call it, PUBLIC named alongside the roles', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION [\s\S]{0,120}FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION [\s\S]{0,120}TO authenticated, service_role;/);
  });
});
