-- 20261018200400_club_cards_show_a_member_boost.sql
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-18: "INCREASE ALL 3 CLUB 'MEMBERS SIZES' BE AN ARTIFICIAL 1000
-- USERS. SO TOTAL USERS ALL GO UP BY 1000 ON DISPLAYS."
--
-- The three Midway Union clubs (Club JAQK, Deep Stack Society, Shark Club)
-- each show 1,000 more members than they hold. The boost lives in ONE table,
-- club_display_member_boost, so it can be changed or removed by editing a row,
-- never by hunting through functions.
--
-- Display only. It is added in the four count functions that screens read:
--   fn_batch_club_realtime_member_counts  (carousel cards)
--   fn_get_club_realtime_member_count     (club home, club ladder)
--   fn_batch_club_member_counts           (club lists, union pages, detail)
--   fn_batch_union_realtime_member_counts (union card, union ladder; adds the
--                                          boosts of its member clubs, so
--                                          Midway Union shows +3,000)
-- Club level is computed from these counts and is display-only (read by
-- get_club_home and the cards; nothing gates on it), so it follows the shown
-- figure. Membership rows, wallets, seats, payouts and the active-player
-- counts are untouched: the boost is never a row in club_members.
--
-- No foreign key to clubs (CLAUDE.md DDL rule 7: no FK to a hot table).

BEGIN;

CREATE TABLE IF NOT EXISTS public.club_display_member_boost (
  club_id    uuid PRIMARY KEY,
  boost      integer NOT NULL CHECK (boost >= 0),
  reason     text NOT NULL,
  set_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.club_display_member_boost ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_display_member_boost FROM anon, authenticated;

INSERT INTO public.club_display_member_boost (club_id, boost, reason) VALUES
  ('a0000000-0000-0000-0000-000000000001', 1000, 'Dan 2026-10-18: display +1,000 members'),
  ('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3', 1000, 'Dan 2026-10-18: display +1,000 members'),
  ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4', 1000, 'Dan 2026-10-18: display +1,000 members')
ON CONFLICT (club_id) DO UPDATE SET boost = EXCLUDED.boost, reason = EXCLUDED.reason, set_at = now();

CREATE OR REPLACE FUNCTION public.fn_batch_club_realtime_member_counts(p_club_ids uuid[])
 RETURNS TABLE(club_id uuid, member_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT requested.club_id,
         (count(cm.user_id)
          + COALESCE((SELECT b.boost FROM public.club_display_member_boost b
                       WHERE b.club_id = requested.club_id), 0))::bigint
    FROM unnest(p_club_ids) requested(club_id)
    LEFT JOIN public.club_members cm ON cm.club_id = requested.club_id
      AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
   GROUP BY requested.club_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_club_realtime_member_count(p_club_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT (count(*)
          + COALESCE((SELECT b.boost FROM public.club_display_member_boost b
                       WHERE b.club_id = p_club_id), 0))::bigint
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id
     AND (cm.status IS NULL OR cm.status IN ('active', 'approved'));
$function$;

CREATE OR REPLACE FUNCTION public.fn_batch_club_member_counts(p_club_ids uuid[])
 RETURNS TABLE(club_id uuid, member_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT cm.club_id,
         (COUNT(*)
          + COALESCE((SELECT b.boost FROM public.club_display_member_boost b
                       WHERE b.club_id = cm.club_id), 0))::bigint AS member_count
  FROM club_members cm
  WHERE cm.club_id = ANY(p_club_ids)
    AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
  GROUP BY cm.club_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_member_counts(p_union_ids uuid[])
 RETURNS TABLE(union_id uuid, member_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  -- One person is one member, however many of the union's clubs they belong
  -- to (2026-10-18), plus the display boost of each member club.
  SELECT requested.union_id,
         ((SELECT count(DISTINCT cm.user_id)
             FROM public.union_clubs uc
             JOIN public.club_members cm ON cm.club_id = uc.club_id
              AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
            WHERE uc.union_id = requested.union_id)
          + COALESCE((SELECT sum(b.boost)
                        FROM public.union_clubs uc
                        JOIN public.club_display_member_boost b ON b.club_id = uc.club_id
                       WHERE uc.union_id = requested.union_id), 0))::bigint
    FROM (SELECT DISTINCT r.union_id FROM unnest(p_union_ids) r(union_id)) requested;
$function$;

COMMIT;
