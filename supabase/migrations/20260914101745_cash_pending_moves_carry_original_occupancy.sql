-- 20260914101745_cash_pending_moves_carry_original_occupancy.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- The engine must rehydrate ready swap sides after a restart, and can hold
-- only the original stay. The previous enumeration discarded that identity.
-- No dependent database objects exist on the inspected live signature.
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_cash_seat_moves_pending(uuid)'::regprocedure)
     IS DISTINCT FROM 'e5def26bcd8caf5fd47d898ca7b14670' THEN
    RAISE EXCEPTION 'Unreviewed fn_cash_seat_moves_pending baseline';
  END IF;
END;
$guard$;

DROP FUNCTION public.fn_cash_seat_moves_pending(uuid);
CREATE FUNCTION public.fn_cash_seat_moves_pending(p_table_id uuid)
RETURNS TABLE(move_id uuid, player_id uuid, to_table_id uuid, to_table_name text, to_role text,
              to_main_index integer, reason text, announced_at timestamptz,
              swap_move_id uuid, ready_at timestamptz, source_occupancy_id uuid)
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT m.id, m.player_id, m.to_table_id, t.name, t.role, t.main_index, m.reason, m.announced_at,
         m.swap_move_id, m.ready_at, m.source_occupancy_id
    FROM public.cash_seat_moves m
    JOIN public.tables t ON t.id = m.to_table_id
   WHERE m.from_table_id = p_table_id AND m.state = 'pending' AND m.expires_at > clock_timestamp()
   ORDER BY m.created_at;
$function$;
REVOKE ALL ON FUNCTION public.fn_cash_seat_moves_pending(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_moves_pending(uuid) TO service_role;
COMMIT;
