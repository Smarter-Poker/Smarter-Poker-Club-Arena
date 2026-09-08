# Platform Audit Coverage Baseline

Pinned Club Arena commit: `c38213179f966523ffd936de329b4e71ad95f1c3`.

This is an inventory, not a completed audit or a comprehensive defect report. Every row is explicitly unreviewed until supported by source, behavior and runtime evidence. The scan read all 7038 tracked code, SQL, styling, workflow and script files in the listed source roots, including tests. Assets, configuration data, runtime database objects and external repositories need separate inventories. A file count is not a feature or route count. Comments and test strings can match lexical patterns; marker and RPC columns are discovery candidates, not confirmed bugs or complete call graphs.

## Current Release Gate

Accounting PR #3807 merged as `06a9694b81b74c3a898714460e0b0918fa087d8e`. Its six production database function definitions matched the tested correction. Both cache-busted frontend build stamps served this SHA at 2026-09-08 15:35 UTC. Publish run 34244812291 completed its Hetzner rsync, symlink swap and origin verification.

Cashout PR #3809 merged as `ab31d84d2b752fa0af047e4f91223c594ec8e00b`. Local focused tests: 74 passed; push gate server suite: 2229 passed; TypeScript passed. PR CI server and client tests passed, but live production E2E and animation checks were skipped. Engine at the last check still served `adf1a2c3`: runtime adoption remains unverified. Never force a restart to satisfy this gate.

## Coverage Boundaries

Inventory includes source pages, components, hooks, client services, engine and transport code, tournament logic, SQL migrations, automated tests, deployment workflows and scripts. A separate read-only discovery found 69 Club Arena API files under the World Hub repository's pages/api/club-arena directory; their live source revision, handlers and dependencies must be independently pinned and reviewed. Direct RPC calls, dynamically composed endpoints, lazy pages and persistent table overlays must be traced as well as literal routes in src/App.tsx.

The original 216-requirement audit remains incomplete. Reconcile its original register with docs/ACCOUNTING-AUDIT-SCOPE-2026-09-08.md and the existing audit/handoff records. Older completion statements are historical evidence, not proof against this revision. Industry comparisons need dated primary references and must preserve the user's explicitly chosen rules.

## Confirmed Follow-Up Requiring Source Review

Cashout callers without onFailed callbacks in HorseLifecycleManager and the sit-out eviction path need explicit outcome handling. The eviction path emits seat_left before the cashout completes and removes evictable players from its in-memory roster afterward. Do not interpret PR #3809 as proving these callers complete. Trace refusals, ambiguous transport results, retries, fallback behavior and client state before changing them.

F30 repository delivery remains subject to the no-new-band-aids gate. The blocked source must not be renamed, allowlisted or bypassed. No wallet adjustment or historical backpay is authorized by this inventory.

## Completion Evidence Required Per Surface

Record the page or handler and revision, callers and authorization boundaries, database or engine effects, failure and concurrent-retry behavior, tests actually executed, industry reference where applicable, and deployed version. Browser surfaces additionally need mobile/desktop, stale installed-shell, reconnect, network-switch and multi-table checks. A passed unit test cannot stand in for a skipped browser or production check.
