# 2026-09-07 - An attestation nobody re-reads is a photograph, not a guard

Phase 6, roadmap 9.2. The roadmap's complaint is that the daily ledger manifest
is stored in the same database as the journal it hashes. True, and measuring it
first found something sharper, live right now.

## The attestation for 2026-08-31 had been wrong for six days

All eight retained days were recomputed for the first time:

| day            | manifest rows | actual rows | delta    |
| -------------- | ------------- | ----------- | -------- |
| 2026-09-06     | 263,705       | 263,705     | 0        |
| 2026-09-05     | 225,648       | 225,648     | 0        |
| 2026-09-04     | 392,608       | 392,608     | 0        |
| 2026-09-03     | 527,563       | 527,563     | 0        |
| 2026-09-02     | 169,076       | 169,076     | 0        |
| 2026-09-01     | 90,734        | 90,734      | 0        |
| **2026-08-31** | **56,893**    | **56,327**  | **-566** |
| 2026-08-30     | 24,107        | 24,107      | 0        |

Seven of eight matched to the row. One did not, and its sha did not match a
recompute either.

**The journal was fine.** The 566 legs were removed at 2026-09-01 14:34 through
the sanctioned maintenance path - reason
`dan-2026-09-01-deep-stack-clean-funding-redo` - and every one of them is
preserved whole in `ca_ledger_mutation_log`. The append-only guard did exactly
its job.

What failed was everything after it:

1. `fn_ca_ledger_day_manifest` only ever examines `CURRENT_DATE - 1`. It wrote
   08-31's manifest on 09-01 at 04:25, **ten hours before the deletion**, and
   has never looked at that day again.
2. Nothing restates a manifest when sanctioned maintenance changes a day, so
   the stored sha silently became a description of a journal that no longer
   exists.
3. `ca_drift_incidents` had recorded **zero** manifest mismatches, ever.

The tamper check inside the writer is good - it refuses to overwrite a changed
day and raises a critical incident - but it is wired to exactly one day. A guard
that looks at yesterday and never again cannot see a change to the day before,
which is precisely where a quiet edit would go.

I first blamed the wrong migration for it. `one_movement_one_journal_row`
(09-02) deletes from `chip_ledger` and has a name that fits perfectly - but its
cleanup logged 47 deletions and **none from 08-31**. The mutation log named the
real one.

## What was built

**`fn_ca_ledger_day_manifest_verify_all()`** recomputes every retained day and
raises the existing critical incident for each that drifts. It rides the cron
that already runs at 04:25 - extended, not replaced, and the migration asserts
the manifest write it already did is still there. No new scheduler
(CLAUDE.md 10.85).

**`ca_ledger_day_manifest_restatements`** records a manifest that had to change,
keeping the old sha and count and the reason. A sanctioned change to history now
leaves the attestation corrected rather than silently wrong - roadmap 9.3's
restatement policy, in the one place it was already needed. The migration
**refuses to restate a difference the mutation log cannot account for**: it
aborts unless the missing rows are exactly the rows the log says were removed.

**2026-08-31 was restated** on those terms: 56,893 -> 56,327, all 566 reconciled
against the log, with the old sha kept. All eight days now verify clean.

**The sha is anchored outside the database.**
`docs/attestation/chip-ledger-days.tsv` carries one line per day in git - a
different owner, content-addressed history, a record Supabase cannot rewrite -
appended daily by `scripts/ci/anchor-ledger-days.mjs` on
`schema-manifest-refresh.yml`'s existing 05:20 UTC schedule, after the 04:25
cron. No new scheduled trigger anywhere.

The file is append-only and **the comparison is the point, not the copy**. A day
already anchored is never rewritten. If the database reports a different sha for
an anchored day, either a restatement explains it - and a new line is appended
beside the old one - or the script fails and says so. Proved both ways before
shipping: a second run is a clean no-op, and a tampered line exits 1 naming both
shas and telling the reader to read the mutation log rather than edit the file.
