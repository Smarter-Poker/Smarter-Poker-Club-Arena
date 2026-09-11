# Real-Time Connections Programme

## Current Continuation Checkpoint (September 10, 2026)

The interrupted September 10 continuation has been recovered. PR #4195 is
merged, published and covered by passing production pagination acceptance.
An older uncommitted ticker query is preserved and completed in the closeout
branch. See `docs/audits/2026-09-10-realtime-closeout-checkpoint.md` and its JSON
for source identities, production evidence and the remaining engine/device/log
acceptance. The historical receipts below remain intact; this is not a claim
that the full programme is certified complete.

The September 11 closeout audit repairs hidden-tab refresh delivery and ticker
account/read ownership. Its scope and regression evidence are recorded in
`docs/changelog/2026-09-11-realtime-refresh-recovery-closeout.md`. Publication is
verified through the associated PR release receipt. The engine, natural-event,
physical-device and detailed-log gates remain open.

## Built-In Execution Standard (September 9, 2026)

Significant Club Arena work must have a built-in server owner and durable
recovery. Cron is a secondary safeguard or housekeeping mechanism, not the
sole progress path. See `docs/standards/EVENT-DRIVEN-EXECUTION.md`.

The Supabase email has been reconciled against current schema, cron history,
subscriptions, and delivery records in
`docs/audits/2026-09-09-supabase-email-reconciliation.md`. The reminder ownership
replacement is published and verified in `docs/audits/2026-09-09-tournament-reminder-release.md`.
The missing detailed-log/device evidence remains open.

Dan, 2026-09-04, after a 22-hour "Reconnecting To The Table" outage that
every monitor slept through: "TAKE EVERYTHING YOU JUST SUGGESTED, AND CREATE
A COMPREHENSIVE BUILD PLAN AND BREAK IT DOWN INTO PHASES. DO ONE PHASE AT A
TIME ... ENSURE THAT EVERYTHING WAS PUBLISHED BEFORE CLAIMING SUCCESS."

A phase is done when its code is merged, published (engine deployed and/or
Club Arena `build-info.json` showing the sha), and verified on production by
reading, not assuming. The list below is the order; each phase records its
verification when it lands.

| Phase | Name                                             | Delivers                                                                                                                                                                                  | Status                                              |
| ----- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | Measure                                          | `poker_act_to_broadcast_ms{audience}` and `poker_actions_fleet_total` on the always-on `/metrics`; `ActionLatencyDegraded` / `ActionLatencyCritical` alert rules                          | done                                                |
| 2     | See the client                                   | Beacon from four client failure sites -> `POST /client-event`; bounded per-user counting in the engine; `PlayersReconnectingRepeatedly` + `TablesAreReloadingThemselves` alerts; two laws | done                                                |
| 3     | Do no harm                                       | Auto-reload failsafe skips auth closes; idempotency key on `/action` (client + handler)                                                                                                   | done                                                |
| 4     | Restart handoff + protocol                       | `restart_in_ms` frame at :53 and a ladder that waits it out; `v` on subscribe and `4426 upgrade_required`                                                                                 | done                                                |
| 5     | Trust and limits                                 | Server clock offset for turn timers; periodic re-auth of live sockets (5 min, cached); per-user socket cap with `4429`; explicit Caddy WS timeouts in the clocks law                      | done                                                |
| 6     | Prove it from outside                            | Synthetic table probe on Open Claw (real socket to a horse-only table, wait for SNAPSHOT, close); runbook `docs/runbooks/tables-say-reconnecting.md`                                      | done                                                |
| 7     | Guardrails                                       | Vercel env-var change audit (names + updatedAt, never values); CLAUDE.md rules (agents never set credentials; never hand-write what a monitor reads); alert canary                        | done                                                |
| 8     | Connection ownership and refusal recovery        | Retire superseded wake listeners; handle protocol and capacity refusals consistently across table and channel sockets                                                                     | published; device acceptance open                   |
| 9     | Financial reconnect and refresh ownership        | Refresh after every channel open; bypass stale cashier cache; retain invalidations during reads; reject retired balance responses                                                         | published; device acceptance open                   |
| 10    | Cashier history recovery and scope ownership     | Retain history invalidations; isolate user and club results/cache; preserve confirmed rows on read failure                                                                                | published; device acceptance open                   |
| 11    | Tournament lobby snapshot recovery               | Re-read on channel subscription; coalesce invalidations; replay live patches over snapshots; isolate retired tournament/account reads; preserve confirmed data on failure                 | published; device acceptance open                   |
| 12    | Notification feed recovery and account isolation | Coalesced fresh reads, owned cache and mutations, truthful failure states, safe server feed queries, and restored notification publication                                                | published; natural-event and device acceptance open |

Phase 17: Daily Missions subscription handoff. Nine mounted cases pass,
including recovery of an update missed between the first read and channel
acknowledgement. Current cursors avoid a duplicate dashboard read and retired
subscriptions cannot apply late replies. Implementation and build verification:
`docs/changelog/2026-09-10-realtime-phase17-mission-subscription-handoff.md`.
PR4175 is published; exact public/origin bytes were verified at 14:59:28 UTC.
Release evidence: `docs/audits/2026-09-10-realtime-phase17-release.md`.
The full Daily Missions production canary subsequently passed in run 34501771061. Broader programme, natural-event and physical-device acceptance
remain open; the release receipt records the remaining failures.

