# Realtime Phase 6 of 7 - prove it from outside

2026-09-06. Club Arena branch `realtime/phase-6-prove-it-from-outside`; World
Hub branch `realtime/phase-6-table-probe`.

## Why

Phases 1 to 5 gave the platform eyes: latency on the always-on exposition, the
client's own failures beaconed back, a socket that refuses out loud, a restart
that announces itself, sockets that re-earn their trust. Every one of those
looks at the platform **from inside the platform**.

On 2026-09-03 the thing that was broken was not visible from inside. The engine
was healthy and dealing 5,700 hands per ten minutes. `/api/health` was green
because the engine was healthy. The lobby was green because PostgREST checks a
JWT's signature and not its session. `login-probe` was green because GoTrue was
issuing tokens perfectly - it was this platform's own cron revoking them a
moment later. Every monitor answered an HTTP question, and the player's
question is a WebSocket one.

**Nothing anywhere opened a socket to a table and waited for the felt.** That
is the entire content of this phase.

## What was built

### A synthetic client, on Open Claw, every five minutes

`pages/api/cron/table-socket-probe.js` (World Hub). It takes the player's path,
step for step:

1. `signInWithPassword` through the anon client - GoTrue.
2. `fn_probe_table_candidate()` - a running cash table that has dealt at least
   three hands in the last ten minutes and has no human sitting at it.
3. `new WebSocket('wss://engine.smarter.poker/ws/table/<id>?v=1', ['bearer', jwt])`
   - Node's own global `WebSocket`, the same WHATWG API the browser hands
   `EngineStateClient`, including the subprotocol array that carries the token.
   This is the client's code path, not an imitation of it.
4. Wait for the first `SNAPSHOT` frame.
5. Close it, `signOut({ scope: 'local' })`.

Step 3 is why this could not be a `fetch`. The upgrade runs code no HTTP
request touches: the protocol-version gate (4426), the token verdict that
separates "revoked" from "GoTrue is unreachable" (4401 versus a pre-handshake
503), the per-user socket cap (4429), and the subscribe that makes a room
deliver its snapshot.

Step 4 matters as much. A socket that opens and then says nothing is what a
player sees as a table that never paints, and it is a completely different
fault from a socket that is refused. The probe reports them as different
outcomes because the runbook sends you to different places for them:
`ok`, `no_snapshot`, `handshake_timeout`, `refused`, `auth_refused`,
`table_not_found`, `rate_limited`, `closed_before_snapshot`, `probe_outdated`.

### Running it before shipping it found the bug

The first version of the table picker asked for any busy horse-only table. I
ran it against production from this machine, with the service account's real
credentials, before writing another line - and it came back:

```
outcome: "refused", close_code: 1006, close_name: "abnormal_no_close_frame"
```

Replaying the upgrade by hand (`curl --http1.1`, which matters - over HTTP/2
curl cannot upgrade at all and the engine answers a misleading 404) gave the
real answer: **`HTTP/1.1 403 Forbidden`, pre-handshake, empty body.**

Nothing was broken. `authorizeTableViewer` fails CLOSED on club membership -
deliberately, so a stale client result can never open a private club's table -
and the platform's service identity is a member of exactly one club, which has
not run a table in months. The two clubs that run the entire live cash fleet
(Midway Union, 36 running tables; Deep Stack Society, 20) are Dan's own, and
the probe was not in either.

**A probe that picks tables it may not open does not measure whether a player
can hold a table. It measures its own membership** - and it would have paged
every fifteen minutes forever while the platform was perfectly healthy. That is
a worse outcome than no probe, because the first thing anyone does with an
alarm that is always wrong is turn it off.

Two changes came out of it, and both make the probe more honest rather than
more permissive:

- `fn_probe_table_candidate(p_viewer)` now mirrors **every** gate the upgrade
  will apply: membership in the table's club, a room that admits observers, a
  dealing table, no human seated. An empty result now means "nothing to probe",
  never "the probe is not allowed in".
