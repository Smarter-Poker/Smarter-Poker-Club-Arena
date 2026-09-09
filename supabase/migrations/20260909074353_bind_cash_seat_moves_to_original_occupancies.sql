-- Every new move binds the original occupancy. Movement and retained outcome
-- commit together; old completed rows are never assigned fabricated receipts.
BEGIN;
SET LOCAL search_path TO public,pg_temp;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cash_seat_move_execute(uuid)'::regprocedure) NOT IN ('a2cae91d3bb885233f006bb34ff2fdb5','d5d6623c05d085f76faeb8f3f95a8e3e') THEN RAISE EXCEPTION 'Unreviewed fn_cash_seat_move_execute baseline'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cash_seat_swap_execute(uuid)'::regprocedure) NOT IN ('52fe5d514028bfe8414d60f5cfe4e8b0','09991eef2a1baa4597a211e035b1f8e9') THEN RAISE EXCEPTION 'Unreviewed fn_cash_seat_swap_execute baseline'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cash_seat_move_execute_before_maintenance_gate(uuid)'::regprocedure) NOT IN ('6055ba8953646538bd866f2f9294366e') THEN RAISE EXCEPTION 'Unreviewed fn_cash_seat_move_execute_before_maintenance_gate baseline'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cash_seat_swap_execute_before_maintenance_gate(uuid)'::regprocedure) NOT IN ('463bb7b45dfbce09e1c837143be3c6ab') THEN RAISE EXCEPTION 'Unreviewed fn_cash_seat_swap_execute_before_maintenance_gate baseline'; END IF;
END $guard$;
LOCK TABLE public.cash_seat_moves IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS source_occupancy_id uuid;
ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS source_seat_number integer;
-- Existing unbound plans cannot prove which stay was selected. Cancel only
-- these unexecuted instructions; no seat, wallet or ledger balance is changed.
UPDATE public.cash_seat_moves SET state='cancelled',note='original_occupancy_not_recorded'
 WHERE state='pending' AND source_occupancy_id IS NULL;

CREATE TABLE IF NOT EXISTS public.cash_seat_move_receipts(
 move_id uuid PRIMARY KEY, player_id uuid NOT NULL, game_id uuid NOT NULL,
 club_id uuid NOT NULL, from_table_id uuid NOT NULL, from_seat_number integer NOT NULL,
 source_occupancy_id uuid NOT NULL, to_table_id uuid NOT NULL,
 to_seat_number integer NOT NULL, destination_occupancy_id uuid NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2) AND amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(source_occupancy_id<>destination_occupancy_id),
 CHECK(from_table_id<>to_table_id)
);
ALTER TABLE public.cash_seat_move_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_seat_move_receipts FROM PUBLIC,anon,authenticated,service_role;
-- The two legs derive from ONE immutable amount, so their total is exactly zero.
CREATE OR REPLACE VIEW public.cash_seat_move_ledger AS
 SELECT move_id,player_id,game_id,club_id,from_table_id AS table_id,
   source_occupancy_id AS occupancy_id,-amount AS amount,'source'::text AS side,created_at
 FROM public.cash_seat_move_receipts
 UNION ALL
 SELECT move_id,player_id,game_id,club_id,to_table_id,
   destination_occupancy_id,amount,'destination'::text,created_at
 FROM public.cash_seat_move_receipts;
REVOKE ALL ON public.cash_seat_move_ledger FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_bind_cash_seat_move_occupancy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp
AS $function$
DECLARE original record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.player_id,NEW.game_id,NEW.from_table_id,NEW.to_table_id,NEW.reason,
         NEW.source_occupancy_id,NEW.source_seat_number) IS DISTINCT FROM
     ROW(OLD.player_id,OLD.game_id,OLD.from_table_id,OLD.to_table_id,OLD.reason,
         OLD.source_occupancy_id,OLD.source_seat_number) THEN
   RAISE EXCEPTION 'SEAT_MOVE_IDENTITY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT s.occupancy_id,s.seat_number INTO original
   FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
   WHERE s.user_id=NEW.player_id AND s.table_id=NEW.from_table_id AND s.left_at IS NULL
     AND t.cluster_id=NEW.game_id AND t.tournament_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'SEAT_MOVE_ORIGINAL_OCCUPANCY_REQUIRED' USING ERRCODE='23514'; END IF;
  IF (NEW.source_occupancy_id IS NOT NULL AND NEW.source_occupancy_id<>original.occupancy_id)
    OR (NEW.source_seat_number IS NOT NULL AND NEW.source_seat_number<>original.seat_number) THEN
   RAISE EXCEPTION 'SEAT_MOVE_ORIGINAL_OCCUPANCY_MISMATCH' USING ERRCODE='23514';
  END IF;
  NEW.source_occupancy_id:=original.occupancy_id;
  NEW.source_seat_number:=original.seat_number;
 END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bind_cash_seat_move_occupancy() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS zzz_bind_cash_seat_move_occupancy ON public.cash_seat_moves;
