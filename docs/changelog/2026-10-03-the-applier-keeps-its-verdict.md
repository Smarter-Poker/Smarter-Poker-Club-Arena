# The applier keeps its verdict, and the merged-migration backlog is live

2026-10-03

## What was red

Two workflows, one root cause and one coincidence.

`Apply Merged Migration` run **37091212017** was dispatched at **02:50:55 UTC**
and refused at 02:51:31:

```
[apply] REFUSED: it is :51 UTC and the break window is :50-:03. Dispatch again after :03. Do not loop.
```

That is `scripts/ci/apply-recorded-migration.mjs` doing exactly what CLAUDE.md
section 2 rule 8 asks of it - the database refuses non-temporary DDL from a
postgres-role session inside minute-of-hour :50-:03, and the script is the
polite half of that guard, so the refusal reads as a sentence here instead of
an aborted transaction there. Nothing was sent. The dispatch was simply 55
seconds into the hourly maintenance break.

`Production Integrity Audit` run **37088262878** was red for the real backlog:
`Every merged migration is live` named three files merged to `main` and absent
from `supabase_migrations.schema_migrations`, and `Nothing is silently red on
main` aggregates that verdict.

## What was actually applied

Measured against `origin/main` at `9e40f709c4`, four files at or after
20261002000000 were absent from `schema_migrations` by name. One of the four is
marked never-to-run. The real backlog was three:

| migration                                                                     | outcome                                              |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| `20261003021958_a_park_over_a_committed_hand_is_withdrawn_when_its_roster_ca` | APPLIED (run 37091934224, committed in 334ms)        |
| `20261002153151_a_standalone_club_banks_its_retired_rake_from_its_dispositio` | APPLIED (run 37092230178, committed in 2789ms)       |
| `20261002145612_the_jackpot_lifetime_counts_an_unopened_pool`                 | REFUSED BY ITS OWN ASSERTION - left alone, see below |

`20261002145829_a_standalone_club_banks_its_retired_rake_at_the_weekly_close`
carries `-- SUPERSEDED BY 20261002153151` on its first line and must never run.
It was not dispatched.

### The park withdrawal

`20261003021958` replaces the body of `fn_f06_withdraw_unplaceable_park` so a
park held over a SEALED hand can be withdrawn, not only one over a
`never_started` permit. Fifteen full tables (135 players) on 79feebfc "Prime
Time Free Buy (NLH)" and the heads-up SNG 657e45b2 had been parked since
01:10Z behind `F06_WITHDRAWAL_POSITIVE_ORIGINAL_REQUIRED`, because the
timed-out `fn_f06_begin_hand` rolled back and left no `never_started` row to
witness the park. It moves no chip, seat or registration.

A sibling agent dispatched the same file 18 seconds ahead of this task and it
APPLIED; the dispatch here then reported `ALREADY-APPLIED ... Nothing sent`,
which is the idempotent read working as designed.

### The standalone rake bank

`20261002153151` credits a standalone club's retired rake to the treasury that
pays its commission, once a week, and banks the two closed weeks whose
commission the treasury had already paid. Verified from
`public.ca_mint_ledger` after the apply:

| week       | amount     | balance before | balance after |
| ---------- | ---------- | -------------- | ------------- |
| 2026-09-14 | 238,108.58 | 31,840.00      | 269,948.58    |
| 2026-09-21 | 369,156.51 | 269,948.58     | 639,105.09    |

607,265.09 to Deep Stack Society, both legs in one transaction at
03:10:12.871Z, through `fn_ca_fund_club` under the idempotency keys
`standalone-rake-bank:<club>:<week>`, exactly the figure the migration's own
backlog block asserts. It would have aborted had the board moved.

### The one that refused itself, and why it was left

`20261002145612` replaces the body of `fn_bbj_conservation_check` so a pool the
hourly meter has not opened yet is inside the lifetime identity from its
creation. Its own post-assert then requires the lifetime identity to be within
1.00, and the live figure is **200.00**:

```
unexplained 245.80, known_residue 45.80, moved_since_resolution 200.00,
journalled_seeds_after_epoch 8400.00, journalled_burns_after_epoch 8200.00
```

