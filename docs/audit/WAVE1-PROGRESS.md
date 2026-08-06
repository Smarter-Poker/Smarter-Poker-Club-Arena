# Wave 1 — Money Integrity: Progress Log

Execution log for Wave 1 of the Club Arena Master Spec & Gap Analysis audit
(findings M1–M14). One entry per landed finding. Nothing is marked shipped
here until the change is merged to `main` AND observed in the production
bundle served from `https://smarter.poker/hub/club-arena/`.

---

## M1 — Idempotent cash-out credit (LANDED)

**Merged:** PR #33 -> `main` as `6b56ef4a` (2026-08-06)

**The bug.** `WalletService.unlockFromTable` is the client-initiated cash-out
money mover (reached from CashierPage). It called `atomic_credit_wallet_and_log`
inside a `retryAsync` closure. `retryAsync` retries on timeout and 5xx, and a
Postgres RPC can commit and then have its response lost — so a retry re-applied
the credit. Worst case for a duplicated *credit* is minting chips that were
never locked at a table.

**The fix.** Route through the existing `fn_idempotent_credit_wallet` wrapper
(the DB idempotency framework — `claim_idempotency_key` +
`store_idempotency_result` — was already shipped). The key is generated ONCE,
**outside** the retry closure, so every retry of the same logical cash-out
shares a key and the DB de-duplicates, while a genuinely new cash-out gets a
fresh key. Key generation prefers `crypto.randomUUID()` with a timestamp+random
fallback. The wrapper returns `jsonb { ok, rpc }`, not a bare boolean, so the
result check tests `creditResult?.ok === false` rather than truthiness.

**What was deliberately NOT changed.** `lockForBuyIn` still calls
`atomic_deduct_wallet_and_log` directly. An earlier revision converted it to
`fn_idempotent_deduct_wallet` and all unit tests passed — but a live grant
check showed the inner `atomic_deduct_wallet_and_log` is granted only to
`postgres` and `service_role`, and `fn_idempotent_deduct_wallet` is not
`SECURITY DEFINER`. A client call would have failed permission-denied and
broken every buy-in in production. Buy-in deduction is engine-owned; the
right home for buy-in idempotency is the server path (`atomic_table_buyin`),
which is tracked separately. The reasoning is recorded in a comment at the
call site so nobody "fixes" it back.

**Also in this change.** Repaired a pre-existing broken mock in the
`internalTransfer` test, which resolved `{ error: null }` with no `data` and so
failed against the real `fn_wallet_type_transfer` contract.

**Gates run:** `tsc --noEmit` 0 errors; `vitest` 14/14 on WalletService;
`check-phantom-tables` 0 phantoms against a live 744-table / 1630-function
manifest (which is itself the proof that `fn_idempotent_credit_wallet` exists
in production); `check-phantom-columns` 0; `check-stranded-writers` 0.

---

## Verification method for this wave

The CI invariant gates resolve every `.rpc()` call against a live manifest
pulled from the production database, so a passing `check-phantom-tables` is
positive evidence the target function exists — not just that the code compiles.
Production presence is then confirmed by grepping the served entry chunk under
`/hub/club-arena/assets/` for the new RPC name. Per CLAUDE.md §1.4, nothing is
described as deployed before that.

Four audit findings (S4, S5, S6, M13) were cleared as false alarms by the same
verify-live-first discipline, and it is what caught the
`fn_idempotent_deduct_wallet` permission trap above before it shipped.
