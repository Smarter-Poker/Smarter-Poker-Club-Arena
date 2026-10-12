# A detector's own verdict is not evidence about the estate

2026-10-03. `Production Integrity Audit` was the last red workflow on `main`.
Four of its eleven jobs were reported as failing; two actually were.

## What each job measured, and what it found

### 1. `The engine is running main` - RED, and the check is right

`.github/scripts/audit-engine-provenance.sh` is not a byte-equality check. It
resolves the newest **runtime-affecting** commit on protected main (`server/**`
minus tests, sim and qualification) and asserts containment in both directions:
the served commit must be an ancestor of `main`, and the required commit must be
an ancestor of the served one. An engine ahead of the required commit passes; a
docs-only or client-only merge cannot make it red.

Measured on run `37098827354` (2026-10-03T05:08:21Z):

```
main needs : 5c7d15db (2026-10-03T05:05:44Z)
engine has : df93949024a1c70ff7ceabeedc59bf0a529b0fe2
```

`df93949024a1` IS an ancestor of `main`, so the engine is not running something
main does not contain. It is behind by exactly ONE engine-affecting commit -
`5c7d15dba8`, `fix(engine): return uncalled ante-only money before rake;
multi-board odd cent by seat order (#5918)` - a real money fix merged three
minutes before the audit ran. Nothing is wrong with the check: production is
genuinely behind, transiently, and the certified delivery for it was already in
flight (`auto-deploy-hetzner.yml` run `37098736112`, queued 05:06:18Z, waiting in
its break gate for the `:55` cutover, CLAUDE.md 13).

The repo has already answered the "chronic boolean" objection and answered it
somewhere else: the `engine_deploy_starvation:` job exists precisely because
`engine:` is a boolean that stayed red for days, and the chosen remedy was a
second job reading the deploy attempt ledger for the GRADIENT rather than
softening the boolean. That job is green. Nothing here was changed: `engine:` is
also the credential-free observer - `tests/engine-watchdog-asks-production.test.ts`
forbids it a `GH_TOKEN` or a `DATABASE_URL` - so it cannot ask whether a
receiver is in flight, and it must not be given a clock to guess with.

### 2. `Nothing is silently red on main` - RED, and the check is right about the estate and wrong about itself

The detector reported five workflows red on `main` past the 6h threshold:

| workflow                       | consecutive | duration                                       |
| ------------------------------ | ----------- | ---------------------------------------------- |
| Estate Integrity               | 73          | 24.0 days                                      |
| Production Integrity Audit     | 112         | at least 21.5 days, no green run in the window |
| Trusted Money Trigger Recovery | 12          | 14.9 days                                      |
| Cron Health                    | 17          | 5.3 days                                       |
| Club Create Certification      | 62          | 13.2h                                          |

Four of those are real and owned elsewhere. The second one is this workflow, and
it is the defect fixed here.

`check-main-is-green.mjs` reads EVERY active workflow's latest verdict on `main`,
including the workflow it is running inside. So its own exit code decided its own
next input, and **green was unreachable by arithmetic**: with the entire estate
green and every other job in this workflow green, the previous run's failure
still put `Production Integrity Audit` in `red`, past any threshold, and alarmed.

This is CLAUDE.md 10.86 rule 4 - the same trap one level up. On 2026-09-30 the
inferred self-mute (`r.loud = hasOpenAlarm(...)`) was correctly removed and
replaced with a DECLARED registry, `SELF_ALARMING_WORKFLOWS`. That registry can
never reach this case by its own rule: an entry must name the label of the issue
THAT workflow files and may never be `MAIN_HEALTH_READER_LABEL`, and the
main-health issue is this workflow's only write path. The registry is right and
stays empty; the fixed point needed a different answer.

**The answer is not "skip my own workflow."** This workflow has eleven jobs and
nine of them read production. A wholesale exemption would hide a red `Live chip
and diamond supply still conserves` from everybody, which is 10.83 in a fresh
coat.

So only the circular part is removed:

- the workflow `GITHUB_WORKFLOW` names - never a hardcoded title - can classify
  as the new `RED_STATE.SELF_REFERENTIAL`, which does not alarm;
- it does so **only** when `onlyFailingJobIs` proves every failing job in its
  latest verdict was `MAIN_HEALTH_JOB_NAME`, read from the Actions jobs API. Any
  other failing job is a real finding and alarms exactly as before;
- an unreadable or empty job list returns false and alarms (10.86 rule 2);
- nothing is inferred from an issue, a label, or a marker this detector wrote.
  That was the 2026-09-30 bug and it stays fixed: `tracked` still alarms.

It is not silent either. A self-referential red is printed in the oldest-first
report with its age, carries its marker into the durable issue, and raises a run
annotation naming how long it has been red - so the reader is unchanged and the
wording still moves (10.86 rule 3). And it can never close the alarm: the close
step greps for the exact all-green sentence, which the detector prints only when
`red.length === 0`.

Convergence, with the estate green: run N reports SELF_REFERENTIAL and exits 0,
so run N is green; run N+1 sees a green latest verdict, prints the all-green
sentence and closes the durable issue.

**This does not make the job green today**, and that is the point - `engine:` is
red in the same run, so `onlyFailingJobIs` returns false and the workflow alarms
exactly as it did before. What changed is that green became reachable at all.

### 3 and 4. `Explicit scoped engine error observation`, `Explicit tournament runtime observation` - NOT red

Both are gated on `github.event_name == 'repository_dispatch'` with a specific
`client_payload` key. Across the last 30 runs of this workflow each one was
`skipped` 26 times and `success` 4 times, and **failed zero times**. They are
conditional observation jobs behaving as declared; there was nothing to fix.

## Not changed, and why

- The audit stays READ-ONLY (CLAUDE.md 1.1). The one new request is a GET on
  `/actions/runs/{id}/jobs`, under the `actions: read` the `main_is_green` job
  already holds. No retry, dispatch, repair, publish or production write was
  added anywhere.
- No allowlist, no threshold was moved, no pin was weakened. `tracked` still
  alarms; age still escalates; `SELF_ALARMING_WORKFLOWS` is still empty.

## Pinned by

`tests/a-detector-does-not-mute-itself.law.test.ts` (the same law, extended with
rules 5 to 8 and ten new assertions) and
`docs/laws.d/a-detector-does-not-mute-itself.md`.
