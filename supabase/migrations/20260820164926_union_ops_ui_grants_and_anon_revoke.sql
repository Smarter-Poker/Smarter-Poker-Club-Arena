-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820164926 "union_ops_ui_grants_and_anon_revoke"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f810a45f4fac0bb842687ab2c8a514a2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- UNION OPS: make the SQL-only capabilities callable from the UI, and only
-- from a signed-in session.
--
-- Two defects being closed here:
--   1. Five functions had no EXECUTE grant to `authenticated` because they had
--      only ever been called by cron/service_role. Any UI call would fail with
--      "permission denied for function".
--   2. Five functions were executable by `anon` — including the two MUTATING
--      assignment RPCs and the agent roster report, which exposes per-player
--      financials. An unauthenticated caller has a null auth.uid(), so the
--      internal authorisation checks are the only thing standing in the way.
--      Anonymous callers have no business reaching these at all.

DO $$
DECLARE
  fn text;
  sig text;
  fns text[] := ARRAY[
    'fn_agent_roster_report(uuid,timestamptz,timestamptz)',
    'fn_agent_weekly_statement(uuid,timestamptz,timestamptz)',
    'fn_union_agent_risk_report(uuid,timestamptz)',
    'fn_union_agent_coverage(uuid)',
    'fn_union_weekly_agent_statements(uuid,timestamptz)',
    'fn_union_settlement_cascade(uuid,timestamptz,timestamptz)',
    'fn_union_distribution_check(uuid,timestamptz)',
    'fn_union_law_selftest()',
    'fn_union_integrity_sweep(uuid,integer)',
    'fn_union_club_exit_blockers(uuid,uuid)',
    'fn_union_expel_club(uuid,uuid,text,boolean)',
    'fn_assign_player_to_agent(uuid,uuid,uuid)',
    'fn_assign_agent_to_super_agent(uuid,uuid,uuid)',
    'fn_player_spendable_balance(uuid,uuid,uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    sig := 'public.' || fn;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;
