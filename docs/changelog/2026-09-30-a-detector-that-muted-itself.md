# A detector that muted itself, and a proof that could not be run

2026-09-30. Two defects in this repository's own signal layer. Both are
CLAUDE.md 10.86's signature failure - a detector answering confidently when it
cannot tell - and in both, the detector's confidence came from something it had
written itself.

---

## 1. `Nothing is silently red on main` was green while ten workflows were red

### What it did

`scripts/ci/check-main-is-green.mjs` decided everything in one line:

```js
for (const r of red) r.loud = hasOpenAlarm(r.name, r.since);
```

and alarmed only on `!r.loud`. `hasOpenAlarm` requires two machine-readable
facts: the `main-health-reader` label, and the per-workflow marker produced by
`workflowAlarmMarker`. **Nothing in the estate writes either of those except
this detector.**

The loop closes on itself. `production-integrity-audit.yml`'s
`Raise the durable alarm for a silently red main` step copies the detector's
whole log into the issue body; the log prints a marker for every red workflow,
including fresh ones it is not alarming about; the next hourly run reads those
markers back as evidence that somebody else has it in hand.

Measured on 2026-09-30, issue #4332 carried markers for ten workflows. Running
the real `classifyWorkflow` over each one's real completed `main` runs, against
the real issue:

| workflow                                        | consecutive failed verdicts | for           | old   | now                 |
| ----------------------------------------------- | --------------------------: | ------------- | ----- | ------------------- |
| Applied Migrations Are Recorded                 |                          50 | >= 29.9 days  | muted | **ALARM** (tracked) |
| Estate Integrity                                |                          65 | 21.5 days     | muted | **ALARM** (tracked) |
| Production Integrity Audit                      |                          96 | >= 19.0 days  | muted | **ALARM** (tracked) |
| Trusted Money Trigger Recovery                  |                          11 | 12.4 days     | muted | **ALARM** (tracked) |
| Telemetry Exposure                              |                          14 | 6.8 days      | muted | **ALARM** (tracked) |
| Post-Deploy E2E (production)                    |                          58 | >= 36.8 hours | muted | **ALARM** (tracked) |
| Cron Health                                     |                           9 | 2.8 days      | muted | **ALARM** (tracked) |
| Schema Integrity Audit                          |                          14 | 2.5 days      | muted | **ALARM** (tracked) |
| Settlement Lane Doctrine                        |                           - | green again   | -     | -                   |
| Auto-Deploy Hetzner Engine (on server/ changes) |                           - | -             | -     | -                   |

`>=` is this detector's own honesty about a fixed run window: every verdict it
can see is a failure, so the first one it can see is probably not the first
there was. Post-Deploy E2E is the noisiest and moves the most between reads.

Eight red, eight suppressed, and the job printed `At least one failure is fresh
or already tracked; retaining the alarm` and exited 0. The Actions conclusion
was **success**. With the fix, the same eight alarm and the job exits 1.

### Why the exemption existed

It is CLAUDE.md 10.83's, and its reasoning is right: a production audit that
exits non-zero in order to RAISE an alarm is doing its job, and the very first
run of this detector flagged `Publish Watchdog` doing exactly that - which
would have taught everyone to ignore the detector inside a week.

What is wrong is INFERRING that from "an open issue names this workflow", and
what is fatal is inferring it from an issue this detector wrote.

**Not one of the ten qualified.** Every one is a real defect or a real
un-cleared backlog. The exemption had no legitimate beneficiary at all; it was
pure suppression.

### What it does now

- **The marker is a receipt, not a mute switch.** A workflow the durable issue
  already names is reported as `tracked` and **still alarms**. `tracked` and
  `SILENT` differ in the word printed and in nothing else.
- **The 10.83 exemption is declared, never inferred.**
  `SELF_ALARMING_WORKFLOWS` in `scripts/ci/lib/workflowVerdicts.mjs` maps a
  workflow name to `{ reason, declaredOn, alarmLabel }`, where `alarmLabel` is
  the label of the issue **that workflow** files. It may never be
  `MAIN_HEALTH_READER_LABEL`. A declared workflow is exempt only while such an
  issue is open and has been touched since the failure episode began: declared
  but gone quiet is the 10.83 bug itself. **The registry ships empty**, which
  is a measurement rather than an oversight.
- **Age escalates instead of muting.** The report is ordered oldest-first and
  the annotation names the worst workflow with its duration and consecutive
  count, so the alarm's own wording moves as the estate gets better or worse. A
  chronic alarm whose text never changes is the same blind spot as no alarm.

### The reader, named

Unchanged: `.github/workflows/production-integrity-audit.yml`, job
`main_is_green`, hourly. It files and updates the single durable issue labelled
`main-health-reader`, and its final step carries the detector's exit code into
the job conclusion. Exit `3` remains COULD NOT TELL: it neither raises nor
closes anything. The close step still greps for the exact sentence
`OK - every workflow's latest VERDICT on main is green.` before touching the
issue, and the detector still prints exactly that sentence and nothing like it.

Pinned by `tests/a-detector-does-not-mute-itself.law.test.ts`
(`docs/laws.d/a-detector-does-not-mute-itself.md`). The existing exit-code
contract in `tests/a-watchdog-that-cannot-look.test.ts` - two `process.exit(0)`
sites, at least three `process.exit(UNKNOWN)` - is preserved unchanged.

---

## 2. A proof this check could not run was reported as a proof that came back false