CREATE TRIGGER zzz_bind_cash_seat_move_occupancy BEFORE INSERT OR UPDATE ON public.cash_seat_moves
 FOR EACH ROW EXECUTE FUNCTION public.fn_bind_cash_seat_move_occupancy();
DO $constraint$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.cash_seat_moves'::regclass AND conname='pending_move_has_original_occupancy') THEN
  ALTER TABLE public.cash_seat_moves ADD CONSTRAINT pending_move_has_original_occupancy
   CHECK(state<>'pending' OR (source_occupancy_id IS NOT NULL AND source_seat_number IS NOT NULL));
 END IF;
END $constraint$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp SET statement_timeout TO '30s'
AS $function$
DECLARE
 initial public.cash_seat_moves%ROWTYPE; partner_initial public.cash_seat_moves%ROWTYPE;
 m public.cash_seat_moves%ROWTYPE; pm public.cash_seat_moves%ROWTYPE;
 source_row public.table_seats%ROWTYPE; partner_source public.table_seats%ROWTYPE;
 destination public.table_seats%ROWTYPE; partner_destination public.table_seats%ROWTYPE;
 outcome jsonb; partner_outcome jsonb; previous jsonb; actor uuid;
BEGIN
 IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
  RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501';
 END IF;
 SELECT receipt INTO previous FROM public.cash_seat_move_receipts WHERE move_id=p_move_id;
 IF FOUND THEN RETURN previous; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 IF public.fn_entry_purchases_frozen() OR public.fn_platform_frozen() THEN
  RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
 END IF;
 SELECT * INTO initial FROM public.cash_seat_moves WHERE id=p_move_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF initial.swap_move_id IS NOT NULL THEN
  SELECT * INTO partner_initial FROM public.cash_seat_moves WHERE id=initial.swap_move_id;
 END IF;
 -- Same user lock as cashout/buy-in; both swap users are ordered before
 -- game, table, move and seat locks. The planner never acquires user locks.
 FOR actor IN SELECT id FROM (VALUES(initial.player_id),(partner_initial.player_id)) v(id)
   WHERE id IS NOT NULL GROUP BY id ORDER BY id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||actor::text,0));
 END LOOP;
 PERFORM 1 FROM public.cash_games
  WHERE id IN(initial.game_id,partner_initial.game_id) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tables
  WHERE id IN(initial.from_table_id,initial.to_table_id,partner_initial.from_table_id,partner_initial.to_table_id)
  ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.cash_seat_moves
  WHERE id IN(initial.id,partner_initial.id) ORDER BY id FOR UPDATE;
 SELECT receipt INTO previous FROM public.cash_seat_move_receipts WHERE move_id=p_move_id;
 IF FOUND THEN RETURN previous; END IF;
 SELECT * INTO m FROM public.cash_seat_moves WHERE id=p_move_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF m.swap_move_id IS DISTINCT FROM initial.swap_move_id THEN
  RAISE EXCEPTION 'SEAT_MOVE_PARTNER_CHANGED' USING ERRCODE='40001';
 END IF;
 IF m.state<>'pending' THEN RETURN jsonb_build_object('ok',false,'reason',m.state); END IF;
 IF m.swap_move_id IS NOT NULL THEN
  SELECT * INTO pm FROM public.cash_seat_moves WHERE id=m.swap_move_id;
  IF NOT FOUND OR pm.swap_move_id IS DISTINCT FROM m.id OR pm.game_id<>m.game_id
    OR pm.from_table_id<>m.to_table_id OR pm.to_table_id<>m.from_table_id
    OR pm.player_id=m.player_id THEN
   RAISE EXCEPTION 'SEAT_SWAP_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;
 END IF;
 SELECT * INTO source_row FROM public.table_seats
  WHERE occupancy_id=m.source_occupancy_id AND table_id=m.from_table_id AND user_id=m.player_id
    AND seat_number=m.source_seat_number AND left_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  UPDATE public.cash_seat_moves SET state='cancelled',note='original_occupancy_gone'
   WHERE id IN(m.id,pm.id) AND state='pending';
  RETURN jsonb_build_object('ok',false,'reason','original_occupancy_gone');
 END IF;
 IF pm.id IS NOT NULL THEN
  SELECT * INTO partner_source FROM public.table_seats
   WHERE occupancy_id=pm.source_occupancy_id AND table_id=pm.from_table_id AND user_id=pm.player_id
    AND seat_number=pm.source_seat_number AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
   UPDATE public.cash_seat_moves SET state='cancelled',note='original_occupancy_gone'
    WHERE id IN(m.id,pm.id) AND state='pending';
   RETURN jsonb_build_object('ok',false,'reason','original_occupancy_gone');
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=m.from_table_id AND cluster_id=m.game_id AND seat_admission_key='cash')
  OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=m.to_table_id AND cluster_id=m.game_id AND seat_admission_key='cash') THEN
  RAISE EXCEPTION 'SEAT_MOVE_GAME_SCOPE_MISMATCH' USING ERRCODE='23514';
 END IF;
 IF pm.id IS NULL THEN
  outcome:=public.fn_cash_seat_move_execute_before_maintenance_gate(m.id);
 ELSE
  outcome:=public.fn_cash_seat_swap_execute_before_maintenance_gate(m.id);
 END IF;
 IF outcome->>'ok' IS DISTINCT FROM 'true' THEN
  RETURN outcome||jsonb_build_object('move_id',m.id,'player_id',m.player_id,
    'from_table_id',m.from_table_id,'source_occupancy_id',m.source_occupancy_id,
    'source_seat_number',m.source_seat_number);
 END IF;
 SELECT * INTO destination FROM public.table_seats
  WHERE user_id=m.player_id AND table_id=m.to_table_id
    AND seat_number=(outcome->>'to_seat_number')::integer AND left_at IS NULL;
 IF NOT FOUND OR destination.stack IS DISTINCT FROM source_row.stack
   OR destination.occupancy_id=source_row.occupancy_id
   OR (outcome->>'stack')::numeric IS DISTINCT FROM source_row.stack
   OR EXISTS(SELECT 1 FROM public.table_seats WHERE occupancy_id=source_row.occupancy_id AND left_at IS NULL) THEN
  RAISE EXCEPTION 'SEAT_MOVE_CONSERVATION_FAILED' USING ERRCODE='23514';
 END IF;
 outcome:=outcome||jsonb_build_object('move_id',m.id,'player_id',m.player_id,
  'from_table_id',m.from_table_id,'source_seat_number',m.source_seat_number,
  'source_occupancy_id',m.source_occupancy_id,'destination_occupancy_id',destination.occupancy_id,
  'idempotency_key','seatmove:'||m.id::text,'reason',m.reason);
 IF pm.id IS NOT NULL THEN
  SELECT * INTO partner_destination FROM public.table_seats
   WHERE user_id=pm.player_id AND table_id=pm.to_table_id AND left_at IS NULL;
  IF NOT FOUND OR partner_destination.stack IS DISTINCT FROM partner_source.stack
    OR partner_destination.occupancy_id=partner_source.occupancy_id
    OR EXISTS(SELECT 1 FROM public.table_seats WHERE occupancy_id=partner_source.occupancy_id AND left_at IS NULL) THEN
   RAISE EXCEPTION 'SEAT_SWAP_CONSERVATION_FAILED' USING ERRCODE='23514';
  END IF;
  outcome:=jsonb_set(outcome,'{partner}',coalesce(outcome->'partner','{}'::jsonb)||
    jsonb_build_object('move_id',pm.id,'source_occupancy_id',pm.source_occupancy_id,
      'source_seat_number',pm.source_seat_number,'destination_occupancy_id',partner_destination.occupancy_id));
  partner_outcome:=jsonb_build_object('ok',true,'swap',true,'move_id',pm.id,'player_id',pm.player_id,
    'from_table_id',pm.from_table_id,'source_seat_number',pm.source_seat_number,
    'source_occupancy_id',pm.source_occupancy_id,'destination_occupancy_id',partner_destination.occupancy_id,
    'to_table_id',pm.to_table_id,'to_seat_number',partner_destination.seat_number,
    'stack',partner_source.stack,'reason',pm.reason,'idempotency_key','seatmove:'||pm.id::text,
    'partner',jsonb_build_object('move_id',m.id,'player_id',m.player_id,
      'from_table_id',m.from_table_id,'to_table_id',m.to_table_id,'to_seat_number',destination.seat_number,
      'stack',source_row.stack,'source_occupancy_id',m.source_occupancy_id,
      'source_seat_number',m.source_seat_number,'destination_occupancy_id',destination.occupancy_id));
  INSERT INTO public.cash_seat_move_receipts(move_id,player_id,game_id,club_id,from_table_id,
    from_seat_number,source_occupancy_id,to_table_id,to_seat_number,destination_occupancy_id,amount,receipt)
   VALUES(pm.id,pm.player_id,pm.game_id,partner_source.club_id,pm.from_table_id,
    pm.source_seat_number,pm.source_occupancy_id,pm.to_table_id,partner_destination.seat_number,
    partner_destination.occupancy_id,partner_source.stack,partner_outcome);
 END IF;
 INSERT INTO public.cash_seat_move_receipts(move_id,player_id,game_id,club_id,from_table_id,
    from_seat_number,source_occupancy_id,to_table_id,to_seat_number,destination_occupancy_id,amount,receipt)
  VALUES(m.id,m.player_id,m.game_id,source_row.club_id,m.from_table_id,
    m.source_seat_number,m.source_occupancy_id,m.to_table_id,destination.seat_number,
    destination.occupancy_id,source_row.stack,outcome);
 RETURN outcome;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute(p_move_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp SET statement_timeout TO '30s'
AS $function$
BEGIN
 RETURN public.fn_cash_seat_move_execute(p_move_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute(uuid),public.fn_cash_seat_swap_execute(uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_execute(uuid),public.fn_cash_seat_swap_execute(uuid)
 TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute_before_maintenance_gate(uuid),
 public.fn_cash_seat_swap_execute_before_maintenance_gate(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
