# The red workflows on main get their verdicts (2026-09-30)

A detector that had been muting them was fixed, so six workflows that had been
red on `main` for between one and twenty-one days became visible at once. Four
of them had never been diagnosed. This is what each one is actually saying, read
from production rows and from the runs themselves, and what was done about it.

Two of the six are fixed here. Three are **correctly red** on genuine unfixed
defects and now say so legibly. One, Estate Integrity, belongs to other
repositories entirely, and one, Trusted Money Trigger Recovery, was never a
health signal at all.

---

## 1. Trusted Money Trigger Recovery - NOT a health signal. Every red run is the guard refusing a push

Reported as 11 consecutive failures over ~12.5 days. Every one of those 11 is a
`workflow_dispatch` run, and every dispatch of this workflow is a **one-shot
proof request** for one candidate bundle from one agent's `pre-push`, not a
periodic check. `scripts/ci/check-main-is-green.mjs` filters `branch=main`, which
is exactly the set of runs a dispatch produces, and it never sees this
workflow's real traffic: the `pull_request_target` runs, which report the PR's
own branch. Those are green - 20 consecutive successes on 2026-09-30 alone.

The last red dispatch, run `36283738205` at 2026-09-27T00:51:01Z, was re-run on
2026-09-30 against current trusted `main`, with the same candidate bundle, to
find out which of two things it was. The answer is unambiguous. On the original
attempt it died at `money-trigger-recovery.mjs:13`, which that day was the bare
`requireThat(rows.length === 1, ...)`; on the re-run it reaches
`verifyRecording` at line 77, because PR **#5500** (`9f92886329`, 2026-09-28)
added the recording path. It still refuses, and correctly.

The bundle names one candidate file:
`supabase/migrations/20260927004356_certification_accounts_archive_ledger_actor_before_deletion.sql`,
at head `13d743f645`. Version `20260927004356` is **not in
`schema_migrations`**. Line 77 asks exactly that - is there one applied history
row for this file's own version - and the answer is no, so the file is not a
recording of anything, and a migration that creates a money trigger with no
declaration and no reviewed contract is refused. The same work reached
production the same night under version `20260927032422`, which is on `main`
and applied. The push that failed is a push that should have failed, and its
author already re-versioned it.

**Action:** none. Nothing here is broken. What is misleading is the count: a
dispatch refusal is a successful refusal, and reading 11 of them as "a workflow
red on main for 12.5 days" is a category error in the reader, not a defect in
the guard. The workflow's continuous traffic is the `pull_request_target` half,
and that half is green.

---

## 2. Cron Health - two separate failures, one fixed here, one correctly red

`Cron Health` fails two independent steps, and they want different answers.

### 2a. The roster changed: 121 to 124 active (FIXED HERE)

`scripts/ci/anchor-cron-roster.mjs` compares the `# active:` count in
`docs/attestation/cron-roster.tsv` against `fn_ca_cron_health()`. It refuses
when they differ, and its refusal says to commit the regenerated file and the
new count "in one reviewed change that says which job moved and why". That is
this. Read live 2026-09-30; no previously pinned job changed its schedule.

Four appeared:

| job                                             | schedule          | where it came from                                                                       |
| ----------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `rakeback-settler-stranded-source-check-hourly` | `28 * * * *`      | applied migration `20260927220353`                                                       |
| `horse-stackoff-audit-20m`                      | `7,27,47 * * * *` | applied migration `20260927221321`                                                       |
| `horse-daily-audit-fallback`                    | `30 7 * * *`      | applied migration `20260928000527`, which has **no file in either repo** - see section 5 |
| `midway-close-once-20260929d`                   | `4 13 29 9 *`     | **no migration at all**                                                                  |

`midway-close-once-20260929d` is the interesting one. No row of
`supabase_migrations.schema_migrations` mentions it. It carries the exact
command `union-weekly-rakeback-close` used to carry, as a one-shot for
2026-09-29 13:04 UTC. `cron.job_run_details` says it ran once, on that minute.
Its next fire is 2027-09-29, so it is a spent one-shot still sitting on the
roster. Unscheduling it is its owner's call and will move this number again,
which is the mechanism working.

