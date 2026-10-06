-- Applied to production as version 20261006040333 (match by name).
--
-- players_share_sports_reels_and_youtube_reel_thumbnail_at_creation
--
-- Law: a player must never be able to tell a horse from a human. Two Reel
-- shapes differed by author:
--   1. Topic. Horses publish Sports Reels (publish_horse_video_reel accepts
--      poker|sports); publish_user_video_reel accepted poker|cash|tournament
--      only, so every public Sports Reel was a horse's.
--   2. Thumbnail. Every Reel row is inserted by fn_social_posts_video_to_reel_mirror
--      (or the publish_user_video_reel fallback) with the post's thumbnail,
--      which is NULL for a YouTube post. A stale sweep on the reels transcode
--      VM (iframeThumbnailDeriveSweep, removed from main in #1977 but still
--      running there) later PATCHes img.youtube.com/vi/<id>/hqdefault.jpg into
--      public ready rows 8 to 12 minutes after insert. Whether and when a Reel
--      got a thumbnail therefore depended on that sweep, not on the write.
--
-- Fix at the write:
--   * public.user_reel_topics() is the one list of Reel topics a player may
--     attest: poker, sports (the two a horse publishes). The composer reads it
--     to decide whether to offer Sports; publish_user_video_reel enforces it.
--   * public.fn_youtube_reel_thumbnail_url(id) is the one YouTube Reel
--     thumbnail. Both Reel inserts set it for every YouTube Reel that is not a
--     managed library Reel, whoever the author is, so no later writer is needed.
--   * publish_user_video_reel stores no client thumbnail on a YouTube post
--     (a horse YouTube post has none) and records metadata.topic like the
--     horse publisher does.
--   * fn_social_post_topics honours a post's declared metadata.topic, then
--     metadata.clip_type, when no primary is known yet. Author-neutral: no
--     existing row changes (asserted below).
--
-- Apply in one transaction, never between :50 and :03 UTC (asserted).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── Preflight ──────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_minute integer := extract(minute FROM (clock_timestamp() AT TIME ZONE 'UTC'))::integer;
BEGIN
  IF v_minute >= 50 OR v_minute < 3 THEN
    RAISE EXCEPTION 'refusing to apply between :50 and :03 UTC (minute %)', v_minute;
  END IF;

  IF md5(pg_get_functiondef('public.publish_user_video_reel(text,text,boolean,text,text,text)'::regprocedure))
       IS DISTINCT FROM 'b04f1c158ea851a9471c50e6455a7ddb' THEN
    RAISE EXCEPTION 'publish_user_video_reel drifted from the reviewed definition';
  END IF;
  IF md5(pg_get_functiondef('public.fn_social_posts_video_to_reel_mirror()'::regprocedure))
       IS DISTINCT FROM 'e93f449a35010868750d7492d6df43cd' THEN
    RAISE EXCEPTION 'fn_social_posts_video_to_reel_mirror drifted from the reviewed definition';
  END IF;
  IF md5(pg_get_functiondef('public.fn_social_post_topics(text,text[],text,text,jsonb)'::regprocedure))
       IS DISTINCT FROM '1e29230a525e1e7715638799628c6135' THEN
    RAISE EXCEPTION 'fn_social_post_topics drifted from the reviewed definition';
  END IF;
  IF to_regprocedure('public.user_reel_topics()') IS NOT NULL THEN
    RAISE EXCEPTION 'public.user_reel_topics() already exists';
  END IF;
  IF to_regprocedure('public.fn_youtube_reel_thumbnail_url(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'public.fn_youtube_reel_thumbnail_url(text) already exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.social_posts'::regclass
      AND tgname = 'trg_social_posts_video_to_reel_mirror'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_social_posts_video_to_reel_mirror is not installed and enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.social_posts'::regclass
      AND tgname = 'trg_social_posts_zz_derive_topics'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_social_posts_zz_derive_topics is not installed and enabled';
  END IF;
  -- The canonical thumbnail is what every horse YouTube Reel already carries.
  IF EXISTS (
    SELECT 1
    FROM public.social_reels r
    JOIN public.profiles p ON p.id = r.author_id
    WHERE p.is_horse IS TRUE
      AND r.youtube_video_id IS NOT NULL
      AND COALESCE(r.is_deleted, false) = false
      AND r.thumbnail_url IS DISTINCT FROM
        'https://img.youtube.com/vi/' || r.youtube_video_id || '/hqdefault.jpg'
  ) THEN
    RAISE EXCEPTION 'a horse YouTube Reel carries a non-canonical thumbnail; review before applying';
  END IF;
END
$preflight$;

-- Baseline of the topics rule for every post this change could touch.
CREATE TEMP TABLE _sports_reels_topics_baseline ON COMMIT DROP AS
SELECT p.id,
       public.fn_social_post_topics(p.topic, p.topics, p.content_type, p.content, p.metadata) AS derived
FROM public.social_posts p
WHERE p.metadata ? 'topic' OR p.metadata ? 'clip_type';

-- ── The one list of Reel topics a player may attest ────────────────────────
CREATE FUNCTION public.user_reel_topics()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  -- The two topics a horse publishes (publish_horse_video_reel). A player
  -- may attest exactly the same ones.
  SELECT ARRAY['poker', 'sports']::text[]
$function$;

COMMENT ON FUNCTION public.user_reel_topics() IS
  'Reel topics a player may attest in publish_user_video_reel; the composer offers exactly these.';

REVOKE ALL ON FUNCTION public.user_reel_topics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_reel_topics() TO authenticated, service_role;

-- ── The one YouTube Reel thumbnail ─────────────────────────────────────────
CREATE FUNCTION public.fn_youtube_reel_thumbnail_url(p_youtube_video_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN p_youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
      THEN 'https://img.youtube.com/vi/' || p_youtube_video_id || '/hqdefault.jpg'
    ELSE NULL
  END
$function$;

COMMENT ON FUNCTION public.fn_youtube_reel_thumbnail_url(text) IS
  'The thumbnail every YouTube Reel gets at insert, whoever the author is.';

REVOKE ALL ON FUNCTION public.fn_youtube_reel_thumbnail_url(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_youtube_reel_thumbnail_url(text) TO authenticated, service_role;

-- ── publish_user_video_reel ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.publish_user_video_reel(p_video_url text, p_topic text, p_topic_confirmed boolean, p_caption text DEFAULT NULL::text, p_thumbnail_url text DEFAULT NULL::text, p_visibility text DEFAULT 'public'::text)
 RETURNS TABLE(social_post_id uuid, social_reel_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_author_id uuid := auth.uid();
  v_role text := COALESCE(auth.role()::text, '');
  v_video_url text := btrim(COALESCE(p_video_url, ''));
  v_youtube_id text;
  v_topic text := lower(btrim(COALESCE(p_topic, '')));
  v_visibility text := lower(btrim(COALESCE(p_visibility, 'public')));
  v_playback_type text;
  v_rights_status text;
  v_canonical_key text;
  v_author_is_horse boolean := false;
  v_post public.social_posts%ROWTYPE;
  v_post_id uuid;
  v_reel_id uuid;
BEGIN
  IF v_role <> 'authenticated' OR v_author_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'publish_user_video_reel requires an authenticated user';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_author_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'a valid author profile is required';
  END IF;

  -- The post contract trigger changes a horse profile's user_upload origin
  -- to horse. Retrying after a lost response must therefore look for that
  -- trigger-produced origin too, but only for the authenticated horse owner.
  SELECT COALESCE(p.is_horse, false)
  INTO v_author_is_horse
  FROM public.profiles p
  WHERE p.id = v_author_id;

  -- A player attests the same Reel topics a horse publishes
  -- (public.user_reel_topics(): poker, sports). cash and tournament remain
  -- accepted poker formats for existing callers.
  IF p_topic_confirmed IS DISTINCT FROM true
     OR NOT (
       v_topic = ANY (public.user_reel_topics())
       OR v_topic IN ('cash', 'tournament')
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'an explicit poker or sports topic confirmation is required';
  END IF;

  IF v_visibility NOT IN ('public', 'private') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'visibility must be public or private';
  END IF;

  IF octet_length(v_video_url) = 0 OR octet_length(v_video_url) > 4096 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'a valid video URL is required';
  END IF;

  v_youtube_id := public.fn_extract_youtube_video_id(v_video_url);
  IF v_youtube_id IS NOT NULL AND v_video_url ~* '^https://' THEN
    v_video_url := 'https://www.youtube.com/watch?v=' || v_youtube_id;
    v_playback_type := 'youtube_embed';
    v_rights_status := 'embed_only';
    v_canonical_key := 'youtube:' || v_youtube_id;
    -- The post remains owner-visible but public RLS keeps it pending until the
    -- trusted verifier proves it public, embeddable, and subscription-free.
    PERFORM public.fn_queue_youtube_verification(
      v_youtube_id,
      'user_reel_publication'
    );
  ELSIF public.fn_is_user_video_storage_url(v_video_url, v_author_id) THEN
    -- The proof helper already rejects query/fragment variants and accepts an
    -- exact public object URL only. Normalize defensively before hashing so
    -- the persisted canonical identity always uses the bare object URL.
    v_video_url := split_part(split_part(v_video_url, '?', 1), '#', 1);
    v_playback_type := 'native';
    v_rights_status := 'user_authorized';
    v_canonical_key := 'native:' || md5(v_video_url);
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'video URL must be a YouTube embed or an uploaded video from your Smarter.Poker Storage namespace';
  END IF;

  -- A response can be lost after COMMIT, and multiple tabs can submit the
  -- same asset concurrently. Serialize on the caller-owned canonical identity
  -- before looking for prior work so every retry observes the first commit.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'publish-user-video-reel:' || v_author_id::text || ':' || v_canonical_key,
      0
    )
  );

  SELECT p.*
  INTO v_post
  FROM public.social_posts p
  WHERE p.author_id = v_author_id
    AND (
      p.origin_type = 'user_upload'
      OR (v_author_is_horse AND p.origin_type = 'horse')
    )
    AND p.content_type = 'video'
    AND COALESCE(p.is_deleted, false) = false
    AND p.canonical_asset_key = v_canonical_key
    AND (
      (
        v_youtube_id IS NOT NULL
        AND public.fn_extract_youtube_video_id(
          NULLIF(p.media_urls ->> 0, '')
        ) = v_youtube_id
      )
      OR (
        v_youtube_id IS NULL
        AND NULLIF(p.media_urls ->> 0, '') = v_video_url
      )
    )
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1
  FOR UPDATE;

  IF v_post.id IS NULL THEN
    INSERT INTO public.social_posts (
      author_id,
      content,
      content_type,
      media_urls,
      visibility,
      audience_mode,
      thumbnail_url,
      metadata,
      topics,
      origin_type,
      playback_type,
      topic,
      rights_status,
      youtube_video_id,
      canonical_asset_key
    ) VALUES (
      v_author_id,
      COALESCE(p_caption, ''),
      'video',
      jsonb_build_array(v_video_url),
      v_visibility,
      CASE WHEN v_visibility = 'private' THEN 'only_me' ELSE 'public' END,
      -- A YouTube post carries no stored thumbnail, exactly like a horse
      -- YouTube post; its Reel gets the canonical one below. A native upload
      -- keeps the poster the player's client extracted.
      CASE
        WHEN v_youtube_id IS NOT NULL THEN NULL
        ELSE NULLIF(btrim(p_thumbnail_url), '')
      END,
      jsonb_build_object(
        'topic', v_topic,
        'topic_attested', true,
        'topic_attested_by', v_author_id,
        'topic_attested_at', now()
      ),
      ARRAY[v_topic]::text[],
      'user_upload',
      v_playback_type,
      v_topic,
      v_rights_status,
      v_youtube_id,
      v_canonical_key
    )
    RETURNING * INTO v_post;
  ELSIF lower(COALESCE(v_post.visibility, 'public')) IS DISTINCT FROM v_visibility
     OR COALESCE(
          v_post.audience_mode,
          CASE WHEN lower(COALESCE(v_post.visibility, 'public')) = 'private'
            THEN 'only_me' ELSE 'public' END
        ) IS DISTINCT FROM (
          CASE WHEN v_visibility = 'private' THEN 'only_me' ELSE 'public' END
        )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'an existing publication has different visibility; refusing to change privacy on retry';
  END IF;

  v_post_id := v_post.id;

  SELECT r.id
  INTO v_reel_id
  FROM public.social_reels r
  WHERE r.source_post_id = v_post_id
    AND r.author_id = v_author_id
    AND COALESCE(r.is_deleted, false) = false
  ORDER BY r.created_at ASC NULLS LAST, r.id ASC
  LIMIT 1
  FOR UPDATE;

  IF v_reel_id IS NULL THEN
    INSERT INTO public.social_reels (
      author_id,
      video_url,
      thumbnail_url,
      caption,
      source_post_id,
      is_public,
      source_type,
      youtube_video_id,
      original_youtube_url,
      media_status,
      origin_type,
      playback_type,
      topic,
      rights_status,
      canonical_asset_key,
      native_processing_requested
    ) VALUES (
      v_post.author_id,
      NULLIF(v_post.media_urls ->> 0, ''),
      CASE
        WHEN v_post.youtube_video_id IS NOT NULL
          THEN public.fn_youtube_reel_thumbnail_url(v_post.youtube_video_id)
        ELSE v_post.thumbnail_url
      END,
      v_post.content,
      v_post_id,
      v_post.visibility = 'public',
      CASE
        WHEN v_post.playback_type = 'native' THEN 'native'
        WHEN v_post.youtube_video_id IS NOT NULL THEN 'youtube'
        ELSE 'user'
      END,
      v_post.youtube_video_id,
      CASE
        WHEN v_post.youtube_video_id IS NOT NULL
          THEN NULLIF(v_post.media_urls ->> 0, '')
        ELSE NULL
      END,
      'ready',
      'social_post',
      v_post.playback_type,
      v_post.topic,
      v_post.rights_status,
      v_post.canonical_asset_key,
      false
    )
    RETURNING id INTO v_reel_id;
  END IF;

  IF v_reel_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'atomic user Reel publication did not create a linked Reel';
  END IF;

  -- The deep link is publication state, not optional client decoration. Keep
  -- it in this transaction so a lost response can never leave a successfully
  -- published post without a route to its Reel. Avoid a no-op replay update so
  -- legacy updated_at triggers retain the original publication timestamp.
  UPDATE public.social_posts p
  SET link_url = '/hub/reels?id=' || v_reel_id::text
  WHERE p.id = v_post_id
    AND p.author_id = v_author_id
    AND p.link_url IS DISTINCT FROM '/hub/reels?id=' || v_reel_id::text;

  RETURN QUERY SELECT v_post_id, v_reel_id;
END
$function$;

-- ── fn_social_posts_video_to_reel_mirror ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_social_posts_video_to_reel_mirror()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_first_url text;
  v_yt_id text;
  v_playback_type text;
  v_rights_status text;
  v_source_type text;
  v_origin_type text;
  v_thumbnail_url text;
BEGIN
  IF NEW.content_type IS DISTINCT FROM 'video'
     OR NEW.media_urls IS NULL
     OR jsonb_typeof(NEW.media_urls) <> 'array'
     OR jsonb_array_length(NEW.media_urls) = 0
  THEN
    RETURN NEW;
  END IF;

  v_first_url := NULLIF(NEW.media_urls ->> 0, '');
  IF v_first_url IS NULL THEN
    RETURN NEW;
  END IF;

  v_yt_id := public.fn_extract_youtube_video_id(v_first_url);
  v_playback_type := CASE
    WHEN v_yt_id IS NOT NULL THEN 'youtube_embed'
    ELSE NEW.playback_type
  END;
  v_rights_status := CASE
    WHEN v_yt_id IS NOT NULL
         AND NEW.rights_status NOT IN ('owned', 'licensed') THEN 'embed_only'
    ELSE NEW.rights_status
  END;
  v_source_type := CASE
    WHEN NEW.origin_type = 'video_library' THEN 'video_library'
    WHEN v_playback_type = 'native' THEN 'native'
    WHEN v_yt_id IS NOT NULL THEN 'youtube'
    ELSE 'user'
  END;
  v_origin_type := CASE
    WHEN NEW.origin_type = 'user_upload' THEN 'social_post'
    ELSE NEW.origin_type
  END;
  -- Every YouTube Reel gets the same thumbnail at insert, whoever wrote the
  -- post (horse or player). Managed library Reels keep their curated poster.
  v_thumbnail_url := CASE
    WHEN v_yt_id IS NOT NULL
         AND NEW.origin_type IS DISTINCT FROM 'video_library'
      THEN public.fn_youtube_reel_thumbnail_url(v_yt_id)
    ELSE NEW.thumbnail_url
  END;

  IF EXISTS (
    SELECT 1 FROM public.social_reels r WHERE r.source_post_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.publication_key IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.social_reels r
    WHERE r.origin_type = 'video_library'
      AND r.publication_key = NEW.publication_key
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.canonical_asset_key IS NOT NULL AND NEW.origin_type = 'video_library'
     AND EXISTS (
       SELECT 1
       FROM public.social_reels r
       WHERE r.origin_type = 'video_library'
         AND r.canonical_asset_key = NEW.canonical_asset_key
     )
  THEN
    RETURN NEW;
  END IF;

  IF NEW.origin_type <> 'video_library' AND EXISTS (
    SELECT 1
    FROM public.social_reels r
    WHERE r.author_id = NEW.author_id
      AND r.video_url = v_first_url
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.social_reels (
    author_id,
    video_url,
    thumbnail_url,
    caption,
    source_post_id,
    is_public,
    source_type,
    youtube_video_id,
    original_youtube_url,
    media_status,
    origin_type,
    playback_type,
    topic,
    rights_status,
    source_asset_id,
    canonical_asset_key,
    publication_key,
    native_processing_requested
  ) VALUES (
    NEW.author_id,
    v_first_url,
    v_thumbnail_url,
    NEW.content,
    NEW.id,
    COALESCE(NEW.visibility = 'public', false),
    v_source_type,
    v_yt_id,
    CASE WHEN v_yt_id IS NOT NULL THEN v_first_url ELSE NULL END,
    'ready',
    v_origin_type,
    v_playback_type,
    NEW.topic,
    v_rights_status,
    NEW.source_asset_id,
    COALESCE(
      NEW.canonical_asset_key,
      CASE WHEN v_yt_id IS NOT NULL THEN 'youtube:' || v_yt_id END
    ),
    NEW.publication_key,
    false
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Managed publication must remain atomic. Legacy user-post behavior keeps its
  -- historical best-effort mirror so an unrelated Reel error cannot lose a post.
  IF NEW.origin_type = 'video_library' THEN
    RAISE;
  END IF;
  RAISE WARNING 'fn_social_posts_video_to_reel_mirror skipped post % (%)', NEW.id, SQLERRM;
  RETURN NEW;
END
$function$;

-- ── fn_social_post_topics ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_social_post_topics(p_topic text, p_topics text[], p_content_type text, p_content text, p_metadata jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_primary text := lower(btrim(COALESCE(p_topic, '')));
  v_content_type text := lower(btrim(COALESCE(p_content_type, '')));
  v_meta jsonb := CASE WHEN jsonb_typeof(p_metadata) = 'object' THEN p_metadata ELSE '{}'::jsonb END;
  v_supplied text[] := ARRAY(
    SELECT lower(btrim(s.value))
      FROM unnest(COALESCE(p_topics, ARRAY[]::text[])) AS s(value)
     WHERE s.value IS NOT NULL);
  v_facets text[] := ARRAY[]::text[];
  v_grounded_type text;
  v_phase7_mode text;
  v_phase6_mode text;
  v_news_box text;
  v_news_type text;
  v_source text;
  v_video_type text;
  v_shared_reel_topic text;
  v_declared_topic text;
  v_clip_type text;
  v_out text[];
BEGIN
  -- Step 1: the primary comes from p_topic. cash and tournament are format
  -- facets under poker; a value outside the CHECK list is unknown, never an error.
  IF v_primary IN ('cash', 'tournament') THEN
    v_facets := v_facets || v_primary;
    v_primary := 'poker';
  ELSIF v_primary NOT IN ('unknown', 'poker', 'slots', 'sports', 'other') THEN
    v_primary := 'unknown';
  END IF;

  -- Step 2: an unknown primary takes the domain of the supplied topics, in the
  -- order fn_infer_video_topic uses. Supplied facets are kept (the video RPCs
  -- already write {poker,cash}; the workers pass what they know).
  IF v_primary = 'unknown' THEN
    IF v_supplied && ARRAY['poker', 'cash', 'tournament'] THEN
      v_primary := 'poker';
    ELSIF v_supplied && ARRAY['slots'] THEN
      v_primary := 'slots';
    ELSIF v_supplied && ARRAY['sports'] THEN
      v_primary := 'sports';
    END IF;
  END IF;
  v_facets := v_facets || ARRAY(
    SELECT s.value FROM unnest(v_supplied) AS s(value)
     WHERE s.value IN ('cash', 'tournament', 'hand', 'session', 'puzzle', 'story',
                       'news', 'club', 'local', 'strategy'));

  -- Step 3: facets from metadata (what the writer recorded about the post).
  v_grounded_type := lower(btrim(COALESCE(v_meta ->> 'grounded_type', '')));
  v_phase7_mode := lower(btrim(COALESCE(v_meta ->> 'phase7_mode', '')));
  v_phase6_mode := lower(btrim(COALESCE(v_meta ->> 'phase6_mode', '')));
  v_news_box := btrim(COALESCE(v_meta ->> 'news_box', ''));
  v_news_type := btrim(COALESCE(v_meta ->> 'news_type', ''));
  v_source := lower(btrim(COALESCE(v_meta ->> 'source', '')));
  v_video_type := lower(btrim(COALESCE(v_meta ->> 'video_type', '')));
  v_shared_reel_topic := lower(btrim(COALESCE(v_meta ->> 'shared_reel_topic', '')));
  v_declared_topic := lower(btrim(COALESCE(v_meta ->> 'topic', '')));
  v_clip_type := lower(btrim(COALESCE(v_meta ->> 'clip_type', '')));

  IF v_grounded_type = 'hand' THEN
    v_facets := array_append(v_facets, 'hand'::text);
  ELSIF v_grounded_type = 'session' THEN
    v_facets := array_append(v_facets, 'session'::text);
  END IF;
  IF v_meta ? 'puzzle' OR v_phase7_mode LIKE 'puzzle\_%' THEN
    v_facets := v_facets || ARRAY['hand', 'puzzle'];
  END IF;
  IF v_phase7_mode LIKE 'story\_%' THEN
    v_facets := array_append(v_facets, 'story'::text);
  END IF;
  IF v_phase6_mode = 'club_data_digest' THEN
    v_facets := array_append(v_facets, 'club'::text);
  END IF;
  IF v_phase6_mode IN ('local_event', 'seasonal_local') THEN
    v_facets := array_append(v_facets, 'local'::text);
  END IF;
  IF v_news_box <> '' OR v_news_type <> '' OR v_content_type = 'news' THEN
    v_facets := array_append(v_facets, 'news'::text);
  END IF;
  IF v_news_box IN ('2', '4') THEN
    v_facets := array_append(v_facets, 'tournament'::text);
  END IF;
  IF v_source = 'social_page_post' THEN
    v_facets := array_append(v_facets, 'club'::text);
  END IF;
  IF v_video_type IN ('cash', 'tournament') THEN
    v_facets := v_facets || v_video_type;
  END IF;
  IF v_primary = 'unknown' THEN
    IF v_shared_reel_topic IN ('poker', 'slots', 'sports', 'other') THEN
      v_primary := v_shared_reel_topic;
    ELSIF v_shared_reel_topic IN ('cash', 'tournament') THEN
      v_primary := 'poker';
      v_facets := v_facets || v_shared_reel_topic;
    END IF;
  END IF;
  -- The topic a post declares about itself. The horse video publisher and the
  -- player Reel publisher both write metadata.topic; collectors write
  -- clip_type. Whoever wrote the post, the same declaration gives the same
  -- primary.
  IF v_primary = 'unknown' THEN
    IF v_declared_topic IN ('poker', 'slots', 'sports', 'other') THEN
      v_primary := v_declared_topic;
    ELSIF v_declared_topic IN ('cash', 'tournament') THEN
      v_primary := 'poker';
      v_facets := v_facets || v_declared_topic;
    ELSIF v_clip_type IN ('poker', 'sports') THEN
      v_primary := v_clip_type;
    END IF;
  END IF;

  -- Step 4: facets from the content: a card token means the post carries a real hand.
  IF p_content ~ '\[\[sp-card:[2-9TJQKA][cdhs]\]\]' THEN
    v_facets := array_append(v_facets, 'hand'::text);
  END IF;

  -- Step 5: facets from content_type (the legacy strategy family).
  IF v_content_type = 'tournament_tip' THEN
    v_facets := v_facets || ARRAY['tournament', 'strategy'];
  ELSIF v_content_type IN ('article', 'gto_concept', 'poker_math', 'hand_reading', 'quick_tip', 'strategy_tip') THEN
    v_facets := array_append(v_facets, 'strategy'::text);
  END IF;

  -- Step 6: every facet above is a poker facet on this platform.
  IF v_primary = 'unknown' AND cardinality(v_facets) > 0 THEN
    v_primary := 'poker';
  END IF;

  -- Step 7: the primary first, then the distinct facets in a fixed order, at most 4 elements.
  v_out := ARRAY[v_primary] || ARRAY(
    SELECT f.name
      FROM unnest(ARRAY['cash', 'tournament', 'hand', 'session', 'puzzle', 'story',
                        'news', 'club', 'local', 'strategy']) WITH ORDINALITY AS f(name, ord)
     WHERE f.name = ANY (v_facets)
     ORDER BY f.ord);
  RETURN v_out[1:4];
EXCEPTION WHEN OTHERS THEN
  -- A derivation must never fail a write. Nothing above can fail on text and
  -- jsonb inputs, and if something ever does the row keeps a legal primary.
  RETURN ARRAY['unknown']::text[];
END
$function$;

-- ── Post checks (self-asserting; any failure rolls the whole change back) ──
DO $postcheck$
DECLARE
  v_changed integer;
  v_player uuid;
  v_post_id uuid;
  v_reel_id uuid;
  v_post record;
  v_reel record;
  v_rejected boolean;
  v_claims_before text := NULLIF(current_setting('request.jwt.claims', true), '');
  v_sub_before text := NULLIF(current_setting('request.jwt.claim.sub', true), '');
  v_role_before text := NULLIF(current_setting('request.jwt.claim.role', true), '');
BEGIN
  -- New definitions are installed and wired to the shared helpers.
  IF md5(pg_get_functiondef('public.publish_user_video_reel(text,text,boolean,text,text,text)'::regprocedure)) = 'b04f1c158ea851a9471c50e6455a7ddb'
     OR md5(pg_get_functiondef('public.fn_social_posts_video_to_reel_mirror()'::regprocedure)) = 'e93f449a35010868750d7492d6df43cd'
     OR md5(pg_get_functiondef('public.fn_social_post_topics(text,text[],text,text,jsonb)'::regprocedure)) = '1e29230a525e1e7715638799628c6135'
  THEN
    RAISE EXCEPTION 'post check: a function still has its old definition';
  END IF;
  IF position('public.user_reel_topics()' IN pg_get_functiondef('public.publish_user_video_reel(text,text,boolean,text,text,text)'::regprocedure)) = 0
     OR position('public.fn_youtube_reel_thumbnail_url(' IN pg_get_functiondef('public.publish_user_video_reel(text,text,boolean,text,text,text)'::regprocedure)) = 0
     OR position('public.fn_youtube_reel_thumbnail_url(' IN pg_get_functiondef('public.fn_social_posts_video_to_reel_mirror()'::regprocedure)) = 0
  THEN
    RAISE EXCEPTION 'post check: the Reel writers do not use the shared topic list and thumbnail';
  END IF;

  -- Capability list and grants.
  IF public.user_reel_topics() IS DISTINCT FROM ARRAY['poker', 'sports']::text[] THEN
    RAISE EXCEPTION 'post check: user_reel_topics() is %', public.user_reel_topics();
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.user_reel_topics()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.user_reel_topics()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'post check: user_reel_topics() grants are wrong';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.publish_user_video_reel(text,text,boolean,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post check: authenticated lost EXECUTE on publish_user_video_reel';
  END IF;

  -- The canonical thumbnail is what every horse YouTube Reel already carries.
  IF public.fn_youtube_reel_thumbnail_url('dQw4w9WgXcQ') IS DISTINCT FROM 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
     OR public.fn_youtube_reel_thumbnail_url('bad') IS NOT NULL
     OR public.fn_youtube_reel_thumbnail_url(NULL) IS NOT NULL
  THEN
    RAISE EXCEPTION 'post check: fn_youtube_reel_thumbnail_url is wrong';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.social_reels r
    JOIN public.profiles p ON p.id = r.author_id
    WHERE p.is_horse IS TRUE
      AND r.youtube_video_id IS NOT NULL
      AND COALESCE(r.is_deleted, false) = false
      AND r.thumbnail_url IS DISTINCT FROM public.fn_youtube_reel_thumbnail_url(r.youtube_video_id)
  ) THEN
    RAISE EXCEPTION 'post check: a horse YouTube Reel differs from the canonical thumbnail';
  END IF;

  -- The topics rule: the declared topic is author-neutral and no existing row changes.
  IF public.fn_social_post_topics(NULL, NULL, 'video', 'What a dunk', '{"topic":"sports"}'::jsonb) IS DISTINCT FROM ARRAY['sports']::text[]
     OR public.fn_social_post_topics(NULL, NULL, 'video', 'Walk-off', '{"clip_type":"sports"}'::jsonb) IS DISTINCT FROM ARRAY['sports']::text[]
     OR public.fn_social_post_topics(NULL, NULL, 'video', 'x', '{"topic":"tournament"}'::jsonb) IS DISTINCT FROM ARRAY['poker', 'tournament']::text[]
     OR public.fn_social_post_topics('poker', NULL, 'video', 'x', '{"topic":"sports"}'::jsonb) IS DISTINCT FROM ARRAY['poker']::text[]
     OR public.fn_social_post_topics(NULL, NULL, 'video', 'x', '{"shared_reel_topic":"slots","topic":"sports"}'::jsonb) IS DISTINCT FROM ARRAY['slots']::text[]
     OR public.fn_social_post_topics(NULL, NULL, 'video', 'x', '{"topic":{"a":1}}'::jsonb) IS DISTINCT FROM ARRAY['unknown']::text[]
     OR public.fn_social_post_topics(NULL, NULL, 'video', 'x', '{"clip_type":"slots"}'::jsonb) IS DISTINCT FROM ARRAY['unknown']::text[]
     OR public.fn_social_post_topics('sports', ARRAY['sports'], 'video', 'x', '{"topic":"sports","clip_type":"sports"}'::jsonb)
        IS DISTINCT FROM public.fn_social_post_topics('sports', ARRAY['sports'], 'video', 'x', '{"topic":"sports","topic_attested":true}'::jsonb)
  THEN
    RAISE EXCEPTION 'post check: fn_social_post_topics declared-topic rule is wrong';
  END IF;
  SELECT count(*) INTO v_changed
  FROM _sports_reels_topics_baseline b
  JOIN public.social_posts p ON p.id = b.id
  WHERE public.fn_social_post_topics(p.topic, p.topics, p.content_type, p.content, p.metadata)
        IS DISTINCT FROM b.derived;
  IF v_changed <> 0 THEN
    RAISE EXCEPTION 'post check: the topics rule changed % existing posts', v_changed;
  END IF;

  -- End to end, as a real player, rolled back: a Sports YouTube share gets the
  -- Sports topic and the canonical thumbnail at insert, and the RPC still
  -- rejects a topic a horse cannot publish.
  SELECT p.id INTO v_player
  FROM public.profiles p
  WHERE COALESCE(p.is_horse, false) = false
    AND p.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM public.content_authors ca WHERE ca.profile_id = p.id
    )
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1;
  IF v_player IS NULL THEN
    RAISE EXCEPTION 'post check: no player profile to test with';
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_player::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_player, 'role', 'authenticated')::text,
      true
    );

    SELECT r.social_post_id, r.social_reel_id
    INTO v_post_id, v_reel_id
    FROM public.publish_user_video_reel(
      'https://www.youtube.com/watch?v=zzzzzzzzzz0',
      'sports',
      true,
      'Postcheck sports share',
      'https://example.invalid/client-poster.jpg',
      'public'
    ) AS r;

    SELECT * INTO v_post FROM public.social_posts WHERE id = v_post_id;
    SELECT * INTO v_reel FROM public.social_reels WHERE id = v_reel_id;

    IF v_post.topic IS DISTINCT FROM 'sports'
       OR v_post.topics IS DISTINCT FROM ARRAY['sports']::text[]
       OR v_post.thumbnail_url IS NOT NULL
       OR v_post.metadata ->> 'topic' IS DISTINCT FROM 'sports'
    THEN
      RAISE EXCEPTION 'post check: player Sports post shape is wrong (topic %, topics %, thumbnail %)',
        v_post.topic, v_post.topics, v_post.thumbnail_url;
    END IF;
    IF v_reel.source_post_id IS DISTINCT FROM v_post_id
       OR v_reel.topic IS DISTINCT FROM 'sports'
       OR v_reel.origin_type IS DISTINCT FROM 'social_post'
       OR v_reel.source_type IS DISTINCT FROM 'youtube'
       OR v_reel.youtube_video_id IS DISTINCT FROM 'zzzzzzzzzz0'
       OR v_reel.thumbnail_url IS DISTINCT FROM 'https://img.youtube.com/vi/zzzzzzzzzz0/hqdefault.jpg'
    THEN
      RAISE EXCEPTION 'post check: player Sports Reel shape is wrong (topic %, origin %, thumbnail %)',
        v_reel.topic, v_reel.origin_type, v_reel.thumbnail_url;
    END IF;

    v_rejected := false;
    BEGIN
      PERFORM public.publish_user_video_reel(
        'https://www.youtube.com/watch?v=zzzzzzzzzz1', 'slots', true, NULL, NULL, 'public'
      );
    EXCEPTION WHEN check_violation THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'post check: publish_user_video_reel accepted a topic outside user_reel_topics()';
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'postcheck rollback';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL; -- the probe's rows and claims are rolled back with this block
  END;

  IF EXISTS (SELECT 1 FROM public.social_reels WHERE youtube_video_id IN ('zzzzzzzzzz0', 'zzzzzzzzzz1'))
     OR EXISTS (SELECT 1 FROM public.social_posts WHERE youtube_video_id IN ('zzzzzzzzzz0', 'zzzzzzzzzz1'))
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS DISTINCT FROM v_claims_before
     OR NULLIF(current_setting('request.jwt.claim.sub', true), '') IS DISTINCT FROM v_sub_before
     OR NULLIF(current_setting('request.jwt.claim.role', true), '') IS DISTINCT FROM v_role_before
  THEN
    RAISE EXCEPTION 'post check: the end-to-end probe was not rolled back';
  END IF;
END
$postcheck$;

COMMIT;

-- After COMMIT, record the new pins:
-- SELECT p.oid::regprocedure, md5(pg_get_functiondef(p.oid))
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname IN (
--   'publish_user_video_reel', 'fn_social_posts_video_to_reel_mirror',
--   'fn_social_post_topics', 'user_reel_topics', 'fn_youtube_reel_thumbnail_url');
