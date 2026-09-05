# 2026-09-05 - The deploy that could not ship, and the sidecar that was killing production

Branch: `fix/the-deploy-that-cannot-ship`. Raised by Dan after an agent
reported one symptom of it.

## The number that started this

`ca_engine_deploy_attempts`, the 72 hours to 19:15 UTC:

| outcome                              | count |
| ------------------------------------ | ----- |
| deployed and verified                | 46    |
| the maintenance break never opened   | 23    |
| coalesced or already serving         | 22    |
| run ended without a verified cutover | 7     |

98 attempts. **52 shipped nothing - 53%.** In the last 24 hours, 18 of 36.
Every one of those 52 is a green tick in `gh run list`.

At the moment this was written `main` was `43bd2d83` and production was
serving `51f67092`, three merges behind, with issue #3161 open.

## Four defects, and the one underneath them

### 1. Something was restarting production every ~40 minutes, and nothing said so

The engine restarts inside an announced five-minute break at :55 (§13). It was
also being restarted at 16:06, 16:42, 17:49, 18:26 and 19:04 UTC on the day
this was written - unannounced, mid-hand, by `sp-autoheal`:

```
05-09-2026 19:04:27 Container /club-arena-engine found to be unhealthy - Restarting container now
```

Autoheal was doing its job. The engine was telling it the truth as the engine
understood it, and the engine was wrong.

**`liveness` went to 'dead' whenever ONE table stalled.** The condition was
`deadStalledCount > 0`: any table with two dealable seats, not paused, that had
made no progress for five minutes. Measured from Prometheus over 763
consecutive minutes:

| reading                                           | value            |
| ------------------------------------------------- | ---------------- |
| minutes reporting `poker_engine_liveness == 0`    | **152 of 763**   |
| of those, minutes with at least one stalled table | 136 of 139 (98%) |
| minutes with a stalled table while reporting 'ok' | 0 of 624         |
| modal stalled count during a dead minute          | **1**            |
| median DEALABLE tables during a dead minute       | **207**          |