**These figures are POST-change.** The assert runs after `EXECUTE v_new`, so
it is the migration's own new body that read 200.00 - the fix does not
reconcile the current data, which is a stronger statement than "the board
moved". The transaction rolled back after 78.8s and committed nothing.

The live identity is also volatile. Read against the unchanged production body
at 03:25Z it was **-100.00** - exactly the symptom this migration was written
to remove - fifteen minutes after the refusal reported +200.00. There are
currently five post-epoch `bbj_pools` rows with no meter baseline, created at
03:18:52, 03:05:36, 03:00:40 and (2026-10-02) 21:04:16 and 20:49:30Z, because
the welcome-certification and club-reset programme is creating and retiring
clubs every few minutes tonight. Its author caught a quiet moment at 14:49 UTC
on 2026-10-02 (seeds 5,400.00 / burns 5,200.00, `moved_since_resolution`
0.00); there has not been one since.

**This was left merged and unapplied deliberately.** The only way to install it
as written is to widen a jackpot money tolerance from 1.00 past 200.00, which
would be an agent deciding that an unexplained 200.00 in the bad-beat lifetime
identity is acceptable. It is not this task's to decide, and it is not a
tooling problem: with the fix installed the books still did not balance, so
the assert is reporting a real gap the fix does not cover.

Re-dispatching it would also be gambling on a transient rather than reading an
error, which is what section 2 rule 2 is about. `Every merged migration is
live` therefore stays red on this one file until whoever owns the BBJ
conservation work either explains the residue or widens the migration's set to
cover a pool whose club is retired before the meter ever opens it.

## The gap that let a refusal read as nothing

`Apply Merged Migration`'s summary for run 37091212017 did not say REFUSED. It
said **"UNEXPECTED exit "** - no number, no cause - for a refusal the applier
had stated in one clear sentence.

`scripts/ci/apply-recorded-migration.mjs` is careful to separate three
outcomes: `0` APPLIED or ALREADY-APPLIED, `1` REFUSED (nothing was sent), `3`
UNKNOWN (something may have been sent; inspect durable state first). Those call
for opposite next moves, which is the whole point of CLAUDE.md 10.86 rule 1.

The workflow threw the distinction away. GitHub runs `run:` under `bash -e`,
and the step opened with `set -uo pipefail`, which does **not** clear `-e`. So
the moment the node pipeline exited non-zero the step aborted - **before**
`echo "code=${PIPESTATUS[0]}" >> "$GITHUB_OUTPUT"` ever ran.
`steps.apply.outputs.code` was empty, and an empty string fell through the
`case` to the catch-all arm.

The fix is in the step: clear `-e` around the pipeline, capture `PIPESTATUS`,
write it, then exit with it. The verdict is recorded before the step hands its
failure to the job.

One level up (10.86 rule 4): the summary now also names the empty case rather
than calling it unexpected. If no code was recorded at all, whether anything
was sent is UNREAD, and the summary says so and says not to re-dispatch blind -
because a re-dispatch is the cheapest thing the next agent would reach for, and
it is the one thing rule 2 forbids.

**THE READER is the agent who dispatches the run**, unchanged - the workflow's
own header says so, and it is dispatch-only with no schedule and no discovery.
This change does not add a reader, a watcher or a retry. It makes the answer
the existing reader already receives say which of the four things happened.

Pinned by `tests/unit/applyMergedMigrationVerdict.test.ts`.

## What was NOT built

No watcher, no cron, no auto-apply, no repair job (10.11, 10.12). The PR-time
question - "is what I just merged applied?" - has no honest cheap answer,
because at PR time the change is not merged and "merged but unapplied" is not
yet defined for it. The hourly `Every merged migration is live` already answers
it after the merge, with a named reader, and it answered correctly here.

## Housekeeping

`~/Documents/club-arena`, the canonical clone every Cowork agent loads
`CLAUDE.md` and `.claude/skills/**` out of, was **77 commits behind
`origin/main`** (10.87). Inventoried first: `HEAD` an ancestor of
`origin/main`, 0 commits ahead, 0 dirty tracked files, no stranded
`.git/index.lock`, three untracked PNGs that do not exist on `main`.
Fast-forwarded with `merge --ff-only` to `9e40f709c4`; 0 behind, 0 ahead, the
three untracked files untouched. No reset, no rebase.