One left the active set **without vanishing**, which is the case this law was
written for and the case it got right: `union-weekly-rakeback-close` is still
row `jobid 272` of `cron.job`, with `active = false`. `fn_ca_cron_health()`
returns active jobs only, so it dropped out of the file and read as gone. It was
stood down while `20260928164258 a_weekly_close_proves_each_book_once...`
reworked the close; its last run was 2026-09-29 09:00 UTC. That is why
`RETAINED_INACTIVE` moves from 2 to 3 alongside the active count: `cron.job`
now holds 124 active + 3 inactive = 127 rows.

Moved together, as the law requires: the roster body and its two header
counters, `RETAINED_INACTIVE` in `anchor-cron-roster.mjs`, and `ACTIVE_JOBS`,
`RETAINED_INACTIVE` and the total in
`tests/the-scheduled-work-roster-is-pinned.law.test.ts`.

### 2b. A scheduled job ran and never once succeeded (CORRECTLY RED)

Exactly one job is `critical`, and it is real:

**`union-rake-rollup-catchup`** - 42 consecutive failures since
2026-09-29T00:55:01Z, last success 2026-09-28T23:55:00Z. Every run dies with
`canceling statement due to statement timeout` inside
`INSERT INTO union_rake_paid_daily_user ...`. That table's newest `day` is
**2026-09-27**: per-user daily union rake attribution is three days stale and
cannot catch itself up.

The cause is named, not guessed, and it is one line. The job's command is

    DO $body$
    BEGIN
      IF pg_try_advisory_lock(hashtext('union-rake-rollup-catchup')) THEN
        PERFORM set_config('statement_timeout', '600s', true);
        PERFORM public.fn_union_rake_rollup_catchup_all(8);
      ...

`statement_timeout` is armed when a top-level statement STARTS. The `DO` block
is that statement, so raising the timeout from inside it cannot extend the timer
already running over it. The block therefore runs under the `postgres` role's
own setting, `statement_timeout=2min` (`pg_roles.rolconfig`), and the evidence
is exact: every one of the 42 failures lasted `00:02:00.00x`, never the 600s the
command asks for. The contrast is in the same table - `midway-close-once-20260929d`
sets `SET statement_timeout='2700s';` as its own top-level statement before its
`SELECT`, and that works.

It is also self-sustaining, which is why it went from flaky to permanent.
`fn_union_rake_rollup_catchup_all` loops over **every** union with a table or a
club in one transaction. One `DO` block is one transaction, so a timeout rolls
back the whole pass: once one full sweep crossed 120 seconds, no run has
committed anything, and none ever will.

**Not fixed here, and the workflow stays red on it.** The repair is a change to
a production `cron.job` command for a money-attribution job, and it needs a
runtime measurement this task could not take under read-only access. The shape
is: make the budget its own top-level statement (`SET statement_timeout='600s';`
before the `DO`), and bound the per-pass work so one slow union cannot roll back
every other union's progress. Until that lands, `Cron Health` going red here is
the guard doing its job.

Two more jobs are in the same statement-timeout family but still succeed
sometimes, so they are `warn` and not the cause of this run's failure:
`ca-ratchet-watch-hourly` (22 of 24 failed) and
`tourney_money_conservation_hourly` (22 of 24 failed).

The fleet itself is alive - jobs were recording runs seconds before this was
written, so the 2026-08-31 silent-401 shape is not what is happening here.

---

## 3. Schema Integrity Audit - CORRECTLY RED, and it belongs to the grants work

The failing job is `No unaccounted DEFINER writer is reachable from a browser`,
and its live counters are

    anon-executable writers: 0 (must be 0)
    RLS-off writable tables: 0 (0 new)
    anon-readable functions: 15 (1 new)

so the failing assertion is the READER delta, not a writer. The one new finding,
named:

**`public.fn_horse_tag_ev_significance(p_since date)`** - `SECURITY DEFINER`,
`STABLE`, executable by `anon`, and it never asks who is asking. Read live
2026-09-30: it backs **no** RLS policy (`pg_policy` holds no qual mentioning
it), so the "revoking a policy helper denies every SELECT" trap does not apply
to this one.

**Not touched here.** Function grants are owned by the concurrent
SECURITY DEFINER reachability work, and this is handed over with the name, the
signature and the policy-helper question already answered. Issue **#5515**
tracks it.

---

## 4. Estate Integrity - CORRECTLY RED, and the repairs are in six other repos

