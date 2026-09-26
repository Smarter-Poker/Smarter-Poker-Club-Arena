# server/src/maintenance/theGateSaysWhyItIsShut.law.test.ts

Tests: `server/src/maintenance/theGateSaysWhyItIsShut.law.test.ts`.

The restart gate can refuse a table for four different reasons, and it says
which one. `ServerTableEngineBase.maintenanceDurabilityReason()` names the
condition that is false — `accounting_unconfirmed`, `accounting_pending`,
`bank_park_write_incomplete` — or null, and `isMaintenanceStateDurable()` is
derived from it, so the boolean the gate reads and the reason an operator
reads can never disagree. `MaintenanceBreak` counts the reasons it refused
for and publishes them on `/health` as `unparkedReasons`; `/metrics` carries
them as `poker_maintenance_unparked_tables{reason}`, zero-seeded, so a rule
can read a reason before it has ever been the reason. A table with cards in
the air is counted once, under `cards_in_air`. An engine that publishes only
the boolean is counted under `unknown` rather than guessed at, a stopped
engine is not the gate's business, and an engine that throws on inspection
never becomes a reason.

Seven cases. Written 2026-09-18, after the gate stayed shut through five
consecutive breaks — 3, 16, 22 and 22 unparked tables — while the engine went
eight hours without a release and the only published number was the count.

Extended 2026-09-25, when 154 terminal tournament engines on 778075b4 held
`stopped_bank_custody_unconfirmed` with no bound and every break since 15:59
UTC certified no restart: the stopped-bank class is bounded exactly like the
F06 class, through one shared helper and the same `F06_UNRESOLVED_GATE_MS`.
Inside the bound the raw reason still holds the gate; past it the table is
counted under `stopped_bank_custody_stuck`, in the same stuck counter, and
stops holding the certificate; a custody that clears drops its clock so a
fresh custody gets the full gate; and the two classes keep separate clocks on
the same table. Six cases.
