# Throwable Pack Expiry

The consumption RPC checked pack expiry against transaction-start time, permitting an expired pack after delay. Selection now uses the current clock, and the credit decrement rechecks expiry after obtaining the row lock. If that pack expired during the wait, selection continues to the next valid pack before charging diamonds.

The synthetic PostgreSQL harness reproduces the original defect and passes 28 checks, including expiry while waiting on a locked row with a second valid pack. Applied production migration 20260908045142_throwable_recheck_pack_expiry. Post-application function MD5 is 9db52098a228a7be9f9c89ed5bf122a0. Anonymous execution stays denied, authenticated execution stays allowed. No real player balances were spent by verification.
