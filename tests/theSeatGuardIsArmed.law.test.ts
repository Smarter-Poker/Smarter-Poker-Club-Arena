import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrationCorpus, type MigrationFile } from './helpers/migrationCorpus';

/**
 * THE SEAT GUARD IS ARMED (binding, 2026-09-06)
 *
 * `fn_ca_guard_seat_creation` refuses a `table_seats` row that APPEARS
 * (INSERT) or COMES BACK TO LIFE (`left_at` NOT NULL -> NULL) carrying
 * `stack > 0` when the caller is neither the engine (`fn_caller_is_engine`:
 * service_role, or no JWT at all - psql, pg_cron, a migration) nor one of five
 * declared money paths that debited a wallet or a treasury and said so through
 * `app.money_path`. Anything else put chips on the felt without taking them
 * from anywhere, which is a mint.
 *
 * It ran in DRY RUN from 2026-09-02 under Dan's instruction that "nothing
 * high-risk for live play is enforced". On 2026-09-06 he returned the decision
 * ("THIS IS ON YOU TO DECIDE") and the guard's own comment had already set the
 * arming condition: "swap it back in only after ca_seat_guard_dryrun has
 * stayed empty for 24 hours." Measured before arming: the trigger enabled
 * ('O'), 170,942 seats created since the dry run began, 41,696 in the last 24
 * hours of which 14,542 carried chips, and zero rows in the dry-run log. An
 * empty log proves nothing on its own - a dead trigger writes nothing either -
 * so the trigger was read as enabled and the traffic through it counted first.
 *
 * WHAT THIS LAW PINS, and why each pin was bought:
 *
 *   1. THE LIVE BODY RAISES. The last migration to declare the function must
 *      install the armed body, not the dry-run one. A revert to observation
 *      mode is a deliberate act; it may not happen by a stale worktree
 *      re-applying an older file.
 *
 *   2. ALL FIVE SANCTIONED PATHS SURVIVE. Lose one literal and a real buy-in
 *      starts failing the moment it commits. The list may GROW - adding a
 *      genuinely missing path is the correct fix in almost every case - so
 *      nothing here counts the entries; it only refuses to let one vanish.
 *
 *   3. DATA INVARIANTS PRECEDE IDENTITY BYPASSES. A tournament seat must be
 *      born with a positive stack, and a canonical seat-first seat must equal
 *      `tournaments.starting_chips`, before engine identity can authorize it.
 *      The engine is still consulted before the money-path allowlist and the
 *      unfunded-seat refusal; identity authorizes a valid funded write but can
 *      never waive the row's game-state contract.
 *
 *   4. A TOP-UP IS UNTOUCHED. `v_creating` is scoped to a seat ARRIVING: an
 *      INSERT with `left_at` NULL, or the revival of a seat that had left.
 *      Chips added to a seat already seated are a different control (the exit
 *      side is `ca_seat_stack_exits` and `fn_unaccounted_seat_exits`,
 *      CLAUDE.md 11.5). The trigger's own `UPDATE OF left_at` column list is
 *      pinned with it: widen it and every top-up starts entering this guard.
 *
 *   5. A REFUSAL CANNOT LOG ITSELF, AND MUST NOT TRY AGAIN. This is the
 *      lesson, and it is the whole reason for the pin. The first draft wrote
 *      the refusal into `ca_seat_guard_dryrun` and then raised. Probed rolled
 *      back, the log count went 0 -> 0: a RAISE inside a BEFORE trigger aborts
 *      the statement, and the trigger's own INSERT is part of that statement,
 *      so the row never survives. Persisting it needs an autonomous
 *      transaction. The evidence travels in the ERROR instead - declared path,
 *      JWT role, application name, table, seat, stack - which reaches the
 *      caller AND the Postgres error log, the same surface where 10,577 FOUR
 *      TABLE LIMIT refusals were counted on 2026-09-06. The message shape is
 *      pinned because it is now the only place that evidence exists.
 *
 *   6. THE MIGRATION REFUSES TO ARM ON UNMET EVIDENCE. Its pre-flight `DO`
 *      block aborts when the dry-run log is non-empty or the trigger is not
 *      enabled, so re-running it in a database that never collected the
 *      evidence cannot arm anything.
 *
 * There is no database in vitest, so this reads the migrations as text. The
 * live behaviour is verified on production: the Postgres error log filtered to
 * `SEAT_NOT_FUNDED`. Any hit is a refused seat that names its own caller;
 * silence is the guard working.
 */

const FUNCTION = 'fn_ca_guard_seat_creation';
const TRIGGER = 'trg_ca_guard_seat_creation';
const DECLARES = `CREATE OR REPLACE FUNCTION public.${FUNCTION}()`;