65 consecutive failures, ~21.5 days, tracked by issue **#3931**. The run reports
`19 problem(s)`, and #3931 already carries a per-file attribution from
2026-09-23 that the audit's own body rewrite cannot destroy. Every one of the 19
is cross-repo file drift - `AGENT-PLAYBOOK.md` in five versions,
`.agents/rules/00-agent-playbook.md` in three, `check-token.sh`, `queue-pr.sh`,
`agent-autopilot.yml`, `agent-open-pr.yml`, `guard-shared-clone.sh`,
`check-unpushed-work.sh`, `check-canonical-clone.sh`, `agent-workspace.sh` - and
Club Arena already holds, or is recorded as the deliberate variant for, each.

Club Arena has no authority over `Smarter-Poker-World-Hub`,
`smarter-poker-commander`, `commander-shared`, `smarter-poker-workers`,
`Smarter-Poker-Diamond-Arena` or `PepNationLab` (CLAUDE.md 1.2). **Nothing in
this repository can make this workflow green**, and weakening the comparison to
get there would delete the only thing that notices a guard fixed in one repo and
not the others. It stays red, and #3931 is the reader.

---

## 5. Applied Migrations Are Recorded - one half fixed, one half is in-flight work

Two steps fail. They are different findings.

### 5a. Nine recordings disagreed with production by exactly one byte (FIXED HERE)

`check-recorded-migrations-evidence.mjs` asks production whether each row of
`scripts/ci/recorded-migrations.manifest.json` hashes to what
`schema_migrations` actually holds. Nine rows failed. Measured, every one of the
nine is off by **one byte**:

| version          | file bytes | production `byte_len` |
| ---------------- | ---------- | --------------------- |
| `20260927231300` | 6556       | 6555                  |
| `20260927231524` | 10831      | 10830                 |
| `20260927231551` | 5748       | 5747                  |
| `20260927231603` | 2288       | 2287                  |
| `20260928001934` | 15880      | 15879                 |
| `20260928031344` | 7426       | 7425                  |
| `20260928033651` | 7690       | 7689                  |
| `20260928133817` | 2058       | 2057                  |
| `20260928134553` | 11151      | 11150                 |

The extra byte is a trailing newline, and the manifest said so in its own words:
each of the nine carried `"recoveredFrom": "array_to_string(..., chr(10)) ||
chr(10), byte for byte"`. That `|| chr(10)` is the defect. The manifest's own
`_how_to_add_a_row` already forbids it - "write those bytes and NOTHING else: no
header, and no newline the database does not already have" - and 27 of the 31
recordings that do end in a newline pass, because production's own statements
end in one. A recording is a claim about bytes; a byte it adds is a byte
production never ran.

Fixed at the root of the artifact: the trailing byte is removed from all nine
files, each now hashes to exactly what `fn_ca_migration_text(version)` returns,
the nine manifest `md5` values are corrected to production's, and the nine
`recoveredFrom` strings no longer describe the `|| chr(10)` that caused it.
`node scripts/ci/check-recorded-migrations-evidence.mjs --offline` is clean.

### 5b. 22 applied migrations with no file - 19 are in flight (CORRECTLY RED)

The run at 13:54 reported `22 of 276 migration(s) applied since 20260923000000
have NO FILE in this repo`. A previous reader called backfilling these
"archaeology". It is not archaeology, and it is also not 22: every one of the 22
was looked for, by version AND by name, across all 778 remote branches of this
repo.

**Nineteen of the 22 have their file, right now, on a branch.** For example
`20260927154806` on `agent/codex-billing-f83d-0927/fix/open-week-request-lock-order`;
`20260927220437`, `20260927220532` and `20260927221228` on
`agent/cowork-claude-league-0927/fix/league-says-when-it-refuses-to-measure`;
`20260928141826` and `20260928141849` on `fix/union-settlement-scale`;
`20260929110440` and `20260929124252` on
`fix/jackpot-share-on-the-felt-is-a-cash-result`. Two of them -
`20260930121500` and `20260930123828` - have merged to `main` since that run.
Backfilling any of these from `statements` would create a second file for a
version another agent is about to merge, which is the collision CLAUDE.md 4.5 is
about. They resolve themselves when their branches land, and nothing should be
done to them.

**Three have no file anywhere, on any branch, in either repo.** These are the
real gap, and the list is short enough to name in full:

| version          | name                                                                    | size                     |
| ---------------- | ----------------------------------------------------------------------- | ------------------------ |
| `20260928000425` | `horse_audit_leak_spike_requires_significance_and_audit_watches_itself` | 6,539 chars, 1 statement |
| `20260928000527` | `horse_daily_audit_fallback_rescues_a_missed_day_loudly`                | 2,505 chars, 1 statement |
| `20260930032343` | `owner_switches_the_fleet_engine_on`                                    | 2,904 chars, 1 statement |

