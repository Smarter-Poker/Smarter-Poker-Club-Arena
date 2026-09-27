-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820062809 "union_law_buyin_overload_delegates_no_split_brain"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8983926a62435524bf18aa91af86fd41 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — REMOVE BUY-IN SPLIT-BRAIN (2026-08-20)
--
-- Adding p_club_id created a SECOND function rather than replacing the first:
--   atomic_table_buyin(uuid,uuid,integer,numeric,boolean)        <- legacy, global wallet
--   atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid)   <- club-aware
--
-- PostgREST resolves by argument name/arity, so the game engine (which posts
-- five arguments) would have kept hitting the legacy global-wallet path while
-- the Club Arena client hit the club-aware one — half the seats stamped, half
-- not, and chips leaving two different wallets. That must be closed BEFORE the
-- club-scoped chip flag is switched on.
--
-- The five-argument form now simply delegates with p_club_id = NULL, so every
-- caller goes through one implementation and honours the flag identically.
-- Callers that supply no club context fall back to the player's resolved club
-- (fn_seat_club_for_user), exactly as intended.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Single implementation: delegate to the club-aware form.
  PERFORM public.atomic_table_buyin(
    p_user_id, p_table_id, p_seat_number, p_amount, p_auto_rebuy, NULL::uuid);
END;
$function$;

