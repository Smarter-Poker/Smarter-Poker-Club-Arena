-- 20260906234056_the_jackpot_says_when_it_crosses_a_number_the_club_chose.sql
--
-- Named for the version the Supabase MCP recorded when it applied this.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE JACKPOT SAYS WHEN IT CROSSES A NUMBER THE CLUB CHOSE
--  BBJ build plan phase 3.4 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR. A Bad Beat Jackpot grows a few chips a hand and is hit
-- about once a fortnight. Between those two facts sits the only marketing the
-- feature has ever needed: the moment it passes a number that makes a player
-- want to sit down. Until now nobody was told - a player had to be looking at
-- a screen that happened to show the figure.
--
-- IT IS A CLUB SETTING, keyed by CLUB and not by pool. A union banks one
-- jackpot for all of its clubs, so pool-keyed thresholds would make one club's
-- operator decide when another club's members get told. Each club sets its own
-- numbers and each notifies its own members; they read the same shared pool,
-- which is correct, because it is the same jackpot.
--
-- ═══ THREE THINGS IT DELIBERATELY DOES NOT DO ═══════════════════════════════
--
-- 1. IT NEVER RUNS ON THE MONEY PATH. The obvious implementation is a trigger
--    on `bbj_pools`, and it is the wrong one: that row is updated on every
--    raked hand - 40,219 times in twenty-four hours, measured on production
--    2026-09-06 - and every one of those updates is inside the transaction
--    that is taking a player's rake. A notification fan-out that can be slow,
--    or can fail, has no business in there. This is a periodic reader instead:
--    it looks at a balance that has already been committed, and the worst a
--    failure can do is delay a message.
--
-- 2. IT DOES NOT FIRE TWICE FOR ONE CROSSING. Every crossing is recorded, and
--    a threshold is armed again only when the pool has been HIT since - which
--    is the only thing that lowers it. Without that, a balance sitting one
--    chip above the number would notify every member every five minutes for a
--    fortnight, and the first thing anyone would do is turn notifications off.
--
-- 3. IT DOES NOT SKIP THE HORSES. CLAUDE.md 10.5 is a hard law and this is
--    exactly the shape it was written about: a fan-out where somebody reaches
--    for `AND NOT is_horse` because "a horse has no browser". A horse is a
--    member, notified through the same path the payout notification already
--    uses for them (server/src/services/supabase/bbj.ts, phase 1.1). The whole
--    estate is 445 active members; the largest club is 418. The volume
--    argument does not exist, and it would not matter if it did.
--
-- ═══ SCALE, MEASURED ════════════════════════════════════════════════════════
--   3 active pools - 445 active club members - largest club 418
--   255 notifications inserted in the last 24h across the whole platform
-- A crossing therefore writes at most a few hundred rows, a few times a month.
--
-- NOTE FOR ANYONE REBUILDING FROM THESE FILES: the fan-out in the function
-- below is the version that was APPLIED here, and it deadlocked against live
-- traffic on the first probe. 20260906234244 replaces it with the ordered one
-- and explains why. Both are kept because this is the record of what ran.
--
-- ROLLBACK:
--   SELECT cron.unschedule('ca-bbj-threshold-notify-5m');
--   DROP FUNCTION IF EXISTS public.fn_bbj_notify_thresholds();
--   DROP TABLE IF EXISTS public.bbj_threshold_crossings;
--   DROP TABLE IF EXISTS public.bbj_notify_thresholds;

BEGIN;

CREATE TABLE IF NOT EXISTS public.bbj_notify_thresholds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES public.clubs (id) ON DELETE CASCADE,
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  label       text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, amount)
);

COMMENT ON TABLE public.bbj_notify_thresholds IS
  'Per-club Bad Beat Jackpot notification thresholds. When the club''s pool crosses `amount`, every active member of THAT club is told once, and the threshold re-arms when the jackpot is next hit. BBJ phase 3.4.';

CREATE TABLE IF NOT EXISTS public.bbj_threshold_crossings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  threshold_id     uuid NOT NULL REFERENCES public.bbj_notify_thresholds (id) ON DELETE CASCADE,
  club_id          uuid NOT NULL REFERENCES public.clubs (id) ON DELETE CASCADE,
  pool_id          uuid,
  threshold_amount numeric(14, 2) NOT NULL,
  balance_at_cross numeric(14, 2) NOT NULL,
  notified_count   integer NOT NULL DEFAULT 0,
  crossed_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bbj_threshold_crossings IS
  'One row per time a club''s jackpot crossed one of its thresholds, and how many members were told. This is what stops a balance parked above the number notifying everybody every five minutes. BBJ phase 3.4.';

