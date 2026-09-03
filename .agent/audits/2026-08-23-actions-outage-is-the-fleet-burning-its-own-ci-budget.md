# The Actions outage is not a GitHub fault - the fleet is burning its own CI budget

Date: 2026-08-23
Author: cowork-embedsweep
Status: cause identified; the immediate unblock needs Dan (billing page). The
structural fix is specified below but deliberately NOT shipped - see section 6.

## 1. What is happening

Every GitHub Actions run created across the estate after
**2026-08-22T23:28:34Z** has failed. Still failing at 2026-08-23T01:11Z.

The failure is not a workflow failure. No runner is ever assigned:

    job="TypeScript Check"  conclusion=failure  runner_name=""  steps=0
    started 01:09:12Z  completed 01:09:14Z          (2 seconds, zero steps)

The boundary is sharp:

| Time (UTC)           | Event                                                      |
| -------------------- | ---------------------------------------------------------- |
| 2026-08-22T23:28:34Z | last successful run anywhere (Publish Watchdog)            |
| 2026-08-22T23:30:58Z | first no-runner failure (Agent Autopilot, run 32605429489) |

Verified at both ends of the window - run 32605429489 (23:30:58Z) and run
32609659494 (01:09:12Z) both show runner_name="", steps=0, ~2s.

## 2. What it is NOT - each ruled out by measurement

| Hypothesis                    | Evidence against                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bad PR / bad workflow file  | Failing branches include main, six unrelated agent branches, and the estate's own Publish Watchdog, Estate Integrity, Agent Autopilot, Silent Revert Guard and Main Rewind Guard. |
| Actions disabled on the repo  | GET /repos/.../actions/permissions returns {"enabled":true,"allowed_actions":"all"}                                                                                               |
| A GitHub incident             | githubstatus.com summary: All Systems Operational, zero open incidents, checked 01:10Z.                                                                                           |
| A workflow that crashes early | There is no log to crash into. GET /actions/jobs/<id>/logs returns BlobNotFound. The job never started.                                                                           |

runner_name="" plus steps=0 plus no log blob is the canonical signature of _the
job was never dispatched_. With Actions enabled and GitHub healthy, that leaves
account-level entitlement: Actions minutes exhausted, spending limit reached, or
a failed payment method.

**This could not be confirmed directly.** The local PAT is fine-grained and
returns 403 on every billing endpoint (/settings/billing/actions,
/settings/billing/usage) and on checks/annotations. GET /user returns
plan: null for the same reason, so the account's plan tier is unconfirmed.

## 3. WHY it ran out - this is the part the previous handoff missed

Both repos are **private**, owned by a **User** account. Private-repo Actions
minutes are metered. The fleet's burn rate against that meter:

Runs created per hour, Smarter-Poker-Club-Arena:

| Hour (UTC)       | Runs                                  |
| ---------------- | ------------------------------------- |
| 2026-08-22 22:00 | 111                                   |
| 2026-08-22 23:00 | 141                                   |
| 2026-08-23 00:00 | 35 (post-outage; jobs now fail in 2s) |

Smarter-Poker-World-Hub logged 149 runs in the same 23:00 hour.

Measured wall-clock, club-arena, the 40 minutes before the outage
(22:48:39Z to 23:28:00Z):

| Workflow                   | Runs | Avg wall |
| -------------------------- | ---- | -------- |
| CI - Build & Type Safety   | 50   | 234s     |
| Build for World Hub Sync   | 19   | 472s     |
| Agent Autopilot            | 51   | 51s      |
| Silent Revert Guard        | 50   | 23s      |
| Agent Open PR              | 32   | 27s      |
| Publish Watchdog           | 20   | 24s      |
| Main Rewind Guard          | 19   | 20s      |
| Auto-Deploy Hetzner Engine | 4    | 223s     |

**Billed minutes are per job, rounded up per job** - not per run. CI - Build &
Type Safety dispatches five real jobs in parallel (TypeScript Check, Production
Build, Client Unit Tests, Server Engine, CSS Beat E2E).

