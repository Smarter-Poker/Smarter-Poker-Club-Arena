# Post-Deploy E2E: two client defects, one spec pinned to the old render, and a frozen tournament fleet

2026-09-22. `Post-Deploy E2E` had failed on every run of the day, including on
`cfaf6d3b0190a320475d488de5a2bb8077a0f0ff`, the revision serving production at
both `https://ca-static.smarter.poker/build-info.json` and
`https://smarter.poker/hub/club-arena/build-info.json`. Two jobs were red:
`Live-table and engine verification` and `Client browser verification`. They
are unrelated failures and were diagnosed separately.

The first question was whether a real player is affected. The answer differs
per failure, so each one is labelled.

## Live-table and engine verification: (a) production is broken

The failing assertion is `production-live-table-realtime.spec.ts:129`,
`expect(health.stalledTableCount).toBe(0)`, reached before the spec observes
anything. It received `61`, and rose to `62` while this was written.

Read from `https://engine.smarter.poker/health` and from rows, not inferred:

- 62 of ~206 dealable tables are dead-stalled. `deadStalledCount` is 62 too,
  so every one is past `TABLE_DEAD_STALL_MS`.
- Six RUNNING tournaments hold 38 of those live tables and 49 seated players,
  and none of the six has a row in `engine_tournament_leases`. The other 477
  RUNNING events do. `activeTournaments` on `/health` reads 484 against 477
  lease rows: managers held in memory that no longer hold their lease, which
  is precisely the condition `tournamentManagerQuarantine` was added to name
  on 2026-09-21.
- Their last dealt hands were `2026-09-18 22:07-22:12` and
  `2026-09-19 14:29`. `$100 Freeroll 12:00 PM` (15 live tables),
  `Afternoon Free Buy (NLH)` twice, `Morning Free Buy (NLH)`,
  `Thursday Night PKO` and a DSS turbo have dealt nothing for three to five
  days. Their seats hold `status = 'active'`, `is_sitting_out = false` and
  real stacks (24,381, 13,510, 30,389, 16,366, 29,857 on one table alone).
  They are horses, which under section 10.5 makes them players, and they are
  frozen mid-event with chips on the felt.
- `/health.stalledTables[].secsIdle` reads ~600 rather than four days because
  `msSinceProgress` is restamped at each hourly restart and thaw. The witness
  that was there is `hand_history`, and it says days.

The last green `Post-Deploy E2E` run finished at 2026-09-18T21:57Z; the first
of those tournaments stopped dealing at 22:07Z the same evening. The check has
been correct and red for four days.

**The cause is named, it is already fixed on `main`, and it cannot reach
production from here.** The engine serving production is
`8825af51817f379c4261658ca29ecc9d8d81932d` (2026-09-18), 178 commits behind
`origin/main`. Every `auto-deploy-hetzner` run since has failed, and not
wrongly: the step `Every database function this build calls exists in
production` refuses the build because `CommerceRenewalConsumer.ts` calls
`fn_ca_commerce_claim_due_renewals`, `fn_ca_commerce_deliver_due_notices` and
`fn_ca_commerce_execute_renewal`, and their migration
(`20260922143541_club_and_union_diamond_commerce`, merged in #5077 seven hours
ago) is absent from `supabase_migrations.schema_migrations` while migrations
either side of it are applied. The door check is doing its job; the engine
release train is stopped behind another task's unapplied schema change.

Applying another task's 2,063-line commerce cutover is not this task's scope
and is exactly the kind of unrelated DDL the production DDL policy and section
10.9 warn against adding to a repair. So this half is **not fixed here**, and
no detector, sweep or repair job was built in its place. What is written down
is the chain, so whoever owns #5077 and the engine release can act on it:
apply the commerce migration, let `auto-deploy-hetzner` pass its door check,
and the tournament-manager quarantine already on `main` reaches the six frozen
events. Tracked on the existing issue #4076.

## Client browser verification

Three failures, of which two were on every run and one was a single
occurrence.

### 1. Club Data touch targets: (a) production is broken

