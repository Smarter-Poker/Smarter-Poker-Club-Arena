# tests/an-attestation-nobody-re-reads-is-a-photograph.law.test.ts

`ca_ledger_day_manifests` hashes each day of `chip_ledger`, and until
2026-09-07 nothing ever re-read it: `fn_ca_ledger_day_manifest` only examines
`CURRENT_DATE - 1`. The attestation for 2026-08-31 had been wrong for six days -
56,893 rows attested, 56,327 present - because 566 legs were removed through the
sanctioned maintenance path ten hours after the manifest was written, and zero
manifest-mismatch incidents had ever been raised. Every retained day is now
re-read daily by the cron that already existed; the verifier hashes exactly what
the writer hashes; a day that legitimately changes is RESTATED with its old sha
kept, and the migration refuses to restate a difference `ca_ledger_mutation_log`
cannot account for; and the sha is anchored in git
(`docs/attestation/chip-ledger-days.tsv`), append-only, where the script FAILS on
an unexplained change instead of rewriting itself to match the database.

Extended 2026-09-07 by the deep dive over that work, which found the same shape
one level up: the verifier walked the MANIFESTS, so 27 days of legs with no
manifest (2026-03-19..2026-08-29, 176,140 legs, 8.8% of the journal) were
outside every guard while it returned `{"checked": 8, "drifted": 0}`; it opened
one sequential scan per day, so its cost grew with a retention Dan had just made
permanent; and the anchor's failure - the loudest signal here - had no reader of
its own, only a red job in a scheduled workflow. So the law now also pins that
coverage follows the JOURNAL (`fn_ca_ledger_day_manifest_backfill`, no third
copy of the hash expression), that the recompute is ONE pass and the per-day
loop cannot come back, that the answer carries what it could NOT check
(`unattested`), and that the anchor raises and closes a named issue of its own.

Extended again the same evening by the deep dive over both of the above
(migration `the_attestation_restates_itself_and_never_outgrows_its_budget`):
a sanctioned maintenance change to an attested day now RESTATES the manifest
in its own transaction through the writer (statement-level triggers on
`chip_ledger`), the manifest tables refuse a hand edit or a delete and the
guard writes the restatement row itself; `chip_ledger` has an index on
`created_at` (a per-day read was 30 s without it); the verifier re-reads days
on a rotation under a 60 s wall-clock budget instead of one pass over a
journal kept for ever (53 s under load against a 2-minute timeout), and its
answer carries `deferred` and `oldest_check_age_days`; every day boundary is
pinned to UTC; and the anchor's append step pushes with the estate's App
token, because github-actions has opened zero pull requests here and the line
would never have reached main.
