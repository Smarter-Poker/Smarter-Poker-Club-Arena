# Throwable Live Verification Follow-Up

This supersedes the production-execution limitation in the earlier audit after Dan explicitly authorized controlled consumption tests.

## Verified Against Production Functions

All test transactions ended in ROLLBACK. Follow-up reads confirmed the probe account retained 300 diamonds, no VIP status, no expiry, zero throw usage, zero throw receipts, and zero throwable purchases.

- Paid throw: one diamond, one usage record.
- Same request replay: zero additional diamonds, consumed=false, idempotent=true.
- Reusing a request for a different item: rejected.
- Zero-balance account: Insufficient diamonds, success=false.
- Active VIP: source=vip_monthly, zero diamonds, free_remaining=499.
- Lifetime VIP with an old expiry field: unlimited=true, zero diamonds.
- Feature purchase: one diamond grants one credit; replay charges zero and grants nothing extra; a throw consumes that credit without another debit.
- Expired VIP with a null tier initially failed as Unknown User. The deployed migration changes the two nullable lifetime comparisons to IS NOT DISTINCT FROM, preserving the rest of the live function. Repeating the test succeeds via the normal one-diamond fallback.

Migration 20260907193905_throwable_expired_vip_null_tier was applied successfully to PokerIQ-Production and this file mirrors that exact recorded migration. CLI discovery could not complete because network approval was cancelled; the filename comes from the applied database history, not an invented timestamp.

The separate 499-row boundary fixture was rejected by automatic review. It was not run. A rate-limit probe did not reject the later call; transaction elapsed time prevents treating that sequence as a controlled sub-1500-ms timing test. No claim of concurrency/cooldown proof is made.

## CI Follow-Up

PR #3494's production build and CSS browser suites passed. CI identified two concrete follow-ups: Close Throwables must be Title Cased, and the discarded-error-read baseline for ThrowableService must decrease from one to zero. Both are corrected in this commit. The baseline is tightened, not relaxed.

Authenticated browser checkout and all remaining art/sound phases are still separate unfinished work. Live RPC verification is not equivalent to full browser-to-broadcast verification.