/** The five money paths that may put chips on a seat without being the engine. */
const SANCTIONED_PATHS = [
  'atomic_table_buyin',
  'fn_take_seat_and_buy_in',
  'fn_seat_horse_in_seat_first_game',
  'fn_seat_late_registrant',
  'fn_horse_seat_from_treasury',
];

/** SQL with every `--` comment line removed, so a header that QUOTES the old
 *  dry-run body (both of these files do, on purpose) is never mistaken for a
 *  declaration. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * READ THE TREE ONCE, NOT ONCE PER QUESTION.
 *
 * Five of the six `it` blocks below call `liveBody()`, and `liveBody` used to
 * walk every file in `supabase/migrations` - 2,897 of them on 2026-09-11, and
 * the one directory in this repo that only ever grows - stripping the comments
 * out of all of it, every single time. On a 28-core box running the suite
 * uncapped, `only a seat ARRIVING is guarded` crossed vitest's 5s default and
 * this file went red; CI, which caps workers at cores/4, stayed green on the
 * identical commit. A guard whose verdict depends on how busy the machine is
 * is a coin flip, and it teaches everyone to re-run CI instead of reading it.
 *
 * Two changes, no change of meaning:
 *   - the corpus comes from `migrationCorpus()`, which reads the directory
 *     once per test file (see `tests/helpers/migrationCorpus.ts`);
 *   - `stripComments` now runs on the FILES THAT COULD MATCH rather than on
 *     all of them. `stripComments` deletes whole `--` lines and rejoins on
 *     '\n', so it never merges two lines into one; a needle with no newline
 *     in it therefore cannot appear after stripping unless it was already
 *     there before. Pre-filtering on the raw text is a superset, and the
 *     stripped check still decides - a header that QUOTES the old dry-run
 *     body is still not a declaration.
 *
 * The shared corpus intentionally represents applied `.sql` migrations. This
 * law must also see the six staged Stage-B `.sql.pending` declarations before
 * production assigns their final versions, so it reads only those pending
 * files once and merges them into this test-local, version-ordered view.
 */
const pendingMigrationCorpus: MigrationFile[] = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql.pending'))
  .sort()
  .map((name) => ({
    name,
    sql: readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'),
  }));

const seatGuardMigrationCorpus: MigrationFile[] = [
  ...migrationCorpus(),
  ...pendingMigrationCorpus,
].sort((left, right) => left.name.localeCompare(right.name));

/** The last declaration in applied history plus the staged Stage-B cutover. */
function latestDeclaring(what: string): { file: string; sql: string } {
  let found = { file: '', sql: '' };
  for (const migration of seatGuardMigrationCorpus) {
    if (!migration.sql.includes(what)) continue;
    const sql = stripComments(migration.sql);
    if (sql.includes(what)) found = { file: migration.name, sql };
  }
  return found;
}

/** The dollar-quoted body of the live declaration of the guard, read once. */
let liveBodyCache: { file: string; body: string } | null = null;
function liveBody(): { file: string; body: string } {
  if (liveBodyCache) return liveBodyCache;
  const { file, sql } = latestDeclaring(DECLARES);
  expect(file, `no migration declares ${FUNCTION}`).not.toBe('');
  const start = sql.lastIndexOf(DECLARES);
  const declaration = sql.slice(start);
  const quoted = /\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(declaration);
  expect(quoted, 'the function body must stay dollar-quoted').not.toBeNull();
  return (liveBodyCache = { file, body: quoted?.[2] ?? '' });
}

/** The migration this law was written for. */
function armedMigration(): { file: string; sql: string } {
  const hit = migrationCorpus().find((m) => m.name.endsWith('_the_seat_guard_is_armed.sql'));
  expect(hit, 'the migration that armed the guard must stay in the tree').toBeDefined();
  return { file: hit?.name ?? '', sql: hit?.sql ?? '' };
}

/** The statement beginning at `from`, up to and including its terminating `;`. */
function statementAt(sql: string, from: number): string {
  const end = sql.indexOf(';', from);
  return sql.slice(from, end < 0 ? undefined : end + 1);
}

