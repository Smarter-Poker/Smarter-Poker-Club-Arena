# The Diamond tournament doors, captured

> **The lifecycle cases built on this base are in the second half of this
> README, under "The lifecycle cases".** Run them with
> `python3 tests/sql/run-diamond-tournament-lifecycle.py`. This first half
> describes the base and its 79 doors; that runner loads the base, this
> capture, a second delta, a second capture of 41 more doors, a seed and the
> cases.

This is the base of the Diamond tournament lifecycle fixture: a private
PostgreSQL 17 database carrying the estate's historical schema plus the **exact
installed Diamond tournament doors**, each one pinned by the md5 of its own
`pg_get_functiondef()` text as production renders it.

Run it:

```
python3 tests/sql/run-diamond-tournament-doors.py
```

Both runners also run in CI, through
`scripts/ci/run-diamond-sql-acceptance.py` in the
`Accounting transactions (PostgreSQL 17)` job. If you add another runner under
`tests/sql/`, it moves three places in the same commit: see
[`README.md`](./README.md) in this directory. `PG_BIN` is the only thing either
runner reads from the environment; it names the PostgreSQL 17 binaries and never
a server.

It needs PostgreSQL 17 binaries (`--bindir DIR`, or `PG_BIN`, or one of
the usual Homebrew and Debian locations). It initdbs its own cluster on a
private unix socket with `listen_addresses` empty, loads four files in order,
requires every pin to match, and drops the cluster. It never connects to
production and needs no credential.

## What it loads, in order

| #   | File                                                                                                     | What it is                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | `scripts/ci/probes/bbj-bank-replay/funded/source/internal-ledger-native-fixture-0006/build/00-roles.sql` | the estate's fixture role principals, unedited                                                            |
| 2   | `.../build/10-historical-schema.sql`                                                                     | the estate's historical schema: 1,158 tables, 2,919 functions, no rows                                    |
| 3   | `tests/sql/diamond-tournament-fixture-schema.sql`                                                        | the seven objects and three columns the base lacks, sliced verbatim from the migrations that created them |
| 4   | `tests/sql/diamond-tournament-doors-captured.sql`                                                        | 79 installed doors, each md5-pinned, ending in a block that refuses to finish if one of them disagrees    |

Measured on 2026-09-20: the loaded database holds 2,957 public functions, five
`poker_diamond_*` relations and both arena switches closed.

## Why a capture and not a migration replay

The ten Phase 8 Diamond tournament migrations edit live function text **in
place** and pin the md5 of the text they were written against. That pin is the
only thing standing between an in-place edit and a silently different money
function. Replaying those migrations onto any base that is not their exact
preimage therefore fails, by design.

On 2026-09-19 a lane building this fixture hit that wall and reached for the
change that makes it go away: rewriting the md5 comparisons to `<> NULL` across
ten financial migrations. It was refused, correctly. **Never weaken, disable,
stub or `<> NULL` an md5 guard, an assertion, or any security or financial
check - not to make a fixture build, not for any reason.**

This fixture takes the other road. It captures the installed RESULT, read
read-only from production on 2026-09-20 through `pg_get_functiondef()` inside
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, and pins every
byte of it. `tests/the-diamond-tournament-doors-are-the-installed-doors.law.test.ts`
holds that arrangement from the repository side, including the last assertion,
which refuses any migration that compares an md5 against NULL.

## Where the bytes came from

`diamond-tournament-doors-captured.manifest.json` records, per door, its
identity, its installed md5, its length, its owner, its live grants and
`bytes_from`. Of the 79 doors, 73 were recovered from copies already committed
in this repository (mostly `tests/fixtures/full-weekly-accounting/schema.sql`
and `tests/fixtures/accounting-delivery/diamond-games/functions.sql`) and six
were transported from production in this session. **Every one of the 79,
whatever its source, is proved byte-identical to the installed definition by
its md5** - that is what makes provenance a checkable fact here rather than a
claim.

## What is inside the capture, and what is not

The capture covers the Diamond tournament **entry-and-obligation closure**: the
create, register, unregister, refund, cancel, pay, drain, settle-fee and
custody doors, and everything those doors call, to closure (computed against
production, depth four, 79 functions, 339,511 bytes of definition).

Named by the Phase 8 migrations and deliberately **not** captured, each with its
reason, pinned as a list by the law so none can join quietly:

- the bounty, PKO and mystery-bounty banks - the programme puts bounties,
  satellites and reserves in Phase 9;
- the chip estate's own terminal settlement, receipts and rake - already
  exercised by `tests/fixtures/tournament-fee-lifecycle`;
- two estate-wide guards that are not tournament doors.

