# Union Source Cascade Candidate

This archive prepares the Union outer dispatcher to compose the actual legacy and captured-source money owners. It is not activated, and it does not certify a complete accounting period or Phase 3.

## Runtime Changes

`01-source-dispatch.sql` discovers the Union's current clubs and the original requested/booked clubs retained in captured sources and funding pools. The outer obtains the existing club payer advisory locks in sorted order. The private helper checks ownership and rediscovery before and after admission/payment work; a late club forces a retry instead of acquiring a new unsorted lock.

Captured source admission, club release, agent payment and player payment use the reviewed actual owners. The helper reconciles their returned amounts against exact new immutable receipts and the linked money assertions. It retains original Union/booked-club routing after membership changes. Existing player funding remains discoverable even when an attempt produces no new agent cash. Established service and no-request-context engine calls retain a NULL actor. The release owner binds that same nullable request identity, and the actual money owners keep their existing ledger attribution fallback; the outer invents no actor. Coherent browser claims still require the original Union overseer.

`02-outer-cascade.sql` preserves the original outer signature and legacy Round 1/2/3 owners. It adds the captured dispatcher and validates round contracts before summary writes. Malformed results raise SQLSTATE 23514 so earlier actual payments roll back. Valid Round 1 replays may omit totals; any supplied totals and counts must still have the correct type and range. Conservation runs before shortfall returns. The preflight checks the original captured `md5(prosrc)` value, not a hash of its different full DDL representation.

No helper response can silently activate finality. An unsupported `common_finality` claim raises before any partial return or finalizer. The declared helper contract returns `source_final: false`; the outer therefore returns `source_finality_pending` before the original period-settled/invoice path.

`03-cron-diagnostics.sql` changes only the installed all-Union wrapper's inaccurate assertion that no rakeback moved. A nonfinal result now says payments may have moved and directs reconciliation to each Union result and its durable receipts. Existing failure, retry and structured result behavior remains.

The inherited `fn_caller_is_engine` contract uses `auth.role()`, not `current_user` inside a definer. It treats all absent JWT context as trusted SQL, including a direct `SET ROLE authenticated` session with claims removed. This candidate preserves that established behavior; normal verified browser requests carry coherent claims. The SQL role proof does not test HTTP JWT verification. `actor-contract-pins.json` and `tracked-cron-callers-pin.json` record these source dependencies.

## Native Evidence

Run the helper suite with `bash docs/audits/2026-09-10-union-source-cascade/run-local.sh`. Run the outer composition with `CASCADE_OUTER_MODE=1` before the same command. The runner uses a fixed PostgreSQL 17 installation, a fresh private data directory and Unix socket, no TCP listener, and a clean libpq environment. Its first connection verifies isolation read-only before any fixture SQL.

The helper suite has 15 groups and one observed late-club wait. Its final money is club release 7.20, agent payment 5.60 and player payment 1.20 across original/current Union scenarios. This helper-only evidence does not itself test the legacy outer.

The separate outer suite has 40 passing groups and completed with exit 0. It uses actual accepted hands, rolling legacy/current bank owners, R1/R2/R3, captured release/agent/player owners, the conservation assertion and tracked period finalizer. A real pre-capture accepted hand banks 2; the legacy rounds pay the club 1.80, an agent 0.50 and a player 0.15. A captured hand banks 20 and pays club release 18, agent payments 14 and player payments 3. Fixture-seeded historical payables and attribution projections are explicitly identified in the test; they are not production backpay or claims of historical emitter coverage.

Fault wrappers invoke the real owner first and corrupt only its returned JSON. Refusal comparisons cover every public table, including actual money and receipts. Exact outer replay produces no second cash or money receipts. A final captured-player receipt failure rolls back the legacy rounds and captured payments together, then the real retry pays once. The actual settlement-period table remains unchanged.

The bank boundary test invokes the exact archived old bank body and the direct granted R1 owner in one transaction. R1 can provisionally retain 20 before the bank acknowledgement exists, but the actual deferred record/leg receipt guard rejects COMMIT and rolls back all public rows. No corresponding Union bank transaction survives. Archived bank-owner overlap evidence separately covers observed old-writer waits and replacement-owner retry. These guards must coactivate; an outer finality hold alone does not protect direct R1.

The successor actor/cron cases use actual PostgreSQL anon, authenticated, service_role and privileged no-request sessions with observed role and coherent claim metadata. Unauthorized coherent browser requests preserve every public row. Service release requests keep actor_id NULL, while actual money owners retain their existing ledger attribution identity. The fixture seeds only that established auth identity to satisfy its foreign key, with no balance or membership. A separately authorized minimal live EXISTS check confirmed the identity is present; this does not attest current owner definitions or ACLs. The due caller keeps its actual calendar guard, and the all-Union caller executes real payments while accurately reporting nonfinal results. The inherited absent-context trust is explicitly tested as allowed, not mislabeled a denial.

`native-proof.json`, `outer-native-proof.json`, the raw logs, cluster identities and input/source hashes identify the precise executed evidence. Counts are groups, not code lines or programme requirements. Commit 9159ff8070be0f4638fb87b667ed83d33b42c689 retains the prior 28-group / actor-refusal snapshot; it is historical evidence, not evidence of this successor. Pinned immutable git archives supply source candidate `d5300be77e19d08b887b3b851946c5c244b77ad9` and payer candidate `c12f993244b1f6b01dd950a8e8fee2b0de07ffef`; the runner never consumes another agent's changing working copy.

## Remaining Activation Requirements

- Complete producer, bank, legacy accrual and funding/payment closure must agree on one accounting scope. The separately archived private prefix seals still return `period_closed: false`; they are not a complete period witness.
- Exact fractional liabilities remain owed. No rounding residual is assigned to another account to manufacture finality.
- All legacy projection exclusions, source/bank admission guards, actual payer owners and capability/browser rollout must be coordinated. Current production dependency hashes and ACLs must be checked at that release; historical catalogue evidence is not a current-live attestation.
- No historical repair, backpay, manual balance edit, blanket lockout, engine restart, Stage-B activation or final-deal authority is included.

The files remain under `docs/audits` and the backup branch deliberately does not trigger an automatic production release. Publication of this archive preserves reviewable work; it is not database activation.
