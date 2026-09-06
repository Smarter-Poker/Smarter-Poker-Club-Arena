-- TOURNAMENT CHIPS ARE SYNCED IN ONE ORDER.
--
-- ROOT CAUSE, from the Postgres log for the 24 hours to 2026-09-06 15:15 UTC:
-- 247 deadlocks - the single largest class on the platform - every one
-- fn_sync_tournament_chips against fn_sync_tournament_chips, "while locking
-- tuple in relation tournament_players". Two engines syncing the same event
-- (a multi-table tournament balancing a player between tables, or two hands
-- ending on two tables that share a moved player) each lock the rows their
-- UPDATE ... FROM jsonb_to_recordset(...) happens to reach first, in whatever
-- order the join produced them, and meet in the middle. Postgres kills one;
-- that table's stacks are not written; the next sync or the reconciler
-- catches up later - which is the pattern Dan has forbidden.
--
-- THE FIX IS THE ORDER. Before the bulk UPDATE, the rows it will touch are
-- locked with SELECT ... ORDER BY user_id FOR UPDATE. Every caller now
-- acquires in user_id order, so two syncs of the same event queue behind each
-- other instead of cycling. The predicate is the same as the UPDATE's (same
-- event, playing, chips actually different), so nothing is locked that was
-- not about to be written. The UPDATE itself is unchanged.
--
-- Postgres applies FOR UPDATE after ORDER BY (the LockRows node sits above
-- the Sort), so the lock order is the sort order, which is the point.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_chips(p_tournament_id uuid, p_updates jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_tournament_id IS NULL OR p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RETURN 0;
  END IF;

  /* ONE LOCK ORDER (20260906): lock the rows this call will write, in
     user_id order, before writing them. 247 deadlocks a day were two syncs of
     the same event reaching the same rows from opposite ends. See the header. */
  PERFORM 1
    FROM public.tournament_players tp
    JOIN jsonb_to_recordset(p_updates) AS u(user_id uuid, chips numeric)
      ON u.user_id = tp.user_id
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'playing'
     AND tp.chips IS DISTINCT FROM floor(GREATEST(u.chips, 0))::integer
   ORDER BY tp.user_id
   FOR UPDATE OF tp;

  UPDATE public.tournament_players tp
     SET chips = floor(GREATEST(u.chips, 0))::integer
  FROM jsonb_to_recordset(p_updates) AS u(user_id uuid, chips numeric)
  WHERE tp.tournament_id = p_tournament_id
    AND tp.user_id = u.user_id
    AND tp.status = 'playing'
    -- PERF 2026-08-25: skip rows whose chip count is already correct. Postgres
    -- does not elide a no-op UPDATE by itself, and every one of those wrote a
    -- heap tuple, a WAL record, index entries and a realtime decode for no
    -- change at all. IS DISTINCT FROM, not <>, so a NULL chips column still
    -- matches and gets written.
    AND tp.chips IS DISTINCT FROM floor(GREATEST(u.chips, 0))::integer;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

DO $verify$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_sync_tournament_chips' AND pronamespace = 'public'::regnamespace;
  IF position('ORDER BY tp.user_id' in v_src) = 0
     OR position('FOR UPDATE OF tp' in v_src) = 0
     OR position('FOR UPDATE OF tp' in v_src) > position('UPDATE public.tournament_players tp' in v_src) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the ordered lock does not precede the bulk update';
  END IF;
  RAISE NOTICE 'CHIP_SYNC_ORDERED rows are locked in user_id order before the update';
END $verify$;

COMMIT;