Phase 16: Cashier directory readiness. Five mounted failures reproduced and
repaired. All eight new cases and 41 existing Cashier/membership contracts pass.
Pending reads cannot give false Join guidance or trigger competing retries;
known cached wallets stay usable. PR4125 is published; exact public/origin bytes
were verified on September 10 at 07:02:36 UTC. Production UI, natural reconnect,
and physical-device acceptance remain open.
Exact evidence: `docs/audits/2026-09-10-realtime-phase16-release.md`.
Subsequent production acceptance, the Cashier canary readiness correction, and
loaded-fleet qualifications: `docs/audits/2026-09-10-realtime-acceptance-follow-through.md`.
Scope: `docs/changelog/2026-09-10-realtime-phase16-cashier-directory.md`.
A subsequent live run exposed Cashier menu clipping at 320px. PR4154 repaired
it and both unchanged production Cashier cases passed at exact release f1992eeb
in run 34457185978. Fresh public/origin bytes still contained the repair at
13:03 UTC. See `docs/audits/2026-09-10-realtime-phase16-cashier-acceptance.md`.
Natural reconnect, physical iPad/PWA, and broader programme acceptance remain open.

Phase 16 follow-through: the Cashier, mobile and freeze repairs are published
and covered by production acceptance. Run 34488597022 passed 288 of 292
executed tests, including both Cashier cases, full Daily Missions certification,
all seven Club Data cases and all 259 sweep cases. The cash selector advances
past its old fixture failure. Four continuity tests remain blocked by the
coordinated engine release prerequisite; physical-device/natural reconnect and
detailed Supabase log/egress evidence remain open.
Evidence: `docs/audits/2026-09-10-realtime-phase16-final-software-acceptance.md`.
Earlier mobile receipt: `docs/audits/2026-09-10-realtime-phase16-mobile-follow-through.md`.

Phase 15: Confirmed tournament inventory. Seven stale-card and realtime-race
failures reproduced and repaired. All 26 mounted cases and 39 existing scope
and anti-flicker contracts pass. PR4104 is published; exact public/origin bytes
were verified on September 10 at 05:26:52 UTC. Natural-event, production UI
and physical-device acceptance remain open.
Exact evidence: `docs/audits/2026-09-10-realtime-phase15-release.md`.
Subsequent production run 34440738779 passed two Cashier and six ClubLobby cases,
with two ClubLobby skips; the overall run still had nine failures. Three account
preflight paths omitted the outer Terms gate before profile readiness. Their
correction is recorded in `docs/changelog/2026-09-10-production-account-terms-preflight.md`;
run 34449578074 verified the repaired preflights and footer. Full acceptance remains open.
Scope: `docs/changelog/2026-09-10-realtime-phase15-confirmed-tournament-inventory.md`.

Phase 14: Lobby inventory and waitlist recovery. PR4095 is published and the
actually referenced public/origin page bytes are verified. Production UI,
natural reconnect and physical-device acceptance remain open.
Exact evidence: `docs/audits/2026-09-10-realtime-phase14-release.md`.
Scope: `docs/changelog/2026-09-10-realtime-phase14-lobby-inventory.md`.

Phase 13: Club lobby recovery ownership. Eight mounted regressions reproduced
and repaired; 71 focused tests pass. PR4085 is published; post-release browser,
natural reconnect and physical-device acceptance remain open.
Exact publication evidence: `docs/audits/2026-09-10-realtime-phase13-release.md`.
Scope: `docs/changelog/2026-09-10-realtime-phase13-lobby-recovery.md`.
Engine release sealing and Stage-B cutover remain with the coordinating task.

Phase 12 scope: `docs/changelog/2026-09-10-realtime-phase12-notification-recovery.md`.
Published client/API and controlled-browser evidence: `docs/audits/2026-09-10-realtime-phase12-release.md`.
Supabase follow-through: `docs/audits/2026-09-10-supabase-email-follow-through.md`.
Full-fleet acceptance remains blocked by the existing staged tournament seat-move database dependency.

Phase 11 scope and regression evidence: `docs/changelog/2026-09-09-realtime-phase11-tournament-snapshots.md`.
Published release and controlled-browser evidence: `docs/audits/2026-09-09-realtime-phase11-release.md`.

Phase 10 scope and regression evidence: `docs/changelog/2026-09-09-realtime-phase10-cashier-history.md`.

Phase 9 (2026-09-09) follows missed financial updates through the actual
channel, MasterBus consumers, and displayed balance stores. Scope and evidence:
`docs/changelog/2026-09-09-realtime-phase9-financial-recovery.md`.
PR3955 and its public/origin publication were verified on 2026-09-09 at
07:40 UTC. Exact runtime asset evidence is in the phase changelog and audit JSON.

Phase 8 (2026-09-09) extends the programme after the callback ownership and
loaded-fleet repairs. Scope and reproducible evidence:
`docs/changelog/2026-09-09-realtime-phase8-connection-ownership.md`.
Release evidence: PR3939 merged as 27bdfaadb42e520565d48676da19b7867803bd57;
public and origin publication plus the referenced JavaScript verified at
2026-09-09 06:50 UTC. See the phase changelog for exact build and test evidence.
Physical iPad/PWA acceptance remains separate from automated transport evidence.

Not in the programme, because they are Dan's decisions, recorded so they are
not lost: Log Out scope (global today; local by default with an explicit
"Sign Out Everywhere" is the usual shape); Supabase JWT expiry (7 days
today; 1 hour surfaces a revoked session within the hour); a second engine
upstream (the standby was collapsed on 2026-08-23 and there is no failover).

