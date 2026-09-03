# Engine deploys are blocked by the financial gate (2026-09-01)

**Status: reported, not fixed. This is a money path and the decision is Dan's.**

## CORRECTION 2 (Dan, 2026-09-01) - THE DEPLOY MODEL CHANGED WHILE THIS WAS BEING WRITTEN

**Both earlier versions of this file are now wrong about the schedule, and
the second one was wrong the moment it was written.** Recording that plainly
rather than editing the history quietly.

Dan: _"WE DO DEPLOYMENTS EVERY HOUR ON THE :55 NOW."_ That superseded the
2026-08-31 five-window rule, and #2527 landed the change at 13:00 UTC - while
I was reading a checkout that predated it. So my "the next window is 14:00
Chicago, 19:00 UTC" was describing a mechanism that no longer existed.

**The model that is actually live.** `auto-deploy-hetzner.yml` runs at :40,
:45 and :50 every hour (three ticks, because a GitHub scheduled run is
best-effort). Each gives the runner time to check out, test and build before
:55. The restart itself happens inside an ANNOUNCED FIVE MINUTE BREAK -
tables are told at :53 to finish the hand, the platform parks at :55 and
holds until :00 (`server/src/maintenance/MaintenanceBreak.ts`). There is no
Chicago window gate and no time zone left to get wrong.

**A bootstrap risk I checked and did NOT find.** The break gate waits for the
engine to publish `maintenance.readyForRestart`, and the engine in production
predated that feature - which would deadlock the very deploy that ships it.
It does not: the gate distinguishes READY, LEGACY and timeout, and a LEGACY
engine (no `maintenance` block in `/health`) is restarted once on the old
SIGTERM drain. Whoever wrote #2527 had already thought of it.

## THE REAL PROBLEM: THE HOURLY SCHEDULE WAS NOT FIRING

The change is correct and it was not running. Measured at 18:36 UTC, the last
20 runs of the workflow:

    15:54 workflow_dispatch failure
    15:37 workflow_dispatch failure
    15:25 workflow_dispatch failure
    14:58 schedule       success
    12:15 workflow_dispatch success
    ...

The hourly cron landed at 13:00 UTC. Between then and 18:36 there should have
been sixteen scheduled ticks (13:40 through 18:30). **Exactly one scheduled
run happened in that entire period, at 14:58**, and it correctly skipped
because 09:58 Chicago was not a window under the rules then in force.

So the engine served the 03:54 image for **fourteen and a half hours** with
five merged PRs waiting - which is precisely the orphaning Dan's change was
made to stop. GitHub scheduled workflows are best-effort and can be dropped
under load; the workflow's own comments say so, and three ticks an hour were
meant to survive that. Three ticks do not help when none of them fire.

**Resolved for today** by dispatching the workflow through the sanctioned
path (a plain `workflow_dispatch`, no `force`, no gate bypassed) once the
conservation gate had cleared on its own. Run 33544596087 succeeded at 18:43;
the container was rebuilt at 18:42:01 and the new code is verified present
and executing:

    docker exec ... grep -c beyondGtoDepthCeiling /app/dist/engine/HorseLogic.js  -> 3
    docker exec ... grep -c river_aggr_won /app/dist/services/HorseHandReview.js  -> 2
    docker exec ... grep -c callersOfPreviousRaise /app/dist/engine/HorseLogic.js -> 3

and, three minutes after the restart, the new counters are firing at live
tables: v31_miss_depth_le50/le110/le300, v31_miss_street_turn/river,
v32_miss_depth_le50/le300, v32_miss_street_flop/turn/river.

**Still open, and it is not a one-off.** Nothing has been done about _why_ the
schedule stopped firing. Until that is understood, the hourly model depends on
someone noticing and dispatching by hand, which is the same failure the league
runner had: a job that looks identical whether or not it is running.
`publish-watchdog.yml` already alarms when production falls behind main - the
question worth answering is whether it fired today and, if it did, why nothing
acted on it.

## CORRECTION, added after the first version of this file

The original text said deploys are blocked, full stop. That is incomplete in a
way that could mislead, so it is corrected here rather than quietly reworded.

**The engine is SUPPOSED to wait.** Dan, 2026-08-31, binding: _"STOP THE
ENGINE FROM RESTARTING. IT SHOULD ONLY BE RESTARTING AT 7AM AND 7PM FROM NOW
ON."_ `auto-deploy-hetzner.yml` now admits only five Chicago hours - 04, 10,
14, 18, 22 - and merged engine code waits for the next one by design. The
workflow says so itself: _"the wait is the feature."_

So there are two separate reasons nothing from today is live, and only one of
them is a fault:

1. **By design.** The 14:58 UTC run skipped correctly - _"2026-09-01 09:58 CDT
   is not a scheduled restart hour in Chicago. Nothing was deployed and the
   engine was not touched."_ That is the system working.
