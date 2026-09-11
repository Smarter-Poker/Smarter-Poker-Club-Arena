# Union Source Cascade Candidate

This archive prepares the Union outer dispatcher to compose the actual legacy and captured-source money owners. It is not activated, and it does not certify a complete accounting period or Phase 3.

## Runtime Changes

`01-source-dispatch.sql` discovers the Union's current clubs and the original requested/booked clubs retained in captured sources and funding pools. The outer obtains the existing club payer advisory locks in sorted order. The private helper checks ownership and rediscovery before and after admission/payment work; a late club forces a retry instead of acquiring a new unsorted lock.

Captured source admission, club release, agent payment and player payment use the reviewed actual owners. The helper reconciles their returned amounts against exact new immutable receipts and the linked money assertions. It retains original Union/booked-club routing after membership changes. Existing player funding remains discoverable even when an attempt produces no new agent cash. Requests with no authenticated actor refuse before admission or money.

`02-outer-cascade.sql` preserves the original outer signature and legacy Round 1/2/3 owners. It adds the captured dispatcher and validates round contracts before summary writes. Malformed results raise SQLSTATE 23514 so earlier actual payments roll back. Valid Round 1 replays may omit totals; any supplied totals and counts must still have the correct type and range. Conservation runs before shortfall returns. The preflight checks the original captured `md5(prosrc)` value, not a hash of its different full DDL representation.

No helper response can silently activate finality. An unsupported `common_finality` claim raises before any partial return or finalizer. The declared helper contract returns `source_final: false`; the outer therefore returns `source_finality_pending` before the original period-settled/invoice path.

## Native Evidence

Run the helper suite with `bash docs/audits/2026-09-10-union-source-cascade/run-local.sh`. Run the outer composition with `CASCADE_OUTER_MODE=1` before the same command. The runner uses a fixed PostgreSQL 17 installation, a fresh private data directory and Unix socket, no TCP listener, and a clean libpq environment. Its first connection verifies isolation read-only before any fixture SQL.

The helper suite has 15 groups and one observed late-club wait. Its final money is club release 7.20, agent payment 5.60 and player payment 1.20 across original/current Union scenarios. This helper-only evidence does not itself test the legacy outer.

The separate outer suite has 28 passing groups and completed with exit 0. It uses actual accepted hands, rolling legacy/current bank owners, R1/R2/R3, captured release/agent/player owners, the conservation assertion and tracked period finalizer. A real pre-capture accepted hand banks 2; the legacy rounds pay the club 1.80, an agent 0.50 and a player 0.15. A captured hand banks 20 and pays club release 18, agent payments 14 and player payments 3. Fixture-seeded historical payables and attribution projections are explicitly identified in the test; they are not production backpay or claims of historical emitter coverage.

Fault wrappers invoke the real owner first and corrupt only its returned JSON. Refusal comparisons cover every public table, including actual money and receipts. Exact outer replay produces no second cash or money receipts. A final captured-player receipt failure rolls back the legacy rounds and captured payments together, then the real retry pays once. The actual settlement-period table remains unchanged.

The bank boundary test invokes the exact archived old bank body and the direct granted R1 owner in one transaction. R1 can provisionally retain 20 before the bank acknowledgement exists, but the actual deferred record/leg receipt guard rejects COMMIT and rolls back all public rows. No corresponding Union bank transaction survives. Archived bank-owner overlap evidence separately covers observed old-writer waits and replacement-owner retry. These guards must coactivate; an outer finality hold alone does not protect direct R1.

`native-proof.json`, `outer-native-proof.json`, the raw logs, cluster identities and input/source hashes identify the precise executed evidence. Counts are groups, not code lines or programme requirements. Pinned immutable git archives supply source candidate `d5300be77e19d08b887b3b851946c5c244b77ad9` and payer candidate `f39368fefe22b4385e9e89e5350bb671c587fb4a`; the runner never consumes another agent's changing working copy.

## Remaining Activation Requirements

- Complete producer, bank, legacy accrual and funding/payment closure must agree on one accounting scope. The separately archived private prefix seals still return `period_closed: false`; they are not a complete period witness.
- Exact fractional liabilities remain owed. No rounding residual is assigned to another account to manufacture finality.
- The existing actor-less service/cron invocation needs a reviewed actor contract before this outer can replace the production owner.
- All legacy projection exclusions, source/bank admission guards, actual payer owners and capability/browser rollout must be coordinated. Current production dependency hashes and ACLs must be checked at that release; historical catalogue evidence is not a current-live attestation.
- No historical repair, backpay, manual balance edit, blanket lockout, engine restart, Stage-B activation or final-deal authority is included.

The files remain under `docs/audits` and the backup branch deliberately does not trigger an automatic production release. Publication of this archive preserves reviewable work; it is not database activation.