- The probe account joins those two clubs as an ordinary `player`, in the
  migration, with `chip_balance = 0`. **The alternative was to add a god-role
  bypass to `authorizeTableViewer`, and that is exactly the shape of bug this
  programme exists to stop** - weakening a viewer gate for a monitor's
  convenience. A synthetic player passes the same gate as a person because it
  is a player.

### The table it picks

`fn_probe_table_candidate(p_viewer)` (migration
`20260906092312_a_synthetic_probe_can_find_a_table_that_is_dealing.sql`).

- **It cannot hardcode a table.** This database holds 5,547 closed cash tables
  and 58 running ones, and which is which changes all day.
- **It requires recent hands.** `TableStateHub.subscribe()` sends a snapshot
  immediately if the room has published one and otherwise holds the subscriber
  until the next publish, so an idle table would leave the probe waiting until
  its timeout and reporting "the socket opened and no felt arrived" - a real
  fault signature - for a table that is simply quiet.
- **It prefers a table with no human seated.** This is not an exception to
  CLAUDE.md 10.5: `is_horse` is read to IDENTIFY, which that law permits, and
  nothing is denied. The probe takes no seat, moves no chips and plays no hand.
  A horse's table is not a lesser table; it is the one where an observer costs
  nobody anything.
- **It picks at RANDOM among the qualifying tables, not the busiest.** Always
  probing the busiest would let one healthy table mask a fleet of broken rooms,
  and would make one sick table alarm every five minutes forever.
- **Zero rows is an answer, not an error.** No running cash table has dealt in
  ten minutes, on a platform that deals ~221,000 hands a day. The probe reports
  that as a failure, because it is one.

### Why it does NOT report to the engine's `/metrics`

This is the design decision of the phase and it is deliberate.

It would be tidy: phases 1, 2 and 5 all put their numbers on the engine's
always-on exposition, and Grafana is where people look. It is also the exact
mistake this probe exists to avoid. **A monitor that reports through the thing
it monitors cannot report the outage it was built for.** If the engine is
refusing sockets it can also be refusing the probe's POST, and the result is a
gauge that stops moving - which looks precisely like a quiet night. Every green
signal in the 2026-09-03 outage shared a failure domain with the thing it
claimed to watch.

So the result goes to three places that do not share a failure domain with the
Club Arena engine, plus a fourth that watches for silence:

| channel | catches |
| --- | --- |
| `probe_heartbeats` in Postgres | the durable record; what `/admin/auth-health` reads |
| an email to `OPS_ALERT_EMAIL` | a row in a table nobody opens at 3am is not an alert |
| a non-200 to Open Claw, listed in `CRITICAL_JOBS` | pages by SMS after **three** consecutive failures |
| `check-cron-fleet-alive.mjs` (every 15 min) | the probe having **stopped**, which is the half that is usually missing |

Three consecutive failures, not two, because one run per hour lands inside the
`:55` maintenance break where a failure is expected. Three in a row is fifteen
minutes of tables nobody can hold; the break can never eat three. The probe is
deliberately not paused for the break - the engine is genuinely away for two to
three minutes of every hour, and a probe that looks away for exactly that
window is blind to the restart handoff phase 4 exists to protect.

Putting these numbers on Prometheus as well is left to phase 7, which owns the
phase 1 finding that the alert rules on the box are not the alert rules in this
repo, in both directions. Adding a hand-edited scrape target now would be
adding to the drift that phase exists to end.

### One identity gate, not two

The rule about who a probe may sign in as lived inside `login-probe.js`. A
second probe needed the same rule, and the choice was to copy it or to move it.
Copying a security gate is how two copies drift, and the drifted one is always
the copy nobody remembers exists - the Club Arena realtime programme had just
spent an audit fixing that exact shape on its WebSocket servers.

It is now `src/lib/probeIdentity.js`, imported by both. The law follows it
there and additionally pins that **every** probe imports the shared one and
none declares its own.

### The runbook

`docs/runbooks/tables-say-reconnecting.md`. Four questions for the first four
minutes, then every close code by name with what it means and where to go, then
the 2026-09-03 outage as the worked example with each of its six steps mapped
to the thing that now watches it.

