# 2026-08-31 — DEEPSTACK schedules never spawned; horse cap rejections mis-reported

Post-ship verification sweep of the MTT audit (PR #2004) found two live issues
in the engine logs.

## 1. 19 scheduled tournaments silently never ran

All schedules seeded 2026-08-25 with `blindPreset: "DEEPSTACK"` (Morning Grind
Deepstack, Five-Card Big Stack, Midweek Morning Stack, Wednesday PLO Stack,
Sunday Funday Six-Card Closer, +14 more) resolved no blind structure — the
preset map knew SLOW/STANDARD/TURBO/HYPER_TURBO/DEEP but not DEEPSTACK — so
`ScheduledTournamentService` skipped every spawn attempt with
`structure_missing`. Fixed with a `DEEPSTACK -> SLOW` alias (a deep stack IS
the slow structure) and pinned by `SchedulePresetAlias.guard.test.ts`, which
asserts every preset name production schedules use resolves, and that payout
presets sum to 100%.

## 2. Expected horse cap rejections reported as errors (57/10min)

`HorseFleetManager.seatHorse` quiets expected `atomic_table_buyin` rejections,
but its literal `TABLE_CAP_REACHED` never matched the RPC's real message
("FOUR TABLE LIMIT: user …", 23514). The in-memory 4-table filter counts only
cash seats this process sees while the RPC also counts tournament bookings, so
these rejections are ordinary seeding races. Added the real message to the
quiet list.
