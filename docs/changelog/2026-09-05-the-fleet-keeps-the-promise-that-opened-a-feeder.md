# 2026-09-05 — The fleet keeps the promise that opened a feeder (deep dive, 04:00–05:00 UTC)

Operation Table Stakes, picking up after `2026-09-05-the-must-move-lobby.md`
and the Gate 5–7 branch (`feat/gate-5-the-snapshot-is-the-rule`, PR #3066,
`docs/HANDOFF-TABLE-STAKES-GATE-7.md`). Dan: "DO A DEEP DIVE AND BUG HUNT ON
EVERYTHING YOU'VE BUILT TODAY ... THE WAY THAT THE FEEDER GAMES START,
ADVANCE, MOVE PLAYERS, EXPAND TO MORE PLAYERS, HOW THE LIST WORKS, WHERE THE
LIST IS LOCATED." Everything below was read from production rows, the live
function bodies, the engine's own `/health`, the host's supervisor journal
and the browser, not from the tests.

## What production looked like at 04:08 UTC

119 enabled games (115 ticking inside 30 s), 146 open cluster tables, 325
seated, 0 seats on closed tables, 0 stale flags, 74 moves done in two hours.
The corner box is on every must-move table (MUST MOVE · Lobby · Players ·
Tables) where the tournament level bar sits, and it opens the lobby with
every table, every chair and stack, the list and the seat change. The list
is in the right place.

## BUG 9 — a feeder opened, nobody came, abandoned, reopened (fleet, this PR)

`feeder_opened x36`, `feeder_abandoned x31`, `feeder_live x2` in two hours.
PLO4 0.10/0.25 Classic (Midway Union): 10 opened, 10 abandoned. The tick
opens a feeder only when Main 1 is full AND the fleet has just reported two
or more horses that could sit in the game. The fleet then ranked that feeder
LAST among cluster tables (`clusterRank`: feeder = 1000), behind ~140 tables
competing for a cycle that fills 1–5 seats in 24–30 s; and when it did reach
it, `occupancyTargetFor` gave a sparse table a vibe target of `1 + hash %
max` — which can be 1. One horse, a table that cannot deal, the horse
must-moved to the next Main chair, an empty feeder abandoned at three
minutes, OPEN two minutes later. Games could not grow past Main 1.

Fix (`HorseFleetManager.ts`): an `opening` feeder ranks before every other
table (the fleet promised the buyers; it seats them first), its target is at
least two, and the 1–2 trickle cannot leave it at one. A live feeder still
ranks after the mains, as before. Pinned in
`TheTablesOpenAndCloseThemselves.law.test.ts`.

## BUG 10 — the one-buyer hold re-armed every 70 s (SQL, applied 04:24)

