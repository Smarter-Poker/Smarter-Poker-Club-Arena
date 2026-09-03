-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902182717; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- EVERY HORSE GETS A SOCIAL IDENTITY (2026-09-02)
--
-- The stable panel counts content_authors; the poker fleet lives in profiles.
-- On 2026-09-01, 416 Deep Stack Society horse profiles were created and only
-- 163 content_authors rows were minted beside them, so the panel read 756 when
-- the fleet was 1,000 and 253 horses were invisible to it.
--
-- WHY IT STOPPED AT 163. content_authors carries UNIQUE (alias) and the
-- generator that night drew from a 20-adjective x 20-noun vocabulary: 400
-- possible handles, of which 147 were already spent by earlier authors. That
-- left 253 free handles for 416 horses, so the batch was arithmetically
-- incapable of finishing. It minted 163 before random draws collided into the
-- unique index often enough to stop it, and nothing anywhere reported the
-- shortfall - the horses were dealt into cash games and tournaments the whole
-- time, simply absent from the roster that names them.
--
-- Three things here: a minting function that cannot exhaust, the backfill of
-- the 283 horses currently missing one, and a reader that makes the next drift
-- loud instead of silent.

-- 1. A HANDLE THAT CANNOT RUN OUT ------------------------------------------
-- Draws from the WHOLE observed vocabulary rather than one night's 20x20 slice
-- (413 first words x 115 second words = 47,495 handles as this is written), is
-- deterministic in the profile id so a re-run is idempotent in spirit, probes
-- forward on collision, and appends a discriminator once probing has clearly
-- entered a crowded corner. It cannot fail to return a free handle.
CREATE OR REPLACE FUNCTION public.fn_mint_social_alias(p_seed text)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_w1 text[];
  v_w2 text[];
  v_base text;
  v_cand text;
  v_n integer := 0;
  v_h bigint;
BEGIN
  SELECT array_agg(w ORDER BY w) INTO v_w1
    FROM (SELECT DISTINCT (regexp_match(alias, '^([A-Z][a-z]+)'))[1] AS w
            FROM public.content_authors) s
   WHERE w IS NOT NULL;
  SELECT array_agg(w ORDER BY w) INTO v_w2
    FROM (SELECT DISTINCT (regexp_match(alias, '^[A-Z][a-z]+([A-Z][a-z]+)'))[1] AS w
            FROM public.content_authors) s
   WHERE w IS NOT NULL;

  IF v_w1 IS NULL OR v_w2 IS NULL
     OR COALESCE(array_length(v_w1, 1), 0) = 0
     OR COALESCE(array_length(v_w2, 1), 0) = 0 THEN
    RAISE EXCEPTION 'fn_mint_social_alias: no alias vocabulary to draw from';
  END IF;

  v_h := abs(hashtext(p_seed));

  LOOP
    v_base := v_w1[1 + ((v_h + v_n * 7919) % array_length(v_w1, 1))]
           || v_w2[1 + (((v_h / 17) + v_n * 104729) % array_length(v_w2, 1))];
    -- Pure handles first. Once fifty probes have all collided we are in a
    -- crowded corner of the space, so take the discriminator rather than
    -- probing forever: this is the safety net that 2026-09-01 did not have.
    v_cand := CASE WHEN v_n < 50 THEN v_base ELSE v_base || (v_n - 49)::text END;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.content_authors WHERE alias = v_cand);
    v_n := v_n + 1;
    IF v_n > 100000 THEN
      RAISE EXCEPTION 'fn_mint_social_alias: could not mint a free alias for %', p_seed;
    END IF;
  END LOOP;

  RETURN v_cand;
END;
$fn$;

COMMENT ON FUNCTION public.fn_mint_social_alias(text) IS
  'Mints a free content_authors.alias. Cannot exhaust: probes the full observed vocabulary then falls back to a numeric discriminator. Added 2026-09-02 after a 400-handle generator stranded 253 horses.';

