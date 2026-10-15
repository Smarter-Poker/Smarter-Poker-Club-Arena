# A Table That Cannot Start Says Why, And A Dark Event Stays Paged

Date: 2026-10-15

## What Happened

The 100 Chip Guarantee Freeroll 6:00 AM (`a38b88a9`) sat RUNNING with 58 seated players and no hand from 2026-10-13 13:14 UTC for about 35 hours. All 8 of its tables were refused at every admission attempt, every 15 seconds, with `retained_hand_submission_pending: successor_financial_claim_spent`. That sentence only ever reached the engine console. `/health` listed the 8 tables as failing admission but not why, and after its first six hours nothing paged at all.

Two gaps, both fixed here:

1. **The refusal never left the process.** `reportError` is console-only, so the one fact that explains a frozen event could only be read with shell access to the engine host.
2. **The dark sweep went silent.** `rebuildManagersOfDarkTournaments` skips a manager admitted inside the dark window. The resume lane re-admitted this event's manager more often than that window, so every sweep read a fresh admission and skipped. After six hours it also deleted the event's rebuild record while the event was still dark, which stopped the "dark after rebuild" page for good.

## The Fix

- `TournamentManagerBase` keeps each failing table's last refusal (bounded, single line), clears it with the failure, and publishes it through `getTableAdmissionRefusals()`.
- `/health` `stalledTables` entries for a table failing admission now carry `refusal`.
- A table failing admission for 10 minutes raises one critical `Tournament.table_admission_failing` financial alert that names the refusal, deduplicated on the table (`table-admission-failing:<table>`), refreshed at most every 30 minutes. It is raised from the table's own retry path; nothing is retried, rebuilt or restarted because of it. Because admission starts failing the moment a restarted engine cannot bring a table back, this is also the post-restart resume check: every table that cannot resume after any engine restart pages within ten minutes with its reason.
- `GameServer` remembers when its dark sweep first read each event as dark. The "admitted recently" skip yields once the event has been dark for the whole window as the sweep has seen it, however often it was re-admitted. An event still dark keeps its rebuild record past six hours.

## Tests

- `server/src/aTableThatCannotStartSaysWhy.test.ts`: refusal kept, bounded and cleared with the failure; quiet before 10 minutes, pages at 10 with the refusal and the table dedupe key, refreshes only after 30; never pages a table that is not failing; wiring pinned.
- `server/src/aDarkEventReadmittedIsStillRebuilt.law.test.ts`: a re-admitted dark event is rebuilt once the sweep has seen it dark for the window; a still-dark event keeps its rebuild record past six hours and keeps paging; a recovered event is forgotten.
- Both files fail against the previous code (8 of 8) and pass with the fix. `server/src/aTableThatCannotBeAdmittedIsStalled.test.ts` now expects the `refusal` field.

The Freeroll's own cause (eight hands whose one successor settlement claim was spent by the `record "new" has no field "metadata"` defect) is fixed separately.
