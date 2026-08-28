# FINDING (not fixed): the hub replays a dead hand to new subscribers

Status: **investigated to root cause, deliberately not patched.** The obvious fix
is wrong for a reason worth writing down. This needs a server change verified
against a running engine, which I cannot observe from here.

## The observation

2026-08-28, ~07:35 UTC, cash table `f2c86e7a-e7c9-4d3c-b496-cd09ab33215d`:

| source                               | said                                              |
| ------------------------------------ | ------------------------------------------------- |
| `table_seats` (`left_at is null`)    | **0 seats**                                       |
| engine `GET /state/:tableId`         | **`players: []`**                                 |
| `hand_history`                       | last hand **#3145102 at 06:17**                   |
| **a fresh page load over WebSocket** | **2 players, 2 hole cards each, "Hand #3145102"** |

Money was never at risk — `fn_unaccounted_seat_exits()` was 0 platform-wide, and
the two stacks shown (38 / 41) matched those players' recorded exit rows.

## Root cause — exact path

`server/src/transport/TableStateHub.ts`, `subscribe()`:

```ts
subscribe(tableId: string, sub: HubSubscriber): void {
  const room = this.getOrCreateRoom(tableId);
  room.subscribers.add(sub);
  if (room.lastSnapshot) {          // <-- unconditional. no age check.
    this.safeSend(sub, JSON.stringify({ type: 'SNAPSHOT', ... state: room.lastSnapshot }));
  }
  ...
}
```

1. `room.lastSnapshot` is only ever cleared by `dropTable()`, which runs on
   **engine teardown** (watchdog kill, zombie rebuild, tournament break) — and
   even then only clears it when the room still has subscribers.
2. The engine publishes from exactly two call sites, both in
   `ServerTableEngine.ts`, i.e. while a hand is being driven. **When a cash table
   simply empties, no further publish carries the empty state.**
3. So `lastSnapshot` freezes on the final hand, and every _new_ WebSocket
   subscriber is handed that hand as though it were live — while HTTP `/state`,
   which reads the engine directly, correctly reports empty.

Player-visible effect: opening an emptied table shows players who left, holding
cards, at a hand number that finished long ago. It self-heals the moment the
table refills (verified — by 08:10 the same table had 9 seated at hand #3170219
and the WS snapshot agreed with the database exactly).

## Why the obvious fix is wrong

`room.lastPublishedAt` already exists, so the natural guard is "don't replay a
snapshot older than N":

```ts
if (room.lastSnapshot && Date.now() - room.lastPublishedAt <= MAX_AGE) { ... }
```

**That timestamp does not mean what it looks like.** `publish()` early-returns on
a no-op patch — and refreshes `lastPublishedAt` on the way out **without touching
`lastSnapshot`**:

```ts
if (patch.length === 0) {
  room.lastPublishedAt = Date.now(); // liveness signal for the ROOM
  return prev; // lastSnapshot NOT updated
}
```

Its own comment says so: _"Liveness is signalled by lastPublishedAt + the next
real DELTA."_ So it is the age of the **room's last tick**, not the age of the
snapshot's **content**. If the engine keeps ticking an idle-but-empty table, that
guard never fires and the bug survives; if it stops ticking, the guard fires but
so would a simpler check.

**And getting it wrong is expensive.** `dropTable` carries a 2026-08-15 CRITICAL
FIX note: deleting a room while sockets were open left players with a healthy
socket that never received another SNAPSHOT, DELTA or EVENT — _"a table could
look frozen to players even after the server had fully recovered."_ Suppressing
the replay for a table that is merely idle would reintroduce exactly that.

## What I could not determine from here

**Does the engine keep publishing (no-op ticks) for a table with zero seats?**
That single fact decides between the candidate fixes, and it is not visible in
the database or over the HTTP endpoint — it needs either the engine source read
end-to-end for the tick lifecycle, or a log/probe on a running Hetzner process.

## Recommended fix, for whoever picks this up

Track the age of the snapshot's **content**, not the room's liveness — add a
`lastSnapshotAt` set only on the branch that actually assigns `lastSnapshot`, and
gate the replay in `subscribe()` on that. It is a two-line addition that cannot
be confused with the liveness timestamp, and it leaves the 2026-08-15 guarantee
intact because a ticking table with real DELTAs keeps refreshing it.

Better still, if the engine can cheaply publish once when a table's last seat
empties, the hub needs no age logic at all — it would simply hold the truth.

CLAUDE.md §11 requires engine deploys to be verified by DB-visible behaviour.
This change has no DB-visible effect, so it needs a deliberate observation plan
(a fresh subscriber against a known-empty table) rather than the usual
hand-count check.
