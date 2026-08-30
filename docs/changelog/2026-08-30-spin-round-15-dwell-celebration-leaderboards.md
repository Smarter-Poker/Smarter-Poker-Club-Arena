# Spin round 15 — partial-board dwell, tiered celebration, leaderboards, seat-first E2E

2026-08-30. Continues rounds 7-14 of the spin / seat-first sweep. Everything
here is inside the spin and seat-first path, per Dan's scope correction.

## 1. A partial board no longer sits for an hour (task 31)

**Measured first.** Across the seat-first games that reached a partial state,
dwell before the board either filled or died was:

| p50  | p90   | max             | over the 180s design ceiling |
| ---- | ----- | --------------- | ---------------------------- |
| 296s | 1608s | 6916s (115 min) | 222 / 330 (67%)              |

Two of three seats bought, one seat empty, and the game sitting there. From
the chair that is indistinguishable from "it never works" — which is exactly
what Dan reported.

`GameServer.fillHumanSeatFirstGame` (round 13) only topped a board up when it
could prove a HUMAN was waiting on it, which costs three reads per partial
game per pass and, worse, left a board whose registration window had already
CLOSED to sit forever if the only occupants were horses.

Renamed to `fillPartialSeatFirstGame`, now taking a `windowClosed` flag
computed from `start_time` on the row the fast lane already read:

```ts
const startMs = t.start_time ? Date.parse(String(t.start_time)) : NaN;
const windowClosed = Number.isFinite(startMs) && startMs <= Date.now();
```

A board past its own start time is topped up unconditionally — there is
nothing left to wait for. The human check remains for boards still inside
their window, where a fill would cut short a window a player might still
walk into.

## 2. The same change is the optimisation (task 32)

`windowClosed` short-circuits BEFORE the primary-table read, the occupant
read and the profile read, so the common case — a board past its window —
now costs zero extra reads instead of three, on every 5-second pass, for
every partial game on the platform. The top-up itself was extracted to
`topUpPartialSeatFirst` so both paths share one implementation and cannot
drift. The 12s per-game throttle and the 60s `seat_first_human_waiting`
escalation are unchanged.

## 3. A 100x no longer celebrates like a 2x (task 33)

The rarest event in the product had no moment of its own: flat 24 confetti
pieces for 25x, 50x and 100x alike; the same "JACKPOT SPIN" banner for 25x
and 50x; sound that differed only in VOLUME; and a 10x — 1 in 100 — got
nothing at all.

`spinCelebration(multiplier)` in `src/config/spinSpec.ts` (mirrored
byte-identical into `server/src/config/spinSpec.ts`) is now the single source
of intensity, and BOTH the wheel and SoundService derive from it:

| multiplier | band | confetti | banner        |
| ---------- | ---- | -------- | ------------- |
| 100x       | mega | 72       | MEGA JACKPOT  |
| 50x        | big  | 48       | SUPER JACKPOT |
| 25x        | big  | 32       | JACKPOT SPIN  |
| 10x        | mid  | 16       | BIG SPIN      |
| 2x-5x      | base | 0        | —             |

This closed a real drift: `SoundService.playSpinMultiplierResult` carried its
own hand-written ladder that stepped at 5x while the wheel stepped at 10x, so
the sound and the picture disagreed about what counted as a big win. It now
reads `spinCelebration(multiplier).soundLevel`.

**ANIMATION LAW (CLAUDE.md 10.6) — additive only.** Every band that
celebrated before celebrates at least as much (25x kept 24 pieces and gained
8); nothing is gated off; no cue is silenced; confetti duration scales with
`var(--animation-speed, 1)`; and `prefers-reduced-motion` stops the pulse
while keeping the banner readable — motion collapses, meaning does not.
Pinned by `tests/unit/tieredSpinCelebration.test.ts` (10) and the existing
Animation Law suite (74), all green.

## 4. Spin leaderboards (task 34)

Migration `20260830053746_spin_leaderboards.sql` adds
`fn_spin_leaderboards(p_days integer default 7)` — SECURITY DEFINER, pinned
search_path, revoked from `public, anon`, granted to
`authenticated, service_role`, with a post-apply assertion. It returns three
boards over the window: biggest hit, most spins, best net.

Aggregated in the database rather than the browser: at ~1,800 spins a day and
three seats each, a client-side version pages tens of thousands of rows to
rank ten names. That is the mistake round 12 removed from the results feed.

**HORSES ARE PLAYERS (CLAUDE.md 10.5).** There is deliberately no `is_horse`
filter anywhere in the function or the client. A leaderboard is precisely the
shape of code where somebody "tidies up" by hiding horses; the law says a
horse pays the same buy-in out of the same wallet and therefore ranks like
anybody else. Both halves are pinned.

Live against production on apply:

```
days: 7
biggest: RakeBandito  100x  buy-in 2.00 -> 16.00   2026-08-26T17:50:07
most:    KickerGrinder  1698 spins
net:     RiverWhale    +3603.00 over 487 spins
```

