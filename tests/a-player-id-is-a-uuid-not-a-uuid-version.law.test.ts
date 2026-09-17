/**
 * A PLAYER ID IS A UUID, NOT A UUID OF A PARTICULAR VERSION (2026-09-10).
 *
 * The bounty doors validated a claimant's `user_id` with a regular expression
 * that pins the UUID VERSION and VARIANT nibbles:
 *
 *   '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 *                              ^^^^^          ^^^^^^
 *
 * A horse's identity is 00000000-0000-0000-0000-0000000000NN. Version nibble
 * 0, variant nibble 0: it fails. Measured on production, 95 of 1,198 profiles
 * fail it - 62 horses and 33 humans whose accounts predate the v4 generator -
 * and all 1,198 are valid uuids that Postgres accepts into a `uuid` column.
 *
 * Every bounty whose claimants included one of those 95 was refused
 * `invalid_claimants`, the elimination pass aborted on that refusal, and the
 * event froze holding escrow nobody could be paid. That is CLAUDE.md 10.5 in
 * the exact shape it was written about: a filter that leaves horses out of
 * something a human gets - except this one left 33 humans out too.
 *
 * It had been written twice more, in opposite directions. `ca_index_every_seat`
 * carried `AND NOT <the same pattern>`, so the stats index it fills covered
 * ONLY those 95 people - the catch-up half of a pass whose first half had the
 * check the right way round and skipped them. Both halves are gone
 * (`every_seat_means_every_seat`).
 *
 * MEASURED AFTER BOTH FIXES: nine live production functions still carry the
 * pattern and every one of them validates an id the PLATFORM generates - a
 * transcode job, a bounty obligation read from the caller's own GUC, a solver
 * run, a dataset, a purchase. Not one validates a person.
 *
 * THE RULE THIS FILE ENFORCES: no NEW migration may carry that pattern. The
 * files that already do are listed below and frozen at that list, so the count
 * can only go down. None of them may be copied forward, because the next
 * person to reach for "a uuid regex" will copy the nearest one.
 * The September 14 installed collector archive is recognized below by exact
 * provenance, retaining the platform-obligation check explicitly approved on
 * September 10. This does not permit another copy or an edited expression.
 *
 * Use the shape, never the version:
 *   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 *
 * docs/changelog/2026-09-10-one-refused-bust-does-not-freeze-an-event.md
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { migrationCorpus, type MigrationFile } from './helpers/migrationCorpus';
import { sliceSqlStatement } from './helpers/sourceWindow';

/** The version-and-variant-checked pattern, as it appears in SQL. */
const VERSION_CHECKED = '[1-5][0-9a-f]{3}-[89ab]';

/**
 * Migrations that already carried it when this law was written. Frozen: a new
 * name here is a new instance of the defect, and removing one is progress.
 *
 * The last two are the corrections - they quote the pattern in order to assert
 * it away, which is the one legitimate reason to write it down.
 */
const HISTORICAL = new Set([
  '20260901000005_stats_rollups_bounded_locked.sql',
  '20260903190000_stats_page_money_is_exact_and_live.sql',
  '20260904083540_stats_phase_1_witness_audit_and_health.sql',
  '20260904092705_stats_phase_1_every_seat_is_indexed.sql',
  '20260908042000_bounty_elimination_outbox_is_atomic_and_recoverable.sql',
  '20260908042300_a_satellite_finish_pays_one_frozen_entitlement_plan.sql',
  '20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql',
  '20260909172537_v31_dataset_and_source_integers_are_canonical.sql',
  '20260909175000_v31_control_receipts_use_exact_json_types.sql',
  '20260909180000_v31_agreement_receipts_bind_the_runtime_cell.sql',
  '20260909182236_bounty_rebuy_settles_the_old_head_before_the_new_generation.sql',
  '20260910053723_tournament_bounty_per_pot_evidence.sql',
  '20260910124023_a_player_id_is_a_uuid_not_a_uuid_version.sql',
  '20260910134429_every_seat_means_every_seat.sql',
]);

const INSTALLED_OBLIGATION_ARCHIVE =
  '20260914133503_pko_heads_follow_accepted_knockout_dependencies.sql';
const PLATFORM_ID_APPROVAL = '20260910134429_every_seat_means_every_seat.sql';
const OBLIGATION_UUID_PREDICATE =
  "'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'";
const APPROVED_OBLIGATION_SCAN_MARKER = "'<previously approved installed obligation UUID check>'";
const digest = (algorithm: 'sha256' | 'md5', text: string) =>
  createHash(algorithm).update(text).digest('hex');

/**
 * September 10's explicit nine-function platform-ID allowlist includes
 * fn_collect_bounty's app.bounty_obligation_id GUC. The September 14 installed
 * R37 artifact preserves that check; it does not validate a player ID. Its
 * captured collector prosrc was read back on September 17 at 05:08:32 UTC.
 *
 * Recognize only those exact immutable sources and that single obligation
 * expression, in memory for this scan. Any changed name, bytes, function body,
 * subject, lookup or extra check falls back to the original generic scan.
 * This is not a function-name exemption, and HISTORICAL remains frozen.
 */
