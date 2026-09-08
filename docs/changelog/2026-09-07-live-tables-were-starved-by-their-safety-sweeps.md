# Live tables were starved by their safety sweeps

**2026-09-07.** Incident repair for cash tables, MTTs, Spins and heads-up
sit-and-gos repeatedly showing **Connecting/Reconnecting To The Table**, pausing
between actions and hands, and losing transient deal/button presentation.

## What production proved

This was not a Supabase session-revocation incident and it was not a browser
specific failure. The authoritative engine and the independent synthetic
player agreed:

- WebSocket auth-refusal counters stayed at zero.
- The synthetic table client needed 3-8 seconds merely to open on its nominal
  successes, then recorded repeated 15-second `handshake_timeout` failures.
- The engine's event-loop governor reached its deepest load-shedding tier while
  p50 scheduling delay remained in the hundreds to thousands of milliseconds.
- A fresh process reproduced the condition within minutes. At 18:03 UTC it had
  113 tournament elimination sweeps physically in flight, 291 dealable tables,
  and p50 event-loop delay of 1.8 seconds.
- The old design opened one full database-heavy elimination pass per RUNNING
  tournament every five seconds. As those passes slowed, they overlapped; as
  they overlapped, the engine lost more timer/I/O turns; and tournaments could
  not finish, so the set producing passes stayed large. Restarting temporarily
  cleared the queue and then rebuilt the same failure.

The 227-second hand measurement from the cash-cluster investigation was real,
but it was an effect of this shared single-thread starvation, not evidence that
the cluster planner itself was the root cause.

## The repair

### One bounded tournament scheduler

The per-manager five-second interval is gone. One process-wide scheduler now:

- admits no more than four physical elimination promises at once;
- keeps a slot occupied until its promise actually settles, even after the
  stuck-work warning fires;
- coalesces repeated wakes for the same tournament;
- prioritizes a committed zero-stack/bust without starving routine causal work;
- admits work only from manager admission, a durable state-transition receipt,
  a committed hand result, or an exact known deadline-never an all-tournament
  wall-clock repair scan; and
- owns one delayed-wake timer for add-on retries, final-table deal polling and
  post-expansion seating instead of recreating an interval per manager.

The live cap is about physical work, not a bookkeeping timeout: a promise that
has not settled cannot free a slot and hide continued concurrency.

### Bounty debt is born with the knockout

The bounty worker now consumes only rows already committed to
`tournament_bounty_obligations` by the atomic knockout transaction. The former
legacy-player/history backfill page and wrapper are dropped, payout RPCs never
invoke them, and the sweep response has no backfill continuation protocol.
Missing obligations are write-path invariant failures; mutable tournament,
seat, settlement and hand-history rows are never used later to invent money
work.

This removes the rolling bridge for engines that predate the atomic knockout
writer. Deployment must therefore prevent those old writers from accepting new
bounty hands during cutover; the database migration and atomic writer must be
activated as one maintenance-gated release.

### A bust wakes only after its chips exist in the database

`HAND_COMPLETE` is emitted before asynchronous settlement. The former callback
could therefore wake elimination while `table_seats` still held the pre-hand
positive stack; under load, a fixed delay was only a guess and the bust could
wait for the safety pass.

The callback now runs after the awaited, authoritative stack settlement and
only when that settlement explicitly reports success. A conservation refusal,
database refusal or exhausted retry does not manufacture visibility; the
failed causal attempt retains a bounded retry and the durable receipt remains
unacknowledged until a clean pass proves completion.

### Late-registration capacity has one database authority

Registration and the owning manager call the same row-locked, idempotent
capacity RPC. It computes real occupied chairs, creates at most the required
table, and emits a durable manager wake in the registration transaction. A
paid entrant that could not claim a chair therefore remains explicit causal
work; cash-table discovery does not scan or mutate tournament registration.

### The horse evaluator spends less of the one engine thread

The CPU profile put five-card scoring at 34-54% of the engine thread, amplified
by Omaha's repeated 2-hole/3-board combinations. Exact five-card rank-product
lookups now replace repeated scratch-array clearing and thirteen-rank scans.
The generic 6-8 card evaluator is unchanged. An exhaustive law compares all
2,598,960 standard-deck and 376,992 Short Deck five-card deals with the reference
evaluator; the measured Omaha decision path is about three times faster.

### Reconnects no longer create more reconnects or erase presentation

- A start failure rejects the owning admission attempt instead of resolving
  successfully with a dead generation still in the table map. Detached
  dealing/watchdog deaths emit one generation-scoped owner signal, so recovery
  begins from the failure itself rather than waiting for a later liveness scan.
- Heartbeat expiry credits only scheduler time the server itself lost before
  deciding that a PONG was late. A genuinely silent client is still closed.
- The client reports a reconnect or event-sequence continuity boundary,
  requests authoritative state, and recovers a missed new-hand presentation
  only inside a short, proven transition window.
- Normal first-load hydration into a hand remains still. Recovered hands use
  the same button-then-deal timing law as an ordinary `HAND_STARTED`; there is
  no shorter or duplicate animation path.

### Recovery and monitoring tell the same truth

- `/health` and `poker_engine_liveness` now call one pure verdict, including
  startup, standby, discovery and whole-fleet semantics.
- Docker and the host supervisor tolerate a busy event loop and enforce a full
  five-minute cold-start grace, preventing an early successful probe from
  ending restart protection.
- Scheduler slots, queue age, late-registration recovery and sustained
  event-loop saturation are low-cardinality alert inputs.
- Caddy removes the WebSocket subprotocol header from request error logs via an
  idempotent, validate-before-reload installer that preserves live credentials
  and rolls back the exact prior file if validation or reload fails.

## Release boundary

This incident is not closed by local tests, a merged pull request, a successful
image build, or one fast probe after restart. Closure requires all of the
following from the same current `main` ancestry:

1. the full static bundle and engine report the exact served build;
2. monitoring rules and the active Caddy configuration match the repository;
3. the production WebKit/E2E suite completes outside maintenance and removes
   its isolated test account;
4. external WebSocket probes repeatedly open and receive a snapshot;
5. physical scheduler slots remain at or below four and queue age drains;
6. event-loop delay leaves the saturation tiers, hand cadence recovers, and no
   unannounced engine restart occurs through the previous 30-minute relapse
   horizon.