Main 1 full, one buyer: `table_opening_hold`, 60 s, `_expired`, ten seconds
later `table_opening_hold` again — 24 event rows in 20 minutes on one game,
~2,500 a day per game in that state. `20260905041557`: an expired hold rests
five minutes (`cash_games.opening_hold_rested_until`). Two buyers still open
a feeder at once. Patched into the live tick body by substring with a
once-only assertion, because the live body (md5 `f2b83050…`) belongs to the
Gate 5 branch and is ahead of the last file on main; a full redefinition from
either side would clobber the other. **Whoever next writes the full tick
body to a file must carry the rest** (the migration's assertion is the pin).

## BUG 11 — the must-move list answered a browser with no account (SQL, applied 04:24)

`fn_cash_game_must_move_list` (#3055) is SECURITY DEFINER, executable by
`authenticated`, and never read who was asking — the shape
`check-telemetry-exposure.mjs` refuses, so **Telemetry Exposure failed on
every pull request since #3055 merged**. The list is meant to be posted
(Dan), so it stays readable by a signed-in caller or the engine; a caller
with no account gets the empty list. Probed as `authenticated` with and
without a JWT `sub`, and as `service_role`: 0 / 7 / 7 rows.

## BUG 12 — the lobby was unreadable on the light theme (client, this PR)

Opened live: game name, every player name, every stack and every count in
`rgb(26,46,26)` on a near-black panel. `MustMoveLobbyModal` borrows the
tournament lobby's `.tlm-panel`, and both read `--text-primary` /
`--text-secondary` / `--text-muted` from the APP theme; this account is on
`data-color-theme="light"`. The panel now re-declares its ink tokens — a dark
surface owns its ink — which fixes the tournament lobby for light-theme
accounts too.

## BUG 13 — the big masthead line clipped (client, this PR)

On a 1280×720 window the portrait felt gives the masthead a 127 px box, and
"NLH 0.10/0.25" at 0.98rem read "NLH 0.10/0....". The box is an inline-size
container now and the row is `clamp(0.6rem, 10.5cqw, 0.98rem)`: 13.3 px in
that box, fits with room, 15.7 px wherever the box allows. And the 375 px
override (`.table-brand__line { font-size: 0.44rem }`) was written after the
rows' own sizes at equal specificity, so on a phone the style badge and the
rules row were 7 px — the other agent's "placard squash". Each row keeps its
own step in that block now.

## Main was red, and how (separate PR: `fix/main-is-red-the-deploy-pins-follow-the-gate`)

Every pull request after 04:02 UTC failed `Client Unit Tests`. #3070 rewrote
`auto-deploy-hetzner.yml` (a sized poll and a :35 tick — right) and five pins
in three unit files still described the 56 × 15 s poll and the :45 tick. It
merged because a workflow-only diff made `ci.yml`'s `changes` job skip the
unit suite that reads the workflow, and the ruleset counts a skipped required
check as green. The pins now describe the new gate; `changes` treats any file
under `.github/workflows/` as touching everything.

The `CSS Beat E2E` red on the same runs (Table Studio, `cards_id` expected
`royal`) passed 4/4 locally against the same commit and passed on the run
three minutes earlier: fourteen pull-request runs launched at 04:01 and the
runners were saturated. Not a code defect.

## Found and recorded, not built tonight

- **The engine is on `dbe3c513` (02:55).** Every deploy since (03:17, 03:54,
  04:17) waited for the break, gave up 23 s before it and reported success —
  #3070's exact defect. #3070 changed only the workflow, so no run is queued;
  the next `server/**` merge (this branch) is the first candidate for a :55
  cutover. Until then the engine halves of #3055 (swap, held, entry by
  reason) and #3063 (bomb-pot VPIP, the `vpip_evicted` leave mode) are not
  running. Every move that expired tonight (18) expired at 04:00–04:04.
- **The engine died at 04:05 with no deploy and no break.** `/health`
  liveness went `dead` (supervisor 1/3 at 04:05:36, 2/3 at 04:06:36),
  `sp-autoheal` restarted the container at 04:07:05 on the same image. The
  log before it: tournament table engines declared dead and rebuilt (14×,
  12×, 7×…), `release_dead_tournament_seats exceeded 20s`, dealing loops
  "cycling without dealing". 318 tables and 402 tournaments on one core,
  resumed together by the 04:00 thaw. The equity governor read scale 1,
  p99 53 ms twenty minutes later. Engine-restart programme territory
  (`docs/HANDOFF_CURRENT_STATE.md`); recorded here because it is the largest
  thing that happened to the felt tonight.
- **Gate 7 is Dan's call** (`docs/HANDOFF-TABLE-STAKES-GATE-7.md`): who opens a
  cash table on the host clubs — the Stable Hand or the controller. Option A
  is recommended there and I agree with it.
- Still owed from the must-move lobby: horses using the seat change like
  humans (10.5: same button, same once, same list); presence not carried
  across a move; a "moving in N hands" countdown; the break/fleet fight (the
  fleet refills a chair inside 30 s, so the five-minute break window rarely
  completes while horses are available — by orbit, as the OPORD intends, is
  the fix).
