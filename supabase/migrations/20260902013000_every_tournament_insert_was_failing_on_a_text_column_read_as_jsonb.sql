-- ═══════════════════════════════════════════════════════════════════════════
--  EVERY INSERT INTO tournaments WAS FAILING. NO GAME COULD BE CREATED.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `trg_tournaments_publish_readiness` fires AFTER INSERT on every tournament
-- and calls fn_tournament_management_readiness, which contained:
--
--     jsonb_array_length(COALESCE(v_t.blind_structure,  '[]'::jsonb)) > 0
--     jsonb_array_length(COALESCE(v_t.payout_structure, '[]'::jsonb)) > 0
--
-- but `tournaments.blind_structure` and `tournaments.payout_structure` are
-- **text**, not jsonb. COALESCE(text, jsonb) is not a coercible pair, so the
-- expression raised 42804 `COALESCE types text and jsonb cannot be matched`
-- on EVERY evaluation.
--
-- The blast radius is the whole product: not one tournament of any kind -
-- Spin, heads-up, SNG or MTT - could be created. Measured on production:
--
--   * the last tournament to start did so at 20:44:53 UTC; four hours later
--     the number that had started since was ZERO;
--   * the Spin board went from 44 open boards to 0 and could not reopen;
--   * the engine logged 458 [ScheduledTournaments.insert_failed] in ninety
--     minutes and 698 seat-first fill refusals in sixty.
--
-- Reproduced deliberately by cloning a real spin row into a rolled-back
-- transaction, which is how the message and its call site were obtained rather
-- than inferred:
--   ctx = PL/pgSQL function fn_tournament_management_readiness(uuid) line 72
--         PL/pgSQL function fn_guard_tournament_publish_readiness()
--
-- THE FIX PARSES THE TEXT INSTEAD OF PRETENDING IT IS JSON. A cast alone would
-- swap one outage for another the first time a row held something unparseable,
-- so the conversion is total: anything that is not a JSON array reads as an
-- empty array, which is exactly what the readiness check means by "no
-- structure yet".
--
-- ROLLBACK:
--   Restore the two COALESCE(...) forms above -- but they are the outage.

