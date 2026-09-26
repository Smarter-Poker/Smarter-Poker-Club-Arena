# A finish the database rolled back is a refusal, not an unknown (2026-09-26)

Engine change in `server/src/tournament/terminalSettlementRpc.ts`; law
`server/src/tournament/aRolledBackFinishIsARefusal.law.test.ts`.

## What happened, read from rows and the postgres log

At 02:30:49 UTC incident 66618f53 opened on 85c5885a (100 Chip Spin PLO4,
300.00 prize), and at 03:03:36 on 66e80c08 (20 Chip Spin PLO5, 60.00). Each had
the same alert: "Tournament completion may have committed but its immutable
receipt could not be resolved. Every table engine was stopped."

The postgres log for 02:29:45 to 02:30:54 shows why. `fn_complete_tournament_terminal`
takes the platform-wide finish lane (`ca:tournament-finish-lane:v1`, which
allows one finish at a time by design). The lane holder, pid 1717451, was itself
waiting on a row lock (`ShareLock on transaction 586862506`) for many seconds.
`authenticator` carries `lock_timeout = 8s`. Every completion attempt behind it
was answered with 55P03, "canceling statement due to lock timeout", and so was
the resolver at 02:30:49.478. That is 122 ms before the alert.

A SQLSTATE response means PostgreSQL rolled that request back. So none of the
five attempts could have committed, and none was still running. The engine
still folded that into "outcome unknown", fenced the manager, and stopped the
event's table engines. Both events finished on their own path at 03:29. The
winners were paid exactly once and escrow closed at exact zero, so the
unknown cost an hour of stopped tables and a critical alert.

## The change

`requestTournamentTerminalReceipt` counts attempts whose outcome the database
did not state. That covers a lost response, a thrown transport error, or a
success whose receipt cannot be verified. The finish becomes a retryable
`TerminalSettlementRefusedError` only when all three of these hold:

- at least one write was attempted;
- every write attempt was answered with a SQLSTATE or PostgREST code;
- the serialized resolver was itself refused with one.

The manager then releases its finish guard and retries on the transient clock,
because `classifyFinishRefusal` maps "canceling statement" to `timeout`. The
terminal authority is idempotent, so a retry that meets a receipt committed by
anyone else adopts it.

Unchanged, and pinned by the existing `terminalSettlementRpc.test.ts` and the
new negative proofs:

- a lost response anywhere keeps the finish unknown;
- a resolver transport failure keeps it unknown;
- a resolver that answers with a mismatched identity keeps it unknown;
- a resolver that reports a commit it cannot verify keeps it unknown.

This does not change the finish lane, the lock timeout or any database function.
The lane holder waiting on a row lock is its own question, and it belongs to the
lane's owners.

## And the rakeback settler: a durable deferral is a deferral, however long it took to arrive

The same PR changes `server/src/services/RakebackSettlerService.ts`; law
`server/src/services/aDurableDeferralIsADeferral.law.test.ts`.

The settler's cursor held at 2026-09-22 18:29:21 from 04:19 UTC, and the engine
log explains it. Every cycle logged `fn_rakeback_recompute_periods failed ...
supabase_timeout; durable receipt not confirmed: request is blocked, not a ready
user-scoped receipt`, followed by `286 period recompute(s) failed ... holding the
watermark`.

While the settler catches up, every page-scoped recompute of the open week is
refused with `cash_source_receipts_incomplete`, because the hands after the page
have no sources yet. The function records that deferral on its request row in
the same transaction.

The two paths treated that deferral differently:

- **Direct response.** When the response arrived inside the 15 s client deadline,
  `readPeriodRecomputeReceipt` accepted it as a durable deferral and the page
  advanced. The weekly close recomputes the whole period later.
- **Read-back.** The blocked path measured 11.2 s idle and 18.9-28.4 s under load
  on 2026-09-26. When the response was lost, the read-back from #5269 refused the
  identical durable deferral.

So the cursor could only move when the database happened to be quick.

`judgePeriodRecomputeReceipt` now returns `deferred` for a row that meets all of
these:

- it is fresh (attempted at or after this call);
- it is `blocked`;
- it carries a request id;
- its receipt is the canonical deferral for exactly that club and week: version 2,
  status blocked, 0 written, a named reason, no error or failure.

The caller counts that row exactly as it counts a direct deferral.

These are still refused, as 11 negative cases in the law and the existing
`rakebackWatermark.test.ts` pins show:

- a stale row;
- an anonymous row;
- a receipt for another club or week;
- a receipt that wrote something;
- a receipt without a reason, or of another version;
- a receipt carrying a failure or an error;
- a receipt another writer cleared;
- a ready receipt on a blocked row.

Negative proof: both new tests fail against the previous
`RakebackSettlerService.ts`.
