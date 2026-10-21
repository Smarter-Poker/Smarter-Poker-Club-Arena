# Reviewed Agent Transfers And Immediate Private Scope Updates

Staff assignment controls now preview selected players, current and destination agents, and affected subtree counts before confirmation. The authoritative transaction rejects stale hierarchy reviews and retains the original operation identity across uncertain responses and remounts. Existing receipts support staff-only search and keyset history.

Hierarchy changes notify old and new uplines on the existing private account broadcast channel. Private reporting screens discard scoped reads and reauthorize immediately, including reconnect and resume; cashier drafts and durable transfer intents remain intact. The hot management-event table remains excluded from WAL publication.

The downline predicate now follows indexed parent links instead of expanding all club edges. A real PostgreSQL fixture with 5,021 members measured 100 lookups at 4,516ms before and 25ms after, with matching answers across ordinary, null, self, depth and cycle cases. These are isolated measurements, not production latency claims.

Maintained native transaction/RLS tests, focused UI/service tests, interruption cleanup checks and existing post-deploy qualification cover preview/confirmation, stale review, replay, direct member access, search, export denial and actual recipient broadcast delivery. Deployment and live verification are tracked separately in the owning task checkpoint.

Four internal hierarchy helpers no longer accept arbitrary actor IDs from browsers. Caller-bound wrappers preserve the seven existing RLS policies and trusted transaction callers retain the original helpers. Native tests reproduce cross-branch probes before the change and verify denial, unchanged own/downline reads and assigned-agent cashout validation afterward.
