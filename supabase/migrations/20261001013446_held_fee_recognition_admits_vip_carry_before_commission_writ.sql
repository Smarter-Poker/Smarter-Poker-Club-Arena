-- @live-proof: md5(pg_get_functiondef('public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure)) = 'f1a1d663ffb3e1fd9d71060d6b97e896'
-- Historical fee recognition admits its exact positive VIP contributors
-- before commission writes; no ordinary award, rate or timeout changes.

BEGIN;

SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
-- The historical owner holds the bank before canonical VIP awards. A cash
-- hand can own VIP carry and need that bank. Refuse that wait atomically;
-- ordinary recognition, canonical credits and final receipts are unchanged.
DO $install$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure);
 IF md5(source) IS DISTINCT FROM '48005212e5690fe916f57c3a4da9bf57'
  OR md5(pg_get_functiondef('public.fn_award_vip_credit(uuid,numeric,text,uuid,text)'::regprocedure))
   IS DISTINCT FROM '29b7217ecae30238871d3a6e676e1bf6'
  OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
   FROM pg_proc WHERE oid='public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure)
 THEN RAISE EXCEPTION 'held_fee_vip_admission_predecessor_changed'; END IF;
 needle:=$before$  INSERT INTO public.agent_commissions($before$;
 replacement:=$after$  -- Bank rows already belong to this historical operation. Never wait for
  -- a cash hand that owns a contributor's VIP carry and needs our bank.
  -- Match the unchanged award loop's positive grouped credit exactly.
  DECLARE vip_rows_locked bigint;vip_rows_expected bigint;
  BEGIN
   SELECT count(*) INTO vip_rows_expected FROM (
    SELECT player_id FROM public.accounting_tournament_fee_sources
    WHERE id=ANY(active_ids) GROUP BY player_id HAVING sum(rake_credit)>0
   ) contributors;
   BEGIN
    PERFORM carry.user_id FROM public.vip_points_carry carry
    WHERE carry.user_id IN (
     SELECT player_id FROM public.accounting_tournament_fee_sources
     WHERE id=ANY(active_ids) GROUP BY player_id HAVING sum(rake_credit)>0
    ) ORDER BY carry.user_id FOR NO KEY UPDATE OF carry NOWAIT;
    GET DIAGNOSTICS vip_rows_locked=ROW_COUNT;
   EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'held_fee_vip_carry_busy' USING ERRCODE='55000';
   END;
   -- Row locks cannot protect absent rows. Never wait on an unadmitted
   -- concurrent insertion in the later canonical carry UPSERT.
   IF vip_rows_locked<>vip_rows_expected THEN
    RAISE EXCEPTION 'held_fee_vip_carry_admission_incomplete' USING ERRCODE='55000';
   END IF;
  END;
  INSERT INTO public.agent_commissions($after$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'held_fee_vip_admission_boundary_changed'; END IF;
 EXECUTE replace(source,needle,replacement);
END $install$;
REVOKE ALL ON FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
