# 2026-08-28 — Spins: pre-start tables are live, honest, and start on time

Dan, from a live spin table: "INSIDE THE SPIN, ALL THE BUTTONS ARE 'EMPTY'
INSTEAD OF THE + BUTTON AND ABLE TO SIT DOWN TO PLAY. THE 'PLAYER ALREADY
SITTING' SAYS 'SPECTATING'. I'M ALSO GETTING MESSAGES ON THE BOTTOM THAT 'THIS
TABLE IS NO LONGER OPEN'."

Reproduced against production in a real browser session, with the database
open beside it. Four defects, one shared shape: a seat-first table BEFORE its
game starts has no engine game, and half the platform assumed the engine is
always there.

## What was found

1. **The pre-start roster was a mount snapshot.** TablePage reads table_seats
   once, at mount; every later update arrives on the engine WebSocket — which
   does not exist until the game starts. Watched live: a horse bought seat 3
   in the database while the page kept offering "+ SIT" on that chair, and a
   seat bought before a soft-nav mount never appeared at all. Every
   "That Seat Was Just Taken" on a chair that reads empty, and every full
   table still showing open seats, is this.

2. **Engine absence read as table death.** The engine answers 4404/404 for a
   pre-start table because there is nothing to host yet. The client counted
   three of those and told the player "This Table Is No Longer Running", filed
   Heartbeat_lost telemetry, and the WS failsafe reloaded the page under them
   about 30 seconds in (observed live — the reload swapped the bundle mid-
   session).

3. **Spins started about a minute late.** Median 62s, p90 88s from third paid
   seat to started_at across 684 spins in 24h; worst cases (3.5-4.5m) were
   the fully-paid stall watchdog doing the start. Cause: the only prompt gate
   lived inside discoverTournaments, whose full pass carries the MTT ramp and
   past-start top-up for the whole board (~180 games) and takes on the order
   of a minute under load. Dan's rule is the wheel spins the MOMENT the third
   seat is paid — and the shared reveal is anchored to that payment, so a
   late start also ate the wheel animation.

4. **A recycled tile was a dead end.** A spin tile holds a tournament id; the
   fleet replaces a completed spin with a NEW id under the same name and
   buy-in. Tapping a stale tile ended at "That Spin Is No Longer Open, Pick
   Another" even though its replacement was open and selling seats — the
   sibling hop the code's own comment promised was never implemented.

## What changed

- **TablePage: pre-start roster live-sync.** While seats are for sale
  (seatFirstBuyIn set, play not begun): a realtime subscription on this
  table's table_seats rows plus a 10s poll fallback rebuilds the players
  array from the database — the only truth there is before the engine
  exists. The tournament row rides the same channel, so the instant the game
  leaves REGISTERING the buy-in sheet comes down even for a spectator with
  no engine socket. Both stop the moment play begins. heroSeat is never
  written by the reload (the hero-seat invariant adopts it from players), so
  it cannot race the hero's own in-flight buy-in.

- **TablePage: pre-start engine absence is expected, not fatal.**
  seatFirstOpenRef gates the 4404 "No Longer Running" toast, the
  Heartbeat_lost report, and the WS auto-reload failsafe while the table is
  a pre-start seat-first game.

- **GameServer: seat-first fast lane.** discoverSeatFirstStarts() runs every
  5s and does exactly one job: count paid seats (via readSeatFirstPaidSeats,
  extracted so both loops share the same primary-table election) and start
  the full games. Both start sites re-check tournamentEngines in the same
  tick they set it. The big loop keeps its gate as backstop; the stall
  watchdog stays as the last resort.

- **ClubHomePage: the promised sibling hop.** A tile whose tournament no
  longer has an open table now follows name + buy-in + variant to the newest
  REGISTERING sibling and lands the player on its table; only when there is
  genuinely nothing open does it say so.

## Verification

- tsc client + server clean; vitest client + server suites green (counts in
  the PR).
- DB-visible: fill-to-start latency for spins after the engine deploy should
  drop from ~62s median to under ~10s — measured via
  `started_at - max(table_seats.joined_at)` on new spins.
- Browser: pre-start spin table shows every DB-seated player within seconds,
  no dead-table toasts, no self-reload while choosing a seat.