`club-data-deep.spec.ts:150` measured the live page at 390px and returned 52
visible controls under the 44px floor: `Day` 32.7 wide, `ALL` 31.7, `Mid`
31.7, `Previous Period` and `Next Period` 33.5, `Go Back` 42.1, all 44 tall.

The line that produced it is `.word` in `ClubDataPage.module.css`. It declared
`min-height: 44px` and nothing about width, so a control's width came only
from padding around three or four condensed characters. Every button on the
page carries `.word`, so `min-width: 44px` on that one rule is the whole fix,
and both floors now sit together where a later word cannot miss them.

Measured in headless Chromium against the real stylesheet at 320, 375 and
390px: every control is now at least 44 by 44, and
`scrollWidth - clientWidth` stays `0`, so the 320px no-overflow assertion in
the same file is not traded away for it. Pinned by
`tests/unit/clubDataWordsAreOnTheTouchFloor.test.ts`, which also holds every button on
the page to `styles.word` so the single rule stays sufficient.

### 2. The tournament lobby overlay: (b) the spec is broken

`tournament-watch.spec.ts:144` asserted the two words back out of the panel's
text as one run with a space. `TournamentLobbyModal` was rebuilt on the
console chassis and prints its name in two measured zones, eyebrow
`Tournament` over title `Lobby`, so the panel's `textContent` reads
`TournamentLobby` with no separator. The player sees what they always saw and
the dialog's accessible name is still `Tournament Lobby`; only the
concatenation changed, and the spec could never match again.

A concatenated substring was never what the line guarded. It is there to catch
`TournamentInfoPanel` opening instead of the lobby. The spec now asks
`getByRole('dialog', { name: /tournament lobby/i })`, which answers that
question outright, survives any future zone split, and still fails if the
wrong panel opens, and it additionally asserts both words are painted in the
header the player reads. Moved in this commit, not weakened. Pinned by
`tests/unit/tournamentLobbyModalIsAskedByName.test.ts`, which holds the modal
and the spec to each other.

### 3. The commerce teardown: (c) I could not tell

`production-customization-commerce.spec.ts` failed once, only on the run that
straddled the 22:55 break. Its journey passed; its teardown did not. The whole
report was one line:

    AggregateError: Customization Commerce Certification Cleanup Failed.

Every cause `cleanupTemporaryCustomizationAccountOnce` raises carries the
table and the refusal behind it, and `AggregateError` prints none of them, so
the run could only be read as "cleanup failed, reason unknown". That is
section 10.86 rule 1: a signal that answered without saying what it knew.

I could not recover the reason after the fact. What is known: three fixture
identities (`ca-customization-cert-*@example.invalid`, created 22:54:59 to
22:55:01) survived with all their rows, so nothing was deleted at all;
`cleanup_reserved_certification_account` itself is healthy, proved against one
of them inside a self-aborting `DO` block that rolled back (section 11.5,
one call) and returned `success: true`; and the only non-cascading foreign key
still pointing at them, `client_shell_telemetry_user_id_fkey`, is
`ON DELETE SET NULL` and cannot block the delete. That is as far as the
evidence goes, so this is recorded as (c) rather than guessed at.

What is fixed is the reporting defect, which is real and is the reason the
cause was lost: `withCauses` in
`tests/e2e/support/temporaryCustomizationAccount.ts` folds each cause into the
thrown message, and both certification specs use it. The realtime spec already
did this for the combined journey-and-teardown branch and not for the
teardown-alone branch, which is the same trap one level up (10.86 rule 4);
both branches now go through the one helper. This does not fix whatever made
that teardown fail, and it is not offered as if it did. The next occurrence
will name its cause in the same line.

## Verified

`npx tsc --noEmit` clean. All eight gate scripts print ok
(`check-css-modules`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case`, `check-ui-text`, `check-no-emoji`,
`check-horses-are-players`, `check-discarded-read-then-write`).
`python3 scripts/ci/verify-source-bindings.py` reports 759 pins across 15
binding files intact; no pinned file changed, so no restamp was required.
The nine affected unit and contract suites pass, 71 tests.