CREATE OR REPLACE FUNCTION public.fn_safe_jsonb_array(p_text text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN '[]'::jsonb;
  END IF;
  BEGIN
    v := p_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN '[]'::jsonb;
  END;
  IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN v;
END;
$function$;

COMMENT ON FUNCTION public.fn_safe_jsonb_array(text) IS
  'Reads a text column that holds a JSON array and never raises: anything '
  'unparseable, null, empty or not an array reads as []. Written because '
  'COALESCE(text_column, ''[]''::jsonb) raised 42804 on every tournament '
  'INSERT and stopped the platform creating games for four hours.';

CREATE OR REPLACE FUNCTION public.fn_tournament_management_readiness(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t record;
  v_union uuid;
  v_enforce boolean;
  v_floor numeric;
  v_bank numeric;
  v_bank_type text;
  v_exposure numeric;
  v_required numeric;
  v_short numeric;
  v_locked boolean;
  v_complete boolean;
BEGIN
  SELECT t.id, t.club_id, t.name, t.status, t.start_time,
         t.tournament_type, t.variant,
         t.buy_in_amount, t.starting_chips, t.max_players,
         t.blind_structure, t.payout_structure,
         COALESCE(t.guaranteed_prize, 0) AS guaranteed_prize,
         COALESCE(t.prize_pool, 0) AS prize_pool
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  SELECT c.union_id, COALESCE(c.guarantee_enforcement_enabled, true),
         COALESCE(c.guarantee_treasury_floor, 0)
    INTO v_union, v_enforce, v_floor
    FROM public.clubs c
   WHERE c.id = v_t.club_id;

  IF v_union IS NOT NULL THEN
    v_bank_type := 'union';
    v_floor := 0;
    SELECT COALESCE(uw.chip_balance, 0)
      INTO v_bank
      FROM public.union_wallets uw
     WHERE uw.union_id = v_union;
    v_bank := COALESCE(v_bank, 0);
    SELECT COALESCE(sum(greatest(COALESCE(t.guaranteed_prize, 0) - COALESCE(t.prize_pool, 0), 0)), 0)
      INTO v_exposure
      FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE c.union_id = v_union
       AND t.id <> p_tournament_id
       AND COALESCE(t.prize_pool_finalized, false) = false
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  ELSE
    v_bank_type := 'club';
    SELECT COALESCE(c.chip_treasury, 0)
      INTO v_bank
      FROM public.clubs c
     WHERE c.id = v_t.club_id;
    v_bank := COALESCE(v_bank, 0);
    SELECT COALESCE(sum(greatest(COALESCE(t.guaranteed_prize, 0) - COALESCE(t.prize_pool, 0), 0)), 0)
      INTO v_exposure
      FROM public.tournaments t
     WHERE t.club_id = v_t.club_id
       AND t.id <> p_tournament_id
       AND COALESCE(t.prize_pool_finalized, false) = false
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  END IF;

  v_required := greatest(v_t.guaranteed_prize - v_t.prize_pool, 0);
  v_short := greatest(COALESCE(v_floor, 0) + COALESCE(v_exposure, 0) + v_required - v_bank, 0);
  v_locked := EXISTS (
    SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = p_tournament_id
  );
  v_complete := NULLIF(trim(COALESCE(v_t.name, '')), '') IS NOT NULL
    AND (
      v_t.start_time IS NOT NULL
      OR upper(COALESCE(v_t.tournament_type, '')) IN ('SNG', 'SPIN')
      OR lower(COALESCE(v_t.variant, '')) IN ('sng', 'spin')
    )
    AND COALESCE(v_t.starting_chips, 0) > 0
    AND COALESCE(v_t.max_players, 0) >= 2
    AND COALESCE(v_t.buy_in_amount, 0) >= 0
    -- text columns, parsed. NOT COALESCE(text, jsonb): that is 42804 on every row.
    AND jsonb_array_length(public.fn_safe_jsonb_array(v_t.blind_structure)) > 0
    AND (
      jsonb_array_length(public.fn_safe_jsonb_array(v_t.payout_structure)) > 0
      OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN'
      OR lower(COALESCE(v_t.variant, '')) = 'spin'
    );

  RETURN jsonb_build_object(
    'state', CASE
      WHEN upper(v_t.status::text) IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN 'closed'
      WHEN NOT v_complete THEN 'incomplete'
      WHEN v_enforce AND v_short > 0 THEN 'funding_blocked'
      ELSE 'ready'
    END,
    'can_start', upper(v_t.status::text) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
      AND v_complete AND (NOT v_enforce OR v_short = 0),
    'contract_locked', v_locked,
    'guarantee_enforced', v_enforce,
    'guaranteed_prize', v_t.guaranteed_prize,
    'current_prize_pool', v_t.prize_pool,
    'overlay_required', v_required,
    'bank_type', v_bank_type,
    'bank_balance', v_bank,
    'bank_floor', COALESCE(v_floor, 0),
    'other_live_exposure', COALESCE(v_exposure, 0),
    'short_by', v_short
  );
END;
$function$;

DO $$
DECLARE v_src text; v_probe jsonb; v_t uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_tournament_management_readiness';
  IF position('COALESCE(v_t.blind_structure' in v_src) > 0
     OR position('COALESCE(v_t.payout_structure' in v_src) > 0 THEN
    RAISE EXCEPTION 'the text/jsonb COALESCE is still there';
  END IF;

  -- The parser must survive the shapes a text column can actually hold.
  IF public.fn_safe_jsonb_array(NULL)        <> '[]'::jsonb THEN RAISE EXCEPTION 'null not handled'; END IF;
  IF public.fn_safe_jsonb_array('')          <> '[]'::jsonb THEN RAISE EXCEPTION 'empty not handled'; END IF;
  IF public.fn_safe_jsonb_array('not json')  <> '[]'::jsonb THEN RAISE EXCEPTION 'garbage not handled'; END IF;
  IF public.fn_safe_jsonb_array('{"a":1}')   <> '[]'::jsonb THEN RAISE EXCEPTION 'object not handled'; END IF;
  IF jsonb_array_length(public.fn_safe_jsonb_array('[{"level":1}]')) <> 1 THEN RAISE EXCEPTION 'array not parsed'; END IF;

  -- And the guard must now run clean against a real row.
  SELECT id INTO v_t FROM public.tournaments WHERE variant='spin' ORDER BY created_at DESC LIMIT 1;
  IF v_t IS NOT NULL THEN
    v_probe := public.fn_tournament_management_readiness(v_t);
    IF v_probe IS NULL THEN RAISE EXCEPTION 'readiness returned nothing for a real row'; END IF;
  END IF;
END $$;;
