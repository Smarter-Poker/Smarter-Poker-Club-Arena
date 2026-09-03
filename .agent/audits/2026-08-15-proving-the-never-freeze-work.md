# 2026-08-15 — Proving the never-freeze work (and what proving it found)

Dan chose "prove it" as the next phase after the never-freeze hardening. That
was the right call: **proving it found three more real defects, two of them in
the recovery machinery shipped earlier the same day.**

## 1. The watchdog now has behavioural tests — and they were verified to FAIL first

`server/src/engine/TableWatchdog.test.ts`, 12 tests covering every tier.

The tests are only worth anything if they catch the bugs, so each was checked
against the pre-fix code by reverting the fixes and re-running. Exactly three
failed, matching the three defects:

```
× TIER 1 resets the stall window so TIER 2 cannot stomp it 10s later
× TIER 3 IS REACHABLE: a seat that cannot be acted escalates to a rebuild
× a rejected force must NOT be recorded as progress
```

Restored, all 12 pass; full suite 497/497.

## 2. Monitoring was decorative — 27 dead alerts and a black-hole receiver

An audit of every alert rule against the metrics Prometheus actually has:

**27 alert rules referenced metrics that do not exist.** Including:

- `EngineDown` queried `up{job="engine_pm2"}`. No scrape config anywhere
  defines that job — the real one is `engine_game_server`. **The platform's
  primary "the engine is dead" alert had never been capable of firing.**
- `EngineHandsPerSecDropped` queried `poker_engine_hands_played_total`; the
  engine emits `poker_hands_dealt_total`. Its time window
  (`hour() >= 13 and hour() < 6`) was also unsatisfiable.
- All 16 SLO burn-rate alerts depend on recording rules that are themselves
  built on `engine_pm2`, so they compute against nothing.
- Postgres and blackbox alerts need exporters that are not deployed at all.

**And Alertmanager routed everything to a `null-receiver`.** Even the alerts
that could fire went nowhere. `HostCPUSaturated` had been firing silently.

So on the morning of the freeze there was no possible path by which anyone
could have been notified. That is the actual reason it was found by a player.

**Fixed:**

- `engine-freeze-rules.yml` — 6 new rules, every one verified against a metric
  the engine really emits. `PokerTablesFrozen` is the one that matters: it
  fires at 1 minute on any table with 2+ dealable seats and no progress.
- New engine metrics: `poker_stalled_tables`, `poker_engine_liveness`,
  `poker_discovery_stale_ms`, `poker_table_ms_since_progress`,
  `poker_table_dealable_seats`.
- Corrected the fixable legacy rules; quarantined the 8 that need undeployed
  exporters into `alert-rules.QUARANTINED.yml` with instructions. Silently
  evaluating-to-nothing is worse than absent: it implies coverage.