The final entry-read audit also repairs Daily Bonus host and account lifetime.
See `docs/changelog/2026-09-11-daily-bonus-entry-read-lifetime.md` for the seven
reproduced regressions and the unchanged wider acceptance gates.

## Found during Phase 1: the alert rules on the box are not the ones in this repo

**This is the biggest single finding of the phase and it is not a Phase 1
deliverable.** Discovered 2026-09-05 03:0x while verifying that the
ActionLatency rules were live: they were gone, four hours after being loaded
and confirmed healthy.

- `deploy.sh` symlinks `/opt/smarter-poker-monitoring/alert-rules.yml` to
  `/opt/smarter-poker-monitoring-src/infra/monitoring/alert-rules.yml`, a
  clone of this repo. **That directory does not exist on engine-01.**
- The live file is a plain 24,963-byte file, last written 2026-09-04 21:41,
  carrying groups (`money-health`, `settlement`) that this repo's
  `infra/monitoring/alert-rules.yml` does not contain - and missing groups it
  does contain (`vercel-health`, `action-latency`).

So the two directions both fail: **a rule added to the repo never reaches
production**, and **a rule added on the box is erased by the next write**.
Every alert-rule change in this incident - EngineRefusingSessions,
EngineCannotReachAuth, both ActionLatency rules - was lost this way and had
to be re-applied by hand.

That is the same shape as the outage that started this programme: a monitor
that is not what everyone believes it is. Fixing it (one source of truth,
plus a check that the box's rules match the repo's) is added to **Phase 7 -
Guardrails**. Until then, an alert rule is not live because it merged; it is
live when `/api/v1/rules` says so.

## Every format, not just cash (Dan, 2026-09-05)

Dan: "you need to fix the real time connection to the spins, heads up and
mtt's as well. not just the cash game tables."

**Checked first, because the answer changes the work.** Spins, SNGs,
heads-up and MTTs are not a separate transport: there is ONE
`ServerTableEngine` hierarchy and ONE table socket (`/ws/table/:id`), so
every phase of this programme reaches all of them by construction. Two
things were verified rather than assumed:

- The MTT/Spin-specific realtime moment - a player MOVED by table balancing -
  is wired end to end. The engine emits `seat_moved` with `to_table_id` on
  the old table's socket, and `TablePage` follows it (`case 'SEAT_MOVED'`,
  navigating or swapping the embedded id). I first searched for the
  lower-case event name, found nothing, and nearly reported it missing; it
  is normalised to upper case before the switch.
- `TOURNAMENT_EVENT` on the channel socket, however, is **dead**. It is
  emitted only by `POST /channels/tournament/:id/event`, which requires
  `INTERNAL_API_KEY`, and its only caller is
  `RealtimeChannelService.broadcastTournamentEvent` - a BROWSER method
  sending a player's Supabase JWT, which that route always rejects. Nothing
  server-side calls it. So `JOIN_TOURNAMENT` subscribes to a channel that
  never delivers. Added to Phase 2.

**What was genuinely missing, and is now fixed:** the latency instrument
was labelled only by audience, so a Spin's p95, a heads-up SNG's and an
MTT final table's were one indistinguishable number mixed in with cash.
"Are Spins slow?" had no answer. `poker_act_to_broadcast_ms` and
`poker_actions_fleet_total` now carry `format=cash|spin|hu_sng|mtt`, derived
from the existing `TournamentBrainContext` (a synchronous cached read,
already warmed per tournament table; heads-up comes from seats at one table,
not a type string). Both alert rules group by `format`, so a slow Spin
alerts on its own p95 instead of hiding inside a cash average. Four values,
eight series with audience - still never a `table_id`.

A tournament whose context has not loaded reports `mtt`, never `cash`:
falling back to cash would file Spins and MTTs under cash and hide exactly
what this label exists to show. The law pins that.

## Phase 1 audit (2026-09-05) - what a deep pass found after "done"

Three real defects, all shipped, none of which any test would have caught:

1. **A degraded horse action was invisible.** The horse instrumentation sat
   ABOVE the check/fold fallback, so a horse whose intended action was
   rejected still reached the felt through the degrade and was neither counted
   nor timed. It keys on the same `applied` that `markProgress()` uses now -
   the one place that already means "this seat acted", whichever of the three
   attempts landed. The law pins the ordering and is red against the shipped
   code.

2. **Nine money alerts existed only on the monitoring box.** `settlement` and
   `money-health` - HandsAreFailingToSettle, NoHandsAreSettling,
   MoneyAlertsGoingUnread and six more - were in no repository. Since
   `deploy.sh` SYMLINKS the repo's `alert-rules.yml` over the live one, the
   first person to run it would have silently deleted every one of them.

3. **The SLO files in this repo said `groups: []`** while `slo-objectives` and
   `slo-recording` ran 14 healthy rules on the box. Same symlink, same
   deletion, same silence.

All three groups are recovered into `infra/monitoring/` verbatim, so the repo
is now a SUPERSET of what is live and a deploy can only ever add. Every one of
the seven rule files validates against the live Prometheus (73 rules).
`tests/an-alert-that-is-live-is-in-the-repo.law.test.ts` names all sixteen
live groups; it found defect 3 by itself, one minute after being written.

This is the same disease as the outage that started the programme - a monitor
that is not what everyone believes it is - and it is why Phase 7 gets a
reconciler that compares `/api/v1/rules` against these files continuously.

## Phase 2 - See the client (2026-09-05)

