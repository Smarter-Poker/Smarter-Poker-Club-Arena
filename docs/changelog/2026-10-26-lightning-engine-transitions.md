# 2026-10-26 - Lightning: faster, safer hand to hand in the engine (transition phase 4 of 5)

Engine only (`server/`). No client file, no migration. Ships in the daily 04:00 Chicago
engine window like any engine change.

## 1. Every showdown is held long enough to see the pot pushed

**What a player saw.** At a Lightning showdown that was not all in, the winner's pot push
and "+N" were often cut off: the next hand was dealt over the top of them.

**Why.** The Lightning host held the full end-of-hand time only for all-in showdowns. Any
other showdown settled the moment the pot was paid, settlement released the players, and a
fast next deal replaced the felt mid-animation (Animation Law, CLAUDE.md 10.6).

**What changed.** Every Lightning hand that reaches a showdown (two or more hands shown, the
physical engine's own test) now holds the physical tables' own end-of-hand hold
(`handCompletionHoldMs`) before settling and freeing anyone. All-in showdowns keep exactly the
hold they already had. A hand won without a showdown is still not held.

## 2. The first player to act gets their whole clock

**What a player saw.** The first player to act in a Lightning hand saw their clock already
about 1.5 s down when their buttons appeared.

**Why.** The client holds the action buttons until the deal has been shown (the dealer button
glides for 700 ms, then the cards fly: about 2 s at a 6-max table). The engine started the
first turn clock 400 ms after the deal.

**What changed.** No Lightning turn clock starts until the client's deal presentation is over.
The engine works that length out from the client's own deal numbers
(`server/src/lightning/LightningDealPresentation.ts`), and a test reads the client's
`DealAnimation.tsx` and `TablePage.tsx` and fails if either side changes without the other.
Horses wait exactly the same: a horse's decision is not even asked for until the deal is shown.
Physical tables are unchanged (they still start at 400 ms, by the 2026-09-07 ruling).

## 3. "Lightning Is Ending" no longer sticks on a tab that missed the all-clear

**What a player saw.** A tab could keep showing "Lightning Is Ending" for a Cluster that was
forming hands again.

**Why.** When a hold ends the engine sends one `status: null` frame. On reconnect/RESYNC it
re-sent the status only when there was one, so a tab that missed that single frame was never
told again.

**What changed.** RESYNC always re-sends the Cluster's current status, null included.

## 4. A converted or returning player is not dealt in before they open Lightning

**What a player saw.** Right after MUST MOVE turned into Lightning (or after sitting back in,
or re-entering), players were dealt Lightning hands before they had opened the Lightning room,
and lost blinds to the turn clock. Production: first hand 7.8-9.9 s after entry, folded by the
clock at 41-47 s.

**Why.** The matcher's presence feed counted a socket on the player's ANCHOR table as present.
That socket cannot see or act in a Lightning hand; the hand is played in the player's own
pool-session room.

**What changed.** For matching, a player is present only through the device that plays their
Lightning seat: a person's room socket, a horse's anchor engine (its input device, CLAUDE.md
10.5 item 2). The anchor engine's report now says which seats it is the input device of; the
rule itself has no horse branch. Unknown is still never dealt. The presence door (the reaper's
clock, the boot reconciliation) keeps its old "connected anywhere" view, so nobody is reported
away while an engine still sees them. A room whose Cluster could not be read at admission now
learns it when its socket arrives, so the new rule cannot strand anyone.

## 5. A sat-out Lightning player is on the cash sit-out clock

**What a player saw.** A Lightning player who sat out kept their seat and chips forever (one
sat out for 7 h 45 min).

**Why.** A Lightning player sits out at their anchor seat, and the anchor is parked by the
dealing halt for as long as the Cluster is Lightning. The cash 5-minute sit-out sweep never ran
there.

**What changed.** The parked anchor of a Cluster that IS Lightning runs the cash rule exactly:
the same 5-minute clock (`DisconnectEngine.SITOUT_MAX_MS`; no button passes at a parked table,
as at any quiet cash table), the same thaw across the maintenance freeze (`sit_out_at` is moved
by `fn_thaw_platform`, and the in-memory clock is thawed the same way), the same
`isMaintenanceFrozen()` gates and the same eviction: the ordinary system cash-out into the club
wallet and `seat_left` 'sit_out_timeout'. The seat's departure ends the pool session (the
existing anchor-seat trigger) and the room closes with the existing "Your Lightning Session Has
Ended". Only the sit-out clock runs: the away and abandoned-seat rules read the anchor's
sockets, and a Lightning player plays in their room. It never runs while a conversion is still
counting its population: it acts only after the Cluster's row reads 'lightning'. The halt law
(`AHaltedTableFinishesItsHandAndDealsNoOther`) records this one exception. Horses and humans
alike.

