# 2026-08-29 — Round 14: the "errors" half of Dan's complaint, found and killed

Dan: "IT NEVER WORKS, **NEVER REGISTERS WITHOUT ERRORS**, AND THE SPIN
ANIMATION NEVER PLAYS." Round 13 explained the "never works" half (engine
restart windows starving the fill). This round chased the word **errors** —
and found a real, shipping defect on the Spin buy-in sheet.

## The bug: TWO 60-second buy-in timers, one of them broken

TablePage carried two independent 60-second buy-in windows. The second one
(the duplicate) did four things wrong, all visible to a player sitting on the
Spin confirm sheet:

1. **It navigated to a dead URL.** `navigate('/hub/club-arena')` — while the
   router's basename ALREADY is `/hub/club-arena` (src/main.tsx). React
   Router prepends the basename, so this resolved to
   `/hub/club-arena/hub/club-arena`, a route that does not exist. A player
   who lingered on the sheet was thrown to a broken page. This was the ONLY
   such call in all of src/ — verified by grep — so it is a one-off defect,
   not a pattern.
2. **It raised a red ERROR toast for a non-error**: "Buy-in timed out. You
   have been removed from the table." The player had not sat at any table,
   so it announced a removal that never happened, in error styling, for an
   ordinary timeout.
3. **On a CASH table it fired ALONGSIDE the real timer** — so a red error and
   a calm info toast both appeared, and two navigations raced for the
   destination.
4. **It used a bare `setTimeout`**, which a background tab throttles, so it
   could fire late against a sheet the player had already dealt with.

Why this matters more since round 9: the Spin sheet now carries the
multiplier odds ladder. Reading it is exactly the sort of thing that keeps a
player on the sheet past sixty seconds — straight into the broken exit.

## The fix

The duplicate is **deleted**. Dan's 60-second rule is unchanged and is now
enforced by the single surviving timer, which was always the correct one:
wall-clock (immune to background-tab throttling), shows a live countdown,
releases the optimistic seat, closes the table tab, uses an INFO toast, and
routes via `exitDestination()` to the real lobby (`/clubs/<id>` or `/`).
That timer now governs the seat-first sheet too, so Spins and cash share one
implementation instead of disagreeing.

**Enhancement:** the window is now VISIBLE on the Spin sheet — "Seat Held For
NNs", amber in the last ten seconds, `aria-live="polite"`. It has always
applied there; nothing on the sheet said so, and the player simply vanished
mid-decision. Counting down is the honest version.

## Verification

- 8 new pins in `tests/unit/oneBuyInWindowNoBrokenExit.test.ts`.
- Every pin asserts against **comment-stripped** source, because the deletion
  note quotes the old strings verbatim — a pin must never pass or fail on its
  author's own prose.
- The first run of that pin was itself caught by
  `noFixedSizeSourceWindows.test.ts` for using `slice(idx, idx + 600)`. Fixed
  structurally with `sliceEnclosingBlock`, not by weakening the guard.
- Spin-surface stub sweep: 0 TODO/FIXME/@ts-ignore across TablePage,
  spinSpec, spinReveal, lobbyEntries, GameLobbyPanel,
  TournamentRecurringService, TournamentManagerBase. SpinWheel confirmed
  rendered (L17403).
- tsc 0 errors client and server; full suites green.