-- 2. THE BACKFILL -----------------------------------------------------------
DO $backfill$
DECLARE
  r record;
  v_alias text;
  v_loc text;
  v_tz text;
  v_spec text;
  v_stakes text;
  v_h bigint;
  v_made integer := 0;
  -- The same twenty cities, ten specialities and seven stake ladders the
  -- 2026-09-01 batch used, so a backfilled horse is indistinguishable from one
  -- minted that night. Timezones are index-matched to the cities.
  v_locs text[] := ARRAY['Atlantic City, NJ','Austin, TX','Barcelona, ES','Berlin, DE',
    'Brooklyn, NY','Chicago, IL','Dallas, TX','Denver, CO','Dublin, IE','Las Vegas, NV',
    'Lisbon, PT','London, UK','Los Angeles, CA','Manchester, UK','Manila, PH',
    'Melbourne, AU','Miami, FL','Phoenix, AZ','Seattle, WA','Toronto, CA'];
  v_tzs text[] := ARRAY['America/New_York','America/Chicago','Europe/Madrid','Europe/Berlin',
    'America/New_York','America/Chicago','America/Chicago','America/Denver','Europe/Dublin','America/Los_Angeles',
    'Europe/Lisbon','Europe/London','America/Los_Angeles','Europe/London','Asia/Manila',
    'Australia/Melbourne','America/New_York','America/Phoenix','America/Los_Angeles','America/Toronto'];
  v_specs text[] := ARRAY['bounty tournaments','cash games','heads-up','live cash','mixed games',
    'PLO','satellites','short deck','spins','tournaments'];
  v_stk text[] := ARRAY['1/2','1/3','10/25','2/3','2/5','25/50','5/10'];
BEGIN
  FOR r IN
    SELECT p.id, p.display_name, p.username
      FROM public.profiles p
     WHERE p.is_horse
       AND NOT EXISTS (SELECT 1 FROM public.content_authors ca WHERE ca.profile_id = p.id)
     ORDER BY p.created_at, p.id
  LOOP
    v_h := abs(hashtext(r.id::text));
    v_loc    := v_locs [1 + (v_h % 20)];
    v_tz     := v_tzs  [1 + (v_h % 20)];
    v_spec   := v_specs[1 + ((v_h / 7) % 10)];
    v_stakes := v_stk  [1 + ((v_h / 11) % 7)];
    v_alias  := public.fn_mint_social_alias(r.id::text);

    INSERT INTO public.content_authors
      (name, alias, location, timezone, specialty, stakes, bio, avatar_seed, profile_id, is_active)
    VALUES
      (COALESCE(NULLIF(r.display_name, ''), r.username),
       v_alias, v_loc, v_tz, v_spec, v_stakes,
       v_spec || ' regular out of ' || v_loc || '. Mostly ' || v_stakes || '.',
       lower(v_alias) || '_' || substr(md5(r.id::text), 1, 8),
       r.id, true);

    v_made := v_made + 1;
  END LOOP;

  RAISE NOTICE 'social identities minted: %', v_made;
END;
$backfill$;

-- 3. MAKE THE NEXT DRIFT LOUD ----------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_horses_without_social_identity()
RETURNS TABLE(profile_id uuid, display_name text, created_at timestamptz)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $rd$
  SELECT p.id, p.display_name, p.created_at
    FROM public.profiles p
   WHERE p.is_horse
     AND NOT EXISTS (SELECT 1 FROM public.content_authors ca WHERE ca.profile_id = p.id)
   ORDER BY p.created_at DESC;
$rd$;

COMMENT ON FUNCTION public.fn_horses_without_social_identity() IS
  'Horses that exist as poker players but not on the stable roster. Should always be empty; a non-empty result means a fleet build minted profiles without content_authors rows, which is how the panel read 756 against a fleet of 1,000 on 2026-09-01.';

-- One horse, one social identity. No duplicates today, and none possible after
-- this: the panel counts these rows, so a second row is a double-counted horse.
CREATE UNIQUE INDEX IF NOT EXISTS content_authors_profile_id_uniq
  ON public.content_authors (profile_id)
  WHERE profile_id IS NOT NULL;

-- 4. ASSERTIONS -------------------------------------------------------------
DO $assert$
DECLARE
  v_missing integer;
  v_horses integer;
  v_linked integer;
BEGIN
  SELECT count(*) INTO v_missing FROM public.fn_horses_without_social_identity();
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill incomplete: % horse(s) still carry no social identity', v_missing;
  END IF;

  SELECT count(*) INTO v_horses FROM public.profiles WHERE is_horse;
  SELECT count(*) INTO v_linked FROM public.content_authors WHERE profile_id IS NOT NULL;
  IF v_linked <> v_horses THEN
    RAISE EXCEPTION 'roster mismatch: % horses against % linked identities', v_horses, v_linked;
  END IF;

  RAISE NOTICE 'horses %, linked social identities % - roster is whole', v_horses, v_linked;
END;
$assert$;
