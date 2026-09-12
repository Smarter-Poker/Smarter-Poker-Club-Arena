-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906235959; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906235959   (the stamp IS the apply time, UTC: 2026-09-06 23:59:59)
--   name        video_reels_integrity_foundation
--   created_by  (not recorded)
--   statements  287 statement(s), 186134 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906235959 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        trg_social_posts_legacy_transition_marker_guard, trg_social_reels_legacy_transition_marker_guard, trg_video_reels_pipeline_controls_touch, trg_video_reels_pipeline_config_touch, trg_social_posts_video_contract_defaults, trg_social_reels_yt_intercept, trg_guard_youtube_native_transcode_job, trg_cancel_revoked_youtube_transcode_jobs
--     FUNCTION       public.fn_extract_youtube_video_id, public.fn_is_platform_public_storage_url, public.fn_is_user_video_storage_url, public.fn_infer_video_topic, public.fn_is_video_library_asset_eligible, public.fn_is_video_library_lineage_eligible, public.fn_legacy_youtube_post_transition_snapshot, public.fn_legacy_youtube_reel_transition_snapshot
--     VIEW           public.video_library_public_catalog
--     TABLE          public.video_reels_legacy_transition_state, public.video_reels_legacy_transition_rows, public.video_reels_pipeline_controls, public.video_reels_pipeline_config
--     INDEX          idx_yt_failures_confirmed_active, uq_social_posts_video_library_asset, uq_social_posts_video_library_canonical, uq_social_posts_video_library_publication, uq_social_reels_video_library_asset, uq_social_reels_video_library_canonical, uq_social_reels_video_library_publication, uq_social_reels_video_library_post
--     POLICY         video_reels_legacy_transition_state_service_only, video_reels_legacy_transition_rows_service_only, video_library_public_read, video_transcode_jobs_service_only, video_reels_pipeline_controls_service_only, video_reels_pipeline_config_service_only, youtube_embed_failures_service_only, video_posts_public_select_guard
--     CONSTRAINT     youtube_embed_failures_verification_status_check on public.youtube_embed_failures, social_posts_source_asset_id_fkey on public.social_posts, social_reels_source_asset_id_fkey on public.social_reels, video_transcode_jobs_source_asset_id_fkey on public.video_transcode_jobs, video_library_videos_availability_status_check on public.video_library_videos, social_posts_origin_type_check on public.social_posts, social_reels_origin_type_check on public.social_reels, video_transcode_jobs_origin_type_check on public.video_transcode_jobs
--     DROP           POLICY video_reels_legacy_transition_state_service_only, POLICY video_reels_legacy_transition_rows_service_only, TRIGGER trg_social_posts_managed_provenance_guard, TRIGGER trg_social_reels_managed_provenance_guard, TRIGGER trg_social_posts_managed_lineage_guard, TRIGGER trg_social_reels_managed_lineage_guard, TRIGGER trg_social_posts_managed_visibility_guard, TRIGGER trg_social_reels_managed_visibility_guard
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260906235959_video_reels_integrity_foundation.sql
-- Video Library -> Reels integrity foundation.
-- TIER:        3
-- AUTHOR:      Smarter-Poker
-- AFFECTS:     video_library_videos, social_posts, social_reels,
--              video_transcode_jobs, youtube_embed_failures, RLS, views,
--              publication RPCs, and lifecycle triggers
-- IRREVERSIBLE: yes (data-preserving containment rollback only)
--
-- WHY:
--   The legacy model collapsed origin, playback, topic, and processing rights
--   into source_type. That let third-party YouTube embeds enter native download
--   jobs, let one library asset create unlinked or duplicate feed records, and
--   let stale availability evidence remain publicly playable.
--
-- HOW:
--   Add independent canonical fields and fail-closed constraints, preserve and
--   repair existing identities, create race-safe atomic publication RPCs,
--   expose revocation-fresh public views, and keep third-party YouTube content
--   embed-only unless owned or licensed rights are explicitly recorded.
--
-- This migration deliberately separates four facts which the legacy
-- source_type column had collapsed into one value:
--   * origin_type: where the record came from;
--   * playback_type: how the client should play it now;
--   * topic: what the content is about;
--   * rights_status: what processing rights Smarter.Poker has.
--
-- Third-party YouTube is embed-only by default. A native conversion can only
-- be queued when a service-role caller explicitly supplies owned/licensed
-- rights, explicitly requests native processing, and the global control is on.
-- Existing row IDs and engagement are preserved throughout the backfill.

BEGIN
SET LOCAL lock_timeout = '5s'
SET LOCAL statement_timeout = '120s'
-- ---------------------------------------------------------------------------
-- 0. Pre-flight assertions
-- ---------------------------------------------------------------------------

DO $preflight$
DECLARE
  v_relation text;
  v_missing_columns text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.video_library_videos',
    'public.social_posts',
    'public.social_reels',
    'public.video_transcode_jobs',
    'public.youtube_embed_failures',
    'public.profiles',
    'storage.objects'
  ]
  LOOP
    IF to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'video reels foundation pre-flight: required relation % is missing', v_relation;
    END IF;
  END LOOP;

  SELECT string_agg(required.table_name || '.' || required.column_name, ', ')
  INTO v_missing_columns
  FROM (VALUES
    ('video_library_videos', 'id'),
    ('video_library_videos', 'youtube_video_id'),
    ('video_library_videos', 'type'),
    ('social_posts', 'id'),
    ('social_posts', 'author_id'),
    ('social_posts', 'content_type'),
    ('social_posts', 'media_urls'),
    ('social_reels', 'id'),
    ('social_reels', 'author_id'),
    ('social_reels', 'video_url'),
    ('social_reels', 'source_post_id'),
    ('video_transcode_jobs', 'id'),
    ('video_transcode_jobs', 'reel_id'),
    ('video_transcode_jobs', 'source_type'),
    ('video_transcode_jobs', 'status'),
    ('youtube_embed_failures', 'video_id'),
    ('profiles', 'id')
  ) AS required(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns existing
    WHERE existing.table_schema = 'public'
      AND existing.table_name = required.table_name
      AND existing.column_name = required.column_name
  );

  IF v_missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'video reels foundation pre-flight: required column(s) missing: %',
      v_missing_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'storage'
      AND table_name = 'objects'
      AND column_name = 'archived_at'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'storage'
      AND table_name = 'objects'
      AND column_name = 'is_delete_marker'
  ) THEN
    RAISE EXCEPTION
      'video reels foundation pre-flight: storage.objects lifecycle columns are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'video_library_videos'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'video reels foundation pre-flight: video_library_videos.id must be uuid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'video_transcode_jobs'
      AND column_name = 'id'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'video reels foundation pre-flight: video_transcode_jobs.id must be text';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
  THEN
    RAISE EXCEPTION 'video reels foundation pre-flight: required API role is missing';
  END IF;

  IF to_regprocedure('public.fn_can_view_post(uuid,text,text[])') IS NULL THEN
    RAISE EXCEPTION
      'video reels foundation pre-flight: required privacy helper public.fn_can_view_post(uuid,text,text[]) is missing';
  END IF;

  IF to_regprocedure('public.fn_set_updated_at()') IS NULL
     OR to_regprocedure('public.fn_video_transcode_jobs_touch_updated_at()') IS NULL
  THEN
    RAISE EXCEPTION
      'video reels foundation pre-flight: required audit timestamp helper is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.youtube_embed_failures'::regclass
      AND constraint_row.conname = 'youtube_embed_failures_video_id_key'
      AND constraint_row.contype = 'u'
  ) THEN
    RAISE EXCEPTION
      'video reels foundation pre-flight: youtube_embed_failures_video_id_key unique constraint is missing';
  END IF;
END
$preflight$
-- ---------------------------------------------------------------------------
-- 1. Canonical identity helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_extract_youtube_video_id(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public
AS $function$
  WITH normalized AS (
    SELECT btrim(p_value) AS value
  )
  SELECT CASE
    WHEN value ~ '^[A-Za-z0-9_-]{11}$'
      THEN value
    WHEN value ~* '^https?://(?:(?:www|m|music)\.)?youtube\.com/watch\?[^#]*(?:#.*)?$'
      AND split_part(split_part(value, '?', 2), '#', 1)
        ~* '(?:^|&)v=[A-Za-z0-9_-]{11}(?:&|$)'
      THEN substring(
        split_part(split_part(value, '?', 2), '#', 1)
        FROM '(?i)(?:^|&)v=([A-Za-z0-9_-]{11})(?:&|$)'
      )
    WHEN value ~* '^https?://youtu\.be/[A-Za-z0-9_-]{11}(?:[/?#].*)?$'
      THEN substring(
        value FROM '(?i)^https?://youtu\.be/([A-Za-z0-9_-]{11})(?:[/?#]|$)'
      )
    WHEN value ~* '^https?://(?:(?:www|m)\.)?youtube\.com/shorts/[A-Za-z0-9_-]{11}(?:[/?#].*)?$'
      THEN substring(
        value FROM '(?i)/shorts/([A-Za-z0-9_-]{11})(?:[/?#]|$)'
      )
    WHEN value ~* '^https?://(?:(?:www|m)\.)?youtube\.com/embed/[A-Za-z0-9_-]{11}(?:[/?#].*)?$'
      THEN substring(
        value FROM '(?i)/embed/([A-Za-z0-9_-]{11})(?:[/?#]|$)'
      )
    WHEN value ~* '^https?://(?:www\.)?youtube-nocookie\.com/embed/[A-Za-z0-9_-]{11}(?:[/?#].*)?$'
      THEN substring(
        value FROM '(?i)/embed/([A-Za-z0-9_-]{11})(?:[/?#]|$)'
      )
    WHEN value ~* '^https?://(?:(?:www|m)\.)?youtube\.com/live/[A-Za-z0-9_-]{11}(?:[/?#].*)?$'
      THEN substring(
        value FROM '(?i)/live/([A-Za-z0-9_-]{11})(?:[/?#]|$)'
      )
    ELSE NULL
  END
  FROM normalized
$function$
COMMENT ON FUNCTION public.fn_extract_youtube_video_id(text) IS
  'Returns an 11-character YouTube video id from a video id or supported YouTube URL; otherwise NULL.'
-- SECURITY EXCEPTION: PostgreSQL has no reliable project-origin setting during
-- migrations or direct maintenance sessions. This exact production public
-- Storage origin is intentionally centralized here so an attacker-controlled
-- Supabase project cannot borrow a real object name from this database. App
-- code derives the same origin from NEXT_PUBLIC_SUPABASE_URL; only this
-- database trust-boundary helper is pinned to the project it protects.
CREATE OR REPLACE FUNCTION public.fn_is_platform_public_storage_url(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public
AS $function$
  SELECT p_url LIKE
    'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/%'
$function$
COMMENT ON FUNCTION public.fn_is_platform_public_storage_url(text) IS
  'Security boundary for this deployment: accepts only the exact Smarter.Poker public Storage origin.'
-- A native user-authorized Reel must point at a video object uploaded into
-- that exact author's server-assigned namespace. Merely containing the word
-- "supabase" is not evidence of ownership: the legacy scrapers also wrote
-- third-party transcodes into Storage. The object lookup additionally proves
-- that the URL was not fabricated and that its stored MIME type is video.
CREATE OR REPLACE FUNCTION public.fn_is_user_video_storage_url(
  p_url text,
  p_author_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
  WITH parsed AS (
    SELECT CASE
      WHEN public.fn_is_platform_public_storage_url(p_url)
       AND p_url !~ '[?#]'
      THEN split_part(split_part(
        substring(p_url FROM '^https://[^/]+/storage/v1/object/public/(.*)$'),
        '?', 1
      ), '#', 1)
      ELSE NULL
    END AS object_ref
  ), object_identity AS (
    SELECT split_part(object_ref, '/', 1) AS bucket_id,
           substring(object_ref FROM position('/' IN object_ref) + 1) AS object_name
    FROM parsed
    WHERE object_ref IS NOT NULL
      AND position('/' IN object_ref) > 0
  )
  SELECT p_author_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM object_identity parsed_object
    JOIN storage.objects stored_object
      ON stored_object.bucket_id = parsed_object.bucket_id
     AND stored_object.name = parsed_object.object_name
    WHERE stored_object.archived_at IS NULL
      AND COALESCE(stored_object.is_delete_marker, false) IS FALSE
      AND COALESCE(stored_object.metadata ->> 'mimetype', '') LIKE 'video/%'
      -- Public playback clients intentionally accept exactly one filename
      -- below the author directory. Match that contract here so a nested
      -- object cannot be published successfully and then disappear from every
      -- feed as untrusted. Reject an encoded slash for the same reason.
      AND parsed_object.object_name !~* '%2f'
      AND (
        (
          parsed_object.bucket_id = 'social-media'
          AND (
            parsed_object.object_name ~
              ('^reels/' || p_author_id::text || '/[^/]+$')
            OR parsed_object.object_name ~
              ('^videos/' || p_author_id::text || '/[^/]+$')
          )
        )
        OR (
          parsed_object.bucket_id = 'stories'
          AND parsed_object.object_name ~
            ('^stories/' || p_author_id::text || '/[^/]+$')
        )
        OR (
          parsed_object.bucket_id = 'live-recordings'
          AND parsed_object.object_name ~
            ('^' || p_author_id::text || '/[^/]+$')
        )
      )
  )
$function$
COMMENT ON FUNCTION public.fn_is_user_video_storage_url(text, uuid) IS
  'Proves that a public Storage URL names an existing video in the supplied author namespace.'
CREATE OR REPLACE FUNCTION public.fn_infer_video_topic(
  p_metadata jsonb,
  p_topics text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $function$
  SELECT CASE
    -- The content collectors' explicit classifier is the strongest historical
    -- evidence and takes precedence over every source-name fallback.
    WHEN lower(btrim(COALESCE(p_metadata ->> 'clip_type', ''))) = 'poker'
      THEN 'poker'
    WHEN lower(btrim(COALESCE(p_metadata ->> 'clip_type', ''))) = 'sports'
      THEN 'sports'
    WHEN upper(btrim(COALESCE(
      p_metadata ->> 'source',
      p_metadata ->> 'source_id',
      ''
    ))) IN (
      'HCL', 'TCH', 'LATB', 'POKERGO', 'HELLMUTH', 'POLK', 'WOLFGANG',
      'MARIANO', 'JLITTLE', 'NEEME', 'BRAD', 'WPT', 'RAMPAGE', 'LODGE',
      'EPT', 'DANIEL', 'WSOP', 'TRITON'
    ) THEN 'poker'
    WHEN upper(btrim(COALESCE(
      p_metadata ->> 'source',
      p_metadata ->> 'source_id',
      ''
    ))) IN (
      'BLEACHER REPORT NBA', 'WARRIORS', 'LAKERS', 'CELTICS', 'BUCKS',
      'HEAT', 'HOUSE OF HIGHLIGHTS', 'NBA', 'ESPN NBA'
    ) THEN 'sports'
    WHEN EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p_topics, ARRAY[]::text[])) AS supplied_topic(value)
      WHERE lower(supplied_topic.value) IN ('poker', 'cash', 'tournament')
    ) THEN 'poker'
    WHEN EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p_topics, ARRAY[]::text[])) AS supplied_topic(value)
      WHERE lower(supplied_topic.value) = 'sports'
    ) THEN 'sports'
    ELSE 'unknown'
  END
$function$
COMMENT ON FUNCTION public.fn_infer_video_topic(jsonb, text[]) IS
  'Conservatively classifies historical video metadata as poker/sports; missing or unrecognized evidence remains unknown.'
-- ---------------------------------------------------------------------------
-- 2. Orthogonal provenance/playback/rights fields and verification state
-- ---------------------------------------------------------------------------

ALTER TABLE public.video_library_videos
  ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS embeddable boolean,
  ADD COLUMN IF NOT EXISTS availability_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS availability_failure_reason text,
  ADD COLUMN IF NOT EXISTS availability_source text
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS origin_type text,
  ADD COLUMN IF NOT EXISTS playback_type text,
  ADD COLUMN IF NOT EXISTS topic text,
  ADD COLUMN IF NOT EXISTS rights_status text,
  ADD COLUMN IF NOT EXISTS source_asset_id uuid,
  ADD COLUMN IF NOT EXISTS youtube_video_id text,
  ADD COLUMN IF NOT EXISTS canonical_asset_key text,
  ADD COLUMN IF NOT EXISTS publication_key text,
  ADD COLUMN IF NOT EXISTS legacy_transition_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false
ALTER TABLE public.social_reels
  ADD COLUMN IF NOT EXISTS origin_type text,
  ADD COLUMN IF NOT EXISTS playback_type text,
  ADD COLUMN IF NOT EXISTS topic text,
  ADD COLUMN IF NOT EXISTS rights_status text,
  ADD COLUMN IF NOT EXISTS source_asset_id uuid,
  ADD COLUMN IF NOT EXISTS canonical_asset_key text,
  ADD COLUMN IF NOT EXISTS publication_key text,
  ADD COLUMN IF NOT EXISTS legacy_transition_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS native_processing_requested boolean NOT NULL DEFAULT false
-- The job carries a copy of the authorization and asset identity used when it
-- was enqueued. attempts/locked_at are included because production already has
-- them while older local schemas do not.
ALTER TABLE public.video_transcode_jobs
  ADD COLUMN IF NOT EXISTS origin_type text,
  ADD COLUMN IF NOT EXISTS rights_status text,
  ADD COLUMN IF NOT EXISTS source_asset_id uuid,
  ADD COLUMN IF NOT EXISTS canonical_asset_key text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz
-- Historical player reports were immediately censoring videos. Preserve the
-- counters, but treat every pre-verification unresolved report as pending and
-- fail open until a trusted verifier confirms it.
DO $youtube_failure_schema$
DECLARE
  v_had_verification_status boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'youtube_embed_failures'
      AND c.column_name = 'verification_status'
  )
  INTO v_had_verification_status;

  ALTER TABLE public.youtube_embed_failures
    ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

  IF NOT v_had_verification_status THEN
    UPDATE public.youtube_embed_failures
    SET verification_status = 'pending',
        last_verified_at = NULL,
        resolved = true;
  END IF;
END
$youtube_failure_schema$
UPDATE public.youtube_embed_failures
SET verification_status = 'error',
    resolved = true,
    last_verified_at = COALESCE(last_verified_at, last_seen_at, now())
WHERE verification_status IS NULL
   OR verification_status NOT IN ('pending', 'confirmed', 'resolved', 'error')
UPDATE public.youtube_embed_failures
SET resolved = CASE WHEN verification_status = 'confirmed' THEN false ELSE true END,
    last_verified_at = CASE
      WHEN verification_status = 'pending' THEN NULL
      ELSE COALESCE(last_verified_at, last_seen_at, now())
    END,
    hit_count = GREATEST(COALESCE(hit_count, 0), 0)
ALTER TABLE public.youtube_embed_failures
  ALTER COLUMN resolved SET DEFAULT true,
  ALTER COLUMN resolved SET NOT NULL,
  ALTER COLUMN verification_status SET DEFAULT 'pending',
  ALTER COLUMN verification_status SET NOT NULL,
  ALTER COLUMN hit_count SET DEFAULT 1,
  ALTER COLUMN hit_count SET NOT NULL