**Why.** Phase 1 measured what the engine does. On 2026-09-03 the engine was
perfect - 5,700 hands per ten minutes - while nobody could play, because the
broken half was the browser's and nothing it saw reached this platform.

**What.** `clientConnectionBeacon` posts one word to `POST /client-event`
from the four sites a client actually loses a socket: `auth_failed`,
`stale`, `handshake_timeout`, `auto_reload`. Per-user counting happens in the
engine over a bounded rolling hour, so the alert Dan asked for ("one player
reconnecting more than N times an hour") exists without putting 1,300 user
ids into Prometheus. Two alerts, two laws, both registered. Full reasoning:
`docs/changelog/2026-09-05-realtime-phase-2-see-the-client.md`.

### Carried out of Phase 2, deliberately not built: the tournament channel

`TOURNAMENT_EVENT` is dead end to end, and it was worth proving rather than
assuming:

- nothing calls `subscribeToTournament` - no page, anywhere;
- its only emitter is `RealtimeChannelService.broadcastTournamentEvent`, a
  BROWSER method sending a player's Supabase JWT to
  `POST /channels/tournament/:id/event`, which requires `INTERNAL_API_KEY`
  and therefore always rejects it;
- nothing server-side calls that route either;
- tournament pages poll every 30 seconds instead (`XMTTPage`).

So `JOIN_TOURNAMENT` subscribes to a channel that has never delivered a
message. This is a FEATURE GAP, not a correctness bug - MTT and Spin players
at a table are served by the table socket, which Phase 1 measures and Phase 2
now watches. Building the channel properly (server-side emission from
`TournamentManagerBase`, pages subscribing, polling retired) is a feature and
belongs in its own phase with Dan's sign-off, not smuggled into an
observability phase. It is recorded here so nobody reads the existing code as
a working path.

## Phase 7 - Guardrails (2026-09-06)

**Why.** Phase 1 wrote down, as its biggest single finding and not one of its
own deliverables, that the alert rules running on engine-01 were not the alert
rules in this repo IN BOTH DIRECTIONS. Everything phases 1 to 6 built ends in an
alert or a number, so a monitoring stack nobody can trust makes all of it
decoration.

**What was true, measured before anything was changed:** 72 alerts running on
the box, 79 declared here, **15 declared and never once evaluated** - among them
`EngineRefusingSessions` and `EngineCannotReachAuth`, the two THIS PROGRAMME
wrote in phase 1 so the outage it exists to prevent would page somebody - and
**8 running that this repo had never seen**, hand-authored on the box on
2026-09-04 with good reasoning and a changelog reference that was never
committed. `deploy.sh` symlinks this repo over the live files, so the first
person to run it would have deleted all eight.

**Why it drifted, which is the part worth fixing.** Nobody was careless. THREE
LISTS had to agree and nothing checked them: `prometheus.yml`'s `rule_files`
(7 files), `docker-compose.yml`'s mounts (7), and `deploy.sh`'s symlink loop
(**4**). Four rule files therefore existed on the box only because a hand had
put them there. This repo also carried three EMPTY alert groups - headings with
no rules under them, which read as coverage.

**What.**

1. **The reconciliation is a union - nothing deleted.** The 8 box-only alerts
   are here now, verbatim, comments intact. `vercel-health` is deleted rather
   than left empty, carrying the box author's reason. Of the 38 alerts in both,
   **zero** differ in `expr` or `for` except three, all the same way, and the
   repo is right: `EngineHandsStopped`, `EngineLivenessDead` and
   `EngineScrapeDown` carry the maintenance-break guard here and did not on the
   box, so those three have been paging about the `:55` break every hour -
   CLAUDE.md 13 rule 6 written down and violated in production.
2. **`deploy.sh` symlinks every rule file Prometheus loads** - four became ten.
   Without this the reconciliation drifts again inside a week.
3. **A threshold re-derived, not guessed.** `EngineRefusingSessions` shipped as
   `>= 6 in 15m`; the live series measures avg 1.1, p95 9.2, max 32.3 per 15
   minutes, so it sat BELOW the ordinary p95 and would have fired for ever on
   expiring tokens. It now fires on refusals happening WHILE a client is stuck
   in a reconnect loop - both true continuously on 2026-09-03, and
   `poker_ws_clients_reconnecting_badly` measured 0 for 24 hours straight in
   ordinary churn. A volume-only backstop at `>= 60` covers a broken beacon.
4. **The canary.** `MonitoringCanary` fires unconditionally, wakes nobody, and
   its ABSENCE is the signal.
5. **`scripts/ci/check-alert-rules-match.mjs`** asks Prometheus what it runs and
   Alertmanager whether it holds the canary. It **exits 2 when it cannot reach
   the stack**: a monitoring check that goes green when it can see nothing is
   the bug it exists to catch.
6. **CLAUDE.md 10.84**, two rules from the two halves of the outage: an agent
   never SETS a credential (the twenty-two hours began with one environment
   variable), and never hand-writes what a monitor reads.

**Laws.** `tests/what-a-monitor-reads-is-what-the-repo-says.law.test.ts`. Six
mutations, six reds - including one found by mutating the law itself, where a
pin passed because the checker's header still mentioned the canary it had
stopped looking for. Full reasoning:
`docs/changelog/2026-09-06-realtime-phase-7-guardrails.md`.

**Still open, recorded rather than quietly fixed:** 32 of 89 alerts carry no
`runbook:` annotation; six of twelve `engine-freeze` alerts have no break guard
and whether each NEEDS one is a per-alert judgement; `slo-rules.yml` and
`slo-alerts.yml` read a blackbox exporter this stack does not deploy.

## Phase 7 audit (2026-09-06) - the one that would have deleted the pager

1. **A deploy would have DELETED THE 3AM PAGER.** `deploy.sh` symlinks
   `alertmanager.yml` too, and the live file carried a `pager-sms` receiver and
   a `page="sms"` route this repo did not have - added on the box 2026-09-04,
   its comment citing a test that was never committed here either. The next
   deploy would have removed paging silently, and the rule-orphan guard would
   have said nothing because it only reads alerts. The routing is in the repo
   now, and the deploy has a second guard that refuses to lose a receiver or a
   route matcher.
2. **The canary would have emailed ops every hour, for ever.** The top-level
   fallthrough receiver is `email-critical` and nothing matched
   `severity="canary"` - alert fatigue manufactured by the thing built to
   prevent it. Explicit route to `null-receiver`, pinned by the law.
3. **The last report ended by asking Dan to run a command.** A deploy that
   depends on somebody remembering is the same class of thing as a rule nobody
   loaded. `.github/workflows/deploy-monitoring.yml` now does it on merge,
   guards both hazards first, and verifies by reading.

**Verification.** `promtool` validates all seven rule files (96 rules) and
`amtool` the routing. Against `main`, `alert-rules.yml` gained the eight
rescued alerts and removed nothing, with no shared expression changed. The
deploy and its final `check-alert-rules-match.mjs` run automatically on the
merge that carries this; before it, the checker reads 72 running against 89
declared and no canary, which is the "before" this phase closes.

## Phase 6 - Prove it from outside (2026-09-06)

**Why.** Phases 1 to 5 gave the platform eyes, and every one of them looks at
the platform FROM INSIDE THE PLATFORM. The thing that was broken on 2026-09-03
was not visible from inside: the engine was healthy and dealing 5,700 hands per
ten minutes, `/api/health` was green because the engine was healthy, the lobby
was green because PostgREST checks a JWT's signature and not its session, and
`login-probe` was green because GoTrue was issuing tokens perfectly - it was
this platform's own cron revoking them a moment later. Every monitor answered
an HTTP question. The player's question is a WebSocket one, and nothing
anywhere was asking it.

**What.**

1. **A synthetic client that does what a player does**, every five minutes, on
   Open Claw: sign in, open a REAL `wss://` socket to a table that is dealing
   (`['bearer', jwt]` subprotocol - the client's own code path, on Node's
   global `WebSocket`), wait for the first `SNAPSHOT`, close, sign out scope
   local. It could not be a `fetch`: the upgrade runs the protocol gate (4426),
   the token verdict that separates revoked from unreachable (4401 vs a
   pre-handshake 503), the socket cap (4429) and the subscribe - none of which
   an HTTP request touches.
2. **A table chosen at runtime, never hardcoded** (`fn_probe_table_candidate`):
   running, cash, at least three hands in the last ten minutes, no human
   seated, picked at RANDOM among the qualifying rooms. Recent hands are
   load-bearing - the hub only sends a snapshot when it has one, so an idle
   table would report "no felt arrived" for a table that is merely quiet.
   Always picking the busiest would let one healthy table mask a broken fleet.
   Zero rows is an answer, not an error: the fleet is not dealing.
3. **The outcomes are distinguished**, because they send you to different
   places: `refused` (1006, the ambiguous one that cost twenty-two hours),
   `auth_refused` (4401), `no_snapshot` (the socket opened and the felt never
   came - a completely different fault), `handshake_timeout`, `table_not_found`,
   `rate_limited`, `probe_outdated` (4426 - the PROBE needs raising, not an
   outage).
4. **`docs/runbooks/tables-say-reconnecting.md`** - four questions for the
   first four minutes, every close code by name, and the 2026-09-03 outage as
   the worked example with each of its six steps mapped to the thing that now
   watches it.

**The design decision of the phase: it does NOT report to the engine's
`/metrics`.** That would be tidy and consistent with phases 1, 2 and 5, and it
is the exact mistake this probe exists to avoid - a monitor that reports
through the thing it monitors cannot report the outage it was built for. If the
engine is refusing sockets it can refuse the probe's POST too, and a gauge that
stops moving looks exactly like a quiet night. The result goes to
`probe_heartbeats`, to an ops email, and to Open Claw's `CRITICAL_JOBS` (three
consecutive failures page by SMS - three rather than two because one run per
hour lands inside the `:55` break, and the break can eat one run but never
three). SILENCE is covered by `check-cron-fleet-alive.mjs`, which asks Postgres
how long it has been since any Open Claw job ran - because a probe that stops
running is silent, and silence looks like health.