describe('the seat guard is armed', () => {
  it('the live declaration raises SEAT_NOT_FUNDED and is not the dry-run body', () => {
    const { file, body } = liveBody();

    expect(
      body,
      `${file} is the live declaration of ${FUNCTION} and it does not refuse ` +
        `anything. Chips may only reach a seat through the engine or a ` +
        `declared money path; a body that cannot say no is an observation, ` +
        `not a guard.`
    ).toContain("RAISE EXCEPTION 'SEAT_NOT_FUNDED");

    expect(
      body.includes('DRY RUN'),
      `${file} installs the DRY RUN body again. The dry run ended on ` +
        `2026-09-06 after 170,942 seat creations produced zero rows in ` +
        `ca_seat_guard_dryrun. Returning the guard to observation mode is a ` +
        `deliberate act - if you mean it, move this law in the same commit.`
    ).toBe(false);

    /**
     * WHO MAY RE-DECLARE THE GUARD (2026-09-06).
     *
     * This used to require that the LAST migration declaring the guard be
     * `_the_seat_guard_is_armed.sql` itself. That pinned the migration's
     * IDENTITY rather than the guard's PROPERTY, so any legitimate later
     * change - the comment correction in 20260906232223, which left the
     * compiled body byte-identical - failed a law about arming.
     *
     * A pin like that pressures the next agent to weaken the law or to avoid
     * touching the function at all, and both are worse than the thing it was
     * protecting against. The property is what matters and it is asserted
     * above: the live body refuses, and it is not the dry-run body.
     *
     * What is kept is deliberateness. A migration may re-declare this guard
     * only by naming itself here, so swapping the body is never something
     * that happens quietly in a file nobody reviewed.
     */
    const SANCTIONED_REDECLARATIONS = [
      /_the_seat_guard_is_armed\.sql$/,
      /_the_seat_guard_says_what_it_actually_does\.sql$/,
      /_spin_reserve_settlement_commits_its_journal_or_nothing\.sql$/,
      /_stage_b_current_postimage_contraction\.sql(?:\.pending)?$/,
    ];
    expect(
      SANCTIONED_REDECLARATIONS.some((re) => re.test(file)),
      `${file} is now the live declaration of ${FUNCTION} and it is not on the ` +
        `sanctioned list in this law. Re-declaring the money guard is allowed, ` +
        `but never silently: add your migration to SANCTIONED_REDECLARATIONS in ` +
        `the same commit, and say in its header what changed and what did not.`
    ).toBe(true);
  });

  it('all five sanctioned money paths survive in the allowlist', () => {
    const { file, body } = liveBody();
    for (const path of SANCTIONED_PATHS) {
      expect(
        body,
        `${file} declares ${FUNCTION} without '${path}'. That path debits a ` +
          `wallet or a treasury and then seats the player; dropping it from ` +
          `the allowlist refuses a legitimate buy-in the moment it commits. ` +
          `The list may GROW - a genuinely missing path is the right fix - ` +
          `but nothing may leave it silently.`
      ).toContain(`'${path}'`);
    }
  });

  it('validates tournament stacks before identity, then asks the engine before the allowlist', () => {
    const { file, body } = liveBody();

    expect(body, 'the engine check must still exist').toMatch(
      /IF\s+public\.fn_caller_is_engine\(\)\s+THEN\s+RETURN\s+NEW;/i
    );

    const engineAt = body.search(/public\.fn_caller_is_engine\(\)/i);
    const positiveStackAt = body.indexOf('TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK');
    const seatFirstStackAt = body.indexOf('SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS');
    const allowlistAt = body.indexOf(`'${SANCTIONED_PATHS[0]}'`);
    const raiseAt = body.indexOf("RAISE EXCEPTION 'SEAT_NOT_FUNDED");

    expect(positiveStackAt, `${file} must enforce a positive tournament stack`).toBeGreaterThan(-1);
    expect(seatFirstStackAt, `${file} must enforce the exact seat-first stack`).toBeGreaterThan(
      positiveStackAt
    );
    expect(engineAt).toBeGreaterThan(seatFirstStackAt);
    expect(
      engineAt,
      `${file} must consult fn_caller_is_engine() BEFORE the app.money_path ` +
        `allowlist. The engine declares no money path and carries no JWT, so ` +
        `an allowlist consulted first refuses every hand the engine deals - ` +
        `a live outage, not a bug report.`
    ).toBeGreaterThanOrEqual(0);
    expect(engineAt).toBeLessThan(allowlistAt);
    expect(engineAt).toBeLessThan(raiseAt);
  });

  it('only a seat ARRIVING is guarded, so a top-up is untouched', () => {
    const { file, body } = liveBody();

    expect(body, 'a seat that appears is an INSERT with left_at NULL').toMatch(
      /TG_OP\s*=\s*'INSERT'\s+AND\s+NEW\.left_at\s+IS\s+NULL/i
    );
    expect(body, 'a seat that comes back to life is left_at NOT NULL -> NULL').toMatch(
      /TG_OP\s*=\s*'UPDATE'\s+AND\s+OLD\.left_at\s+IS\s+NOT\s+NULL\s+AND\s+NEW\.left_at\s+IS\s+NULL/i
    );
    expect(
      body,
      `${file} must return early for anything that is not a seat arriving. ` +
        `Chips added to a seat already seated are a top-up and a different ` +
        `control entirely (ca_seat_stack_exits guards the exit side).`
    ).toMatch(/IF\s+NOT\s+v_creating\s+THEN\s+RETURN\s+NEW;/i);

    // The trigger's own column list is the other half of the same promise.
    const trg = latestDeclaring(`CREATE TRIGGER ${TRIGGER}`);
    expect(trg.file, `no migration declares ${TRIGGER}`).not.toBe('');
    const create = statementAt(trg.sql, trg.sql.lastIndexOf(`CREATE TRIGGER ${TRIGGER}`));
    expect(
      create,
      `${trg.file} must keep ${TRIGGER} on BEFORE INSERT OR UPDATE OF ` +
        `left_at. Widening the column list sends every top-up and every stack ` +
        `write through a guard that was reasoned about for arrivals only.`
    ).toMatch(/BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+left_at\s+ON\s+public\.table_seats/i);
  });

  it('the refusal does not try to log itself - it cannot, and the error carries the evidence', () => {
    const { file, body } = liveBody();

    expect(
      body.includes('INSERT INTO public.ca_seat_guard_dryrun'),
      `${file} writes the refusal into ca_seat_guard_dryrun before raising. ` +
        `That row NEVER SURVIVES: a RAISE in a BEFORE trigger aborts the ` +
        `statement, and the trigger's own INSERT is part of that statement. ` +
        `Measured on a rolled-back probe, the log count went 0 -> 0. ` +
        `Persisting it needs an autonomous transaction (dblink or ` +
        `pg_background), which is a lot of new machinery in a money path for ` +
        `a record the error already carries.`
    ).toBe(false);
    expect(
      /\bINSERT\s+INTO\b/i.test(body),
      `${file} writes a row from inside the guard. Nothing written by an ` +
        `aborting statement survives it; see the note above.`
    ).toBe(false);

    // The error is now the ONLY place the evidence exists, so its shape is
    // load-bearing: this is what "watch the log for SEAT_NOT_FUNDED" reads.
    for (const field of ['path=%', 'jwt_role=%', 'app=%', 'table=%', 'seat=%', 'stack=%']) {
      expect(
        body,
        `the refusal must still name ${field.replace('=%', '')}. The Postgres ` +
          `error log is the only surface on which a refused seat is ` +
          `countable, and a message that does not name its caller cannot be ` +
          `acted on.`
      ).toContain(field);
    }
    expect(body, 'the refusal keeps its SQLSTATE so callers can classify it').toMatch(
      /USING\s+ERRCODE\s*=\s*'check_violation'/i
    );
  });

  it('the migration refuses to arm unless the dry run was empty and the trigger live', () => {
    const { file, sql } = armedMigration();
    const body = stripComments(sql);

    const preflight = body.slice(0, body.indexOf(DECLARES));
    expect(
      preflight,
      `${file} must not replace the guard body before checking the evidence`
    ).toContain('ca_seat_guard_dryrun');
    expect(
      preflight,
      `${file} must abort when ca_seat_guard_dryrun holds rows: those rows ` +
        `name a seat creator outside the allowlist, and arming over them ` +
        `refuses a path that is really in use.`
    ).toMatch(/RAISE\s+EXCEPTION\s+'ca_seat_guard_dryrun holds/i);
    expect(
      preflight,
      `${file} must read tgenabled for ${TRIGGER}. An empty dry-run log from ` +
        `a DISABLED trigger is not evidence of anything, and that is the one ` +
        `way this whole decision could have been wrong.`
    ).toMatch(/tgenabled[\s\S]{0,200}?trg_ca_guard_seat_creation/i);

    // And the post-apply block re-asserts, in the database, what this file
    // asserts in text - including the lesson about the log that cannot be.
    expect(body, 'the migration asserts the armed body landed').toContain(
      "position('SEAT_NOT_FUNDED' IN v_src)"
    );
    expect(body, 'the migration asserts the dry-run body did not').toContain(
      "position('DRY RUN' IN v_src)"
    );
    expect(body, 'the migration asserts the refusal does not try to log itself').toContain(
      "position('INSERT INTO public.ca_seat_guard_dryrun' IN v_src)"
    );
    for (const path of SANCTIONED_PATHS) {
      expect(
        body,
        `${file} must assert '${path}' survived the swap, in the same ` +
          `transaction that swapped it`
      ).toContain(`position('${path}' IN v_src)`);
    }
  });
});
