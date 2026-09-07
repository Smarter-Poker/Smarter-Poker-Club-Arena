# The attestation restates itself, and never outgrows its budget

2026-09-07, evening. The deep dive over phase 6 of the chip-accounting
programme, run to Dan's standing order before phase 7 opens: "verify that
every thing you've built in the previous phase is 100% fully built, coded,
wired in and tested. CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
REGRESSIONS OR WIRING ISSUES."

Migration `20260907214827_the_attestation_restates_itself_and_never_outgrows_its_budget`
(the file's first line still carries the version the reservation script
handed out, `20260907213447`; production stamped `20260907214827` on apply,
the file is named for that, and its bytes are identical to the recorded
statements - md5 `939a19f890d316a9b3c140805801bbc9` both sides).
Branch `fix/phase-6-deep-dive`.

## What held

Read from production and `origin/main`, not from the handoff:

- both phase 6 migrations (`…161921`, `…164321`) are byte-identical to what
  `supabase_migrations.schema_migrations` recorded (the second differs by the
  file's trailing newline, exactly as its author wrote down);
- every phase 6 file is on `origin/main` (`git cat-file -e`), and production
  served a `ca_sha` on `main` at 21:19 UTC;
- `verify_all()` said `{"checked": 35, "drifted": 0, "unattested": 0}`, the
  cron carried all three calls at `25 4 * * *`, the anchor file carried 36
  lines, one restatement and zero manifest incidents existed;
- the anchor job has run hourly since the merge (four runs, all green, "up to
  date: 35 day(s)");
- `check-main-is-green`: nothing silent; `check-cron-health` over 48 h: 127
  active, 0 critical, 0 idle.

## What did not - four defects, all the same shape

Every one is CLAUDE.md 10.86's: a guard that answers confidently about a
scope nobody stated. Each is fixed at the root, not detected.

### 1. A sanctioned change to an attested day was still a detector plus a human

Phase 6 made a maintenance deletion NOTICED - the verifier raises a critical
incident at 04:25 the next morning - and then somebody hand-writes a row in
`ca_ledger_day_manifest_restatements`, which is how 2026-08-31 was fixed in
`…161921`. That is the "flagged and reconciled" pattern Dan retired from this
programme on 2026-09-06. And nothing guarded the manifest tables at all: any
service-role session could `UPDATE` a sha or `DELETE` a manifest and no row
anywhere would say so.

Now:

- `zz_ca_attested_day_is_restated_del` / `_upd` - statement-level `AFTER`
  triggers on `chip_ledger` with transition tables - restate every affected,
  attested day **in the maintenance transaction itself**, through the writer,
  with `maintenance:<app.ledger_maintenance reason>` as the reason. They do
  nothing unless that GUC is set, which is the only way a `DELETE` or a
  hash-changing `UPDATE` gets past `fn_ca_journal_append_only` in the first
  place, so the hot path pays one GUC read on a code path that has never run
  (`n_tup_upd = 0`, `n_tup_del = 0` since stats reset).
- `zz_ca_manifest_is_restated_not_edited` on `ca_ledger_day_manifests`:
  `DELETE` is refused; an `UPDATE` to any attested field is refused unless it
  comes through the writer; and when it does, **the guard writes the
  restatement row itself** (old sha, new sha, reason, who, application). A
  restatement exists by construction, not by convention.
- `zz_ca_restatement_is_append_only` on the restatements table.
- The writer gained `p_restate_reason`. It refuses to restate a day to zero
  rows - a maintenance statement that would empty an attested day is refused
  whole.

Proved inside the migration by a probe that set the maintenance GUC, deleted
one cold leg from 2026-03-19, checked the manifest changed and the guard had
written exactly one restatement with the right old and new sha, then rolled
the subtransaction back - and asserted afterwards that the manifest, the
restatements and the leg were all exactly as before. `ca_ledger_mutation_log`
holds no probe row; `ca_drift_incidents` holds no probe incident.

### 2. The verifier was still linear in a journal kept for ever

#3463 turned one scan per day into one pass over the table and called the
cost flat. It is flat in days. It is linear in the journal, which Dan ruled
the same day is kept for ever, and which grew 263,705 legs on 2026-09-06.

| measurement                                         | value     |
| --------------------------------------------------- | --------- |
| one-pass verifier, 04:25 (from #3463)               | 11,683 ms |
| the same, 21:19 UTC under ordinary evening load     | 53,513 ms |
| the cron role's `statement_timeout`                 | 2 min     |
| a per-day read (24,107 legs of 08-30), before       | 30,124 ms |
| the same read after `idx_chip_ledger_created_at`    | 1,558 ms  |
| distinct days in the journal, loose index scan      | 124 ms    |
| the new rotation, all 35 days, 21:49 UTC under load | 49,675 ms |

The per-day number is the root: `chip_ledger` had no index on `created_at`
alone, so every per-day read - the daily writer included - was planned as a
filter over the whole `(club_id, created_at)` index. The index was built
`CONCURRENTLY` at 21:31 UTC (41 MB, valid, no write blocked; a plain
`CREATE INDEX` would take a `SHARE` lock against the engine's 8 s
`lock_timeout`) and is recorded in the migration with `IF NOT EXISTS`.

With it, the verifier re-reads days on a **rotation under a wall-clock
budget** (60 s default, half the timeout): least-recently-checked first,
`last_checked_at` stamped on every re-read, `deferred` counted when the budget
runs out. The nightly cost is bounded by the budget, not the journal. What
replaces the cliff is a number: `oldest_check_age_days` travels with the
answer, and a **warning** (not critical - nothing has drifted) incident
`manifest-rotation-stale` fires past 30 days. Basis: the whole journal
re-reads in one night today, so 30 days is thirty-fold headroom, and when it
fires the decision - a bigger budget, or a longer rotation - is Dan's, made
on a number rather than on a job that quietly died.

Coverage is still checked every night, in O(days): `fn_ca_ledger_finished_days()`
is a recursive loose index scan shared by the backfill and the verifier, so
"which days exist" has one definition.

The daily protection does not weaken. Defect 1's trigger catches a sanctioned
change the moment it happens, and an unsanctioned change cannot happen
(`fn_ca_journal_append_only`). The rotation is the net under that, and it now
says how wide its mesh is.

### 3. A day was whatever the caller's TimeZone said it was

`created_at` is `timestamptz`; every `::date` and `>= p_day` in these
functions was evaluated in the session's TimeZone. The server is UTC and no
role overrides it, so nothing has gone wrong - but a caller with a different
TimeZone would have hashed different rows into the same day, raised a false
critical, and after defect 1's fix written a false restatement. Every function
here now carries `SET timezone = 'UTC'`, and the migration reads
`pg_proc.proconfig` to prove it (the catalogue spells it `TimeZone=UTC`,
which the first apply attempt learned the hard way; nothing was committed).

### 4. The anchor's append path had never worked

The "Commit the new lines" step pushed with `GITHUB_TOKEN` and ran
`gh pr create`. A push with `GITHUB_TOKEN` emits no `push` event, so
`agent-open-pr.yml` never saw the branch; and `gh pr create` needs a setting
the refresh job in the same file says is off. **github-actions[bot] has
opened zero pull requests in this repository, ever** (search API,
`author:app/github-actions`). So the first day after the 35 an agent pushed
by hand would have gone to `chore/anchor-ledger-days` and stayed there, for
ever, while the job stayed green: an anchor that never advances, reporting
success. The 04:25 run tomorrow would have been the first.

It now mints the estate's App token exactly as `agent-open-pr.yml` does and
pushes with that, so the branch takes the same route to `main` as every other
change here (agent-open-pr opens, agent-autopilot merges). A fall-through to
`GITHUB_TOKEN` is now a red step with an `::error` naming the two settings,
not a green notice.

Also in the script: PostgREST caps one response at 1,000 rows - one line a
day, under three years - after which every later day would silently never be
anchored. It now sends `Prefer: count=exact`, reads `Content-Range`, and
refuses a truncated answer. Run against production after the change: "up to
date: 35 day(s) anchored, nothing new", exit 0.

## Two things noticed and left as they are

- The anchor job runs on **both** of the workflow's crons (hourly and daily),
  not "the 05:20 schedule" the phase 6 text says, because unlike `refresh` it
  has no `if:` skipping the hourly one. Hourly is the better cadence for an
  alarm; the comments and README now say so.
- `Schema Manifest Refresh`'s own `refresh` job has the same PR-creation gap
  (its branch `chore/schema-manifest-refresh` has never had a pull request
  either). Another lane's surface; noted here, not changed.

## Live now

```
verify_all() -> {"checked": 35, "drifted": 0, "deferred": 0, "unattested": 0,
                 "never_checked": 0, "oldest_check_age_days": 0,
                 "budget_ms": 60000, "ms": 49675}
functions      fn_ca_ledger_day_manifest(date, text)   writer + restatement mode
               fn_ca_ledger_day_manifest_backfill(date)
               fn_ca_ledger_day_manifest_verify_all(integer)
               fn_ca_ledger_finished_days()
               fn_ca_attested_day_is_restated()        trigger
               fn_ca_manifest_is_restated_not_edited() trigger
               fn_ca_restatement_is_append_only()      trigger
               all SECURITY DEFINER, search_path pinned, timezone pinned,
               none executable by anon or authenticated
index          idx_chip_ledger_created_at, 41 MB, valid
cron           unchanged: manifest(); backfill(); verify_all();  25 4 * * *
manifests      35, all last_checked_at = 2026-09-07 21:49 UTC
restatements   1 (2026-08-31, from phase 6)
incidents      0 manifest incidents
```

Pinned by ten new assertions in
`tests/an-attestation-nobody-re-reads-is-a-photograph.law.test.ts` (27 total).

## Still open, and not phase 7

Unchanged from the phase 6 handoff: 364.80 owed to three tournament winners
pending Dan's bubble-protection decision; the one unbanked raked hand
(`56d12749`, 7.50); idempotency keys on 0.08% of legs; partition cut stages
2-5.
