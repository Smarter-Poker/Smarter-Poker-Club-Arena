-- One explicit recovery of the same stopped invalid build only. First prove
-- no active builder/session, exact target definition, existing DDL/freeze
-- permission and unchanged financial source. Never drop a live index or loop.
SET lock_timeout='180s';
SET statement_timeout='6min';
REINDEX INDEX CONCURRENTLY public.idx_settlement_idem_first_attempt;
