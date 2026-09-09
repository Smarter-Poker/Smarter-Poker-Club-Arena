# Retained administrative departure outcomes

Status: locally implemented and verified; not deployed. Phase 2 remains in progress.

Completed administrative departures now have a read-only original-actor replay path that uses retained authority plus the exact occupancy receipt. A deleted table or profile cannot erase the original outcome. The HTTP handler authenticates the actor once before this lookup; absent original authority still requires current table-admin authorization before any new action. Unavailable or malformed outcome lookups reject before engine dispatch.

The bound cashout wrapper derives administrative session classification from retained occupancy authority and restores the caller's previous transaction-local marker. A later occupancy cannot inherit an earlier kick classification. The canonical financial implementation is unchanged.

Verification: 117 PostgreSQL 17 tests passed; 119 service and HTTP tests passed. Coverage includes deleted tables/profiles, original actor and exact scope, voluntary receipt exclusion, application-role denial, deferred kick classification, marker restoration, malformed outcomes, and unavailable lookups. Server TypeScript and publication are separate release gates. No production balances or historical incidents were changed.

Remaining: bulk administrative selection identity, other departure cleanup paths, combined Phase 2 acceptance, and staged Hetzner adoption.
