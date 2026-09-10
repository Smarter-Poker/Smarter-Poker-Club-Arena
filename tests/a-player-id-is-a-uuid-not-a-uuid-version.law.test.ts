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
 *
 * Use the shape, never the version:
 *   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 *
 * docs/changelog/2026-09-10-one-refused-bust-does-not-freeze-an-event.md
 */
import { describe, it, expect } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

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

describe('a player id is a uuid, not a uuid of a particular version', () => {
  it('no new migration validates an id by its uuid version nibble', () => {
    const offenders = migrationCorpus()
      .filter((m) => m.sql.includes(VERSION_CHECKED))
      .map((m) => m.name)
      .filter((name) => !HISTORICAL.has(name));
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
