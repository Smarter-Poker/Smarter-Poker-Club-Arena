# Jackpot receipt mismatch blocks the next hand

## Evidence and intended change

Production engine 064d1864 resumed at 17:00 UTC. The first 912 next-hand samples had p50 10,927 ms, p90 20,297 ms and a 42,026 ms maximum. Logs repeatedly reported `BBJ contribution identity reused with a different payment payload` and table settlement watchdog restarts.

Read-only receipt inspection found 91 pending accepted hands with an already banked contribution whose amount, club, table and hand UUID matched, but whose hand number or big blind was null. `fn_bbj_repair_unbanked` writes that incomplete shape directly. `bbj_record_contribution` correctly rejects an unexplained payload change, so retrying cannot progress. The oldest affected receipt was for a hand accepted at 15:51:47 UTC. No production payment was invoked to reproduce this.

The change will allow missing legacy descriptive fields to be supplied only by a hash-verified immutable accepted-hand envelope matching the entire requested identity, amount, club and big blind. Existing non-null fields and the original pool still must match. Replay returns the existing contribution without allocating or crediting again. The legacy repair sweep will exclude hands owned by the accepted-hand obligation processor, preventing a second writer from manufacturing these receipts. Existing balance, journal, allocation, completion and receipt rows are not rewritten by this migration.

Verification and deployment results will be appended after execution. The wider latency incident remains open until live sampling confirms recovery.

## Verification before publication

- Isolated PostgreSQL 17 reproduced the original receipt conflict.
- All 18 new cases passed: metadata recovery without any stored data change, repeated replay, missing/tampered proof, known identity/payment/destination conflicts, and accepted versus legacy repair ownership.
- Existing BBJ routing (7), sequential receipt/allocation (28) and four concurrent replay/conflict cases passed. The complete isolated accounting suite exited 0, including cash-out, insurance, hand roster, ticket, rebuy and journal rollback checks.
- The exact migration, including both production-definition hash guards and grants, applied successfully in a separate isolated database.
- No production payment, seat, contribution, refund, or reconciliation function was invoked for testing. Production application and natural recovery sampling remain pending at commit time.