Two further closure members are left at the historical base's text rather than
captured, because no case reaches either:
`fn_ca_register_for_tournament_with_ticket_for` (satellite-ticket admission) and
`fn_ensure_late_registration_capacity` (late-registration seating; not on the
pre-start path). If a future case reaches either, capture it first. **Neither
was reached by the lifecycle cases** (re-checked 2026-09-29, when the create
door began admitting satellites): no case registers anybody, with a ticket or
without, because the closed switch refuses every entry, and no case seats a
late registrant, because reaching RUNNING needs the UPDATE half of the trigger
chain that is not captured yet. Both remain uncaptured, for the same stated
reasons.

## What this is NOT

This is the fixture's base and its doors. **It is not a tournament lifecycle
certification.** No Phase 8 checklist line is claimed by it: registration, late
entry, re-entry, rebuy, balancing, blind clocks, prize escrow separation,
obligation settlement, finishing-position evidence, restart recovery, paid
places, ties, cancelled events and duplicate payout attempts are all still to be
exercised against these doors. `docs/changelog/2026-09-20-the-diamond-tournament-doors-are-captured.md`
records exactly where that work stopped and the next thing it hits.

It also opens nothing: `cash_games_enabled` and `tournaments_enabled` are false
in the fixture as they are in production, and the runner asserts it.

---

# The lifecycle cases

```
python3 tests/sql/run-diamond-tournament-lifecycle.py
```

That runner loads everything above, plus four more files, and then runs the
lifecycle cases. It never connects to production, needs no credential, and
**never opens an arena switch**: `cash_games_enabled` and `tournaments_enabled`
arrive false as production holds them, and the runner refuses to pass if either
is on when the cases finish.

| #   | File                                      | What it is                                                                                                          |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 5   | `diamond-tournament-lifecycle-schema.sql` | two relations, four `tournaments` columns and four `tournaments` constraints the base lacks, sliced verbatim        |
| 6   | `diamond-tournament-lifecycle-doors.sql`  | 26 more installed doors, md5-pinned, plus the nine `tournaments` triggers production carries that the base does not |
| 7   | `diamond-tournament-lifecycle-seed.sql`   | one Diamond arena, four synthetic accounts, the staff account, the arena settings row and the MTT admission ABI     |
| 8   | `diamond-tournament-lifecycle-cases.sql`  | the cases                                                                                                           |

## Why a second capture

The first capture holds the functions the Diamond tournament money path
**calls**. The second holds the functions production **fires**: `tournaments`
has a trigger chain, and the create door's own INSERT runs it.

The historical base and production disagree there. Measured read-only on
2026-09-20: production attaches **60** triggers to `public.tournaments` naming
**58** distinct functions. Of those 58, **34** are already byte-identical in the
base, **13** render to different text and **11** are absent from it. Twelve of
the 60 triggers are not attached in the base at all, and one trigger the base
carries - `a0_tournament_manager_write_scope` - names
`trg_tournament_manager_write_scope`, a function production does not have.

Loaded against the base alone, a Diamond MTT is refused by a creation guard 165
bytes shorter than the installed one and never reaches nine refusals production
runs. So the 22 functions the create path needs are captured the same md5-pinned
way, 20 of them recovered from bytes already committed in this repository and 2
transported from production in this session, and the nine INSERT triggers are
installed in production's own `pg_get_triggerdef()` text.

Four more joined them for the Phase 9 cross-format conservation cases: the
prize ladder the terminal prices every paid place with
(`fn_ca_prize_ladder_versioned` and its two versions, `fn_ca_prize_ladder` and
`fn_ca_prize_ladder_v2`) and the final-field generator entry close commits
(`fn_ca_payout_structure`). All four are pure functions, transported from
production by a read-only `pg_get_functiondef()`.

## The refresh of 2026-09-29, and how a capture is refreshed

Three migrations changed the create door that day (the money-key fence,
satellites, Spins) and others changed doors the capture holds. A refresh reads
every pin of both captures against production (`md5(pg_get_functiondef(oid))`,
read-only), re-transports each door that moved with a read-only
`pg_get_functiondef()`, and rewrites its block, its line in the file's own
proof list and its manifest entry in one step, so the three can never disagree.
Twelve doors had moved and were re-pinned (eleven in the first capture, the
satellite-target guard in the second). Fifteen joined the second capture: the
satellite and Spin creation paths (`fn_ca_diamond_satellite_target_accepts_new_feeder`,
`fn_poker_diamond_create_spin`, `fn_poker_diamond_spin_contract`,
`fn_ca_tournament_recorded_seat_first`), the two INSERT triggers production
attached to `tournaments` after 2026-09-20 (installed, with their functions),
and every function the cases execute that rendered differently from production
(the management-contract and readiness readers the insert chain calls, the blind
resolver the blind clock calls, the freeze reader, the `tables` counters and
closing cash-out a Spin's own table reaches, the table-origin validator and the
Spin draw-contract guard). The retired `a0_tournament_manager_write_scope` is
dropped from `tables`, `table_seats` and `tournament_players` as it already was
from `tournaments`. The Spin row needs two tables and the acceptance trigger two
more; all four are sliced verbatim into the lifecycle delta, and the seed slices
the published Spin table from the migrations that seed it.