`20260928000527` is the same change that put `horse-daily-audit-fallback` on the
cron roster in section 2a, which is how one unrecorded migration shows up in two
different guards. `20260930032343` is an owner decision about the engine fleet.

**Not written here**, deliberately. Section 5a is a live demonstration that a
single byte decides whether a recording is true, and these three want their
author, or somebody who can read the SQL back through a byte-exact channel
rather than a JSON tool boundary. The recipe is the manifest's own: recover with
`SELECT array_to_string(statements, chr(10)) FROM
supabase_migrations.schema_migrations WHERE version='<v>'`, write those bytes and
nothing else, and prove the file's md5 equals the `md5` column of
`public.fn_ca_migration_text('<v>')` before adding the manifest row.

Until those three land, this workflow is correctly red, and issue **#2630** is
its reader.

---

## 6. Production Integrity Audit, migrations_are_live=1 - CORRECTLY RED, the migration is stale

`20260927160709_a_page_recompute_reads_only_the_evidence_that_changed.sql`
merged to `main` on 2026-09-27T21:43:42Z (PR #5475) and never reached the
database. Read live 2026-09-30: it is absent from `schema_migrations`, and not
one of the 5 functions, 1 table, 3 indexes or 2 triggers it declares exists.

It was never dispatched. The applier is not the obstacle -
`apply-merged-migration.yml` plus `scripts/ci/migration-concurrent-preamble.mjs`
accept exactly this file's shape (a `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
preamble, then one `BEGIN;`/`COMMIT;`), and no `Apply Merged Migration` run ever
named it.

**Dispatching it today would be refused, and the refusal would be right.** Its
own STEP 2.1 precondition asserts

    md5(p.prosrc) = '80f40737e9015888f2b5c4215c383bc5'

for `fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])`, and the live
body hashes to `adea66332439cb1c0071f37ce12165b9`. The calculator is no longer
the body this change was derived from, so the migration would abort with
`PERIOD_CALCULATOR_PREIMAGE_CHANGED` - which is the self-protection working, and
is also why forcing it past that check would be a regression rather than a fix.

Worth recording, because it ties this finding to section 5: the newest recorded
migration that replaces that calculator is `20260927154806`, and its own asserted
`pg_get_functiondef` md5 (`2fffb5add208db1eb1e6b66c9df15220`) does not match the
live definition either (`926b233007ee76b4d8002d454568b1b5`). No row of
`schema_migrations` asserts the body production is running. `20260927154806` is
one of the 19 migrations in section 5b whose file is still on an unmerged
branch.

**The end state is neither "apply" nor "withdraw" on a coin flip: it is
re-derive.** The migration's reasoning and its three indexes are still valid;
its preimage is not. Its author has to recompute the preimage against the
current calculator and re-dispatch. Applying it as written cannot work, and
pretending it can would lose a real 60-second-per-page-call regression that the
migration correctly measured.

---

## What changed in this repository

- `supabase/migrations/20260927231300_*.sql`, `...231524_*.sql`,
  `...231551_*.sql`, `...231603_*.sql`, `20260928001934_*.sql`,
  `...031344_*.sql`, `...033651_*.sql`, `...133817_*.sql`, `...134553_*.sql` -
  one trailing byte removed from each, so each is byte-identical to the SQL
  production applied under its version.
- `scripts/ci/recorded-migrations.manifest.json` - the nine `md5` values
  corrected to production's, and the nine `recoveredFrom` strings corrected so
  they no longer describe the `|| chr(10)` that caused the drift.
- `docs/attestation/cron-roster.tsv` - regenerated body (124 rows), both header
  counters moved, and a header block naming each of the five jobs that moved and
  where each came from.
- `scripts/ci/anchor-cron-roster.mjs` - `RETAINED_INACTIVE` 2 to 3, with the
  reason beside it.
- `tests/the-scheduled-work-roster-is-pinned.law.test.ts` - `ACTIVE_JOBS`
  121 to 124, `RETAINED_INACTIVE` 2 to 3, total 123 to 127, and the argument for
  every move in the docblock.

No guard was weakened, no assertion was relaxed, and no detector, sweep, repair
job or schedule was added.
