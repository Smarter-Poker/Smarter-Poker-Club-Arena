# A horse whose Lightning pool session ended leaves its anchor seat (2026-10-24)

## What was measured

"FLH 0.25/0.50 Lightning Games" (Cluster `5be919f7-d306-4349-a514-22b88b18f98e`,
anchor table `f596811a-a65b-4c74-916b-830ebb581136`), read-only on production:

- 15:49:46.347 UTC: one `player_disconnected` batch stamped seven pool
  players. Three were reported back by a room socket within 40 s.
- 15:52:50 UTC: `fn_lightning_reap_expired_disconnects` closed the other four
  sessions `disconnect_expired` (180 s timeout).
- Two of the four left their anchor seats later through ordinary departures
  (16:14:44 and 17:54:30).
- The other two never moved: horse `0f14f372-...` (seat 3, 38.74) and horse
  `f39893fa-...` (seat 5, 51.77) still owned live anchor seats at 23:29 UTC,
  `is_sitting_out` false, `leave_pending` false, cash sessions open, and no
  open pool session. They were the only two such seats in any Lightning
  Cluster.

## Root cause

The reaper closes a pool session and, by design, never stands the anchor seat
up (Phase 9 remediation, `20261008142857`): a returning person reads
`fn_lightning_reconnect_state`, is offered VIEW GAME on their own chair, and
decides. Nothing in the live path decided for a horse:

- `fn_table_seats_lightning_pool_follows_seat` re-enters only on a seat
  change (left_at, user, sit-out, leave_pending, stack crossing zero);
- the parked anchor pass (`passWhileDealingHalted`, the only loop an anchor
  runs while its Cluster is Lightning) handled a busted horse but had nothing
  for a funded horse outside the pool;
- `HorseSessionRotator`'s departure pass skips any table under four seated
  players, and an anchor holds a few of the Cluster's players each.

So the chips sat on the chair, the chair was held, and the seat counted against
the horse's four-game limit, for as long as nobody looked.

## The fix

`standUpHorsesWhosePoolSessionEnded` runs in the parked pass, after the bust
recovery and before the halt acknowledgement. The engine is the horse's input
device (CLAUDE.md 10.5), so it makes the choice a person makes at the same
seat and uses the person's own door: `leaveTable`, scoped to the occupancy.
That is the voluntary cash-out (stay clock, `atomic_seat_cashout_locked`, the
club-wallet credit and its receipt, idempotent per occupancy), then
`seat_left` and the Cluster wake. The fleet then seats a horse the ordinary
way, and that buy-in enters the pool through the same seat trigger a person's
does.

It acts only when `lightningSeatsWhosePoolSessionEnded` (a read in
`services/supabase/lightningAnchor.ts`) says the Cluster is Lightning right
now, the player has no open session anywhere in the Cluster, and a session
THIS occupancy entered from THIS seat has closed; only on a second sighting of
the same occupancy at least 30 s after the first; never on an unreadable pool,
during the freeze, or for a horse sitting out, already leaving or busted.

No migration. No cron, sweep or repair job: it is the horse's own seat
management inside the anchor engine's existing parked pass.

## The two stranded horses

Once the engine carrying this change is serving, the anchor's next parked pass
sees both seats, and the pass after it (30 s later) stands each up through
`leaveTable`. Neither is ahead of a running stay clock (both
`stay_remaining_ms` 0), so each is cashed out at its seat stack, 38.74 and
51.77, into its own club wallet, once: the cash-out is keyed to the occupancy
and the seat leaves in the same transaction.

## Not fixed here, and what a person gets

- The stamp: a horse whose input device is its anchor engine's heartbeat can
  be stamped disconnected, and only a Lightning room socket reports
  `reconnected` (`LightningRegistry.connect`), so nothing un-stamps it. That
  is why four heartbeating horses timed out at 15:52. This change makes the
  outcome safe; the stamp itself is a separate defect.
- A person whose session ended the same way keeps the anchor seat and chips
  indefinitely. Nothing stands them up and nothing re-enters them: the parked
  pass does not run sit-out eviction, and the seat trigger needs a seat
  change. Their only paths are coming back (VIEW GAME, then Leave, or a sit
  out and back in) or the Cluster leaving Lightning.

Law: `server/src/engine/aHorseWhosePoolSessionEndedLeavesItsAnchorSeat.law.test.ts`.
