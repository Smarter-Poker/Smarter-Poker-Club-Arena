# 2026-08-28 — Seat-first lobby routing, client horse guard, and pre-start polish

Third pass of the day on Dan's spin report, after the pre-start live roster
(#1602) and the horse-loader tournament gate (#1618). This one closes the
remaining wiring holes found in a line-by-line sweep of the whole spin path,
and upgrades the pre-start experience.

## Fixed

1. **The lobby card's Sit Down ran the MTT register flow for spins.**
   LobbyTable wired every spin/sng row's Sit Down to `onRegister` — the Sign
   Up dialog, which charges the entry fee with no seat attached and dumps the
   player into a tournament lobby as a paid, seatless "Spectating" entrant.
   (The DB has refused that registration since PR #1620, which decayed the
   bug from "takes money" to "dead-ends on a cryptic toast".) Three layers
   now: LobbyTable routes seat-first cards (spin, or sng with 2 chairs) to a
   new `onSpinJoin`; ClubHomePage supplies it via spinQuickJoin; and
   handleRegister itself refuses seat-first rows and reroutes them, so any
   surface that regrows the old wiring lands on the right flow. Multi-seat
   SNGs keep the register flow — they are registration games.

2. **Watch / Return To Game on a spin card opened an MTT lobby screen.**
   Dan 2026-08-20: "there is 'no lobby' for a spin, you just start on a
   table." Spin and heads-up cards' view action now opens the game's live
   table through spinQuickJoin (stale ids and recycled siblings handled);
   MTTs and multi-seat SNGs keep their lobby screen.

3. **Client horse writes are refused at the service, not just the caller.**
   HydraService.seedTable now reads the table row and refuses any table with
   a tournament_id (or game_type 'tournament') before seating anything —
   #1618 gated TablePage's caller, but HorseOrchestrator also calls
   seedTable, and callers regrow. An unreadable table row refuses too.

4. **Every client "which table is this game on?" now asks the database's own
   election.** New TableService.resolveTournamentLiveTable delegates to
   fn_tournament_primary_table (occupancy first, oldest tie-break — the same
   choice the engine and the seating RPCs make), with newest-non-closed as
   the RPC-outage fallback. Rewired: spinQuickJoin's main lookup, its
   sibling hop, TablePage's stale-table recovery, and the recycled-table
   watch. A duplicate's empty newer table can no longer swallow a player.

## Improved

5. **No phantom level clock before the game exists.** A REGISTERING
   seat-first table used to fabricate "LEVEL 1 · 3:00" counting down from
   page-mount (level_started_at is NULL pre-start, and the fallback was
   Date.now()), restarting on every reload. The clock now starts when the
   level does: the mount effect requires a started level, and the pre-start
   roster channel starts the clock from the tournament row the moment its
   status leaves REGISTERING — which is also the only start signal level 1
   has (level_up broadcasts begin at level 2).

6. **The pre-start footer carries the fill state.** Spectator:
   "Spectating, Tap An Open Seat To Join · 2 Of 3 Seats Taken". Seated:
   "Seat Reserved, Waiting For 1 More Player", live, fed by the pre-start
   roster sync — the toast said it once, the footer now keeps it true.

## Pinned

tests/unit/seatFirstLobbyRouting.test.ts — the three routing layers, the
seat-first split matching fn_take_seat_and_buy_in, and the canonical
primary-table resolver at every client lookup site.

## Deliberately left open (flagged to Dan)

- Full removal of the client-side Hydra horse path on CASH tables (direct
  table_seats INSERT/DELETE from the browser, fabricated 100bb display
  stacks, client TURN_CHANGE horse actions). The server fleet owns horses
  everywhere now; this whole module is pre-migration legacy, but ripping it
  out touches live cash flows and deserves its own change with its own
  verification.
- Seated players at a pre-start table render face-down card fans (SeatSlot
  draws a fan for every 'active' non-hero seat with no hand-in-progress
  gate). Cosmetic; touching it means threading a new prop through SeatSlot's
  custom memo comparator under the animation law, so it is noted rather than
  smuggled into this change.
