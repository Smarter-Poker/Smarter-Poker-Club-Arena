-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830053636; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET statement_timeout = '300s';

-- ═══════════════════════════════════════════════════════════════════════════
-- POLISH 1: the weighted rake data reaches the player
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ca_hand_facts.rake_paid has been cent-exact per human per hand since the
-- weighted migration (it uses the same canonical allocator as the money
-- pipeline), and rake_attributions holds the authoritative per-hand ledger.
-- Neither was visible to the player it describes.
--
-- CALLER'S OWN DATA ONLY. Both functions derive the subject from auth.uid()
-- and never from a parameter — a caller-supplied id is a caller-supplied
-- answer. The engine (service_role) may pass p_user for support tooling.

-- 1. Lifetime / windowed rake summary for the stats page.
CREATE OR REPLACE FUNCTION public.ca_player_rake_stats(
  p_user uuid DEFAULT NULL, p_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
  v_since timestamptz;
  v_hands bigint := 0;
  v_raked_hands bigint := 0;
  v_rake numeric := 0;
  v_bb numeric := 0;
  v_first timestamptz;
  v_last timestamptz;
BEGIN
  -- Identity from the session, never from the argument (service_role aside).
  IF public.fn_caller_is_engine() THEN
    v_uid := COALESCE(p_user, auth.uid());
  ELSE
    v_uid := auth.uid();
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('hands', 0, 'raked_hands', 0, 'rake_paid', 0,
                              'rake_per_100', 0, 'rake_in_bb', 0, 'days', p_days);
  END IF;

  v_since := CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz
                  ELSE now() - make_interval(days => GREATEST(p_days, 1)) END;

  SELECT count(*), count(*) FILTER (WHERE COALESCE(f.rake_paid, 0) > 0),
         COALESCE(SUM(f.rake_paid), 0),
         COALESCE(SUM(CASE WHEN f.big_blind > 0 THEN f.rake_paid / f.big_blind ELSE 0 END), 0),
         min(f.played_at), max(f.played_at)
    INTO v_hands, v_raked_hands, v_rake, v_bb, v_first, v_last
    FROM public.ca_hand_facts f
   WHERE f.user_id = v_uid
     AND f.played_at >= v_since
     AND f.tournament_id IS NULL;

  RETURN jsonb_build_object(
    'hands', v_hands,
    'raked_hands', v_raked_hands,
    'rake_paid', round(v_rake, 2),
    -- The industry-standard shape: rake per 100 hands played.
    'rake_per_100', CASE WHEN v_hands > 0 THEN round(v_rake * 100.0 / v_hands, 2) ELSE 0 END,
    'rake_in_bb', round(v_bb, 2),
    'bb_per_100', CASE WHEN v_hands > 0 THEN round(v_bb * 100.0 / v_hands, 2) ELSE 0 END,
    'avg_rake_per_raked_hand',
      CASE WHEN v_raked_hands > 0 THEN round(v_rake / v_raked_hands, 4) ELSE 0 END,
    'first_hand_at', v_first,
    'last_hand_at', v_last,
    'days', p_days
  );
END $function$;

REVOKE ALL ON FUNCTION public.ca_player_rake_stats(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_rake_stats(uuid, integer) TO authenticated, service_role;

-- 2. "Your rake share" for ONE hand — the replay/hand-detail line.
-- Reads the authoritative per-player ledger, and never exposes another
-- player's contribution: only the caller's own row plus hand-level totals
-- that are already public in hand history.
CREATE OR REPLACE FUNCTION public.ca_player_hand_rake_share(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rr record;
  v_ra record;
BEGIN
  IF v_uid IS NULL OR p_hand_id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT rake_amount, bbj_contribution, pot_size, rake_method, player_contributions
    INTO v_rr FROM public.rake_records WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT eligible_contribution, returned_uncalled, contribution_weight,
         weighted_rake_credit, bbj_attributed_contribution
    INTO v_ra
    FROM public.rake_attributions
   WHERE hand_id = p_hand_id AND player_id = v_uid;

  -- The player was not in this hand (or it predates the ledger).
  IF NOT FOUND THEN
    -- Ledger-free hands still answer for a player who contributed, using the
    -- canonical allocator — same fallback contract as everywhere else.
    IF v_rr.player_contributions ? v_uid::text THEN
      RETURN (
        SELECT jsonb_build_object(
          'found', true,
          'hand_id', p_hand_id,
          'rake_method', COALESCE(v_rr.rake_method, 'DEALT_EQUAL'),
          'pot_size', v_rr.pot_size,
          'hand_rake', round(v_rr.rake_amount, 2),
          'hand_bbj', round(COALESCE(v_rr.bbj_contribution, 0), 2),
          'your_contribution', round((v_rr.player_contributions->>v_uid::text)::numeric, 2),
          'your_returned_uncalled', 0,
          'your_share_pct', round(a.weight * 100, 2),
          'your_rake', round(a.credit, 2),
          'your_bbj', 0,
          'from_ledger', false)
        FROM public.fn_allocate_rake_credits(
               v_rr.rake_amount, v_rr.player_contributions,
               COALESCE(v_rr.rake_method, 'DEALT_EQUAL')) a
        WHERE a.user_id = v_uid
      );
    END IF;
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'hand_id', p_hand_id,
    'rake_method', COALESCE(v_rr.rake_method, 'DEALT_EQUAL'),
    'pot_size', v_rr.pot_size,
    'hand_rake', round(v_rr.rake_amount, 2),
    'hand_bbj', round(COALESCE(v_rr.bbj_contribution, 0), 2),
    'your_contribution', round(COALESCE(v_ra.eligible_contribution, 0), 2),
    'your_returned_uncalled', round(COALESCE(v_ra.returned_uncalled, 0), 2),
    'your_share_pct', round(COALESCE(v_ra.contribution_weight, 0) * 100, 2),
    'your_rake', round(COALESCE(v_ra.weighted_rake_credit, 0), 2),
    'your_bbj', round(COALESCE(v_ra.bbj_attributed_contribution, 0), 2),
    'from_ledger', true
  );
END $function$;

REVOKE ALL ON FUNCTION public.ca_player_hand_rake_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_player_hand_rake_share(uuid) TO authenticated, service_role;

-- Smoke: both callable, correct empty shape with no session.
DO $$
DECLARE v jsonb;
BEGIN
  v := public.ca_player_rake_stats(NULL, 30);
  IF (v->>'hands') IS NULL THEN RAISE EXCEPTION 'ca_player_rake_stats shape wrong: %', v; END IF;
  v := public.ca_player_hand_rake_share(NULL);
  IF (v->>'found') <> 'false' THEN RAISE EXCEPTION 'ca_player_hand_rake_share shape wrong: %', v; END IF;
  RAISE NOTICE 'player rake stats RPCs: shapes OK';
END $$;
