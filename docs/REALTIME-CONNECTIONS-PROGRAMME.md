# Real-Time Connections Programme

Dan, 2026-09-04, after a 22-hour "Reconnecting To The Table" outage that
every monitor slept through: "TAKE EVERYTHING YOU JUST SUGGESTED, AND CREATE
A COMPREHENSIVE BUILD PLAN AND BREAK IT DOWN INTO PHASES. DO ONE PHASE AT A
TIME ... ENSURE THAT EVERYTHING WAS PUBLISHED BEFORE CLAIMING SUCCESS."

A phase is done when its code is merged, published (engine deployed and/or
Club Arena `build-info.json` showing the sha), and verified on production by
reading, not assuming. The list below is the order; each phase records its
verification when it lands.

| Phase | Name                       | Delivers                                                                                                                                                                                  | Status |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1     | Measure                    | `poker_act_to_broadcast_ms{audience}` and `poker_actions_fleet_total` on the always-on `/metrics`; `ActionLatencyDegraded` / `ActionLatencyCritical` alert rules                          | done   |
| 2     | See the client             | Beacon from four client failure sites -> `POST /client-event`; bounded per-user counting in the engine; `PlayersReconnectingRepeatedly` + `TablesAreReloadingThemselves` alerts; two laws | done   |
| 3     | Do no harm                 | Auto-reload failsafe skips auth closes; idempotency key on `/action` (client + handler)                                                                                                   | done   |
| 4     | Restart handoff + protocol | `restart_in_ms` frame at :53 and a ladder that waits it out; `v` on subscribe and `4426 upgrade_required`                                                                                 |        |
| 5     | Trust and limits           | Server clock offset for turn timers; periodic re-auth of live sockets (5 min, cached); per-user socket cap with `4429`; explicit Caddy WS timeouts in the clocks law                      |        |
| 6     | Prove it from outside      | Synthetic table probe on Open Claw (real socket to a horse-only table, wait for SNAPSHOT, close); runbook `docs/runbooks/tables-say-reconnecting.md`                                      |        |
| 7     | Guardrails                 | Vercel env-var change audit (names + updatedAt, never values); CLAUDE.md rules (agents never set credentials; never hand-write what a monitor reads); alert canary                        |        |

Not in the programme, because they are Dan's decisions, recorded so they are
not lost: Log Out scope (global today; local by default with an explicit
"Sign Out Everywhere" is the usual shape); Supabase JWT expiry (7 days
today; 1 hour surfaces a revoked session within the hour); a second engine
upstream (the standby was collapsed on 2026-08-23 and there is no failover).

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

**Verification.** Recorded below when the engine deploy lands.

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