Putting these numbers on Prometheus waits for **Phase 7**, which owns the phase
1 finding that the alert rules on the box are not the rules in this repo, in
both directions. Adding a hand-edited scrape target now would be adding to the
drift that phase exists to end.

**Also here:** the "who may a probe be" gate moved out of `login-probe.js` into
one shared module both probes import - a copied security gate is one that
drifts, which the phase 5 audit had just finished proving on the WebSocket
servers.

**Laws.** `tests/every-refusal-has-a-runbook.law.test.ts` (every `CLOSE_* =
4xxx` must appear in the runbook, so a new close code cannot ship undocumented)
and the World Hub's `synthetic-probes-never-sign-out-a-person.law.test.mjs`
extended with the one-gate and real-socket pins. Seven mutations, seven reds.
Full reasoning:
`docs/changelog/2026-09-06-realtime-phase-6-prove-it-from-outside.md`.

**Running it before shipping it found the bug.** The first table picker asked
for any busy horse-only table. Run against production from the Mac with the
service account's real credentials, it came back `refused`, close 1006 - and
`curl --http1.1` gave the real answer: a pre-handshake `403 Forbidden`. Nothing
was broken. `authorizeTableViewer` fails closed on club membership, and the
service identity was not a member of either club that runs the live cash fleet.
**A probe that picks tables it may not open measures its own membership, not
whether a player can hold a table**, and it would have paged forever while the
platform was healthy. Fixed by making the picker mirror EVERY gate the upgrade
applies, and by making the probe an ordinary `player` member of those two clubs

