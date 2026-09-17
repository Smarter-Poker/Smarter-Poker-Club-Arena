# The marks, the runs, and the week

**2026-09-10. Dan, on the three Diamond Games, asked what to do next: "THERE
IS NOTHING FOR ME... THIS IS ALL YOU... AND YES DO ALL OF THIS: the other
fifteen wireframe icons cut as 3D marks, repeat-bet and auto-drop on Plinko
and Crash, and a 'biggest wins this week' section on the floor."**

Continues `docs/changelog/2026-09-09-the-wheel-gives-a-free-spin-a-day.md`.

## The marks

Every club icon was a 1.8px `currentColor` stroke on `fill: none`, a
wireframe, sitting in a bevelled steel plate with rivets and a lit LED. Dan
circled the diamond on 2026-09-09 ("NOT WHAT EVER THIS FLAT BORING BROKEN
THING IS") and it was recut as a faceted stone that day. The other fourteen
are cut now, from one recipe, in the console's own emblem language, the one
the spade crest and the diamond bezel already speak: a bevelled polished
chrome outline, a dark gunmetal body, blue light bouncing off the lower
edge, lit from the top left like the plate around it.

Each mark is six layers over its own silhouette (`marks.json`): the
extrusion (the silhouette again, offset down and right, near black, so the
object has thickness), the body with the chrome rim painted as a stroke
under the fill so the rim is a crisp band, a radial blue underlight clipped
to the silhouette, a soft black groove where the face meets the rim so the
rim reads as raised, a top-left sheen, and the details in chrome and blue
glass: the bank's pillars, the vault's dial and spokes, the wallet's clasp,
the gear's hub, the rabbit's ears. The stats mark's bars are blue glass, the
way the wheel's blue segments are. Nothing is an outline. What makes them
read as three dimensions at 20px is that the rim, the face and the extrusion
carry three different values and the light comes from one place.

There is no wireframe left to fall through to; `tsc` refuses an icon name
without a mark, and the unit test checks every icon renders as one with no
`currentColor` in it and no shared gradient ids between two on a page.

## Auto Drop and Auto Play

Repeat-bet was already the plate: Drop and Start keep the bet, the board and
the auto cash-out, so the second round is one tap. What was missing was the
run. The steel plate now sets one (Off, 5, 10, 25, 50) and the blue plate
starts it; while it runs the steel plate says Stop and the blue plate counts
the round.

The runner decides exactly one thing (`src/utils/autoRun.ts`): whether the
page would let a thumb press the plate right now. It waits while a ball is
falling or a curve is climbing, waits until a fresh sealed commit is in hand
(the spent one is cleared the moment a round lands, so nothing can press on
a dead ticket), waits out the pause between rounds the host has set, presses
after a beat so the last result can be read, and stops on the page's own
blocker with the reason (the diamonds run out, the day's limit, the bank
cannot cover a win at that bet, the wheel closed). Every round in a run is
its own server round with its own commit; nothing is decided any faster and
nothing is decided in the browser. Crash's Auto Play needs an auto cash-out
set before it will start, because the page will not be the one deciding
when to leave a climb; the server settles every round at the target that
was set when the run began. A manual cash-out mid-run cashes that round and
the run goes on. Leaving the page ends the run with it.

10.12 is respected: the runner is not a watch around the games, it is the
page's own blocker read once more before every press.

## The week on the floor

A recent win is small more often than not; the biggest of the week is what
a player remembers and what a floor shouts about. `fn_diamond_game_floor`
now also returns `top_week`: the same rounds, over the last seven days, the
five that paid the most, named the same way (`fn_arena_name` and the arena
avatar, never a user id, never a horse flag, certification rounds out). The
lobby prints them under "This Week / Biggest Wins" with their position,
straight after the balances, and the recent wins move under the three
games. Migration `20260910183806_the_floor_remembers_the_week`, dry-run with
a rolled-back probe (shape, order, the seven-day bound, no leaked fields, at
most five) before it was applied and registered. The service reads an older
floor without `top_week` as an empty week, not a crash.

## Gates

`check-ui-text`, `check-title-case`, `check-painted-text-case`,
`check-nav-title-case`, `tsc`, the new unit tests (`clubMarks`, `autoRun`,
`gameFloor`), every test naming a touched file, and the full vitest suite.