**Delivery, verified end to end.** Slack was tried first — `SLACK_ALERT_URL` in
the monitoring `.env` is 44 characters, truncated and invalid; Slack answers
posts to it with its documentation homepage. Switched to Resend SMTP (already
this platform's email provider). Resend's API confirms both a synthetic
critical and the real backlogged CPU warning as **`delivered`** to
admin@smarter.poker.

## 3. THE BIG ONE: Docker never restarts unhealthy containers

The Docker `HEALTHCHECK` shipped this morning was bound to real liveness — and
**would never have restarted anything.** Docker's healthcheck only sets
`.State.Health.Status`. Only Swarm and Kubernetes act on it; plain Docker does
not. The engine would have sat marked `unhealthy` forever with every table
frozen. The "self-healing restart" claim was wrong.

Found by drilling it, not by reading it.

**Fixed:** `sp-autoheal` (willfarrell/autoheal) watches for containers labelled
`autoheal=true` going unhealthy and restarts them. The deploy workflow now
applies the label, and the label is documented as load-bearing.

**Verified on a disposable probe** (not production, after the drill below):
probe went unhealthy at 19:34:20 → autoheal logged
`found to be unhealthy - Restarting container now` → start time moved
19:33:22 → 19:35:05. Loop closed.

## 4. `docker kill` / `docker stop` do NOT trigger `--restart always`

Discovered by running the drill wrong. Docker treats both as _manual_ stops and
leaves the container down until the daemon restarts or someone starts it by
hand. My first drill used `docker kill` and the engine stayed down ~1-2 minutes
until I started it (0 human players were seated; horses only).

This matters beyond the drill: **an operator `docker stop`, or a deploy that
halts between stop and run, leaves the engine dead with no automatic
recovery.** Documented in the deploy workflow header.

A genuine crash is unaffected — verified separately: a container exiting 1 on
its own restarted 3 times in 50s under `--restart always`. So the
`uncaughtException → process.exit(1)` design added this morning does work.

## Verification summary

| Claim                                 | How it was proven                                        |
| ------------------------------------- | -------------------------------------------------------- |
| Watchdog Tier 1/2/3 behave correctly  | 12 tests; 3 verified failing against pre-fix code        |
| A rejected force escalates to rebuild | `TIER 3 IS REACHABLE` test                               |
| Watchdog leaves healthy hands alone   | 3 tests incl. parked-runout case                         |
| Alerts reach a human                  | Resend API status `delivered`, twice                     |
| Freeze rules evaluate on real data    | All 6 rules `health: ok`; `poker_stalled_tables` scraped |
| Unhealthy container gets restarted    | autoheal probe, start time moved                         |
| Crashed process gets restarted        | crash probe, RestartCount 0→3                            |
| Production survived the drill         | 53 hands / 22 tables at 19:36, baseline restored         |

## Still open

- **The engine's own recovery paths (watchdog Tier 2/3, zombie reaper,
  tournament revival) have still never fired in production.** They are unit-
  proven but not field-proven. Triggering them safely needs a staging table or
  a deliberate fault-injection hook; do not force them on a live table.
- Client reconnection after `dropTable()` is code-fixed and unit-tested but not
  yet verified with a real browser on a live table.
- Host is 2 vCPU at load ~2.3 — sustained saturation. `HostCPUSaturated` had
  been firing silently for an unknown period and is now emailing. Worth sizing
  up: a saturated box makes scheduler-tick lateness (and therefore freezes)
  more likely.
- `/api/alerts/engine` (World Hub) + the `engine_alerts` table give a durable
  "did we know?" audit trail, but need `ALERT_WEBHOOK_SECRET` set in Vercel to
  activate. Email works without it.

---

## ADDENDUM — the watchdog was proven on a live production table (21:26 UTC)

The first drill was inconclusive and it was worth understanding why: injecting a
"turn stall" that only removed the enforcement clock did NOT freeze the table.
The horse's pending think-time `setTimeout` still fired, the horse acted, and
play continued. **Removing the clock is not a freeze.** A freeze is "nobody is
going to act AND no clock will force it" — both halves are required.

Fixed by tracking the horse think-timer (`horseActionTimer`, which is worth
having anyway — an untracked timer cannot be cleared on teardown) and having the
injection cancel it too. Re-drilled on table `57799263`, horses only, buy-in
untouched:

```
T-0   inject: seat 2, hadClock=true, hadHorseTimer=true, hand #62
t+9s   idle 13.7s   hand 62   <- frozen
t+18s  idle 22.7s   hand 62   <- frozen
t+27s  idle 31.7s   hand 62   <- frozen
t+36s  idle  0.5s   hand 63   <- RECOVERED
t+45s  idle  2.2s   hand 63   <- dealing normally
```

Engine log, the decisive line:

```
[ServerTableEngine.57799263....watchdog_turn_stalled]
  Error: Hand #62 stalled 55s at seat 2 (clock=false, stage=turn, trip=1)
```

`clock=false` confirms the clock was genuinely absent — this was a real stall,
not a simulated log line. The watchdog tripped ONCE, Tier 1 armed a replacement
clock (`TIMER_STARTED`), that clock expired into an auto-fold (`TIMER_EXPIRED`),
the hand completed through settlement, and the table dealt hands #63 and #64.

No escalation to Tier 2 or Tier 3 was needed, which is the correct outcome:
Tier 1 is the cheapest recovery and it was sufficient.

**Status: the table watchdog is now field-proven, not just unit-proven.** It
detected and recovered a genuinely frozen production table without human
intervention and without disturbing any other table.
