-- Finite recovery only of this exact interrupted online operation.
-- First prove original builder ended, exact invalid/ready/live shape and owner,
-- unchanged audit source, no ccnew/ccold siblings, completed original blocking
-- transactions and full maintenance runway. Retain all platform DDL guards.
-- Use statement_timeout=6min and lock_timeout=180s; no transaction wrapper,
-- DROP, blind repetition, timer or automatic repair. After any unknown outcome
-- inspect the SAME operation. Read replacement OID and valid/ready/live state.
REINDEX INDEX CONCURRENTLY public.idx_uwt_settlement_conservation;
