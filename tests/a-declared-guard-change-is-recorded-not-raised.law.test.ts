/**
 * A DECLARED GUARD CHANGE IS RECORDED, NOT RAISED (2026-09-10).
 *
 * `fn_ca_guard_defs_watch` compares each function on `fn_ca_guard_watchlist()`
 * (28 when this was written, 41 since 2026-09-13) against a stored baseline and raises an INFO notice
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
const watchlistDefinitions = () =>
  migrationsMentioning('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => {
      const start = m.sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist');
      const body = m.sql.slice(start, m.sql.indexOf('$function$;', start));
      const names = [...body.matchAll(/'(fn_[a-z0-9_]+)'/g)].map((x) => x[1]);
      return { name: m.name, guards: [...new Set(names)] };
    });

const watchlist = (): string[] => {
  const defs = watchlistDefinitions();
  const newest = defs[defs.length - 1];
  expect(newest, 'some migration must define fn_ca_guard_watchlist').toBeDefined();
  expect(
    newest!.guards.length,
    'the watchlist should parse to a non-trivial set of guards'
  ).toBeGreaterThan(10);
  return newest!.guards;
};

/**
 * A GUARD IS WATCHED FROM THE MIGRATION THAT FIRST NAMED IT (2026-09-13).
 *
 * The first time the list was widened (the Diamond money doors and the Phase 8
 * unit rules, `the_diamond_guards_are_watched`), every earlier migration that
 * had redefined one of the new names became an offender here retroactively -
 * eleven of them, all applied before anything watched those functions, none of
 * which could have declared a change to a list it was not on. That is not what
 * this law is for. A migration owes a declaration only for a guard that was
 * already watched when it ran, so a guard's history starts at the migration
 * that put it on the list, or at the declaration law itself, whichever is
 * later. A guard on the original list is watched from the law, as before.
 */
const watchedFrom = (): Map<string, string> => {
  const from = new Map<string, string>();
  for (const def of watchlistDefinitions()) {
    for (const g of def.guards) {
      if (!from.has(g)) from.set(g, def.name > LAW ? def.name : LAW);
    }
  }
  return from;
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
    const from = watchedFrom();
    const offenders: string[] = [];
    for (const m of migrationCorpus()) {
      if (m.name < LAW) continue; // history: the declaration did not exist yet
      if (m.sql.includes(DECLARE)) continue;
      for (const g of guards) {
        // history for THIS guard: it was not on the list when the migration ran
        if (m.name < (from.get(g) ?? LAW)) continue;
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

  it('a guard is watched from the migration that first named it, never before', () => {
    const from = watchedFrom();
    // the original list is watched from the declaration law itself
    expect(from.get('fn_ca_guard_defs_watch')).toBe(LAW);
    // the Diamond doors joined on 2026-09-12 and are watched from that migration,
    // so the door migrations that came before it are history for them
    const widened = from.get('fn_poker_diamond_reserve');
    expect(widened).toBeDefined();
    expect(widened!).toMatch(/_the_diamond_guards_are_watched\.sql$/);
    expect(widened! > LAW).toBe(true);
    // and a guard on the newest list always has a start
    for (const g of watchlist()) expect(from.has(g), `${g} has no watched-from`).toBe(true);
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
