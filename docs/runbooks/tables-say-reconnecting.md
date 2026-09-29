# Tables say "Reconnecting To The Table"

**This page exists because that sentence once stayed on screen for twenty-two
hours while every dashboard was green.** If you are here at 3am, start at
[The first four minutes](#the-first-four-minutes) and do not read the rest
until you have an answer to question 1.

Realtime Connections Programme, phase 6. Companion to
[`REALTIME-CONNECTIONS-PROGRAMME.md`](../REALTIME-CONNECTIONS-PROGRAMME.md).

---

## What the banner actually means

`TableConnectionBanner` shows it whenever `EngineStateClient` is not holding an
open, subscribed socket for that table. That is ALL it means. It does not
distinguish between:

- the engine refusing the socket,
- the socket opening and the felt never arriving,
- the player's own network,
- an engine restart that was announced and is being waited out (since phase 4
  this one says so instead - if the banner is bare, it is not a scheduled
  restart).

The reason the banner is vague is the reason this page is long: the client
cannot tell, and neither can you until you look at the numbers below.

One refusal CAN be told, and since 2026-09-20 it has its own words: an engine
that will not show this account the table at all. That is the status
`access_refused`, it never says "Reconnecting", and it has its own section
below.

---

## The first four minutes

Answer these four, in this order. Each one eliminates a whole class.

### 1. What is the synthetic probe saying?

The probe (`/api/cron/table-socket-probe`, World Hub, scheduled on Open Claw
every 5 minutes) does exactly what a player does: signs in, opens a real
WebSocket to a table that is dealing, waits for the first `SNAPSHOT`.

```sql
select occurred_at, status, duration_ms, details->>'outcome' as outcome,
       details->'steps'->'socket'->>'close_code'  as close_code,
       details->'steps'->'socket'->>'close_name'  as close_name,
       details->'steps'->'pick_table'->>'table_id' as table_id
from probe_heartbeats
where probe_name = 'table-socket-probe'
order by occurred_at desc
limit 12;
```

- **Rows are `ok` and recent** - the platform can hold a table. What you are
  looking at is one player, one network, or one table. Skip to
  [It is only some players](#it-is-only-some-players).
- **Rows are `skipped`, `reason: maintenance_break`** - the platform was on its
  announced `:55` break, every table was parked, and the probe said so instead
  of crying. Expected once an hour. If you see a RUN of them outside `:55`-`:00`,
  the break did not end: go to question 3.
- **Rows are `failed`** - go to the outcome's section in
  [Close codes and outcomes](#close-codes-and-outcomes). The outcome IS the
  diagnosis; that is what it is for.
- **THERE ARE NO RECENT ROWS AT ALL.** This is the dangerous one and it does
  not mean "fine". A probe that stopped running is silent, and silence looks
  exactly like health - it is how a scheduled job read `enabled: true` for two
  and a half months after it last fired. Check the dispatcher is alive:

  ```bash
  ssh root@<openclaw-dispatcher> "systemctl status openclaw --no-pager | head -20"
  ssh root@<openclaw-dispatcher> "journalctl -u openclaw -n 60 --no-pager | grep table-socket"
  ```

  A 401 in that journal means `CRON_SECRET` drifted between Vercel and the
  Hetzner VM: every job returns 401, the log does not fill with errors, it
  STOPS. That happened on 2026-08-31 to all 85 jobs and nothing noticed.

### 2. Is the engine actually up, and is it the build you think?

```bash
ssh root@5.161.252.33 "docker ps --format '{{.Image}} {{.Status}}'"
```

The image tag IS the commit sha. **A green deploy run is not a deployment** -
the deploy workflow builds the image before the `:55` maintenance break and
skips the cutover if the next break is beyond its budget, reporting SUCCESS
with a step named "DID NOT DEPLOY - this run shipped nothing". If you are
hunting a bug you believe you fixed, check this tag before anything else.

### 3. Is this the maintenance break?

The engine restarts at `:55` of EVERY hour inside an announced five-minute
break, and is genuinely away for two to three minutes of it (CLAUDE.md 13).

```promql
poker_maintenance_break_active
```

If that is 1, tables are supposed to be paused and the client should be showing
the break screen, not a bare reconnect banner. A bare banner DURING the break
is itself the bug - it means the announcement did not reach that client
(phase 4).

### 4. Is the engine refusing sessions?

This is the question the 2026-09-03 outage turned on, and until phase 1 nothing
asked it.

```promql
sum by (path, denied) (rate(poker_ws_auth_refused_total[5m]))
```

- `denied="invalid"` climbing - sessions are being REVOKED or the tokens are
  bad. Go to [4401](#4401---auth_refused).
- `denied="unavailable"` climbing - GoTrue cannot be reached. That is
  `EngineCannotReachAuth`, and the engine is deliberately NOT signing anyone
  out for it; the client keeps retrying and play resumes when auth returns.

---

## Close codes and outcomes

Every code the engine can send, what it means, and where to go. The probe
reports these by name; `EngineStateClient` handles the same set.

### 1006 - `abnormal_no_close_frame` / probe outcome `refused`

**The socket never completed its handshake.** From a client this is
indistinguishable from a dropped link, and that ambiguity is precisely what
made the 2026-09-03 outage invisible: the engine wrote a PRE-handshake HTTP 401
and the browser reported 1006, so the client's reconnect ladder treated a
permanent refusal as a flaky network and retried forever with the same dead
token.

The engine no longer does that for an invalid token - it completes the
handshake and closes with 4401. **But five other refusals are still written
before the handshake**, and every one of them reaches the client as a bare 1006. Find out which by replaying the upgrade by hand (`--http1.1` matters:
over HTTP/2 curl cannot upgrade at all and the engine answers a misleading
404):

```bash
curl -sS -i --http1.1 --max-time 15 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Protocol: bearer, $TOKEN" \
  "https://engine.smarter.poker/ws/table/$TABLE_ID?v=1"
```

| status                     | meaning                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `101`                      | the upgrade worked; the fault is after it - go to `no_snapshot`                                                                                                                                                            |
| `403`                      | one of four viewer gates: **not a member of the table's club**, banned by a club/union blacklist, the table is seats-only (`restrict_observers`), or the IP rule found a different account at that table from this address |
| `404`                      | the table does not exist and could not be started                                                                                                                                                                          |
| `503`                      | the engine could not CHECK the token (GoTrue unreachable) - deliberate, and the client is meant to keep retrying                                                                                                           |
| nothing / connection reset | the proxy or the engine is not answering - check `EngineDown` and the Caddy log, and question 3                                                                                                                            |

**A 403 here is the trap.** It is a correct refusal, it is permanent, and the
client cannot tell it from a flaky link - so the tab reconnects forever with no
explanation. If a player reports one dead table while everything else works,
this is the first thing to check. (Recorded as a Phase 6 finding: those four
gates deserve real close codes the way the auth refusal got 4401.)

### 4401 - `auth_refused`

**The engine looked at the session and said no.** The close reason carries
`auth:<code>`; `auth:session_not_found` is the signature of the 2026-09-03
outage.

```sql
-- Something revoking sessions? The 22-hour outage looked exactly like this.
select created_at, payload->>'actor_username' as who, payload->>'action' as action
from auth.audit_log_entries
where created_at > now() - interval '2 hours'
  and payload->>'action' in ('logout','login')
order by created_at desc limit 50;
```

A repeating (login, logout) pair with `user_agent` `"node"` at a regular
cadence is a synthetic monitor signing a real person out. That is what
happened: `PROBE_LOGIN_EMAIL` had been pointed at Dan's own account and
`signOut()` defaults to scope `global`. Both halves are now law
(`src/lib/probeIdentity.js` and
`__tests__/synthetic-probes-never-sign-out-a-person.law.test.mjs` in the World
Hub) - if you find a THIRD way to do it, that is the bug, and the law needs the
new shape rather than an exception.

Other causes worth eliminating, in order of how often they are it: a signing
key rotated in Supabase; the engine pointed at the wrong Supabase project
(check its `SUPABASE_URL`); a re-auth sweep closing live sockets it should not
(`poker_ws_reauth_closed_total` climbing - phase 5).

### 4426 - `upgrade_required` / probe outcome `probe_outdated`

**The client is speaking an older protocol than the engine now accepts.** For a
PLAYER this is self-healing: the client reloads for the new bundle once.

For the PROBE it is not an outage at all - it means the probe's
`PROBE_PROTOCOL_VERSION` constant (World Hub,
`pages/api/cron/table-socket-probe.js`) is behind Club Arena's
`PROTOCOL_VERSION` (`src/services/EngineSocketMux.ts`). Raise it. This outcome
is deliberately reported as `probe_outdated` and not `failed`, because a probe
that cried outage every time the protocol advanced would be muted within a
week, and then it would not be there for the real one.

If PLAYERS are stuck on 4426 in a loop, the bundle is not reaching them: check
`curl -s https://smarter.poker/hub/club-arena/build-info.json` against `main`.

### 4404 - `table_not_found`

The table genuinely closed. For a player mid-session this is normal at the end
of a table's life. For the probe it is a race between picking a table and
opening it - one occurrence is noise; a run of them means tables are churning
faster than they are being created (look at the cluster controller alerts).

**Careful:** a 4404 during a restart window is NOT a closed table, it is a
table the new engine has not adopted yet. The client asks the database (the
single row in `engine_maintenance_break`) before it believes a 4404.

**Nor is a 4404 on a table created seconds ago** (2026-09-20). The engine builds
a created cash table on first demand (`GameServer.ensureCashTableEngine`), so
a SUBSCRIBE that loses that race hears `TABLE_NOT_FOUND`. A client that has
never connected retries its first three 4404s on the fast end of the ladder
(1s, 2s, 2s - `NEVER_CONNECTED_FAST_NOT_FOUND_RETRIES`) before it falls to the
slow step, and after three 4404s TablePage reads the `tables` row before it
says "This Table Is No Longer Running": a row the engine would still wake
(cash, no tournament, not deleted, status waiting, running or active -
`isStillWakeableTableRow`, the client's copy of
`server/src/services/onDemandTableWake.ts`) gets another attempt at once
(`reconnectNow`) instead of the toast. A row read that fails says the toast,
as before.

### 4429 - `rate_limited_or_socket_cap`

Either backpressure eviction, or the per-user socket cap (phase 5, 10 sockets
per account, refusing the ARRIVING socket rather than evicting a live one).

```promql
poker_ws_socket_cap_refused_total
```

For a player: a client in a reconnect loop that never closes its old sockets.
For the probe: **the probe is leaking its own sockets** - it should close
every one it opens, and if this is the outcome, that is the first place to
look, not the platform.

### 4403 - `banned`, 4400 - `bad_request`, 4500 - `server_error`

4403 is a club or union blacklist and is working as intended. 4400 means the
client sent something malformed - a version skew or a hand-rolled client. 4500
is the engine failing inside the upgrade; check the engine log
(project `club-arena-engine`).

On the multiplexed socket 4400 is also how `EngineSocketMux` closes one table's
facade when the engine refuses that table's SUBSCRIBE, with the engine's code
in the reason (`subscription refused: <CODE>`). Two of those codes are a
verdict on the viewer and have their own status - next section.

### 4400 `subscription refused: <CODE>` - status `access_refused`

**Not a connection problem, and nothing retries it.** The engine's viewer
check (`server/src/services/TableViewerAccess.ts`) has ruled that this account
may not watch this table. It admits a player seated at the table and an active
or approved member of a club in the table's scope (`fn_club_scope_ids`); a
table with `restrict_observers` admits seated players only. Everyone else is
refused - including a union owner or admin who was allowed to CREATE the game
(`fn_can_create_games`) but is a member of no club in its scope. That is the
usual way to meet this, and it is not a client bug: the client can only say
it honestly.

On the multiplexed socket (the default) the engine answers the table's
SUBSCRIBE with `ERROR` and one of two codes, and the facade closes with 4400
and one of these reasons:

- `subscription refused: CLUB_MEMBERSHIP_REQUIRED` - not a member of any club
  in the table's scope;
- `subscription refused: OBSERVERS_RESTRICTED` - a member, at a table that
  admits seated players only.

`accessRefusalFromClose` reads the code back out of the reason and
`EngineStateClient` moves to `access_refused`. That status is terminal for the
reconnect ladder: no timer is armed and the watchdog stops. The client's wake
listeners (network back, tab brought to the front) still ask once more each
time, so a membership granted in another tab is honoured without a reload, and
a socket that opens clears the verdict.

What the player reads on the felt (`TableConnectionBanner`, a steady red
bullet - it does not pulse, because nothing is being attempted):

| reason                                           | banner                                                          |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `subscription refused: CLUB_MEMBERSHIP_REQUIRED` | This Table Is Open To Club Members Only. Join The Club To Watch |
| `subscription refused: OBSERVERS_RESTRICTED`     | This Table Is Open To Seated Players Only                       |
| the code is not available                        | You Do Not Have Access To This Table                            |

Start in the New Cash Game flow meets the same verdict over HTTP first: GET
`/state/:id` answers 403 with the same code, `GameServerAPI.wakeTable` keeps
it, and the host is told "Game Created. Only Club Members Can Watch This
Table" (or "... Only Seated Players ...") and sent to the club page, never
told the game started and never retried for it.

**With the mux switched off** (`localStorage ca_ws_mux='0'`) none of this
applies: the single-table socket gets the same verdict as a PRE-handshake HTTP
403, which the browser reports as 1006 - see the 1006 section. That player sees
the ordinary reconnect ladder. A player stuck on "Reconnecting" at one table
with the mux off: check membership before the network.

```sql
-- Does the table's scope admit this account as an observer?
select m.club_id, m.role, m.status
from club_members m
where m.user_id = '<user id>'
  and m.status in ('active', 'approved')
  and m.club_id = any (public.fn_club_scope_ids(
        (select coalesce(union_id, club_id) from tables where id = '<table id>')));

-- And does the table admit observers at all?
select restrict_observers from tables where id = '<table id>';
```

Pinned by `tests/a-new-table-is-waking-not-gone.test.ts` (the transport) and
`tests/a-refused-viewer-is-told-why.test.tsx` (the words, and this section).

### 4901 - `mux_superseded`

Client-side only, from `EngineSocketMux`: a newer multiplexed socket replaced
this one. Normal. If it repeats, the mux is thrashing - the kill switch is
`localStorage ca_ws_mux='0'` for one player, which is a diagnostic, not a fix.

### Probe outcome `no_snapshot` - the socket opened and the felt never came

**A different fault from every code above, and the one most likely to be
misread.** The socket is fine; the engine accepted it, subscribed it to the
room, and the room never published. Look at:

- Is the table dealing at all? `poker_actions_fleet_total` by format.
- Is the engine's event loop saturated? `/health.equityGovernor.scale < 1`
  means the single core is hot and horse Monte Carlo is eating it.
- Did `TableStateHub` drop the room?

For the probe specifically, `fn_probe_table_candidate` only offers tables with
at least 3 hands in the last 10 minutes, precisely so that "no snapshot" cannot
mean "quiet table". If you widen that function, you break that guarantee.

### Probe outcome `closed_before_snapshot`

The socket opened, the engine accepted it, and then it closed with a code that
has no section of its own above - before any `SNAPSHOT`. Read
`details.steps.socket.close_code` in the heartbeat and go to that code's
section; if it is not in this page, that is a bug in this page and
`tests/every-refusal-has-a-runbook.law.test.ts` should have caught it.

### Probe outcome `construct_failed`

`new WebSocket(...)` threw before a connection was even attempted - a malformed
URL or a runtime with no global `WebSocket`. Nothing is wrong with the
platform; `ENGINE_URL` or the probe's own runtime is. Check the error text in
the heartbeat.

### Probe outcome `handshake_timeout`

The socket neither opened nor closed within 15 seconds. That is a black hole -
a TCP connection accepted and never answered. Look at the proxy and at
`HostCPUSaturated`, not at auth.

### Probe step `pick_table` failed - "no table this account may open"

`fn_probe_table_candidate` mirrors every gate the upgrade applies - membership
in the table's club, a room that admits observers, a table that is dealing, no
human seated - so an empty result is one of two incidents. Tell them apart:

```sql
-- Is the FLEET dealing at all?
select count(*) from hand_history where created_at > now() - interval '10 minutes';

-- Can the probe account still SEE anything? (zero rows = the membership is gone)
select c.name, count(t.*) filter (where t.status='running' and t.tournament_id is null) as running
from club_members m join clubs c on c.id = m.club_id
left join tables t on t.club_id = c.id
where m.user_id = (select id from auth.users where email='daniel@smarter.poker')
  and m.status in ('active','approved')
group by c.name;
```

- **The fleet is quiet** - go to `EngineDown`, `NoHandsAreSettling` and
  `EngineHandsPerSecDropped`. On a platform that deals ~221,000 hands a day,
  ten silent minutes is the incident.
- **The membership is gone** - the probe is blind, not the platform. The
  service identity is an ordinary `player` member of the clubs that run the
  cash fleet (added by
  `20260906092312_a_synthetic_probe_can_find_a_table_that_is_dealing.sql`, one
  row per club, no chips, never seated). Restore it. Until then the probe is
  reporting its own blindness, and you should treat the platform as unmonitored
  rather than as broken.

---

## It is only some players

If the probe is green, the platform can hold a table, and you are looking at a
subset. The client's own telemetry is the tool (phase 2 - beacons from four
failure sites, counted per user in the engine):

```promql
poker_ws_clients_reconnecting_badly      # how many accounts are looping
poker_ws_worst_client_reconnects         # the worst one's count
sum by (reason) (rate(poker_ws_client_reconnects_total[15m]))
```

`PlayersReconnectingRepeatedly` and `TablesAreReloadingThemselves` are the
alerts on these. A single account looping while the fleet is calm is that
account: a revoked session on one device, a captive portal, or a corporate
proxy killing idle WebSockets (the engine pings every 25 seconds precisely to
stay under the shortest idle timeout in common use).

---

## What NOT to do

- **Do not restart the engine to "clear it".** It restarts itself at `:55`
  inside an announced break with the platform frozen, so hands are protected.
  An unannounced restart voids in-flight hands - horses' hands included; they
  are players (CLAUDE.md 10.5).
- **Do not point a probe at a real person's account** to "test what they see".
  That is the outage.
- **Do not trust a green deploy run.** Read the image tag (question 2).
- **Do not add an alert rule by editing the file on the box.** The live rules
  and this repo's `infra/monitoring/alert-rules.yml` do not match, in both
  directions, and hand-edits are erased by the next write. That reconciliation
  is phase 7's job; until it lands, a rule is live when
  `curl -s localhost:9090/api/v1/rules` says so and not when it merged.

---

## The worked example: 2026-09-03

Twenty-two hours. Every table said "Reconnecting To The Table". The engine was
dealing 5,700 hands per ten minutes throughout.

1. A World Hub cron had `PROBE_LOGIN_EMAIL` pointed at Dan's personal account
   and called a bare `signOut()` - scope global - every 15 minutes.
2. The engine verifies every table socket with `auth.getUser()`. GoTrue
   answered `session_not_found`.
3. The engine wrote a pre-handshake HTTP 401. The browser reported close 1006.
4. The client could not tell 1006 from a dropped link, so it reconnected
   forever with the same dead token. The access token lives seven days, so
   nothing ever tried to refresh.
5. The lobby kept working, because PostgREST checks a JWT's signature and not
   its session - so the app LOOKED signed in while the engine refused it.
6. Every monitor was green. `/api/health` (the engine was healthy). The login
   probe (GoTrue was issuing tokens perfectly - it was the revocation a moment
   later that mattered). Nothing anywhere opened a socket to a table.

Each numbered step now has something watching it: (1) the probe-identity law,
(2) `poker_ws_auth_refused_total` + `EngineRefusingSessions`, (3) 4401 instead
of a pre-handshake 401, (4) the client asks GoTrue whether the session is alive
instead of spinning, (6) this probe, which does step 6's missing thing every
five minutes.

Full timeline:
[`docs/changelog/2026-09-04-a-revoked-session-is-not-a-reconnect.md`](../changelog/2026-09-04-a-revoked-session-is-not-a-reconnect.md).
