# 2026-08-24 — Always-connected, phase 2: the risks found before they fired

Follow-up to `.agent/audits/2026-08-24-always-connected-three-root-causes.md`
(heartbeat mismatch, resubscribe-on-reconnect, deploy drain gate — all shipped
and verified in production, PR #619). Dan: "FIND ANY AND ALL OTHER REASONS THIS
MAY HAPPEN AND FIX THEM NOW... BEFORE THEY BECOME AN ISSUE." Swept the entire
realtime path again. Three more defects fixed, several risks verified-clean.

## Fixed 1 — multi-tab channel eviction ping-pong (ChannelHub)

`ChannelHub.addConnection` enforced ONE socket per userId by closing the
existing socket whenever a new one arrived. Two tabs — lobby + table,
multi-table play, phone + desktop — therefore evicted each other in an endless
reconnect loop: A connects → B connects, kills A → A auto-reconnects, kills B →
forever. Every cycle dropped the user's subscriptions (pre-#619 permanently;
post-#619 momentarily) and flapped wallet/tournament/lobby feeds. This is very
plausibly the sustained 6–9 reconnects/min signature in `action_audit_logs`
on 2026-08-23 21:14–21:35.

Now: `Map<userId, Set<WebSocket>>`, capped at 8 sockets/user (oldest evicted
beyond the cap), every send fans out to all of a user's sockets, and
subscriptions/presence are torn down only when the LAST socket closes. The
2026-07-21 reconnect-race guard generalises: a late close from a socket no
longer in the set is a no-op. `connectionCount()` now counts sockets;
`userCount()` (new) counts users. 8 tests rewritten/added in
`ChannelHub.reconnect.test.ts`.

## Fixed 2 — hub hard-evict left the socket open (TableStateHub)

On hard backpressure (>4 MiB buffered) the hub removed the subscriber from the
room but never touched the socket — the client kept an OPEN connection that
would never speak again, and sat blind until its staleness watchdog fired up to
60s later, mid-hand. `HubSubscriber` gains optional `evict()`: the single-table
transport closes the socket with 4429 (client reconnects on the slow ladder —
correct for a link that could not keep up); the mux transport drops only that
table's subscription and sends an ERROR frame. New
`TableStateHub.evict.test.ts` (3 tests).

## Fixed 3 — a silently dropped JOIN stayed dropped (client re-assert)

`joinClubIfMember` fails CLOSED on a transient DB error — the JOIN is dropped
with no error frame, and the client believes it is subscribed. Nothing would
ever retry. `EngineChannelClient` now re-asserts its desired subscription
state on the live socket every 180s (JOINs are idempotent server-side), so any
silently lost subscription heals within one interval. Also serves as outbound
traffic on quiet links. Test added to `engine-state-client-recovery.test.ts`.

## Verified clean (no change needed)

- **Liveness vs autoheal**: `/health` liveness already has a startup grace
  (STARTUP_GRACE_MS), asks the DATABASE for deal-rate evidence rather than
  trusting its own progress marks, treats standby as its own value, and no
  longer flips on slow discovery (#446/#465/#618).
- **Deploy verification** now asks the container directly AND asserts the
  public hostname serves the same build — the unmanaged-twin/Caddy-failover
  incident of 2026-08-23 cannot recur silently, and a one-engine guard fails
  the deploy if a stranger wears the engine label.
- **Repo Caddyfile** is single-upstream, no proxy read timeouts that would cut
  WebSocket streams; the Phase-1 deploy's public-hostname check passing proves
  the live config routes to the managed container.
- **GameServerAPI circuit breaker**: 3 failures / 30s cooldown, half-open
  probe, resets on browser 'online' — sane during engine restarts.

## Still open (unchanged from phase 1)

- Database pressure (72 GB hand_history, statement timeouts) — its own
  workstream.
- The ~2 min post-restart 4404 window while tables rehydrate: mitigated by far
  fewer restarts (drain gate) and slow-ladder client retries; shrinking the
  window itself means reordering boot (register tables before full hydration)
  and is deliberately not attempted in this pass.
