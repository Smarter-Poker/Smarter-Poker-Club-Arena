# Tournament Refund Club References Are Indexed

Phase 3 PR #3971 was blocked by three unindexed foreign keys into clubs. Club retirement must be able to locate dependent refund records without scanning each entire table.

Migration 20260909171744_tournament_refund_club_foreign_keys_are_indexed.sql adds full indexes on the club-reference columns of tournament_refund_entitlements, tournament_refund_tranches and tournament_refund_authorizations. The migration uses one transaction with short lock and statement limits. It changes no financial or entitlement data.

Verification: isolated PostgreSQL 17 application and replay exited 0; all three query plans could use their index. Production application succeeded, all three indexes are valid and ready, and the previously failing check-club-fk-indexes.mjs exited 0. The repository manifest generator refreshed actual installed metadata. Phase 3 remains in progress, with CI rerun and engine adoption pending.
