# Phase 2 Final Cashout Retirement

Status: locally tested, not applied or published.

The previous retirement draft revoked browser access to the canonical cashout and the old admin RPC, but left SECURITY DEFINER aliases callable. The final stage revokes PUBLIC, anon, authenticated and service_role access to all four unbound entrypoints: atomic_seat_cashout_locked, atomic_table_cashout, player_leave_table and fn_admin_kick_player. The occupancy-bound engine function continues to invoke the private primitive as its owner.

The final SQL is staged at scripts/deploy/phase-two-retire-unbound-cashout.sql. It must become a reserved migration only after the additive occupancy schema, compatible frontend and compatible engine are verified live. This ordering permits the initial migration acceptance gate without prematurely removing paths used by an older engine.

The PostgreSQL 17 harness installs the exact legacy alias, applies every additive migration, then applies the staged retirement twice. All 143 tests passed. Role tests prove all four old entrypoints reject every application role without changing seats or money, while the service-role occupancy-bound path still pays the original stay.

Evidence: /tmp/chip-conservation-evidence/phase-two-final-retirement-postgres.log.
Pending: remaining Phase 2 review, combined acceptance, additive production migration application, normal Hetzner publication, scheduled engine adoption, final reserved retirement migration and live privilege verification. No production completion is claimed.
