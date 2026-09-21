# tests/no-workflow-gains-a-new-timer.law.test.ts

## The law

No workflow in this repository gains a new `- cron:` line, and no existing
schedule changes cadence, without that change being a reviewed edit to this
law's own list.

## What it covers that nothing else did

Measured 2026-09-19: **11 `- cron:` lines across 9 of this repo's workflow
files.** Three existing law tests enforce CLAUDE.md 10.85 for exactly one file,
`schema-manifest-refresh.yml`, each asserting `<= 2`. The other workflows were
covered by nobody, and no inventory of what this repo runs on a timer existed
anywhere.

## Why an allowlist of file and schedule pairs

**Not a count.** A count of 11 is blind to the change that actually costs.
`estate-integrity.yml` moving from `17 */4 * * *` to `* * * * *` keeps the count
at 11 and multiplies its runs by 240. That cadence was already tuned down once
in a cost audit, which is recorded in the file's own schedule block.

**Not a hash.** `ci.yml` changes constantly, so a directory hash would be red
for unrelated reasons most days. This estate has already written up what that
costs: a job red for an unrelated reason is how the real signal became
invisible.

A file and schedule pair fails on a new line, a moved line and a changed
cadence, and the diff names the job.

## It fails in both directions

A timer that appears fails the first test. A timer that disappears fails the
second. Retiring a schedule is meant to be as visible as adding one, because a
schedule that vanishes silently is the same class of problem as one that
appears silently.

## No contradiction with the existing three

The list carries exactly two entries for `schema-manifest-refresh.yml`, which
satisfies the `<= 2` assertion in `tests/the-second-writer-is-audited.law.test.ts`
and the two in `tests/an-attestation-nobody-re-reads-is-a-photograph.law.test.ts`.
All four bind the same fact and move together.

## workflow_dispatch

`cron-health.yml`, `estate-integrity.yml` and `schema-manifest-refresh.yml`
could not be run on demand, so confirming a fix meant waiting up to six hours
for the next tick. Adding `workflow_dispatch` is not adding a schedule, and the
law asserts all three keep it.

Each already had a `repository_dispatch` trigger, so a run with
`github.event.schedule` empty is an already-exercised path. The only
schedule-conditioned job in the three is `schema-manifest-refresh.yml`'s
`refresh`, whose `if: github.event.schedule != '40 * * * *'` is true on a manual
run, exactly as it already is on the repository dispatch.

## Asserting the negative

Timers are counted with YAML `#` comments stripped, quote-aware so
`'13 9 * * 1' # Mondays 09:13 UTC` keeps its value. That is the live shape in
`secrets-expiry.yml`.

`blankNonCode` in `tests/helpers/sourceWindow.ts` handles JavaScript comments
and understands neither SQL's `--` nor YAML's `#`, so this law carries its own
stripper. Measured today, raw and stripped both count 11, so the stripper
changes nothing now and exists to keep a future workflow comment that quotes a
`- cron:` line while explaining why it must not be added from tripping the gate.
