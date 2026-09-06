# Realtime Phase 7 of 7 - guardrails

2026-09-06. Branch `realtime/phase-7-guardrails`.

The last phase, and the one that closes the finding phase 1 wrote down and could
not fix: **the alert rules running on engine-01 were not the alert rules in this
repo, in both directions.**

## What was actually true, measured before anything was changed

| | |
| --- | --- |
| alerts running on the box | **72** |
| alerts declared in `infra/monitoring/` | **79** |
| declared here and NEVER LOADED | **15** |
| running that this repo had never seen | **8** |

The 15 include **`EngineRefusingSessions`** and **`EngineCannotReachAuth`** -
the two alerts this programme wrote in phase 1 so that the outage it exists to
prevent would page somebody. They had never once been evaluated.

The 8 are cron-health and postgres-health rules, hand-authored on the box on
2026-09-04, with careful reasoning comments and a changelog reference
(`2026-09-04-the-headings-that-alerted-on-nothing.md`) **that was never
committed to this repo**. They are good rules. `deploy.sh` symlinks this repo
over the live files, so the first person to run it would have deleted all eight
without noticing.

## Why it drifted, which is the part worth fixing

Nobody was careless. **Three lists of files had to agree and nothing checked
that they did:**

1. `prometheus.yml` `rule_files:` - what Prometheus LOADS (7 files)
2. `docker-compose.yml` mounts - what the container can SEE (7 files)
3. `deploy.sh`'s symlink loop - what a deploy actually UPDATES (**4 files**)

So `engine-freeze-rules.yml`, `supervisor-rules.yml`, `tournament-rules.yml` and
`spin-rules.yml` existed on the box only because a human hand had put them
there. A rule added to any of them here could never reach production, and a
deploy would leave the hand-written copy in place for ever.

And this repo carried **three empty alert groups** - `cron-health`,
`postgres-health`, `vercel-health` - headings with no rules under them, while
the box held the rules for two of them. An empty group is worse than an absent
one: it reads as coverage.

## What was built

### The reconciliation - a union, nothing deleted

- The 8 box-only alerts are in this repo now, verbatim, with the original
  author's reasoning comments intact.
- `vercel-health` is deleted rather than left empty, carrying the box author's
  explanation: every rule it would want reads
  `probe_success{job="vercel_health"}` from blackbox-exporter, which this stack
  does not deploy, and that coverage genuinely lives in the World Hub's
  `publish-watchdog.yml` - deliberately outside this failure domain.
- Checked before assuming a conflict: of the 38 alerts present in BOTH, **zero**
  differ in `expr` or `for` in `alert-rules.yml` and `slo-alerts.yml`. The 671
  differing lines were comments. Three DO differ, all the same way, and the repo
  is right: `EngineHandsStopped`, `EngineLivenessDead` and `EngineScrapeDown`
  carry the maintenance-break guard here and did not on the box - so those three
  have been paging about the `:55` break every hour, which is CLAUDE.md 13 rule
  6 written down and violated in production.

### `deploy.sh` now symlinks every rule file Prometheus loads

Four became ten. This is the mechanism half: without it, the reconciliation
would drift again by the end of the week.

### A threshold re-derived instead of guessed

`EngineRefusingSessions` was written as `>= 6 refusals in 15m`. Before loading
it, its threshold was measured against the live series it reads:

    avg 15m increase over 24h ...  1.1
    p95 ..........................  9.2
    max .......................... 32.3

`>= 6` sits **below the ordinary p95**. It would have fired several times a day,
for ever, on nothing but seven-day tokens expiring in tabs nobody had closed -
and an alarm that is always on is an alarm that gets muted. Raising the number
alone would rot, because the count scales with traffic (1.1 at 04:00, 23.4 at
11:38 the same morning).

So it fires on the shape that actually hurt: refusals **while at least one
client is stuck in a reconnect loop**. On 2026-09-03 both were true
continuously; in ordinary churn `poker_ws_clients_reconnecting_badly` measured
0 for 24 hours straight, because a client refused once simply goes away. A
volume-only backstop (`>= 60`, nearly double the observed daily max) covers the
case where the beacon itself is the broken thing.

### The canary

`MonitoringCanary` fires unconditionally (`vector(1)`), severity `canary`,
routed to nobody. Its **absence** is the signal. Every other rule in the stack
is quiet when things are well, which makes "no alerts" and "no monitoring" the
same observation - and they were the same observation for twenty-two hours, and
again for the fifteen rules that had never loaded.

### `scripts/ci/check-alert-rules-match.mjs`

Asks Prometheus what it is running and Alertmanager whether it holds the canary,
and compares both against what this repo declares. **It exits 2 when it cannot
reach the stack** - a monitoring check that goes green when it cannot see
anything is the bug it exists to catch.

Its first run, before the deploy, reported exactly the table above.

## Laws and rules

