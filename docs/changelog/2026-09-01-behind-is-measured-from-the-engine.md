# 2026-09-01 - The staleness alarm could be reset by shipping more code

## What was wrong

`fn_ca_engine_deploy_truth_watch` shipped this morning to answer "is the engine
running main", because a green `auto-deploy-hetzner` run does not answer it. Its
fourth check, `engine_behind_target`, measured how long the engine had been
behind as **how old the newest offered sha is**.

Those are different questions, and the gap between them is a hole you can drive
a permanently stuck engine through. Every new commit starts a new clock, so a
pipeline offering a fresh sha every couple of hours can never accumulate the
eight hours the alarm needs.

**It happened the same afternoon, to this alarm, on its first day.** The engine
sat on `bda90d71` from 04:11 UTC. Between 14:58 and 16:00 the pipeline offered
four times, three different shas:

```
14:58  f5859e14   coalesced or already serving this commit
15:31  12899f11   run ended without a verified cutover
15:42  12899f11   run ended without a verified cutover
16:00  240ce7b5   run ended without a verified cutover
```

Three of those are outright deploy FAILURES, not the benign window skip. At
18:10 the engine had been fourteen hours stale and the alarm was silent - and
by its own rule it was right, because the newest sha was two hours old.

## What it does now

The clock starts at the first attempt that offered something **other than what
the engine is running**, counting only attempts since the pipeline last offered
the running build. That is exactly "how long has this engine been refusing the
thing it is being given", and no number of new commits can reset it.

Drilled inside a transaction rolled back by RAISE before it was trusted: three
different shas across twenty hours, none of them the running build, now report
`since` twenty hours ago and raise the critical. The old logic read the same
rows as twenty MINUTES and said nothing.

The migration is deliberately surgical - it rewrites one query inside the
function via `pg_get_functiondef` and raises rather than proceeding if the text
it expects has moved, because two other agents extended the same function that
afternoon (leader rows, engine-missing state) and none of that should be
clobbered by a full-body replace.

## The limitation, said plainly

This measures from RECORDED evidence. `ca_engine_deploy_attempts` only starts at
14:58 today, when the recording step merged, so today's fourteen-hour gap
predates the instrument and it cannot retroactively alarm on it. From here on it
can.

## What was actually blocking the engine, and it was not the alarm

The three failed deploys stopped at the same step:

```
FAIL  trailing 4h unexplained chip supply is -4162775.63
[check-chip-conservation] FAILED
```

The financial health-gate refusing to deploy onto a bleeding ledger, exactly as
designed. Reading the snapshots, the supply did not bleed: total went
189,865,035 at 10:05 to 189,863,083 at 18:05, down about 1,952 chips across
eight hours. The multi-million figures come from `mint_since_prev` being
attributed one snapshot LATE, so a single real movement books as a large
positive `unexplained` in one hour and a large negative in the next:

| snapshot | delta_vs_prev | mint_since_prev | unexplained |
| --- | --- | --- | --- |
| 12:05 | +4,159,902 | 4,159,644 | +258 |
| 13:05 | +5,741,903 | 4,159,644 (the 12:05 mint again) | +1,582,259 |
| 14:05 | -2,407 | 5,741,355 (last hour's delta) | -5,743,763 |

Consecutive spikes of different sizes do not cancel inside a four-hour trailing
SUM, so the gate read -4.16M. By 18:10 the bad snapshots had aged out of the
window and the trailing figure was -1,364.74, well inside the 5,000 threshold.

**Not fixed here, and deliberately.** The 14:00 movements are 16.5M and 9M
between `settlement_suspense` and `agent_wallet` plus 7.5M out of a club
treasury, all `adjustment`, and today's one open reconciler critical is that
same club (Deep Stack Society, ledger -7,501,086.84 against a stored
2,478,126.60). Another agent is actively repairing that treasury -
`deep_stack_opening_balance_correction` landed while this was being written.
Two agents correcting one treasury from different directions is how a
double-repair happens, and a double-repair on nine million chips is worse than
the drift. It is written down here and left to whoever holds it.
