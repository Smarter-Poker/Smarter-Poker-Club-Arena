# The wheel runs the way the other two do

**2026-09-11. Phase 5 of 6.**

Continues `docs/changelog/2026-09-11-the-player-can-see-the-day-and-the-way-out.md`.

Plinko has had Auto Drop and Crash Auto Play since 2026-09-10. The wheel, which
is the slowest of the three to press by hand because its landing takes five
seconds, had neither.

## One runner, not a second one

The danger in adding auto-play to a third game is that it becomes a second
runner: a loop with its own idea of when to press, its own idea of when to stop,
and its own bugs. There is one runner in this codebase, `autoRunVerdict`, and it
makes exactly one decision: wait, press, finish, or stop because the page would
refuse a thumb. The wheel calls it, presses `handleSpin` rather than reaching
for the service itself, and handles all four verdicts and no fifth thing.

The guard is the page's own blocker, not a watch built around it
(CLAUDE.md 10.12). A run stops on anything the page would print at a player: the
wheel paused, the platform in its break, the daily ceiling reached, the club
unable to cover a win, or the player out of diamonds. It also stops on a
refusal from the server and on a request that never answered, because a run
pressing into the dark is worse than one that stops.

## Two rules that are the wheel's alone

**A welcome spin is never auto-played.** It is once per member, ever, and it
costs nothing, so there is no run to make of it. The size cannot be cycled and a
run cannot be started while the wheel is on the house, and the primary plate
stays a single Welcome Spin.

**The wheel turns before a spin is counted.** Plinko and Crash finish a round at
the server. The wheel's result is decided at the server and then spun for five
seconds before the player sees it, so `busy` covers the animation as well as the
request, and the run counts a spin when it lands rather than when it is asked
for. The pause between spins is 1200ms: longer than Plinko's 700, shorter than
Crash's 1500. The landing itself is the wait; this is the beat to read the
prize under the pointer.

## What moved on the plate

The run plate takes the seat the Odds plate had, which is where Plinko and Crash
already put it. Odds was a scroll shortcut to a console that sits immediately
below this one, and the wheel was the only one of the three with it. It is not
gone: on a welcome spin, where a run is meaningless, the Odds plate keeps that
seat, so nothing is lost on the one screen that had no use for a run.

## Verified

The law holds the wheel to the shared runner, to stopping wherever a thumb would
be stopped, to never auto-playing a welcome spin, and to counting on the landing
rather than the request. Checked on the live page at 393px: the plates read Run
Off and Spin 100, and cycle to Run 5, 10, 25 and 50.
