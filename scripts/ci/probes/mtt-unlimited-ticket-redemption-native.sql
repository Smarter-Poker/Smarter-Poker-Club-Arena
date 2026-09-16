-- Required R46 catalog entry. Run only through protected local admission in
-- an isolated database with the complete current schema and candidate migration.
-- The legacy source composer installs old financial bodies and is NOT this
-- fixture's provider. Both this wrapper and its included source must be pinned.
\set ON_ERROR_STOP on
\set r46_unlimited_mtt on
\ir existing-ticket-current-redemption-native.sql
\unset r46_unlimited_mtt
