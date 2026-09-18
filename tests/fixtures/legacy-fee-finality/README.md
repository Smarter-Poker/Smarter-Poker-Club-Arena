# Original player finality with unresolved fee custody

This bounded successor covers exactly five named legacy events (365 fee chips)
and three separately named PKOs (324 fee chips). The immutable raw-source
fingerprints and exact amounts are checked again by the database. Player
finality uses the existing cash and bounty payers. Fees remain counted once in
the existing tournament escrow; no spendable revenue, bank receipt, commission
or full weekly-accounting certification is invented.

The version 3 terminal is explicit: final player results, incomplete accounting,
original custody identity, zero player prize/bounty banks and nonzero held fees.
The original terminal stays immutable if actual original agreements are later
recovered. That continuation uses the existing capture and rake owner, with a
private same-transaction admission, canonical recognition and deferred atomic
proof. Caller settings cannot authorize it. Breakfast's optional original
standings witness is preserved and compared with its immutable authority.

Run `scripts/dev/test-full-weekly-accounting-activation.sh
--legacy-fee-finality-only` with the maintained PostgreSQL 17 fixture inputs.
This selects one bounded phase of the existing full-schema runner. The default
required accounting run includes the same phase. No production database is
used. Every tested financial action uses normal triggers and original owners.

Original raw fee JSON is lossless PostgreSQL text. Do not parse and reserialize
it through binary floats: numeric scale inside nested JSON participates in the
original fingerprint. The PKO packet also preserves 216 recorded charges and
109 existing canonical batch/source documents. Player standings, prizes and
original local agreements in the five-event continuation scene are explicitly
synthetic. They prove transaction behavior, not the truth of production ranks
or missing production agreements. The three PKOs remain unresolved in this
qualification; their missing original terms are not invented.

The native phase reproduces the former fee refusal, verifies player rollback,
late custody/recognition faults, concurrent first closes, duplicate replay,
application access and append-only/truncate controls, existing weekly refusal,
and the actual supply-reader expression. It feeds eight unresolved and five
resolved real PostgreSQL receipts into the maintained engine decoder.

`build-candidate.py --check` verifies the reserved migration composition from
captured exact dependency preimages. `--postimages PATH` also emits source
postimages for independent composition; that file is not installed evidence.
The qualification writes the actual native catalog, tested source hashes and
logs. Deploy the compatible engine decoder before the database may emit v3.
Protected PR checks, migration installation/readback and production behavior
remain separate from this fixture. MTT owns the production operation.
