-- 20261002225448_a_browser_moves_only_the_reel_counters_it_is_the_evidence_fo.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Telemetry Exposure (run 37071022389) reported two routines open to the
-- browser: public.increment_reel_count(uuid,text) and
-- public.decrement_reel_count(uuid,text). Both are SECURITY DEFINER, both are
-- executable by `authenticated`, and neither has ever looked at who is calling.
-- A single logged-in account could therefore set any reel's like_count,
-- comment_count, share_count or view_count to anything it liked, on any
-- author's reel, by calling the RPC in a loop. RLS does not apply inside a
-- definer, so "Users can update own reels" never saw those writes.
--
-- READ BEFORE CHANGING THE GRANTS: nothing here is widened. `authenticated`
-- keeps exactly the EXECUTE it has today, because the World Hub's reel player
-- really does call these from the browser. What changes is that the routine now
-- consults the caller and refuses the two counters a browser must not write.
--
-- WHAT A BROWSER ACTUALLY ASKS FOR, read from the callers rather than assumed:
--
--   Smarter-Poker-World-Hub pages/hub/reels.js:1535,2153,2212
--   Smarter-Poker-World-Hub src/components/social/Reels.jsx:726,1788,1847
--   Smarter-Poker-World-Hub src/components/social/ReelsFeedCarousel.jsx:1642,1679,1802
--
-- Every one of those nine call sites passes 'view_count' or 'share_count', and
-- always +1. No browser call site anywhere passes like_count or comment_count,
-- and no browser call site decrements. Those two counters already have a table
-- of truth and a trigger that keeps them: trg_sync_like_count on
-- public.social_likes and trig_update_reel_comment_count on
-- public.social_comments. A browser write to them is a double count as well as
-- the abuse vector.
--
-- The World Hub's own server routes keep the full field set, because they hold
-- the service key and they are the reconciling writer:
--   pages/api/social/interactions.js:186,370  (like_count / comment_count)
--   pages/api/social/share-count.js:100       (share_count)
-- Both prefer SUPABASE_SERVICE_ROLE_KEY. Their NEXT_PUBLIC anon fallback could
-- never execute these routines anyway: `anon` has held no EXECUTE on them since
-- the 2026-08-31 definer sweep, and this migration revokes it again explicitly
-- so a later blanket GRANT line has to be deliberate.
--
-- So, for a request that arrives with an anon or authenticated JWT:
--   * auth.uid() must be a real viewer, and
--   * p_field must be share_count or view_count.
-- Everything else about the routines - the field allowlist, the
-- social_reel_aliases canonicalisation added by the World Hub's
-- 20261001221500_social_reel_alias_reconciliation.sql, the GREATEST(...,0)
-- floor - is unchanged.
--
-- WHY NOT JUST DROP SECURITY DEFINER, like the social_posts siblings?
-- increment_post_count/decrement_post_count are SECURITY INVOKER, which is why
-- they never appear in this report - and also why, under "Users can update own
-- posts", a viewer bumping somebody else's post counter updates zero rows. For
-- reels the product wants a viewer's view and share to count, and the alias
-- table is service-role-only under RLS, so an invoker routine would lose the
-- canonicalisation that landed yesterday. Consulting the caller is the fix that
-- keeps both.
--
-- THIS FUNCTION'S SOURCE OF TRUTH LIVES IN THE WORLD HUB. If you are editing
-- these routines there, keep the caller check: without it Club Arena's
-- Telemetry Exposure goes red again, which is how this hole was found.
--
-- RECONCILED WITH PHASE 3, 2026-10-02 (before this file was ever applied).
-- 20261002223109_a_counter_is_not_a_public_write and
-- 20261002232011_a_stale_tab_counts_through_the_same_door reached the same
-- two routines from the other side and were applied first. Applied as merged,
-- this file would have let a signed-in browser add a view in a loop (no
-- once-a-day key) and take a view or share DOWN. The bodies below keep every
-- check this file introduced, word for word, and add the two that close
-- those: a browser's view or share goes through fn_count_content_engagement
-- (one per player per content per day, auth.uid() the subject), and a browser
-- never decrements. This is the text that ran; it is identical to the reel
-- bodies in 20261002232011, so the two can be applied in either order.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('increment_reel_count','decrement_reel_count') AND p.prosrc LIKE '%auth.uid()%' AND p.prosrc LIKE '%auth.role()%' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.increment_reel_count(p_reel_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $function$
DECLARE
  v_target uuid;
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'increment_reel_count: invalid field %', p_field;
  END IF;
  -- A browser reports its own view or share, once a day, and nothing else.
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    IF v_request_role IN ('anon', 'authenticated') THEN
      IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'increment_reel_count: a signed-in viewer is required'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    IF p_field NOT IN ('share_count', 'view_count') THEN
      RAISE EXCEPTION 'increment_reel_count: % is kept from social_likes/social_comments, not from a browser', p_field
        USING ERRCODE = '42501';
    END IF;
    IF p_field = 'view_count' THEN
      PERFORM public.fn_count_content_engagement(p_reel_id, 'view', 'reels');
    ELSIF p_field = 'share_count' THEN
      PERFORM public.fn_count_content_engagement(p_reel_id, 'share', 'reels');
    ELSE
      RAISE EXCEPTION 'increment_reel_count: % is not a browser''s to write', p_field USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed
  LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format(
    'UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) + 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING v_target;
END
$function$;

CREATE OR REPLACE FUNCTION public.decrement_reel_count(p_reel_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $function$
DECLARE
  v_target uuid;
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
BEGIN
  IF p_field IS NULL OR NOT (p_field = ANY(ARRAY['like_count','comment_count','share_count','view_count']::text[])) THEN
    RAISE EXCEPTION 'decrement_reel_count: invalid field %', p_field;
  END IF;
  -- A browser never takes a count down: the view or share it reported is a
  -- receipt, and like and comment counts are the triggers' to keep.
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    IF v_request_role IN ('anon', 'authenticated') THEN
      IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'decrement_reel_count: a signed-in viewer is required'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    IF p_field NOT IN ('share_count', 'view_count') THEN
      RAISE EXCEPTION 'decrement_reel_count: % is kept from social_likes/social_comments, not from a browser', p_field
        USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'decrement_reel_count: a count is not a browser''s to take down' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(a.canonical_reel_id, p_reel_id) INTO v_target
  FROM (SELECT 1) seed
  LEFT JOIN public.social_reel_aliases a ON a.alias_reel_id = p_reel_id;
  EXECUTE format(
    'UPDATE public.social_reels SET %I = GREATEST(COALESCE(%I, 0) - 1, 0) WHERE id = $1',
    p_field, p_field
  ) USING v_target;
END
$function$;

-- Exactly the reachability these routines already had on 2026-10-02: PUBLIC and
-- anon hold nothing, the browser role and the service role hold EXECUTE.
REVOKE ALL ON FUNCTION public.increment_reel_count(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decrement_reel_count(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_reel_count(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decrement_reel_count(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.increment_reel_count(uuid, text) IS
  'Atomic reel engagement counter. A browser caller must be a signed-in viewer and may add only its own view or share, at most once a day per reel, through fn_count_content_engagement; like_count and comment_count are kept by the triggers on social_likes and social_comments and are service-side only. See 20261002225448 and 20261002232011.';
COMMENT ON FUNCTION public.decrement_reel_count(uuid, text) IS
  'Atomic reel engagement counter. Service-side only: a browser caller never takes a count down. See 20261002225448 and 20261002232011.';

COMMIT;