Estimate for that 40-minute window, club-arena alone - _this is an estimate, the
inputs above are measured_:

    CI                    50 runs x 5 jobs x ~3 min      ~750 min
    Build for WH Sync     19 runs x 8 min                ~152 min
    orchestration         172 runs x 1 min (min billing) ~172 min
    Hetzner deploy         4 runs x 4 min                 ~16 min
                                                        ---------
                                                        ~1,090 min

GitHub's private-repo allowance is 2,000 min/month on Free and 3,000 on Pro.

**The estate consumes its entire monthly Actions allowance in roughly one to one
and a half hours of active fleet work.** That is the finding. The outage was not
an accident of timing; it is the arithmetic.

## 4. The immediate unblock (Dan only - agents cannot do this)

https://github.com/settings/billing - check Actions minutes used, the monthly
spending limit, and the payment method. Raising the limit restores CI.

**It will buy roughly an hour at the current burn rate.** Do section 5 as well.

## 5. Where the budget actually goes

By share of the pre-outage burn:

- **~69% is CI - Build & Type Safety.** It already has
  concurrency: cancel-in-progress: true, so this is not runaway duplicates -
  it is five jobs x every push x ~40 pushes/hour from the agent fleet.
- **19 of 61 CI runs were on main.** ci.yml triggers on both pull_request
  and push: main. Every squash-merge therefore runs the full five-job matrix a
  second time, on a commit the PR run already validated.
- **~16% is orchestration** - Autopilot, Silent Revert Guard, Agent Open PR,
  Publish Watchdog, Main Rewind Guard: 172 of 300 runs. Each is short (20-51s)
  but each is billed a **full minute minimum**. Agents managing agents.
- Build for World Hub Sync (472s avg) has a concurrency: block **without**
  cancel-in-progress.

Candidate reductions, highest leverage first:

1. Skip CI jobs on docs-only diffs, via a changes detection job plus if:
   guards on each job. **Do NOT use a workflow-level paths: filter** - the five
   CI jobs are required checks on the main ruleset, and a workflow filtered out
   by paths: never reports, which hangs every docs PR in BLOCKED forever. A job
   skipped by if: still satisfies a required check; a workflow skipped by
   paths: does not. 11 of 61 CI runs were on docs/ branches.
2. Narrow the push: main CI run to only the jobs that are genuinely
   post-merge (Post-Deploy Verification), rather than re-running the full matrix.
3. Add cancel-in-progress to Build for World Hub Sync - **only after**
   checking whether a cancelled sync can leave public/hub/club-arena/ half
   written. It is the publish step; a partial sync is worse than a wasted minute.
4. Collapse the five orchestration workflows. Five one-minute billings per push
   for work that is mostly API calls.

## 6. Why none of that was shipped in this audit

Every one of those changes edits the workflow that gates **every agent's
merges**, and CI is down, so none of them can be validated. Shipping an
unverifiable change to the merge gate during an outage is how the merge gate
stays broken. The measurements are here so the change can be made deliberately,
with CI green, by someone who can watch it land.

## 7. Also verified this session (unrelated to the outage)

- **The embed sweep is clean on main.** Re-ran check-embed-relationships.mjs
  (currently only on PR #329's branch) against origin/main @ 8c11d80a9 with the
  service-role key: 35 distinct embedded selects, exactly 3 broken, and all 3 are
  the ones PR #329 fixes (HandReplayViewer, BlockedPlayersList, TableService).
  No new breakage has been introduced since the sweep.
- **All five "still open" items from the previous handoff's section 5 are already
  fixed on main** by other agents - club_members.reputation_xp,
  tables.is_running, social_conversation_participants.is_typing, and the two
  MessagingService.ts embeds (message_reactions.sender_id, messages.inviter_id).
  Only the audit comments naming them remain. That list can be struck from the
  handoff.
- **WIP snapshot taken by hand** (launchd still captures nothing - ~/Documents
  is TCC-protected and Full Disk Access has not been granted):
  refs/wip/club-arena/20260823T011148Z. agent-trees-audit.sh now reports 7
  trees at risk, down from the handoff's larger list - most agents have pushed.
  Documents/club-arena-2 still holds 28 uncommitted files, ~21h stale, and was
  not touched: it belongs to another agent.
