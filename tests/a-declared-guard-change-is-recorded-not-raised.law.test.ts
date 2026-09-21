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
import { createHash } from 'node:crypto';
import {
  migrationCorpus,
  migrationsMentioning,
  type MigrationFile,
} from './helpers/migrationCorpus';

/** The migration that introduced the declaration. Migrations before it are history. */
const LAW = '20260910143032_a_declared_guard_change_is_recorded_not_raised.sql';
const DECLARE = 'fn_ca_declare_guard_redefinition';

/**
 * An already-installed migration is immutable. Each of these omitted its
 * declaration; its forward repair records only the exact installed history and
 * live authority. Bind BOTH source files of every entry so this cannot pardon a
 * new or modified guard change. Prospective redefinitions still require their
 * own same-transaction declaration.
 *
 * THIS IS A BOUND LIST, NOT A WAIVER, and the difference is the four hashes.
 * An entry names one original file, the one guard it failed to declare, and one
 * successor that declares it - and pins the exact bytes of both files. Change a
 * character of either, point it at a second guard, or remove the successor, and
 * the pardon evaporates and the original is an offender again. The three tests
 * below prove exactly that, per entry.
 *
 * 2026-09-20 added two entries. 20260920183008 replaced
 * fn_ca_incident_escalation_tick and 20260920192513 replaced fn_ca_autoledger by
 * asserted substitution; neither declared itself, so fn_ca_guard_defs_watch did
 * its job - observed a hash nobody had named, moved the baseline itself, and
 * opened an INFO notice apiece (466ebf15 at 19:25Z, f95556fc at 20:25Z). Both
 * were installed byte for byte before the omission was noticed, so the text that
 * ran is left exactly as it ran and one successor records both forward.
 */
interface InstalledOmission {
  original: string;
  originalSha256: string;
  successor: string;
  successorSha256: string;
  guard: string;
}
const installedFundingDeclaration: InstalledOmission = {
  original: '20260917230925_cash_funding_retains_original_participant_custody.sql',
  originalSha256: 'febab308160e36d6adabe8a3cf7e33afe77d06cabfe799ea25e389d957f023a3',
  successor: '20260918014359_declare_the_installed_original_club_funding_guard.sql',
  successorSha256: 'a4f3438b9cfdd57052ea45a463dcced91c442041aa0746ccab442b278d9c5d71',
  guard: 'fn_club_members_ledger_writer',
};
const BOARD_GUARD_SUCCESSOR = '20260921003008_declare_the_two_installed_board_guards.sql';
const BOARD_GUARD_SUCCESSOR_SHA256 =
  'd04d76a2cfcb8769f108cb1a325339a48f3882dc5c84a8312d9ade0778dd232b';
