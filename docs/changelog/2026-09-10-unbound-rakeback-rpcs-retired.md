# Retire Unbound Rakeback Payment RPCs

Three service-callable RPC signatures could invoke fn_pay_player_chips with a requested amount without debiting an identified payer or proving a canonical earning obligation:
atomic_pay_player_rakeback(uuid,numeric), atomic_pay_player_rakeback(uuid,uuid,numeric,uuid,text), and credit_player_rakeback(uuid,numeric,text,text).

The forward migration only removes EXECUTE from PUBLIC, anon, authenticated and service_role. It preserves the installed bodies and owner access, so existing catalog integrity checks still inspect the same paths. It moves no balances, changes no historical records and does not replace the canonical claim/period settlement flow.

Read-only production inspection on September 10 found zero pg_depend references to these signatures. Full function-body references consisted of three catalog or wallet guard name inventories; each was reviewed and its exact MD5 is pinned in the migration. A source scan of src, server, Supabase functions and operational scripts found only a WalletService comment and the schema manifest, no runtime invocation. The migration refuses unknown stored dependencies, new body references, changed bodies and unexpected grants.

## Verification

Run bash docs/audits/2026-09-10-rakeback-payer-proof/run-retirement-local.sh. It creates a disposable PostgreSQL 17 cluster with no network listener. The probe requires its explicit /tmp Unix socket, fixed test database and local-only server address.

Four preflight refusal cases cover a changed body, unexpected authenticated grant, new nested caller and stored SQL dependency. Nine attempted positive-amount calls exercise all three RPCs under anon, authenticated and service_role and require PostgreSQL permission denial before body execution. A final assertion proves no wallet, journal or idempotency evidence changes and all installed body MD5s are preserved.

These are ACL tests. The intentionally minimal fixture does not model settlement economics or claim production-equivalent money-trigger coverage. The separate payer consolidation still requires captured source-time terms, mixed payer grouping, immutable source receipts, wrapper lock order, complete money-trigger tests and release verification.

## Operational Boundary

No rollback should regrant an unbound money path. If a missed caller appears, keep the ACL retirement and migrate that caller to an earning-identity-bound payer after review. The preflight guards fail before any grant mutation if the catalog changes.

Primary guidance: https://supabase.com/docs/guides/database/functions and https://www.postgresql.org/docs/17/sql-revoke.html.