CREATE INDEX IF NOT EXISTS bbj_threshold_crossings_threshold_time_idx
  ON public.bbj_threshold_crossings (threshold_id, crossed_at DESC);

ALTER TABLE public.bbj_notify_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bbj_threshold_crossings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bbj_thresholds_member_select ON public.bbj_notify_thresholds;
CREATE POLICY bbj_thresholds_member_select ON public.bbj_notify_thresholds
  FOR SELECT TO authenticated
  USING (public.fn_is_club_member_uid(club_id));

DROP POLICY IF EXISTS bbj_thresholds_admin_write ON public.bbj_notify_thresholds;
CREATE POLICY bbj_thresholds_admin_write ON public.bbj_notify_thresholds
  FOR ALL TO authenticated
  USING (public.fn_is_club_admin_uid(club_id))
  WITH CHECK (public.fn_is_club_admin_uid(club_id));

DROP POLICY IF EXISTS bbj_crossings_admin_select ON public.bbj_threshold_crossings;
CREATE POLICY bbj_crossings_admin_select ON public.bbj_threshold_crossings
  FOR SELECT TO authenticated
  USING (public.fn_is_club_admin_uid(club_id));

-- THE GRANTS ARE NAMED, not inherited. A new table in `public` is granted ALL
-- to anon and authenticated by default, and RLS is then the only thing between
-- a browser and the row - which holds right up until somebody adds a
-- permissive FOR ALL policy for a reason that sounds good. (Phase 2 shipped
-- exactly that latent hazard on bbj_unclaimed_shares and had to come back for
-- it; this one is named at birth.)
REVOKE ALL ON public.bbj_notify_thresholds FROM PUBLIC, anon;
REVOKE ALL ON public.bbj_threshold_crossings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bbj_notify_thresholds TO authenticated;
GRANT SELECT ON public.bbj_threshold_crossings TO authenticated;
GRANT ALL ON public.bbj_notify_thresholds TO service_role;
GRANT ALL ON public.bbj_threshold_crossings TO service_role;

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
  v_crossing_id    uuid;
BEGIN
  FOR v_t IN
    SELECT th.id, th.club_id, th.amount, th.label
      FROM public.bbj_notify_thresholds th
     WHERE th.enabled
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

    INSERT INTO public.bbj_threshold_crossings
      (threshold_id, club_id, pool_id, threshold_amount, balance_at_cross)
    VALUES (v_t.id, v_t.club_id, v_pool_id, v_t.amount, v_balance)
    RETURNING id INTO v_crossing_id;

    WITH told AS (
      INSERT INTO public.notifications (user_id, type, title, message, metadata, read)
      SELECT cm.user_id,
             'bonus',
             'The Bad Beat Jackpot Just Passed $' || trim(to_char(v_t.amount, 'FM999,999,999.00')),
             'The jackpot at ' || COALESCE(c.name, 'your club') || ' is now $' ||
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
        FROM public.club_members cm
        JOIN public.clubs c ON c.id = cm.club_id
       WHERE cm.club_id = v_t.club_id
         AND cm.status = 'active'
      RETURNING 1
    )
    SELECT count(*) INTO v_members FROM told;

    UPDATE public.bbj_threshold_crossings
       SET notified_count = COALESCE(v_members, 0)
     WHERE id = v_crossing_id;

    v_crossings := v_crossings + 1;
    v_notified  := v_notified + COALESCE(v_members, 0);
  END LOOP;

  RETURN jsonb_build_object('crossings', v_crossings, 'notified', v_notified);
END $function$;

COMMENT ON FUNCTION public.fn_bbj_notify_thresholds() IS
  'Tells every active member of a club when its Bad Beat Jackpot crosses a threshold the club set, once per crossing, re-arming when the jackpot is next hit. Never runs on the money path. Operator surface: service_role only. BBJ phase 3.4.';

REVOKE ALL ON FUNCTION public.fn_bbj_notify_thresholds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_notify_thresholds() TO service_role;

COMMIT;
