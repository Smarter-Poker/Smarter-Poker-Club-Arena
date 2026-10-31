# Lightning settlement joins the matcher pass before row locks

## Change

**Files:** migration `20261031155622`, existing anchor-order native runner and unit enforcement, two captured native fixtures.
**What existed:** settlement `11a27ab2e92d129ceab9201cbe2737f9` acquired instance and seat rows without joining the matcher's existing exclusive transaction advisory gate (settlement lines 103–110). Matching sorts anchors per formed group but retains those locks across every group in its transaction. A later group can therefore acquire a lower anchor after an earlier higher anchor. The post-first-fix production deadlock at 2026-10-31 13:54:41.562 UTC remained possible.
**What changed:** read the original hand's cluster with its instance and acquire the existing `lightning_matcher:<cluster>` gate in shared transaction mode before any instance, anchor or slot lock. Matcher exclusivity spans the whole pass; disjoint settlements can hold the gate together. Keep the prior seat ordering for direct formation, canonical request hashing, amounts, physical writer, receipt and ACL unchanged. The migration requires the exact installed preimage and verifies postimage `6d66c432d60034302d04258ca9c5f67f` in one short DDL transaction.
**Why:** global transaction ordering is required across multiple actual formations, rather than only within one group.
**Verified:** source reread; integrated native P6 chain passed all 22 original sections and its existing zero-payer, funded-population, PnL and cash-clock followups, plus all three prior anchor and four new matcher-pass checks. Root `tsc --noEmit` and the extended native-pipeline enforcement unit passed locally. Exact provider and installation evidence belongs in the task checkpoint.

## Regression

The existing required P6 settlement pipeline runs the original three anchor checks and four additional pass checks in the same disposable PostgreSQL database. Captured current formation, planner and matcher bodies are hash-asserted; their financial dependencies are the maintained P6 writers. Fixture configuration is explicit, with an empty pending-top-up relation. No planner or formation function is replaced with a fake.

The native case starts a real six-player hand, fast-folds two players through the real RPC, and has the actual planner assign their adverse anchors to two different six-player groups. A test-only insertion trigger pauses the first real formation after its anchors are held. The current seat-ordered settler and actual two-group matcher reproduce 40P01. After the correction, settlement waits at the advisory gate while an independent backend can still lock the original instance, both real groups finish, and settlement commits physically once with an exact receipt replay. Concurrent anchor balances equal the unchanged original serial settlement in a rolled-back transaction. A second case witnesses two disjoint same-cluster settlements holding shared admission simultaneously; the real matcher returns `pass_in_progress`, and both settlements commit once and replay exact receipts. Function metadata and restrictive access remain unchanged.

Test-only gates exist only in the native fixture. No production game, wallet or financial test operation is performed. Database delivery does not require an engine restart.