2. **The fault.** The three runs inside the 10:00 Chicago window (15:25, 15:37,
   15:54 UTC) did try to deploy, and the financial gate stopped all three.

The next window is 14:00 CDT = **19:00 UTC**, and the gate clears around 18:30
UTC, so today's engine work should land at 19:00 UTC without anyone forcing
anything. If it does not, the gate is still failing and the cause below has
not resolved.

## What is happening

`auto-deploy-hetzner.yml` failed the three runs that fell inside its 10:00
Chicago window (15:25, 15:37, 15:54 UTC), all on the same step:

    Financial health-gate (zero-drift phase 5)
      FAIL  trailing 4h unexplained chip supply is -4162775.63
    [check-chip-conservation] FAILED

The gate is doing exactly its job. It refuses to ship the engine while the
books do not balance, and it should not be bypassed. There is a
`[skip-financial-gate]` commit tag; using it on a chip-supply alarm would be
precisely the wrong move.

## The consequence, which is what makes this urgent

**Nothing merged to `server/**` today is live.\*\* The running container was
built at 03:54 UTC, hours before any of it merged. Proved directly rather than
inferred:

    docker inspect club-arena-engine -> created 2026-09-01T03:54:43Z
    docker exec ... grep -rl 'noteGtoMiss' /app/dist /app/src   -> 0 matches
    docker exec ... grep -c 'beyondGtoDepthCeiling' ...          -> no match

and from the telemetry side, on a day with 715,866 decisions:

    gto_miss_no_cell      7,785 fires
    v32_defend_no_range   6,457 fires
    v31_miss_depth_*          absent
    v32_miss_depth_*          absent
    gto_skip_too_deep         absent

`noteGtoMiss` is called on the line immediately after the `gto_miss_no_cell`
counter. The first fires and the second does not, so the deployed engine
predates that change. Five merged PRs are waiting: #2464, #2467, #2470, #2474,
#2479.

## What the alarm actually is

Total chip supply is CONSERVED. Across six hours it moved from 189,865,036 to
189,863,289 - a drift of about 1,700 on 189 million, which is ordinary rake
and settlement noise.

The spike is a single pool moving, and the ledger classifying that movement as
a mint:

| Time (UTC) | member_wallets  | agent_wallets  | mint_since_prev | unexplained    |
| ---------- | --------------- | -------------- | --------------- | -------------- |
| 12:05      | 171,520,148     | 6,726,000      | 4,159,644       | 258            |
| 13:05      | 171,520,377     | 10,066,000     | 4,159,644       | +1,582,259     |
| 14:05      | **167,790,742** | **13,796,000** | 5,741,355       | **-5,743,763** |
| 15:05      | 171,520,868     | 10,066,000     | 0               | -1,530         |
| 16:05      | 171,519,367     | 10,066,000     | 0               | +371           |

At 14:05 member wallets are down 3,730,000 and agent wallets are up by the
same 3,730,000, and it reverses an hour later. Note also that `mint_since_prev`
reports the identical 4,159,644.00 at both 12:05 and 13:05 - the same movement
counted in two consecutive snapshots.

So the reading is: **agent-wallet funding is being written to the mint ledger
rather than recorded as a transfer between pools.** Nothing was created and
nothing was lost; the conservation check compares the pool delta against the
mint ledger, the mint ledger claims 5.74M was minted, the pools say nothing
was, and the difference is reported as unexplained.

I have NOT changed anything here. Per CLAUDE.md 11.5 a money path is not
probed or patched on an agent's own reading of it, and the classification of
agent funding is a design decision, not a bug I can assume.

## It self-clears, and that is also a problem

The gate sums `unexplained` over a trailing 4 hours. Modelling the window
forward:

| Gate runs at | Sees      | Verdict  |
| ------------ | --------- | -------- |
| 17:00        | 4,162,663 | FAIL     |
| 17:30        | 5,744,922 | FAIL     |
| 18:00        | 5,744,922 | FAIL     |
| 18:30        | 1,159     | **PASS** |

Once the 14:05 snapshot ages out the gate goes green on its own and today's
engine work deploys on the next run. That is convenient and it is the wrong
property: **a real chip leak would also age out of a 4-hour window.** The gate
forgets, so the only thing standing between a genuine loss and a silent
recovery is whether somebody happened to look inside the window.

## Recommended, for Dan to decide

1. **Classify agent-wallet funding as a transfer, not a mint.** That removes
   the phantom at its source. Money path, so it needs your sign-off.
2. **Make the conservation failure sticky.** A breach inside the window should
   raise a durable record that has to be cleared deliberately, rather than
   expiring after four hours. As it stands the gate can only catch a leak
   during the four hours it happens to span.
3. Until either lands, expect the engine to deploy in bursts: blocked while a
   funding run is inside the window, released afterwards.