So for a fifth of the day the engine declared itself dead on the word of a
single table while 207 others dealt normally, and five times that day the
sidecar acted on it and voided every hand on every one of them (§10.5 - a
horse's hand counts).

The file's own history had already reached the correct rule three times, in
three different costumes: _a slow database is not a dead process_, _a
discovery stall alone must not kill a dealing engine_, _a barren leader is
safe to kill because it owns zero tables and a restart voids no hand_. The
2026-08-22 fix to this very clause moved the threshold from 120s to 300s and
kept the shape. The shape was the bug.

**The rule now:** dead only when the stall is the whole fleet - every dealable,
unpaused table has out-stalled the recovery chain. A minority stall has its own
cheaper remedy (watchdog Tier 1-3 -> killForRestart -> zombie reaper ->
discovery rebuild), which rebuilds the broken table without touching the
others. Killing the container is not an escalation of that; it is a worse
version of it applied to 311 innocent tables.

**Replayed against the same 763 minutes:**

| rule | minutes declared dead |
| ---- | --------------------- |
| old  | **152**               |
| new  | **4**                 |

The four survivors are real: the worst was 91 stalled tables out of 91
dealable. The new rule keeps every true death and drops 148 false ones.

The gauge was fixed too. `poker_engine_liveness` keyed on the 120s VISIBILITY
list while `getStatus()` killed on the 300s one - two thresholds under one
name, so the series anyone alerted on was not the series Docker acted on.
`/health` now also publishes `deadStalledCount`, `dealableTableCount` and
`wholeFleetStalled`, so the verdict can be argued with from outside the
process; before today the only way to ask why the engine had died was to shell
into the box.

### 2. The coalescing gate read the wrong clock

`auto-deploy-hetzner.yml` compared `/health.uptime` against a 20-minute
spacing threshold. Uptime says when the PROCESS started. The gate wanted to
know when the PIPELINE last restarted production. Every autoheal bounce reset
uptime, so every deploy in the following twenty minutes coalesced.

Recorded case, run `33981313111` (attempt 134, 17:33:36Z):

```
Engine restarted only 900s ago (< 1200s) and is healthy with 289 tables - coalescing.
SHIPPED: false
```

The engine had restarted at 17:18:36 - not a deploy, not a break.

The workflow's own 2026-08-24 note predicted this exactly ("it restarts for
reasons other than deploys - a healthcheck kill, a promoted standby, a crash")
and the bypass it added only covers an UNHEALTHY engine or one with zero
tables. A healthy engine bounced by its own sidecar is the case that slips
through, and it was the common one.

The clock now comes from `ca_engine_deploy_attempts` via
`scripts/ci/last-shipped-engine-deploy.mjs` - a ledger only this pipeline
writes, that nothing on the host can move. An unreadable ledger does NOT
coalesce: failing closed here means declining to ship, and the real protection
is the break gate downstream. Spacing is a courtesy; the break is the law.

And an engine younger than our own last deploy is now reported as an
`UNPLANNED RESTART` annotation. Until today that was visible only as a deploy
that mysteriously coalesced.

### 3. The break gate could not afford to wait

The gate's budget is the job timeout minus the elapsed build minus a
300s cutover reserve, and it refuses to wait when the next :55 is further away
than that. With `timeout-minutes: 40` and a build that had grown to 8-18
minutes, the budget was ~27 minutes - so **any run reaching the gate before :28
quit having shipped nothing.**

That window is exactly where an off-cycle dispatch lands, and an off-cycle
dispatch is what `publish-watchdog` fires when it notices the engine is behind
main. The one mechanism whose entire job is catching up a stale engine was
arithmetically incapable of ever landing a deploy.

Measured, back to back, both carrying `aa6b6387`, both green, both after
building everything:

| run         | at the gate | next break | budget | verdict      |
| ----------- | ----------- | ---------- | ------ | ------------ |
| 33985138036 | 19:01       | 3295s      | 1765s  | not sleeping |
| 33986167969 | 19:15       | 2429s      | 1654s  | not sleeping |

Two fixes:

- **An image is built once per commit.** `club-arena-engine:<sha>` is the same
  bytes every time - the tag IS the commit - so a run that finds it already on
  the host adopts it instead of spending 8-18 minutes reproducing a file that
  is already there. That is what turns an off-cycle dispatch from "incapable of
  landing" into "stages the image, and the :35 tick finishes the job in about a
  minute". Retries are now nearly free.
- **`timeout-minutes` 40 -> 55**, and the budget formula reads the same number
  rather than a hand-copied `40 * 60`. Run 33986167969 lands under the new
  arithmetic (budget 2554s > 2429s to the break) without any other change.

The refusal message changed too. It is a notice, not a warning, and it says the
image is staged rather than reporting a run that did the expensive half of the
work as a total loss.

### 4. The run named the wrong gate

One run gave three different answers. The step warning said _drain gate - hands
are still in flight_; the summary and the database said _the maintenance break
never opened_; the truth was that it had declined to wait for a break that had
not started yet.

The branch it fell through tested `steps.window.outputs.open`, and **there is no
`window` step** - the restart-window gate was deleted when Dan moved the restart
to the hourly :55 break. A missing step's output is the empty string and never
`'false'`, so the branch was unreachable while reading as a live gate, and it
advertised a "7am/7pm America/Chicago restart window" that §13 abolished. That
is precisely the stale-text failure §13 was written about.

The break gate now hands up its own `gate_reason` on every path that declines,
and the run warning, the job summary and the deploy ledger all print that same
string. 23 rows in `ca_engine_deploy_attempts` blamed a break that had never
been reached; they cannot be written again.

## Hardening

`tests/the-deploy-can-always-ship.law.test.ts` (registered in
`docs/laws.d/`) pins all of it, and deliberately does not assert that any
number has a particular value - it asserts the numbers still AGREE, because
agreement is the property that broke. Every one of these defects was a value
that was correct when written, in a pipeline whose other values moved
underneath it.

It checks: the job timeout and the budget formula are the same number; at least
one scheduled tick can build from cold and still reach the break; every
scheduled tick reaches the break once an image is staged; the refusal says the
image is staged rather than blaming the break; the spacing decision does not
read `/health.uptime`; the clock comes from the ledger; an unreadable ledger
does not coalesce; an unplanned restart is reported; `steps.window` and
"7am/7pm" appear nowhere as live code; the count of `skip=true` paths in the
break gate equals the count of `gate_reason` paths; the warning, summary and
ledger read one string; and a staged image is adopted before any `docker
build`.

**Run against `origin/main`, 9 of its 12 assertions fail** - one per defect
fixed here.

`server/src/engineLiveness.test.ts` gains the fleet-wide rule in the same
commit that changes it (§5 rule 8), including the two production readings as
cases: one stalled table out of 312 is not dead, 79 out of 312 is not dead,
91 out of 91 is, an idle fleet with nothing dealable is not, and
`dbConfirmedDead` - the detector that asks Postgres instead of asking this
process about its own work - still fires unchanged. The source-window
assertions now ban `deadStalledCount > 0` in the liveness expression and
`stalled.length === 0` in the gauge by name, so neither regression can return
under a new spelling.

## Not fixed here, and deliberately

**Why tables stall in the first place.** 79 of them did at once. That is the
TableWatchdog / stall programme, it is a different investigation, and nothing
above depends on its answer: a stalled table is a table-level fault with a
table-level remedy, and this change is about not answering it by killing the
container. The stall itself remains visible - more visible than before, since
`poker_dead_stalled_tables` and `poker_dealable_tables` are now published
separately from the liveness verdict.
