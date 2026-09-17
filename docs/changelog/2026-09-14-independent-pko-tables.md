# Independent PKO tables preserve bounty entitlement

A tournament-wide deal-number watermark rejected valid bounties when different tables finished hands in a different order. In the audited completed cohort, 24 of 43 explicit ordering refusals had no shared table or affected player with any later obligation recorded at the rejection time, and their exact claimants had not yet busted.

The original claim and collect functions now consult a private, read-only independence predicate before rejecting a hand below the watermark. It verifies the highest settled watermark and complete later receipts, validates identities before marker casts, requires current claimants still playing, and proves all later pending/settled PKO heads are on different tables with disjoint affected players. Shared or unknown dependencies retain the existing refusal.

Existing settled replay, hand/seat/rebuy identity, pending and same-hand predecessors, exact head snapshots, denomination math, settlement locks, financial writes and marker postconditions remain intact. The predicate has no service-role/public execution grant; the existing database authorities call it internally. No existing row is rewritten and no missing historical head is paid.

Native verification passes 97 assertions plus source/ACL rejection and private-access checks, including separate old claim/collect counterexamples and five concurrent lower-hand claim/collect sessions. All 664 engine accounting cases across 38 files and server TypeScript/build pass. See the fixture README for the bounded chip payer and provider limitations.

Applied once at 12:46:51 UTC as history20260914124651. Readback at 12:47:13 UTC verifies claim body7891b176cdfdf8d8088c10b59240cfe3, collection64474c90007dc5a91e253d02150dc94e and private predicate72c2a52fc8509125a7ed442d4ae8b2f0 with exact owner, ACL, security mode and search path. No production payer was called as a test.

Protected source CI, natural live execution, shared-player causal ordering and historical recipient repair remain separate open acceptance steps.
