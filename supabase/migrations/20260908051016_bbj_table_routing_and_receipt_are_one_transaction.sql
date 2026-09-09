-- Why: engine pool selection cached by club and ignored private-table scope.
-- What: resolve the table's pool, create it when needed, and post one atomic receipt.
-- Measured: private/union/standalone routes, replay after membership change, and rollback on posting failure.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF to_regprocedure('public.bbj_record_table_contribution(uuid,uuid,integer,numeric,numeric,uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'Table BBJ posting function already exists; inspect before replacing';
 END IF;
 IF md5(pg_get_functiondef('public.bbj_record_contribution(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,integer,uuid)'::regprocedure)) <> '523a1db036474234718a7e664f4eee8e'
 OR md5(pg_get_functiondef('public.fn_resolve_bbj_pool(uuid,uuid)'::regprocedure)) <> 'fb66d9f2fb54713549bf48bce6633356' THEN
  RAISE EXCEPTION 'BBJ posting dependencies changed; re-audit before applying';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.bbj_record_table_contribution(
 p_table_id uuid, p_club_id uuid, p_hand_number integer, p_amount numeric,
 p_big_blind numeric, p_hand_id uuid DEFAULT NULL
) RETURNS public.bbj_contributions
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
SET statement_timeout TO '30s'
AS $function$
DECLARE v_club uuid; v_pool uuid;
BEGIN
 IF p_table_id IS NULL OR p_club_id IS NULL OR p_hand_number IS NULL THEN
  RAISE EXCEPTION 'BBJ table payment requires table, club and hand number' USING ERRCODE='22023';
 END IF;
 -- The same identity locks as the underlying posting function: a retry
 -- retains its original pool even if the club changes union membership.
 IF p_hand_id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('bbj:hand:' || p_hand_id::text, 0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'bbj:table-hand:' || p_table_id::text || ':' || p_hand_number::text, 0));

 SELECT club_id INTO v_club FROM public.tables WHERE id=p_table_id FOR SHARE;
 IF NOT FOUND OR v_club IS DISTINCT FROM p_club_id THEN
  RAISE EXCEPTION 'BBJ table does not belong to the supplied club' USING ERRCODE='22023';
 END IF;
 SELECT pool_id INTO v_pool FROM public.bbj_contributions
 WHERE (p_hand_id IS NOT NULL AND hand_id=p_hand_id)
    OR (table_id=p_table_id AND hand_number=p_hand_number)
 ORDER BY created_at LIMIT 1;
 IF v_pool IS NULL THEN
  v_pool := public.fn_resolve_bbj_pool(p_table_id, p_club_id);
 END IF;
 RETURN public.bbj_record_contribution(
  v_pool,p_hand_id,p_table_id,p_amount,0,0,0,p_big_blind,p_hand_number,p_club_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.bbj_record_table_contribution(uuid,uuid,integer,numeric,numeric,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_record_table_contribution(uuid,uuid,integer,numeric,numeric,uuid) TO service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('bbj_record_table_contribution','approved','2026-09-08 audited service-only table BBJ posting: scope resolution and receipt commit together; calls the keyed contribution writer and preserves original replay destination.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
NOTIFY pgrst,'reload schema';
COMMIT;
