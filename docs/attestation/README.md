# The ledger attestation, anchored outside the database

`ca_ledger_day_manifests` holds one row per day of `chip_ledger`: the row
count, the chain-sequence range, the net amount and a sha256 over that day's
legs. It is a good attestation, and on its own it proves nothing to anybody who
does not already trust the database it is stored in (roadmap 9.2).

`chip-ledger-days.tsv` is the same lines, in git. A different owner,
content-addressed history, and a record Supabase cannot rewrite.

## The file is append-only, and that is the whole point

A day already anchored is never rewritten. `scripts/ci/anchor-ledger-days.mjs`
runs daily from `.github/workflows/schema-manifest-refresh.yml` (its existing
05:20 UTC schedule, after the 04:25 manifest cron - no new scheduled trigger,
CLAUDE.md 10.85) and:

- appends a line for any day not yet anchored;
- **fails** if a day this file already carries now hashes differently in the
  database and no restatement explains it.

That failure is the alarm. It means the journal for an already-attested day
changed with nothing recording why, which is either a change made outside the
sanctioned maintenance path or a change nobody wrote down.

## When a day legitimately changes

Sanctioned maintenance CAN change history - it goes through
`app.ledger_maintenance` and every old row is preserved in
`ca_ledger_mutation_log`. When it does, the manifest must be restated: a row in
`ca_ledger_day_manifest_restatements` recording the old sha, the new sha and
the reason. The anchor then appends a NEW line marked `restated` and leaves the
original line untouched, so the file carries both what was attested and what
replaced it.

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
