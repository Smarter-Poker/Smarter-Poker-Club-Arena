-- live_md5 a5d21188b37bb0566c2fb82abeeb29a2
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_moved bigint;
BEGIN
 -- OLD is only touched inside the UPDATE branch; a BEFORE/AFTER INSERT has none.
 IF TG_OP='UPDATE' THEN
   IF OLD.purpose='tournament_entry' OR NEW.purpose='tournament_entry' THEN
     IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.target_id IS DISTINCT FROM OLD.target_id
        OR NEW.arena_id IS DISTINCT FROM OLD.arena_id
        OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
        OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
       RAISE EXCEPTION 'A Diamond Tournament Entry Is Fixed To The Player And Event It Paid For'
         USING ERRCODE='P0815';
     END IF;
   END IF;
 END IF;
 IF NEW.purpose <> 'tournament_entry' THEN RETURN NULL; END IF;

 IF NEW.seat_id IS NOT NULL OR NEW.seat_joined_at IS NOT NULL OR NEW.occupancy_id IS NOT NULL THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Never Binds To A Seat' USING ERRCODE='P0813';
 END IF;

 SELECT COALESCE(sum(CASE WHEN m.action='reserve' THEN m.amount ELSE -m.amount END),0)
   INTO v_moved FROM public.poker_diamond_movements m WHERE m.custody_id=NEW.id;
 IF NEW.balance IS DISTINCT FROM v_moved THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Holds Only What Was Reserved For It'
     USING ERRCODE='P0814';
 END IF;

 RETURN NULL;
END $function$

