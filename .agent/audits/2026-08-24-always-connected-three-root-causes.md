# 2026-08-24 — "The server disconnects have got to stop": three root causes

Dan: "IT KEEPS BREAKING, CRASHING LIVE GAMES AND TOURNAMENTS, CAUSING
DISCONNECTS IN THE WALLETS, AND ABILITY TO SEE LIVE GAMES AND TOURNAMENTS."

Deep dive into the realtime stack (client EngineStateClient/EngineChannelClient,
server EngineWebSocketServer/ChannelWebSocketServer/ChannelHub/TableStateHub,
deploy pipeline) plus production data. Three distinct root causes, all fixed in
this change.

## Root cause 1 — the server killed every channel connection at the 60s mark

`ChannelWebSocketServer.heartbeatSweep()` sent `CHANNEL_PING` and accepted ONLY
`CHANNEL_PONG` as proof of life. The deployed client (`EngineChannelClient`)
only recognises `PING` and answers `PONG` — `CHANNEL_PING` fell through its
switch, and its `PONG` fell through the server's. JOIN\_\* frames were not
counted as liveness either. Net effect: **every single `/ws/channel` socket was
declared dead and force-closed 60 seconds after it opened, forever** — the
socket carrying FINANCIAL_UPDATE (wallets), TOURNAMENT_EVENT, CLUB_EVENT,
CLUB_PRESENCE_UPDATE and LOBBY_UPDATE. "Disconnects in the wallets" was this.
The sweep also sent a stray unsolicited `CHANNEL_PONG` to the client every 25s,
which answered nothing (removed).

Fix (both dialects, either side may deploy first):

- Server sweep sends `PING` **and** `CHANNEL_PING`; ANY well-formed inbound
  frame stamps liveness; `PONG` and `CHANNEL_PONG` are both accepted.
- Client answers `CHANNEL_PING` with `CHANNEL_PONG` (and still `PING`→`PONG`).
- Pinned by `server/src/transport/ChannelWebSocketServer.heartbeat.test.ts`
  (6 tests) and new cases in `tests/engine-state-client-recovery.test.ts`.

## Root cause 2 — nothing ever re-subscribed after a reconnect

Server-side channel subscriptions (ChannelHub `clubSubs` / `tournamentSubs` /
`lobbySubscribers`) live on the CONNECTION and die with it
(`removeConnection`). The client sent each `JOIN_*` exactly once, at
subscribe time. So after ANY reconnect — root cause 1 every 60s, every engine
deploy, any network blip — the fresh socket had **zero subscriptions** and no
tournament/club/lobby/presence message ever arrived again, silently, until a
full page reload. Supabase Realtime used to re-subscribe automatically; the
2026-05-18 migration to the engine WS lost that behaviour. This is "can't see
live games and tournaments".

Fix:

- `EngineChannelClient` now records desired subscription state from every
  `send()` (net of LEAVEs, latest UPDATE_PRESENCE per club) and **replays it on
  every reconnect** before flushing the offline queue. Server JOINs are
  idempotent, so a raced duplicate is harmless.
- New public `onStatusChange()` listener API on the channel client.
- `useRealtimeFinancials` refetches balances (BALANCE_UPDATED) on every
  reconnect — FINANCIAL_UPDATE is push-only, so anything that changed while the
  socket was down was previously missed forever.

## Root cause 3 — the engine restarted ~25 times a day, kicking everyone

263 non-test server-touching commits landed on main in the 7 days before this
audit; each one auto-deployed = full container stop/start = every WebSocket on
the platform closed, in-flight hands voided, ~2 minutes of 4404s while tables
rehydrate. The drain gate waited a maximum of ~8 minutes for
`humansSeatedTotal == 0` and then **proceeded anyway**, so anyone playing
through a busy merge afternoon was kicked mid-hand repeatedly. Production data:
engine_ws_connect audit rows show reconnect storms up to 380/hour from a
single human client, and a ~3s crash-loop signature on 2026-08-23 02:41–03:00
(the window the nightly-league freeze (#358) was diagnosed and fixed).

Fix (auto-deploy-hetzner.yml):

- **Drain gate fails closed**: humans still seated after the wait now DEFER
  the deploy (job succeeds, nothing restarts) instead of restarting under them.
- **Bounded staleness**: if the running engine's uptime ≥ 6h, the restart
  proceeds anyway — a table that never empties must not pin stale (possibly
  security-relevant) code forever. `workflow_dispatch` force=true unchanged.
- **Hourly catch-up** (`schedule: 17 * * * *`): deploys HEAD in the first
  empty window. A new dedupe step exits in seconds when production already
  serves HEAD, so up-to-date hours cost one checkout + one curl.
- **Dedupe on every trigger**: an engine already serving the exact commit is
  never bounced again.

## Verified

- Client: `npx vitest run tests/engine-state-client-recovery.test.ts` — 10/10.
- Server: `npx vitest run src/transport/ChannelWebSocketServer.heartbeat.test.ts`
  — 6/6. `npx tsc --noEmit` clean on both sides.
- Workflow YAML parsed; step-guard matrix reviewed (skip paths leave the
  running container untouched; GUARANTEE step still runs on drain-deferral).

## Still open (documented, not fixed here)

- Database pressure (72 GB hand_history, statement timeouts) still degrades
  lobby RPCs and can trigger healthcheck-driven restarts; partially addressed
  by 2026-08-23 fixes (#446, #465, fee rollup). Wants its own workstream.
- The `/ws/table` reconnect bursts (6–9/min sustained on 2026-08-23 21:14–21:35)
  are consistent with engine restarts + network flap but were not separately
  root-caused; with root causes 1–3 fixed, remaining bursts will stand out in
  `action_audit_logs` (`action_type = 'engine_ws_connect'`).
