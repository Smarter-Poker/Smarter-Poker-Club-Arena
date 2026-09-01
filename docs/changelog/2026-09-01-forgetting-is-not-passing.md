# Forgetting is not passing (2026-09-01)

Two instruments that reported success by not looking. Both were raised as
"Dan's call" earlier today; both turned out to have a fix that is mine.

## 1. A conservation breach expired after four hours

`check-chip-conservation.mjs` gates every engine deploy on:

    SELECT sum(unexplained) FROM ca_supply_snapshots
     WHERE taken_at > now() - interval '4 hours'

A trailing window forgets. Four hours after a breach the gate goes green on
its own, whether or not anybody looked.

**The evidence was already in the table.** On 2026-08-31 seven consecutive
snapshots breached and total supply rose from 176,183,282 to 179,473,345 --
**plus 3,290,063 chips** -- with `mint_since_prev` recorded as zero on every
one of them:

|       |          |       |            |
| ----- | -------- | ----- | ---------- |
| 15:05 | +20,606  | 18:05 | +1,345,385 |
| 15:43 | +79,099  | 19:05 | +577,347   |
| 16:05 | +145,163 | 20:05 | +355,228   |
| 17:05 | +767,234 |       |            |

Almost entirely `member_wallets`, with treasuries and agent wallets flat.
Chips entered player balances and no issuance was recorded against them. All
seven aged out that same evening and the gate has been green over them since.

### What was built, and what was deliberately not

`ca_supply_breach_ack` plus `fn_ca_unacknowledged_supply_breaches()` and a
`supply_breach_unacknowledged` finding wired into the daily audit. A breach is
now critical, permanent, and cleared only by an `INSERT` naming a person and a
reason -- with a `CHECK` that the reason is at least a sentence, because "ok"
is not an explanation and this row is the audit trail for chips nobody could
account for.

**The deploy gate is unchanged.** Making it consider all history would block
every deploy on the platform right now over rows from 2026-08-31, and that is
a production-availability decision for Dan, not an agent.

**Nothing is seeded as acknowledged.** The seven stand. A fix whose first act
is to silence its own evidence is not a fix. Whether they are the gap already
baselined by `baseline_the_unledgered_gap` (2026-08-27) is a question for
whoever owns zero-drift, and the finding says exactly that rather than
assuming it.

The acknowledgement path was probed inside a transaction that was rolled back,
per CLAUDE.md 11.5: a two-character reason is refused, a real one removes
exactly one breach, and nothing was committed.

## 2. Nothing noticed that the schedules had stopped firing

`auto-deploy-hetzner.yml` moved to an hourly cron at 13:00 UTC. Between then
and 18:52, sixteen scheduled ticks were due and **one** ran. `cron-health.yml`
does not cover this: it asks the _database_ which scheduled work failed, so it
watches the horse jobs and not GitHub Actions cron.

`schedule-liveness.mjs` reads every workflow that declares a `schedule:`,
works out the widest hole its cron should ever leave, and asks the API when it
last ran on that trigger. **On its first live run it found four, not one:**

| Workflow                  | Expected every | Last scheduled run |
| ------------------------- | -------------- | ------------------ |
| `build-for-world-hub.yml` | 30 min         | 156 min ago        |
| `auto-deploy-hetzner.yml` | 50 min         | 259 min ago        |
| `agent-autopilot.yml`     | 30 min         | 108 min ago        |
| `publish-watchdog.yml`    | 60 min         | 184 min ago        |

`build-for-world-hub` is what publishes the Club Arena bundle, so this was
never confined to the engine.

### Design notes

- **It is a job in `publish-watchdog.yml`, on `workflow_run` -- not its own
  cron.** A cron that alarms about cron cannot alarm when cron is what broke.
  That trigger fired eight or more times today against the schedule's one.
- **The watchlist is derived from the workflow files**, the same principle as
  the layer watchlist fixed earlier today. A hand-kept list goes stale and
  then lies.
- **It refuses to guess.** Any cron shape it cannot read cleanly returns null
  and is skipped, because a wrong expectation is a false alarm and a false
  alarm is how a real one gets ignored.
- **It never fails the job.** GitHub drops ticks often enough that a red X
  would be noise within a day. The engine watchdog beside it is what actually
  _repairs_ the case that matters, by dispatching the deploy itself.

## Verification

`tests/schedule-liveness.test.ts`, 7 tests. My own first two expectations of
the cron arithmetic were wrong and the code was right, which is precisely why
they are written down rather than eyeballed. `npx tsc --noEmit` clean; all 17
CI typecheck-job steps pass locally.
