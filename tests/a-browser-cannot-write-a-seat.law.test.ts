/**
 * LAW - A BROWSER CANNOT WRITE A SEAT
 *
 * table_seats is written only by the engine (service_role). Row level security
 * already refused every browser write, but anon and authenticated held INSERT,
 * UPDATE, DELETE, REFERENCES, TRIGGER and MAINTAIN - one mistaken policy away
 * from a logged-out visitor moving chips between seats. The last browser write
 * (TablePage's time-bank refresh) went in #6164; migration
 * 20261005184400_a_browser_cannot_write_a_seat revokes the privileges, closes
 * club_members to logged-out visitors, and asserts both.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');
const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const SEAT = '20261005184400_a_browser_cannot_write_a_seat.sql';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : /\.(ts|tsx)$/.test(e.name)
        ? [join(dir, e.name)]
        : []
  );
}

describe('LAW: a browser cannot write a seat', () => {
  it('the closing migration exists and asserts its effect', () => {
    expect(files).toContain(SEAT);
    const sql = strip(read(SEAT));
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\s+ON TABLE public\.table_seats FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\s+ON TABLE public\.club_members FROM PUBLIC, anon;/
    );
    expect(sql).toContain('a browser role can still write table_seats');
    expect(sql).toContain('a logged-out visitor can still write club_members');
    expect(sql).not.toMatch(/REVOKE\s+ALL/i);
  });

  it('nothing after the close grants a browser role a write on table_seats', () => {
    const offenders = files
      .filter((f) => f > SEAT)
      .filter((f) =>
        /GRANT\s+[^;]*\b(INSERT|UPDATE|DELETE|ALL)\b[^;]*ON\s+(TABLE\s+)?public\.table_seats\b[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i.test(
          strip(read(f))
        )
      );
    expect(offenders).toEqual([]);
  });

  it('no browser source writes table_seats', { timeout: 30_000 }, () => {
    const writers = walk(join(ROOT, 'src')).filter((f) =>
      /from\(\s*['"]table_seats['"]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/.test(
        readFileSync(f, 'utf8')
      )
    );
    expect(writers, 'the engine owns every seat write').toEqual([]);
  });
});
