# Phase 2 Final Cashout Retirement

Status: applied and application-role privileges verified; final migration-file publication pending.

The previous retirement draft revoked browser access to the canonical cashout and the old admin RPC, but left SECURITY DEFINER aliases callable. The final stage revokes PUBLIC, anon, authenticated and service_role access to all four unbound entrypoints: atomic_seat_cashout_locked, atomic_table_cashout, player_leave_table and fn_admin_kick_player. The occupancy-bound engine function continues to invoke the private primitive as its owner.

The final SQL is staged at scripts/deploy/phase-two-retire-unbound-cashout.sql. It must become a reserved migration only after the additive occupancy schema, compatible frontend and compatible engine are verified live. This ordering permits the initial migration acceptance gate without prematurely removing paths used by an older engine.

The PostgreSQL 17 harness installs the exact legacy alias, applies every additive migration, then applies the staged retirement twice. All 143 tests passed. Role tests prove all four old entrypoints reject every application role without changing seats or money, while the service-role occupancy-bound path still pays the original stay.

Evidence: /tmp/chip-conservation-evidence/phase-two-final-retirement-postgres.log.
Pending: remaining Phase 2 review, combined acceptance, additive production migration application, normal Hetzner publication, scheduled engine adoption, final reserved retirement migration and live privilege verification. No production completion is claimed.

## Verified Production Retirement

On September 9, 2026 at 21:02 UTC, compatible engine 561eaa523829ef8ecbd6b11fffe946b6e53fd756 was proved by HTTP health, matching database heartbeat and Git ancestry from the occupancy release. All five cashout/seat-move/router source blobs matched that release. Public and origin frontend both served b30e1b8513bf51937276c8d57b44c03ff038cb51, which also contains the release.

The exact staged SQL, SHA256 5ecc6d171b53f019f069e5463099d4ab191352ef73edd55a4b4b5ca977ce49ed, was copied to the reserved migration 20260909210038 and applied once through Supabase MCP as live version 20260909210206. All four unbound functions now deny anon, authenticated and service_role; the bound function denies browsers and retains service execution. No money test or balance correction was performed. Existing local PostgreSQL tests had already applied this identical SQL twice and proved bound payouts and retired-role denial.

The earlier paragraphs describe the historical staged checkpoint. Migration and evidence publication are still pending. Overall Phase 3 remains open.
