-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901110603; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-09-01 11:03 UTC: all 416 club_members rows and all 32 agents rows for
-- Deep Stack Society (club 11192, 2a1132b9-5ba2-42e6-9f01-30a7fcffebe3) were
-- deleted inside a single minute, taking 7,500,000 chips of structure with them.
-- Verified present at 11:02, gone at 11:03. Nothing recorded it: no row in
-- ca_ledger_mutation_log, none in data_audit_log, no chip_ledger movement. A
-- direct service-role DELETE leaves no evidence anywhere in this schema.
--
-- Two things follow. The rows are refused deletion unless a caller asks for it
-- on purpose, and every attempt -- refused or allowed -- is recorded with enough
-- session identity to name the next one.

CREATE TABLE IF NOT EXISTS public.deep_stack_delete_attempts (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  source_table text        NOT NULL,
  allowed      boolean     NOT NULL,
  db_user      text        NOT NULL,
  db_role      text        NOT NULL,
  application  text,
  client_addr  text,
  backend_pid  int,
  running_query text,
  old_row      jsonb       NOT NULL
);

CREATE OR REPLACE FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed boolean := COALESCE(current_setting('app.deep_stack_teardown', true), '') = 'on';
  v_query   text;
BEGIN
  SELECT a.query INTO v_query
    FROM pg_stat_activity a WHERE a.pid = pg_backend_pid();

  INSERT INTO public.deep_stack_delete_attempts
    (source_table, allowed, db_user, db_role, application, client_addr, backend_pid, running_query, old_row)
  VALUES
    (TG_TABLE_NAME, v_allowed, session_user, current_user,
     current_setting('application_name', true), host(COALESCE(inet_client_addr(), '0.0.0.0'::inet)),
     pg_backend_pid(), left(COALESCE(v_query, ''), 4000), to_jsonb(OLD));

  IF NOT v_allowed THEN
    RAISE EXCEPTION
      'DEEP_STACK_PROTECTED: this row belongs to Deep Stack Society (club 11192) and is not deletable'
      USING ERRCODE = '42501',
            HINT = 'The whole club was deleted once with no audit trail. Set app.deep_stack_teardown = ''on'' for your transaction if you really mean it.';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_deep_stack_members_are_protected ON public.club_members;
CREATE TRIGGER trg_deep_stack_members_are_protected
  BEFORE DELETE ON public.club_members
  FOR EACH ROW
  WHEN (OLD.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
  EXECUTE FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident();

DROP TRIGGER IF EXISTS trg_deep_stack_agents_are_protected ON public.agents;
CREATE TRIGGER trg_deep_stack_agents_are_protected
  BEFORE DELETE ON public.agents
  FOR EACH ROW
  WHEN (OLD.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
  EXECUTE FUNCTION public.fn_deep_stack_society_cannot_be_deleted_by_accident();
