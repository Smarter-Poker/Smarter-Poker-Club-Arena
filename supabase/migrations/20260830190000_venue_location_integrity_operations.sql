-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830190000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Poker Near Me phase 9: auditable, optimistic-concurrency venue corrections.

CREATE TABLE IF NOT EXISTS public.venue_location_integrity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id integer NOT NULL REFERENCES public.poker_venues(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 500),
  integrity_status text NOT NULL CHECK (integrity_status IN ('verified', 'border')),
  integrity_reason text NOT NULL,
  before_record jsonb NOT NULL,
  after_record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)
CREATE INDEX IF NOT EXISTS idx_venue_location_integrity_log_venue_created
  ON public.venue_location_integrity_log (venue_id, created_at DESC)
ALTER TABLE public.venue_location_integrity_log ENABLE ROW LEVEL SECURITY
DROP POLICY IF EXISTS venue_location_integrity_log_admin_read ON public.venue_location_integrity_log
CREATE POLICY venue_location_integrity_log_admin_read
  ON public.venue_location_integrity_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role::text IN ('admin', 'superadmin', 'god')
    )
  )
CREATE OR REPLACE FUNCTION public.resolve_venue_location_integrity(
  p_venue_id integer,
  p_expected_updated_at timestamptz,
  p_address text,
  p_city text,
  p_state text,
  p_latitude double precision,
  p_longitude double precision,
  p_reason text,
  p_actor_id uuid,
  p_integrity_status text,
  p_integrity_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before public.poker_venues%ROWTYPE;
  v_after public.poker_venues%ROWTYPE;
  v_actor_role text;
BEGIN
  SELECT p.role::text INTO v_actor_role
  FROM public.profiles p
  WHERE p.id = p_actor_id;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'superadmin', 'god') THEN
    RAISE EXCEPTION 'platform admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'expected venue revision required' USING ERRCODE = '22023';
  END IF;
  IF char_length(trim(coalesce(p_reason, ''))) < 12 OR char_length(trim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'audit reason must contain 12 to 500 characters' USING ERRCODE = '22023';
  END IF;
  IF p_integrity_status NOT IN ('verified', 'border') THEN
    RAISE EXCEPTION 'only verified or border corrections may be applied' USING ERRCODE = '22023';
  END IF;
  IF p_latitude IS NULL OR p_longitude IS NULL
     OR p_latitude < -90 OR p_latitude > 90
     OR p_longitude < -180 OR p_longitude > 180 THEN
    RAISE EXCEPTION 'coordinates outside valid range' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before
  FROM public.poker_venues
  WHERE id = p_venue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'venue not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_before.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'venue revision changed' USING ERRCODE = '40001';
  END IF;

  UPDATE public.poker_venues
  SET address = nullif(trim(p_address), ''),
      city = trim(p_city),
      state = upper(trim(p_state)),
      latitude = p_latitude,
      longitude = p_longitude,
      lat = p_latitude,
      lng = p_longitude,
      updated_at = now()
  WHERE id = p_venue_id
  RETURNING * INTO v_after;

  INSERT INTO public.venue_location_integrity_log (
    venue_id,
    actor_id,
    reason,
    integrity_status,
    integrity_reason,
    before_record,
    after_record
  ) VALUES (
    p_venue_id,
    p_actor_id,
    trim(p_reason),
    p_integrity_status,
    p_integrity_reason,
    jsonb_build_object(
      'address', v_before.address,
      'city', v_before.city,
      'state', v_before.state,
      'latitude', coalesce(v_before.latitude, v_before.lat),
      'longitude', coalesce(v_before.longitude, v_before.lng),
      'updated_at', v_before.updated_at
    ),
    jsonb_build_object(
      'address', v_after.address,
      'city', v_after.city,
      'state', v_after.state,
      'latitude', coalesce(v_after.latitude, v_after.lat),
      'longitude', coalesce(v_after.longitude, v_after.lng),
      'updated_at', v_after.updated_at
    )
  );

  RETURN jsonb_build_object(
    'venue_id', v_after.id,
    'name', v_after.name,
    'updated_at', v_after.updated_at,
    'integrity_status', p_integrity_status
  );
END;
$$
REVOKE ALL ON FUNCTION public.resolve_venue_location_integrity(
  integer, timestamptz, text, text, text, double precision, double precision,
  text, uuid, text, text
) FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.resolve_venue_location_integrity(
  integer, timestamptz, text, text, text, double precision, double precision,
  text, uuid, text, text
) TO service_role
COMMENT ON TABLE public.venue_location_integrity_log IS
  'Immutable audit trail for operator-approved Poker Near Me location corrections.'
COMMENT ON FUNCTION public.resolve_venue_location_integrity IS
  'Atomically corrects venue coordinates with admin-role validation, optimistic concurrency, and before/after audit evidence.'
