# The Diamond Satellite Seat Door Is Executed, Not Only Pinned

October 4, 2026. Phase 9 of the Diamond Arena programme, the satellite line.
Behind the switch: `tournaments_enabled` is false and stays false. No migration,
no production write, no economics.

## What was wrong

The Diamond satellite line was built and applied on September 29
(`20260929161500 a_diamond_satellite_seat_is_a_whole_ticket`, PR #5607) and it
delivers a seat through a new owner-only door,
`fn_poker_diamond_tournament_seat_transfer`. Every rule that door carries was
held by `tests/a-diamond-satellite-seat-is-a-whole-ticket.law.test.ts`, and that
test reads the migration's own text.

A text pin proves the migration said something. It does not prove the installed
door does it. Measured on October 4: no fixture under `tests/sql/` called this
door at all, and the door's body was not in either Diamond tournament capture -
only its name, in the guard watchlist. The only time the door had ever run was
one rolled-back production rehearsal on September 29, which is evidence but not
a gate: nothing would have caught a later edit that changed what it refuses.

The divider is the part that matters most. A Diamond is indivisible, and a
satellite is where the question bites hardest: it awards whole seats and pays
the remainder as cash, so the door's first test is that the ticket, the prize
part and the fee part are each whole Diamonds and that the parts add up to the
ticket exactly. That test had never been executed.

## What changed

The installed door joined the Diamond tournament lifecycle capture as its
forty-second door, transported from production by a read-only
`pg_get_functiondef()` and md5-pinned like every other one: md5
`3c7b92f5f29c7440fec5d8e82f4e4018`, 10,047 bytes, owner `postgres`. The
transport was proved lossless rather than assumed - the bytes were carried as
base64 and the decoded length and md5 re-checked against what production
reported. Production grants EXECUTE on this door to nobody but its owner, and
the capture keeps it that way with the same `REVOKE ALL ... FROM PUBLIC, anon,
authenticated, service_role` every other captured door carries.

Case 14 of `tests/sql/diamond-tournament-lifecycle-cases.sql` then calls the
door fourteen times on an isolated PostgreSQL 17 cluster and reads back what it
refused:

| Reached by name                                        | Ways | What it is                                                                                                 |
| ------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------- |
| `diamond_satellite_seat_requires_whole_parts`          | 6    | the divider: a fractional ticket, prize or fee; whole parts that do not add up; a seat for nothing; no key |
| `diamond_satellite_seat_requires_two_diamond_events`   | 2    | assets never cross, at either end                                                                          |
| `diamond_satellite_seat_names_another_target`          | 2    | another Diamond event, and a bounty event, refused at the target gate                                      |
| `diamond_satellite_seat_is_not_the_target_entry`       | 1    | the right target, whole parts that add up, prize and fee swapped                                           |
| `diamond_satellite_seat_has_no_qualifier_registration` | 1    | everything correct and no registration to fund                                                             |
| `diamond_tournament_entry_already_held`                | 1    | duplicate qualification: the qualifier already holds the target's entry                                    |
| `poker_diamond_one_open_entry`                         | 1    | and the schema's partial unique index refuses a second open entry even if a door forgot to                 |

Each one is proved to have moved nothing: the ledger, custody, movement,
journal and wallet totals are snapshotted before the case and re-read after it,
and the fixture's own closing block still finds both switches closed, every
synthetic wallet holding exactly its signup grant, and no arena journal row.

The law test now pins that arrangement too, so a future change cannot drop the
door from the capture or delete a case and still pass. That was proved by
breaking it: with the duplicate-qualification refusal removed from the cases,
the law test fails with `the fixture must reach
diamond_tournament_entry_already_held`; restored, it passes.

## No number here is invented

Every ticket, prize and fee in case 14 is read back from the target row the
create door wrote earlier in the same file - 20 Diamonds, 18 prize and 2 fee,
computed by the installed door from the estate's own committed native MTT
inputs (`scripts/ci/probes/mtt-dual-creation-preparation-native.sql`, buyIn 20)
and the installed fee floor. The four events case 14 uses are the same
committed configurations case 9 uses, under their own names. Nothing is a
price, a guarantee or a ladder, and nothing states what any future event owes
anybody.

## What this does NOT prove

The funded delivery itself is still not executed here. A seat needs a prize
bank; a Diamond prize bank is filled only through an entry door that refuses
while `tournaments_enabled` is false (case 6 is that refusal); and no fixture
this runner loads may open an arena switch - `tests/the-diamond-tournament-lifecycle-runs-the-installed-doors.law.test.ts`
refuses it, and the switch is Dan's. So the custody-to-custody movement, the
ledger row on each side and the untouched wallet remain proved by the
rolled-back production rehearsal under
`docs/evidence/diamond-phase-9-funded-conservation/`, not by CI.

Case 14 also does not reach the entry test's own bounty clause: the target gate
refuses a bounty event before the format is read. The swapped-parts call is
what reaches that test, and the case says so in its own comment rather than
claiming the bounty rule.

No programme checklist line is newly claimed by this change. The satellite line
was already ticked on September 29; this makes its door's refusals a repeatable
gate instead of a text pin plus a one-off rehearsal.

## Files

- `tests/sql/diamond-tournament-lifecycle-doors.sql` - the door, its md5 pin,
  its line in the file's own proof list, and the declared count 41 to 42
- `tests/sql/diamond-tournament-lifecycle-doors.manifest.json` - its manifest
  entry with its provenance, and the refresh note
- `tests/sql/diamond-tournament-lifecycle-cases.sql` - case 14
- `tests/a-diamond-satellite-seat-is-a-whole-ticket.law.test.ts` - the new
  assertion that the fixture executes the door and reaches each refusal
- `docs/laws.d/a-diamond-satellite-seat-is-a-whole-ticket.md` - the law's own
  words for what was added, and what is still not executed
- `tests/sql/diamond-tournament-doors.README.md` - the door count, and a section
  saying what case 14 proves and what it does not. One stale figure in the table
  it edits was corrected at the same time: that file still said the second
  capture installs "nine" `tournaments` triggers, where its own manifest and
  proof block have recorded eleven since the September 29 refresh.

## Verified

- `python3 tests/sql/run-diamond-tournament-lifecycle.py` - passes; all 121
  captured doors install, every new assertion reports PASS, and both arena
  switches are closed when the cases finish
- `npx vitest run` on the four affected test files - 134 passed, and 775 in the
  law registry
- `python3 scripts/ci/verify-source-bindings.py` - 796 pins across 16 binding
  files unchanged; no `source-binding.json` pins any file this change touches,
  so no pin was restamped
- `node scripts/ci/check-diamond-runners-listed.mjs` - 24 Diamond runners, all
  run by CI. No runner was added, so no count moved
- `scripts/ci/classify-ci-changes.mjs` already routes all three changed fixture
  paths to the job that executes them, through its existing
  `diamond-tournament-[a-z0-9-]+\.(sql|manifest\.json)` patterns. No routing
  change was needed
