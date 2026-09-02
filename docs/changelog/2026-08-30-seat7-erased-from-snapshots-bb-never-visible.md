# A seat the engine dealt that the client refused to see

2026-08-30. Dan's report, verbatim: "WAIT UNTIL BB IS NOT WORKING, IT NEVER
POSTS YOU IN THE BB, JUST SAYS YOU ARE SITTING OUT AND WILL BE DEALT IN NEXT
HAND AND NEVER DOES, THEN YOU GET BOOTED AFTER THE 5 MIN WINDOW."

## What actually happened (table 08746c1a, seat 7, 2026-08-31 00:27 UTC)

The engine did everything right. The player sat at 00:27:13; the big blind was
arriving at their seat, so the wait-for-BB release fired on the very next hand
(3769181 at 00:27:36): they were dealt in, their big blind was posted, the
table folded around and they WON the pot. Hand history proves all of it.

Their client showed none of it. `tableState.maxPlayers` boots at 6, and a
TablePage mounted without navigation state (multi-table screens, deep links)
keeps that default until the table-row load corrects it — and
`mapEngineSnapshot` dropped every seat above `maxSeats` on the floor
(`if (idx >= maxSeats) continue`). On a 9-max table, seat 7's own hero was
erased from every snapshot: no hole cards, no action bar, the footer stuck on
"Seat Reserved, You'll Be Dealt In Next Hand". The engine gave them turns
nobody could see, timed each one out, force-sat them out after three strikes
(00:32:5x — they vanish from deals at hand 3769389), and evicted the seat at
the five-minute mark (00:37:50). The player watched a reserved seat promise a
deal that, from where they sat, never came.

## The fixes

1. **mapEngineSnapshot never drops a seat** — the per-seat arrays now size
   themselves to the highest seat the snapshot actually carries
   (`effectiveMaxSeats`), whatever the caller believes `maxPlayers` is.
   Pinned by `tests/unit/snapshotNeverDropsASeat.law.test.ts`.
2. **The ring grows with the evidence** — both snapshot merge paths in
   TablePage now raise `maxPlayers` (grow-only) when the engine proves more
   seats exist, so seat geometry renders them; the GAME_START recovery path
   grows `updatedPlayers` instead of discarding high seats.
3. **entry_hold writes are ordered** (server) — the same incident left
   `entry_hold='waiting'` on a player the engine was dealing, because the
   register write and the release's clearing write are both fire-and-forget
   and landed out of order. `persistEntryHold` now chains writes per user, so
   a restart can no longer re-hold a player who already paid their way in.
   Pins in `EntryStateSurvivesRestart.test.ts` moved to the new mechanism in
   the same commit.

## Verification

- `tests/unit/snapshotNeverDropsASeat.law.test.ts` red on the old code
  (players.length 6, hero gone), green on the new.
- Client: 74 tests across the six suites that exercise mapEngineSnapshot all
  green; `npx tsc --noEmit` clean.
- Server: `EntryStateSurvivesRestart.test.ts` + `noUnhandledRejections.test.ts`
  green (10 tests); server `tsc --noEmit` clean.
