# The safety nets are not running, and a correction to what I said yesterday

Date: 2026-09-02
Branch: `fix/the-safety-nets-are-not-running`

## 1. A correction, first

`65cbdaa71` (PR #2585) closed a real hole — `fn_set_club_lobby_message` was
EXECUTE-granted to `anon`, and Phase 5's `message_revision` compare-and-swap had
a sibling writer that ignored it. Both of those findings stand, and both are
fixed and verified live.

**The reason I gave for why it mattered so much was wrong, and it is wrong in
the commit message, the changelog and the pull request body.** I wrote that the
`refresh` job runs behind the definer audit, so a red audit had stopped the
schema manifest from refreshing estate-wide. It does not. `refresh` and
`definer-exposure` are sibling jobs in `schema-manifest-refresh.yml` with no
`needs:` between them, and the workflow says so in its own comment:

> Its own job, so a schema-manifest problem and a security finding cannot mask
> each other.

What I actually saw was `refresh` marked **skipped** in the 22:47 run. That is
by design: `refresh` carries `if: github.event.schedule != '40 * * * *'`,
because the hourly cron exists for the security audit alone and an hourly
manifest pull request would be noise. I read a deliberate skip as a
consequential one.

I have left the fix in place and corrected the story here rather than rewriting
history, because the fix was right for its own reasons.

## 2. What is actually wrong, which is worse

Looking for the blocked refresh is how the real problem surfaced. **This
repository's scheduled workflows are firing at roughly a tenth of their
configured rate.** Measured over 2026-09-01 (UTC day):

| Workflow                           | Cron                        | Expected | Actually ran |
| ---------------------------------- | --------------------------- | -------- | ------------ |
| `schema-manifest-refresh.yml`      | `40 * * * *` + `20 5 * * *` | ~25      | **3**        |
| `publish-watchdog.yml`             | every 15 min                | ~96      | **5**        |
| `build-for-world-hub.yml` catch-up | `*/30 * * * *`              | 48       | **4**        |

The publish watchdog ran at 00:43, 06:04, 11:55, 16:13 and 22:38 — gaps of
five to six hours where the documentation promises fifteen minutes. The daily
05:20 manifest refresh did not fire at all; the only successful refreshes on
2026-09-01 were two manual `workflow_dispatch` runs at 12:54 and 13:21.

### What that cost, concretely, on one day

- **Issue #2566, "production is not serving main", was filed at 20:10 and the
  next watchdog run was 22:38.** The publisher had been jammed since 23:27 the
  previous cycle. The alarm designed to fire within fifteen minutes fired
  hours later.
- **The publisher's own catch-up cron is the documented remedy for exactly
  today's jam.** Its comment says so: "when the pushes stop right after a
  cancellation ... main and production stay diverged until somebody pushes
  again ... this makes the common case self-correct." It ran four times in
  twenty-four hours, and not once during the jam.
- **The anon-executable writer was live from at least 17:26 until 00:33.** The
  hourly audit that exists to shorten exactly that window ran three times.

### Why this is not a YAML bug

Nothing in these workflow files is wrong. GitHub does not guarantee scheduled
workflow delivery and drops runs under load; this repository had 30 open pull
requests each running a heavy matrix, and runner allocation was visibly
starved at the same time — `Build for World Hub Sync` runs sat with **zero jobs
created** for hours, and GitHub answered a cancel request with "cannot cancel a
workflow run that has not been queued yet."

So the estate's safety nets are built on a scheduler that is dropping most of
their runs, and every one of those nets is watching something more reliable
than itself.

## 3. What follows from it

`CLAUDE.md` section 11 already rules that scheduled jobs belong on Open Claw
(Hetzner, systemd, 85 jobs, its own cron). Section 11.4 exempts
`publish-watchdog.yml` with a good argument:

> A watchdog that shares a failure domain with the thing it watches is not a
> watchdog.

That argument was about the _deploy pipeline_. The measurement above adds a
second failure domain nobody had accounted for: the watchdog shares GitHub's
**scheduler** with the thing it watches, and that scheduler is where the
reliability is actually being lost. A watchdog that runs five times a day
cannot promise a fifteen-minute alarm.

Moving `publish-watchdog` and the publisher catch-up to Open Claw is the
change that follows, and it is a decision rather than a patch: it is Dan's
section-11.4 exemption to amend, and Open Claw's dispatcher is deployed with
`scripts/deploy-openclaw.sh` rather than from here. Recorded here with the
numbers so the decision can be made on evidence instead of on a guess.

Nothing in this changelog changes behaviour. The bundle-delta gate committed
alongside it is separate and self-contained.

## Postscript: the gate failed its own pull request, and why

The first version of `entry-chunk-delta.mjs` read the module list out of the
entry chunk's **sourcemap**. It passed locally and failed CI immediately with
`index-Kq1SvQtS-v6.js has no sourcemap`.

The reason is in `vite.config.ts`: the Sentry plugin uploads sourcemaps and then
deletes them (`filesToDeleteAfterUpload`), and it is gated on
`NODE_ENV=production && SENTRY_AUTH_TOKEN`. That is precisely CI and never a
developer machine. So the gate was reading an artifact that exists only where it
was written and never where it runs.

Rollup knows the chunk's modules without any sourcemap, so it is asked directly:
an `entry-module-manifest` plugin writes `.entry-modules.json` on `writeBundle`,
before Sentry can delete anything and outside `dist/` so the list never ships to
players. The baseline is 202 modules rather than the sourcemap's 156, because
Rollup's own ledger is the complete one.

Verified after the change: the gate passes at parity, and removing two modules
from the baseline still reproduces the 2026-09-01 leak by name.

The step condition was tightened at the same time. `always()` would have fired
even when the BUILD failed, where there is no `dist` to measure - turning one
clear failure into two. It now runs on success, or specifically when the size
gate above is the step that went red, which is when "who is paying for this" is
most worth answering.
