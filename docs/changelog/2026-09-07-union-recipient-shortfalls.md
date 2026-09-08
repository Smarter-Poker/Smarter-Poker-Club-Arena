# Union periods remain incomplete while recipients are unpaid

The cascade checked round amounts and payee counts but did not require a shortfall counter, and marked the period settled even when a round reported unpaid recipients. The due runner separately treated a missing counter as zero.

The original cascade now requires numeric shortfall evidence from both later rounds. After recording their durable progress it returns incomplete if either reports a nonzero counter, before marking the period or issuing completion statements. The due runner accepts an explicit JSON numeric zero only. Existing payment amounts, idempotency and authorization remain.

Original-function reproduction showed an unpaid recipient marking the period settled. Candidate and installed rollback probes passed both later rounds, missing/null/string counters, completed retry and due recognition, alongside prior invoice and exact-conservation cases. Payment, invoice, permission and clock helpers were stubbed. No historical payment or period row was changed.

Applied migration: 20260907224856. Historical status reconciliation, older-period retry coverage, enabled invoice attribution and full journal/account conservation remain separate audit work.
