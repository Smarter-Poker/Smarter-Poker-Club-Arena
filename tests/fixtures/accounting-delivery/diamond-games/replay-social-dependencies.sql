-- Exact read-only catalog capture 2026-09-19. Isolated replay qualification only.

-- All real post/story/reward triggers and table constraints remain enabled.

-- Video branches are retained but this probe shares only text replay links.

-- The production postgres defaults also apply to every newly created replay
-- object. Preserve them so the migration's explicit revokes are exercised
-- against the actual starting privileges, not a locally empty default ACL.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLES TO anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,UPDATE,USAGE ON SEQUENCES TO anon,authenticated,service_role;

CREATE TABLE public."social_posts" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "author_id" uuid NOT NULL,
 "content" text NOT NULL,
 "content_type" text DEFAULT 'text'::text,
 "media_urls" jsonb DEFAULT '[]'::jsonb,
 "like_count" integer DEFAULT 0,
 "comment_count" integer DEFAULT 0,
 "share_count" integer DEFAULT 0,
 "view_count" integer DEFAULT 0,
 "visibility" text DEFAULT 'public'::text,
 "is_pinned" boolean DEFAULT false,
 "is_flagged" boolean DEFAULT false,
 "is_deleted" boolean DEFAULT false,
 "achievement_data" jsonb,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED,
 "metadata" jsonb DEFAULT '{}'::jsonb,
 "link_url" text,
 "link_title" text,
 "link_description" text,
 "link_image" text,
 "link_site_name" text,
 "thumbnail_url" text,
 "transcode_status" text,
 "original_media_url" text,
 "transcode_error" text,
 "transcoded_at" timestamp with time zone,
 "cover_frames" text[],
 "cover_frame_index" integer,
 "ai_label" boolean DEFAULT false,
 "audience_mode" text,
 "audience_list" text[],
 "share_to_story" boolean DEFAULT false,
 "metadata_location" jsonb,
 "topics" text[],
 "origin_type" text DEFAULT 'user_upload'::text NOT NULL,
 "playback_type" text DEFAULT 'external_embed'::text NOT NULL,
 "topic" text DEFAULT 'unknown'::text NOT NULL,
 "rights_status" text DEFAULT 'unknown'::text NOT NULL,
 "source_asset_id" uuid,
 "youtube_video_id" text,
 "canonical_asset_key" text,
 "publication_key" text,
 "legacy_transition_expires_at" timestamp with time zone
);

CREATE TABLE public."social_stories" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "author_id" uuid NOT NULL,
 "content" text,
 "media_url" text,
 "media_type" character varying(20) DEFAULT 'image'::character varying,
 "background_color" character varying(255),
 "created_at" timestamp with time zone DEFAULT now(),
 "expires_at" timestamp with time zone DEFAULT (now() + '24:00:00'::interval),
 "view_count" integer DEFAULT 0,
 "is_active" boolean DEFAULT true,
 "link_url" text
);

CREATE TABLE public."celebration_queue" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "user_id" uuid NOT NULL,
 "reward_id" text NOT NULL,
 "reward_name" text,
 "diamonds" integer NOT NULL,
 "rarity" text DEFAULT 'common'::text NOT NULL,
 "icon" text,
 "message" text,
 "created_at" timestamp with time zone DEFAULT now(),
 "dismissed" boolean DEFAULT false
);

CREATE TABLE public."reward_claims" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "user_id" uuid NOT NULL,
 "reward_id" text NOT NULL,
 "diamonds_awarded" integer NOT NULL,
 "multiplier" numeric(3,2) DEFAULT 1.0,
 "metadata" jsonb DEFAULT '{}'::jsonb,
 "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE public."reward_definitions" (
 "id" text NOT NULL,
 "category" text DEFAULT 'standard'::text NOT NULL,
 "subcategory" text,
 "name" text NOT NULL,
 "description" text,
 "base_amount" integer NOT NULL,
 "max_amount" integer,
 "is_repeatable" boolean DEFAULT false,
 "cooldown_hours" integer DEFAULT 24,
 "bypasses_cap" boolean DEFAULT false,
 "rarity" text DEFAULT 'common'::text,
 "icon" text,
 "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE public."video_library_videos" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "youtube_video_id" text NOT NULL,
 "video_url" text NOT NULL,
 "source_id" text NOT NULL,
 "source_name" text NOT NULL,
 "type" text NOT NULL,
 "title" text NOT NULL,
 "thumbnail_url" text,
 "duration" text,
 "views_text" text DEFAULT '0'::text,
 "views_count" bigint DEFAULT 0,
 "published_at" timestamp with time zone,
 "scraped_at" timestamp with time zone DEFAULT now(),
 "enriched_at" timestamp with time zone,
 "created_at" timestamp with time zone DEFAULT now(),
 "updated_at" timestamp with time zone DEFAULT now(),
 "tags" jsonb DEFAULT '[]'::jsonb,
 "availability_status" text DEFAULT 'unknown'::text NOT NULL,
 "embeddable" boolean,
 "availability_checked_at" timestamp with time zone,
 "availability_failure_reason" text,
 "availability_source" text
);


ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_audience_mode_chk" CHECK (((audience_mode IS NULL) OR (audience_mode = ANY (ARRAY['public'::text, 'friends'::text, 'friends_except'::text, 'specific'::text, 'only_me'::text, 'custom'::text])))) NOT VALID;


ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_comment_count_check" CHECK ((comment_count >= 0));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_content_check" CHECK ((char_length(content) <= 2000));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_embed_rights_check" CHECK (((rights_status <> 'embed_only'::text) OR (playback_type = 'youtube_embed'::text)));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_like_count_check" CHECK ((like_count >= 0));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_managed_library_integrity_check" CHECK ((((origin_type <> 'video_library'::text) AND (source_asset_id IS NULL) AND (publication_key IS NULL)) OR ((origin_type = 'video_library'::text) AND (source_asset_id IS NOT NULL) AND (youtube_video_id IS NOT NULL) AND (canonical_asset_key IS NOT NULL) AND (publication_key IS NOT NULL))));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_origin_type_check" CHECK ((origin_type = ANY (ARRAY['user_upload'::text, 'story'::text, 'social_post'::text, 'video_library'::text, 'horse'::text, 'pokernews'::text, 'generated'::text, 'legacy'::text])));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_pkey" PRIMARY KEY (id);

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_playback_type_check" CHECK ((playback_type = ANY (ARRAY['native'::text, 'youtube_embed'::text, 'external_embed'::text])));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_rights_status_check" CHECK ((rights_status = ANY (ARRAY['unknown'::text, 'embed_only'::text, 'owned'::text, 'licensed'::text, 'user_authorized'::text, 'restricted'::text])));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_share_count_check" CHECK ((share_count >= 0));


ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_topic_check" CHECK ((topic = ANY (ARRAY['unknown'::text, 'poker'::text, 'cash'::text, 'tournament'::text, 'slots'::text, 'sports'::text, 'other'::text])));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_view_count_check" CHECK ((view_count >= 0));

ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_visibility_check" CHECK ((visibility = ANY (ARRAY['public'::text, 'followers'::text, 'private'::text])));


ALTER TABLE public."social_stories" ADD CONSTRAINT "social_stories_pkey" PRIMARY KEY (id);

