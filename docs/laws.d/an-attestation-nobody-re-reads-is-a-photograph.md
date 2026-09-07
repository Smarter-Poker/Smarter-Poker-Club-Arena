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
