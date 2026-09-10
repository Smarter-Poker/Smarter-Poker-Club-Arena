# Native Spin draw rollback and replay

The direct Spin draw probe previously proved replay after play but did not force a failure after real entry, rake, draw journal, reserve receipt and escrow writes. It now injects that late failure, verifies the complete financial snapshot is restored, removes the fault, and retries the same event through the actual payment functions.

The probe passes on PostgreSQL 17.11 with the exact saved current `fn_spin_book_entry`, `fn_spin_settle_game` and `fn_spin_draw_and_settle` bodies and real ledger/reserve/escrow triggers. It verifies one successful booking, the same four immutable evidence IDs on replay after stack redistribution and a vacated seat, unchanged financial state, and refusal of caller-defined economics or a new draw with played starting stacks.

Only the fault trigger is synthetic. The money authorities and their accounting triggers are not replaced with stubs. The three current function definitions are installed inside the same rollback-only rehearsal transaction. Their previous hashes, fixture count and absence of the fault trigger are verified afterward.

No application runtime or production database changed. This is native direct-draw evidence, not a claim that final winner settlement, the immutable launch wrapper, release adoption or the complete Phase 3 programme is accepted. Exact provenance and remaining boundaries are recorded in `docs/audits/2026-09-10-spin-native-composition-evidence.json`.

Re-read: yes. Native PostgreSQL proof and `git diff --check` pass. No TypeScript changed.
