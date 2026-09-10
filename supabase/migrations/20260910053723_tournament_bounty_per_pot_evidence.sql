-- Phase 3 B02: preserve exact winning-pot identities for future hands.
-- Apply this reader before deploying the engine that writes pots[].awards.
-- No historical reconstruction, new payout rail, trigger or wallet mutation.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $preflight$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid='public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)'::regprocedure)
       IS DISTINCT FROM '193de04c64c285ba0bf0cb20bb38c28d' THEN
    RAISE EXCEPTION 'Bounty claimant authority changed; review current definition before applying';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_exact_tournament_knockout_claimants(
  p_tournament_id uuid,
  p_hand_id uuid,
  p_eliminated_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pots jsonb;
  v_winners jsonb;
  v_last_pot integer;
  v_winning_pot integer;
  v_chosen_pot_count integer;
  v_raw_winner_count integer;
  v_valid_winner_count integer;
  v_distinct_winner_count integer;
  v_chosen_eligible jsonb;
  v_chosen_pot jsonb;
  v_claimants jsonb;
BEGIN
  SELECT h.pots, h.winners INTO v_pots, v_winners
    FROM public.hand_history h
   WHERE h.id = p_hand_id;
  IF jsonb_typeof(v_pots) <> 'array' OR jsonb_array_length(v_pots) = 0
     OR jsonb_typeof(v_winners) <> 'array' OR jsonb_array_length(v_winners) = 0 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index','') !~ '^[0-9]+$'
  ) THEN
    RETURN NULL;
  END IF;

  WITH pots AS (
    SELECT CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
                THEN (p->>'index')::integer ELSE ordinality::integer - 1 END AS pot_index,
           COALESCE(p->'eligible', p->'eligiblePlayers', '[]'::jsonb) AS eligible
      FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p, ordinality)
  )
  SELECT max(pot_index) INTO v_last_pot
    FROM pots
   WHERE jsonb_typeof(eligible) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(eligible) e(user_id)
                  WHERE e.user_id = p_eliminated_user_id::text);
  IF v_last_pot IS NULL THEN RETURN NULL; END IF;

  -- A modern row that cannot name a valid winner of the exact last pot is
  -- incomplete. Do not walk down to a different pot or largest winner: that
  -- would assign money to somebody who did not own the knockout.
  v_winning_pot := v_last_pot;

  SELECT count(*)
    INTO v_chosen_pot_count
    FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p,ordinality)
   WHERE CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
              THEN (p->>'index')::integer ELSE ordinality::integer-1 END=v_winning_pot;
  IF v_chosen_pot_count<>1 THEN
    RETURN NULL;
  END IF;
  SELECT p, COALESCE(p->'eligible',p->'eligiblePlayers','[]'::jsonb)
    INTO v_chosen_pot, v_chosen_eligible
    FROM jsonb_array_elements(v_pots) WITH ORDINALITY AS q(p,ordinality)
   WHERE CASE WHEN COALESCE(p->>'index','') ~ '^[0-9]+$'
              THEN (p->>'index')::integer ELSE ordinality::integer-1 END=v_winning_pot;
  IF jsonb_typeof(v_chosen_eligible)<>'array' THEN RETURN NULL; END IF;

  -- New accepted hands preserve each actual pot/half award beside that pot.
  -- The flat winners list contains merged paid totals and only the first
  -- potIndex for a player who won several pots. Do not reconstruct from it
  -- when exact evidence is supplied, including malformed or empty evidence.
  IF v_chosen_pot ? 'awards' THEN
    v_winners := v_chosen_pot->'awards';
    IF jsonb_typeof(v_winners) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    IF jsonb_array_length(v_winners)=0 THEN RETURN NULL; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_winners) w
       WHERE COALESCE(w->>'potIndex',w->>'pot_index','') !~ '^[0-9]+$'
    ) THEN RETURN NULL; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_winners) w
       WHERE (COALESCE(w->>'potIndex',w->>'pot_index'))::numeric<>v_winning_pot
    ) THEN RETURN NULL; END IF;
  END IF;


  -- Never canonicalise corruption by filtering it away. Every winner row for
  -- the exact pot must name one distinct tournament participant who is in the
  -- pot's eligible set. A malformed outsider in a tie makes the whole money
  -- authority unavailable; it does not enlarge the valid player's share.
  WITH exact_winners AS (
    SELECT w,COALESCE(w->>'userId',w->>'user_id','') AS user_id_text
      FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index')::integer=v_winning_pot
  ), classified AS (
    SELECT user_id_text,
           user_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             AND user_id_text<>p_eliminated_user_id::text
             AND EXISTS (SELECT 1 FROM public.tournament_players tp
                          WHERE tp.tournament_id=p_tournament_id
                            AND tp.user_id=CASE
                              WHEN user_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                              THEN user_id_text::uuid ELSE NULL END)
             AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_chosen_eligible) e(user_id)
                          WHERE e.user_id=user_id_text) AS valid
      FROM exact_winners
  )
  SELECT count(*),count(*) FILTER (WHERE valid),
         count(DISTINCT user_id_text) FILTER (WHERE valid)
    INTO v_raw_winner_count,v_valid_winner_count,v_distinct_winner_count
    FROM classified;
  -- Hi-lo histories legitimately contain one row for the high half and one
  -- for the low half when the same player scoops. Validate every source row,
  -- then canonicalise to distinct claimant ids below; duplicate winner rows
  -- are not duplicate people and must not invalidate an otherwise exact pot.
  IF v_raw_winner_count=0 OR v_valid_winner_count<>v_raw_winner_count
     OR v_distinct_winner_count=0 THEN
    RETURN NULL;
  END IF;

  WITH participants AS (
    SELECT DISTINCT COALESCE(w->>'userId',w->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(v_winners) w
     WHERE COALESCE(w->>'potIndex',w->>'pot_index')::integer=v_winning_pot
  )
  SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'weight', 1)
                   ORDER BY user_id::text)
    INTO v_claimants FROM participants;
  RETURN v_claimants;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)
  TO service_role;
DO $verify$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid='public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)'::regprocedure)
       IS DISTINCT FROM '6ead779d2261848571713f0220953082' THEN
    RAISE EXCEPTION 'Bounty claimant authority postcondition failed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Bounty claimant authority execution grants changed';
  END IF;
END;
$verify$;
NOTIFY pgrst, 'reload schema';
COMMIT;