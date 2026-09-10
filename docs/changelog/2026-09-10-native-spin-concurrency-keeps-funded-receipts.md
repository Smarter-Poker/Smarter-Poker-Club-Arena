# Native Spin concurrency keeps funded receipts

The current immutable draw wrapper and native accounting dependencies now have observed overlapping-session evidence. A changed-rule request waits behind the original draw and returns its exact receipt; concurrent exact retries also preserve one draw receipt, two reserve rows, two Spin journal legs and one rake row.

Two different events also compete for one scarce reserve. Three actual entry bookings contribute 8.28 and one actual prior five-chip draw leaves 3.28, below the four chips needed by the two pending launches. The second event is observed blocked by the first. One funds two chips; the other refuses with `P0404/no_eligible_tiers`. The reserve remains 1.28, with no loser draw receipt or draw journal. The complete financial state matches the first committed snapshot after refusal and after both exact retries.

All money, receipt, lease, reserve and RNG functions are native. No balance rewrite, stub or disabled runtime guard creates scarcity. Opening paid-entry evidence remains a synthetic fixture input. Exact current schema and owned 9301/9401/9501 fixture events are retained in the exclusively allocated local `full_stage1` database for subsequent acceptance; no cleanup or production change occurred.

The first scarcity run hit the correct refusal but exposed a harness-only psql `-c` versus script exit-code assumption. The complete proof was repeated on fresh IDs with the owner snapshot retained. Exact source provenance, counts and logs are in `docs/audits/2026-09-10-spin-native-concurrency-evidence.json`.

Remaining boundaries are final winner/terminal settlement against current M5 authority parity, coordinated production adoption and the other Phase 3 controls. Re-read: yes. Native concurrency assertions and `git diff --check` pass. No runtime or TypeScript changed.