## 6. A formed hand reaches the felt sooner

**Why.** `match_to_hand` was about 1.74 s at p50, mostly fixed overhead in the host's start.

**What changed.**

- The host table's rules are read alongside `begin_dealing`, for the front table the supervisor
  already knows. `bind_hand_number` stays the authority: a hint it does not confirm is discarded
  and the bound table is read.
- The club rake defaults now ride `loadTable`'s existing club embed; the separate `clubs` read is
  gone.
- The formation's time banks are asked for at the start too.
- Every step of the start is now timestamped (`LightningStartTiming`), with the event loop's own
  delay, so the next measurement can tell event-loop lag from database time. A slow start logs
  one bounded `[LightningStartTiming]` line; nothing of the hand is recorded.
- NOT DONE: merging `bind_hand_number` into `begin_dealing`. It needs a migration that rewrites a
  hot dealing function with an md5 guard on its current production body, which cannot be read
  from here without a database tool this phase is not allowed to use. Skipped rather than shipped
  blind.

## 7. Freed sooner after settlement

**What changed.** Once a settlement commits and the boundary's auto-rebuy and horse top-up asks
have answered, the hand's players are released (their time banks handed back first) and the
Cluster is woken at once, before the post-commit drain (which can retry for up to 15 s) and the
hand-history receipt. Each horse's top-up request now goes out at the same moment as every other
horse's, through the same path; one horse's failure no longer holds up another's.

Not moved before the boundary asks: the database refuses an auto-rebuy for a player who is
already in a hand, and a boundary gets one attempt, so waking the matcher first could cost a
short-stacked player their rebuy.

## 8. A new player's first hand reads their time bank in one round trip

The allowance and the durable bank are asked together, and the durable bank's two reads (open
pool sessions, the players' live seats) go together, keeping only the seat each open session
anchors.

## Not changed

The 3-second five-player wait, the mode-switch thresholds and dwell (phase 5), any client file,
any money path.

## Tests

New: `server/src/lightning/LightningHandToHand.test.ts` (deal wait, start path, settled wake,
bank reads), `LightningPresentInTheRoom.test.ts`, `LightningHorseTopUpTogether.test.ts`,
`LightningHostRulesOneRead.test.ts`, `server/src/services/supabase/lightningAnchorTimeBanks.test.ts`,
`server/src/engine/aSatOutLightningPlayerIsOnTheCashSitOutClock.test.ts`; two new cases in
`LightningShowdownHold.test.ts`, two in `tables.killSettings.test.ts`, one in the halt law.

Updated because the behaviour they pinned changed on purpose: `LightningPhase13RolloutDrain.test.ts`
and `LightningPhase8SessionApp.test.ts` (RESYNC now re-sends a null status),
`LightningShadowWorker.test.ts` and `AHorsePlaysFourLightningGamesLikeADesktop.law.test.ts` (the
anchor report carries `inputDevice`).

## Five-player hands wait one second (Dan, 2026-10-26)

Dan approved: "five-player Lightning hands wait 1 second". Six ready players
still deal at once and fewer than five never deal; exactly five now wait ONE
second (was three) from the fifth player becoming ready. Measured before the
change: five-player hands were about 14% of all Lightning hands, and their
last-freed-to-reserved time was 3.4 s p50 against 0.3 s for six.

- Database: `20261026131624_lightning_five_ready_players_wait_one_second_for_a_sixth.sql`
  rewrites the five `interval '3 seconds'` sites in `fn_lightning_match_plan`
  (3), `fn_lightning_form_hand` (1) and `fn_lightning_formation_sizes` (1),
  refusing any image that does not hold exactly those sites. It takes no table
  lock and installs on merge. The rewrite was checked against the live images
  by a read-only SELECT (counts before and after, nothing left at three
  seconds), and the file itself was run on a scratch PostgreSQL: one second
  forms five, half a second does not, grants are kept, and a second run refuses.
- Engine: `LIGHTNING_FORMATION_MAX_WAIT_MS` 3,000 to 1,000, so the worker's
  deadline pass and the TypeScript port agree with the database. It is live
  with this engine at the daily 04:00 window; until then the database decides
  and the worker's ordinary one-second passes pick the groups up.
- The matcher parity harness installs the new file last, so the port is
  compared with the same rule. `LightningFormationFullness.test.ts` and the
  deadline-pass test in `LightningFormWorker.test.ts` moved to one second.