Three sentences in it are the ones a summary would drop and they are pinned by
the law: that **1006 is ambiguous** (the fact that made the outage invisible),
that **a green deploy run is not a deployment** (the workflow reports success
with the cutover skipped, so the image tag on the running container is the only
proof), and that **a probe with no recent rows means silence, not health**.

## Laws

- `tests/every-refusal-has-a-runbook.law.test.ts` (Club Arena) - scans every
  `CLOSE_* = 4xxx` the engine and client declare and requires each to appear in
  the runbook. Add a close code without documenting it and CI goes red. It also
  checks the runbook is linked from the programme document and that every
  relative link in it resolves, because a 3am page that lands on a broken link
  is a page with no runbook.
- `__tests__/synthetic-probes-never-sign-out-a-person.law.test.mjs` (World Hub)
  - extended with LAW 2 (one gate) and LAW 4: the probe opens a real socket,
  waits for a `SNAPSHOT`, distinguishes the outcomes, closes what it opens,
  never calls an endpoint that moves seats or chips, never reports through the
  engine, and is wired into Open Claw with a paging threshold and a runbook
  pointer.

Seven mutations on the World Hub law, seven reds: a bare `signOut()`; a local
copy of the identity gate; accepting any frame instead of `SNAPSHOT`; not
closing the socket; pointing the probe at an HTTP path instead of `/ws/table/`;
a paging threshold of zero; the schedule entry deleted.

## The deep audit (same day) - four defects, all in what had just been built

The phase was pushed and then audited before moving on. Everything below was
found after "done" and fixed in the same branch.

### 1. The migration would have FAILED on apply, taking the function with it

`club_members` carries **34 triggers**. One of them,
`trg_club_members_require_explicit_join`, refuses any insert that does not
declare where the membership came from:

```
MEMBERSHIP_REQUIRES_JOIN: Club Members Can Only Be Added Through Join A Club
```

The migration did not declare one, so it would have aborted on apply - and
because a migration is one transaction, `fn_probe_table_candidate` would not
have been created either. The probe would then have failed on its RPC every
five minutes, reporting a platform that was completely healthy.

Proved BOTH directions with self-aborting probes (CLAUDE.md 11.5, one call, one
`DO` block ending in `RAISE EXCEPTION`, an error being the success case):

| probe | result |
| --- | --- |
| the migration exactly as written | `MEMBERSHIP_REQUIRES_JOIN` - aborts |
| with `set_config('app.club_membership_source','join_club', true)` | `inserted=2`, both `player/active` |

Fixed by setting that value the way `fn_join_club` sets it around the real
join, and by writing the same column list `fn_join_club_membership_impl`
writes, so the row is indistinguishable from a player who joined through the
UI. The other 33 triggers were each checked rather than assumed: the approval
gate returns early for a non-`authenticated` caller, the automated-player guard
only fires for a horse or `is_bot`, the four-club limit is not reached, and
`zz_freeze_guard` carries an explicit carve-out - "a membership row carrying no
chips is identity, not money" - so a `:55` break cannot abort the apply.

The migration now also ENDS with an assertion: if the probe identity is not a
member of both fleet clubs, the apply fails rather than reporting success and
leaving a blind probe behind.

### 2. The happy path had never actually been run

Every earlier verification stopped at a refusal. So the migration was applied,
and the probe's own `openTableSocket` - extracted verbatim from the shipped
file - was run against production with the service account's real credentials:

```
outcome: "ok", opened: true, snapshot: true, open_ms: 1630, snapshot_ms: 1630, frames: ["SNAPSHOT"]
```

**That is the first time in this programme that anything has proven, from
outside, that a player can hold a table.** The four viewer gates cost ~1.6 s,
comfortably inside the 15 s timeout.

The same run also confirmed Phase 3 / CLAUDE.md 10.10 rule 3 working in
production: a deliberately stale token produced a completed handshake and a
`4401 auth:http_400` close, not a bare pre-handshake 401.

### 3. The probe was shipping a law violation

