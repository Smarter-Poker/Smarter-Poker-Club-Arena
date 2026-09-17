-- Included only by the protected primary native qualification transaction.
SELECT pg_temp.class4_assert(current_database()='class4_native_'||
 replace(current_setting('app.class4_execution_uuid'),'-',''),'guard negative native binding');

SAVEPOINT class4_body_drift;
DO $$DECLARE s text;BEGIN
 s:=pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure);
 EXECUTE replace(s,'DECLARE','DECLARE /* isolated source drift */');
END$$;
\set ON_ERROR_STOP off
\ir ../../supabase/components/class4-hand-outcome-evidence.sql
\if :ERROR
  \set class4_error :SQLSTATE
\else
  \quit 31
\endif
\set ON_ERROR_STOP on
ROLLBACK TO class4_body_drift;
SELECT pg_temp.class4_assert(:'class4_error'='P0001','body drift must refuse');

SAVEPOINT class4_acl_drift;
REVOKE EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean,integer) FROM service_role;
\set ON_ERROR_STOP off
\ir ../../supabase/components/class4-hand-outcome-evidence.sql
\if :ERROR
  \set class4_error :SQLSTATE
\else
  \quit 32
\endif
\set ON_ERROR_STOP on
ROLLBACK TO class4_acl_drift;
SELECT pg_temp.class4_assert(:'class4_error'='P0001','target ACL drift must refuse');

SAVEPOINT class4_dependency_drift;
GRANT UPDATE ON public.hand_atomic_commits TO service_role;
\set ON_ERROR_STOP off
\ir ../../supabase/components/class4-hand-outcome-evidence.sql
\if :ERROR
  \set class4_error :SQLSTATE
\else
  \quit 33
\endif
\set ON_ERROR_STOP on
ROLLBACK TO class4_dependency_drift;
SELECT pg_temp.class4_assert(:'class4_error'='P0001','canonical write-authority drift must refuse');

SAVEPOINT class4_trigger_drift;
ALTER TABLE public.financial_alerts DISABLE TRIGGER zz_ca_alert_resolution_reaches_the_incident;
\set ON_ERROR_STOP off
\ir ../../supabase/components/class4-hand-outcome-evidence.sql
\if :ERROR
  \set class4_error :SQLSTATE
\else
  \quit 34
\endif
\set ON_ERROR_STOP on
ROLLBACK TO class4_trigger_drift;
SELECT pg_temp.class4_assert(:'class4_error'='P0001','disabled mirror trigger must refuse');

SELECT pg_temp.class4_assert((SELECT
 alerts IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(a)ORDER BY id)FROM public.financial_alerts a)
 AND commits IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(c)ORDER BY hand_id)FROM public.hand_atomic_commits c)
 AND mirrors IS NOT DISTINCT FROM(SELECT jsonb_agg(to_jsonb(i)ORDER BY id)FROM public.ca_drift_incidents i)
 FROM class4_before_source),'guard refusals must not change any subject rows');