- the alternative was a god-role bypass in the viewer gate, which is the shape
  of bug this programme exists to stop.

**Found here, recorded, NOT fixed here: five refusals are still written BEFORE
the handshake** (not a club member, banned, seats-only table, IP conflict, and
table-not-found), so each reaches the client as a bare 1006 and the tab
reconnects forever with no explanation. Phase 3 gave the auth refusal a real
close code (4401 + reason) for exactly this reason and the four viewer gates
never got the same treatment. It is an engine change with a client half, so it
is the first item for the phase 6 audit; the runbook documents how to diagnose
it by hand meanwhile.

## Phase 6 audit (2026-09-06) - four defects, all in what had just been built

1. **The migration would have FAILED on apply.** `club_members` carries 34
   triggers and `trg_club_members_require_explicit_join` refuses any insert
   that does not declare its source - so the migration would have aborted, and
   with it `fn_probe_table_candidate`, leaving the probe to fail every five
   minutes against a healthy platform. Proved both directions with self-
   aborting probes (11.5): as written it raises `MEMBERSHIP_REQUIRES_JOIN`;
   with `set_config('app.club_membership_source','join_club', true)` - the
   value `fn_join_club` sets around the real join - both rows insert. The
   migration now ends with an assertion, so an apply cannot report success
   while leaving the probe blind.
2. **The happy path had never been run.** Every earlier verification stopped at
   a refusal. The migration was applied and the probe's own `openTableSocket`,
   extracted verbatim from the shipped file, was run against production:
   `outcome: "ok"`, socket open in 1630 ms, `SNAPSHOT` received. **That is the
   first time in this programme that anything has proven, from outside, that a
   player can hold a table.**
3. **The probe was shipping a law violation** - it hand-wrote its
   `unconfigured` response instead of `unconfiguredProbe()`, which writes the
   heartbeat FIRST. `a-probe-that-cannot-run-says-so.law` was red.
4. **Two outcomes existed in code and in no runbook.** Both documented; the set
   is now `PROBE_OUTCOMES`, pinned in both directions, which immediately caught
   two more outcomes hidden inside a ternary.

**Verification.** Client half: `fn_probe_table_candidate` live, the service
identity a member of both fleet clubs with zero chips, and a real `wss://`
socket to a live table returning `SNAPSHOT` in 1.63 s. Engine half: nothing to
deploy - the probe runs outside the engine, which is the point. **Remaining
manual step: `bash scripts/deploy-openclaw.sh` once the World Hub PR merges**,
or the schedule exists in the repo and not on the box (World Hub CLAUDE.md
11.3). The live dispatcher was checked and is currently byte-identical to
`main`, so there is no pre-existing drift to untangle.

## Phase 5 - Trust and limits (2026-09-06)

**Why.** Three things a live socket still took on trust: that the device's
clock is right, that the session behind it is still valid, and that one account
cannot open sockets without limit.

**What.**

1. **There is one server clock.** This phase was meant to ADD an offset; it
   already existed TWICE, with opposite signs, born eighteen days apart -
   `utils/serverClock` (`Date.now() - offset`) and `lib/serverClock`
   (`Date.now() + offset`). Same name, same meaning, inverted arithmetic, so
   one wrong import path would have turned a three-second-fast phone into a
   three-second-SLOW one and doubled the error on the turn ring. The
   latency-corrected estimator was fed only by snapshots and drove the turn
   clock; the rough one, which ignores latency on purpose, was fed by every
   frame. Folded into one, `lib/serverClock` deleted.
2. **Trust has to be renewed.** A socket was authenticated once at the upgrade
   and trusted forever after - the 2026-09-03 outage from the other side. Every
   live socket now re-asks GoTrue every five minutes, staggered per socket and
   bounded per sweep, and ONLY a definitive rejection closes it.
3. **A cap of ten sockets per account**, refusing the ARRIVING socket with 4429
   rather than evicting one that may be carrying a hand.
4. **The socket clocks agree.** Four clocks in four files, one of them not in
   this repo, held together by relationships nothing checked. Now pinned.
   Measured on the box: Caddy sets no timeout at all for the engine vhost, so
   the 25-second ping clears every default comfortably.

**Found and NOT fixed here:** the repo carries TWO Caddyfiles for
`engine.smarter.poker` and neither is what is running. Same shape as the Phase 1
alert-rules finding; it belongs to Phase 7's reconciler, and picking a winner
between three files is a decision rather than a cleanup.

**Laws.** `tests/there-is-one-server-clock.law.test.ts`,
`server/src/transport/trustIsRenewedAndBounded.law.test.ts`, and the socket
clocks added to `the-break-clocks-agree`. Six mutations, six reds. Full
reasoning: `docs/changelog/2026-09-06-realtime-phase-5-trust-and-limits.md`.