ALTER TABLE public.youtube_embed_failures
  DROP CONSTRAINT IF EXISTS youtube_embed_failures_verification_status_check,
  DROP CONSTRAINT IF EXISTS youtube_embed_failures_verification_resolution_check
ALTER TABLE public.youtube_embed_failures
  ADD CONSTRAINT youtube_embed_failures_verification_status_check
    CHECK (verification_status IN ('pending', 'confirmed', 'resolved', 'error')),
  ADD CONSTRAINT youtube_embed_failures_verification_resolution_check
    CHECK (
      (verification_status = 'confirmed' AND resolved = false)
      OR (verification_status <> 'confirmed' AND resolved = true)
    )
CREATE INDEX IF NOT EXISTS idx_yt_failures_confirmed_active
  ON public.youtube_embed_failures (video_id)
  WHERE verification_status = 'confirmed' AND resolved = false
-- Phase 1 introduces a stricter fresh-verification gate, but production also
-- contains historical public YouTube rows whose IDs have not yet been drained
-- by the trusted verifier. Preserve only the exact pre-migration row snapshots
-- for one bounded verifier window. This is not a verification verdict: any
-- confirmed failure wins immediately, changed/new rows do not inherit it, and
-- a repeat apply cannot extend the deadline or capture additional rows.
CREATE TABLE IF NOT EXISTS public.video_reels_legacy_transition_state (
  transition_key text PRIMARY KEY,
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT video_reels_legacy_transition_key_check
    CHECK (transition_key = 'phase1-public-youtube'),
  CONSTRAINT video_reels_legacy_transition_window_check
    CHECK (expires_at = captured_at + interval '7 days')
)
CREATE TABLE IF NOT EXISTS public.video_reels_legacy_transition_rows (
  surface text NOT NULL,
  row_id uuid NOT NULL,
  youtube_video_id text NOT NULL,
  row_snapshot jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (surface, row_id),
  CONSTRAINT video_reels_legacy_transition_surface_check
    CHECK (surface IN ('social_posts', 'social_reels')),
  CONSTRAINT video_reels_legacy_transition_youtube_id_check
    CHECK (
      youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
      AND youtube_video_id NOT LIKE 'FAKE%'
    ),
  CONSTRAINT video_reels_legacy_transition_row_window_check
    CHECK (expires_at = captured_at + interval '7 days')
)
ALTER TABLE public.video_reels_legacy_transition_state ENABLE ROW LEVEL SECURITY
ALTER TABLE public.video_reels_legacy_transition_rows ENABLE ROW LEVEL SECURITY
DROP POLICY IF EXISTS video_reels_legacy_transition_state_service_only
  ON public.video_reels_legacy_transition_state
CREATE POLICY video_reels_legacy_transition_state_service_only
  ON public.video_reels_legacy_transition_state
  FOR SELECT
  TO service_role
  USING (true)
DROP POLICY IF EXISTS video_reels_legacy_transition_rows_service_only
  ON public.video_reels_legacy_transition_rows
CREATE POLICY video_reels_legacy_transition_rows_service_only
  ON public.video_reels_legacy_transition_rows
  FOR SELECT
  TO service_role
  USING (true)
REVOKE ALL ON TABLE public.video_reels_legacy_transition_state,
  public.video_reels_legacy_transition_rows
  FROM PUBLIC, anon, authenticated, service_role
GRANT SELECT ON TABLE public.video_reels_legacy_transition_state,
  public.video_reels_legacy_transition_rows
  TO service_role
-- A repeat apply may already have the managed-column guards installed. Remove
-- them for the deterministic migration-owned backfill and recreate them below
-- before COMMIT. A failed transaction restores the pre-migration trigger state.
DROP TRIGGER IF EXISTS trg_social_posts_managed_provenance_guard
  ON public.social_posts
DROP TRIGGER IF EXISTS trg_social_reels_managed_provenance_guard
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_social_posts_managed_lineage_guard
  ON public.social_posts
DROP TRIGGER IF EXISTS trg_social_reels_managed_lineage_guard
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_social_posts_managed_visibility_guard
  ON public.social_posts
DROP TRIGGER IF EXISTS trg_social_reels_managed_visibility_guard
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_video_library_asset_fail_closed
  ON public.video_library_videos
DROP TRIGGER IF EXISTS trg_social_reels_yt_intercept
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_social_reels_yt_queue_job
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_social_reels_block_too_long
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_social_posts_video_contract_defaults
  ON public.social_posts
DROP TRIGGER IF EXISTS trg_social_posts_legacy_transition_marker_guard
  ON public.social_posts
DROP TRIGGER IF EXISTS trg_social_reels_legacy_transition_marker_guard
  ON public.social_reels
-- The containment rollback deliberately leaves these safety triggers in
-- place. Suspend them during migration-owned normalization as well: otherwise
-- a disabled control plus an inert queued job makes the next forward apply
-- invoke the old guard before this migration reaches its containment pass.
-- Every trigger is recreated below before COMMIT, and transactional DDL
-- restores the pre-apply definitions automatically if anything fails.
DROP TRIGGER IF EXISTS trg_guard_youtube_native_transcode_job
  ON public.video_transcode_jobs
DROP TRIGGER IF EXISTS trg_cancel_revoked_youtube_transcode_jobs
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_reel_falls_back_when_job_dies
  ON public.video_transcode_jobs
DROP TRIGGER IF EXISTS trg_filtered_too_long_delete_reel
  ON public.video_transcode_jobs
-- Preserve historical audit timestamps during the deterministic backfill.
-- These existing touch triggers are recreated before COMMIT; transaction
-- rollback restores them automatically if any migration statement fails.
DROP TRIGGER IF EXISTS trg_social_reels_updated_at
  ON public.social_reels
DROP TRIGGER IF EXISTS trg_video_transcode_jobs_touch
  ON public.video_transcode_jobs
-- Repeat application can encounter the final validated CHECK constraints
-- before the repair updates below. Remove them along with the guards so the
-- migration can normalize a partially migrated row, then recreate and
-- validate the complete contract in section 4.
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_origin_type_check,
  DROP CONSTRAINT IF EXISTS social_posts_playback_type_check,
  DROP CONSTRAINT IF EXISTS social_posts_topic_check,
  DROP CONSTRAINT IF EXISTS social_posts_rights_status_check,
  DROP CONSTRAINT IF EXISTS social_posts_embed_rights_check,
  DROP CONSTRAINT IF EXISTS social_posts_managed_library_integrity_check
ALTER TABLE public.social_reels
  DROP CONSTRAINT IF EXISTS social_reels_origin_type_check,
  DROP CONSTRAINT IF EXISTS social_reels_playback_type_check,
  DROP CONSTRAINT IF EXISTS social_reels_topic_check,
  DROP CONSTRAINT IF EXISTS social_reels_rights_status_check,
  DROP CONSTRAINT IF EXISTS social_reels_embed_rights_check,
  DROP CONSTRAINT IF EXISTS social_reels_native_processing_rights_check,
  DROP CONSTRAINT IF EXISTS social_reels_managed_library_integrity_check
ALTER TABLE public.video_transcode_jobs
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_origin_type_check,
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_rights_status_check,
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_native_rights_check
-- Centralize the public-playback decision so direct table reads, time-based
-- expiry, the publisher, and update-time fail-closed behavior cannot drift.
-- The row-lineage overload below additionally proves that a managed row is
-- actually playing the same YouTube asset named by its foreign key.
CREATE OR REPLACE FUNCTION public.fn_is_video_library_asset_eligible(
  p_asset_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
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
-- The public catalog must not assemble a potentially truncated failure list
-- in application memory. This view evaluates the correlated NOT EXISTS gate
-- in fn_is_video_library_asset_eligible for every row before count/range
-- pagination, so confirmed takedowns and malformed IDs cannot shift offsets.
CREATE OR REPLACE VIEW public.video_library_public_catalog
WITH (security_barrier = true)
AS
SELECT
  v.youtube_video_id,
  v.source_id,
  v.source_name,
  v.type,
  v.title,
  v.thumbnail_url,
  v.views_text,
  v.views_count,
  v.duration,
  v.published_at,
  v.scraped_at,
  v.tags,
  v.availability_status,
  v.embeddable,
  v.availability_checked_at
FROM public.video_library_videos v
WHERE public.fn_is_video_library_asset_eligible(v.id)
REVOKE ALL ON TABLE public.video_library_public_catalog
  FROM PUBLIC, anon, authenticated
GRANT SELECT ON TABLE public.video_library_public_catalog TO service_role
CREATE OR REPLACE FUNCTION public.fn_is_video_library_lineage_eligible(
  p_asset_id uuid,
  p_youtube_video_id text,
  p_canonical_asset_key text,
  p_publication_key text,
  p_playback_url text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
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
COMMENT ON FUNCTION public.fn_is_video_library_asset_eligible(uuid) IS
  'Fail-closed freshness, topic, embedding, and active-failure gate for a managed library asset.'
COMMENT ON FUNCTION public.fn_is_video_library_lineage_eligible(uuid, text, text, text, text) IS
  'Public-playback gate that also proves a managed row plays the exact referenced library asset.'
-- Replace the legacy USING(true) base-table read. The service-only catalog
-- view remains the application entry point, but an anon client holding the
-- public project key must not bypass the same freshness and rights gate.
ALTER TABLE public.video_library_videos ENABLE ROW LEVEL SECURITY
DROP POLICY IF EXISTS video_library_public_read
  ON public.video_library_videos
CREATE POLICY video_library_public_read
  ON public.video_library_videos
  FOR SELECT
  TO anon, authenticated
  USING (public.fn_is_video_library_asset_eligible(id))
-- Explicitly named foreign keys make delete behavior visible. Library assets
-- cannot be deleted out from underneath a published post/reel provenance link.
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_source_asset_id_fkey
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_source_asset_id_fkey
  FOREIGN KEY (source_asset_id)
  REFERENCES public.video_library_videos(id)
  ON DELETE RESTRICT
  NOT VALID
ALTER TABLE public.social_reels
  DROP CONSTRAINT IF EXISTS social_reels_source_asset_id_fkey
ALTER TABLE public.social_reels
  ADD CONSTRAINT social_reels_source_asset_id_fkey
  FOREIGN KEY (source_asset_id)
  REFERENCES public.video_library_videos(id)
  ON DELETE RESTRICT
  NOT VALID
ALTER TABLE public.video_transcode_jobs
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_source_asset_id_fkey
ALTER TABLE public.video_transcode_jobs
  ADD CONSTRAINT video_transcode_jobs_source_asset_id_fkey
  FOREIGN KEY (source_asset_id)
  REFERENCES public.video_library_videos(id)
  ON DELETE RESTRICT
  NOT VALID
-- ---------------------------------------------------------------------------
-- 3. Conservative, ID-preserving backfill
-- ---------------------------------------------------------------------------

UPDATE public.social_posts p
SET youtube_video_id = public.fn_extract_youtube_video_id(
      COALESCE(NULLIF(p.media_urls ->> 0, ''), p.link_url)
    )
WHERE p.youtube_video_id IS NULL
  AND public.fn_extract_youtube_video_id(
        COALESCE(NULLIF(p.media_urls ->> 0, ''), p.link_url)
      ) IS NOT NULL
UPDATE public.social_posts p
SET canonical_asset_key = 'youtube:' || public.fn_extract_youtube_video_id(
      COALESCE(NULLIF(p.media_urls ->> 0, ''), p.link_url)
    )
WHERE p.canonical_asset_key IS NULL
  AND public.fn_extract_youtube_video_id(
        COALESCE(NULLIF(p.media_urls ->> 0, ''), p.link_url)
      ) IS NOT NULL
UPDATE public.social_posts
SET playback_type = CASE
      WHEN canonical_asset_key LIKE 'youtube:%' THEN 'youtube_embed'
      WHEN COALESCE(media_urls ->> 0, '') ILIKE '%supabase%/storage/%' THEN 'native'
      ELSE 'external_embed'
    END,
    rights_status = CASE
      WHEN canonical_asset_key LIKE 'youtube:%' THEN 'embed_only'
      ELSE 'unknown'
    END,
    origin_type = 'legacy',
    topic = public.fn_infer_video_topic(metadata, topics)
WHERE playback_type IS NULL
   OR rights_status IS NULL
   OR origin_type IS NULL
   OR topic IS NULL
-- Repair partially migrated environments and make the existing collector
-- classification authoritative when it is explicit. Unknown evidence is not
-- promoted by this pass.
UPDATE public.social_posts p
SET topic = public.fn_infer_video_topic(p.metadata, p.topics)
WHERE p.content_type = 'video'
  AND public.fn_infer_video_topic(p.metadata, p.topics) <> 'unknown'
  AND p.topic IS DISTINCT FROM public.fn_infer_video_topic(p.metadata, p.topics)
-- A horse profile is provenance evidence, but not by itself topic evidence.
UPDATE public.social_posts p
SET origin_type = 'horse'
FROM public.profiles profile
WHERE profile.id = p.author_id
  AND COALESCE(profile.is_horse, false)
  AND p.origin_type = 'legacy'
UPDATE public.social_reels r
SET youtube_video_id = COALESCE(
      r.youtube_video_id,
      public.fn_extract_youtube_video_id(r.original_youtube_url),
      public.fn_extract_youtube_video_id(r.video_url)
    )
WHERE r.youtube_video_id IS NULL
  AND COALESCE(
        public.fn_extract_youtube_video_id(r.original_youtube_url),
        public.fn_extract_youtube_video_id(r.video_url)
      ) IS NOT NULL
UPDATE public.social_reels
SET canonical_asset_key = 'youtube:' || youtube_video_id
WHERE canonical_asset_key IS NULL
  AND youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
UPDATE public.social_reels
SET playback_type = CASE
      WHEN video_url ILIKE '%supabase%/storage/%' THEN 'native'
      WHEN canonical_asset_key LIKE 'youtube:%'
           AND public.fn_extract_youtube_video_id(video_url) IS NOT NULL
        THEN 'youtube_embed'
      ELSE 'external_embed'
    END,
    rights_status = CASE
      WHEN canonical_asset_key LIKE 'youtube:%'
           AND public.fn_extract_youtube_video_id(video_url) IS NOT NULL
        THEN 'embed_only'
      ELSE 'unknown'
    END,
    origin_type = CASE
      WHEN source_story_id IS NOT NULL THEN 'story'
      WHEN source_post_id IS NOT NULL THEN 'social_post'
      WHEN source_type = 'user' THEN 'user_upload'
      ELSE 'legacy'
    END,
    topic = 'unknown'
WHERE playback_type IS NULL
   OR rights_status IS NULL
   OR origin_type IS NULL
   OR topic IS NULL
-- Historical native rows were created by a legacy YouTube downloader without
-- persisted rights evidence. Restore those rows to their canonical YouTube
-- embed instead of treating a Storage copy as proof of ownership. IDs,
-- engagement, attribution, and linked-post relationships are preserved.
UPDATE public.social_posts p
SET media_urls = CASE
      WHEN jsonb_typeof(p.media_urls) = 'array'
        AND jsonb_array_length(p.media_urls) > 0
      THEN jsonb_set(
        p.media_urls,
        '{0}',
        to_jsonb(
          'https://www.youtube.com/watch?v=' ||
          public.fn_extract_youtube_video_id(p.original_media_url)
        ),
        false
      )
      ELSE jsonb_build_array(
        'https://www.youtube.com/watch?v=' ||
        public.fn_extract_youtube_video_id(p.original_media_url)
      )
    END,
    playback_type = 'youtube_embed',
    rights_status = 'embed_only',
    youtube_video_id = public.fn_extract_youtube_video_id(p.original_media_url),
    canonical_asset_key = 'youtube:' ||
      public.fn_extract_youtube_video_id(p.original_media_url)
WHERE p.content_type = 'video'
  AND p.playback_type = 'native'
  AND p.rights_status = 'unknown'
  AND public.fn_extract_youtube_video_id(p.original_media_url) IS NOT NULL
UPDATE public.social_reels r
SET video_url = 'https://www.youtube.com/watch?v=' ||
      public.fn_extract_youtube_video_id(r.original_youtube_url),
    original_youtube_url = 'https://www.youtube.com/watch?v=' ||
      public.fn_extract_youtube_video_id(r.original_youtube_url),
    playback_type = 'youtube_embed',
    rights_status = 'embed_only',
    source_type = CASE
      WHEN r.origin_type = 'video_library' THEN 'video_library'
      ELSE 'youtube'
    END,
    youtube_video_id = public.fn_extract_youtube_video_id(r.original_youtube_url),
    canonical_asset_key = 'youtube:' ||
      public.fn_extract_youtube_video_id(r.original_youtube_url),
    media_status = 'ready',
    native_processing_requested = false
WHERE r.playback_type = 'native'
  AND r.rights_status = 'unknown'
  AND public.fn_extract_youtube_video_id(r.original_youtube_url) IS NOT NULL
-- The remaining legacy native rows are accepted only when the object exists
-- in that exact author's upload namespace. Everything else is retained but
-- made private until an explicit rights reconciliation is recorded.
UPDATE public.social_posts p
SET rights_status = 'user_authorized',
    canonical_asset_key = 'native:' || md5(
      split_part(split_part(NULLIF(p.media_urls ->> 0, ''), '?', 1), '#', 1)
    ),
    youtube_video_id = NULL
WHERE p.content_type = 'video'
  AND p.playback_type = 'native'
  AND p.rights_status = 'unknown'
  AND public.fn_is_user_video_storage_url(
    NULLIF(p.media_urls ->> 0, ''),
    p.author_id
  )
UPDATE public.social_reels r
SET rights_status = 'user_authorized',
    canonical_asset_key = 'native:' || md5(
      split_part(split_part(r.video_url, '?', 1), '#', 1)
    ),
    youtube_video_id = NULL,
    original_youtube_url = NULL,
    native_processing_requested = false,
    source_type = 'native'
WHERE r.playback_type = 'native'
  AND r.rights_status = 'unknown'
  AND public.fn_is_user_video_storage_url(r.video_url, r.author_id)
UPDATE public.social_posts p
SET visibility = 'private'
WHERE p.content_type = 'video'
  AND p.playback_type = 'native'
  AND p.rights_status NOT IN ('owned', 'licensed', 'user_authorized')
  AND p.visibility IS DISTINCT FROM 'private'
UPDATE public.social_reels r
SET is_public = false,
    native_processing_requested = false
WHERE r.playback_type = 'native'
  AND r.rights_status NOT IN ('owned', 'licensed', 'user_authorized')
  AND r.is_public = true
-- Carry explicit topic/provenance evidence across the existing post link. This
-- keeps proven poker rows discoverable without guessing that every historical
-- YouTube URL is poker. Unknown legacy rows retain their IDs but fail closed
-- from public playback and discovery until explicitly classified.
UPDATE public.social_reels r
SET topic = CASE
      WHEN p.topic IN ('poker', 'cash', 'tournament') THEN 'poker'
      WHEN p.topic = 'sports' THEN 'sports'
      ELSE r.topic
    END,
    origin_type = CASE
      WHEN r.origin_type = 'video_library'
        OR r.source_asset_id IS NOT NULL
        OR r.publication_key LIKE 'video-library:%'
        THEN 'video_library'
      WHEN p.origin_type = 'horse' THEN 'horse'
      ELSE 'social_post'
    END
FROM public.social_posts p
WHERE p.id = r.source_post_id
-- Capture the transition deadline once. ALTER TABLE above holds the affected
-- relations against concurrent writers for this transaction, so the marker is
-- an exact snapshot of rows committed before this migration began. The local
-- setting is used only to finish the first capture later in this transaction;
-- it is deliberately false on every reapply.
DO $capture_legacy_youtube_transition$
DECLARE
  v_captured_at timestamptz := statement_timestamp();
  v_expires_at timestamptz;
BEGIN
  INSERT INTO public.video_reels_legacy_transition_state (
    transition_key,
    captured_at,
    expires_at
  ) VALUES (
    'phase1-public-youtube',
    v_captured_at,
    v_captured_at + interval '7 days'
  )
  ON CONFLICT (transition_key) DO NOTHING
  RETURNING expires_at INTO v_expires_at;

  IF v_expires_at IS NULL THEN
    PERFORM set_config('app.capture_legacy_youtube_transition', '0', true);
    RETURN;
  END IF;

  PERFORM set_config('app.capture_legacy_youtube_transition', '1', true);

  UPDATE public.social_posts p
  SET legacy_transition_expires_at = v_expires_at
  WHERE p.content_type = 'video'
    AND COALESCE(p.is_deleted, false) = false
    AND p.visibility IS DISTINCT FROM 'private'
    AND p.playback_type = 'youtube_embed'
    AND p.rights_status IN ('embed_only', 'owned', 'licensed')
    AND p.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    AND p.youtube_video_id NOT LIKE 'FAKE%'
    AND p.canonical_asset_key = 'youtube:' || p.youtube_video_id
    AND public.fn_extract_youtube_video_id(NULLIF(p.media_urls ->> 0, ''))
        = p.youtube_video_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.youtube_embed_failures failure
      WHERE failure.video_id = p.youtube_video_id
        AND failure.verification_status = 'confirmed'
        AND failure.resolved = false
    );

  UPDATE public.social_reels r
  SET legacy_transition_expires_at = v_expires_at
  WHERE COALESCE(r.is_deleted, false) = false
    AND r.is_public = true
    AND r.playback_type = 'youtube_embed'
    AND r.rights_status IN ('embed_only', 'owned', 'licensed')
    AND r.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    AND r.youtube_video_id NOT LIKE 'FAKE%'
    AND r.canonical_asset_key = 'youtube:' || r.youtube_video_id
    AND public.fn_extract_youtube_video_id(r.video_url) = r.youtube_video_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.youtube_embed_failures failure
      WHERE failure.video_id = r.youtube_video_id
        AND failure.verification_status = 'confirmed'
        AND failure.resolved = false
    );