ALTER TABLE public."celebration_queue" ADD CONSTRAINT "celebration_queue_pkey" PRIMARY KEY (id);




ALTER TABLE public."reward_claims" ADD CONSTRAINT "reward_claims_pkey" PRIMARY KEY (id);



ALTER TABLE public."reward_definitions" ADD CONSTRAINT "reward_definitions_pkey" PRIMARY KEY (id);

ALTER TABLE public."video_library_videos" ADD CONSTRAINT "video_library_videos_availability_status_check" CHECK ((availability_status = ANY (ARRAY['unknown'::text, 'verified'::text, 'unavailable'::text, 'private'::text, 'restricted'::text, 'embed_disabled'::text, 'error'::text])));

ALTER TABLE public."video_library_videos" ADD CONSTRAINT "video_library_videos_pkey" PRIMARY KEY (id);

ALTER TABLE public."video_library_videos" ADD CONSTRAINT "video_library_videos_type_check" CHECK ((type = ANY (ARRAY['cash'::text, 'tournament'::text, 'slots'::text])));

ALTER TABLE public."video_library_videos" ADD CONSTRAINT "video_library_videos_verified_availability_check" CHECK ((((availability_status = 'verified'::text) AND (embeddable IS TRUE) AND (availability_checked_at IS NOT NULL)) OR ((availability_status <> 'verified'::text) AND (embeddable IS DISTINCT FROM true))));

ALTER TABLE public."video_library_videos" ADD CONSTRAINT "video_library_videos_youtube_video_id_key" UNIQUE (youtube_video_id);

ALTER TABLE public."social_posts" ADD CONSTRAINT "fk_social_posts_author_id_profiles" FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_author_id_fkey" FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."social_posts" ADD CONSTRAINT "social_posts_source_asset_id_fkey" FOREIGN KEY (source_asset_id) REFERENCES video_library_videos(id) ON DELETE RESTRICT;
ALTER TABLE public."social_stories" ADD CONSTRAINT "fk_social_stories_author_id_profiles" FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."celebration_queue" ADD CONSTRAINT "celebration_queue_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."celebration_queue" ADD CONSTRAINT "fk_celebration_queue_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."reward_claims" ADD CONSTRAINT "fk_reward_claims_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public."reward_claims" ADD CONSTRAINT "reward_claims_reward_id_fkey" FOREIGN KEY (reward_id) REFERENCES reward_definitions(id);
ALTER TABLE public."reward_claims" ADD CONSTRAINT "reward_claims_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX idx_social_posts_author ON public.social_posts USING btree (author_id);

CREATE INDEX idx_social_posts_author_id ON public.social_posts USING btree (author_id, created_at DESC);

CREATE INDEX idx_social_posts_canonical_asset_key ON public.social_posts USING btree (canonical_asset_key) WHERE (canonical_asset_key IS NOT NULL);

CREATE INDEX idx_social_posts_created ON public.social_posts USING btree (created_at DESC);

CREATE INDEX idx_social_posts_transcode_queued ON public.social_posts USING btree (transcode_status, created_at DESC) WHERE (transcode_status = ANY (ARRAY['queued'::text, 'running'::text]));

CREATE UNIQUE INDEX uq_social_posts_video_library_asset ON public.social_posts USING btree (source_asset_id) WHERE ((origin_type = 'video_library'::text) AND (source_asset_id IS NOT NULL));

CREATE UNIQUE INDEX uq_social_posts_video_library_canonical ON public.social_posts USING btree (canonical_asset_key) WHERE ((origin_type = 'video_library'::text) AND (canonical_asset_key IS NOT NULL));

CREATE UNIQUE INDEX uq_social_posts_video_library_publication ON public.social_posts USING btree (publication_key) WHERE ((origin_type = 'video_library'::text) AND (publication_key IS NOT NULL));

CREATE INDEX idx_social_stories_author ON public.social_stories USING btree (author_id, expires_at);

CREATE INDEX idx_stories_created ON public.social_stories USING btree (created_at DESC);

CREATE INDEX idx_video_library_availability_due ON public.video_library_videos USING btree (availability_status, availability_checked_at);

CREATE INDEX idx_vlv_scraped_at ON public.video_library_videos USING btree (scraped_at DESC);

CREATE INDEX idx_vlv_source_scraped ON public.video_library_videos USING btree (source_id, scraped_at DESC NULLS LAST);

CREATE INDEX idx_vlv_type_scraped ON public.video_library_videos USING btree (type, scraped_at DESC NULLS LAST);

CREATE INDEX idx_vlv_views_count ON public.video_library_videos USING btree (views_count DESC NULLS LAST);

SET check_function_bodies=off;

-- Catalog definition MD5 7529dddd2e04426432a1fdc113086a6b

-- Escaped only to retain original whitespace without adding patch trailing spaces.
DO $catalog$ BEGIN EXECUTE E'CREATE OR REPLACE FUNCTION public.claim_reward(p_user_id uuid, p_reward_id text, p_metadata jsonb DEFAULT ''{}''::jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO ''public'', ''extensions''\nAS $function$\nDECLARE\n    v_reward reward_definitions%ROWTYPE;\n    v_balance user_diamond_balance%ROWTYPE;\n    v_multiplier DECIMAL(3,2) := 1.0;\n    v_diamonds INTEGER;\n    v_daily_cap INTEGER := 500;\n    v_today_earned INTEGER;\n    v_claim_id UUID;\nBEGIN\n    -- Get reward definition\n    SELECT * INTO v_reward FROM reward_definitions WHERE id = p_reward_id;\n    IF NOT FOUND THEN\n        RETURN jsonb_build_object(''success'', false, ''error'', ''Reward not found'');\n    END IF;\n    \n    -- Get or create user balance\n    SELECT * INTO v_balance FROM user_diamond_balance WHERE user_id = p_user_id;\n    IF NOT FOUND THEN\n        INSERT INTO user_diamond_balance (user_id, balance, lifetime_earned)\n        VALUES (p_user_id, 0, 0)\n        RETURNING * INTO v_balance;\n    END IF;\n    \n    -- Check if non-repeatable reward already claimed\n    IF NOT v_reward.is_repeatable THEN\n        IF EXISTS (SELECT 1 FROM reward_claims WHERE user_id = p_user_id AND reward_id = p_reward_id) THEN\n            RETURN jsonb_build_object(''success'', false, ''error'', ''Already claimed'', ''already_claimed'', true);\n        END IF;\n    END IF;\n    \n    -- Calculate streak multiplier\n    IF v_balance.current_streak >= 7 THEN\n        v_multiplier := 2.0;\n    ELSIF v_balance.current_streak >= 3 THEN\n        v_multiplier := 1.5;\n    END IF;\n    \n    -- Calculate diamonds\n    v_diamonds := FLOOR(v_reward.base_amount * v_multiplier);\n    \n    -- Check daily cap (unless bypasses_cap is true)\n    IF NOT COALESCE(v_reward.bypasses_cap, false) THEN\n        SELECT COALESCE(SUM(diamonds_awarded), 0) INTO v_today_earned\n        FROM reward_claims\n        WHERE user_id = p_user_id AND created_at::date = CURRENT_DATE;\n        \n        IF v_today_earned >= v_daily_cap THEN\n            RETURN jsonb_build_object(''success'', false, ''error'', ''Daily cap reached'', ''cap_reached'', true);\n        END IF;\n        \n        -- Reduce to stay under cap\n        IF v_today_earned + v_diamonds > v_daily_cap THEN\n            v_diamonds := v_daily_cap - v_today_earned;\n        END IF;\n    END IF;\n    \n    -- Create the claim\n    INSERT INTO reward_claims (user_id, reward_id, diamonds_awarded, multiplier, metadata)\n    VALUES (p_user_id, p_reward_id, v_diamonds, v_multiplier, p_metadata)\n    RETURNING id INTO v_claim_id;\n    \n    -- Update balance\n    UPDATE user_diamond_balance\n    SET balance = balance + v_diamonds,\n        lifetime_earned = lifetime_earned + v_diamonds,\n        updated_at = NOW()\n    WHERE user_id = p_user_id;\n    \n    -- Queue celebration\n    INSERT INTO celebration_queue (user_id, reward_id, reward_name, diamonds, rarity, icon, message)\n    VALUES (\n        p_user_id,\n        p_reward_id,\n        v_reward.name,\n        v_diamonds,\n        v_reward.rarity,\n        v_reward.icon,\n        CASE v_reward.rarity\n            WHEN ''legendary'' THEN ''LEGENDARY ACHIEVEMENT!''\n            WHEN ''epic'' THEN ''EPIC DISCOVERY!''\n            WHEN ''rare'' THEN ''RARE FIND!''\n            ELSE ''DIAMONDS EARNED!''\n        END\n    );\n    \n    RETURN jsonb_build_object(\n        ''success'', true,\n        ''claim_id'', v_claim_id,\n        ''reward_id'', p_reward_id,\n        ''reward_name'', v_reward.name,\n        ''diamonds'', v_diamonds,\n        ''multiplier'', v_multiplier,\n        ''rarity'', v_reward.rarity,\n        ''icon'', v_reward.icon,\n        ''new_balance'', v_balance.balance + v_diamonds\n    );\nEND;\n$function$\n'; END $catalog$;

