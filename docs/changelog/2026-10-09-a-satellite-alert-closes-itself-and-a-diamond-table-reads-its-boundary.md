# A Satellite Alert Closes Itself And A Diamond Table Reads Its Boundary

**Date:** 2026-10-09

## A Satellite Conservation Alert Is One Row Per Satellite

`FeeReconciler.satellite_conservation` raised a new CRITICAL on every hourly pass with no subject key. Between 2026-10-07 18:06 and 2026-10-08 15:01 UTC it wrote 22 open rows for three Diamond Arena "Sunday Deep Stack Satellite" events (7e56f752, ae199f83, e2ea5f2a) that had paid every winner through the Diamond ledger. Migration 20261008150323 taught `fn_satellite_conservation_audit` that a satellite conserved by its own receipt is not a violation, so it stopped flagging them, but nothing closed the rows it had written.

- Each flagged satellite now raises its own alert keyed `satellite-conservation:<id>`, so a standing condition is one open row.
- Every pass re-asks the same audit over 14 days about every satellite an open alert names, and closes the alert with a written resolution only when every satellite it names is COMPLETED inside that window and no longer reported. A satellite the audit could not read is never treated as proof.
- The check still moves no money.

Law: `server/src/services/aSatelliteConservationAlertClosesItself.law.test.ts`.

## A Diamond Cash Table's Refresh Reads What Its Boundary Checks

`refreshRakeConfig` re-reads a cash table's rules about once a minute and, for a Diamond table, asks `assertDiamondTable` whether the arena may keep dealing under them. The re-read did not select `game_variant`, `status`, the blinds or `bbj_percent`, which the boundary checks, so every refresh of every live Diamond cash table was refused as "Diamond Plain Cash Table Required" (about 800 log lines in six hours) and a permitted straddle or run it twice change never reached a running table until its next restart. The read now carries every column the boundary judges. The test derives that list from the boundary's own source, so a new check there that the read does not carry fails.

Test: `server/src/engine/aDiamondRefreshReadsWhatItsBoundaryChecks.test.ts`.

## A Refused Opening Horse Is Replaced

`seedOpenSeatTable` asked for exactly as many opening horses as a seat-first board opens with. A horse another tick had just taken to four games was refused with FOUR TABLE LIMIT (17 reports in six hours) and its seat opened empty. That refusal is the cap working, so it is no longer reported as an error, and the seat is offered to fresh candidates once, never past the opening count.

Test: `server/src/services/aRefusedOpenerIsReplaced.test.ts`.