END
$capture_legacy_youtube_transition$
-- Only the historical source_type=video_library rows that can be proved to
-- match an actual library asset are promoted to managed provenance.
UPDATE public.social_reels r
SET source_asset_id = v.id,
    canonical_asset_key = 'youtube:' || v.youtube_video_id,
    publication_key = 'video-library:' || v.id::text,
    origin_type = 'video_library',
    playback_type = 'youtube_embed',
    topic = CASE
      WHEN v.type IN ('cash', 'tournament') THEN 'poker'
      WHEN v.type = 'slots' THEN 'slots'
      ELSE 'other'
    END,
    rights_status = 'embed_only',
    native_processing_requested = false,
    youtube_video_id = v.youtube_video_id,
    original_youtube_url =
      'https://www.youtube.com/watch?v=' || v.youtube_video_id,
    video_url = 'https://www.youtube.com/watch?v=' || v.youtube_video_id,
    media_status = 'ready',
    is_public = CASE
      WHEN v.type IN ('cash', 'tournament')
       AND v.availability_status = 'verified'
       AND v.embeddable IS TRUE
       AND v.availability_checked_at >= now() - interval '7 days'
       AND v.availability_checked_at <= now() + interval '5 minutes'
        THEN r.is_public
      WHEN r.legacy_transition_expires_at > now()
        THEN r.is_public
      ELSE false
    END,
    source_type = 'video_library'
FROM public.video_library_videos v
WHERE r.source_type = 'video_library'
  AND (
    r.youtube_video_id = v.youtube_video_id
    OR public.fn_extract_youtube_video_id(r.video_url) = v.youtube_video_id
  )
  AND r.id = (
    SELECT candidate.id
    FROM public.social_reels candidate
    WHERE candidate.source_type = 'video_library'
      AND (
        candidate.youtube_video_id = v.youtube_video_id
        OR public.fn_extract_youtube_video_id(candidate.video_url) = v.youtube_video_id
      )
    ORDER BY candidate.created_at ASC NULLS LAST, candidate.id ASC
    LIMIT 1
  )
-- If an old environment contains duplicate legacy library rows, retain every
-- row and all engagement but designate only the deterministic oldest row as
-- the managed canonical record. This makes the new uniqueness enforceable
-- without deleting or merging history.
WITH ranked_managed AS (
  SELECT r.id,
         row_number() OVER (
           PARTITION BY r.canonical_asset_key
           ORDER BY r.created_at ASC NULLS LAST, r.id ASC
         ) AS ordinal
  FROM public.social_reels r
  WHERE r.origin_type = 'video_library'
    AND r.canonical_asset_key IS NOT NULL
)
UPDATE public.social_reels r
SET origin_type = 'legacy',
    source_asset_id = NULL,
    publication_key = NULL
FROM ranked_managed d
WHERE r.id = d.id
  AND d.ordinal > 1
-- Every unpromoted historical library marker fails closed. Its row id and
-- engagement remain intact for audit/reconciliation, but it cannot bypass the
-- managed eligibility gate merely because it lost the canonical tie-break.
UPDATE public.social_reels
SET is_public = false,
    native_processing_requested = false
WHERE source_type = 'video_library'
  AND origin_type <> 'video_library'
  AND NOT (legacy_transition_expires_at > now())
CREATE OR REPLACE FUNCTION public.fn_legacy_youtube_post_transition_snapshot(
  p_post public.social_posts
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $function$
  SELECT jsonb_build_object(
    'author_id', (p_post).author_id,
    'content_type', (p_post).content_type,
    'playback_url', NULLIF((p_post).media_urls ->> 0, ''),
    'origin_type', (p_post).origin_type,
    'playback_type', (p_post).playback_type,
    'topic', (p_post).topic,
    'rights_status', (p_post).rights_status,
    'source_asset_id', (p_post).source_asset_id,
    'youtube_video_id', (p_post).youtube_video_id,
    'canonical_asset_key', (p_post).canonical_asset_key,
    'publication_key', (p_post).publication_key,
    'is_deleted', COALESCE((p_post).is_deleted, false),
    'visibility', (p_post).visibility,
    'audience_mode', (p_post).audience_mode,
    'audience_list', (p_post).audience_list
  )
$function$
CREATE OR REPLACE FUNCTION public.fn_legacy_youtube_reel_transition_snapshot(
  p_reel public.social_reels
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $function$
  SELECT jsonb_build_object(
    'author_id', (p_reel).author_id,
    'video_url', (p_reel).video_url,
    'original_youtube_url', (p_reel).original_youtube_url,
    'source_post_id', (p_reel).source_post_id,
    'source_story_id', (p_reel).source_story_id,
    'origin_type', (p_reel).origin_type,
    'source_type', (p_reel).source_type,
    'playback_type', (p_reel).playback_type,
    'topic', (p_reel).topic,
    'rights_status', (p_reel).rights_status,
    'source_asset_id', (p_reel).source_asset_id,
    'youtube_video_id', (p_reel).youtube_video_id,
    'canonical_asset_key', (p_reel).canonical_asset_key,
    'publication_key', (p_reel).publication_key,
    'is_deleted', COALESCE((p_reel).is_deleted, false),
    'is_public', (p_reel).is_public,
    'media_status', (p_reel).media_status,
    'native_processing_requested', (p_reel).native_processing_requested
  )
$function$
-- Finish only the first capture after all deterministic lineage repairs. The
-- immutable JSON snapshots make the exception row-scoped rather than video-ID
-- scoped: changing identity, privacy, topic, rights, or lineage loses it.
INSERT INTO public.video_reels_legacy_transition_rows (
  surface,
  row_id,
  youtube_video_id,
  row_snapshot,
  captured_at,
  expires_at
)
SELECT
  'social_posts',
  p.id,
  p.youtube_video_id,
  public.fn_legacy_youtube_post_transition_snapshot(p),
  state.captured_at,
  state.expires_at
FROM public.social_posts p
JOIN public.video_reels_legacy_transition_state state
  ON state.transition_key = 'phase1-public-youtube'
WHERE current_setting('app.capture_legacy_youtube_transition', true) = '1'
  AND p.legacy_transition_expires_at = state.expires_at
ON CONFLICT (surface, row_id) DO NOTHING
INSERT INTO public.video_reels_legacy_transition_rows (
  surface,
  row_id,
  youtube_video_id,
  row_snapshot,
  captured_at,
  expires_at
)
SELECT
  'social_reels',
  r.id,
  r.youtube_video_id,
  public.fn_legacy_youtube_reel_transition_snapshot(r),
  state.captured_at,
  state.expires_at
FROM public.social_reels r
JOIN public.video_reels_legacy_transition_state state
  ON state.transition_key = 'phase1-public-youtube'
WHERE current_setting('app.capture_legacy_youtube_transition', true) = '1'
  AND r.legacy_transition_expires_at = state.expires_at
ON CONFLICT (surface, row_id) DO NOTHING
CREATE OR REPLACE FUNCTION public.legacy_transition_eligible(
  p_post public.social_posts
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
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
CREATE OR REPLACE FUNCTION public.legacy_transition_eligible(
  p_reel public.social_reels
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
  SELECT COALESCE((p_reel).is_deleted, false) = false
    AND (p_reel).is_public = true
    AND (p_reel).playback_type = 'youtube_embed'
    AND (p_reel).rights_status IN ('embed_only', 'owned', 'licensed')
    AND (p_reel).youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    AND (p_reel).youtube_video_id NOT LIKE 'FAKE%'
    AND (p_reel).canonical_asset_key =
      'youtube:' || (p_reel).youtube_video_id
    AND public.fn_extract_youtube_video_id((p_reel).video_url) =
      (p_reel).youtube_video_id
    AND EXISTS (
      SELECT 1
      FROM public.video_reels_legacy_transition_rows transition_row
      JOIN public.video_reels_legacy_transition_state transition_state
        ON transition_state.transition_key = 'phase1-public-youtube'
       AND transition_state.captured_at = transition_row.captured_at
       AND transition_state.expires_at = transition_row.expires_at
      WHERE transition_row.surface = 'social_reels'
        AND transition_row.row_id = (p_reel).id
        AND transition_row.youtube_video_id = (p_reel).youtube_video_id
        AND transition_row.row_snapshot =
          public.fn_legacy_youtube_reel_transition_snapshot(p_reel)
        AND transition_row.expires_at =
          (p_reel).legacy_transition_expires_at
        AND transition_row.captured_at <= now() + interval '5 minutes'
        AND transition_row.expires_at =
          transition_row.captured_at + interval '7 days'
        AND transition_row.expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.youtube_embed_failures failure
      WHERE failure.video_id = (p_reel).youtube_video_id
        AND failure.verification_status = 'confirmed'
        AND failure.resolved = false
    )
$function$
CREATE OR REPLACE FUNCTION public.fn_guard_legacy_transition_marker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
DROP TRIGGER IF EXISTS trg_social_posts_legacy_transition_marker_guard
  ON public.social_posts
CREATE TRIGGER trg_social_posts_legacy_transition_marker_guard
  BEFORE INSERT OR UPDATE OF legacy_transition_expires_at
  ON public.social_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_legacy_transition_marker()
DROP TRIGGER IF EXISTS trg_social_reels_legacy_transition_marker_guard
  ON public.social_reels
CREATE TRIGGER trg_social_reels_legacy_transition_marker_guard
  BEFORE INSERT OR UPDATE OF legacy_transition_expires_at
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_legacy_transition_marker()
-- Promote defaults only after every historical row has been classified.
ALTER TABLE public.social_posts
  ALTER COLUMN origin_type SET DEFAULT 'user_upload',
  ALTER COLUMN origin_type SET NOT NULL,
  ALTER COLUMN playback_type SET DEFAULT 'external_embed',
  ALTER COLUMN playback_type SET NOT NULL,
  ALTER COLUMN topic SET DEFAULT 'unknown',
  ALTER COLUMN topic SET NOT NULL,
  ALTER COLUMN rights_status SET DEFAULT 'unknown',
  ALTER COLUMN rights_status SET NOT NULL
ALTER TABLE public.social_reels
  ALTER COLUMN origin_type SET DEFAULT 'user_upload',
  ALTER COLUMN origin_type SET NOT NULL,
  ALTER COLUMN playback_type SET DEFAULT 'external_embed',
  ALTER COLUMN playback_type SET NOT NULL,
  ALTER COLUMN topic SET DEFAULT 'unknown',
  ALTER COLUMN topic SET NOT NULL,
  ALTER COLUMN rights_status SET DEFAULT 'unknown',
  ALTER COLUMN rights_status SET NOT NULL
UPDATE public.video_transcode_jobs j
SET origin_type = COALESCE(j.origin_type, r.origin_type),
    rights_status = COALESCE(j.rights_status, r.rights_status),
    source_asset_id = COALESCE(j.source_asset_id, r.source_asset_id),
    canonical_asset_key = COALESCE(j.canonical_asset_key, r.canonical_asset_key)
FROM public.social_reels r
WHERE r.id = j.reel_id
  AND (
    j.origin_type IS NULL
    OR j.rights_status IS NULL
    OR j.source_asset_id IS NULL
    OR j.canonical_asset_key IS NULL
  )
UPDATE public.video_transcode_jobs
SET origin_type = COALESCE(origin_type, 'legacy'),
    rights_status = COALESCE(rights_status, 'unknown')
WHERE origin_type IS NULL OR rights_status IS NULL
ALTER TABLE public.video_transcode_jobs
  ALTER COLUMN origin_type SET DEFAULT 'legacy',
  ALTER COLUMN origin_type SET NOT NULL,
  ALTER COLUMN rights_status SET DEFAULT 'unknown',
  ALTER COLUMN rights_status SET NOT NULL
-- ---------------------------------------------------------------------------
-- 4. Constraints and managed-publication uniqueness
-- ---------------------------------------------------------------------------

ALTER TABLE public.video_library_videos
  DROP CONSTRAINT IF EXISTS video_library_videos_availability_status_check,
  DROP CONSTRAINT IF EXISTS video_library_videos_verified_availability_check
ALTER TABLE public.video_library_videos
  ADD CONSTRAINT video_library_videos_availability_status_check
    CHECK (availability_status IN (
      'unknown', 'verified', 'unavailable', 'private', 'restricted',
      'embed_disabled', 'error'
    )),
  ADD CONSTRAINT video_library_videos_verified_availability_check
    CHECK (
      (
        availability_status = 'verified'
        AND embeddable IS TRUE
        AND availability_checked_at IS NOT NULL
      )
      OR (
        availability_status <> 'verified'
        AND embeddable IS DISTINCT FROM true
      )
    )
ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_origin_type_check,
  DROP CONSTRAINT IF EXISTS social_posts_playback_type_check,
  DROP CONSTRAINT IF EXISTS social_posts_topic_check,
  DROP CONSTRAINT IF EXISTS social_posts_rights_status_check,
  DROP CONSTRAINT IF EXISTS social_posts_embed_rights_check,
  DROP CONSTRAINT IF EXISTS social_posts_managed_library_integrity_check
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_origin_type_check
    CHECK (origin_type IN (
      'user_upload', 'story', 'social_post', 'video_library', 'horse',
      'pokernews', 'generated', 'legacy'
    )),
  ADD CONSTRAINT social_posts_playback_type_check
    CHECK (playback_type IN ('native', 'youtube_embed', 'external_embed')),
  ADD CONSTRAINT social_posts_topic_check
    CHECK (topic IN ('unknown', 'poker', 'cash', 'tournament', 'slots', 'sports', 'other')),
  ADD CONSTRAINT social_posts_rights_status_check
    CHECK (rights_status IN (
      'unknown', 'embed_only', 'owned', 'licensed', 'user_authorized',
      'restricted'
    )),
  ADD CONSTRAINT social_posts_embed_rights_check
    CHECK (
      rights_status <> 'embed_only'
      OR playback_type = 'youtube_embed'
    ),
  ADD CONSTRAINT social_posts_managed_library_integrity_check
    CHECK (
      (
        origin_type <> 'video_library'
        AND source_asset_id IS NULL
        AND publication_key IS NULL
      )
      OR (
        origin_type = 'video_library'
        AND source_asset_id IS NOT NULL
        AND youtube_video_id IS NOT NULL
        AND canonical_asset_key IS NOT NULL
        AND publication_key IS NOT NULL
      )
    )
ALTER TABLE public.social_reels
  DROP CONSTRAINT IF EXISTS social_reels_origin_type_check,
  DROP CONSTRAINT IF EXISTS social_reels_playback_type_check,
  DROP CONSTRAINT IF EXISTS social_reels_topic_check,
  DROP CONSTRAINT IF EXISTS social_reels_rights_status_check,
  DROP CONSTRAINT IF EXISTS social_reels_embed_rights_check,
  DROP CONSTRAINT IF EXISTS social_reels_native_processing_rights_check,
  DROP CONSTRAINT IF EXISTS social_reels_managed_library_integrity_check
ALTER TABLE public.social_reels
  ADD CONSTRAINT social_reels_origin_type_check
    CHECK (origin_type IN (
      'user_upload', 'story', 'social_post', 'video_library', 'horse',
      'pokernews', 'generated', 'legacy'
    )),
  ADD CONSTRAINT social_reels_playback_type_check
    CHECK (playback_type IN ('native', 'youtube_embed', 'external_embed')),
  ADD CONSTRAINT social_reels_topic_check
    CHECK (topic IN ('unknown', 'poker', 'cash', 'tournament', 'slots', 'sports', 'other')),
  ADD CONSTRAINT social_reels_rights_status_check
    CHECK (rights_status IN (
      'unknown', 'embed_only', 'owned', 'licensed', 'user_authorized',
      'restricted'
    )),
  ADD CONSTRAINT social_reels_embed_rights_check
    CHECK (
      rights_status <> 'embed_only'
      OR playback_type = 'youtube_embed'
    ),
  ADD CONSTRAINT social_reels_native_processing_rights_check
    CHECK (
      NOT native_processing_requested
      OR rights_status IN ('owned', 'licensed')
    ),
  ADD CONSTRAINT social_reels_managed_library_integrity_check
    CHECK (
      (
        origin_type <> 'video_library'
        AND source_asset_id IS NULL
        AND publication_key IS NULL
      )
      OR (
        origin_type = 'video_library'
        AND source_asset_id IS NOT NULL
        AND youtube_video_id IS NOT NULL
        AND canonical_asset_key IS NOT NULL
        AND publication_key IS NOT NULL
      )
    )
ALTER TABLE public.video_transcode_jobs
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_origin_type_check,
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_rights_status_check,
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_native_rights_check,
  DROP CONSTRAINT IF EXISTS video_transcode_jobs_claim_lease_check
ALTER TABLE public.video_transcode_jobs
  ADD CONSTRAINT video_transcode_jobs_origin_type_check
    CHECK (origin_type IN (
      'user_upload', 'story', 'social_post', 'video_library', 'horse',
      'pokernews', 'generated', 'legacy'
    )),
  ADD CONSTRAINT video_transcode_jobs_rights_status_check
    CHECK (rights_status IN (
      'unknown', 'embed_only', 'owned', 'licensed', 'user_authorized',
      'restricted'
    )),
  ADD CONSTRAINT video_transcode_jobs_native_rights_check
    CHECK (
      source_type <> 'youtube'
      OR status NOT IN ('queued', 'processing', 'running')
      OR rights_status IN ('owned', 'licensed')
    ) NOT VALID,
  ADD CONSTRAINT video_transcode_jobs_claim_lease_check
    CHECK (
      source_type <> 'youtube'
      OR status <> 'processing'
      OR (
        claim_token IS NOT NULL
        AND worker_id IS NOT NULL
        AND btrim(worker_id) <> ''
        AND locked_at IS NOT NULL
        AND heartbeat_at IS NOT NULL
      )
    ) NOT VALID
ALTER TABLE public.social_posts
  VALIDATE CONSTRAINT social_posts_source_asset_id_fkey
ALTER TABLE public.social_reels
  VALIDATE CONSTRAINT social_reels_source_asset_id_fkey
ALTER TABLE public.video_transcode_jobs
  VALIDATE CONSTRAINT video_transcode_jobs_source_asset_id_fkey
-- Keep raw job claims and output locations off every browser role even if a
-- future policy is accidentally broadened. RLS remains a second independent
-- boundary; the worker and server APIs use the service role.
ALTER TABLE public.video_transcode_jobs ENABLE ROW LEVEL SECURITY
DO $video_transcode_job_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT p.policyname
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'video_transcode_jobs'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.video_transcode_jobs',
      v_policy.policyname
    );
  END LOOP;
END
$video_transcode_job_policies$
CREATE POLICY video_transcode_jobs_service_only
  ON public.video_transcode_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true)
REVOKE ALL ON TABLE public.video_transcode_jobs
  FROM PUBLIC, anon, authenticated
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.video_transcode_jobs TO service_role
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_posts_video_library_asset
  ON public.social_posts (source_asset_id)
  WHERE origin_type = 'video_library' AND source_asset_id IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_posts_video_library_canonical
  ON public.social_posts (canonical_asset_key)
  WHERE origin_type = 'video_library' AND canonical_asset_key IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_posts_video_library_publication
  ON public.social_posts (publication_key)
  WHERE origin_type = 'video_library' AND publication_key IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_reels_video_library_asset
  ON public.social_reels (source_asset_id)
  WHERE origin_type = 'video_library' AND source_asset_id IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_reels_video_library_canonical
  ON public.social_reels (canonical_asset_key)
  WHERE origin_type = 'video_library' AND canonical_asset_key IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_reels_video_library_publication
  ON public.social_reels (publication_key)
  WHERE origin_type = 'video_library' AND publication_key IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_reels_video_library_post
  ON public.social_reels (source_post_id)
  WHERE origin_type = 'video_library' AND source_post_id IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_video_library_availability_due
  ON public.video_library_videos (availability_status, availability_checked_at)
CREATE INDEX IF NOT EXISTS idx_social_reels_canonical_asset_key
  ON public.social_reels (canonical_asset_key)
  WHERE canonical_asset_key IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_social_posts_canonical_asset_key
  ON public.social_posts (canonical_asset_key)
  WHERE canonical_asset_key IS NOT NULL
-- ---------------------------------------------------------------------------
-- 5. Service-only controls (fail closed when a key is absent)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.video_reels_pipeline_controls (
  control_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
)
-- The service publisher identity is configuration, not a host secret. Keep it
-- in the database so every scheduler instance resolves the same audited author
-- and a missing host variable can never cause attribution drift.
CREATE TABLE IF NOT EXISTS public.video_reels_pipeline_config (
  singleton_key text PRIMARY KEY DEFAULT 'video_library'
    CHECK (singleton_key = 'video_library'),
  video_library_publisher_profile_id uuid
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
)
CREATE OR REPLACE FUNCTION public.fn_video_reels_pipeline_controls_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_video_reels_pipeline_controls_touch
  ON public.video_reels_pipeline_controls
CREATE TRIGGER trg_video_reels_pipeline_controls_touch
  BEFORE UPDATE ON public.video_reels_pipeline_controls
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_video_reels_pipeline_controls_touch()
DROP TRIGGER IF EXISTS trg_video_reels_pipeline_config_touch
  ON public.video_reels_pipeline_config
CREATE TRIGGER trg_video_reels_pipeline_config_touch
  BEFORE UPDATE ON public.video_reels_pipeline_config
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_video_reels_pipeline_controls_touch()
ALTER TABLE public.video_reels_pipeline_controls ENABLE ROW LEVEL SECURITY
ALTER TABLE public.video_reels_pipeline_config ENABLE ROW LEVEL SECURITY
DROP POLICY IF EXISTS video_reels_pipeline_controls_service_only
  ON public.video_reels_pipeline_controls
CREATE POLICY video_reels_pipeline_controls_service_only
  ON public.video_reels_pipeline_controls
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true)
DROP POLICY IF EXISTS video_reels_pipeline_config_service_only
  ON public.video_reels_pipeline_config
CREATE POLICY video_reels_pipeline_config_service_only
  ON public.video_reels_pipeline_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true)