ALTER FUNCTION public.claim_reward(uuid,text,jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_reward(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.claim_reward(uuid,text,jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION public.claim_reward(uuid,text,jsonb) TO "service_role";

-- Catalog definition MD5 3a5860f2bd54aa80e3e54931ef90876a

CREATE OR REPLACE FUNCTION public.fn_social_reward_award(p_user_id uuid, p_action_key text, p_reference_id text, p_target_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_created_at timestamptz;
BEGIN
    IF p_user_id IS NULL OR p_action_key IS NULL THEN RETURN; END IF;
    -- Anti-farming: the 24h account-age gate every HTTP endpoint applied.
    -- A profile we cannot find is NOT paid - fail closed.
    SELECT created_at INTO v_created_at FROM public.profiles WHERE id = p_user_id;
    IF v_created_at IS NULL OR (now() - v_created_at) < interval '24 hours' THEN RETURN; END IF;
    PERFORM public.award_diamonds_v2(p_user_id, p_action_key, p_reference_id, p_target_id,
                                     jsonb_build_object('source','db_trigger'));
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[social-reward] % failed for user %: %', p_action_key, p_user_id, SQLERRM;
    RETURN;
END $function$
;

ALTER FUNCTION public.fn_social_reward_award(uuid,text,text,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_social_reward_award(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_social_reward_award(uuid,text,text,text) TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_social_reward_award(uuid,text,text,text) TO "service_role";

-- Catalog definition MD5 ec85ac8337898f3e47bc1d3d1199108e

CREATE OR REPLACE FUNCTION public.fn_can_view_post(p_author_id uuid, p_audience_mode text, p_audience_list text[])
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_viewer uuid;
  v_mode text;
BEGIN
  v_viewer := auth.uid();
  v_mode := COALESCE(p_audience_mode, 'public');

  -- Author always sees their own posts.
  IF v_viewer IS NOT NULL AND v_viewer = p_author_id THEN
    RETURN TRUE;
  END IF;

  IF v_mode = 'public' THEN
    RETURN TRUE;
  END IF;

  -- All non-public modes require the viewer to be authenticated.
  IF v_viewer IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_mode = 'only_me' THEN
    RETURN FALSE; -- author already returned above
  END IF;

  IF v_mode = 'friends' THEN
    RETURN public.fn_are_friends(v_viewer, p_author_id);
  END IF;

  IF v_mode = 'friends_except' THEN
    -- audience_list holds excluded user ids
    RETURN public.fn_are_friends(v_viewer, p_author_id)
       AND NOT (v_viewer::text = ANY(COALESCE(p_audience_list, '{}'::text[])));
  END IF;

  IF v_mode IN ('specific', 'custom') THEN
    RETURN v_viewer::text = ANY(COALESCE(p_audience_list, '{}'::text[]));
  END IF;

  -- Unknown mode: fail closed.
  RETURN FALSE;
END;
$function$
;

ALTER FUNCTION public.fn_can_view_post(uuid,text,text[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_can_view_post(uuid,text,text[]) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_can_view_post(uuid,text,text[]) TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_can_view_post(uuid,text,text[]) TO "anon";

GRANT EXECUTE ON FUNCTION public.fn_can_view_post(uuid,text,text[]) TO "authenticated";

GRANT EXECUTE ON FUNCTION public.fn_can_view_post(uuid,text,text[]) TO "service_role";

-- Catalog definition MD5 e058af269888d9db622c7003b9876b7b

CREATE OR REPLACE FUNCTION public.fn_is_public_video_playback_eligible(p_playback_type text, p_rights_status text, p_playback_url text, p_author_id uuid, p_youtube_video_id text, p_canonical_asset_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT CASE
    WHEN p_playback_type = 'youtube_embed' THEN
      p_rights_status IN ('embed_only', 'owned', 'licensed')
      AND p_youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
      AND p_canonical_asset_key = 'youtube:' || p_youtube_video_id
      AND public.fn_extract_youtube_video_id(p_playback_url) = p_youtube_video_id
      AND public.fn_has_fresh_public_youtube_verification(p_youtube_video_id)
    WHEN p_playback_type = 'native' THEN
      p_rights_status IN ('owned', 'licensed', 'user_authorized')
      AND public.fn_is_user_video_storage_url(p_playback_url, p_author_id)
      AND (
        (
          p_rights_status = 'user_authorized'
          AND
          p_youtube_video_id IS NULL
          AND p_canonical_asset_key LIKE 'native:%'
        )
        OR (
          p_rights_status IN ('owned', 'licensed')
          AND (
            p_youtube_video_id IS NULL
            OR (
              p_canonical_asset_key = 'youtube:' || p_youtube_video_id
              AND public.fn_has_fresh_public_youtube_verification(p_youtube_video_id)
            )
          )
        )
      )
    ELSE false
  END
$function$
;

ALTER FUNCTION public.fn_is_public_video_playback_eligible(text,text,text,uuid,text,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_is_public_video_playback_eligible(text,text,text,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_is_public_video_playback_eligible(text,text,text,uuid,text,text) TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_is_public_video_playback_eligible(text,text,text,uuid,text,text) TO "service_role";

GRANT EXECUTE ON FUNCTION public.fn_is_public_video_playback_eligible(text,text,text,uuid,text,text) TO "anon";

GRANT EXECUTE ON FUNCTION public.fn_is_public_video_playback_eligible(text,text,text,uuid,text,text) TO "authenticated";

-- Catalog definition MD5 296372702ded9ce20a4d19804c14e476

CREATE OR REPLACE FUNCTION public.fn_is_video_library_asset_eligible(p_asset_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.video_library_videos v
    WHERE v.id = p_asset_id
      AND v.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
      AND v.youtube_video_id NOT LIKE 'FAKE%'
      AND v.type IN ('cash', 'tournament')
      AND v.availability_status = 'verified'
      AND v.embeddable IS TRUE
      AND v.availability_checked_at IS NOT NULL
      AND v.availability_checked_at >= now() - interval '7 days'
      AND v.availability_checked_at <= now() + interval '5 minutes'
      AND NOT EXISTS (
        SELECT 1
        FROM public.youtube_embed_failures f
        WHERE f.video_id = v.youtube_video_id
          AND f.verification_status = 'confirmed'
          AND f.resolved = false
      )
  )
$function$
;

ALTER FUNCTION public.fn_is_video_library_asset_eligible(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_is_video_library_asset_eligible(uuid) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_asset_eligible(uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_asset_eligible(uuid) TO "service_role";

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_asset_eligible(uuid) TO "anon";

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_asset_eligible(uuid) TO "authenticated";

-- Catalog definition MD5 80880ffedc928c4c4f4f29229d54d451

CREATE OR REPLACE FUNCTION public.fn_is_video_library_lineage_eligible(p_asset_id uuid, p_youtube_video_id text, p_canonical_asset_key text, p_publication_key text, p_playback_url text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.video_library_videos v
    WHERE v.id = p_asset_id
      AND p_youtube_video_id = v.youtube_video_id
      AND p_canonical_asset_key = 'youtube:' || v.youtube_video_id
      AND p_publication_key = 'video-library:' || v.id::text
      AND public.fn_extract_youtube_video_id(p_playback_url) = v.youtube_video_id
      AND public.fn_is_video_library_asset_eligible(v.id)
  )
$function$
;

ALTER FUNCTION public.fn_is_video_library_lineage_eligible(uuid,text,text,text,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_is_video_library_lineage_eligible(uuid,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_lineage_eligible(uuid,text,text,text,text) TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_lineage_eligible(uuid,text,text,text,text) TO "anon";

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_lineage_eligible(uuid,text,text,text,text) TO "authenticated";

GRANT EXECUTE ON FUNCTION public.fn_is_video_library_lineage_eligible(uuid,text,text,text,text) TO "service_role";

-- Catalog definition MD5 1f46895b63d874a18c2da0190836c4ac

CREATE OR REPLACE FUNCTION public.legacy_transition_eligible(p_post social_posts)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT (p_post).content_type = 'video'
    AND COALESCE((p_post).is_deleted, false) = false
    AND (p_post).visibility IS DISTINCT FROM 'private'
    AND (p_post).playback_type = 'youtube_embed'
    AND (p_post).rights_status IN ('embed_only', 'owned', 'licensed')
    AND (p_post).youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    AND (p_post).youtube_video_id NOT LIKE 'FAKE%'
    AND (p_post).canonical_asset_key =
      'youtube:' || (p_post).youtube_video_id
    AND public.fn_extract_youtube_video_id(
          NULLIF((p_post).media_urls ->> 0, '')
        ) = (p_post).youtube_video_id
    AND EXISTS (
      SELECT 1
      FROM public.video_reels_legacy_transition_rows transition_row
      JOIN public.video_reels_legacy_transition_state transition_state
        ON transition_state.transition_key = 'phase1-public-youtube'
       AND transition_state.captured_at = transition_row.captured_at
       AND transition_state.expires_at = transition_row.expires_at
      WHERE transition_row.surface = 'social_posts'
        AND transition_row.row_id = (p_post).id
        AND transition_row.youtube_video_id = (p_post).youtube_video_id
        AND transition_row.row_snapshot =
          public.fn_legacy_youtube_post_transition_snapshot(p_post)
        AND transition_row.expires_at =
          (p_post).legacy_transition_expires_at
        AND transition_row.captured_at <= now() + interval '5 minutes'
        AND transition_row.expires_at =
          transition_row.captured_at + interval '7 days'
        AND transition_row.expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.youtube_embed_failures failure
      WHERE failure.video_id = (p_post).youtube_video_id
        AND failure.verification_status = 'confirmed'
        AND failure.resolved = false
    )
$function$
;

ALTER FUNCTION public.legacy_transition_eligible(social_posts) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.legacy_transition_eligible(social_posts) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.legacy_transition_eligible(social_posts) TO "postgres";

GRANT EXECUTE ON FUNCTION public.legacy_transition_eligible(social_posts) TO "anon";

GRANT EXECUTE ON FUNCTION public.legacy_transition_eligible(social_posts) TO "authenticated";

GRANT EXECUTE ON FUNCTION public.legacy_transition_eligible(social_posts) TO "service_role";

-- Catalog definition MD5 96da541712286581c374b0a6d0298600

CREATE OR REPLACE FUNCTION public.fn_queue_video_transcode()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.content_type = 'video'
     AND (NEW.media_urls->>0) IS NOT NULL
     AND (
       (NEW.media_urls->>0) ILIKE '%.mov'
       OR (NEW.media_urls->>0) ILIKE '%.hevc'
       OR (NEW.media_urls->>0) ILIKE '%.heic'
       OR (NEW.media_urls->>0) ILIKE '%.mkv'
       OR (NEW.media_urls->>0) ILIKE '%.avi'
       OR (NEW.media_urls->>0) ILIKE '%.mp4'
       OR (NEW.media_urls->>0) ILIKE '%.m4v'
       OR (NEW.media_urls->>0) ILIKE '%.webm'
       OR (NEW.media_urls->>0) ILIKE '%/live-recordings/%'
     )
     -- Only queue when a thumbnail is actually missing: a client-supplied
     -- poster frame should not trigger a re-encode just for extraction.
     AND (NEW.thumbnail_url IS NULL OR NEW.thumbnail_url = '')
  THEN
    NEW.transcode_status := 'queued';
    NEW.original_media_url := (NEW.media_urls->>0);
  END IF;
  RETURN NEW;
END;
$function$
;

ALTER FUNCTION public.fn_queue_video_transcode() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_queue_video_transcode() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_queue_video_transcode() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_queue_video_transcode() TO "service_role";

-- Catalog definition MD5 361d53230ceac434d88a7785dd66530a

CREATE OR REPLACE FUNCTION public.fn_auto_create_story_from_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Wrap in exception handler so a failed story insert never blocks the post
    BEGIN
        INSERT INTO social_stories (
            author_id,
            content,
            media_url,
            media_type,
            created_at,
            expires_at,
            is_active
        )
        VALUES (
            NEW.author_id,
            LEFT(NEW.content, 200),
            CASE WHEN NEW.media_urls IS NOT NULL AND jsonb_array_length(NEW.media_urls) > 0
                 THEN NEW.media_urls->>0
                 ELSE NULL
            END,
            CASE
                WHEN NEW.media_urls IS NOT NULL AND jsonb_array_length(NEW.media_urls) > 0 THEN
                    CASE WHEN NEW.media_urls->>0 ILIKE '%.mp4' OR NEW.media_urls->>0 ILIKE '%video%'
                         THEN 'video'
                         ELSE 'image'
                    END
                ELSE NULL
            END,
            NOW(),
            NOW() + INTERVAL '24 hours',
            true
        );
    EXCEPTION WHEN OTHERS THEN
        -- Silently swallow - story creation is optional, never block the post
        RAISE WARNING '[fn_auto_create_story_from_post] Failed: %', SQLERRM;
    END;

    RETURN NEW;  -- CRITICAL: Always return NEW so the INSERT proceeds
END;
$function$
;

ALTER FUNCTION public.fn_auto_create_story_from_post() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_auto_create_story_from_post() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_auto_create_story_from_post() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_auto_create_story_from_post() TO "service_role";

-- Catalog definition MD5 c06b9bc893b963718ccac1ffc6aeec91

CREATE OR REPLACE FUNCTION public.trgfn_award_social_post()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF COALESCE(NEW.is_deleted,false) THEN RETURN NEW; END IF;
    IF length(btrim(COALESCE(NEW.content,''))) < 20 THEN RETURN NEW; END IF;
    PERFORM public.fn_social_reward_award(NEW.author_id,'social_post',
        'social_post_'||NEW.author_id::text||'_'||NEW.id::text, NEW.id::text);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW; END $function$
;

ALTER FUNCTION public.trgfn_award_social_post() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.trgfn_award_social_post() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.trgfn_award_social_post() TO "postgres";

GRANT EXECUTE ON FUNCTION public.trgfn_award_social_post() TO "authenticated";

GRANT EXECUTE ON FUNCTION public.trgfn_award_social_post() TO "service_role";

-- Catalog definition MD5 12d3f0751ffd93fa7036e6f852eb4dd8

CREATE OR REPLACE FUNCTION public.fn_social_post_reward()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare    v_result JSONB;
begin    -- Call the existing reward bus to claim the 'social_post_share' reward (15 diamonds)
    v_result := claim_reward(NEW.author_id, 'social_post_share', jsonb_build_object('post_id', NEW.id));
        RETURN NEW;
        EXCEPTION WHEN OTHERS then    -- If reward fails, don't block the post_frequency    RETURN NEW;
        END;
        $function$
;

ALTER FUNCTION public.fn_social_post_reward() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_social_post_reward() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_social_post_reward() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_social_post_reward() TO "service_role";

-- Catalog definition MD5 a2415e5851fd2ed52d6b4be34c8187f5

CREATE OR REPLACE FUNCTION public.fn_guard_legacy_transition_marker()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.legacy_transition_expires_at IS NOT NULL)
     OR (
       TG_OP = 'UPDATE'
       AND NEW.legacy_transition_expires_at IS DISTINCT FROM
           OLD.legacy_transition_expires_at
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'legacy YouTube transition markers are immutable migration evidence';
  END IF;

  RETURN NEW;
END
$function$
;

ALTER FUNCTION public.fn_guard_legacy_transition_marker() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_guard_legacy_transition_marker() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_legacy_transition_marker() TO "postgres";

-- Catalog definition MD5 463f377d0d81931b8db33df6912e6aec

CREATE OR REPLACE FUNCTION public.fn_guard_managed_video_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_asset_youtube_id text;
  v_playback_url text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.origin_type = 'video_library'
     AND NEW.origin_type IS DISTINCT FROM 'video_library'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'managed video lineage cannot be declassified in place';
  END IF;

  IF NEW.origin_type IS DISTINCT FROM 'video_library'
     AND NEW.source_asset_id IS NULL
     AND NEW.publication_key IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'social_reels'
     AND COALESCE(to_jsonb(NEW) ->> 'source_type', '') <> 'video_library'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'managed Reel source_type must be video_library';
  END IF;

  IF NEW.origin_type IS DISTINCT FROM 'video_library'
     OR NEW.source_asset_id IS NULL
     OR NEW.youtube_video_id IS NULL
     OR NEW.canonical_asset_key IS NULL
     OR NEW.publication_key IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'managed video lineage fields must be complete and coherent';
  END IF;

  SELECT v.youtube_video_id
  INTO v_asset_youtube_id
  FROM public.video_library_videos v
  WHERE v.id = NEW.source_asset_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'managed video source asset does not exist';
  END IF;

  IF TG_TABLE_NAME = 'social_posts' THEN
    v_playback_url := NULLIF(NEW.media_urls ->> 0, '');
  ELSE
    v_playback_url := NULLIF(NEW.video_url, '');
  END IF;

  IF NEW.youtube_video_id IS DISTINCT FROM v_asset_youtube_id
     OR NEW.canonical_asset_key IS DISTINCT FROM
        'youtube:' || v_asset_youtube_id
     OR NEW.publication_key IS DISTINCT FROM
        'video-library:' || NEW.source_asset_id::text
     OR public.fn_extract_youtube_video_id(v_playback_url)
        IS DISTINCT FROM v_asset_youtube_id
     OR (
       TG_TABLE_NAME = 'social_reels'
       AND public.fn_extract_youtube_video_id(
             NULLIF(to_jsonb(NEW) ->> 'original_youtube_url', '')
           )
           IS DISTINCT FROM v_asset_youtube_id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'managed video lineage does not match the referenced asset';
  END IF;

  RETURN NEW;
END
$function$
;

ALTER FUNCTION public.fn_guard_managed_video_lineage() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_guard_managed_video_lineage() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_video_lineage() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_video_lineage() TO "service_role";

-- Catalog definition MD5 b332721b36411f8a83ff66bde793571e

CREATE OR REPLACE FUNCTION public.fn_guard_managed_video_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF COALESCE(auth.role()::text, '') <> 'service_role'
     AND (
       NEW.origin_type = 'video_library'
       OR NEW.source_asset_id IS NOT NULL
       OR NEW.publication_key IS NOT NULL
       OR COALESCE(to_jsonb(NEW) ->> 'source_type', '') = 'video_library'
       OR (
         TG_OP = 'UPDATE'
         AND (
           OLD.origin_type = 'video_library'
           OR OLD.source_asset_id IS NOT NULL
           OR OLD.publication_key IS NOT NULL
           OR COALESCE(to_jsonb(OLD) ->> 'source_type', '') = 'video_library'
         )
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'managed video provenance may only be written by the service role';
  END IF;
  RETURN NEW;
END
$function$
;

ALTER FUNCTION public.fn_guard_managed_video_provenance() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_guard_managed_video_provenance() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_video_provenance() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_video_provenance() TO "service_role";

-- Catalog definition MD5 7f8b9d0fbe9c5dabb91d2af9da38f0c6

CREATE OR REPLACE FUNCTION public.fn_guard_managed_post_visibility()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.origin_type = 'video_library'
     AND NEW.visibility = 'public'
     AND (
       COALESCE(auth.role()::text, '') <> 'service_role'
       OR current_setting('app.video_library_publish_asset_id', true)
          IS DISTINCT FROM NEW.source_asset_id::text
       OR NOT public.fn_is_video_library_lineage_eligible(
         NEW.source_asset_id,
         NEW.youtube_video_id,
         NEW.canonical_asset_key,
         NEW.publication_key,
         NULLIF(NEW.media_urls ->> 0, '')
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'managed library posts may only be published by publish_video_library_reel';
  END IF;
  RETURN NEW;
END
$function$
;

ALTER FUNCTION public.fn_guard_managed_post_visibility() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_guard_managed_post_visibility() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_post_visibility() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_guard_managed_post_visibility() TO "service_role";

-- Catalog definition MD5 491b60dc12f376f4e7a48d9ee97deed2

CREATE OR REPLACE FUNCTION public.fn_social_posts_video_contract_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_first_url text;
  v_yt_id text;
  v_provenance_yt_id text;
  v_prior_yt_id text;
  v_inferred_topic text;
  v_caller_role text := COALESCE(auth.role()::text, '');
  v_user_storage_video boolean := false;
BEGIN
  IF NEW.content_type IS DISTINCT FROM 'video' THEN
    RETURN NEW;
  END IF;

  v_first_url := NULLIF(NEW.media_urls ->> 0, '');
  v_yt_id := public.fn_extract_youtube_video_id(v_first_url);
  IF TG_OP = 'UPDATE' THEN
    v_prior_yt_id := COALESCE(
      public.fn_extract_youtube_video_id(NULLIF(OLD.media_urls ->> 0, '')),
      public.fn_extract_youtube_video_id(OLD.original_media_url),
      CASE
        WHEN OLD.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
          THEN OLD.youtube_video_id
        ELSE NULL
      END
    );
  END IF;
  v_inferred_topic := public.fn_infer_video_topic(NEW.metadata, NEW.topics);

  IF v_inferred_topic <> 'unknown' THEN
    NEW.topic := v_inferred_topic;
  END IF;

  IF NEW.origin_type = 'user_upload' AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = NEW.author_id
      AND COALESCE(p.is_horse, false)
  ) THEN
    NEW.origin_type := 'horse';
  END IF;

  IF v_yt_id IS NOT NULL THEN
    PERFORM public.fn_queue_youtube_verification(
      v_yt_id,
      'social_post_write'
    );
    NEW.youtube_video_id := v_yt_id;
    NEW.canonical_asset_key := 'youtube:' || v_yt_id;
    NEW.playback_type := 'youtube_embed';
    IF COALESCE(auth.role()::text, '') <> 'service_role'
       OR NEW.rights_status NOT IN ('owned', 'licensed')
    THEN
      NEW.rights_status := 'embed_only';
    END IF;
  ELSIF public.fn_is_platform_public_storage_url(v_first_url)
  THEN
    NEW.playback_type := 'native';
    v_provenance_yt_id := COALESCE(
      public.fn_extract_youtube_video_id(NEW.original_media_url),
      CASE
        WHEN NEW.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
          THEN NEW.youtube_video_id
        ELSE NULL
      END,
      v_prior_yt_id
    );
    -- A service worker may not publish a downloaded YouTube rendition by
    -- directly rewriting the post. The completion RPC first retires the exact
    -- claim, then exposes that completed job id as transaction-local proof for
    -- both the Reel and post updates.
    IF v_provenance_yt_id IS NOT NULL
       AND (
         TG_OP = 'INSERT'
         OR OLD.playback_type IS DISTINCT FROM 'native'
         OR NULLIF(OLD.media_urls ->> 0, '') IS DISTINCT FROM v_first_url
       )
       AND (
         v_caller_role <> 'service_role'
         OR NEW.rights_status NOT IN ('owned', 'licensed')
         OR NOT EXISTS (
           SELECT 1
           FROM public.video_transcode_jobs completion_job
           JOIN public.social_reels completion_reel
             ON completion_reel.id = completion_job.reel_id
           WHERE completion_job.id = current_setting(
                   'app.youtube_native_completion_job_id', true
                 )
             AND completion_job.status = 'completed'
             AND completion_job.reel_id = completion_reel.id
             AND completion_reel.source_post_id = NEW.id
             AND completion_job.user_id IS NOT DISTINCT FROM NEW.author_id
             AND completion_job.rights_status IS NOT DISTINCT FROM NEW.rights_status
             AND completion_job.canonical_asset_key = 'youtube:' || v_provenance_yt_id
             AND completion_job.output_url IS NOT DISTINCT FROM
               split_part(split_part(v_first_url, '?', 1), '#', 1)
         )
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'YouTube-derived native posts may only be published by complete_rights_cleared_youtube_transcode';
    END IF;
    -- A rights-cleared worker replaces only the playable URL. Retain the
    -- source identity so the native and embed representations deduplicate.
    IF v_caller_role = 'service_role'
       AND NEW.rights_status IN ('owned', 'licensed')
       AND v_provenance_yt_id IS NOT NULL
    THEN
      NEW.youtube_video_id := v_provenance_yt_id;
      NEW.canonical_asset_key := 'youtube:' || v_provenance_yt_id;
    ELSE
      NEW.youtube_video_id := NULL;
      NEW.canonical_asset_key := 'native:' || md5(v_first_url);
    END IF;
    v_user_storage_video := public.fn_is_user_video_storage_url(
      v_first_url,
      NEW.author_id
    );
    IF v_caller_role = 'authenticated'
       AND auth.uid() = NEW.author_id
       AND v_user_storage_video
    THEN
      NEW.rights_status := 'user_authorized';
    ELSIF v_caller_role = 'service_role'
       AND NEW.rights_status = 'user_authorized'
       AND v_user_storage_video
    THEN
      NEW.rights_status := 'user_authorized';
    ELSIF v_caller_role <> 'service_role'
       OR NEW.rights_status NOT IN ('owned', 'licensed')
    THEN
      NEW.rights_status := 'unknown';
    END IF;
  ELSIF NEW.playback_type = 'youtube_embed'
     OR NEW.youtube_video_id IS NOT NULL
  THEN
    v_provenance_yt_id := public.fn_extract_youtube_video_id(
      NEW.original_media_url
    );
    IF v_provenance_yt_id IS NOT NULL THEN
      NEW.media_urls := CASE
        WHEN jsonb_typeof(NEW.media_urls) = 'array'
          AND jsonb_array_length(NEW.media_urls) > 0
        THEN jsonb_set(
          NEW.media_urls,
          '{0}',
          to_jsonb(NEW.original_media_url),
          false
        )
        ELSE jsonb_build_array(NEW.original_media_url)
      END;
      NEW.youtube_video_id := v_provenance_yt_id;
      NEW.canonical_asset_key := 'youtube:' || v_provenance_yt_id;
      NEW.playback_type := 'youtube_embed';
      IF v_caller_role <> 'service_role'
         OR NEW.rights_status NOT IN ('owned', 'licensed')
      THEN
        NEW.rights_status := 'embed_only';
      END IF;
    ELSE
      NEW.youtube_video_id := NULL;
      NEW.canonical_asset_key := CASE
        WHEN v_first_url IS NOT NULL THEN 'external:' || md5(v_first_url)
        ELSE NULL
      END;
      NEW.playback_type := 'external_embed';
      NEW.rights_status := 'unknown';
    END IF;
  ELSE
    -- Caller-supplied playback/rights labels never turn an arbitrary URL into
    -- native media. Only the exact project Storage branch above can do that.
    NEW.youtube_video_id := NULL;
    NEW.canonical_asset_key := CASE
      WHEN v_first_url IS NOT NULL THEN 'external:' || md5(v_first_url)
      ELSE NULL
    END;
    NEW.playback_type := 'external_embed';
    NEW.rights_status := 'unknown';
  END IF;

  RETURN NEW;
END
$function$
;

ALTER FUNCTION public.fn_social_posts_video_contract_defaults() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_social_posts_video_contract_defaults() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_social_posts_video_contract_defaults() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_social_posts_video_contract_defaults() TO "service_role";

-- Catalog definition MD5 e93f449a35010868750d7492d6df43cd

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
    NEW.thumbnail_url,
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
$function$
;

ALTER FUNCTION public.fn_social_posts_video_to_reel_mirror() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_social_posts_video_to_reel_mirror() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_social_posts_video_to_reel_mirror() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_social_posts_video_to_reel_mirror() TO "service_role";

-- Catalog definition MD5 9aabed2309d652f85614fcc0e265fe65

CREATE OR REPLACE FUNCTION public.fn_create_social_post(p_author_id uuid, p_content text DEFAULT ''::text, p_content_type text DEFAULT 'text'::text, p_media_urls text[] DEFAULT '{}'::text[], p_visibility text DEFAULT 'public'::text, p_achievement_data jsonb DEFAULT NULL::jsonb, p_thumbnail_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_post_id uuid;
  v_media_jsonb jsonb := to_jsonb(COALESCE(p_media_urls, '{}'::text[]));
  v_caller_role text := COALESCE(auth.role()::text, '');
  v_caller_uid uuid := auth.uid();
BEGIN
  IF v_caller_role = 'authenticated' THEN
    IF v_caller_uid IS NULL OR p_author_id IS DISTINCT FROM v_caller_uid THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'forbidden: authenticated users may only post as themselves'
      );
    END IF;
  ELSIF v_caller_role <> 'service_role' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'forbidden: anonymous callers cannot create posts'
    );
  END IF;

  INSERT INTO public.social_posts (
    author_id,
    content,
    content_type,
    media_urls,
    visibility,
    achievement_data,
    thumbnail_url,
    created_at,
    updated_at
  ) VALUES (
    p_author_id,
    p_content,
    p_content_type,
    v_media_jsonb,
    p_visibility,
    p_achievement_data,
    p_thumbnail_url,
    now(),
    now()
  )
  RETURNING id INTO v_post_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_post_id,
    'author_id', p_author_id,
    'content', p_content,
    'content_type', p_content_type,
    'created_at', now(),
    'media_urls', v_media_jsonb,
    'thumbnail_url', p_thumbnail_url,
    'like_count', 0,
    'comment_count', 0
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END
$function$
;

ALTER FUNCTION public.fn_create_social_post(uuid,text,text,text[],text,jsonb,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_create_social_post(uuid,text,text,text[],text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_create_social_post(uuid,text,text,text[],text,jsonb,text) TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_create_social_post(uuid,text,text,text[],text,jsonb,text) TO "authenticated";

GRANT EXECUTE ON FUNCTION public.fn_create_social_post(uuid,text,text,text[],text,jsonb,text) TO "service_role";

RESET check_function_bodies;

ALTER TABLE public."social_posts" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."social_posts" FROM PUBLIC,anon,authenticated,service_role;

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_posts" TO "postgres";

GRANT INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_posts" TO "anon";

GRANT INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_posts" TO "authenticated";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_posts" TO "service_role";

ALTER TABLE public."social_stories" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."social_stories" FROM PUBLIC,anon,authenticated,service_role;

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_stories" TO "postgres";

GRANT INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_stories" TO "anon";

GRANT INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_stories" TO "authenticated";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."social_stories" TO "service_role";

ALTER TABLE public."celebration_queue" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."celebration_queue" FROM PUBLIC,anon,authenticated,service_role;

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."celebration_queue" TO "postgres";

GRANT INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."celebration_queue" TO "anon";

GRANT INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."celebration_queue" TO "authenticated";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."celebration_queue" TO "service_role";

ALTER TABLE public."reward_claims" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."reward_claims" FROM PUBLIC,anon,authenticated,service_role;

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."reward_claims" TO "postgres";

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public."reward_claims" TO "anon";

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public."reward_claims" TO "authenticated";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."reward_claims" TO "service_role";

ALTER TABLE public."reward_definitions" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."reward_definitions" FROM PUBLIC,anon,authenticated,service_role;

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."reward_definitions" TO "postgres";

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public."reward_definitions" TO "anon";

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public."reward_definitions" TO "authenticated";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."reward_definitions" TO "service_role";

ALTER TABLE public."video_library_videos" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."video_library_videos" FROM PUBLIC,anon,authenticated,service_role;

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."video_library_videos" TO "postgres";

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public."video_library_videos" TO "anon";

GRANT SELECT,REFERENCES,TRIGGER ON TABLE public."video_library_videos" TO "authenticated";

GRANT INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLE public."video_library_videos" TO "service_role";

CREATE POLICY "Service role manages" ON public."celebration_queue" AS PERMISSIVE FOR ALL TO "service_role" USING (true);

CREATE POLICY "Users dismiss own celebrations" ON public."celebration_queue" AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));

CREATE POLICY "Users view own celebrations" ON public."celebration_queue" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));

CREATE POLICY "Service role inserts" ON public."reward_claims" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);

CREATE POLICY "Users view own claims" ON public."reward_claims" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));

CREATE POLICY "reward_definitions_public_read" ON public."reward_definitions" AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);

CREATE POLICY "reward_definitions_service_write" ON public."reward_definitions" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);

CREATE POLICY "Audience-aware view" ON public."social_posts" AS PERMISSIVE FOR SELECT TO PUBLIC USING (fn_can_view_post(author_id, audience_mode, audience_list));

CREATE POLICY "Users can create their own posts" ON public."social_posts" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (((author_id = ( SELECT auth.uid() AS uid)) OR (((( SELECT auth.jwt() AS jwt) ->> 'role'::text) = 'service_role'::text) AND (author_id = '00000000-0000-0000-0000-000000000001'::uuid))));

CREATE POLICY "Users can delete own posts" ON public."social_posts" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((( SELECT auth.uid() AS uid) = author_id));

CREATE POLICY "Users can update own posts" ON public."social_posts" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((( SELECT auth.uid() AS uid) = author_id));

CREATE POLICY "video_posts_public_select_guard" ON public."social_posts" AS RESTRICTIVE FOR SELECT TO "anon","authenticated" USING (((COALESCE(is_deleted, false) = false) AND ((author_id = ( SELECT auth.uid() AS uid)) OR (visibility IS DISTINCT FROM 'private'::text)) AND fn_can_view_post(author_id, COALESCE(audience_mode, NULLIF(visibility, 'public'::text), 'public'::text), audience_list) AND ((content_type IS DISTINCT FROM 'video'::text) OR (author_id = ( SELECT auth.uid() AS uid)) OR legacy_transition_eligible(social_posts.*) OR fn_is_public_video_playback_eligible(playback_type, rights_status, NULLIF((media_urls ->> 0), ''::text), author_id, youtube_video_id, canonical_asset_key)) AND (legacy_transition_eligible(social_posts.*) OR (origin_type <> 'video_library'::text) OR fn_is_video_library_lineage_eligible(source_asset_id, youtube_video_id, canonical_asset_key, publication_key, NULLIF((media_urls ->> 0), ''::text)))));

CREATE POLICY "Public read access" ON public."social_stories" AS PERMISSIVE FOR SELECT TO PUBLIC USING (true);

CREATE POLICY "Users can create their own stories" ON public."social_stories" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((author_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "Users can delete their own stories" ON public."social_stories" AS PERMISSIVE FOR DELETE TO PUBLIC USING ((author_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "video_library_public_read" ON public."video_library_videos" AS PERMISSIVE FOR SELECT TO "anon","authenticated" USING (fn_is_video_library_asset_eligible(id));

CREATE POLICY "video_library_videos_service_write" ON public."video_library_videos" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);

CREATE TRIGGER tr_queue_video_transcode BEFORE INSERT ON public.social_posts FOR EACH ROW EXECUTE FUNCTION fn_queue_video_transcode();

CREATE TRIGGER trg_auto_story_on_post AFTER INSERT ON public.social_posts FOR EACH ROW WHEN ((new.origin_type IS DISTINCT FROM 'video_library'::text)) EXECUTE FUNCTION fn_auto_create_story_from_post();

CREATE TRIGGER trg_award_social_post AFTER INSERT ON public.social_posts FOR EACH ROW EXECUTE FUNCTION trgfn_award_social_post();

CREATE TRIGGER trg_reward_social_post AFTER INSERT ON public.social_posts FOR EACH ROW WHEN ((new.origin_type IS DISTINCT FROM 'video_library'::text)) EXECUTE FUNCTION fn_social_post_reward();

CREATE TRIGGER trg_social_posts_legacy_transition_marker_guard BEFORE INSERT OR UPDATE OF legacy_transition_expires_at ON public.social_posts FOR EACH ROW EXECUTE FUNCTION fn_guard_legacy_transition_marker();

CREATE TRIGGER trg_social_posts_managed_lineage_guard BEFORE INSERT OR UPDATE OF origin_type, source_asset_id, youtube_video_id, canonical_asset_key, publication_key, media_urls ON public.social_posts FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_video_lineage();

CREATE TRIGGER trg_social_posts_managed_provenance_guard BEFORE INSERT OR UPDATE OF origin_type, source_asset_id, publication_key ON public.social_posts FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_video_provenance();

CREATE TRIGGER trg_social_posts_managed_visibility_guard BEFORE INSERT OR UPDATE OF visibility, origin_type, source_asset_id, youtube_video_id, canonical_asset_key, publication_key, media_urls ON public.social_posts FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_post_visibility();

CREATE TRIGGER trg_social_posts_video_contract_defaults BEFORE INSERT OR UPDATE OF author_id, content_type, media_urls, metadata, topics, origin_type, playback_type, topic, rights_status ON public.social_posts FOR EACH ROW EXECUTE FUNCTION fn_social_posts_video_contract_defaults();

CREATE TRIGGER trg_social_posts_video_to_reel_mirror AFTER INSERT ON public.social_posts FOR EACH ROW EXECUTE FUNCTION fn_social_posts_video_to_reel_mirror();

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.claim_reward(uuid,text,jsonb)'::regprocedure) IS DISTINCT FROM 'd09e9e274128dac073662273460f3755' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','claim_reward(uuid,text,jsonb)'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_social_reward_award(uuid,text,text,text)'::regprocedure) IS DISTINCT FROM 'f7c0f8b05bc07b9b5ae6242ff12534b9' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_social_reward_award(uuid,text,text,text)'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_can_view_post(uuid,text,text[])'::regprocedure) IS DISTINCT FROM '3cb4a495c8684f3e9a59d85eace0341a' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_can_view_post(uuid,text,text[])'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_is_public_video_playback_eligible(text,text,text,uuid,text,text)'::regprocedure) IS DISTINCT FROM '0d24cd6621143f58995f1f04b9e10bb8' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_is_public_video_playback_eligible(text,text,text,uuid,text,text)'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_is_video_library_asset_eligible(uuid)'::regprocedure) IS DISTINCT FROM '9f1950d3c4413fb0c2d1609569518b65' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_is_video_library_asset_eligible(uuid)'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_is_video_library_lineage_eligible(uuid,text,text,text,text)'::regprocedure) IS DISTINCT FROM '8a2cd5407e1360ab90739ebc8ac6eceb' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_is_video_library_lineage_eligible(uuid,text,text,text,text)'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.legacy_transition_eligible(social_posts)'::regprocedure) IS DISTINCT FROM '5a1c6daa04ca74646db6f44a8b79f5da' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','legacy_transition_eligible(social_posts)'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_queue_video_transcode()'::regprocedure) IS DISTINCT FROM '68e6a34236e936d60eb492499c4569ad' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_queue_video_transcode()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_auto_create_story_from_post()'::regprocedure) IS DISTINCT FROM '584110911417f7d32d17ad4f2da20063' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_auto_create_story_from_post()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trgfn_award_social_post()'::regprocedure) IS DISTINCT FROM '2856eaa161404685cb452ec49268c917' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','trgfn_award_social_post()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_social_post_reward()'::regprocedure) IS DISTINCT FROM '977ca37d3d27b68a4dd35d7144be1c28' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_social_post_reward()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_guard_legacy_transition_marker()'::regprocedure) IS DISTINCT FROM 'b751b8bf9ee5723fd0ab06936e98796c' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_guard_legacy_transition_marker()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_guard_managed_video_lineage()'::regprocedure) IS DISTINCT FROM '12bd5f7c94f9d1ade7107c8073170fcc' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_guard_managed_video_lineage()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_guard_managed_video_provenance()'::regprocedure) IS DISTINCT FROM '7346fe1df8e06f2b04a4d59619d43f8a' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_guard_managed_video_provenance()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_guard_managed_post_visibility()'::regprocedure) IS DISTINCT FROM '715a0609c5be769c9625992303510cf0' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_guard_managed_post_visibility()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_social_posts_video_contract_defaults()'::regprocedure) IS DISTINCT FROM 'a875fb9936c13a08ad8562af2184548f' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_social_posts_video_contract_defaults()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_social_posts_video_to_reel_mirror()'::regprocedure) IS DISTINCT FROM 'd0e2aed78aeb9abf16ad9e8d4e6d1838' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_social_posts_video_to_reel_mirror()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_social_post(uuid,text,text,text[],text,jsonb,text)'::regprocedure) IS DISTINCT FROM '3c353b88d9561b69a7a421cd49623be9' THEN RAISE EXCEPTION 'Replay fixture function witness failed: %','fn_create_social_post(uuid,text,text,text[],text,jsonb,text)'; END IF; END $fixture$;

-- Canonical social_post reward policy; the retired social_post_share ID has no live definition.

INSERT INTO public.diamond_reward_catalog SELECT * FROM jsonb_populate_record(NULL::public.diamond_reward_catalog,'{"active": true, "category": "social", "diamonds": 10, "lifetime": false, "action_key": "social_post", "updated_at": "2026-07-31T22:20:14.566704+00:00", "max_per_day": 2, "counts_toward_daily_cap": true}'::jsonb) ON CONFLICT (action_key) DO NOTHING;