- `tests/what-a-monitor-reads-is-what-the-repo-says.law.test.ts` - the three
  file lists agree; no alert group is empty; the canary exists, is
  unconditional, wakes nobody, and is looked for by name. **Six mutations, six
  reds** - one of which was found by mutating the law itself: the first version
  of the "something checks for it" pin read the whole checker file and passed
  when the checker was pointed at a different alertname, because the header
  still mentioned the canary. A pin satisfied by prose is not a pin.
- **CLAUDE.md 10.84**, two rules from the two halves of the outage: *an agent
  never SETS a credential* (the twenty-two hours began with one environment
  variable, and an agent may read where a credential lives and say what shape it
  should have, never write one), and *never hand-write what a monitor reads*.

## The deep audit (same day) - and the one that would have deleted the pager

Phase 7 was pushed and then audited before the programme was called finished.
Three defects, and the first is the worst thing found in the whole programme.

### 1. A deploy would have DELETED THE 3AM PAGER

`deploy.sh` symlinks `alertmanager.yml` over the live one exactly as it does
the rule files. The live file carried a **`pager-sms` receiver and a
`page="sms"` route that this repo did not have** - the pager added on the box
on 2026-09-04, which posts to the World Hub and texts a phone. Its comment even
cites `tests/the-pager-list-is-exactly-six.test.ts` **in this repo**, and that
test does not exist here either: the work was done on the box and neither the
config nor its test was ever committed.

So the next `deploy.sh` would have removed paging outright, silently. And the
rule-orphan guard added earlier in this phase would have said nothing, because
it only reads alerts.

Worse: **the automation added in this phase would have done it unattended.**
Fixed by bringing the box's `alertmanager.yml` in verbatim (it is a strict
superset - the diff has no lines the repo had and the box lacked), and by
adding a second guard to the deploy workflow that reads the live routing and
refuses if any receiver or route matcher would be lost. Verified against
production both ways: it passes today, and with the pager receiver or the
`page="sms"` matcher removed from the repo it exits 1 and names what would go.

### 2. The canary would have emailed ops every hour, for ever

`alertmanager.yml`'s top-level fallthrough receiver is `email-critical`, and
there was no route matching `severity="canary"`. `MonitoringCanary` fires
unconditionally by design - so it would have reached the default receiver and
mailed ops on every `repeat_interval`, for ever. **Alert fatigue manufactured
by the thing built to prevent alert fatigue**, and it was live in the repo for
about an hour. It now has an explicit route to `null-receiver`, and the law
pins it.

### 3. I ended the last report by asking Dan to run a command

That was wrong twice: World Hub RULE 0 says shipping is never something an
agent hands to a human, and more importantly **a deploy that depends on
somebody remembering is the same class of thing as a rule nobody loaded**,
which is this phase's entire finding. `deploy.sh` had existed the whole time,
documented as "run as root on the box", and the repo's rules reached production
exactly as often as a person thought to go and run it.

`.github/workflows/deploy-monitoring.yml` now deploys on any merge to `main`
touching `infra/monitoring/**`, guards both hazards above first, and then
verifies by reading - twenty seconds for Prometheus to reload, then
`check-alert-rules-match.mjs`, which also fails if Alertmanager is not holding
the canary. A green deploy step is not a loaded rule.

### Also checked, and correct

- `promtool check rules` on **all seven** rule files: SUCCESS, 96 rules.
  `amtool check-config`: route, 2 inhibit rules, 4 receivers.
- Against `origin/main`, `alert-rules.yml` gained the 8 rescued alerts, the
  canary and the volume backstop, **removed nothing**, and **no shared alert's
  `expr` changed**.
- `deploy.sh`'s symlink list gained three rule files and dropped nothing.
- The merged-branch guard did its job: the follow-up push to the merged
  `realtime/phase-7-guardrails` was REFUSED, not stranded (CLAUDE.md 10.82),
  so this work is on a new branch off `main`.

Four more mutations on the extended law, four reds: the pager receiver renamed,
the `page="sms"` matcher removed, the canary pointed at `email-critical`, and
the routing guard deleted from the workflow.

## Still open, recorded rather than quietly fixed

- **32 of 89 alerts carry no `runbook:` annotation.** Requiring one would be a
  red law today; making it one is worth doing, after the runbooks exist.
- **Six of twelve `engine-freeze` alerts have no maintenance-break guard**
  (`PokerTablesFrozen`, `EngineDiscoveryStalled`, `EngineTableRebuildChurn`,
  `StatsLiveTriggerMissingHands`, `StatsWitnessAuditDisagrees`,
  `StatsAllInEquityCoverageLow`). Whether each one NEEDS it is a per-alert
  judgement about what a five-minute pause does to its expression, and guessing
  would be worse than the gap.
- `slo-rules.yml` and `slo-alerts.yml` are loaded but their alerts read
  recording rules from a blackbox exporter this stack does not deploy.
