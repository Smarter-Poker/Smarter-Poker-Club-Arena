/**
 * LAW: UNION DATA'S WINDOW READER IS PLANNED WITH ITS VALUES (2026-10-23).
 *
 * Migration 20261023032335. As a LANGUAGE sql function, fn_ca_rake_windows_v3
 * was planned with its arguments unknown and joined every MTT ever run to the
 * window one index probe at a time: 4.9 s of Union Data's 7 s month view,
 * against the 8 s browser statement timeout. The same statement run through
 * EXECUTE ... USING is planned for the window it reads (4.49 s -> 2.38 s for
 * the Midway month, identical jsonb on every closed window measured).
 *
 * This pins that the statement is the 20261022165130 text with only its
 * arguments renamed, that it still runs through EXECUTE with its values, and
 * that no client gained access to the internal reader.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8');
const NEW = read('20261023032335_rake_windows_plan_with_their_actual_values.sql');
const OLD = read('20261022165130_club_data_and_union_data_read_each_window_once.sql');

const between = (s: string, start: string, end: string): string => {
  const a = s.indexOf(start);
  expect(a, start).toBeGreaterThan(-1);
  const b = s.indexOf(end, a + start.length);
  expect(b, end).toBeGreaterThan(-1);
  return s.slice(a + start.length, b);
};

describe("Union Data's window reader is planned with its values", () => {
  it('is one guarded transaction that changes no table, index or trigger', () => {
    expect(NEW.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(NEW.trim().endsWith('COMMIT;')).toBe(true);
    expect(NEW).toMatch(/SET LOCAL lock_timeout = '3s';/);
    expect(NEW).toContain("IS DISTINCT FROM '88eb254e0a975b87182904562a7e63f1'");
    expect(NEW).not.toMatch(/CREATE (UNIQUE )?INDEX|CREATE TABLE|CREATE TRIGGER|ALTER TABLE|LOCK TABLE/);
  });

  it('runs the 20261022165130 statement unchanged but for $1..$4, through EXECUTE ... USING', () => {
    const fnAt = OLD.indexOf('CREATE FUNCTION public.fn_ca_rake_windows_v3(');
    const open = OLD.indexOf('$function$', fnAt) + '$function$'.length;
    const original = OLD.slice(open, OLD.indexOf('$function$', open));
    const renamed = original
      .replaceAll('p_per_club', '$4')
      .replaceAll('p_clubs', '$1')
      .replaceAll('p_start', '$2')
      .replaceAll('p_end', '$3');
    expect(between(NEW, 'EXECUTE $windows$', '$windows$')).toBe(renamed);
    expect(NEW).toMatch(/USING p_clubs, p_start, p_end, p_per_club;/);
    expect(NEW).toMatch(/LANGUAGE plpgsql\s+STABLE SECURITY DEFINER\s+SET search_path TO 'public'\s+SET work_mem TO '256MB'/);
  });

  it('keeps the internal reader closed to every client role', () => {
    expect(NEW).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_rake_windows_v3(uuid[],date,date,boolean) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(NEW).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.fn_ca_rake_windows_v3/);
    expect(NEW).not.toMatch(/is_horse/);
  });
});