**Measured, not assumed.** With `track_functions` on, the refreshed cases
execute 174 production functions. 165 render byte-identical to production. The
other nine are named here so they cannot be mistaken for covered: five run on
the seed's signup path, which builds the synthetic accounts and is not under
test (`fn_ca_autoledger`, `fn_ca_mint`, `fn_guard_profile_privileged_columns`,
`fn_reject_horse_name_on_human`, `generate_referral_code`), and four on the
UPDATE half of the `tournaments` trigger chain that the cancellation cases
reach and this capture does not stand up (`fn_ca_fund_overlay_on_lock`,
`fn_guard_managed_game_lifecycle`, `trg_lock_atomic_final_table_deal_status`,
and `fn_guard_tournament_completing_claim`, whose trigger production keeps
disabled). The Spin row's table is written through the base's `tables` trigger
chain: production attaches 36 triggers there and the base 24 once the retired
one is dropped, and six production INSERT triggers do not fire on it here
(`a00_f06_lifecycle`, `tournament_table_inherits_committed_blinds`,
`union_pnl_original_inventory`, `zz_tables_kill_pot_guard`,
`zzzz_stamp_table_game_scope`, `zzzz_stamp_table_seat_admission`). The funded
rehearsal in `docs/evidence/diamond-phase-9-funded-conservation/` runs all of
them in production.

## The arena's membership boundary, and how the seed satisfies it

`poker_arena_membership_guard` (`fn_poker_guard_arena_structure`) is
`BEFORE INSERT OR UPDATE` on `club_members`, and for a club whose asset is
`diamonds` its first test is `TG_OP='INSERT'`. **An INSERT is refused
unconditionally**, with no exemption for `postgres`, for `service_role` or for a
platform admin. That is deliberate, and the doors say so in their own words -
`fn_ca_entry_scope_ok` carries the comment "The Diamond arena has no membership
rows by design: every account with a profile is a member", and
`fn_poker_arena_context` sets `member=true, role='player'` for a Diamond arena
without consulting `club_members` at all.

Production's single Diamond arena membership row is a pre-guard artefact, not a
condition the guard admits: the club and that row were both created at
2026-09-08T11:28:12.386252Z, the guard arrived with migration `20260908152855`
four hours later, and the row's `updated_at` is that migration's own timestamp
reshaping it into the only shape the guard tolerates on UPDATE.

So the seed creates **no membership row**, and therefore gives the arena no
`owner_id`: `clubs.owner_id` is nullable in production, and
`fn_club_owner_has_a_player_wallet` - the deferred constraint trigger that would
otherwise create the owner's wallet row at COMMIT - returns on its first line
when `owner_id IS NULL`. Nothing is disabled. The seed then proves the guard is
still armed by attempting production's exact row and being refused.

## What the cases prove, and what the closed switch stops

`fn_poker_diamond_reserve` refuses a tournament entry while
`tournaments_enabled` is off, and `fn_poker_diamond_tournament_charge` refuses a
rebuy, re-entry or add-on at the same test. So **no Diamond can be taken for an
entry here**, and every case that would need a funded custody row is a refusal
case, asserted to move nothing. That closed switch is itself the sixth case.

The changelog,
`docs/changelog/2026-09-20-the-diamond-tournament-lifecycle-cases-run.md`,
lists case by case what runs, what each one asserts, and the exact place the
funded half stops.

Cases 9 to 13 are the Phase 9 cross-format conservation cases: one table of
every Diamond format the create door admits - all seven since 2026-09-29,
satellites and Spins included (adding a format is adding a row) - capped
exposure, the closed switch, cancellation before launch and the prize ladder's
rounding at both units. The funded half, which needs an entry the closed switch
refuses, is proved by the rolled-back production rehearsal kept in
`docs/evidence/diamond-phase-9-funded-conservation/`.
`docs/changelog/2026-09-29-diamond-phase-9-cross-format-conservation.md` and
`docs/changelog/2026-09-29-diamond-phase-9-every-diamond-format-conserves.md`
say what each half proves, and the ladder defect the cases found.