REVOKE ALL ON TABLE public.video_reels_pipeline_controls
  FROM PUBLIC, anon, authenticated
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.video_reels_pipeline_controls TO service_role
REVOKE ALL ON TABLE public.video_reels_pipeline_config
  FROM PUBLIC, anon, authenticated
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.video_reels_pipeline_config TO service_role
INSERT INTO public.video_reels_pipeline_config (singleton_key)
VALUES ('video_library')
ON CONFLICT (singleton_key) DO NOTHING
-- Production already has one established library publisher. Preserve that
-- identity only when the historical lineage is unambiguous; zero or multiple
-- candidates intentionally leave the system fail-closed for explicit service
-- configuration rather than guessing a profile.
WITH historical_publishers AS (
  SELECT p.author_id
  FROM public.social_posts p
  WHERE p.origin_type = 'video_library'
    AND p.author_id IS NOT NULL
  UNION
  SELECT r.author_id
  FROM public.social_reels r
  WHERE r.origin_type = 'video_library'
    AND r.author_id IS NOT NULL
), unambiguous_publisher AS (
  SELECT min(author_id::text)::uuid AS author_id
  FROM historical_publishers
  HAVING count(DISTINCT author_id) = 1
)
UPDATE public.video_reels_pipeline_config config
SET video_library_publisher_profile_id = candidate.author_id,
    updated_at = now()
FROM unambiguous_publisher candidate
WHERE config.singleton_key = 'video_library'
  AND config.video_library_publisher_profile_id IS NULL
INSERT INTO public.video_reels_pipeline_controls (control_key, enabled, reason)
VALUES
  ('video_library_discovery', true,
   'Daily source discovery is enabled'),
  ('video_library_enrichment', true,
   'Post-discovery tagging and metadata enrichment are enabled'),
  ('video_library_reel_creation', true,
   'Creation of canonical library Reel records is enabled'),
  ('video_library_reel_publication', true,
   'Phase 1 verified embed-only publication is enabled'),
  ('youtube_native_transcode', false,
   'Fail closed until an operator enables explicitly rights-cleared native processing')
