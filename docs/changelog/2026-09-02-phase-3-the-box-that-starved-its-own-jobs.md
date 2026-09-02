# 2026-09-02 — Push/publish cost audit, phase 3: the box that starved its own jobs

Phases 1 and 2 made the publisher converge on the tip of `main`. Phase 3 was
meant to be bookkeeping: move the remaining billable jobs onto the Hetzner
box. It turned into an incident, because the box had been tuned for a
situation that never happens.

## What was measured

Numbers below are counted from the Actions API over a rolling 24 hours, not
estimated. This replaces the "85 PRs/day" figure the previous handoff carried
as UNVERIFIED.

|                        | minutes / 24h | cost / month |
| ---------------------- | ------------: | -----------: |
| Still billed by GitHub |          3272 |         $785 |
| Already on the box     |          1375 |   $330 saved |

The largest remaining hosted line items, per month:

| Workflow                                   | hosted min/day | $/mo |
| ------------------------------------------ | -------------: | ---: |
| CI (chiefly CSS Beat E2E, a required gate) |           1913 |  459 |
| Build for World Hub Sync (the publisher)   |            518 |  124 |
| Auto-Deploy Hetzner Engine                 |            188 |   45 |
| Post-Deploy E2E                            |            175 |   42 |
| Publish Watchdog                           |            146 |   35 |
| Silent Revert Guard                        |            115 |   28 |

## What was routed

`changes`, Source Windows, Stub Gate, `verdict`, Live Production E2E and
Post-Deploy Verification now read `vars.CI_RUNNER`. Ten of twelve CI jobs run
on the box. CSS Beat E2E and the publisher's own shards stay hosted, on
purpose — see the capacity note below.

The Playwright `--with-deps` branch is keyed on `runner.environment`, not on
`vars.CI_RUNNER`. That variable is set repo-wide, so keying on it would have
dropped `--with-deps` from CSS Beat E2E while that job is still hosted and
needs the apt step, breaking a required check.

## Three things that were not true

**The worker cap was a constant where it should have been a ratio.**
`VITEST_WORKERS` defaulted to 4, measured honestly on an idle box with one
job. Nine jobs ran at once instead: 26 vitest processes, load 44 on 8 cores,
0% steal, three more jobs queued. A 150-hand simulation that takes 967 ms
measured 12342 ms, blew a 10 s ceiling, turned `main` red and stopped the
publisher. A queued job waits harmlessly; a starved job times out. The cap is
derived now — total workers near 2x cores divided by the runner count, floor
2, ceiling 4 — and the run prints the peak it implies.

**The sweeper restarted runners that were mid-job.** It promised never to kill
a job and decided idle from `pgrep Runner.Worker` alone. Between the Listener
accepting a job and the Worker appearing, a committed runner shows no Worker.
Applying the cap landed in that window and killed two CI jobs, which reported
"The runner has received a shutdown signal" — it reads like an infrastructure
blip and it was this script. A runner that has accepted a job has already
written into its `_work` tree, so that is the second signal now, checked
twice, under a `flock` because the provisioner raced its own cron copy.

**RUNNER_ENVIRONMENT was never set by this runner build.** Three test files
relax their wall clock with `RUNNER_ENVIRONMENT === 'self-hosted' ? 3 : 1`.
The string appears zero times in `Runner.Worker.dll` and `Runner.Common.dll`,
so every one of them was a silent no-op: the ternary took the hosted branch on
the self-hosted box. The proof is a failure reading "Test timed out in
10000ms" where a working multiplier would have said 30000ms. The idiom is
spreading rather than receding — a fourth copy shipped in #2659 the same
afternoon. The drop-in exports the variable now, which repairs every existing
and future copy without touching those files.

## A pin that was left behind

`tests/config/spinEngineWiring.test.ts` matched the literal
`tournament.blind_structure = spinBlinds`, one line of a hand-written
per-field copy that dropped `payout_structure`. #2645 replaced the whole list
with `applySpinDrawPatch`, which copies every key by construction, and did not
move the pin. The pin went red on a repo whose behaviour had improved, and it
stopped the publisher. CLAUDE.md 10.6 already requires moving a pin in the
commit that replaces its mechanism; this is that move, late.

## Capacity, and the one decision left

The box runs at 100% CPU with 0% steal during bursts, so the shared vCPU is
not being throttled and the dedicated `ccx33` at +$24.50/mo would buy nothing.
It is simply out of cores.

Routing CSS Beat E2E (~$297/mo) and the publisher (~$124/mo) onto it as it
stands would slow publishing, which is the thing phases 1 and 2 existed to
fix. Absorbing both needs `cpx51` (16 cores, 32 GB) at $279.49/mo, +$138 to
save ~$421 — net ~$283/mo, and the headroom that stops jobs starving. That is
a spending decision, so it is Dan's, and it is the only thing phase 3 leaves
open.
