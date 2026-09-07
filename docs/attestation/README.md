# The ledger attestation, anchored outside the database

`ca_ledger_day_manifests` holds one row per day of `chip_ledger`: the row
count, the chain-sequence range, the net amount and a sha256 over that day's
legs. It is a good attestation, and on its own it proves nothing to anybody who
does not already trust the database it is stored in (roadmap 9.2).

`chip-ledger-days.tsv` is the same lines, in git. A different owner,
content-addressed history, and a record Supabase cannot rewrite.

## The file is append-only, and that is the whole point

A day already anchored is never rewritten. `scripts/ci/anchor-ledger-days.mjs`
runs from `.github/workflows/schema-manifest-refresh.yml` on the schedules that
workflow already had - daily at 05:20 UTC and hourly at :40, so the first run
after the 04:25 manifest cron carries the new day and an unexplained change is
seen within the hour (no new scheduled trigger, CLAUDE.md 10.85) - and:

- appends a line for any day not yet anchored;
- **fails** if a day this file already carries now hashes differently in the
  database and no restatement explains it.

That failure is the alarm. It means the journal for an already-attested day
changed with nothing recording why, which is either a change made outside the
sanctioned maintenance path or a change nobody wrote down.

## When a day legitimately changes

Sanctioned maintenance CAN change history - it goes through
`app.ledger_maintenance` and every old row is preserved in
`ca_ledger_mutation_log`. When it does, the manifest is restated **by the same
transaction**: statement-level triggers on `chip_ledger`
(`zz_ca_attested_day_is_restated_del` / `_upd`) re-attest every affected day
through `fn_ca_ledger_day_manifest(day, 'maintenance:<reason>')`, and the guard
on `ca_ledger_day_manifests` writes the row in
`ca_ledger_day_manifest_restatements` - old sha, new sha, reason, who - itself.
Nobody has to remember. A manifest cannot be edited or deleted by hand, and an
attested day cannot be emptied (the maintenance statement is refused whole).
The anchor then appends a NEW line marked `restated` and leaves the original
line untouched, so the file carries both what was attested and what replaced
it.

Every day is also re-read from the journal on a rotation:
`fn_ca_ledger_day_manifest_verify_all()` re-reads the least-recently-checked
days for up to 60 s each night, stamps `last_checked_at`, and reports
`oldest_check_age_days` (a warning incident past 30 days). Measured 2026-09-07:
all 35 days in 49.7 s under evening load, so today the whole journal is re-read
every night; the rotation is what keeps that true as the journal grows.

**Never edit a line in this file to make a check pass.** If nothing explains a
difference, the answer is an investigation, not an edit.

## Why this existed to be found

On 2026-09-07 the eight retained days were recomputed for the first time. Seven
matched to the row. **2026-08-31 did not** - 56,893 rows attested, 56,327
present - and it had been wrong since 2026-09-01 14:34, when 566 legs were
removed through the sanctioned path, ten hours after the manifest was written.
Nothing noticed for six days, because `fn_ca_ledger_day_manifest` only ever
examines `CURRENT_DATE - 1`. Zero manifest-mismatch incidents had ever been
raised.

The journal was fine. The attestation of it was not, and nothing was looking.

## What an anchored line proves, and what it does not

This matters more now that the file covers days going back to March, which were
anchored months after they happened.

A line proves **nothing about what that day held at the time**. Hashing
2026-03-24 on 2026-09-07 records what the journal says today, not what it said
in March.

What it proves is that **from the moment it is anchored, that day cannot change
without the change being visible** - inside the database by
`fn_ca_ledger_day_manifest_verify_all`, and outside it by this file, which git
owns and Supabase cannot reach. That is the entire claim, and it is the claim
worth having: every leg is kept for ever (Dan's ruling, 2026-09-07), so what
needs guarding is the history not being rewritten later.

## The file is in the order lines were ANCHORED, not in date order

2026-03-19 sits below 2026-09-06, because the older days were anchored on
2026-09-07 when the coverage gap was closed. **Do not sort it.** Append-only is
the property that makes the file evidence; re-ordering it rewrites lines that
were supposed to be untouchable, and the next reader cannot tell a tidy-up from
a cover-up.

## Coverage follows the journal, not the day the cron started

Until 2026-09-07 this file, and the manifests behind it, held **eight** days.
The journal held thirty-five. `fn_ca_ledger_day_manifest` only ever examines
`CURRENT_DATE - 1`, so the twenty-seven older days - 2026-03-19 through
2026-08-29, 176,140 legs, 8.8% of the journal - were attested by nothing, and
the verifier reported `{"checked": 8, "drifted": 0}` without a word about them,
because it walked the manifests and a day without one did not exist to it.

`fn_ca_ledger_day_manifest_backfill()` now attests every finished day the
journal has, the daily job calls it before verifying, and the verifier counts
the days it could NOT check and returns that count beside the drift count. A
day with rows and no manifest raises a critical incident now instead of being
invisible.

If you are reading this because `unattested` came back non-zero: the backfill
did not run or could not write. Start with the 04:25 job's last run.
