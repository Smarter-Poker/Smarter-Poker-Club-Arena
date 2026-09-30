# tests/a-retry-gets-its-first-receipt.law.test.ts

A retry gets its first receipt. Every Diamond money door answers a retry of the
same request with what it answered the first time, word for word, with no
replay marker, and refuses the same key with different parameters by name.
Decided by Claude on Dan's delegation of 2026-09-30 (docs/DIAMOND-RULINGS.md).
The concurrency suite had found three doors answering a retry differently: the
store laid cost 0 and granted false over its stored receipt; the withdrawal
added replayed and idempotent markers and read diamonds_after from the wallet
as it stood at the retry; and the prize payer answered false to a retry, and
false again - paying nothing, naming nothing - to a key reused with another
amount.

`20260930235000` redefines those three doors from production's own text and
edits the payer's one caller, `fn_credit_and_log`, by asserted substitution.
The payer now answers true to a retry and names the key only when it pays, and
`fn_credit_and_log` reads that key, so it still writes the payout evidence
once and answers false to a verified retry. Its callers and the engine read
the same answers as before.

The law pins each door's retry answer, the payer's refusal
`diamond_tournament_pay_key_reused`, the key handed from the payer to
`fn_credit_and_log`, the kept grants, the closing assertions, the four live
proofs, and the concurrency suite's replay rules: every door but the shared
rebuy core answers a retry with its first receipt after the caller's wallet
has moved, and every door refuses a changed payload by name.
