# Rebuy uses shared receipts with validated amounts and scoped ledger settings

2026-09-08

An earlier rebuy implementation accepted an existing key without proving its table or committed result. A 46-case isolated candidate reproduced this and provided a dedicated receipt. The production hash guard then refused that candidate because another change had already moved entry purchases to shared entry_purchase_idempotency_receipts. No part of the superseded migration applied. Candidate commit 761666754 remains unpublished for evidence.

This change builds on the shared receipt mechanism. The public wrapper and private rebuy core now require a player, table, purchase key and finite positive whole-cent amount. The private core preserves and restores money-path and ledger category/counterparty/entity/tournament settings, and clears unrelated tournament context during the debit. A direct legacy-key conflict cannot fabricate a successful core result. Shared receipt helpers, entry maintenance ordering, authorization and numeric return type are preserved.

The browser checks for a finite nonnegative numeric result before clearing its retry key or announcing success. It retains the key on an unconfirmed response and no longer claims that no chips were taken when the response is unknown.

Validation: 46 isolated PostgreSQL cases against the shared wrapper/core/helpers passed, including scope binding, replay, key cleanup, seat departure, immutable receipt changes, concurrent attempts and 25 injected wallet/journal/entitlement/history/receipt-completion failures. All preceding 395 database cases passed. The same browser patch passed 25 existing client laws, TypeScript and a production build before transfer to this branch; it applied cleanly.

No competing receipt table or new watcher/reconciler is introduced. Historical balances and ambiguous old keys are not guessed. The browser key still lives in memory, so reload persistence and the existing pending-addon delivery lifecycle remain open audit items; complete cash-hand crash recovery is also still outstanding.

Production verification: migration 20260908131745 applied successfully, and the uncommitted filename was aligned to that authoritative record. Wrapper hash 2a05339c9329ce9fcbefbc1ab72901f5; private-core hash 7b987a8d9bc21645b5bf7ba1bde36f85. Shared receipt helpers are unchanged. Public wrapper permissions remain authenticated/service; private core remains owner-only.

Registry wiring: migration 20260908133232 registers the audited private core without widening grants. The exact reviewed hash and owner-only access are checked before the insert and verified afterwards. The broader audit checkpoint is docs/audits/2026-09-08-chip-audit-checkpoint.md.
