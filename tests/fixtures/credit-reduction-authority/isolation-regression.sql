\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Separate complete transactions, no changed default.
BEGIN ISOLATION LEVEL REPEATABLE READ;
\ir isolation-cases.sql
ROLLBACK;
BEGIN ISOLATION LEVEL SERIALIZABLE;
\ir isolation-cases.sql
ROLLBACK;
