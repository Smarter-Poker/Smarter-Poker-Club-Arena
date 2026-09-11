# D9 private legacy finish evidence

Two owner-only read-only functions qualify the actual persisted legacy hand receipts and return exact standings evidence. They neither complete tournaments nor transfer money. The shared pure validator is JSON validation only: it does not grant authority to caller-supplied facts.

The captured 28-case cohort contains 67 players and 440 succeeded receipts. Twenty-five events qualify; three refuse a positive return after an earlier zero: `097e3601-ccf9-4035-af40-eb35068d2652`, `44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa`, and `95e43b6e-c1c9-445e-a1d9-cbe711e3bac1`. All remain in the cohort. Of the qualified events, three are satellites and must use the canonical satellite financial authority; eleven are spins and eleven use cash places. The fourth satellite is the refused `097e3601` case. Earlier classification used `variant=sng`, which obscured these actual satellite types.

`9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8` has an accepted final winner stack of 900 while its player mirror records 300. The helper exposes that mismatch. Ordinary completion must refuse it until exact adjudication. The eleven truly unfinished cases and the separately paid `f370585d` case from the earlier 40-event inventory remain outstanding; this narrower 28-case proof does not remove them.

Run `python3 scripts/ci/rehearse-d9-legacy-witness.py`. It starts an isolated Unix-socket-only PostgreSQL17 cluster, imports the preserved genuine schema and current matched financial definitions, seeds scoped observed evidence, runs tests with origin triggers, then stops its own cluster. Identity-only auth rows satisfy restored schema dependencies; no financial function is replaced with a stub. Replica mode is used only for fixture restoration, never for witness or negative probe execution. Installed seven-disabled-guard state is preserved here; subsequent D12 integration requires its own proof.

Native receipt: 521 source function bodies and 293 trigger definitions/states match the preserved current readback; all440 receipts qualify; 21 hostile JSON probes and17 native event probes pass. Every event probe runs with origin triggers inside a rollback transaction. Twenty application table hashes remain identical, and every historical elimination sequence remains NULL.

Both functions are SECURITY DEFINER, owned by postgres, with EXECUTE revoked from PUBLIC, anon, authenticated and service_role; exact proconfig is `["search_path=pg_catalog, public, pg_temp","TimeZone=UTC"]`. The pure validator is immutable and its prosrc MD5 is `0be7ce46c91572336ee97c80e827428d`.

Persisted `settlement_idempotency_keys` rows have no append-only trigger in the captured catalog. Their exact source hashes must therefore be sealed into immutable finish evidence under the existing finish/settlement locks and rechecked before authority executes. A valid source-byte mutation changes the basis hash; an invalid mutation refuses. This preview proof does not claim the integrating authority race test has passed. Root owns that next integration and normal financial rehearsal.

Source base: `5a550b6343f613a7134011b41d69cdad613642f7`. Migration reserved through the normal allocator: `20260911163920_accepted_tournament_settlement_facts.sql`.

Archive SHA256: `8362576de367577effe686496138192d868454b33ba215f153167469876eff7c`. Manifest SHA256: `375601b1c159f2fa182a076137bc49947a6481efc20e4f7d0813caf883a988c2`.

No production data, schema, settings, wakes or payouts were written.
