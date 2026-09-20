\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s';
SET LOCAL timezone='UTC'; SET LOCAL search_path=public,pg_temp;
\ir ../spin-receipt-lane/boundary.sql
\ir current-lane-state.sql
SELECT pg_temp.current_lane_state();
ROLLBACK;
