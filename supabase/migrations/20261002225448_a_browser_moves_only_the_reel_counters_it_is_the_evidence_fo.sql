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
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('increment_reel_count','decrement_reel_count') AND p.prosrc LIKE '%auth.uid()%' AND p.prosrc LIKE '%auth.role()%' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))

BEGIN;

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
  -- A PostgREST request carries its role in the JWT. anon/authenticated is a
  -- browser; service_role is the World Hub's own reconciling route; NULL is a
  -- database session (pg_cron, psql, a migration) and is not a browser either.
  IF v_request_role IN ('anon', 'authenticated') THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'increment_reel_count: a signed-in viewer is required'
        USING ERRCODE = '42501';
    END IF;
    IF p_field NOT IN ('share_count', 'view_count') THEN
      RAISE EXCEPTION 'increment_reel_count: % is kept from social_likes/social_comments, not from a browser', p_field
        USING ERRCODE = '42501';
    END IF;
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
  IF v_request_role IN ('anon', 'authenticated') THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'decrement_reel_count: a signed-in viewer is required'
        USING ERRCODE = '42501';
    END IF;
    IF p_field NOT IN ('share_count', 'view_count') THEN
      RAISE EXCEPTION 'decrement_reel_count: % is kept from social_likes/social_comments, not from a browser', p_field
        USING ERRCODE = '42501';
    END IF;
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
  'Atomic reel engagement counter. A browser caller must be a signed-in viewer and may move only share_count or view_count; like_count and comment_count are kept by the triggers on social_likes and social_comments and are service-side only. See 20261002225448.';
COMMENT ON FUNCTION public.decrement_reel_count(uuid, text) IS
  'Atomic reel engagement counter. A browser caller must be a signed-in viewer and may move only share_count or view_count; like_count and comment_count are kept by the triggers on social_likes and social_comments and are service-side only. See 20261002225448.';

COMMIT;
