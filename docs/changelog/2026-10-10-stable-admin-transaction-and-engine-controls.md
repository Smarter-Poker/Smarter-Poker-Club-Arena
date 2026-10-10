# Stable Admin transaction and engine controls

Stable Admin now reaches the existing engine and financial owners for player
restriction and durable logout, floor holds and cash-table boundary close,
eligible tournament cancellation/refund, existing hourly maintenance commands,
and registration, positive issuance and cashier stops. World Hub separately
owns the console APIs and private asynchronous export artifacts.

Commands retain the original operation identity through interruption. Account
changes cannot reuse a pending request under another operator. Database guards
serialize stops with transactions already admitted, retain funded returns and
refuse new issuance without relying on caller labels. Tournament cancellation
uses the original atomic refund authority and current maker-checker policy.
Floor close retains actual chip and Diamond cashout owners; existing hands
finish before the boundary. Maintenance requests use the existing hourly
owner and original deadline without adding a second scheduled break.

Isolated qualifications exercise actual captured original permission, refund,
cashier and ledger owners on synthetic rows. Required native PostgreSQL 17
checks include concurrent admission/stop ordering and duplicate refund or
cashout settlement. PGlite is provisional sequential evidence only. Exact-source native PostgreSQL 17 qualifications now pass locally: floor
admission/park and cashout races, 101 cancellation/stop assertion groups with
real-session ordering and duplicate refund exactly once, and all 15 rebuy
money scenarios. Initial foreign shared-memory exhaustion was resolved by
sequential native execution; no foreign cluster was modified. Hosted checks
remain required before installation. Existing required accounting shards own
these checks and the required Server Engine result joins their verdicts.

Local client tests, builds and server qualification are recorded in the
World Hub task checkpoint at docs/horses/HANDOFF-2026-10-06-phase11.md and the
external evidence archive. These candidate checks do not establish protected
merge, migration installation, engine activation, publication or live behavior.
No production player, financial transaction or control was used as a fixture.

Connected engine test fixtures now return the canonical empty floor-state
read or explicitly model no hold in isolated startup tests. Existing timing,
launch-owner RPC and failure assertions remain; 115 affected tests pass. The
rebuy native runner honors caller SSD TMPDIR with exact owned-prefix cleanup
and refuses an overlong Unix socket path. No native failure is skipped.
