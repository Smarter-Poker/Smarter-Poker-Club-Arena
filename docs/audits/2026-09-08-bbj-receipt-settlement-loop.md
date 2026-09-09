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

## Production adoption

PR 3839 merged as 4932f6f91ad9b08300cf20afbeb9576b6559770f. The reviewed migration was applied through Supabase at 17:32 UTC, recorded there as version 20260908173206. Function fingerprints are `917c59ef3aa4d21865edaf1bfec354bc` (receipt) and `016c5757cf739b66ef459045680c7f45` (legacy repair). The repository's reserved migration file remains 20260908171222.

Natural settlement recovery reduced pending accepted hands from 341 at 17:31:28 to 42 at 17:32:52, then 35 at 17:35. The reported Madness table reduced from 11 pending receipts to one. No BBJ identity conflicts appeared in the first complete post-application log sample. No operator payment/reconciliation call was used to drive that result.

The overall incident remains open. Database statement timeouts remained, and a separate unobserved table-stop rejection caused a fleet restart at 17:28 before this migration. Median-only timing is insufficient to claim all hand gaps are fixed.
