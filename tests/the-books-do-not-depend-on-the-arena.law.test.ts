/**
 * THE DIAMOND BOOKS DO NOT DEPEND ON THE ARENA EXISTING.
 *
 * The Diamond Arena is rebuilt from scratch periodically - it was on 2026-09-08 -
 * and an honest teardown drops every arena object. Three core accounting
 * surfaces used to call `fn_ca_arena_diamonds()` directly:
 *
 *   fn_ca_diamond_trial_balance   proves every diamond is accounted for
 *   fn_ca_diamond_snapshot        the hourly deploy gate
 *   fn_ca_diamond_economy         the economy report
 *
 * so dropping one arena function would have taken the platform's accounting with
 * it, and the deploy gate's first symptom would have been silence.
 *
 * They read `fn_ca_diamond_offledger_float()` now, which the accounting side
 * owns, and which keeps two answers apart:
 *
 *   - NO ARENA EXISTS        -> 0, and 0 is the truth.
 *   - AN ARENA CANNOT BE READ -> RAISE. Never 0. A float that cannot be measured
 *     is not a float of zero, and reporting it as one publishes a wrong balance
 *     that looks right (CLAUDE.md 10.86).
 *
 * The probe that shipped with this dropped the arena functions and the settings
 * table and watched the books keep balancing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('the books do not depend on the arena', () => {
  const sql = read('the_books_survive_the_arena');
  const body = code(sql);

  it('gives the accounting side its own float reader', () => {
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_diamond_offledger_float');
  });

  it('returns zero only when there is genuinely no arena', () => {
    expect(body).toContain("IF to_regprocedure('public.fn_ca_arena_diamonds()') IS NULL THEN");
    expect(body).toContain('RETURN 0;');
  });

  it('raises rather than reporting zero when an arena cannot be read', () => {
    expect(body).toContain('RAISE EXCEPTION');
    expect(sql).toContain('will not publish a balance they could not compute');
  });

  it('repoints all three accounting surfaces', () => {
    for (const fn of [
      'fn_ca_diamond_trial_balance',
      'fn_ca_diamond_snapshot',
      'fn_ca_diamond_economy',
    ]) {
      expect(body).toContain(fn);
    }
    expect(body).toContain('accounting surface(s) still call the arena directly');
    expect(body).toContain('of 3 accounting surfaces read the float through the books own reader');
  });

  it('asserts the books still balance through the new path', () => {
    expect(body).toContain('the register identity is off by % after repointing');
    expect(body).toContain('players + float <> register');
  });

  it('creates, alters and drops no arena object', () => {
    // the rebuild owns every one of those; this migration must not race it
    expect(body).not.toMatch(/DROP\s+(FUNCTION|TABLE)\s+[^;]*arena/i);
    expect(body).not.toMatch(/CREATE\s+TABLE[^;]*arena/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.ca_arena_settings/i);
  });

  it('states the contract the new arena plugs into', () => {
    expect(sql).toContain('public.fn_ca_arena_diamonds()');
    expect(sql).toContain('THE CONTRACT');
  });
});
