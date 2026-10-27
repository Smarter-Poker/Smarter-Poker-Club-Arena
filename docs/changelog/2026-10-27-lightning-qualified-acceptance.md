# Lightning decision integrity at the controller door

Lightning now rechecks the existing Phase 8 and Phase 10-13 release authorities after think time, before both an ordinary action and a fast-fold reservation. Withdrawn, stale or mismatched authority selects its original reference action and updates the existing execution witness. Usable authority preserves the candidate. Existing Phase 14 and feature checks remain in the same acceptance path.

The action owner now retains the controller acceptance callback as authoritative if the controller subsequently throws or returns false. A committed chip mutation is finalized once; it does not become a rejected action or trigger another submission. Pre-acceptance refusal retains the existing remaining-clock and fallback behavior.

The initial real-controller regressions failed for all three demonstrated cases: accepted-then-throw, accepted-then-false and stale PLO4 authority. After repair, the focused exact-acceptance, feature-authority and classic effect suites pass 228 checks, including withdrawal for each variant gate, fast-fold withdrawal, usable-authority control and exact-once effects. Another 61 host/fold-door checks pass. Root and server TypeScript compilation both pass. Exact commands and logs are retained in the task evidence.

This is a Phase 1 runtime integrity correction. It does not qualify or activate the preserved river model, change fleet seating, or establish live delivery.

The corrective-kernel and catastrophe-guard runtime digests now bind the new acceptance helper. Mutation-sensitive checks fail without these entries and pass after the correction; no qualification plan or protected selection was restamped. Existing execution-witness receipts remain the ledger owner.
