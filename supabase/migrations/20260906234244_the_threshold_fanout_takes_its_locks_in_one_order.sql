-- 20260906234244_the_threshold_fanout_takes_its_locks_in_one_order.sql
--
-- Named for the version the Supabase MCP recorded when it applied this.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE THRESHOLD FAN-OUT TAKES ITS LOCKS IN ONE ORDER
--  BBJ phase 3.4, found by probing the function before trusting it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT HAPPENED, on the very first probe (CLAUDE.md 11.5 - a self-aborting
-- transaction on production, where an error is the success case):
--
--   40P01: deadlock detected
--   Process A waits for ShareLock on transaction X; blocked by process B
--   Process B waits for ShareLock on transaction Y; blocked by process A
--   while locking tuple (74,6) in relation "profiles"
--   SELECT 1 FROM ONLY public.profiles x WHERE id = $1 FOR KEY SHARE OF x
--
-- WHY. `notifications.user_id` references `profiles.id`, so a bulk INSERT of
-- one row per member takes a FOR KEY SHARE lock on one profile row per member
-- - up to 418 of them - IN WHATEVER ORDER `club_members` happened to return.
-- Any concurrent writer touching the same profiles in a different order
-- deadlocks with it. On a live database that is not a rare race: it happened
-- on the first attempt, against ordinary platform traffic, in the afternoon.
--
-- THE FIX IS THE CAUSE, not a retry around it (CLAUDE.md 10.11). Two writers
-- that take the same locks IN THE SAME ORDER cannot deadlock with each other,
-- so the fan-out is ordered by `user_id` - a total order every writer can
-- agree on without coordinating. The old arbitrary order was not a decision
-- anybody made; it was the absence of one.
--
-- AND ONE THRESHOLD'S FAILURE NO LONGER COSTS THE OTHERS THEIRS. The loop now
-- catches per threshold: a club whose fan-out fails is skipped, reported, and
-- retried on the next five-minute run, while every other club is still told.
-- Because the crossing row is written inside the same block, a failed fan-out
-- rolls that back too - so the threshold stays ARMED rather than being
-- recorded as announced to nobody.
--
-- PROVEN, in a transaction that was rolled back:
--   418 members - balance 23,113.14
--   run 1: {"crossings": 1, "notified": 418, "failed": 0}
--   run 2: {"crossings": 0, "notified": 0,   "failed": 0}   <- says it once
--   no deadlock; zero residue afterwards.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_notify_thresholds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t              record;
  v_pool_id        uuid;
  v_balance        numeric;
  v_members        integer;
  v_crossings      integer := 0;
  v_notified       integer := 0;
  v_failed         integer := 0;
  v_crossing_id    uuid;
BEGIN
  FOR v_t IN
    SELECT th.id, th.club_id, th.amount, th.label
      FROM public.bbj_notify_thresholds th
     WHERE th.enabled
     ORDER BY th.club_id, th.amount
  LOOP
    v_pool_id := NULL;
    v_balance := NULL;
    SELECT p.pool_id, p.main_balance INTO v_pool_id, v_balance
      FROM public.fn_bbj_pool_for_club(v_t.club_id) p
     LIMIT 1;

    CONTINUE WHEN v_pool_id IS NULL;
    CONTINUE WHEN COALESCE(v_balance, 0) < v_t.amount;

    IF EXISTS (
      SELECT 1
        FROM public.bbj_threshold_crossings c
        LEFT JOIN public.bbj_pools bp ON bp.id = v_pool_id
       WHERE c.threshold_id = v_t.id
         AND c.crossed_at > COALESCE(bp.last_hit_at, '-infinity'::timestamptz)
    ) THEN
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.bbj_threshold_crossings
        (threshold_id, club_id, pool_id, threshold_amount, balance_at_cross)
      VALUES (v_t.id, v_t.club_id, v_pool_id, v_t.amount, v_balance)
      RETURNING id INTO v_crossing_id;

      /* EVERY ACTIVE MEMBER, HORSES INCLUDED (CLAUDE.md 10.5), IN USER_ID
         ORDER. The order is not cosmetic: each row takes a FOR KEY SHARE lock
         on its profile through the notifications FK, and an arbitrary order
         deadlocked against live traffic on the first probe. */
      WITH ordered AS (
        SELECT cm.user_id, c.name AS club_name
          FROM public.club_members cm
          JOIN public.clubs c ON c.id = cm.club_id
         WHERE cm.club_id = v_t.club_id
           AND cm.status = 'active'
         ORDER BY cm.user_id
      ), told AS (
        INSERT INTO public.notifications (user_id, type, title, message, metadata, read)
        SELECT o.user_id,
               'bonus',
               'The Bad Beat Jackpot Just Passed $' || trim(to_char(v_t.amount, 'FM999,999,999.00')),
               'The jackpot at ' || COALESCE(o.club_name, 'your club') || ' is now $' ||
                 trim(to_char(v_balance, 'FM999,999,999.00')) ||
                 '. Every raked hand adds to it, and it pays the table when it hits.',
               jsonb_build_object(
                 'clubId', v_t.club_id,
                 'poolId', v_pool_id,
                 'threshold', v_t.amount,
                 'balance', v_balance,
                 'crossingId', v_crossing_id,
                 'label', v_t.label
               ),
               false
          FROM ordered o
        RETURNING 1
      )
      SELECT count(*) INTO v_members FROM told;

      UPDATE public.bbj_threshold_crossings
         SET notified_count = COALESCE(v_members, 0)
       WHERE id = v_crossing_id;

      v_crossings := v_crossings + 1;
      v_notified  := v_notified + COALESCE(v_members, 0);
    EXCEPTION WHEN OTHERS THEN
      /* The crossing row rolls back with the fan-out, so the threshold stays
         ARMED and the next run tries again. Recording a crossing that told
         nobody would silence this club's jackpot for good. */
      v_failed := v_failed + 1;
      RAISE WARNING '[bbj-threshold] club % threshold % could not be announced: % (%). It stays armed.',
        v_t.club_id, v_t.amount, SQLERRM, SQLSTATE;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'crossings', v_crossings,
    'notified', v_notified,
    'failed', v_failed
  );
END $function$;

COMMENT ON FUNCTION public.fn_bbj_notify_thresholds() IS
  'Tells every active member of a club when its Bad Beat Jackpot crosses a threshold the club set, once per crossing, re-arming when the jackpot is next hit. Fans out in user_id order because the notifications FK takes a per-profile lock and an arbitrary order deadlocked against live traffic. One club failing never costs the others theirs. Never runs on the money path. Operator surface: service_role only. BBJ phase 3.4.';

REVOKE ALL ON FUNCTION public.fn_bbj_notify_thresholds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_notify_thresholds() TO service_role;

COMMIT;
