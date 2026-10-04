# Diamond Arena Phase 10, lines 3, 4 and 5: verified line by line, 2026-10-04

An audit, not a plan. [The remaining-work audit of September 20](../../DIAMOND-LAUNCH-REMAINING-WORK-2026-09-20.md)
left three Phase 10 lines unaddressed and ticked none of them, saying so in
those words: "no audit has gone line by line against these deliverables".
[The line-by-line audit of September 21](../../DIAMOND-PHASE-10-AUDIT-2026-09-21.md)
scoped them into a nine-item build list, the work was built on September 29 and
30, and the programme ticked the lines. The audit that closes the loop, against
what is actually installed and running, is this one. It covers the three lines
only; lines 1, 2 and 6 have [their own audit](../../DIAMOND-PHASE-10-LINES-1-2-6-2026-09-29.md).

Every database read below was taken through
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` against project
`kuklfnapbkmacvwxktbh` on 2026-10-04 between 12:36 and 12:42 UTC. No
production write was made, no DDL was run and neither arena switch was touched.
Repository verdicts are against `origin/main` at `455ec7ee4e`.

## The short answer

All three lines are built, installed and wired. Two of them are proven by
production rows rather than by code reading. One defect was found and fixed in
this pull request, and it was in the regression protection, not in the feature:
the law that pins the staff desk's door parameters had grown to 93% of its
time budget and timed out instead of asserting.

| Line                                                              | Verdict                                | Proven by                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 4. Staff game configuration, incident review, audited adjustments | Built and installed. Partly exercised. | 33 functions in `pg_proc`; eight staff doors each file an audit row. The review door has never been used by a person. |
| 3. Real member, online, seated and table counts                   | Built, installed and proven live       | `fn_diamond_arena_counts()` answered a real number, a real zero and an honest unknown in one read                     |
| 5. Financial push alerts without arena-wide lockout               | Built, installed and proven live       | Two episodes paged once each, recorded in diamonds, to one named active recipient                                     |

## Line 3: the counts, and the unknown that is not a zero

CLAUDE.md 10.86 rule 1 is the governing rule: "I could not tell" is a distinct
outcome and must have its own name, never folded into pending, green, empty,
zero or silence. The defect to avoid is a figure that reads 0 when it means
unknown.

`public.fn_diamond_arena_counts()` read live at 12:38:31 UTC:

```json
{
  "as_of": "2026-10-04T12:38:31.993595+00:00",
  "online": null,
  "seated": 0,
  "tables": 17,
  "members": 1149,
  "unknown": { "online": "no_caller_to_witness" }
}
```

That single answer carries all three outcomes at once, which is the whole
point: `members` 1,149 and `tables` 17 are real numbers, `seated` is a real 0
(both arena switches are closed, so nobody is seated), and `online` is NULL
with its reason named, because the reader was `service_role` and the function
will not count who is here without a caller to check its presence sources
against. The reason is a name, not a shrug: the function answers
`no_caller_to_witness`, `presence_not_reported`, `arena_not_identified` or
`read_failed_<SQLSTATE>`, and each figure fails on its own while the others
answer.

`tables` 17 agrees with a direct count of the arena's own rows: 17 tables on
club `002c2d27-9584-4e52-835a-bb2be148fc81` that are not deleted.

The client half does not undo it. `src/lib/diamondArenaCounts.ts` maps a
number to itself, an absent read to `null` (printed `...`), and a NULL,
malformed or negative figure to `COUNT_UNKNOWN` (printed `Unavailable`), so
loading, a real zero and unknown are three different things on the screen.
`src/services/DiamondArenaRosterService.ts` throws on a failed read rather
than returning an empty page, and `toDiamondRosterPage` treats a page with no
item list or no total as unreadable rather than as "0 Results" - which is rule
2 of the same section, not coercing an unreadable answer into an empty one.

How the screen was checked: not by looking at it. The rendering is pinned by
assertion, and the pins ran green in this pull request -
`tests/unit/diamondArenaCounts.test.ts` ("prints loading, a real zero and
unknown three different ways", "never turns something it cannot read into a
zero"), `tests/a-diamond-figure-is-real-or-it-is-unknown.law.test.ts`
("neither arena surface turns an unknown back into a zero", "a stored zero
never comes back as a figure somebody read") and
`tests/the-arena-knows-who-is-here.law.test.ts` ("answers online only while a
source shows the caller, and never a made-up zero"). 159 tests across the
sixteen Diamond Phase 10 files pass.

**Verdict: built, installed and proven live.** The one figure that cannot be
demonstrated from a server-side read is a non-NULL `online`, because proving
it needs a signed-in browser whose own Realtime feed is registered; the
witness rule is what makes that unprovable from here, and it is the rule
working rather than a gap.

## Line 4: staff game configuration, incident review and audited adjustments

Thirty-three functions named by the six migrations of September 29 are present
in `pg_proc`, and all six migration names are in
`supabase_migrations.schema_migrations`: `staff_run_a_diamond_game_on_the_record`
(20260929213000), `the_staff_diamond_cancellation_is_a_reviewed_lane_authority`
(20260929213100), `a_person_can_review_a_diamond_incident` (20260929211500),
`a_diamond_correction_settles_once` (20260929220000),
`staff_read_the_diamond_books` (20260929231500) and
`a_diamond_alarm_reaches_a_phone` (20260929210000).

**Every staff door records who used it.** Read from `pg_proc.prosrc`, each of
these calls `fn_poker_diamond_staff_audit` and reads `auth.uid()`:
`fn_poker_diamond_open_cash_table`, `_edit_cash_table`, `_close_cash_table`,
`_set_table_straddle`, `_set_table_run_it_twice`, `_set_table_bomb_pot`,
`_cancel_tournament`, `_remove_tournament_player`, plus
`_create_seat_first_board` and `_audit_tournament_created`. The audit's item 4
asked for the five doors that already existed to be brought in too; they were.

**Settling a correction is still refused by name, and that is correct.**
`ca_diamond_correction_source` holds 0 rows and `ca_diamond_adjustment_receipts`
holds 0 rows, so `fn_ca_diamond_adjustment_settle` refuses with
`diamond_correction_source_not_authorized`, which the staff desk prints as
"Not Settled: What Pays For A Diamond Correction Has Not Been Authorized Yet".
What pays for a Diamond correction is decision 2 of the September 21 audit and
is Dan's under CLAUDE.md 10.9. Propose, approve and reject exist; settle waits
on him. Nothing here invents an economic answer.

**The books read from a stored reading, and the reading is fresh.**
`ca_diamond_health_reading` holds one row, read at 2026-10-04 12:35:00 UTC,
three minutes before this audit's read. So `fn_ca_diamond_staff_books` answers
without waiting on the health report, and the reading it answers from is being
refreshed.

**What is NOT proven: the incident review door has never been used by a
person.** `ca_diamond_incident_events`, the append-only review trail, holds
**0 rows**. All 123 critical `ca_diamond_incidents` rows are resolved and the
last was filed 2026-10-03 19:35 UTC, but they were resolved by
`fn_ca_diamond_health_watch` resolving what it filed, not by a reviewer at the
desk. 7,230 warning rows are open, the oldest from 2026-09-03. So acknowledge,
comment, resolve-with-a-reason, reopen and close-a-rule-family are built,
granted and pinned by `tests/a-person-can-review-a-diamond-incident.law.test.ts`,
and none of them has been exercised in production. Who reviews Diamond
incidents is decision 5 of the September 21 audit and is still open.

**Verdict: built and installed; the configuration and adjustment doors are
proven by their audit wiring, the review door is proven only in isolation.**

### One residue worth recording, not fixed here

The September 21 audit found that two chip doors, `fn_request_manual_bomb_pot`
and `fn_update_table_bomb_settings`, authorize through `clubs.owner_id` or a
`club_members` role, have no Diamond branch, and so could let the arena's
owner account change a Diamond table's bomb settings without the checks or the
audit row of `fn_poker_diamond_set_table_bomb_pot`. Read today, neither
function has gained a Diamond branch - but the hole is shut anyway, by
`fn_poker_guard_arena_structure`, the trigger `poker_arena_table_guard` on
`public.tables` and `clubs`:

- a Diamond club whose `owner_id` is not exactly
  `00000000-0000-0000-0000-000000000001` is refused, "The Diamond Arena
  Belongs To The System", and production's arena holds exactly that sentinel,
  so no door that trusts a club's owner admits a person;
- a Diamond `club_members` row whose role is not `player` or whose status is
  not `automatic` is refused, so nobody can hold `owner`, `co_owner` or
  `admin` in the arena. Production holds one membership row, role `player`,
  status `automatic`;
- any structural `tables` or `tournaments` UPDATE on a Diamond row is refused
  for a caller who is neither `service_role` nor a platform admin, play-state
  columns excepted.

What remains is narrow and is not a hole: a platform admin who used a chip
screen on a Diamond table would write no Diamond audit row. Closing that
needs a Diamond branch in two chip doors, which needs a migration; it is
recorded here rather than built, because it is not reachable by anyone who is
not already platform staff and `apply_migration` is not available to this
lane.

## Line 5: financial push alerts, scoped, without arena-wide lockout

This line is proven by rows, which is the strongest evidence any of the three
has. `ca_drift_incidents` holds exactly two findings keyed `diamond-rule:%`:

| dedupe key                           | severity | currency | occurrences | first seen           | notify ledger rows | sent once at         |
| ------------------------------------ | -------- | -------- | ----------- | -------------------- | ------------------ | -------------------- |
| `diamond-rule:DR0:health_critical:1` | critical | diamonds | 29          | 2026-09-29 21:35 UTC | 1                  | 2026-09-29 21:35 UTC |
| `diamond-rule:DR0:health_critical:2` | critical | diamonds | 1           | 2026-10-03 19:35 UTC | 1                  | 2026-10-03 19:35 UTC |

Read that row by row, because it is the whole design working:

- **It pages once per episode.** Episode 1 folded 29 critical
  `ca_diamond_incidents` rows, filed hourly over two days, into one finding
  with one notify-ledger row and one send. A condition re-filed every hour
  paged a phone once.
- **The episode rotates after a person closes it.** Episode 1 resolved,
  episode 2 opened four days later and paged again. A key stable for the life
  of the rule would have paged once in its life.
- **It is worded in Diamonds.** `currency` is `diamonds` on both, which is
  what `fn_ca_raise_drift_incident` learning a currency was for.
- **Warnings never page.** No `diamond-rule:%` finding of any severity below
  critical exists, against 7,230 open Diamond warning rows.
- **The alarm has a reader, and the reader is named.** CLAUDE.md 10.86 rule 3
  requires it. Both sends went to `ca_incident_notify_ledger.recipient_id`
  `47965354-0e56-43ef-931c-ddaab82af765`, which is a real `profiles` row, is
  the `user_id` of the one `active` row in `ca_incident_recipients` (platform
  scope, `min_severity` `warning`, `senior`), and holds 60 rows in
  `push_subscriptions`. The two other recipient rows are inactive and received
  nothing.
- **Nothing locked the arena out.** `ca_arena_settings.cash_games_enabled` and
  `tournaments_enabled` are both still false and were not moved by any of
  this, and `tests/only-a-person-moves-the-arena-switches.law.test.ts` (item 9
  of the build list) passes: no migration defines a function that writes
  either column.

**Verdict: built, installed and proven live.**

## The defect this audit found, and the fix in this pull request

`tests/unit/diamondStaffDeskService.test.ts` is the guard that stops the staff
desk from calling an RPC by the wrong parameter name, which PostgREST answers
as a 404 the moment staff press a button. It read every door's latest
definition out of `supabase/migrations`, and it did that by scanning the whole
corpus once per door.

Measured in this worktree on 2026-10-04 at 5,093 migration files and 62 MB:
reading the corpus costs 1,960 ms and the regex passes over it another 213 ms.
The test finished in **4,652 ms of vitest's 5,000 ms default** - 93% of its
budget, 7% headroom, against a directory that only grows. Run alone it passed.
Run in a batch of sixteen files it **timed out**, and a timed-out test is not a
failing assertion: the assertion never ran at all. That is CLAUDE.md 10.86
rule 1, and raising the budget to the ceiling just read is the trap rule 4
names.

So the work was removed instead of the budget raised.
`tests/helpers/migrationCorpus.ts` gained `latestFunctionParams(names)`, which
walks the directory newest-first, reads a file only while a name is still
unanswered and skips the regex on any file whose text does not mention the
function. The first file that defines a name holds its latest definition, which
is the same answer an ascending whole-corpus pass gives. Measured through the
helper: **103 ms, 242 of 5,093 files read**, and the nine doors resolve to
byte-identical parameter lists. The test body now takes 4 ms and the file 938
ms end to end.

Before: 1 failed, 155 passed in a sixteen-file run, the failure being
`Test timed out in 5000ms`. After: **16 files, 159 tests, all passing in
2.86 s.** `npx tsc --noEmit` is clean,
`check-title-case`, `check-ui-text`, `check-painted-text-case` and
`check-nav-title-case` all pass, and `verify-source-bindings.py` reports all
796 pins across 16 binding files still hashing to their recorded bytes.

### The same trap, one level up, measured and not fixed

`tests/only-a-person-moves-the-arena-switches.law.test.ts` spends **2,036 ms**
of its 5,000 ms in one test, scanning the whole corpus for a migration that
writes an arena switch. That is 41% of its budget and it has 2.9 s of
headroom today. It is not the same defect - "does any migration do X" is a
whole-corpus question, and the memoised corpus read is already the cheapest
way to ask it - so `latestFunctionParams` does not apply and nothing was
changed. It is recorded with its measurement because the corpus grows by a few
hundred files a week, and whoever sees this one go red should know it was
already at 41% on 2026-10-04 rather than rediscover it as a flake.

## What this audit did not do

- It did not tick or edit a programme checkbox.
- It did not write to production, run DDL, or apply a migration.
- It did not build the Diamond branch for the two chip bomb doors.
- It did not exercise the incident review door, which needs a staff session
  and would write production rows.
- It did not prove a non-NULL `online` figure, which needs a signed-in browser.
