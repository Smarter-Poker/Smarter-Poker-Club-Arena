\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Separate fresh cluster after complete original catalog,
-- full36 and the complete new credit/document/delivery/reader successor.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
\ir helpers.sql
-- The actual journal trigger requires the retained store vocabulary. This fresh
-- cluster has not run the acceptance lifecycle seed; reuse its exact captured
-- supplement once, before any real send/hold/payment entrypoint executes.
\ir ../correction-writer-authority/captured-store-policy.sql
DO $guard$ BEGIN IF to_regclass('public.credit_reduction_fixture_marker') IS NOT NULL
 THEN RAISE EXCEPTION 'fresh credit reduction concurrency marker required';END IF;END$guard$;
\ir seed.sql
-- Synthetic hierarchy only, established before the real concurrent calls.
-- User28 sends to player6 and to agent8 (whose agent row is initially absent).
SET LOCAL session_replication_role=replica;
UPDATE public.club_members SET agent_id=pg_temp.cr_id(28)
 WHERE club_id=pg_temp.cr_id(101) AND user_id IN(pg_temp.cr_id(6),pg_temp.cr_id(8));
SET LOCAL session_replication_role=origin;
CREATE TABLE public.credit_reduction_fixture_marker(
 singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 database_oid oid NOT NULL,postmaster_started_at timestamptz NOT NULL);
REVOKE ALL ON public.credit_reduction_fixture_marker FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.credit_reduction_fixture_marker(singleton,database_oid,postmaster_started_at)
 VALUES(true,(SELECT oid FROM pg_database WHERE datname=current_database()),pg_postmaster_start_time());
COMMIT;
