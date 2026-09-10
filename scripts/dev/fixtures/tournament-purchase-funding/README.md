# Tournament Purchase Funding Rehearsal

Run `python3 scripts/dev/probe-tournament-registration-funding-pg17.py --purchases-only` for these 13 groups. The default runner includes both the seven registration groups and these purchase groups. It creates and stops its own PostgreSQL 17 cluster, accepts no database URL and uses CI's existing pinned pg client when PGNODE is set.

This fixture reuses the registration and satellite-refund funding fixtures. It adds 33 captured installed functions, six catalog table shapes and 23 actual contract triggers for the public purchase RPC, money core, knockout-generation checks, seat assignment and receipt. Each fresh case checks the installed function body hashes against the manifest. Successful purchases bind the wallet debit, journal, immutable entitlement, escrow, table stack, roster stack, generation, wake and operation receipt. Retry/failure checks compare a fingerprint of all rows in the 15 relevant write relations.

The scenarios cover rebuy, re-entry and unraked add-on funding; final receipt failure; real overlapping same-token and competing-token transactions; a funded replacement for a vacated seat; successive knockout/seat generations; historical-token replay after a later bust; the re-entry count cap; live/paid player refusal; level and timed cutoffs; missing or contradictory accepted-hand evidence; insufficient funds; add-on expiry; and rebuy prompt, format and count eligibility. An open add-on period legitimately extends the rebuy window, so cutoff fixtures close that period too.

## Limits

This is an isolated contract rehearsal, not a full production-schema clone. Initial registration uses the real funding path. Accepted hand/settlement records and initial table/seat state are synthetic inputs; the real hand-commit writer is not run. A legacy eliminated entrant with an existing zero chair and a normally vacated chair are both exercised. Subsequent simulated eliminations vacate the chair, preserving the installed deferred roster/seat constraint.

Auth identity, session liveness, engine identity and maintenance state are synthetic. The three bounty read relations are empty shapes: bounty payment execution and a funded bounty re-entry are not certified. Foreign keys to excluded parent programmes, notification/reporting/membership guards, full HTTP/RLS, union funding, table expansion, engine consumption of a grant, and accepted-hand settlement racing the grant remain separate acceptance boundaries. The captured public RPC still checks its real bounty-completion predicate; no replacement money or seat writer is invented.

No production data is copied and no production financial writes occur.