`__tests__/a-probe-that-cannot-run-says-so.law.test.mjs` requires every probe
under `pages/api/cron/` to route its "missing env" early return through
`unconfiguredProbe()`, which writes a `failed` heartbeat FIRST and then returns
the 500 - because a probe that writes no row is indistinguishable from one that
was never scheduled, and a dashboard cannot draw a red badge for a row that
does not exist. That is recovery-probe's 2026-09-04 defect. The new probe
hand-wrote its own `{ status: 'unconfigured' }` and the law was red. Fixed;
both probe laws green.

### 4. Two outcomes existed in code and in no runbook

`construct_failed` and `closed_before_snapshot` could be reported and had no
section in the runbook - an outcome is the diagnosis, so an unlisted one is a
page with no page to turn to. Both documented, and the set is now
`PROBE_OUTCOMES`, pinned BOTH ways: every outcome the code produces must be
registered, and every registered outcome must be produced. Writing that pin
immediately caught a second problem - two outcomes hidden inside a ternary,
which the scan could not see - so the ternary became two explicit branches.
Three mutations, three reds.

### 5. A scheduler's 200 is not proof the job ran

The probe's FIRST scheduled run, 10:23:00 UTC, returned `vercel 200 in 0.4s` -
and wrote no heartbeat row. Vercel had not finished deploying the merge, and
something upstream answered 200 for a route that did not exist yet. Had the
audit stopped at the dispatcher's green tick, the phase would have been
reported as verified while the probe had never executed once.

The 10:28:00 run took 3.0 s at the dispatcher and left this in
`probe_heartbeats`:

    status ok · 1290 ms · login 323 ms · socket open 794 ms · SNAPSHOT at 796 ms

with the matching `success` in `cron_health_log`, so `check-cron-fleet-alive`
can see it stop. **The row is the proof. The tick is not** - which is the same
lesson as "a green deploy run is not a deployment", one layer up.

### Also checked, and correct

- `maxDuration: 60` is already used by sixteen other routes on this plan.
- The heartbeat insert was run against the real `probe_heartbeats` table inside
  a rolled-back transaction: accepted, `occurred_at` defaults.
- The live Open Claw dispatcher is byte-identical to `main`, the service is
  active, and the deploy key and server IP both resolve - so
  `bash scripts/deploy-openclaw.sh` will work the moment the World Hub PR
  merges. **That deploy is the one manual step this phase leaves.**

## Found during Phase 6, recorded and NOT fixed here

**Five refusals are still written before the handshake, and every one reaches
the client as a bare 1006.** Phase 3 and CLAUDE.md 10.10 rule 3 fixed this for
the auth refusal - an invalid token now completes the handshake and closes 4401
with a reason - precisely because a pre-handshake refusal is indistinguishable
from a dropped link and the client spins on it forever. The same treatment was
never given to the four viewer gates in `EngineWebSocketServer`'s upgrade
handler:

| gate | status written | what the player sees |
| --- | --- | --- |
| not a member of the table's club | 403 | reconnecting, forever |
| banned by a club/union blacklist | 403 | reconnecting, forever |
| the table is seats-only (`restrict_observers`) | 403 | reconnecting, forever |
| IP rule: another account is at that table from this address | 403 | reconnecting, forever |
| the table does not exist and could not be started | 404 | (the client does check the break row before believing this one) |

Every one is a CORRECT and PERMANENT refusal, and the client cannot tell any of
them from a flaky link. A player who opens a stale link to a club they left
gets the twenty-two-hour experience in miniature, with nothing on any dashboard.

It is not fixed here because it is an engine change with a client half - each
gate needs a close code and a reason, and `EngineStateClient` needs to stop
laddering on them - and this phase is the outside view, not the protocol. It is
the first item for the phase 6 audit. The runbook documents how to diagnose it
by hand in the meantime, which is the part that matters at 3am.

## What this phase deliberately did not do

- **It does not act on a table.** No `/action`, no `/addchips`, no seat, no
  chips - pinned by the law. A monitor that plays poker every five minutes is
  the 2026-08-25 incident (CLAUDE.md 11.5).
- **It does not create a second scheduler.** CLAUDE.md 10.85: Open Claw, never
  the Claude scheduler, and never a GitHub `schedule:` for application logic.
- **It does not add a Prometheus scrape target.** See above; that is phase 7.
