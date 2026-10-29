# Approved agent adjustment qualification

Run `native.py --pg-bin PATH --scratch EXTERNAL_SCRATCH --output RESULT_JSON` against an isolated PostgreSQL 17. It creates its own local cluster and removes it after completion. It cannot connect to production.

The fixture preserves current captured columns and checks for agents, clubs, chip_ledger and ca_manual_adjustments. It executes current declaration, enrichment, wallet alias synchronization, cashier actor guard, actor foreign key/trigger, ledger-key claim, balance/leg tallies, deferred refusal and the complete audit reader. The standalone approval executor and exact migration are exercised, including failure rollback and concurrent retry. Actor authorization is a null-JWT PostgreSQL session, matching the intended operator. No synthetic JWT is used.

External foreign keys other than performed_by and unrelated business notification/report triggers are not recreated. The external refusal recorder is controlled to avoid a network side effect; the actual invariant still raises. Maintenance state and epoch are isolated fixture rows. These limits do not constitute production permission or financial acceptance. The operator must prove the installed bytes and run the correction in a transaction that rolls back before committing the verified result.

Approved past-earned credits can settle into an existing suspended agent wallet without changing its status, role or access. Frozen wallets remain refused. The same native runner verifies the exact follow-up installer and the suspended-wallet rollback/conservation boundary.

The earned-commission follow-up installs the captured canonical accounting document trigger, invoice builder, immutable invoice guard, invoice counter and complete delivery owner. It reproduces the old incident-correction failure before the fix, then proves a paid club-to-agent transaction-history receipt, authentic intent, rollback, replay, suspended-wallet credit and refusal if the document trigger is missing. Existing incident-only correction documents remain unchanged. Current owner policy sends non-cashout documents to transaction history only; no Messenger delivery is expected or manufactured.

The native loader also executes genuine original-flow, terminal, satellite, cancellation, launch and freeze guards on this ordinary club-to-agent path. Canonical full cold row types provide unreachable union/fee branches; those branches and their external foreign keys are outside this proof. No actual production account or transaction data is stored in these packets.