const installedEscalationTickDeclaration: InstalledOmission = {
  original: '20260920183008_the_board_can_close_and_silence_is_never_a_fix.sql',
  originalSha256: 'a3c92b4a7da8d39553f58c8f8713c70ab0800be1bc27d40c706bae51643febbf',
  successor: BOARD_GUARD_SUCCESSOR,
  successorSha256: BOARD_GUARD_SUCCESSOR_SHA256,
  guard: 'fn_ca_incident_escalation_tick',
};
const installedAutoledgerDeclaration: InstalledOmission = {
  original: '20260920192513_the_journal_leg_names_the_club_the_prize_landed_in.sql',
  originalSha256: '7a14ebe01d372e647fa863a235c5af0a8f28936a19d23af309be4d71e67de9fa',
  successor: BOARD_GUARD_SUCCESSOR,
  successorSha256: BOARD_GUARD_SUCCESSOR_SHA256,
  guard: 'fn_ca_autoledger',
};
const installedOmissions: InstalledOmission[] = [
  installedFundingDeclaration,
  installedEscalationTickDeclaration,
  installedAutoledgerDeclaration,
];
const sha256 = (sql: string): string => createHash('sha256').update(sql).digest('hex');
const matchesOmission = (
  repair: InstalledOmission,
  migration: MigrationFile,
  guard: string,
  corpus: MigrationFile[]
): boolean => {
  const successor = corpus.find((m) => m.name === repair.successor);
  return (
    migration.name === repair.original &&
    guard === repair.guard &&
    sha256(migration.sql) === repair.originalSha256 &&
    successor !== undefined &&
    successor.name > migration.name &&
    sha256(successor.sql) === repair.successorSha256
  );
};
const hasExactInstalledDeclaration = (
  migration: MigrationFile,
  guard: string,
  corpus: MigrationFile[]
): boolean => installedOmissions.some((r) => matchesOmission(r, migration, guard, corpus));

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
        if (redefines(m.sql, g) && !hasExactInstalledDeclaration(m, g, migrationCorpus())) {
          offenders.push(`${m.name} redefines ${g}`);
        }
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

  it.each(installedOmissions)(
    'an immutable installed omission has only its exact guarded forward declaration ($guard)',
    (repair) => {
      const corpus = migrationCorpus();
      const original = corpus.find((m) => m.name === repair.original)!;
      const successor = corpus.find((m) => m.name === repair.successor)!;
      expect(original).toBeDefined();
      expect(successor).toBeDefined();
      expect(hasExactInstalledDeclaration(original, repair.guard, corpus)).toBe(true);
      /* It must name the migration it is recording, and prove the INSTALLED
         text rather than the repository file - the two are not the same thing,
         and a repair that cannot say which text it pardons pardons any text. */
      expect(successor.sql).toContain(repair.original.slice(0, 14));
      expect(successor.sql).toContain('supabase_migrations.schema_migrations');
      expect(successor.sql).toContain('md5(pg_get_functiondef(p.oid))=v_expected');
      expect(successor.sql).toContain(
        "p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'"
      );
      expect(successor.sql).toContain(`v_declared := public.${DECLARE}(`);
      expect(successor.sql).toContain(`'${repair.guard}',`);
      expect(successor.sql).toContain('v_declared IS DISTINCT FROM v_expected');
      // A declaration RECORDS. It may not replace a body, a grant or a row.
      expect(successor.sql).not.toMatch(
        /CREATE OR REPLACE FUNCTION|ALTER FUNCTION|UPDATE public|DELETE FROM/i
      );
      /* And from 2026-09-20 it must be checkable for liveness, or nothing can
         tell whether the declaration it promises ever reached production. The
         same date a-merged-migration-must-be-live binds from, for the same
         reason; earlier repairs are history and are not re-written for it. */
      if (repair.successor.slice(0, 8) >= '20260920') {
        expect(successor.sql).toMatch(/--\s*@live-proof:/);
      }
    }
  );

  it('the funding repair still carries the exact installed digest it was written with', () => {
    const repair = installedFundingDeclaration;
    const successor = migrationCorpus().find((m) => m.name === repair.successor)!;
    expect(successor.sql).toContain(repair.originalSha256);
  });

  it.each(installedOmissions)(
    'a missing or changed repair, changed source, or another guard remains undeclared ($guard)',
    (repair) => {
      const corpus = migrationCorpus();
      const original = corpus.find((m) => m.name === repair.original)!;
      expect(
        hasExactInstalledDeclaration(
          original,
          repair.guard,
          corpus.filter((m) => m.name !== repair.successor)
        )
      ).toBe(false);
      expect(
        hasExactInstalledDeclaration(
          { ...original, sql: original.sql + '\n-- changed' },
          repair.guard,
          corpus
        )
      ).toBe(false);
      expect(
        hasExactInstalledDeclaration(
          { ...original, name: '20260919000000_new_change.sql' },
          repair.guard,
          corpus
        )
      ).toBe(false);
      expect(hasExactInstalledDeclaration(original, 'fn_ca_guard_defs_watch', corpus)).toBe(false);
      // and one entry's successor never pardons another entry's original
      for (const other of installedOmissions) {
        if (other.original === repair.original) continue;
        expect(hasExactInstalledDeclaration(original, other.guard, corpus)).toBe(false);
      }
      for (const mutate of [
        (sql: string) =>
          sql.replace(`v_declared := public.${DECLARE}(`, 'v_declared := public.unknown('),
        (sql: string) => sql.replace(`'${repair.guard}',`, "'fn_ca_guard_defs_watch',"),
      ]) {
        expect(
          hasExactInstalledDeclaration(
            original,
            repair.guard,
            corpus.map((m) => (m.name === repair.successor ? { ...m, sql: mutate(m.sql) } : m))
          )
        ).toBe(false);
      }
    }
  );

  it('a byte changed anywhere in the funding repair evaporates its pardon', () => {
    const repair = installedFundingDeclaration;
    const corpus = migrationCorpus();
    const original = corpus.find((m) => m.name === repair.original)!;
    for (const mutate of [
      (sql: string) => sql.replace(repair.originalSha256, '0'.repeat(64)),
      (sql: string) => sql.replace('e7cae5f2fc19ef0d2c47e528764abd5a', '0'.repeat(32)),
    ]) {
      expect(
        hasExactInstalledDeclaration(
          original,
          repair.guard,
          corpus.map((m) => (m.name === repair.successor ? { ...m, sql: mutate(m.sql) } : m))
        )
      ).toBe(false);
    }
  });

  it('the board repair names the two installed migrations it records, and their live hashes', () => {
    const successor = migrationCorpus().find((m) => m.name === BOARD_GUARD_SUCCESSOR)!;
    expect(successor, `${BOARD_GUARD_SUCCESSOR} must exist`).toBeDefined();
    // the installed statements it is pardoning, digested from schema_migrations
    expect(successor.sql).toContain(
      'f15d32c009acbd9e6d268aea6ae3831620bca56792c1671b856bb548ff2bb6f8'
    );
    expect(successor.sql).toContain(
      '2284dd4e6e631b9ad1f1cb2a9c77af63a0745b18f978fb61a1b124bf3566bd1f'
    );
    // the live definitions it refuses to record if they have moved
    expect(successor.sql).toContain('52bc785feeebef56ff0d4f682168c677');
    expect(successor.sql).toContain('53f9d85b88cc86b807f7ea5b80d7bd4e');
    // and it says plainly that it closes neither notice
    expect(successor.sql).toContain('do not close themselves');
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
