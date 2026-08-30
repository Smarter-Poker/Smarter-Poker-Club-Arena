# Cashier Phase 1: Critical Integrity And Loading Recovery

## What Existed

`fn_agent_wallet_claim_back` accepted arbitrary numeric precision. The player
wallet stores two decimals while the receiving agent wallet stores four, so a
claim for `0.0049` could round the player debit to zero and still credit the
agent. Its retry receipt was also matched by caller and operation ID without
proving the retry still named the same source send.

The Trade page started `loadClub()` in one passive effect and incremented its
request version in a later passive effect. React executes those effects in
source order, so the reset invalidated the request that had just started. Both
the success path and `finally` were discarded as stale, leaving the first tab
on `Loading Members...` indefinitely.

The browser balance triggers installed during the 2026-08-27 production hotfix
were described in a tracked migration whose only executable statement was
`SELECT 1`. A clean database replay did not recreate those protections.

## What Changed

- Claim Back now rejects explicit amounts finer than one cent before reading or
  locking either wallet.
- A null amount means the maximum safe whole-cent remainder. Historical
  sub-cent residue is rounded down, never up, and dust below one cent closes the
  reversal without creating another fractional credit.
- Claim retries are serialized and bound to their original transaction; an
  explicit amount must match the original receipt too.
- The client asks for the server-calculated safe remainder and renders the
  amount returned by the server rather than its stale local estimate.
- Club-scoped state reset and the following load are one ordered effect:
  invalidate old work, clear old state, then start the new request.
- The clean-replay migration now contains the executable invoker-rights
  functions and all three browser balance triggers for member inserts, member
  updates, and club treasury updates.

## Verification

- Rendered React regression: a deliberately delayed membership read clears
  `Loading Members...`, renders the new roster, and keeps Trade selected.
- Focused Vitest: 4 files, 27 tests passed.
- Production migration assertions confirmed the cent guard, replay binding,
  and all three trigger definitions.
- A production transaction-isolated probe produced six PASS results: sub-cent
  refusal, whole-cent success, conserved balances, same-intent replay,
  source-bound retry refusal, and direct browser balance-write refusal. The
  fixture and every movement were rolled back.

Real-time law: not applicable. This phase repairs an on-demand cashier load and
atomic money RPC; it adds no polling, snapshot-diff UX, or table-state event.
