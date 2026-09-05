# 2026-09-05 - The lobby stops reloading under the player, a game is never x/y, and the ring is linear

Three of Dan's 2026-09-05 items, client only.

## 1. "FIX WHAT EVER BUG IS CAUSING THE CLUB ARENA GAME LOBBY PAGES TO RANDOMLY GLITCH AND RELOAD"

Measured, not guessed. `client_shell_telemetry` for the 24 hours before this
change: **91 distinct deployed bundles**, **115 shell reloads** for two users
(median page age 23 minutes, mean 67), and 7,984 `controllerchange`
staleness checks. Every publish made every visible lobby stale, and
`useShellUpdateGate` adopted the new bundle after a 3 s settle whenever the
page was visible and not a table - which, at ninety builds a day, is a reload
every twenty-odd minutes for anyone browsing. That is the "random" reload.

The bundle is not the problem; the moment is. `mayReloadForShell` now also
requires the player to have been AWAY from the page: no pointer, touch, key,
wheel or scroll input for `IDLE_BEFORE_RELOAD_MS` (5 minutes). A tab coming
back from hidden qualifies on its own (hidden tabs receive no input); the
startup window is unchanged (a stale boot restarts at once, before anything
is built); the resume probe still catches a days-old bundle - it waits for
the player to look away. `RELOAD_COOLDOWN_MS` 10 -> 30 minutes.

A second, smaller glitch on the same page: `get_club_home` (the fast path)
painted cluster rows with their game-wide figures, then the authoritative
chain select replaced every row ~300 ms later without them - feeder and
Main 2 rows leaked back onto the board and the style filter emptied, on every
load and every 90 s refresh. The chain now selects the cluster identity
columns itself and OVERLAYS onto the rows on screen (`mergeFastRows`),
removing only rows it no longer returns.

## 2. "ALL THE GAME CARDS ARE STILL SHOWING WRONG FOR FEEDER GAMES, THEY SHOULD NEVER BE 2/6 OR 9/9"

Same root cause as the leak above: with the cluster columns dropped, the
entry lost its `game` and printed the Main 1 table's own `x/y`. Fixed by the
overlay, and made impossible to regress: `PlaqueSeats` prints "N Playing ·
K Tables" for a game (no pips, no denominator), the pre-commit panel prints
"N In K Tables", the premium card adapter already printed a bare count for a
capacity-less entry. Pinned in
`tests/a-game-counts-its-players-like-a-tournament.law.test.ts`.

## 3. "FIX THE DISAPPEARING COUNTDOWN CLOCK TO ACTUALLY TAKE 15 FULL SECONDS TO DISAPPEAR, IT CURRENTLY TAKES EXACTLY HALF THE TIME"

The ring's animation has been 15 s since 2026-08-20 (every duration guard in
`SeatSlot.tsx` is real), and it still read as half the time because of the
easing added on 2026-08-21 for "slow down at the end":
`linear(0, 0.75 66.6%, 1)` spent three quarters of the arc in the first ten
seconds, so on a 3 px ring the visible band was a sliver by the halfway mark.
Every fix since floored the duration; the shape was the problem. The shrink
is **linear** now - the arc that is left is exactly the time that is left at
every second of the fifteen - and the five-second blink stays as the
end-of-clock cue. Pinned in `tests/seatslot-countdown-duration.test.tsx`.