`scripts/ci/check-migrations-are-live.mjs` is the converse check - a migration
that merged to `main` and was never applied - and it works. On 2026-09-30 it
was correctly red, having found
`20260927160709_a_page_recompute_reads_only_the_evidence_that_changed.sql`:
five functions, one table, three indexes and two triggers that production has
never had. That finding is real and was confirmed independently against the
live catalogue.

The defect is in how it reported the run's last line.

Step 3 runs each `-- @live-proof:` expression and treats any non-`true` answer,
**a rejection included**, as evidence the migration is not live. For
`ERROR: function ... does not exist` that is exactly right and is why the rule
reads that way: a proof about an unapplied migration names what is not there
yet. It is wrong for `ERROR: syntax error`, and the check was manufacturing
precisely that.

`declaredProofs` reads ONE line, because the marker is line-anchored and every
Lightning harness greps for it that way. Three migrations on `main` declare a
proof that does not survive it:

| migration        | what reaches the database                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `20260929130144` | `(SELECT count(*) FROM pg_index i` - truncated at line 1 of 7          |
| `20260928200404` | `(SELECT count(*) FROM pg_class c JOIN pg_namespace n ...` - truncated |
| `20260928001128` | two proofs that are English prose, not SQL at all                      |

so the run reported

```
proof false: (SELECT count(*) FROM pg_index i  ->  rejected: ERROR:  syntax error at or near "as"
```

and counted it toward MERGED BUT NOT LIVE. The verdict survived only because
step 2 had already caught the missing indexes. Had the objects been live, a
correct branch would have been accused on nothing whatever - and this file's
own header says what that costs: _"a check that accuses at a 70% false rate
gets switched off, which is how this estate already lost Applied Migrations Are
Recorded."_

### What it does now

An unrunnable proof is a **third outcome**. It is never run, never counted
false, always named, and on its own it makes the run exit **2 - COULD NOT
TELL**, which is neither the pass nor the accusation. Two layers, because
neither alone is enough:

- **Before asking.** `proofIsRunnable` refuses text that cannot be an
  expression - unbalanced parentheses, an unterminated literal or dollar quote.
  That covers every truncation, and it keeps a malformed proof out of the
  shared `UNION ALL` batch, which is a collapse this file already feared.
- **After asking.** `psql` now runs with `VERBOSITY=verbose`, so an `ERROR:`
  line carries its SQLSTATE. `42601` (`syntax_error`) is about the text we
  sent and can never be about what production holds. A missing object raises
  `42883` / `42P01` / `42703` and **stays a failure, unchanged**. A line whose
  SQLSTATE cannot be parsed is judged the old way, so a surprise in psql's
  output format cannot quietly turn a real miss into a shrug.

Precedence is **FAIL > COULD-NOT-TELL > PASS**: a migration that also fails on
real evidence still exits 1, because there we do know.

Proved by running both implementations against a stub `psql` through the
script's own `PSQL_BIN` seam - no production write, no credential:

| case                                        | `origin/main`             | now                                     |
| ------------------------------------------- | ------------------------- | --------------------------------------- |
| truncated multi-line proof, objects present | **exit 1**, "proof false" | **exit 2**, "COULD NOT RUN"             |
| missing object plus an unrunnable proof     | exit 1                    | **exit 1**, naming the missing function |
| proof rejected `42883` (function absent)    | exit 1                    | **exit 1**, unchanged                   |

Pinned in `tests/a-merged-migration-must-be-live.law.test.ts`, including a
non-vacuity bound: fewer than 2% of the 150+ proofs on `main` may be refused,
so the gate cannot pass by rejecting everything.

---

## What was NOT changed, and why

Two workflows are red on `main` for reasons that are correct, and nothing here
makes them green.

- **`Applied Migrations Are Recorded`** (issue #2630) reports that 22 of the
  276 migrations applied since 2026-09-23 have no file in either repository,
  and `check-recorded-migrations-evidence.mjs` separately reports nine recorded
  migrations whose file hash is not what production's `statements` holds. Both
  are real drift and a real backlog. Backfilling 22 migrations out of
  `supabase_migrations.schema_migrations.statements` is archaeology in its own
  right and is not attempted here.
- **`Production Integrity Audit`** is red because `check-anon-definer-grants`
  exits 1 and `migrations_are_live` exits 1. Both are findings, not detector
  defects.

Two symptoms quoted when this work was scoped -
`A live-drift detector produced no trustworthy verdict` and
`The merged-migration verdict is missing` - do not occur in the current runs.
Both `Carry the …verdict` steps received a numeric code (`live_drift` reported
`anon_definers=1`; `migrations_are_live` reported `1`). They were older runs.

### The measurement behind the migration-file question

Reconciling `git ls-tree -r origin/main supabase/migrations/` against
`supabase_migrations.schema_migrations` for versions at or after `20260914`:
**192 Club Arena migration files have no history row.** That is not 192 misses.
Of the 314 functions and 45 tables those files declare, **308 functions and 44
tables are live in production**. The six absent functions belong to two files,
one of which (`20260924130148`) is explicitly withdrawn by
`20260924134722_..._is_withdrawn.sql`; the other is `20260927160709`, the single
genuine miss, and exactly what the converse check reports.

So a missing history row is **not** evidence a migration did not run - that
criterion would produce 191 false accusations to find one real defect - and the
live object is. That is the criterion `check-migrations-are-live.mjs` already
uses, which is why the converse check needed repairing rather than replacing.
