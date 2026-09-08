BEGIN;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid) TO service_role;
COMMIT;
