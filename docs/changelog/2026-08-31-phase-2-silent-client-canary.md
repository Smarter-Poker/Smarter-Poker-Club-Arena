# Phase 2 — telling a player who left from a player whose client is broken

2026-08-31. The engine cannot see a browser, and on 2026-08-31 that cost
somebody their seat. A player sat in seat 7 of a 9-max table; his own client
had erased him from his screen. From the engine's side he was
indistinguishable from an AFK: the heartbeat landed every five seconds, the
turn timer expired, three strikes forced a sit-out, and the five-minute clock
took the seat. He was at his desk the whole time.

Phase 1 fixed the client bug. This phase makes the NEXT one visible in minutes
instead of costing a seat.

## What a heartbeat actually proves

That the app is running and the network is up. Nothing more. It says nothing
about whether the player can SEE anything — which is exactly the state the
seat-7 player was in while his beats landed perfectly.

## The fingerprint

A combination a genuine AFK human almost never produces:

    connected  +  turns offered  +  never once acted, ever, at this table

Somebody who plays and then wanders off has acted at least once. Somebody
whose client cannot show them the action never does. `DisconnectEngine` now
carries `everActed`, `turnsOffered` and an optional `lastTurnRenderedAt`, and
`reportSuspectedSilentClient()` fires at the exact moment the ladder condemns
a player — the moment nobody was told on 2026-08-31.

**Diagnosis only.** The sit-out still happens, the eviction clock still runs.
Letting this change the outcome would let a broken client hold a seat forever,
which is a worse bug than the one it reports.

## The optional ack

`turnRendered` rides the existing heartbeat: the client says whether it has
actually DRAWN the action controls. It is written by the ActionPanel's own
render arm — the one place that knows for certain — rather than re-derived
next to the heartbeat, because a second copy of that condition would drift,
and a false "the player can see this" silences the canary for precisely the
player it exists to catch. Cleared when the turn ends so it cannot carry a
stale yes into a later hand.

Optional by design: old clients omit it and fall back to the weaker signal, so
they are treated exactly as every client is treated today. It can only ever
make the engine quieter about a player, never harsher.

## Horses

There is no `is_horse` branch in this feature and none is needed. A horse acts
through the same `performAction` path as a human (HorseLogic ->
scheduleHorseAction -> performAction -> recordPlayerActed), so it sets
`everActed` on its first decision and can never trip the canary. The signal is
behavioural, not an identity test — a horse is measured by the same yardstick
as a human and passes it for the same reason. A test asserts the absence of
any such branch so nobody adds one later.

## Verification

- `SilentClientCanary.test.ts`: 8 cases, both directions (fires for the broken
  client on the real ladder; silent for ordinary AFK, for a disconnect, for a
  confirmed render, and for too little evidence). Verified real — removing the
  `everActed` guard turns two of them red, including the horse case.
- Client: **705 files / 9,990 tests**. Server: **269 files / 3,050 tests**. Zero
  failures. `tsc --noEmit` clean both sides.
