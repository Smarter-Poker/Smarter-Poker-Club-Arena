# Realtime programme, Phase 4 of 7 - Restart handoff and protocol (2026-09-05)

Phases 1 and 2 made a broken table visible; Phase 3 stopped the client making
things worse when one broke. This phase is about the three minutes of every
hour when the engine is deliberately away, and about the tabs that outlive a
deploy.

---

## 1. A scheduled restart is not a failure

### What was happening every hour

The engine restarts inside an announced break at :55 and is gone for two to
three minutes (CLAUDE.md 13). The break is announced properly: at :53 the
engine broadcasts a `maintenance_break` frame, and `TablePage` draws a
countdown from it.

**Nothing on the transport read that frame.** It went straight past
`EngineStateClient` to the page, so while the player watched a countdown that
said "your seat is safe", the reconnect ladder underneath was treating the
silence as a box that had died:

```
1s, 2s, 4s, 8s, 16s, 30s, 30s ...  maxRetries at about three minutes
  -> status 'failed'
  -> TablePage's twenty-second failsafe reloads the page
```

That is a scheduled, hourly page reload under a seated player - discarding the
felt, the overlays and any armed pre-action, to arrive at a box that is still
booting. It is a race the client sometimes wins (the engine returns at ~:58 and
the ladder announces `failed` at ~:58 too), which is worse than losing it
outright, because it means the defect only appears on the slower restarts and
looks random.

On the way there it also asks GoTrue whether the session is still alive - three
failed handshakes in a row being the exact shape of the 2026-09-03 outage. Here
it is not, and every connected browser asking auth at once, for an answer the
server volunteered two minutes earlier, is the storm this phase names.

### What it does now

The engine adds two numbers to the frame it already sends:

- `restart_in_ms` - how long until the socket goes away. Two minutes at :53,
  zero once the countdown has started.
- `resume_expected_at` - absolute epoch ms, when it should be back.

Both are DERIVED from the break constants that `the-break-clocks-agree`
already pins, never guessed, and they are on the existing frame rather than a
new one because that frame already reaches every subscribed socket at exactly
the right moment - and an unknown field is ignored by every client that has not
learned to read it.

`EngineStateClient` reads them and, while inside the window:

- **never reaches `'failed'`**, which is what TablePage's failsafe watches;
- **polls at a flat 5s** instead of doubling to a 30s cap. The ladder is right
  for an outage of unknown length; here the server has already told us the
  length, and a table that could come back at :58:02 should not sit dead until
  :58:30 because the ladder had reached its slowest step;
- **does not ask GoTrue**, because we know why the socket will not open.

The window carries a 90-second grace past the announced return and then
expires. It has to: without an expiry one announcement would disable the
failsafe forever, and the failsafe exists for the restarts that go wrong.

**A missing table still wins.** 4404 means the table is gone, which a restart
does not change, so `waitingOutARestart` excludes it and the missing-table
branch is still evaluated first.

### The second guard, which is not duplication

`TablePage`'s failsafe now also refuses to reload while a break is active. That
is a different fact from a different source, and it exists for the reader the
socket signal cannot reach: **a browser that LOADED during the outage never
received the frame, because there was no socket to receive it on.**
`useMaintenanceBreak` reads the break from the database (`fn_maintenance_break_state`)
precisely for that case. One guard is transport-level and instant; the other
works with no engine at all.

---

## 2. The engine says which protocol it speaks

### Why this exists before it is needed

Club Arena's origin keeps old assets ON PURPOSE (CLAUDE.md 1.1): `/assets/*` is
an additive pool nothing deletes, pruned only by age. That is what stops a
deploy 404ing a player's chunks mid-hand - and it means a tab opened yesterday
is running yesterday's bundle against today's engine, right now.

Nothing on the wire said which protocol either side spoke. So the only ways to
change a frame's shape were to hope no stale tab was reading it, or to carry
both shapes forever.

### The shape

Every socket URL carries `?v=` from ONE builder, covering all three sockets -
the multiplexed `/ws/multi` that every table shares by default, the per-table
`/ws/table/:id` behind the `ca_ws_mux='0'` kill switch, and `/ws/channel`. A
version on two of the three would be worse than none: the engine would refuse
the stale bundles that happened to be muxed and silently serve the rest.

**In the URL, not a frame.** The mux has a SUBSCRIBE frame and the per-table
socket does not - the table is named by the path and the engine sends a
SNAPSHOT on connect - so a frame would cover one socket and not the other, and
would arrive after the connection had already been accepted. The URL is the one
place all three share and the one moment the engine can still refuse.

A client below `MIN_CLIENT_PROTOCOL` is **refused with a close frame (4426)
after completing the handshake**, never a pre-handshake HTTP status. That is
the 2026-09-03 lesson applied before it costs anything: a status written before
the handshake reaches JavaScript as close 1006, and 1006 means "try again",
which is the one thing a stale bundle must not do.

The parser reads absent, malformed and negative all as **0** - the version of
every bundle that predates the parameter - and never NaN, because a comparison
against NaN is false and would let garbage through the one gate meant to catch
it.

### It is a no-op today, deliberately

`MIN_CLIENT_PROTOCOL` is 0, so every client is accepted and this costs one
query parameter. The gate is installed while it is harmless so that the day a
frame changes shape there is somewhere to put the number. Raise it in the same
commit as the frame change and never before: every tab below the new number is
reloaded the moment it deploys.

### The client answers 4426 with new bytes

Not `location.reload()`. Dan, 2026-08-19: "a plain window.location.reload()
does NOT fix a stale chunk" - the page is running an old index.html and
reloading re-serves that same cached document from the service worker, the
bfcache or the edge, straight back into the same refusal. It calls the SHARED
`hardReload` in `utils/lazyWithRetry`, which drops the service worker, purges
Cache Storage and navigates with a cache-busting query. Reused rather than
re-written: a second copy of that reasoning is how two mechanisms end up
disagreeing.

4426 is also the one close code where reloading is the right answer rather than
the lazy one, which is why it stops the ladder instead of reconnecting into the
same refusal.

---

## Laws, mutation-tested

Both were checked by BREAKING the behaviour they guard and confirming red, then
green again on restore:

| mutation                                          | result     |
| ------------------------------------------------- | ---------- |
| ladder escalates to `failed` during a restart     | 1 failed ✓ |
| client stops reading `resume_expected_at`         | 2 failed ✓ |
| TablePage reloads during a break again            | 1 failed ✓ |
| protocol refused with an HTTP status, not a close | 1 failed ✓ |
| the version parser returns NaN                    | 2 failed ✓ |
| the channel socket loses its version              | 2 failed ✓ |

- `tests/a-scheduled-restart-is-not-a-failure.law.test.ts`
- `server/src/transport/theEngineSaysWhichProtocolItSpeaks.law.test.ts`

Both registered under `docs/laws.d/`.

## Not in this phase

Server clock offset for turn timers, periodic re-auth of live sockets and the
per-user socket cap are Phase 5. Nothing here changes what any seat is owed,
and horses are untouched in both directions: a horse has no browser to reload
and no bundle to be stale.
