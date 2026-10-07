# Lightning Phase 7 Review Fixes: Switching Off No Longer Voids Hands; A Held Seat Is Always Offered

Date: 2026-10-07

## P1: Switching Lightning off voided the hands being dealt

`server/src/lightning/LightningSupervisor.ts`. Discovery filtered on
`lightning_enabled = true`, so an operator switching the flag off on a
Cluster still in `lightning` dropped it from discovery at once. The
supervisor then stopped its worker and called
`hosting.abortCluster(clusterId, 'worker_stopped')`, voiding every live hand
(all-in pots included) - while the database's tick was about to drain the
Cluster through `pending_off` with the promise that in-flight hands finish.
A failed abandon could also leave an instance `dealing`, making
`commit_must_move` answer `instances_in_flight` until the 15-minute reaper.

Now the one discovery read takes `cluster_mode IN ('lightning','pending_off')`
with no flag filter, selects `lightning_enabled` alongside, and a `lightning`
Cluster whose flag is not exactly `true` is discovered as DRAINING: no new
hand forms, every host keeps running, until the tick moves the Cluster on.
A worker stops (and aborts what has not settled) only when its Cluster is
must_move/frozen/dead or gone from discovery.

Tests: `server/src/lightning/LightningPhase7Reversion.test.ts` - the
discovery-filter pin updated (no `eq` on the flag), a parse pin for the
drains-not-disappears rule, and a behavioural test: a hand dealing when the
operator switches the flag off settles under its host, `abortCluster` is
never called.

## P3: A seated player in a pending_on/pending_off Cluster was offered a second join

`src/lightning/lightningSession.ts`. `lightningEntryDecision` offered the
held seat only through `lightningReturnTableId`, which requires
`cluster_mode = 'must_move'`. A player with no open pool session but a live
seat in a Cluster in `pending_on` or `pending_off` therefore saw JOIN GAME,
inviting a second join attempt. Now whenever `seat_table_id` is set and there
is no open pool session, the decision is the seat (VIEW GAME), whatever the
mode. `lightningReturnTableId` itself is unchanged (the room-closed 4404 path
still demands MUST MOVE).

Tests: `tests/lightning/lightning-phase-7-reversion.test.tsx` - the decision
offers the seat in pending_on/pending_off/lightning, the entry door with no
seat, the open room over the seat; and the rendered route on a pending_on
Cluster shows VIEW GAME, never a join.