function scanAfterPreviouslyApprovedInstalledObligationCheck(
  migration: MigrationFile,
  approval: MigrationFile | undefined
): string {
  if (
    migration.name !== INSTALLED_OBLIGATION_ARCHIVE ||
    digest('sha256', migration.sql) !==
      '209677be92189861d585c45d041841cc9ec4ec8e7c6d729f43a15ab66c0bb12c' ||
    approval?.name !== PLATFORM_ID_APPROVAL ||
    digest('sha256', approval.sql) !==
      '0a460a25ee1948abf643d3067866f5173cb495b80bd395d9c234422cd140ddea' ||
    migration.sql.split(VERSION_CHECKED).length !== 2
  ) {
    return migration.sql;
  }

  const collector = sliceSqlStatement(
    migration.sql,
    'CREATE OR REPLACE FUNCTION public.fn_collect_bounty('
  );
  const body = /\nAS \$function\$([\s\S]*)\$function\$;$/.exec(collector)?.[1];
  if (
    !body ||
    digest('md5', body) !== 'bc621ffbddfd931897706f6d1f099109' ||
    !body.includes("v_context text := current_setting('app.bounty_obligation_id',true);") ||
    !body.includes(
      `IF COALESCE(v_context,'')
       ~* ${OBLIGATION_UUID_PREDICATE} THEN
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.id=v_context::uuid AND bo.tournament_id=p_tournament_id`
    )
  ) {
    return migration.sql;
  }
  return migration.sql.replace(OBLIGATION_UUID_PREDICATE, APPROVED_OBLIGATION_SCAN_MARKER);
}

function migrationsWithUnapprovedVersionChecks(migrations: MigrationFile[]): string[] {
  const approval = migrations.find((migration) => migration.name === PLATFORM_ID_APPROVAL);
  return migrations
    .filter((migration) =>
      scanAfterPreviouslyApprovedInstalledObligationCheck(migration, approval).includes(
        VERSION_CHECKED
      )
    )
    .map((migration) => migration.name)
    .filter((name) => !HISTORICAL.has(name));
}