Client surface: a Spin Leaders block on the Spin view of
`TournamentResultsPage`, two tabs (Best Net / Most Spins), top three in gold,
names truncated rather than wrapping, counts via `toLocaleString`. The read
is error-bound and reports through `reportError` — the page is held at ZERO
discarded-error reads by `discardedErrorReadRatchet.test.ts`, and a failure
here must leave the block HIDDEN rather than showing an empty podium, which
reads as "nobody has played" to a player who spun forty times this week.

## 5. Seat-first E2E (task 35)

`tests/e2e/seat-first-entry.spec.ts` — the first real-browser coverage of the
flow Dan says never works. Rounds 13 and 14 fixed things no test in the repo
could see, because they are things a browser does over TIME: whether the
countdown counts, whether the sheet is reachable by clicking, whether the
seat underneath is hit-testable. jsdom lays nothing out and none of its
timers is a real second.

Five specs: the sheet opens from an open seat on a joinable spin; the
held-seat countdown ticks DOWN against wall-clock time and the sheet survives
it (the deleted duplicate timer navigated to
`/hub/club-arena/hub/club-arena` — a dead route — and the spec asserts that
URL can never come back); the multiplier ladder opens and every prize equals
`cost x multiplier` at the real stake; Cancel closes it and the seat can be
opened a second time (a stuck pending guard leaves the player on a table they
cannot enter, which is the same experience as "it never works"); the backdrop
dismisses without reaching anything underneath.

**It spends nothing.** CLAUDE.md 11.5 is binding. The debit is on exactly one
line — `commitSeatFirstBuyIn`, wired to `.seat-buyin-confirm__btn--go` and
nothing else. That locator is asserted to EXIST and is never clicked; every
spec exits through Cancel.

## 6. What the E2E found on its first real run — a cash price on a spin seat

Writing spec 5 paid for itself before it was even merged.

Running it against production, the walk landed on `1 Chip Spin PLO5` — a spin
whose buy-in is **one chip** — clicked its open seat, and got the **CASH**
buy-in modal:

```
BUY-IN   800 … 4,000     Min / Max / 40BB / 93BB / 146BB
( Account Balance: 495,817.23 )
```

Not one number on that sheet was true of the game. And it could not lead
anywhere: `fn_take_seat_and_buy_in` is the only sanctioned entry to a
seat-first game and the cash path never calls it.

`handleSeatClick` had exactly two outcomes — seat-first sheet if
`seatFirstBuyIn` is set, otherwise the cash modal priced off the table's
BLINDS. There was no third branch, so a TOURNAMENT table whose seat-first
sale was unavailable took the cash one. That is not an edge case:

- the game FILLS between the lobby click and the seat click (spins fill in
  seconds, and are recycled at roughly ten a minute — the table in question
  went 2/3 to 3/3 while the test was walking to it);
- the tournament read failed or was RLS-denied;
- the page mounted before the row flipped to REGISTERING.

This is Dan's report in its own words — "I STILL CAN'T EVEN SIT DOWN AND PLAY,
IT NEVER WORKS, NEVER REGISTERS WITHOUT ERRORS." A cash prompt for 800 chips
on a one-chip spin is precisely that from the chair, and it is worse than an
inert seat: the player is quoted a price, believes the game wants it, and
every path onward fails.

**Fixed:** the cash path is now closed to tournament tables. A table that is a
tournament by either measure (`isTournament` or a non-null `tournamentId`)
refuses, says _"This Seat Is Not For Sale Right Now"_, and reports
`TablePage.cash_path_on_tournament_seat` — because the guard makes the symptom
harmless without making the cause go away, and a guard that silences a bug
without counting it is how the original survived this long. Pinned by
`tests/unit/noCashPriceOnATournamentSeat.test.ts` (8), which holds the
control-flow ORDER: seat-first branch, then the guard, then cash. The E2E
asserts it too, on the path where it skips.

### Three ways the spec could only skip, and what each one was

Worth recording, because all three are the failure this directory has been
caught by before — a suite that reports green while asserting nothing:

1. the spin fleet is created against the UNION id, and `/clubs/<union-id>`
   redirects to `/unions/<id>` — a different page with no lobby on it at all.
   A member club's lobby is the surface that shows them;
2. the lobby opens on a game-type tab that is not SPINS, so the row selector
   matched nothing against a club holding 44 live spins;
3. the panel CTA is rendered through a text-transform, so its accessible name
   is literally `JOIN SPIN` — and Playwright does not fold case for a RegExp
   name.

Each cost a full round trip to diagnose because the log said only "5 skipped".
The helper now prints why it declined, every time.

## Verification

- `npx tsc --noEmit` — exit 0
- client vitest, server vitest — run SERIALLY (in parallel the server's 23s
  HorseLeague benchmarks starve the 5s CSS timeouts and produce two false
  failures)
- new pins: `spinLeaderboards.test.ts` (14), `tieredSpinCelebration.test.ts`
  (10)
- ratchets re-run and green: `discardedErrorReadRatchet`,
  `noFixedSizeSourceWindows`, `mySpinResultsDeepLink`