**Verification.** Client half published as `9685001e6`. The engine half is
BUILT AND STAGED on engine-01 and not yet running: the deploy workflow's run
for `d3c1855ed` reported success with the cutover SKIPPED, because the next
`:55` break was 3123s away and beyond that run's budget - its own step is named
"DID NOT DEPLOY - this run shipped nothing" and it says in the summary "do not
treat this tick as proof the engine is running your code". The running image is
still `7a1d19390` (#3224), and `poker_ws_reauth_closed_total` and
`poker_ws_socket_cap_refused_total` are absent from engine-01's Prometheus
while `poker_ws_protocol_refused_total` (Phase 4) is present - which is the
same statement read from the other end. It cuts over at the next window with no
rebuild. **A green deploy run is not a deployment**; the image tag on the
running container is.

## Phase 5 audit (2026-09-06) - what a deep pass found after "done"

Two defects, both the shape this programme keeps finding: a mechanism that is
correct where you look and absent where you do not.

1. **Re-auth and the cap reached two of the three sockets.** `/ws/channel` had
   neither - and Phase 4 had written the warning for exactly this ("a version
   on two of the three sockets is worse than none") one phase earlier. It is
   the worst of the three to have missed: that socket carries club presence,
   the lobby, hand replay and `FINANCIAL_UPDATE`, so a revoked session went on
   receiving a player's wallet balance and ledger entries indefinitely. The
   mechanism moved into `server/src/transport/wsHelpers.ts`
   (`runReauthSweep`, `socketsHeldBy`, `staggeredReauthAt`) and both servers
   call it with their own map, label and numbers - one implementation, three
   sockets, no way for two to drift.

2. **The clock was unified and its callers were not.** Phase 5 folded two
   `serverNow()` implementations into one and pinned five consumers; eleven
   OTHER places were still subtracting `Date.now()` from an instant the engine
   or Postgres stamped. The worst was `MultiTablePage`: the table's own turn
   ring read the server clock and the multi-table tab strip did not, so a
   skewed device showed two different countdowns for one hand and the player
   believed the one they were looking at. Also `inAnnouncedRestart()` - the
   Phase 4 window itself, which a fast phone would leave early and escalate
   its ladder into the very restart the window exists to wait out - the
   insurance countdown on a decision that spends chips, the disconnect grace
   clock whose comment read "no drift under clock skew", the break countdown,
   the tournament clock and the sit-out clock.

**A law that only reads source is half a law.** `trustIsRenewedAndBounded` was
all source pins, and a mutation making the per-user cap count every socket in
the room - the cap then refuses everybody - left all twenty-one green. It now
drives the real helpers as well (`LAW 8`), and `there-is-one-server-clock`
gained a scan that finds any known server stamp measured against `Date.now()`.
Twenty mutations, twenty reds. Full reasoning:
`docs/changelog/2026-09-06-realtime-phase-5-deep-audit.md`.

## Phase 4 - Restart handoff and protocol (2026-09-05)

**Why.** The engine is deliberately away for two to three minutes of every
hour, and nothing on the TRANSPORT knew it. The `maintenance_break` frame went
past `EngineStateClient` to `TablePage`, which drew a countdown while the
ladder underneath treated the silence as a dead box: 1s, 2s, 4s ... maxRetries
at about three minutes, status `failed`, and TablePage's twenty-second failsafe
reloading the page under a seated player who had just been promised their seat
would survive. It also sent every connected browser at GoTrue to ask about a
silence the server had explained two minutes earlier.

**What.**

1. **The restart handoff.** The engine adds `restart_in_ms` and
   `resume_expected_at` to the frame it already sends, derived from the break
   constants `the-break-clocks-agree` pins rather than guessed. Inside that
   window the client never reaches `failed`, polls at a flat 5s instead of
   doubling to a 30s cap, and does not ask GoTrue. The window carries a
   90-second grace and then EXPIRES, or one announcement would disable the
   failsafe forever. A missing table (4404) still wins over it. TablePage keeps
   an independent guard for the reader the frame cannot reach: a browser that
   LOADED during the outage, which only the database-backed break can tell.
2. **The protocol version.** Every socket URL carries `?v=` from one builder
   across all three sockets; below `MIN_CLIENT_PROTOCOL` the engine completes
   the handshake and closes **4426**, never a pre-handshake status (which is
   1006 to a browser, and 1006 means retry - the one thing a stale bundle must
   not do). A no-op at 0 today, installed so that the day a frame changes shape
   there is somewhere to put the number. The client answers it with the shared
   `hardReload`, because a plain reload re-serves the same stale document.

**Laws.** `tests/a-scheduled-restart-is-not-a-failure.law.test.ts` and
`server/src/transport/theEngineSaysWhichProtocolItSpeaks.law.test.ts`, both
mutation-tested against six deliberate breakages. Full reasoning:
`docs/changelog/2026-09-05-realtime-phase-4-restart-handoff-and-protocol.md`.

**Verification (2026-09-05/06, read from production).** The client half
published at 23:20 and was checked by downloading the bytes: all three sockets
go through the one builder (`Br(this.baseUrl,"/ws/multi")`,
`Br(this.opts.baseUrl,"/ws/table/"+…)`, `Br(this.opts.baseUrl,"/ws/channel")`),
`PROTOCOL_VERSION` minifies to 1, and there is **exactly one**
`replace(/^http/,"ws")` left in the entire entry chunk - the builder itself, so
no hand-built socket URL survives. The engine cut over inside the 23:55 break:
`becameLeaderAt 23:55:18`, the running container is
`club-arena-engine:dec2a23f0…` (the image tag IS the commit sha), healthy, and
`MIN_CLIENT_PROTOCOL` is compiled into both `EngineWebSocketServer.js` and
`ChannelWebSocketServer.js` inside that image.

**Phase 4 audit (2026-09-06)** found four defects, one of which meant the phase
did nothing for the players most likely to need it - a frame reaches only the
sockets that were already subscribed, so anyone who sat down after :53 was
never told. See `docs/changelog/2026-09-06-realtime-phase-4-deep-audit.md`.

## Phase 3 - Do no harm (2026-09-05)

**Why.** Phases 1 and 2 made a broken table visible. Neither changed what the
client DOES when a table breaks, and in two places what it does is make things
worse. Both are the same mistake: a recovery mechanism that fires without
checking whether it can possibly help.

**What.**

1. **The auto-reload failsafe no longer reloads an auth refusal.** Twenty
   seconds of a dead socket used to reload the page; against a 4401 the fresh
   page presents the same token to the same refusal and comes back in another
   twenty seconds, having discarded the felt, the overlays and any armed
   pre-action. The status alone cannot tell you it is auth - `auth_failed` is
   passed THROUGH on the way to `reconnecting` and then `failed` - so the cause
   is remembered separately and stays sticky until a socket actually opens.
   Not silent either way: the banner says `The Table Cannot Verify Your Sign
In. Still Trying` instead of blaming the connection, and the server gets a
   new `reload_suppressed` beacon reason with its own alert,
   `PlayersCannotAuthenticateToTables`.
2. **An action applies once.** One idempotency key per intent, generated in
   `submitAction` and carried by every retry inside it (the 429 ladder and
   `engineFetch`'s 401 retry). In the body, not a header - the engine is a
   different origin and its CORS allows only `Content-Type, Authorization`. A
   repeat never reaches the engine; a refusal (401 / 404 / 429) is never
   cached, so a retry after a restart still runs for real. Published as
   `poker_action_idempotency_total{outcome}`.

**Laws.** `tests/a-reload-cannot-fix-a-sign-in.law.test.ts` and
`server/src/http/theSameActionAppliesOnce.law.test.ts`. Full reasoning:
`docs/changelog/2026-09-05-realtime-phase-3-do-no-harm.md`.

**Verification (2026-09-05, read from production).** The client half published
at 21:15 and was checked by DOWNLOADING THE BYTES PLAYERS GET, not by matching
a sha: the entry chunk carries `idempotencyKey`, and the TablePage chunk
carries `reload_suppressed`, `4401` and the banner sentence verbatim. The
engine cut over inside the 21:55 break, and at 22:26 engine-01's `/metrics`
showed `poker_ws_client_reconnects_total{reason="reload_suppressed"} 0` (the
reason accepted, not folded into `other`) and
`poker_action_idempotency_total{outcome="stored"} 11` with `replay` and
`conflict` both at zero - **eleven real human actions stamped with a key and
de-duplicated end to end, no duplicates and no key collisions.** The alert
`PlayersCannotAuthenticateToTables` is loaded and `health=ok`.

One run before that shipped nothing and said so three different ways; the
reason ladder is fixed in #3194 and pinned.

**Phase 3 audit (2026-09-05)** found four more defects; see the changelog. The
one that mattered most was not in Phase 3 code at all: `/addchips` has carried
an `opId` since the Cashier audit of 2026-08-27, the engine falls back to a
fresh `randomUUID()` when a caller omits it, and the AUTOMATIC top-up omitted
it - so the one top-up path that retries without a human deciding to was the
one with no de-duplication.

## Phase 1 - Measure (2026-09-04)

**Why first.** Every later phase changes how a table behaves under stress,
and until this phase nothing could say whether a change made the table
faster or slower. `actToBroadcastLatency` had been recorded per table for
months and scraped never: the registry it lives in is `ENGINE_METRICS`-gated
and the gate is off in production (checked on engine-01: zero lines on
`/metrics`). The gate is right - ~270 tables x 12 buckets per scrape - so the
fix is a low-cardinality twin, not opening the gate.

**What.** `server/src/observability/engineInstruments.ts` gains
`alwaysOnRegistry` with two instruments, both labelled only by
`audience=human|horse` (human when at least one human is seated at the
table): `poker_act_to_broadcast_ms` (histogram, default 1 ms to 5 s
buckets) and `poker_actions_fleet_total`. `ServerTableEngine` observes the
twin beside the gated one; `GameServer.getPrometheusMetrics()` renders the
registry on every scrape. Two alert rules read the **human** series only - a
fleet p95 would be a horse number, and horses do not complain about lag -
guarded by the maintenance break: p95 > 500 ms for 10 m warns, > 1.5 s for
5 m is critical.

**Law.** `server/src/observability/theTableFeelIsMeasured.law.test.ts`: the
registry renders both instruments with only the audience label, GameServer
renders it on the always-on path, the engine observes the twin, and both
rules read the human series and carry the break guard.

**Found on deploy.** The first engine (77a2443f, 21:55 UTC) rendered both
instruments with zero samples while 267 tables dealt: horse actions call
`handController.performAction` directly and bypass the method that starts
the act-to-broadcast clock, so only human HTTP actions had ever been timed -
and no human was seated. Fixed in the same phase: the horse path starts the
same clock and counts on the same instrument (CLAUDE.md 10.5), which also
makes the engine's own baseline latency visible whenever no human sits.

**Verification.** Recorded below when the second engine deploy lands.
