/**
 * A DECLARED GUARD CHANGE IS RECORDED, NOT RAISED (2026-09-10).
 *
 * `fn_ca_guard_defs_watch` compares each of the 28 functions on
 * `fn_ca_guard_watchlist()` against a stored baseline and raises an INFO notice
 * when they differ. Its own text ends "Then resolve this notice - it does not
 * close itself."
 *
 * So every deliberate, reviewed, applied migration that redefines a watched
 * guard puts an item on the drift board that a human has to clear by hand. At
 * 13:28 one did; at 14:25 the board carried it. That is our own maintenance
 * setting off an alarm - the third instance of that shape in one day.
 *
 * THE RULE, which is the registry pattern the platform already uses for
 * maintenance kinds: a DECLARED change is recorded, an UNDECLARED one is
 * raised. A migration that redefines a watched guard calls
 * `fn_ca_declare_guard_redefinition('<guard>', 'migration <name>')` in the SAME
 * transaction; the baseline moves with the definition and the watcher has
 * nothing to report.
 *
 * THE WATCHER IS NOT WEAKENED, and this file exists to keep it that way. It is
 * not muted, not narrowed, and its severity is untouched. A guard redefined by
 * anything that did not declare itself - a hand edit on the box, an unreviewed
 * CREATE OR REPLACE, a rollback that silently restores old text - still moves
 * the hash away from the baseline and still raises.
 *
 * docs/changelog/2026-09-10-a-declared-guard-change-is-recorded-not-raised.md
 */
import { describe, it, expect } from 'vitest';
import { migrationCorpus, migrationsMentioning } from './helpers/migrationCorpus';

/** The migration that introduced the declaration. Migrations before it are history. */
const LAW = '20260910143032_a_declared_guard_change_is_recorded_not_raised.sql';
const DECLARE = 'fn_ca_declare_guard_redefinition';

/**
 * The watchlist is not hard-coded here. It is read from the newest migration
 * that defines `fn_ca_guard_watchlist`, so adding a guard to the watchlist
 * automatically extends this law rather than quietly leaving the new guard out.
 */
const watchlist = (): string[] => {
  const defs = migrationsMentioning('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist').sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const newest = defs[defs.length - 1];
  expect(newest, 'some migration must define fn_ca_guard_watchlist').toBeDefined();
  const start = newest!.sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist');
  const body = newest!.sql.slice(start, newest!.sql.indexOf('$function$;', start));
  const names = [...body.matchAll(/'(fn_[a-z0-9_]+)'/g)].map((m) => m[1]);
  expect(names.length, 'the watchlist should parse to a non-trivial set of guards').toBeGreaterThan(
    10
  );
  return [...new Set(names)];
};

/** Does this migration text redefine `guard`? */
const redefines = (sql: string, guard: string): boolean =>
  sql.includes(`CREATE OR REPLACE FUNCTION public.${guard}(`) ||
  sql.includes(`CREATE OR REPLACE FUNCTION public.${guard}\n`) ||
  // the asserted-substitution shape: read the live definition, replace, EXECUTE
  (sql.includes('pg_get_functiondef') &&
    sql.includes('EXECUTE') &&
    sql.includes(`p.proname = '${guard}'`));

describe('a declared guard change is recorded, not raised', () => {
  it('a migration that redefines a watched guard declares it in the same transaction', () => {
    const guards = watchlist();
    const offenders: string[] = [];
    for (const m of migrationCorpus()) {
      if (m.name < LAW) continue; // history: the declaration did not exist yet
      if (m.sql.includes(DECLARE)) continue;
      for (const g of guards) {
        if (redefines(m.sql, g)) offenders.push(`${m.name} redefines ${g}`);
      }
    }
    expect(
      offenders,
      [
        'These migrations redefine a guard on fn_ca_guard_watchlist() without',
        'declaring it, so fn_ca_guard_defs_watch will open an INFO notice that',
        'a human has to close by hand. Add, in the same transaction:',
        `  PERFORM public.${DECLARE}('<guard>', 'migration <this migration>');`,
        offenders.join('\n'),
      ].join('\n')
    ).toEqual([]);
  });

  it('the declaration refuses an unnamed change and a guard nobody watches', () => {
    const law = migrationCorpus().find((m) => m.name === LAW);
    expect(law, `${LAW} must exist`).toBeDefined();
    expect(law!.sql).toContain('a guard redefinition must name the migration that made it');
    expect(law!.sql).toContain('which is not on the guard watchlist');
    expect(law!.sql).toContain('a declaration cannot baseline an absent guard');
  });

  it('the watcher itself is not touched, muted or narrowed', () => {
    const law = migrationCorpus().find((m) => m.name === LAW)!;
    expect(law.sql).not.toContain('CREATE OR REPLACE FUNCTION public.fn_ca_guard_defs_watch');
    // and the migration says so in as many words, because the next reader will
    // ask whether this was a mute
    expect(law.sql).toContain('NOTHING ABOUT THE WATCHER CHANGES');
  });

  it('the notice it closed was proved by reconstruction, not asserted', () => {
    const law = migrationCorpus().find((m) => m.name === LAW)!;
    // the previous definition plus the two documented substitutions must equal
    // the live one, byte for byte, or the migration refuses to close anything
    expect(law.sql).toContain(
      'is NOT the previous definition plus the two documented substitutions'
    );
    expect(law.sql).toContain("md5(v_new) <> 'ac9d66e60d077d886981c428c71e5c3c'");
    // and no other watched guard may be sitting away from its baseline
    expect(law.sql).toContain('differ from their baseline and would raise at the next run');
  });
});
