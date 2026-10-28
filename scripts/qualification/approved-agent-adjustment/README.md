# Approved agent adjustment qualification

Run `native.py --pg-bin PATH --scratch EXTERNAL_SCRATCH --output RESULT_JSON` against an isolated PostgreSQL 17. It creates its own local cluster and removes it after completion. It cannot connect to production.

The fixture preserves current captured columns and checks for agents, clubs, chip_ledger and ca_manual_adjustments. It executes current declaration, enrichment, wallet alias synchronization, cashier actor guard, actor foreign key/trigger, ledger-key claim, balance/leg tallies, deferred refusal and the complete audit reader. The standalone approval executor and exact migration are exercised, including failure rollback and concurrent retry. Actor authorization is a null-JWT PostgreSQL session, matching the intended operator. No synthetic JWT is used.

External foreign keys other than performed_by and unrelated business notification/report triggers are not recreated. The external refusal recorder is controlled to avoid a network side effect; the actual invariant still raises. Maintenance state and epoch are isolated fixture rows. These limits do not constitute production permission or financial acceptance. The operator must prove the installed bytes and run the correction in a transaction that rolls back before committing the verified result.
