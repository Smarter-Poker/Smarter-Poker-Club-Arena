# Phase 1 — the seat-truth contract: the client stops guessing how big the table is

2026-08-31. Follow-up to the seat-7 incident of the same morning (see
`2026-08-30-seat7-erased-from-snapshots-bb-never-visible.md`). That fix stopped
the client DROPPING a seat it had been told about. This one removes the guess
that made the drop possible, and adds the alarm that would have caught it.

## 1. The engine publishes `max_seats`

`tableState.maxPlayers` is seeded to 6 and corrected only when the client's own
`tables` row query lands — so for the opening seconds of every mount, and
indefinitely if that query failed or was RLS denied, a 9-max table was drawn as
a 6-max one. The engine has always held `tableInfo.max_players`; now it says so,
on BOTH payloads a client can receive (live broadcast and the idle
between-hands one — a seat-first joiner at a quiet table sees only the latter).

The mapper prefers it over both the caller's belief and its own occupied-seat
inference, because the inference has a blind spot the engine does not: it can
only see OCCUPIED seats, so a 9-max table with nobody past seat 4 still drew six
and the empty high seats were unclickable. One clamp remains absolute — a
published capacity may never drop a seat that holds a player. A ghost seat is
cosmetic; an erased hero costs somebody their stack.

Pinned by `server/src/engine/SeatCountIsPublished.test.ts` and five new cases in
`tests/unit/snapshotNeverDropsASeat.law.test.ts`.

## 2. `maxPlayers: 6 | 9` was a lie, and it disarmed the compiler

The estate holds 102,664 tables; **43,226 are 2, 3, 7 or 8-max** — a third of
the platform outside the type that claimed to describe it. Every assignment
therefore carried `as 6 | 9`, and a cast is not a check, it is an instruction to
stop looking. The one tool that could have caught a 9-max table rendering six
seats had been told at every site to ignore exactly that. The code already knew:
a comment at the heads-up guard admits the value "carries 2 at runtime".

Widened to `number` in `TableState`, `createEmptySeats` and `TableModalsLayer`;
all four casts deleted. `SEAT_LAYOUTS` has always defined 2 through 9, so not a
pixel moves — what it buys is that the next wrong seat count is a compile error.

## 3. The missing half of the hero-seat invariant

`TablePage` already asserts one direction — `players[]` holds the hero but
`heroSeat` disagrees — and self-heals. The opposite direction was silent, and it
is the exact shape of the incident: the engine's snapshot NAMED the hero at seat
7, the mapper dropped it, so `players[]` had no hero row and the existing
invariant could not fire, because it iterates the very array he was missing
from. Nothing noticed for ten minutes.

Now: engine names a seat for this user + client renders no such seat =
`reportError` (once per table/seat, so an alarm is not noise) and heal by
adopting the seat the server named. Deliberately stated on the OUTCOME rather
than any cause, so it fires for the next bug of this class — a mapping
regression, a bad merge, a stale reducer — none of which have been imagined yet.

## Verification

- Client: 678 test files, 9,790 tests, 0 failures. `tsc --noEmit` clean.
- Server: `SeatCountIsPublished` + `EntryStateSurvivesRestart` +
  `noUnhandledRejections` green (13). `tsc --noEmit` clean.
- `npm run build` exit 0 (`✓ built in 16.77s`).
