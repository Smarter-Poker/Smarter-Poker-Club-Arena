-- Found while verifying Phase 1 rather than while writing it, which is the
-- point of verifying.
--
-- money_check_heartbeat was created with the schema's default grants, which on
-- this database hand `anon` and `authenticated` arwdxtm - SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER. RLS is enabled on the table
-- and it carries no policies, so those grants are inert TODAY: row-level
-- security denies every one of them to a browser role and service_role bypasses
-- RLS.
--
-- Inert is not the same as absent. The day somebody adds a permissive policy
-- for a legitimate read - a status page, a dashboard tile - every one of those
-- write grants comes alive with it, and a browser could stamp a heartbeat for a
-- check that never ran. That is the precise failure this table exists to make
-- impossible, reachable through the table itself.
--
-- The function that writes it is already service_role only. The table it writes
-- should say the same thing on its own face rather than relying on a policy
-- that happens not to exist yet.
--
-- WORTH KNOWING: check-definer-authorization guards new FUNCTIONS this way and
-- nothing guards new TABLES. Every table created since that gate was written
-- has carried these default grants unexamined.
--
-- ROLLBACK
--   GRANT ALL ON TABLE public.money_check_heartbeat TO anon, authenticated;

REVOKE ALL ON TABLE public.money_check_heartbeat FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.money_check_heartbeat TO service_role;

DO $$
DECLARE v_acls text[]; v_entry text;
BEGIN
  SELECT array_agg(a::text) INTO v_acls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(c.relacl) AS a
   WHERE n.nspname='public' AND c.relname='money_check_heartbeat';

  FOREACH v_entry IN ARRAY COALESCE(v_acls, ARRAY[]::text[]) LOOP
    IF v_entry LIKE '=%' OR v_entry LIKE 'anon=%' OR v_entry LIKE 'authenticated=%' THEN
      RAISE EXCEPTION 'money_check_heartbeat is still granted to a browser role: %', v_entry;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(v_acls, ARRAY[]::text[])) e
                  WHERE e LIKE 'service_role=%') THEN
    RAISE EXCEPTION 'money_check_heartbeat lost its service_role grant: %', v_acls;
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='money_check_heartbeat') THEN
    RAISE EXCEPTION 'money_check_heartbeat lost row level security';
  END IF;
END $$;