describe('a player id is a uuid, not a uuid of a particular version', () => {
  it('no new migration validates an id by its uuid version nibble', () => {
    const offenders = migrationsWithUnapprovedVersionChecks(migrationCorpus());
    expect(
      offenders,
      [
        'These migrations validate an id with a UUID VERSION check.',
        "A horse's id is 00000000-0000-0000-0000-0000000000NN and 33 human",
        'accounts predate the v4 generator; all of them are valid uuids.',
        'Validate the SHAPE instead:',
        "  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
        offenders.join('\n'),
      ].join('\n')
    ).toEqual([]);
  });

  it('recognizes only the captured installed obligation expression approved on September 10', () => {
    const archive = migrationCorpus().find(
      (migration) => migration.name === INSTALLED_OBLIGATION_ARCHIVE
    )!;
    const approval = migrationCorpus().find(
      (migration) => migration.name === PLATFORM_ID_APPROVAL
    )!;
    expect(archive).toBeDefined();
    expect(approval).toBeDefined();
    const scanned = scanAfterPreviouslyApprovedInstalledObligationCheck(archive, approval);
    expect(scanned).not.toBe(archive.sql);
    expect(scanned).toBe(
      archive.sql.replace(OBLIGATION_UUID_PREDICATE, APPROVED_OBLIGATION_SCAN_MARKER)
    );
    expect(scanned).not.toContain(VERSION_CHECKED);
    expect(migrationsWithUnapprovedVersionChecks([approval, archive])).toEqual([]);
  });

  it.each([
    [
      'a new migration copies the archive',
      (m: MigrationFile) => ({ ...m, name: '20260918000000_copied_collector.sql' }),
    ],
    [
      'the predicate validates a player',
      (m: MigrationFile) => ({
        ...m,
        sql: m.sql.replace(
          "IF COALESCE(v_context,'')",
          "IF COALESCE(p_eliminated_user_id::text,'')"
        ),
      }),
    ],
    [
      'the context reads a player GUC',
      (m: MigrationFile) => ({
        ...m,
        sql: m.sql.replace(
          "current_setting('app.bounty_obligation_id',true)",
          "current_setting('app.player_id',true)"
        ),
      }),
    ],
    [
      'the context is assigned a player',
      (m: MigrationFile) => ({
        ...m,
        sql: m.sql.replace(
          "current_setting('app.bounty_obligation_id',true)",
          'p_collector_user_id::text'
        ),
      }),
    ],
    [
      'the lookup changes identity',
      (m: MigrationFile) => ({
        ...m,
        sql: m.sql.replace(
          'WHERE bo.id=v_context::uuid',
          'WHERE bo.eliminated_user_id=v_context::uuid'
        ),
      }),
    ],
    [
      'the function is renamed',
      (m: MigrationFile) => ({
        ...m,
        sql: m.sql.replace(
          'CREATE OR REPLACE FUNCTION public.fn_collect_bounty(',
          'CREATE OR REPLACE FUNCTION public.fn_collect_player('
        ),
      }),
    ],
    [
      'a second check is added inside the collector',
      (m: MigrationFile) => ({
        ...m,
        sql: m.sql.replace(
          "  IF COALESCE(v_context,'')",
          `  IF p_collector_user_id::text ~* ${OBLIGATION_UUID_PREDICATE} THEN RETURN '{}'::jsonb; END IF;\n  IF COALESCE(v_context,'')`
        ),
      }),
    ],
    [
      'a second check is added outside the collector',
      (m: MigrationFile) => ({
        ...m,
        sql: `${m.sql}\nSELECT id FROM public.profiles WHERE id::text ~* ${OBLIGATION_UUID_PREDICATE};\n`,
      }),
    ],
    [
      'unrelated archive bytes change',
      (m: MigrationFile) => ({ ...m, sql: `${m.sql}\n-- changed artifact\n` }),
    ],
  ] as const)('fails closed when %s', (_description, change) => {
    const archive = migrationCorpus().find(
      (migration) => migration.name === INSTALLED_OBLIGATION_ARCHIVE
    )!;
    const approval = migrationCorpus().find(
      (migration) => migration.name === PLATFORM_ID_APPROVAL
    )!;
    const changed = change(archive);
    expect(changed).not.toEqual(archive);
    expect(scanAfterPreviouslyApprovedInstalledObligationCheck(changed, approval)).toBe(
      changed.sql
    );
    expect(migrationsWithUnapprovedVersionChecks([approval, changed])).toEqual([changed.name]);
  });

  it.each(['missing', 'renamed', 'changed'] as const)(
    'fails closed with %s prior approval',
    (change) => {
      const archive = migrationCorpus().find(
        (migration) => migration.name === INSTALLED_OBLIGATION_ARCHIVE
      )!;
      const approval = migrationCorpus().find(
        (migration) => migration.name === PLATFORM_ID_APPROVAL
      )!;
      const changed =
        change === 'missing'
          ? undefined
          : change === 'renamed'
            ? { ...approval, name: '20260918000000_copied_approval.sql' }
            : {
                ...approval,
                sql: approval.sql.replace("'fn_collect_bounty',", "'fn_collect_other',"),
              };
      expect(changed).not.toEqual(approval);
      expect(scanAfterPreviouslyApprovedInstalledObligationCheck(archive, changed)).toBe(
        archive.sql
      );
      expect(
        migrationsWithUnapprovedVersionChecks(changed ? [changed, archive] : [archive])
      ).toContain(archive.name);
    }
  );

  it('the historical list only shrinks - a name that is gone stays gone', () => {
    const present = new Set(
      migrationCorpus()
        .filter((m) => m.sql.includes(VERSION_CHECKED))
        .map((m) => m.name)
    );
    const stale = [...HISTORICAL].filter((name) => !present.has(name));
    // A file listed here that no longer carries the pattern has been fixed or
    // superseded; drop it from HISTORICAL in the same commit so the list stays
    // an honest inventory rather than a growing pile of exemptions.
    expect(
      stale,
      `these names no longer carry the pattern - remove them from HISTORICAL:\n${stale.join('\n')}`
    ).toEqual([]);
  });

  it('the fix migration shows the shape every id check should use', () => {
    const fix = migrationCorpus().find(
      (m) => m.name === '20260910124023_a_player_id_is_a_uuid_not_a_uuid_version.sql'
    );
    expect(fix, 'the fix migration must exist').toBeDefined();
    expect(fix!.sql).toContain("'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    // and it names both doors it corrected
    expect(fix!.sql).toContain('fn_claim_bounty_legacy_candidate_20260907');
    expect(fix!.sql).toContain('fn_exact_tournament_knockout_claimants');
  });

  it('the seat indexer keeps the shape check and loses the version check', () => {
    const seats = migrationCorpus().find(
      (m) => m.name === '20260910134429_every_seat_means_every_seat.sql'
    );
    expect(seats, 'the seat-indexer correction must exist').toBeDefined();
    // it asserts the anchor is unique before it substitutes
    expect(seats!.sql).toContain(
      'the seat indexer carries % version-checked player-id clause(s), expected 1'
    );
    // and afterwards: version gone, shape kept, index still written idempotently
    expect(seats!.sql).toContain(
      'the seat indexer still validates a player id by its uuid version'
    );
    expect(seats!.sql).toContain('the seat indexer lost its uuid SHAPE check');
    expect(seats!.sql).toContain('ON CONFLICT DO NOTHING');
    // and it closes the class: every remaining live use is a platform-generated id
    expect(seats!.sql).toContain(
      'production function(s) outside the platform-id allowlist still carry a uuid-version check'
    );
  });
});