ON CONFLICT (control_key) DO NOTHING
-- A browser report is evidence to verify, not authority to remove a video.
-- Only the service-backed API may record reports, and only the trusted verifier
-- may turn a pending report into an active feed exclusion.
CREATE OR REPLACE FUNCTION public.record_youtube_embed_failure_report(
  p_video_id text,
  p_error_code integer DEFAULT 150,
  p_surface text DEFAULT 'Unknown'
)
RETURNS TABLE (
  video_id text,
  hit_count integer,
  verification_status text,
  resolved boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_video_id text := public.fn_extract_youtube_video_id(p_video_id);
  v_error_code integer;
  v_surface text;
BEGIN
  IF COALESCE(auth.role()::text, '') <> 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'record_youtube_embed_failure_report requires the service role';
  END IF;

  IF v_video_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'a valid YouTube video id is required';
  END IF;

  v_error_code := CASE
    WHEN p_error_code IN (2, 5, 100, 101, 150) THEN p_error_code
    ELSE 150
  END;
  v_surface := left(
    regexp_replace(
      COALESCE(NULLIF(btrim(p_surface), ''), 'Unknown'),
      '[[:cntrl:]]',
      '',
      'g'
    ),
    80
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('youtube-embed-failure:' || v_video_id, 0)
  );

  RETURN QUERY
  INSERT INTO public.youtube_embed_failures AS existing (
    video_id,
    error_code,
    surface,
    hit_count,
    first_seen_at,
    last_seen_at,
    resolved,
    verification_status,
    last_verified_at
  ) VALUES (
    v_video_id,
    v_error_code,
    v_surface,
    1,
    now(),
    now(),
    true,
    'pending',
    NULL
  )
  ON CONFLICT ON CONSTRAINT youtube_embed_failures_video_id_key DO UPDATE
  SET error_code = EXCLUDED.error_code,
      surface = EXCLUDED.surface,
      hit_count = GREATEST(COALESCE(existing.hit_count, 0), 0) + 1,
      last_seen_at = now(),
      resolved = CASE
        WHEN existing.verification_status = 'confirmed'
         AND existing.resolved = false THEN false
        ELSE true
      END,
      verification_status = CASE
        WHEN existing.verification_status = 'confirmed'
         AND existing.resolved = false THEN 'confirmed'
        ELSE 'pending'
      END,
      last_verified_at = CASE
        WHEN existing.verification_status = 'confirmed'
         AND existing.resolved = false THEN existing.last_verified_at
        ELSE NULL
      END
  RETURNING
    existing.video_id,
    existing.hit_count,
    existing.verification_status,
    existing.resolved;
END
$function$
DROP FUNCTION IF EXISTS public.record_youtube_embed_failure_verdict(
  text, text, integer, text
)
CREATE OR REPLACE FUNCTION public.record_youtube_embed_failure_verdict(
  p_video_id text,
  p_verdict text,
  p_error_code integer DEFAULT NULL,
  p_surface text DEFAULT 'verification_worker',
  p_verification_started_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  video_id text,
  hit_count integer,
  verification_status text,
  resolved boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_video_id text := public.fn_extract_youtube_video_id(p_video_id);
  v_verdict text := replace(lower(btrim(COALESCE(p_verdict, ''))), '-', '_');
  v_verification_status text;
  v_resolved boolean;
  v_error_code integer;
  v_surface text;
  v_existing public.youtube_embed_failures%ROWTYPE;
BEGIN
  IF COALESCE(auth.role()::text, '') <> 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'record_youtube_embed_failure_verdict requires the service role';
  END IF;

  IF v_video_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'a valid YouTube video id is required';
  END IF;

  IF v_verdict = 'verified' THEN
    v_verification_status := 'resolved';
    v_resolved := true;
  ELSIF v_verdict IN ('unavailable', 'private', 'restricted', 'embed_disabled') THEN
    v_verification_status := 'confirmed';
    v_resolved := false;
  ELSIF v_verdict IN ('error', 'network_error') THEN
    v_verification_status := 'error';
    v_resolved := true;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'verdict must be verified, unavailable, private, restricted, embed_disabled, error, or network_error';
  END IF;

  v_error_code := CASE
    WHEN p_error_code IN (2, 5, 100, 101, 150) THEN p_error_code
    WHEN v_verdict IN ('unavailable', 'private') THEN 100
    WHEN v_verdict IN ('restricted', 'embed_disabled') THEN 150
    ELSE 150
  END;
  v_surface := left(
    regexp_replace(
      COALESCE(NULLIF(btrim(p_surface), ''), 'verification_worker'),
      '[[:cntrl:]]',
      '',
      'g'
    ),
    80
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('youtube-embed-failure:' || v_video_id, 0)
  );

  SELECT f.*
  INTO v_existing
  FROM public.youtube_embed_failures f
  WHERE f.video_id = v_video_id
  FOR UPDATE;

  -- A report arriving after verification began belongs to the next verifier
  -- pass. Do not erase that newer evidence with an older in-flight verdict.
  IF FOUND
     AND p_verification_started_at IS NOT NULL
     AND v_existing.last_seen_at > p_verification_started_at
  THEN
    RETURN QUERY SELECT
      v_existing.video_id,
      v_existing.hit_count,
      v_existing.verification_status,
      v_existing.resolved;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.youtube_embed_failures AS existing (
    video_id,
    error_code,
    surface,
    hit_count,
    first_seen_at,
    last_seen_at,
    resolved,
    verification_status,
    last_verified_at
  ) VALUES (
    v_video_id,
    v_error_code,
    v_surface,
    0,
    now(),
    now(),
    v_resolved,
    v_verification_status,
    now()
  )
  ON CONFLICT ON CONSTRAINT youtube_embed_failures_video_id_key DO UPDATE
  SET error_code = EXCLUDED.error_code,
      surface = EXCLUDED.surface,
      resolved = CASE
        WHEN v_verification_status = 'error'
         AND existing.verification_status = 'confirmed'
         AND existing.resolved = false THEN false
        ELSE v_resolved
      END,
      verification_status = CASE
        WHEN v_verification_status = 'error'
         AND existing.verification_status = 'confirmed'
         AND existing.resolved = false THEN 'confirmed'
        ELSE v_verification_status
      END,
      last_verified_at = CASE
        WHEN v_verification_status = 'error'
         AND existing.verification_status = 'confirmed'
         AND existing.resolved = false THEN existing.last_verified_at
        ELSE now()
      END
  RETURNING
    existing.video_id,
    existing.hit_count,
    existing.verification_status,
    existing.resolved;

  SELECT f.*
  INTO v_existing
  FROM public.youtube_embed_failures f
  WHERE f.video_id = v_video_id;

  -- A confirmed trusted verdict revokes the proof used by every live native
  -- job for this source. Do this in the same transaction as the verdict so a
  -- worker can never observe the confirmed block while still claiming or
  -- completing work authorized by the older positive result. The job guard
  -- takes the same advisory lock, which closes the enqueue-versus-verdict race:
  -- whichever transaction wins is followed by either rejection or cancellation.
  IF v_existing.verification_status = 'confirmed'
     AND v_existing.resolved = false
  THEN
    UPDATE public.video_transcode_jobs j
    SET status = 'cancelled',
        completed_at = now(),
        error_message = 'youtube_verification_authorization_revoked',
        worker_id = NULL,
        claim_token = NULL,
        locked_at = NULL,
        heartbeat_at = now()
    WHERE j.source_type = 'youtube'
      AND j.status IN ('queued', 'processing', 'running')
      AND j.canonical_asset_key = 'youtube:' || v_video_id;

    UPDATE public.social_reels r
    SET video_url = r.original_youtube_url,
        playback_type = 'youtube_embed',
        media_status = 'ready',
        native_processing_requested = false,
        source_type = CASE
          WHEN r.origin_type = 'video_library' THEN 'video_library'
          ELSE 'youtube'
        END
    WHERE r.youtube_video_id = v_video_id
      AND r.original_youtube_url IS NOT NULL
      AND (
        r.native_processing_requested
        OR r.media_status IN ('queued', 'processing')
      );
  END IF;

  -- Keep the catalog verdict and failure verdict in this same transaction. A
  -- transient verifier error never overrides a previously confirmed block.
  IF NOT (
    v_verification_status = 'error'
    AND v_existing.verification_status = 'confirmed'
    AND v_existing.resolved = false
  ) THEN
    UPDATE public.video_library_videos v
    SET availability_status = CASE v_verdict
          WHEN 'verified' THEN 'verified'
          WHEN 'unavailable' THEN 'unavailable'
          WHEN 'private' THEN 'private'
          WHEN 'restricted' THEN 'restricted'
          WHEN 'embed_disabled' THEN 'embed_disabled'
          ELSE 'error'
        END,
        embeddable = (v_verdict = 'verified'),
        availability_checked_at = now(),
        availability_failure_reason = CASE
          WHEN v_verdict = 'verified' THEN NULL
          ELSE left(v_verdict || ':' || v_surface, 255)
        END,
        availability_source = 'youtube_embed_verifier'
    WHERE v.youtube_video_id = v_video_id;
  END IF;
END
$function$
-- Keep the legacy endpoint callable while making its behavior abuse-safe. It
-- now records pending evidence through the same atomic path and cannot be
-- executed by browser roles.
CREATE OR REPLACE FUNCTION public.increment_yt_failure_hits(p_video_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
BEGIN
  PERFORM 1
  FROM public.record_youtube_embed_failure_report(
    p_video_id,
    150,
    'legacy_increment_rpc'
  );
END
$function$
ALTER TABLE public.youtube_embed_failures ENABLE ROW LEVEL SECURITY
DO $youtube_failure_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT p.policyname
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'youtube_embed_failures'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.youtube_embed_failures',
      v_policy.policyname
    );
  END LOOP;
END
$youtube_failure_policies$
CREATE POLICY youtube_embed_failures_service_only
  ON public.youtube_embed_failures
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true)
REVOKE ALL ON TABLE public.youtube_embed_failures
  FROM PUBLIC, anon, authenticated
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.youtube_embed_failures TO service_role
REVOKE ALL ON FUNCTION public.record_youtube_embed_failure_report(text, integer, text)
  FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.record_youtube_embed_failure_report(text, integer, text)
  TO service_role
REVOKE ALL ON FUNCTION public.record_youtube_embed_failure_verdict(text, text, integer, text, timestamptz)
  FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.record_youtube_embed_failure_verdict(text, text, integer, text, timestamptz)
  TO service_role
REVOKE ALL ON FUNCTION public.increment_yt_failure_hits(text)
  FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.increment_yt_failure_hits(text)
  TO service_role
-- Inventory every currently public canonical YouTube surface, including each
-- exact row in the bounded legacy transition, into the trusted verifier queue.
-- A syntactically valid ID is not evidence that a video is public, embeddable,
-- or free of subscription/login requirements. Existing trusted verdicts are
-- retained byte-for-byte; previously unseen IDs begin pending. DO NOTHING also
-- makes reapply leave hit counts, timestamps, and resolved verdicts untouched.
WITH public_youtube_ids AS (
  SELECT DISTINCT public.fn_extract_youtube_video_id(NULLIF(p.media_urls ->> 0, '')) AS video_id
  FROM public.social_posts p
  WHERE p.content_type = 'video'
    AND COALESCE(p.is_deleted, false) = false
    AND p.visibility = 'public'
  UNION
  SELECT DISTINCT COALESCE(
    public.fn_extract_youtube_video_id(r.video_url),
    public.fn_extract_youtube_video_id(r.original_youtube_url),
    CASE WHEN r.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$' THEN r.youtube_video_id END
  ) AS video_id
  FROM public.social_reels r
  WHERE COALESCE(r.is_deleted, false) = false
    AND r.is_public = true
  UNION
  SELECT DISTINCT transition_row.youtube_video_id AS video_id
  FROM public.video_reels_legacy_transition_rows transition_row
)
INSERT INTO public.youtube_embed_failures (
  video_id,
  error_code,
  surface,
  hit_count,
  first_seen_at,
  last_seen_at,
  resolved,
  verification_status,
  last_verified_at
)
SELECT
  inventory.video_id,
  150,
  'phase1_public_youtube_inventory',
  0,
  now(),
  now(),
  true,
  'pending',
  NULL
FROM public_youtube_ids inventory
WHERE inventory.video_id IS NOT NULL
ON CONFLICT ON CONSTRAINT youtube_embed_failures_video_id_key DO NOTHING
CREATE OR REPLACE FUNCTION public.fn_queue_youtube_verification(
  p_video_id text,
  p_surface text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_video_id text := public.fn_extract_youtube_video_id(p_video_id);
  v_surface text := left(
    regexp_replace(
      COALESCE(NULLIF(btrim(p_surface), ''), 'youtube_publication'),
      '[[:cntrl:]]',
      '',
      'g'
    ),
    80
  );
BEGIN
  IF v_video_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.youtube_embed_failures AS existing (
    video_id,
    error_code,
    surface,
    hit_count,
    first_seen_at,
    last_seen_at,
    resolved,
    verification_status,
    last_verified_at
  ) VALUES (
    v_video_id,
    150,
    v_surface,
    0,
    now(),
    now(),
    true,
    'pending',
    NULL
  )
  ON CONFLICT ON CONSTRAINT youtube_embed_failures_video_id_key DO UPDATE
  SET surface = EXCLUDED.surface,
      last_seen_at = now(),
      resolved = true,
      verification_status = 'pending',
      last_verified_at = NULL
  WHERE NOT (
      existing.verification_status = 'confirmed'
      AND existing.resolved = false
    )
    AND NOT (
      existing.verification_status = 'resolved'
      AND existing.resolved = true
      AND existing.last_verified_at >= now() - interval '6 days'
      AND existing.last_verified_at <= now() + interval '5 minutes'
    );
END
$function$
REVOKE ALL ON FUNCTION public.fn_queue_youtube_verification(text, text)
  FROM PUBLIC, anon, authenticated
-- Keep future post writes on the same contract as the historical backfill.
-- Existing collectors already emit metadata.clip_type/source but do not yet
-- know about these new columns, so deriving here prevents tomorrow's valid
-- poker clips from silently falling back to topic=unknown.
CREATE OR REPLACE FUNCTION public.fn_social_posts_video_contract_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
DROP TRIGGER IF EXISTS trg_social_posts_video_contract_defaults
  ON public.social_posts
CREATE TRIGGER trg_social_posts_video_contract_defaults
  BEFORE INSERT OR UPDATE OF
    author_id, content_type, media_urls, metadata, topics, origin_type,
    playback_type, topic, rights_status
  ON public.social_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_social_posts_video_contract_defaults()
-- Preserve the deployed seven-argument signature while routing every RPC
-- insert through the same provenance defaults as direct inserts. In
-- particular, authenticated native uploads become user-authorized video posts;
-- topic remains unknown unless an explicit classified path supplies it.
-- A historical migration left the same argument names on a text-typed
-- achievement overload. Remove it so PostgREST cannot face an ambiguous RPC
-- during a clean replay; production already carries only the jsonb form.
DROP FUNCTION IF EXISTS public.fn_create_social_post(
  uuid, text, text, text[], text, text, text
)
CREATE OR REPLACE FUNCTION public.fn_create_social_post(
  p_author_id uuid,
  p_content text DEFAULT ''::text,
  p_content_type text DEFAULT 'text'::text,
  p_media_urls text[] DEFAULT '{}'::text[],
  p_visibility text DEFAULT 'public'::text,
  p_achievement_data jsonb DEFAULT NULL::jsonb,
  p_thumbnail_url text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
REVOKE ALL ON FUNCTION public.fn_create_social_post(
  uuid, text, text, text[], text, jsonb, text
) FROM PUBLIC, anon
GRANT EXECUTE ON FUNCTION public.fn_create_social_post(
  uuid, text, text, text[], text, jsonb, text
) TO authenticated, service_role
-- Enter a contained state while the claim-token/atomic-completion worker is
-- deployed. On the first apply the native switch is inserted disabled above,
-- so every legacy in-flight job, including a previously rights-cleared one,
-- is cancelled and its Reel returns to the source embed. On repeat applies an
-- operator-enabled switch proves the new worker was deliberately activated;
-- preserve its valid live work instead of turning idempotency into revocation.
-- No Reel is deleted.
UPDATE public.video_transcode_jobs j
SET status = 'cancelled',
    completed_at = COALESCE(j.completed_at, now()),
    worker_id = NULL,
    claim_token = NULL,
    locked_at = NULL,
    heartbeat_at = now(),
    error_message = concat_ws('; ', NULLIF(j.error_message, ''),
      'cancelled_by_video_reels_rights_foundation')
WHERE j.source_type = 'youtube'
  AND j.status IN ('queued', 'processing', 'running')
  AND NOT EXISTS (
    SELECT 1
    FROM public.video_reels_pipeline_controls control
    WHERE control.control_key = 'youtube_native_transcode'
      AND control.enabled
  )
UPDATE public.social_reels r
SET video_url = r.original_youtube_url,
    playback_type = 'youtube_embed',
    media_status = 'ready',
    native_processing_requested = false,
    source_type = CASE
      WHEN r.origin_type = 'video_library' THEN 'video_library'
      ELSE 'youtube'
    END
WHERE r.media_status IN ('queued', 'processing')
  AND r.original_youtube_url IS NOT NULL
  AND r.youtube_video_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.video_reels_pipeline_controls control
    WHERE control.control_key = 'youtube_native_transcode'
      AND control.enabled
  )
ALTER TABLE public.video_transcode_jobs
  VALIDATE CONSTRAINT video_transcode_jobs_native_rights_check
ALTER TABLE public.video_transcode_jobs
  VALIDATE CONSTRAINT video_transcode_jobs_claim_lease_check
-- ---------------------------------------------------------------------------
-- 6. Rights-aware intercept and queue. Embed-only is always playable and is
--    never queued.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_social_reels_yt_intercept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_yt_id text;
  v_provenance_yt_id text;
  v_prior_yt_id text;
  v_service_role boolean := COALESCE(auth.role()::text, '') = 'service_role';
  v_native_enabled boolean := false;
  v_native_allowed boolean := false;
BEGIN
  -- Intercept only when the URL being played is a YouTube URL. A completed
  -- worker legitimately retains youtube_video_id/original_youtube_url while
  -- changing video_url to native storage; using those provenance fields as the
  -- detector would accidentally undo every successful conversion.
  v_yt_id := public.fn_extract_youtube_video_id(NEW.video_url);

  IF TG_OP = 'UPDATE' THEN
    v_prior_yt_id := COALESCE(
      public.fn_extract_youtube_video_id(OLD.video_url),
      public.fn_extract_youtube_video_id(OLD.original_youtube_url),
      CASE
        WHEN OLD.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
          THEN OLD.youtube_video_id
        ELSE NULL
      END
    );
  END IF;

  IF v_yt_id IS NULL THEN
    IF public.fn_is_platform_public_storage_url(NEW.video_url)
    THEN
      NEW.playback_type := 'native';
      NEW.source_type := 'native';
      NEW.native_processing_requested := false;
      v_provenance_yt_id := COALESCE(
        public.fn_extract_youtube_video_id(NEW.original_youtube_url),
        CASE
          WHEN NEW.youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
            THEN NEW.youtube_video_id
          ELSE NULL
        END,
        v_prior_yt_id
      );
      IF v_provenance_yt_id IS NOT NULL
         AND (
           TG_OP = 'INSERT'
           OR OLD.playback_type IS DISTINCT FROM 'native'
           OR OLD.source_type IS DISTINCT FROM 'native'
           OR OLD.video_url IS DISTINCT FROM NEW.video_url
         )
         AND (
           NOT v_service_role
           OR NEW.rights_status NOT IN ('owned', 'licensed')
           OR NOT EXISTS (
             SELECT 1
             FROM public.video_transcode_jobs completion_job
             WHERE completion_job.id = current_setting(
                     'app.youtube_native_completion_job_id', true
                   )
               AND completion_job.status = 'completed'
               AND completion_job.reel_id = NEW.id
               AND completion_job.user_id IS NOT DISTINCT FROM NEW.author_id
               AND completion_job.rights_status IS NOT DISTINCT FROM NEW.rights_status
               AND completion_job.canonical_asset_key = 'youtube:' || v_provenance_yt_id
               AND completion_job.output_url IS NOT DISTINCT FROM
                 split_part(split_part(NEW.video_url, '?', 1), '#', 1)
           )
         )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'YouTube-derived native Reels may only be published by complete_rights_cleared_youtube_transcode';
      END IF;
      IF v_service_role
         AND NEW.rights_status IN ('owned', 'licensed')
         AND v_provenance_yt_id IS NOT NULL
      THEN
        NEW.youtube_video_id := v_provenance_yt_id;
        NEW.canonical_asset_key := 'youtube:' || v_provenance_yt_id;
      ELSE
        NEW.youtube_video_id := NULL;
        NEW.canonical_asset_key := 'native:' || md5(NEW.video_url);
      END IF;
      IF NOT v_service_role
         AND auth.uid() = NEW.author_id
         AND public.fn_is_user_video_storage_url(NEW.video_url, NEW.author_id)
      THEN
        NEW.rights_status := 'user_authorized';
      ELSIF v_service_role
         AND NEW.rights_status = 'user_authorized'
         AND public.fn_is_user_video_storage_url(NEW.video_url, NEW.author_id)
      THEN
        NEW.rights_status := 'user_authorized';
      ELSIF NEW.rights_status = 'user_authorized'
         OR (NOT v_service_role AND NEW.rights_status IN ('owned', 'licensed'))
      THEN
        NEW.rights_status := 'unknown';
      END IF;
    ELSIF NEW.playback_type = 'native' THEN
      NEW.source_type := 'user';
      NEW.native_processing_requested := false;
      NEW.youtube_video_id := NULL;
      NEW.canonical_asset_key := 'external:' || md5(NEW.video_url);
      NEW.playback_type := 'external_embed';
      NEW.rights_status := 'unknown';
    ELSIF NEW.playback_type = 'youtube_embed'
       OR NEW.youtube_video_id IS NOT NULL
    THEN
      -- A caller cannot pair a synthetic YouTube identity with an arbitrary
      -- external playable URL. A valid original is canonicalized; otherwise
      -- the row is demoted out of the public Reels playback contract.
      v_provenance_yt_id := public.fn_extract_youtube_video_id(
        NEW.original_youtube_url
      );
      IF v_provenance_yt_id IS NOT NULL THEN
        NEW.video_url := NEW.original_youtube_url;
        NEW.youtube_video_id := v_provenance_yt_id;
        NEW.canonical_asset_key := 'youtube:' || v_provenance_yt_id;
        NEW.playback_type := 'youtube_embed';
        NEW.source_type := 'youtube';
        NEW.native_processing_requested := false;
        IF NOT v_service_role OR NEW.rights_status NOT IN ('owned', 'licensed') THEN
          NEW.rights_status := 'embed_only';
        END IF;
      ELSE
        NEW.youtube_video_id := NULL;
        NEW.canonical_asset_key := 'external:' || md5(NEW.video_url);
        NEW.playback_type := 'external_embed';
        NEW.native_processing_requested := false;
        NEW.rights_status := 'unknown';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM public.fn_queue_youtube_verification(
    v_yt_id,
    'social_reel_write'
  );

  SELECT c.enabled
  INTO v_native_enabled
  FROM public.video_reels_pipeline_controls c
  WHERE c.control_key = 'youtube_native_transcode';

  v_native_allowed :=
    v_service_role
    AND COALESCE(v_native_enabled, false)
    AND NEW.native_processing_requested
    AND NEW.rights_status IN ('owned', 'licensed')
    -- Phase 1 library publications are canonical embeds. Rights-cleared native
    -- library masters are introduced by the Phase 6 studio and must not be
    -- improvised from a third-party library URL in the meantime.
    AND NEW.origin_type IS DISTINCT FROM 'video_library'
    AND NEW.source_type IS DISTINCT FROM 'video_library';

  NEW.youtube_video_id := v_yt_id;
  -- The playable URL, not caller-supplied identity fields, owns canonical
  -- identity. This also repairs a Reel whose YouTube URL is intentionally
  -- replaced with a different video.
  NEW.canonical_asset_key := 'youtube:' || v_yt_id;
  NEW.original_youtube_url := NEW.video_url;

  IF NEW.origin_type = 'video_library' OR NEW.source_type = 'video_library' THEN
    NEW.source_type := 'video_library';
  ELSE
    NEW.source_type := 'youtube';
  END IF;

  IF v_native_allowed THEN
    NEW.playback_type := 'youtube_embed';
    NEW.media_status := 'queued';
  ELSE
    -- Unknown third-party YouTube rights become embed-only. A client cannot
    -- spoof the new columns to reach the queue because the service-role claim,
    -- explicit request, grant, and kill switch are all required above.
    IF NOT v_service_role OR NEW.rights_status NOT IN ('owned', 'licensed') THEN
      NEW.rights_status := 'embed_only';
    END IF;
    NEW.native_processing_requested := false;
    NEW.playback_type := 'youtube_embed';
    NEW.media_status := 'ready';
    NEW.video_url := COALESCE(NEW.original_youtube_url, NEW.video_url);
  END IF;

  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_social_reels_yt_intercept ON public.social_reels
CREATE TRIGGER trg_social_reels_yt_intercept
  BEFORE INSERT OR UPDATE OF
    video_url, original_youtube_url, youtube_video_id, media_status,
    rights_status, native_processing_requested, playback_type
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_social_reels_yt_intercept()
-- The control is a processing kill switch, not merely a publication switch.
-- Direct service-role writes and an old worker binary cannot create or claim a
-- YouTube job while native processing is disabled.
CREATE OR REPLACE FUNCTION public.fn_guard_youtube_native_transcode_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_control_enabled boolean := false;
  v_reel public.social_reels%ROWTYPE;
  v_youtube_id text;
BEGIN
  IF NEW.source_type = 'youtube'
     AND NEW.status IN ('queued', 'processing', 'running')
  THEN
    -- Hold a shared row lock until this write commits. A concurrent disable
    -- therefore either wins first (and this write fails) or acknowledges only
    -- after this already-authorized write is durable.
    SELECT control.enabled
    INTO v_control_enabled
    FROM public.video_reels_pipeline_controls control
    WHERE control.control_key = 'youtube_native_transcode'
    FOR SHARE;

    IF NOT COALESCE(v_control_enabled, false) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'YouTube native transcode processing is disabled';
    END IF;

    v_youtube_id := public.fn_extract_youtube_video_id(NEW.youtube_url);
    IF v_youtube_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('youtube-embed-failure:' || v_youtube_id, 0)
      );
    END IF;

    -- Serialize authorization changes with enqueue/claim writes. The Reel
    -- revocation trigger updates jobs after taking this row lock, so it either
    -- cancels this durable write or completes before this guard re-attests it.
    SELECT r.*
    INTO v_reel
    FROM public.social_reels r
    WHERE r.id = NEW.reel_id
    FOR SHARE;

    IF NOT FOUND
       OR v_youtube_id IS NULL
       OR public.fn_extract_youtube_video_id(NEW.source_url) IS DISTINCT FROM v_youtube_id
       OR NEW.rights_status NOT IN ('owned', 'licensed')
       OR NEW.user_id IS DISTINCT FROM v_reel.author_id
       OR NEW.rights_status IS DISTINCT FROM v_reel.rights_status
       OR NEW.origin_type IS DISTINCT FROM v_reel.origin_type
       OR NEW.source_asset_id IS DISTINCT FROM v_reel.source_asset_id
       OR NEW.canonical_asset_key IS DISTINCT FROM 'youtube:' || v_youtube_id
       OR v_reel.canonical_asset_key IS DISTINCT FROM NEW.canonical_asset_key
       OR v_reel.youtube_video_id IS DISTINCT FROM v_youtube_id
       OR public.fn_extract_youtube_video_id(v_reel.video_url) IS DISTINCT FROM v_youtube_id
       OR public.fn_extract_youtube_video_id(v_reel.original_youtube_url) IS DISTINCT FROM v_youtube_id
       OR v_reel.source_type IS DISTINCT FROM 'youtube'
       OR v_reel.native_processing_requested IS DISTINCT FROM true
       OR COALESCE(v_reel.is_deleted, false)
       OR v_reel.source_post_id IS NULL
       OR v_reel.origin_type = 'video_library'
       OR NOT (
         EXISTS (
           SELECT 1
           FROM public.video_library_videos verified_asset
           WHERE verified_asset.youtube_video_id = v_youtube_id
             AND verified_asset.availability_status = 'verified'
             AND verified_asset.embeddable IS TRUE
             AND verified_asset.availability_checked_at >= now() - interval '7 days'
             AND verified_asset.availability_checked_at <= now() + interval '5 minutes'
         )
         OR EXISTS (
           SELECT 1
           FROM public.youtube_embed_failures verified_source
           WHERE verified_source.video_id = v_youtube_id
             AND verified_source.verification_status = 'resolved'
             AND verified_source.resolved IS TRUE
             AND verified_source.last_verified_at >= now() - interval '7 days'
             AND verified_source.last_verified_at <= now() + interval '5 minutes'
         )
       )
       OR EXISTS (
         SELECT 1
         FROM public.youtube_embed_failures failed_source
         WHERE failed_source.video_id = v_youtube_id
           AND failed_source.verification_status = 'confirmed'
           AND failed_source.resolved = false
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'YouTube native transcode job does not match a rights-cleared Reel';
    END IF;
  END IF;
  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_guard_youtube_native_transcode_job
  ON public.video_transcode_jobs
CREATE TRIGGER trg_guard_youtube_native_transcode_job
  BEFORE INSERT OR UPDATE OF
    reel_id, user_id, source_url, youtube_url, source_type, status,
    origin_type, rights_status, source_asset_id, canonical_asset_key
  ON public.video_transcode_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_youtube_native_transcode_job()
-- Rights and lineage are mutable after a job is queued. Cancel the exact live
-- job as part of the Reel update so revoked work cannot remain claimable even
-- by a worker version that never performs its own re-attestation.
CREATE OR REPLACE FUNCTION public.fn_cancel_revoked_youtube_transcode_jobs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
BEGIN
  UPDATE public.video_transcode_jobs job
  SET status = 'cancelled',
      completed_at = now(),
      error_message = 'native_processing_authorization_revoked',
      worker_id = NULL,
      claim_token = NULL,
      locked_at = NULL,
      heartbeat_at = now()
  WHERE job.reel_id = NEW.id
    AND job.source_type = 'youtube'
    AND job.status IN ('queued', 'processing', 'running')
    AND (
      NEW.native_processing_requested IS DISTINCT FROM true
      OR NEW.rights_status NOT IN ('owned', 'licensed')
      OR COALESCE(NEW.is_deleted, false)
      OR NEW.source_type IS DISTINCT FROM 'youtube'
      OR NEW.origin_type = 'video_library'
      OR NEW.source_post_id IS NULL
      OR NEW.youtube_video_id IS NULL
      OR job.user_id IS DISTINCT FROM NEW.author_id
      OR job.rights_status IS DISTINCT FROM NEW.rights_status
      OR job.origin_type IS DISTINCT FROM NEW.origin_type
      OR job.source_asset_id IS DISTINCT FROM NEW.source_asset_id
      OR job.canonical_asset_key IS DISTINCT FROM NEW.canonical_asset_key
      OR public.fn_extract_youtube_video_id(job.youtube_url) IS DISTINCT FROM NEW.youtube_video_id
      OR public.fn_extract_youtube_video_id(job.source_url) IS DISTINCT FROM NEW.youtube_video_id
      OR public.fn_extract_youtube_video_id(NEW.video_url) IS DISTINCT FROM NEW.youtube_video_id
      OR public.fn_extract_youtube_video_id(NEW.original_youtube_url) IS DISTINCT FROM NEW.youtube_video_id
    );
  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_cancel_revoked_youtube_transcode_jobs
  ON public.social_reels
CREATE TRIGGER trg_cancel_revoked_youtube_transcode_jobs
  AFTER UPDATE OF
    author_id, rights_status, native_processing_requested, is_deleted,
    source_type, origin_type, source_asset_id, canonical_asset_key,
    youtube_video_id, video_url, original_youtube_url, source_post_id
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_cancel_revoked_youtube_transcode_jobs()
CREATE OR REPLACE FUNCTION public.fn_social_reels_yt_queue_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_native_enabled boolean := false;
BEGIN
  IF COALESCE(auth.role()::text, '') <> 'service_role' THEN
    RETURN NEW;
  END IF;

  SELECT c.enabled
  INTO v_native_enabled
  FROM public.video_reels_pipeline_controls c
  WHERE c.control_key = 'youtube_native_transcode';

  IF NOT COALESCE(v_native_enabled, false)
     OR NOT NEW.native_processing_requested
     OR NEW.rights_status NOT IN ('owned', 'licensed')
     OR NEW.media_status <> 'queued'
     OR NEW.youtube_video_id IS NULL
     OR NEW.source_post_id IS NULL
     OR NEW.origin_type = 'video_library'
     OR NEW.source_type = 'video_library'
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.youtube_embed_failures f
    WHERE f.video_id = NEW.youtube_video_id
      AND f.verification_status = 'confirmed'
      AND f.resolved = false
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'an active YouTube embed failure blocks native processing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.video_transcode_jobs j
    WHERE j.reel_id = NEW.id
      AND j.status IN ('queued', 'processing', 'running', 'completed', 'done')
  ) THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.video_transcode_jobs (
      reel_id,
      user_id,
      source_url,
      youtube_url,
      source_type,
      status,
      target_format,
      target_bitrate,
      origin_type,
      rights_status,
      source_asset_id,
      canonical_asset_key
    ) VALUES (
      NEW.id,
      NEW.author_id,
      NEW.original_youtube_url,
      NEW.original_youtube_url,
      'youtube',
      'queued',
      'h264_1080p',
      2500000,
      NEW.origin_type,
      NEW.rights_status,
      NEW.source_asset_id,
      NEW.canonical_asset_key
    );
  EXCEPTION WHEN unique_violation THEN
    -- The existing live-job indexes are the cross-transaction race guard. A
    -- canonical sibling may use a different URL spelling, so do not strand the
    -- race loser in queued state waiting for an exact-URL broadcast.
    UPDATE public.social_reels r
    SET media_status = 'ready',
        playback_type = 'youtube_embed',
        native_processing_requested = false,
        video_url = r.original_youtube_url
    WHERE r.id = NEW.id;
  END;

  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_social_reels_yt_queue_job ON public.social_reels
CREATE TRIGGER trg_social_reels_yt_queue_job
  AFTER INSERT OR UPDATE OF
    media_status, rights_status, native_processing_requested
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_social_reels_yt_queue_job()
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_transcode_jobs_canonical_live
  ON public.video_transcode_jobs (canonical_asset_key)
  WHERE source_type = 'youtube'
    AND status IN ('queued', 'processing', 'running')
    AND canonical_asset_key IS NOT NULL
-- Managed library identity is reserved to the service-role publisher. Without
-- this column guard an authenticated author could satisfy row-level ownership,
-- claim a library source_asset_id, and squat the partial unique key before the
-- real publisher ran.
CREATE OR REPLACE FUNCTION public.fn_guard_managed_video_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
DROP TRIGGER IF EXISTS trg_social_posts_managed_provenance_guard
  ON public.social_posts
CREATE TRIGGER trg_social_posts_managed_provenance_guard
  BEFORE INSERT OR UPDATE OF origin_type, source_asset_id, publication_key
  ON public.social_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_managed_video_provenance()
DROP TRIGGER IF EXISTS trg_social_reels_managed_provenance_guard
  ON public.social_reels
CREATE TRIGGER trg_social_reels_managed_provenance_guard
  BEFORE INSERT OR UPDATE OF
    origin_type, source_type, source_asset_id, publication_key
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_managed_video_provenance()
-- The FK proves only that an asset exists. This guard proves that every
-- managed row's redundant identity and playable URL all describe that exact
-- asset, preventing a fresh safe asset id from laundering a different video.
CREATE OR REPLACE FUNCTION public.fn_guard_managed_video_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
DROP TRIGGER IF EXISTS trg_social_posts_managed_lineage_guard
  ON public.social_posts
CREATE TRIGGER trg_social_posts_managed_lineage_guard
  BEFORE INSERT OR UPDATE OF
    origin_type, source_asset_id, youtube_video_id, canonical_asset_key,
    publication_key, media_urls
  ON public.social_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_managed_video_lineage()
DROP TRIGGER IF EXISTS trg_social_reels_managed_lineage_guard
  ON public.social_reels
CREATE TRIGGER trg_social_reels_managed_lineage_guard
  BEFORE INSERT OR UPDATE OF
    origin_type, source_type, source_asset_id, youtube_video_id, canonical_asset_key,
    publication_key, video_url, original_youtube_url
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_managed_video_lineage()
-- Publishing visibility is a privileged state transition, not just a boolean.
-- Even service-role writes must carry the transaction-local asset context set
-- by publish_video_library_reel after it has performed all eligibility checks.
CREATE OR REPLACE FUNCTION public.fn_guard_managed_post_visibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
CREATE OR REPLACE FUNCTION public.fn_guard_managed_reel_visibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
BEGIN
  IF NEW.origin_type = 'video_library'
     AND NEW.is_public = true
     AND (
       COALESCE(auth.role()::text, '') <> 'service_role'
       OR current_setting('app.video_library_publish_asset_id', true)
          IS DISTINCT FROM NEW.source_asset_id::text
       OR NOT public.fn_is_video_library_lineage_eligible(
         NEW.source_asset_id,
         NEW.youtube_video_id,
         NEW.canonical_asset_key,
         NEW.publication_key,
         NEW.video_url
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'managed library Reels may only be published by publish_video_library_reel';
  END IF;
  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_social_posts_managed_visibility_guard
  ON public.social_posts
CREATE TRIGGER trg_social_posts_managed_visibility_guard
  BEFORE INSERT OR UPDATE OF
    visibility, origin_type, source_asset_id, youtube_video_id,
    canonical_asset_key, publication_key, media_urls
  ON public.social_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_managed_post_visibility()
DROP TRIGGER IF EXISTS trg_social_reels_managed_visibility_guard
  ON public.social_reels
CREATE TRIGGER trg_social_reels_managed_visibility_guard
  BEFORE INSERT OR UPDATE OF
    is_public, origin_type, source_asset_id, youtube_video_id,
    canonical_asset_key, publication_key, video_url
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_managed_reel_visibility()
-- State changes hide linked content immediately. A return to verified does not
-- republish it; only the publisher RPC can deliberately restore visibility.
CREATE OR REPLACE FUNCTION public.fn_video_library_asset_fail_closed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
BEGIN
  IF public.fn_is_video_library_asset_eligible(NEW.id) THEN
    RETURN NEW;
  END IF;

  UPDATE public.social_reels r
  SET is_public = false
  WHERE r.origin_type = 'video_library'
    AND r.source_asset_id = NEW.id
    AND r.is_public = true
    AND NOT public.legacy_transition_eligible(r);

  UPDATE public.social_posts p
  SET visibility = 'private'
  WHERE p.origin_type = 'video_library'
    AND p.source_asset_id = NEW.id
    AND p.visibility IS DISTINCT FROM 'private'
    AND NOT public.legacy_transition_eligible(p);

  RETURN NEW;
END
$function$
UPDATE public.social_reels r
SET is_public = false
WHERE (r.origin_type = 'video_library' OR r.source_type = 'video_library')
  AND r.is_public = true
  AND NOT public.legacy_transition_eligible(r)
  AND NOT public.fn_is_video_library_lineage_eligible(
    r.source_asset_id,
    r.youtube_video_id,
    r.canonical_asset_key,
    r.publication_key,
    r.video_url
  )
UPDATE public.social_posts p
SET visibility = 'private'
WHERE p.origin_type = 'video_library'
  AND p.visibility IS DISTINCT FROM 'private'
  AND NOT public.legacy_transition_eligible(p)
  AND NOT public.fn_is_video_library_lineage_eligible(
    p.source_asset_id,
    p.youtube_video_id,
    p.canonical_asset_key,
    p.publication_key,
    NULLIF(p.media_urls ->> 0, '')
  )
DROP TRIGGER IF EXISTS trg_video_library_asset_fail_closed
  ON public.video_library_videos
CREATE TRIGGER trg_video_library_asset_fail_closed
  AFTER UPDATE OF
    type, youtube_video_id, availability_status, embeddable,
    availability_checked_at
  ON public.video_library_videos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_video_library_asset_fail_closed()
CREATE OR REPLACE FUNCTION public.fn_has_fresh_public_youtube_verification(
  p_youtube_video_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
  SELECT p_youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    AND (
      EXISTS (
        SELECT 1
        FROM public.video_library_videos verified_asset
        WHERE verified_asset.youtube_video_id = p_youtube_video_id
          AND verified_asset.availability_status = 'verified'
          AND verified_asset.embeddable IS TRUE
          AND verified_asset.availability_checked_at >= now() - interval '7 days'
          AND verified_asset.availability_checked_at <= now() + interval '5 minutes'
      )
      OR EXISTS (
        SELECT 1
        FROM public.youtube_embed_failures verified_source
        WHERE verified_source.video_id = p_youtube_video_id
          AND verified_source.verification_status = 'resolved'
          AND verified_source.resolved IS TRUE
          AND verified_source.last_verified_at >= now() - interval '7 days'
          AND verified_source.last_verified_at <= now() + interval '5 minutes'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.youtube_embed_failures failed_source
      WHERE failed_source.video_id = p_youtube_video_id
        AND failed_source.verification_status = 'confirmed'
        AND failed_source.resolved = false
    )
$function$
-- Repair a partially applied or previously enabled environment without
-- disturbing valid live work. A repeat migration may encounter jobs created
-- before the current guard/cancellation logic existed; only jobs that fail the
-- same current Reel, rights, lineage, and fresh-proof contract are retired.
WITH cancelled_jobs AS (
  UPDATE public.video_transcode_jobs job
  SET status = 'cancelled',
      completed_at = now(),
      error_message = 'cancelled_by_video_reels_revalidation',
      worker_id = NULL,
      claim_token = NULL,
      locked_at = NULL,
      heartbeat_at = now()
  WHERE job.source_type = 'youtube'
    AND job.status IN ('queued', 'processing', 'running')
    AND NOT EXISTS (
      SELECT 1
      FROM public.social_reels reel
      WHERE reel.id = job.reel_id
        AND public.fn_extract_youtube_video_id(job.youtube_url) IS NOT NULL
        AND public.fn_extract_youtube_video_id(job.source_url)
          = public.fn_extract_youtube_video_id(job.youtube_url)
        AND job.rights_status IN ('owned', 'licensed')
        AND job.user_id IS NOT DISTINCT FROM reel.author_id
        AND job.rights_status IS NOT DISTINCT FROM reel.rights_status
        AND job.origin_type IS NOT DISTINCT FROM reel.origin_type
        AND job.source_asset_id IS NOT DISTINCT FROM reel.source_asset_id
        AND job.canonical_asset_key = 'youtube:' ||
          public.fn_extract_youtube_video_id(job.youtube_url)
        AND reel.canonical_asset_key IS NOT DISTINCT FROM job.canonical_asset_key
        AND reel.youtube_video_id = public.fn_extract_youtube_video_id(job.youtube_url)
        AND public.fn_extract_youtube_video_id(reel.video_url) = reel.youtube_video_id
        AND public.fn_extract_youtube_video_id(reel.original_youtube_url) = reel.youtube_video_id
        AND reel.source_type = 'youtube'
        AND reel.native_processing_requested
        AND COALESCE(reel.is_deleted, false) = false
        AND reel.source_post_id IS NOT NULL
        AND reel.origin_type <> 'video_library'
        AND public.fn_has_fresh_public_youtube_verification(reel.youtube_video_id)
    )
  RETURNING job.reel_id
)
UPDATE public.social_reels reel
SET video_url = reel.original_youtube_url,
    playback_type = 'youtube_embed',
    media_status = 'ready',
    native_processing_requested = false,
    source_type = CASE
      WHEN reel.origin_type = 'video_library' THEN 'video_library'
      ELSE 'youtube'
    END
WHERE reel.id IN (
    SELECT cancelled.reel_id
    FROM cancelled_jobs cancelled
    WHERE cancelled.reel_id IS NOT NULL
  )
  AND reel.original_youtube_url IS NOT NULL
  AND reel.youtube_video_id IS NOT NULL
-- Shared public playback contract for non-managed videos. Ownership fields are
-- not sufficient by themselves: native playback must resolve to an existing
-- author-scoped object, and an embed must prove one exact YouTube identity.
CREATE OR REPLACE FUNCTION public.fn_is_public_video_playback_eligible(
  p_playback_type text,
  p_rights_status text,
  p_playback_url text,
  p_author_id uuid,
  p_youtube_video_id text,
  p_canonical_asset_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
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
COMMENT ON FUNCTION public.fn_is_public_video_playback_eligible(
  text, text, text, uuid, text, text
) IS 'Fail-closed public playback gate for exact YouTube embeds and proven author-scoped native videos.'
-- Restrictive policies intersect every permissive policy already deployed.
-- They close broad legacy USING(true) policies without disrupting the existing
-- audience-mode policy, and the linked-post EXISTS makes Reel access inherit
-- post visibility/deletion/audience changes immediately.
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY
ALTER TABLE public.social_reels ENABLE ROW LEVEL SECURITY
DROP POLICY IF EXISTS video_posts_public_select_guard
  ON public.social_posts
CREATE POLICY video_posts_public_select_guard
  ON public.social_posts
  AS RESTRICTIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    COALESCE(is_deleted, false) = false
    AND (
      author_id = (SELECT auth.uid())
      OR visibility IS DISTINCT FROM 'private'
    )
    AND public.fn_can_view_post(
      author_id,
      COALESCE(audience_mode, NULLIF(visibility, 'public'), 'public'),
      audience_list
    )
    AND (
      content_type IS DISTINCT FROM 'video'
      OR author_id = (SELECT auth.uid())
      OR public.legacy_transition_eligible(social_posts)
      OR public.fn_is_public_video_playback_eligible(
        playback_type,
        rights_status,
        NULLIF(media_urls ->> 0, ''),
        author_id,
        youtube_video_id,
        canonical_asset_key
      )
    )
    AND (
      public.legacy_transition_eligible(social_posts)
      OR origin_type <> 'video_library'
      OR public.fn_is_video_library_lineage_eligible(
        source_asset_id,
        youtube_video_id,
        canonical_asset_key,
        publication_key,
        NULLIF(media_urls ->> 0, '')
      )
    )
  )
DROP POLICY IF EXISTS video_reels_public_select_guard
  ON public.social_reels
CREATE POLICY video_reels_public_select_guard
  ON public.social_reels
  AS RESTRICTIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    COALESCE(is_deleted, false) = false
    AND (
      author_id = (SELECT auth.uid())
      OR (
        is_public = true
        AND (
          public.legacy_transition_eligible(social_reels)
          OR public.fn_is_public_video_playback_eligible(
            playback_type,
            rights_status,
            video_url,
            author_id,
            youtube_video_id,
            canonical_asset_key
          )
        )
      )
    )
    AND (
      public.legacy_transition_eligible(social_reels)
      OR (
        origin_type <> 'video_library'
        AND source_type IS DISTINCT FROM 'video_library'
      )
      OR (
        origin_type = 'video_library'
        AND source_type = 'video_library'
        AND public.fn_is_video_library_lineage_eligible(
          source_asset_id,
          youtube_video_id,
          canonical_asset_key,
          publication_key,
          video_url
        )
      )
    )
    AND (
      source_post_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.social_posts linked_post
        WHERE linked_post.id = social_reels.source_post_id
      )
    )
  )
-- ---------------------------------------------------------------------------
-- 7. Failure and duration behavior. A failed optimization returns to the
--    original embed. No trigger in the new state deletes an embed-only Reel.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_reel_falls_back_when_job_dies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM 'failed' OR NEW.reel_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.social_reels r
  SET video_url = r.original_youtube_url,
      playback_type = 'youtube_embed',
      media_status = 'ready',
      native_processing_requested = false,
      source_type = CASE
        WHEN r.origin_type = 'video_library' THEN 'video_library'
        ELSE 'youtube'
      END
  WHERE r.id = NEW.reel_id
    AND r.media_status IN ('queued', 'processing')
    AND r.original_youtube_url IS NOT NULL
    AND r.youtube_video_id IS NOT NULL;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_reel_falls_back_when_job_dies skipped job % (%)', NEW.id, SQLERRM;
  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_reel_falls_back_when_job_dies
  ON public.video_transcode_jobs
CREATE TRIGGER trg_reel_falls_back_when_job_dies
  AFTER INSERT OR UPDATE OF status ON public.video_transcode_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_reel_falls_back_when_job_dies()
CREATE OR REPLACE FUNCTION public.fn_filtered_too_long_delete_reel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
BEGIN
  IF NEW.status = 'failed'
     AND COALESCE(NEW.error_message, '') ILIKE 'filtered_too_long_or_large%'
     AND (OLD.status IS DISTINCT FROM NEW.status
          OR COALESCE(OLD.error_message, '') IS DISTINCT FROM COALESCE(NEW.error_message, ''))
     AND NEW.reel_id IS NOT NULL
  THEN
    UPDATE public.social_reels r
    SET video_url = r.original_youtube_url,
        playback_type = 'youtube_embed',
        media_status = 'ready',
        native_processing_requested = false,
        source_type = CASE
          WHEN r.origin_type = 'video_library' THEN 'video_library'
          ELSE 'youtube'
        END
    WHERE r.id = NEW.reel_id
      AND r.original_youtube_url IS NOT NULL
      AND r.youtube_video_id IS NOT NULL;
  END IF;

  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_filtered_too_long_delete_reel
  ON public.video_transcode_jobs
CREATE TRIGGER trg_filtered_too_long_delete_reel
  AFTER UPDATE ON public.video_transcode_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_filtered_too_long_delete_reel()
CREATE OR REPLACE FUNCTION public.fn_social_reels_block_too_long()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_duration_text text;
  v_duration numeric;
BEGIN
  -- Long source embeds remain valid library/social content. The duration guard
  -- applies only to an explicitly authorized native-processing request.
  IF NOT NEW.native_processing_requested
     OR NEW.rights_status NOT IN ('owned', 'licensed')
     OR NEW.source_post_id IS NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT p.metadata ->> 'duration_seconds'
  INTO v_duration_text
  FROM public.social_posts p
  WHERE p.id = NEW.source_post_id;

  IF v_duration_text ~ '^[0-9]+([.][0-9]+)?$' THEN
    v_duration := v_duration_text::numeric;
  END IF;

  IF v_duration IS NOT NULL AND v_duration >= 600 THEN
    RAISE NOTICE '[reels-filter] blocking native processing: post % has duration_seconds=%',
      NEW.source_post_id, v_duration;
    NEW.native_processing_requested := false;
    NEW.media_status := 'ready';
    NEW.playback_type := 'youtube_embed';
    NEW.video_url := COALESCE(NEW.original_youtube_url, NEW.video_url);
    RETURN NEW;
  END IF;

  RETURN NEW;
END
$function$
DROP TRIGGER IF EXISTS trg_social_reels_block_too_long ON public.social_reels
CREATE TRIGGER trg_social_reels_block_too_long
  BEFORE INSERT OR UPDATE OF native_processing_requested, rights_status
  ON public.social_reels
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_social_reels_block_too_long()
-- ---------------------------------------------------------------------------
-- 8. Recreate the post -> Reel mirror explicitly with the full identity model.
-- ---------------------------------------------------------------------------

-- Managed imports are system publication, not a user engagement action. The
-- live database otherwise auto-creates a 24-hour Story and calls the 15-diamond
-- social-post reward for every inserted post. Preserve those triggers for real
-- posts while preventing Story spam and reward farming by the publisher bot.
DO $managed_post_side_effects$
BEGIN
  IF to_regprocedure('public.fn_auto_create_story_from_post()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_auto_story_on_post ON public.social_posts;
    CREATE TRIGGER trg_auto_story_on_post
      AFTER INSERT ON public.social_posts
      FOR EACH ROW
      WHEN (NEW.origin_type IS DISTINCT FROM 'video_library')
      EXECUTE FUNCTION public.fn_auto_create_story_from_post();
  END IF;

  IF to_regprocedure('public.fn_social_post_reward()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_reward_social_post ON public.social_posts;
    CREATE TRIGGER trg_reward_social_post
      AFTER INSERT ON public.social_posts
      FOR EACH ROW
      WHEN (NEW.origin_type IS DISTINCT FROM 'video_library')
      EXECUTE FUNCTION public.fn_social_post_reward();
  END IF;
END
$managed_post_side_effects$
CREATE OR REPLACE FUNCTION public.fn_social_posts_video_to_reel_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
DROP TRIGGER IF EXISTS trg_social_posts_video_to_reel_mirror
  ON public.social_posts
CREATE TRIGGER trg_social_posts_video_to_reel_mirror
  AFTER INSERT ON public.social_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_social_posts_video_to_reel_mirror()
-- User uploads use one atomic write boundary too. The caller supplies an
-- explicit poker-topic attestation; generic uploads remain topic=unknown and
-- are therefore not promoted into the public poker Reel feed by assumption.
CREATE OR REPLACE FUNCTION public.publish_user_video_reel(
  p_video_url text,
  p_topic text,
  p_topic_confirmed boolean,
  p_caption text DEFAULT NULL,
  p_thumbnail_url text DEFAULT NULL,
  p_visibility text DEFAULT 'public'
)
RETURNS TABLE (
  social_post_id uuid,
  social_reel_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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

  IF p_topic_confirmed IS DISTINCT FROM true
     OR v_topic NOT IN ('poker', 'cash', 'tournament')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'an explicit poker topic confirmation is required';
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
      NULLIF(btrim(p_thumbnail_url), ''),
      jsonb_build_object(
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
      v_post.thumbnail_url,
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
$function$
REVOKE ALL ON FUNCTION public.publish_user_video_reel(
  text, text, boolean, text, text, text
) FROM PUBLIC, anon
GRANT EXECUTE ON FUNCTION public.publish_user_video_reel(
  text, text, boolean, text, text, text
) TO authenticated
-- ---------------------------------------------------------------------------
-- 9. Atomic, race-safe, service-role-only library publisher
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.publish_video_library_reel(
  p_video_id text,
  p_author_id uuid,
  p_caption text DEFAULT NULL
)
RETURNS TABLE (
  social_post_id uuid,
  social_reel_id uuid,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_asset public.video_library_videos%ROWTYPE;
  v_post_id uuid;
  v_reel_id uuid;
  v_post_created boolean := false;
  v_reel_created boolean := false;
  v_canonical_key text;
  v_publication_key text;
  v_caption text;
  v_video_url text;
BEGIN
  IF COALESCE(auth.role()::text, '') <> 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'publish_video_library_reel requires the service role';
  END IF;

  IF (
    SELECT count(*)
    FROM public.video_reels_pipeline_controls c
    WHERE c.control_key IN (
      'video_library_reel_creation',
      'video_library_reel_publication'
    )
      AND c.enabled
  ) <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'video library Reel publication is disabled';
  END IF;

  IF p_author_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.video_reels_pipeline_config config
       JOIN public.profiles p
         ON p.id = config.video_library_publisher_profile_id
       WHERE config.singleton_key = 'video_library'
         AND config.video_library_publisher_profile_id = p_author_id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'the configured live video-library publisher profile is required';
  END IF;

  SELECT v.*
  INTO v_asset
  FROM public.video_library_videos v
  WHERE v.youtube_video_id = btrim(p_video_id)
     OR v.id::text = btrim(p_video_id)
  ORDER BY CASE WHEN v.youtube_video_id = btrim(p_video_id) THEN 0 ELSE 1 END
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'video library asset was not found';
  END IF;

  -- Serialize all publication attempts for the same source asset, including
  -- requests using different textual identifiers.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('video-library:' || v_asset.id::text, 0)
  );

  IF v_asset.type NOT IN ('cash', 'tournament') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'only cash and tournament poker videos may be published as library Reels';
  END IF;

  IF v_asset.availability_status <> 'verified'
     OR v_asset.embeddable IS DISTINCT FROM true
     OR v_asset.availability_checked_at IS NULL
     OR v_asset.availability_checked_at < now() - interval '7 days'
     OR v_asset.availability_checked_at > now() + interval '5 minutes'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'video library asset must have a fresh verified embeddable result';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.youtube_embed_failures f
    WHERE f.video_id = v_asset.youtube_video_id
      AND f.verification_status = 'confirmed'
      AND f.resolved = false
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'video library asset has an active embed failure';
  END IF;

  IF public.fn_extract_youtube_video_id(v_asset.youtube_video_id) IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'video library asset has an invalid YouTube video id';
  END IF;

  v_canonical_key := 'youtube:' || v_asset.youtube_video_id;
  v_publication_key := 'video-library:' || v_asset.id::text;
  v_caption := COALESCE(NULLIF(btrim(p_caption), ''), v_asset.title);
  v_video_url := 'https://www.youtube.com/watch?v=' || v_asset.youtube_video_id;

  -- The visibility guards require this transaction-local proof that all
  -- checks above ran inside the sole supported publication path.
  PERFORM set_config(
    'app.video_library_publish_asset_id',
    v_asset.id::text,
    true
  );

  SELECT p.id
  INTO v_post_id
  FROM public.social_posts p
  WHERE p.origin_type = 'video_library'
    AND (
      p.source_asset_id = v_asset.id
      OR p.publication_key = v_publication_key
      OR p.canonical_asset_key = v_canonical_key
    )
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1
  FOR UPDATE;

  SELECT r.id
  INTO v_reel_id
  FROM public.social_reels r
  WHERE r.origin_type = 'video_library'
    AND (
      r.source_asset_id = v_asset.id
      OR r.publication_key = v_publication_key
      OR r.canonical_asset_key = v_canonical_key
    )
  ORDER BY r.created_at ASC NULLS LAST, r.id ASC
  LIMIT 1
  FOR UPDATE;

  IF v_post_id IS NULL THEN
    INSERT INTO public.social_posts (
      author_id,
      content,
      content_type,
      media_urls,
      visibility,
      audience_mode,
      thumbnail_url,
      link_url,
      link_title,
      metadata,
      topics,
      origin_type,
      playback_type,
      topic,
      rights_status,
      source_asset_id,
      youtube_video_id,
      canonical_asset_key,
      publication_key
    ) VALUES (
      p_author_id,
      v_caption,
      'video',
      jsonb_build_array(v_video_url),
      'public',
      'public',
      v_asset.thumbnail_url,
      v_video_url,
      v_asset.title,
      jsonb_build_object(
        'video_library_id', v_asset.id,
        'youtube_video_id', v_asset.youtube_video_id,
        'source_id', v_asset.source_id,
        'source_name', v_asset.source_name,
        'video_type', v_asset.type,
        'duration', v_asset.duration,
        'availability_checked_at', v_asset.availability_checked_at
      ),
      ARRAY['poker', v_asset.type]::text[],
      'video_library',
      'youtube_embed',
      'poker',
      'embed_only',
      v_asset.id,
      v_asset.youtube_video_id,
      v_canonical_key,
      v_publication_key
    )
    RETURNING id INTO v_post_id;
    v_post_created := true;
  END IF;

  -- The explicit mirror normally creates the Reel with the post. It
  -- intentionally skips when an older managed Reel already owns the canonical
  -- key, so re-read before deciding whether a direct insert is necessary.
  IF v_reel_id IS NULL THEN
    SELECT r.id
    INTO v_reel_id
    FROM public.social_reels r
    WHERE r.source_post_id = v_post_id
       OR (
         r.origin_type = 'video_library'
         AND r.canonical_asset_key = v_canonical_key
       )
    ORDER BY
      CASE WHEN r.source_post_id = v_post_id THEN 0 ELSE 1 END,
      r.created_at ASC NULLS LAST,
      r.id ASC
    LIMIT 1
    FOR UPDATE;
  END IF;

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
      media_status,
      original_youtube_url,
      origin_type,
      playback_type,
      topic,
      rights_status,
      source_asset_id,
      canonical_asset_key,
      publication_key,
      native_processing_requested
    ) VALUES (
      p_author_id,
      v_video_url,
      v_asset.thumbnail_url,
      v_caption,
      v_post_id,
      true,
      'video_library',
      v_asset.youtube_video_id,
      'ready',
      v_video_url,
      'video_library',
      'youtube_embed',
      'poker',
      'embed_only',
      v_asset.id,
      v_canonical_key,
      v_publication_key,
      false
    )
    RETURNING id INTO v_reel_id;
    v_reel_created := true;
  ELSE
    -- Upgrade a pre-foundation library Reel in place so its ID, likes, saves,
    -- views, comments, and shares all survive.
    UPDATE public.social_reels r
    SET author_id = p_author_id,
        video_url = v_video_url,
        thumbnail_url = COALESCE(v_asset.thumbnail_url, r.thumbnail_url),
        caption = v_caption,
        source_post_id = v_post_id,
        is_public = true,
        source_type = 'video_library',
        youtube_video_id = v_asset.youtube_video_id,
        media_status = 'ready',
        original_youtube_url = v_video_url,
        origin_type = 'video_library',
        playback_type = 'youtube_embed',
        topic = 'poker',
        rights_status = 'embed_only',
        source_asset_id = v_asset.id,
        canonical_asset_key = v_canonical_key,
        publication_key = v_publication_key,
        native_processing_requested = false
    WHERE r.id = v_reel_id;
  END IF;

  UPDATE public.social_posts p
  SET author_id = p_author_id,
      content = v_caption,
      content_type = 'video',
      media_urls = jsonb_build_array(v_video_url),
      visibility = 'public',
      audience_mode = 'public',
      thumbnail_url = COALESCE(v_asset.thumbnail_url, p.thumbnail_url),
      link_url = '/hub/reels?id=' || v_reel_id::text,
      link_title = v_asset.title,
      metadata = COALESCE(p.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'video_library_id', v_asset.id,
          'youtube_video_id', v_asset.youtube_video_id,
          'social_reel_id', v_reel_id,
          'source_id', v_asset.source_id,
          'source_name', v_asset.source_name,
          'video_type', v_asset.type,
          'availability_checked_at', v_asset.availability_checked_at
        ),
      topics = ARRAY['poker', v_asset.type]::text[],
      origin_type = 'video_library',
      playback_type = 'youtube_embed',
      topic = 'poker',
      rights_status = 'embed_only',
      source_asset_id = v_asset.id,
      youtube_video_id = v_asset.youtube_video_id,
      canonical_asset_key = v_canonical_key,
      publication_key = v_publication_key
  WHERE p.id = v_post_id;

  RETURN QUERY
  SELECT v_post_id, v_reel_id, (v_post_created OR v_reel_created);
END
$function$
-- Final native publication is a single authorization and write boundary. The
-- worker may upload bytes optimistically, but only this RPC can atomically
-- change the Reel, its linked post, and the claimed job to completed.
CREATE OR REPLACE FUNCTION public.complete_rights_cleared_youtube_transcode(
  p_job_id text,
  p_claim_token uuid,
  p_worker_id text,
  p_output_url text,
  p_thumbnail_url text DEFAULT NULL
)
RETURNS TABLE (
  transcode_job_id text,
  social_reel_id uuid,
  social_post_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_job public.video_transcode_jobs%ROWTYPE;
  v_reel public.social_reels%ROWTYPE;
  v_post public.social_posts%ROWTYPE;
  v_youtube_id text;
  v_native_enabled boolean := false;
  v_job_found boolean := false;
  v_output_url text := split_part(split_part(btrim(COALESCE(p_output_url, '')), '?', 1), '#', 1);
BEGIN
  IF COALESCE(auth.role()::text, '') <> 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'complete_rights_cleared_youtube_transcode requires the service role';
  END IF;

  IF p_job_id IS NULL
     OR btrim(p_job_id) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_claim_token IS NULL
     OR btrim(COALESCE(p_worker_id, '')) = ''
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'job, claim token, and worker identity are required';
  END IF;

  SELECT j.*
  INTO v_job
  FROM public.video_transcode_jobs j
  WHERE j.id = p_job_id
  FOR UPDATE;
  v_job_found := FOUND;

  -- A response may be lost after COMMIT. Replaying the same immutable claim and
  -- output is a successful acknowledgement, never a second publication. This
  -- check deliberately precedes the kill switch so a completed write remains
  -- acknowledgeable after an emergency shutdown.
  IF v_job_found
     AND v_job.status = 'completed'
     AND v_job.claim_token IS NOT DISTINCT FROM p_claim_token
     AND v_job.worker_id IS NOT DISTINCT FROM p_worker_id
     AND split_part(split_part(COALESCE(v_job.output_url, ''), '?', 1), '#', 1)
       IS NOT DISTINCT FROM v_output_url
  THEN
    SELECT r.*
    INTO v_reel
    FROM public.social_reels r
    WHERE r.id = v_job.reel_id;

    IF FOUND
       AND v_reel.source_post_id IS NOT NULL
       AND v_reel.video_url IS NOT DISTINCT FROM v_output_url
       AND v_reel.playback_type = 'native'
       AND v_reel.source_type = 'native'
       AND v_reel.media_status = 'ready'
       AND public.fn_is_user_video_storage_url(v_output_url, v_reel.author_id)
    THEN
      SELECT p.*
      INTO v_post
      FROM public.social_posts p
      WHERE p.id = v_reel.source_post_id;

      IF FOUND
         AND NULLIF(v_post.media_urls ->> 0, '') IS NOT DISTINCT FROM v_output_url
         AND v_post.playback_type = 'native'
      THEN
        RETURN QUERY SELECT v_job.id, v_reel.id, v_post.id;
        RETURN;
      END IF;
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'completed transcode acknowledgement does not match current publication state';
  END IF;

  SELECT c.enabled
  INTO v_native_enabled
  FROM public.video_reels_pipeline_controls c
  WHERE c.control_key = 'youtube_native_transcode'
  FOR SHARE;

  IF NOT COALESCE(v_native_enabled, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'YouTube native transcode publication is disabled';
  END IF;

  IF NOT v_job_found
     OR v_job.status <> 'processing'
     OR v_job.claim_token IS DISTINCT FROM p_claim_token
     OR v_job.worker_id IS DISTINCT FROM p_worker_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'transcode claim is no longer current';
  END IF;

  SELECT r.*
  INTO v_reel
  FROM public.social_reels r
  WHERE r.id = v_job.reel_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'claimed transcode Reel does not exist';
  END IF;

  v_youtube_id := public.fn_extract_youtube_video_id(v_job.youtube_url);
  IF v_youtube_id IS NULL
     OR public.fn_extract_youtube_video_id(v_job.source_url) IS DISTINCT FROM v_youtube_id
     OR public.fn_extract_youtube_video_id(v_reel.video_url) IS DISTINCT FROM v_youtube_id
     OR public.fn_extract_youtube_video_id(v_reel.original_youtube_url) IS DISTINCT FROM v_youtube_id
     OR v_job.canonical_asset_key IS DISTINCT FROM 'youtube:' || v_youtube_id
     OR v_reel.youtube_video_id IS DISTINCT FROM v_youtube_id
     OR v_reel.canonical_asset_key IS DISTINCT FROM 'youtube:' || v_youtube_id
     OR v_job.user_id IS DISTINCT FROM v_reel.author_id
     OR v_job.source_type IS DISTINCT FROM 'youtube'
     OR v_reel.source_type IS DISTINCT FROM 'youtube'
     OR v_job.rights_status NOT IN ('owned', 'licensed')
     OR v_reel.rights_status IS DISTINCT FROM v_job.rights_status
     OR v_job.origin_type IS DISTINCT FROM v_reel.origin_type
     OR v_job.source_asset_id IS DISTINCT FROM v_reel.source_asset_id
     OR v_reel.native_processing_requested IS DISTINCT FROM true
     OR COALESCE(v_reel.is_deleted, false)
     OR v_reel.source_post_id IS NULL
     OR v_reel.origin_type = 'video_library'
     OR v_reel.source_type = 'video_library'
     OR NOT public.fn_has_fresh_public_youtube_verification(v_youtube_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'current Reel does not match the claimed rights-cleared YouTube source';
  END IF;

  IF NOT public.fn_is_user_video_storage_url(v_output_url, v_reel.author_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'native output must be an existing video in the Reel author namespace';
  END IF;

  SELECT p.*
  INTO v_post
  FROM public.social_posts p
  WHERE p.id = v_reel.source_post_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_post.author_id IS DISTINCT FROM v_reel.author_id
     OR v_post.content_type IS DISTINCT FROM 'video'
     OR COALESCE(v_post.is_deleted, false)
     OR v_post.canonical_asset_key IS DISTINCT FROM v_reel.canonical_asset_key
     OR v_post.rights_status IS DISTINCT FROM v_reel.rights_status
     OR public.fn_extract_youtube_video_id(NULLIF(v_post.media_urls ->> 0, ''))
        IS DISTINCT FROM v_youtube_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'linked post does not match the claimed rights-cleared Reel';
  END IF;

  -- Retire the exact claim before changing the Reel's processing request.
  -- This remains atomic with the publication below, while ensuring the
  -- authorization-revocation trigger cannot cancel the completion itself.
  UPDATE public.video_transcode_jobs j
  SET status = 'completed',
      completed_at = now(),
      output_url = v_output_url,
      error_message = NULL,
      heartbeat_at = now(),
      locked_at = NULL
  WHERE j.id = v_job.id
    AND j.status = 'processing'
    AND j.claim_token = p_claim_token
    AND j.worker_id = p_worker_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'transcode claim changed before completion';
  END IF;

  PERFORM set_config(
    'app.youtube_native_completion_job_id',
    v_job.id,
    true
  );

  UPDATE public.social_reels r
  SET video_url = v_output_url,
      thumbnail_url = COALESCE(NULLIF(btrim(p_thumbnail_url), ''), r.thumbnail_url),
      source_type = 'native',
      playback_type = 'native',
      media_status = 'ready',
      native_processing_requested = false
  WHERE r.id = v_reel.id;

  UPDATE public.social_posts p
  SET media_urls = CASE
        WHEN jsonb_typeof(p.media_urls) = 'array'
          AND jsonb_array_length(p.media_urls) > 0
        THEN jsonb_set(p.media_urls, '{0}', to_jsonb(v_output_url), false)
        ELSE jsonb_build_array(v_output_url)
      END,
      -- The locked job/Reel/post lineage above is authoritative. Normalize
      -- legacy or stale provenance instead of letting a mismatched historical
      -- original_media_url make the guarded native transition impossible.
      original_media_url =
        'https://www.youtube.com/watch?v=' || v_youtube_id,
      thumbnail_url = COALESCE(NULLIF(btrim(p_thumbnail_url), ''), p.thumbnail_url),
      playback_type = 'native'
  WHERE p.id = v_post.id;

  RETURN QUERY SELECT v_job.id, v_reel.id, v_post.id;
END
$function$
REVOKE ALL ON FUNCTION public.publish_video_library_reel(text, uuid, text)
  FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.publish_video_library_reel(text, uuid, text)
  TO service_role
REVOKE ALL ON FUNCTION public.complete_rights_cleared_youtube_transcode(
  text, uuid, text, text, text
) FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.complete_rights_cleared_youtube_transcode(
  text, uuid, text, text, text
) TO service_role
REVOKE ALL ON FUNCTION public.fn_social_reels_yt_intercept()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_social_reels_yt_queue_job()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_guard_youtube_native_transcode_job()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_cancel_revoked_youtube_transcode_jobs()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_reel_falls_back_when_job_dies()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_filtered_too_long_delete_reel()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_social_reels_block_too_long()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_social_posts_video_to_reel_mirror()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_video_reels_pipeline_controls_touch()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_guard_managed_video_provenance()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_guard_legacy_transition_marker()
  FROM PUBLIC, anon, authenticated, service_role
REVOKE ALL ON FUNCTION public.fn_legacy_youtube_post_transition_snapshot(
  public.social_posts
) FROM PUBLIC, anon, authenticated, service_role
REVOKE ALL ON FUNCTION public.fn_legacy_youtube_reel_transition_snapshot(
  public.social_reels
) FROM PUBLIC, anon, authenticated, service_role
REVOKE ALL ON FUNCTION public.legacy_transition_eligible(
  public.social_posts
) FROM PUBLIC, anon, authenticated, service_role
GRANT EXECUTE ON FUNCTION public.legacy_transition_eligible(
  public.social_posts
) TO anon, authenticated, service_role
REVOKE ALL ON FUNCTION public.legacy_transition_eligible(
  public.social_reels
) FROM PUBLIC, anon, authenticated, service_role
GRANT EXECUTE ON FUNCTION public.legacy_transition_eligible(
  public.social_reels
) TO anon, authenticated, service_role
REVOKE ALL ON FUNCTION public.fn_social_posts_video_contract_defaults()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_is_user_video_storage_url(text, uuid)
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_has_fresh_public_youtube_verification(text)
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_is_platform_public_storage_url(text)
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_guard_managed_video_lineage()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_guard_managed_post_visibility()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_guard_managed_reel_visibility()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_video_library_asset_fail_closed()
  FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.fn_is_video_library_asset_eligible(uuid)
  FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.fn_is_video_library_asset_eligible(uuid)
  TO anon, authenticated
REVOKE ALL ON FUNCTION public.fn_is_video_library_lineage_eligible(
  uuid, text, text, text, text
) FROM PUBLIC
GRANT EXECUTE ON FUNCTION public.fn_is_video_library_lineage_eligible(
  uuid, text, text, text, text
) TO anon, authenticated
REVOKE ALL ON FUNCTION public.fn_is_public_video_playback_eligible(
  text, text, text, uuid, text, text
) FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.fn_is_public_video_playback_eligible(
  text, text, text, uuid, text, text
) TO anon, authenticated
GRANT EXECUTE ON FUNCTION public.fn_can_view_post(uuid, text, text[])
  TO anon, authenticated
COMMENT ON FUNCTION public.legacy_transition_eligible(public.social_posts) IS
  'Computed field for the exact immutable pre-Phase-1 YouTube post snapshot; expires seven days after the one-time capture and never overrides a confirmed failure.'
COMMENT ON FUNCTION public.legacy_transition_eligible(public.social_reels) IS
  'Computed field for the exact immutable pre-Phase-1 YouTube Reel snapshot; expires seven days after the one-time capture and never overrides a confirmed failure.'
COMMENT ON FUNCTION public.publish_video_library_reel(text, uuid, text) IS
  'Service-only atomic/idempotent publisher for fresh verified poker library embeds. Preserves and links a legacy managed Reel when one exists.'
DO $restore_audit_touch_triggers$
BEGIN
  IF to_regprocedure('public.fn_set_updated_at()') IS NULL
     OR to_regprocedure('public.fn_video_transcode_jobs_touch_updated_at()') IS NULL
  THEN
    RAISE EXCEPTION
      'video reels foundation: required audit timestamp trigger function is missing';
  END IF;

  DROP TRIGGER IF EXISTS trg_social_reels_updated_at
    ON public.social_reels;
  CREATE TRIGGER trg_social_reels_updated_at
    BEFORE UPDATE ON public.social_reels
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_set_updated_at();

  DROP TRIGGER IF EXISTS trg_video_transcode_jobs_touch
    ON public.video_transcode_jobs;
  CREATE TRIGGER trg_video_transcode_jobs_touch
    BEFORE UPDATE ON public.video_transcode_jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_video_transcode_jobs_touch_updated_at();
END
$restore_audit_touch_triggers$
-- ---------------------------------------------------------------------------
-- 10. Migration-time invariants
-- ---------------------------------------------------------------------------

DO $assertions$
DECLARE
  v_bad_embed_jobs bigint;
  v_bad_live_youtube_jobs bigint;
  v_bad_public_native_reels bigint;
  v_bad_public_native_posts bigint;
  v_bad_library_reels bigint;
  v_bad_library_posts bigint;
  v_bad_legacy_library_reels bigint;
  v_bad_failure_states bigint;
  v_bad_transition_markers bigint;
  v_transition_state_count bigint;
  v_bad_post_topics bigint;
  v_bad_linked_topics bigint;
  v_trigger_count integer;
BEGIN
  SELECT count(*)
  INTO v_bad_public_native_reels
  FROM public.social_reels r
  WHERE r.is_public = true
    AND r.playback_type = 'native'
    AND NOT public.fn_is_public_video_playback_eligible(
      r.playback_type,
      r.rights_status,
      r.video_url,
      r.author_id,
      r.youtube_video_id,
      r.canonical_asset_key
    );

  IF v_bad_public_native_reels <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % public native Reel(s) lack provable rights/storage lineage',
      v_bad_public_native_reels;
  END IF;

  SELECT count(*)
  INTO v_bad_public_native_posts
  FROM public.social_posts p
  WHERE p.content_type = 'video'
    AND p.visibility = 'public'
    AND p.playback_type = 'native'
    AND NOT public.fn_is_public_video_playback_eligible(
      p.playback_type,
      p.rights_status,
      NULLIF(p.media_urls ->> 0, ''),
      p.author_id,
      p.youtube_video_id,
      p.canonical_asset_key
    );

  IF v_bad_public_native_posts <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % public native post(s) lack provable rights/storage lineage',
      v_bad_public_native_posts;
  END IF;

  SELECT count(*)
  INTO v_bad_embed_jobs
  FROM public.video_transcode_jobs j
  JOIN public.social_reels r ON r.id = j.reel_id
  WHERE j.source_type = 'youtube'
    AND j.status IN ('queued', 'processing', 'running')
    AND r.rights_status = 'embed_only';

  IF v_bad_embed_jobs <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % embed-only Reel(s) still have live transcode jobs',
      v_bad_embed_jobs;
  END IF;

  SELECT count(*)
  INTO v_bad_live_youtube_jobs
  FROM public.video_transcode_jobs job
  WHERE job.source_type = 'youtube'
    AND job.status IN ('queued', 'processing', 'running')
    AND NOT EXISTS (
      SELECT 1
      FROM public.social_reels reel
      WHERE reel.id = job.reel_id
        AND public.fn_extract_youtube_video_id(job.youtube_url) IS NOT NULL
        AND public.fn_extract_youtube_video_id(job.source_url)
          = public.fn_extract_youtube_video_id(job.youtube_url)
        AND job.rights_status IN ('owned', 'licensed')
        AND job.user_id IS NOT DISTINCT FROM reel.author_id
        AND job.rights_status IS NOT DISTINCT FROM reel.rights_status
        AND job.origin_type IS NOT DISTINCT FROM reel.origin_type
        AND job.source_asset_id IS NOT DISTINCT FROM reel.source_asset_id
        AND job.canonical_asset_key = 'youtube:' ||
          public.fn_extract_youtube_video_id(job.youtube_url)
        AND reel.canonical_asset_key IS NOT DISTINCT FROM job.canonical_asset_key
        AND reel.youtube_video_id = public.fn_extract_youtube_video_id(job.youtube_url)
        AND public.fn_extract_youtube_video_id(reel.video_url) = reel.youtube_video_id
        AND public.fn_extract_youtube_video_id(reel.original_youtube_url) = reel.youtube_video_id
        AND reel.source_type = 'youtube'
        AND reel.native_processing_requested
        AND COALESCE(reel.is_deleted, false) = false
        AND reel.source_post_id IS NOT NULL
        AND reel.origin_type <> 'video_library'
        AND public.fn_has_fresh_public_youtube_verification(reel.youtube_video_id)
        AND EXISTS (
          SELECT 1
          FROM public.video_reels_pipeline_controls control
          WHERE control.control_key = 'youtube_native_transcode'
            AND control.enabled
        )
    );

  IF v_bad_live_youtube_jobs <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % live YouTube job(s) violate current rights, lineage, or fresh-proof authorization',
      v_bad_live_youtube_jobs;
  END IF;

  SELECT count(*)
  INTO v_bad_library_reels
  FROM public.social_reels r
  LEFT JOIN public.video_library_videos v ON v.id = r.source_asset_id
  WHERE r.origin_type = 'video_library'
    AND (
      r.source_asset_id IS NULL
      OR v.id IS NULL
      OR r.source_type <> 'video_library'
      OR r.youtube_video_id IS DISTINCT FROM v.youtube_video_id
      OR r.canonical_asset_key IS DISTINCT FROM 'youtube:' || v.youtube_video_id
      OR r.publication_key IS DISTINCT FROM 'video-library:' || v.id::text
      OR public.fn_extract_youtube_video_id(r.video_url)
         IS DISTINCT FROM v.youtube_video_id
      OR public.fn_extract_youtube_video_id(r.original_youtube_url)
         IS DISTINCT FROM v.youtube_video_id
      OR r.playback_type <> 'youtube_embed'
      OR r.rights_status <> 'embed_only'
      OR r.media_status <> 'ready'
      OR (
        r.is_public
        AND NOT public.legacy_transition_eligible(r)
        AND NOT public.fn_is_video_library_lineage_eligible(
          r.source_asset_id,
          r.youtube_video_id,
          r.canonical_asset_key,
          r.publication_key,
          r.video_url
        )
      )
    );

  IF v_bad_library_reels <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % managed library Reel(s) violate the canonical embed contract',
      v_bad_library_reels;
  END IF;

  SELECT count(*)
  INTO v_bad_library_posts
  FROM public.social_posts p
  LEFT JOIN public.video_library_videos v ON v.id = p.source_asset_id
  WHERE p.origin_type = 'video_library'
    AND (
      p.source_asset_id IS NULL
      OR v.id IS NULL
      OR p.youtube_video_id IS DISTINCT FROM v.youtube_video_id
      OR p.canonical_asset_key IS DISTINCT FROM 'youtube:' || v.youtube_video_id
      OR p.publication_key IS DISTINCT FROM 'video-library:' || v.id::text
      OR public.fn_extract_youtube_video_id(NULLIF(p.media_urls ->> 0, ''))
         IS DISTINCT FROM v.youtube_video_id
      OR (
        p.visibility = 'public'
        AND NOT public.legacy_transition_eligible(p)
        AND NOT public.fn_is_video_library_lineage_eligible(
          p.source_asset_id,
          p.youtube_video_id,
          p.canonical_asset_key,
          p.publication_key,
          NULLIF(p.media_urls ->> 0, '')
        )
      )
    );

  IF v_bad_library_posts <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % managed library post(s) violate canonical lineage',
      v_bad_library_posts;
  END IF;

  SELECT count(*)
  INTO v_bad_legacy_library_reels
  FROM public.social_reels r
  WHERE r.source_type = 'video_library'
    AND r.origin_type <> 'video_library'
    AND r.is_public = true
    AND NOT public.legacy_transition_eligible(r);

  IF v_bad_legacy_library_reels <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % unpromoted legacy library Reel(s) remain public',
      v_bad_legacy_library_reels;
  END IF;

  SELECT count(*)
  INTO v_bad_failure_states
  FROM public.youtube_embed_failures f
  WHERE (f.verification_status = 'confirmed') IS DISTINCT FROM (f.resolved = false);

  IF v_bad_failure_states <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % YouTube failure verdict(s) have incoherent state',
      v_bad_failure_states;
  END IF;

  SELECT count(*)
  INTO v_transition_state_count
  FROM public.video_reels_legacy_transition_state state
  WHERE state.transition_key = 'phase1-public-youtube'
    AND state.expires_at = state.captured_at + interval '7 days';

  IF v_transition_state_count <> 1 THEN
    RAISE EXCEPTION
      'video reels foundation: expected exactly one immutable legacy transition window, found %',
      v_transition_state_count;
  END IF;

  SELECT count(*)
  INTO v_bad_transition_markers
  FROM (
    SELECT p.id
    FROM public.social_posts p
    WHERE p.legacy_transition_expires_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.video_reels_legacy_transition_rows transition_row
        WHERE transition_row.surface = 'social_posts'
          AND transition_row.row_id = p.id
          AND transition_row.expires_at = p.legacy_transition_expires_at
      )
    UNION ALL
    SELECT r.id
    FROM public.social_reels r
    WHERE r.legacy_transition_expires_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.video_reels_legacy_transition_rows transition_row
        WHERE transition_row.surface = 'social_reels'
          AND transition_row.row_id = r.id
          AND transition_row.expires_at = r.legacy_transition_expires_at
      )
  ) bad_marker;

  IF v_bad_transition_markers <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % legacy transition marker(s) lack immutable snapshot evidence',
      v_bad_transition_markers;
  END IF;

  SELECT count(*)
  INTO v_bad_post_topics
  FROM public.social_posts p
  WHERE p.content_type = 'video'
    AND public.fn_infer_video_topic(p.metadata, p.topics) <> 'unknown'
    AND p.topic IS DISTINCT FROM public.fn_infer_video_topic(p.metadata, p.topics);

  IF v_bad_post_topics <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % explicitly classified video post(s) were not backfilled',
      v_bad_post_topics;
  END IF;

  SELECT count(*)
  INTO v_bad_linked_topics
  FROM public.social_reels r
  JOIN public.social_posts p ON p.id = r.source_post_id
  WHERE r.origin_type <> 'video_library'
    AND p.topic IN ('poker', 'sports')
    AND r.topic IS DISTINCT FROM p.topic;

  IF v_bad_linked_topics <> 0 THEN
    RAISE EXCEPTION
      'video reels foundation: % linked Reel(s) disagree with explicit post topic',
      v_bad_linked_topics;
  END IF;

  SELECT count(*)
  INTO v_trigger_count
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.social_posts'::regclass
    AND t.tgname = 'trg_social_posts_video_to_reel_mirror'
    AND NOT t.tgisinternal;

  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION
      'video reels foundation: expected exactly one post-to-Reel mirror trigger, found %',
      v_trigger_count;
  END IF;

  SELECT count(*)
  INTO v_trigger_count
  FROM pg_trigger t
  WHERE (
      (
        t.tgrelid = 'public.social_posts'::regclass
        AND t.tgname = 'trg_social_posts_legacy_transition_marker_guard'
      )
      OR (
        t.tgrelid = 'public.social_reels'::regclass
        AND t.tgname = 'trg_social_reels_legacy_transition_marker_guard'
      )
    )
    AND NOT t.tgisinternal;

  IF v_trigger_count <> 2 THEN
    RAISE EXCEPTION
      'video reels foundation: expected both immutable transition marker guards, found %',
      v_trigger_count;
  END IF;

  IF to_regprocedure('public.fn_auto_create_story_from_post()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.social_posts'::regclass
         AND t.tgname = 'trg_auto_story_on_post'
         AND pg_get_triggerdef(t.oid, true) ILIKE '%origin_type%video_library%'
     )
  THEN
    RAISE EXCEPTION
      'video reels foundation: managed-library Story side-effect guard is missing';
  END IF;

  IF to_regprocedure('public.fn_social_post_reward()') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.social_posts'::regclass
         AND t.tgname = 'trg_reward_social_post'
         AND pg_get_triggerdef(t.oid, true) ILIKE '%origin_type%video_library%'
     )
  THEN
    RAISE EXCEPTION
      'video reels foundation: managed-library reward side-effect guard is missing';
  END IF;
END
$assertions$
NOTIFY pgrst, 'reload schema'
COMMIT
-- ---------------------------------------------------------------------------
-- ROLLBACK / CONTAINMENT (Tier 3)
-- ---------------------------------------------------------------------------
-- Apply the block below as a NEW migration only after reverting the app to the
-- pre-Phase-1 release. It intentionally retains additive columns, repaired
-- lineage, rights evidence, constraints, and backfilled rows. Removing those
-- facts would be data loss and would re-enable unsafe third-party downloads.
-- This rollback stops every new Phase-1 write and removes only the three new RPC
-- entry points; the backward-compatible columns and safety triggers can remain
-- while a corrected forward migration is prepared.
--
-- BEGIN;
-- UPDATE public.video_reels_pipeline_controls
-- SET enabled = false,
--     updated_at = now()
-- WHERE control_key IN (
--   'video_library_discovery',
--   'video_library_enrichment',
--   'video_library_reel_creation',
--   'video_library_reel_publication',
--   'youtube_native_transcode'
-- );
-- REVOKE ALL ON FUNCTION public.publish_video_library_reel(text, uuid, text)
--   FROM PUBLIC, anon, authenticated, service_role;
-- REVOKE ALL ON FUNCTION public.publish_user_video_reel(text, text, boolean, text, text, text)
--   FROM PUBLIC, anon, authenticated, service_role;
-- REVOKE ALL ON FUNCTION public.complete_rights_cleared_youtube_transcode(text, uuid, text, text, text)
--   FROM PUBLIC, anon, authenticated, service_role;
-- DROP FUNCTION IF EXISTS public.publish_video_library_reel(text, uuid, text);
-- DROP FUNCTION IF EXISTS public.publish_user_video_reel(text, text, boolean, text, text, text);
-- DROP FUNCTION IF EXISTS public.complete_rights_cleared_youtube_transcode(text, uuid, text, text, text);
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
