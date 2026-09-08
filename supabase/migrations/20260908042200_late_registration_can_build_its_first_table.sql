-- LATE REGISTRATION CAN BUILD ITS FIRST TABLE.
--
-- Capacity used to clone a currently live sibling. When a RUNNING tournament
-- had zero live tables, the paid registration transaction could neither seat
-- the entrant nor create the table whose absence caused the failure. The
-- manager's fallback also understood only level-based late registration, so a
-- minutes-only event had no second path.
--
-- One SQL predicate is now the authority for the entry window and one SQL
-- primitive is the authority for capacity. Capacity is derived from the
-- tournament contract itself at its current blind level; it does not need a
-- live or historical table. The registration wrapper installed by
-- 20260908042000 reserves its not-yet-inserted entrant through that primitive
-- inside the same outer transaction as debit, roster insertion and seating.
-- The manager calls the SAME primitive with no reservation. Both calls take
-- the tournament row lock and re-count demand and capacity after waiting, so
-- two engine processes, or an engine and a registration, can never create the
-- same expansion independently.

BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.fn_tournament_late_registration_open(
  p_tournament_id uuid
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT t.status='RUNNING'
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND (
         CASE
           WHEN COALESCE(t.late_reg_levels,t.rebuy_levels,0)>0
             THEN COALESCE(t.current_level,0)<COALESCE(t.late_reg_levels,t.rebuy_levels,0)
           WHEN COALESCE(t.late_reg_mins,0)>0
             THEN t.started_at IS NOT NULL
              AND clock_timestamp()<t.started_at+make_interval(mins=>t.late_reg_mins)
           ELSE false
         END
       )
       AND (
         t.max_players IS NULL OR (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id=t.id
         )<t.max_players
       )
      FROM public.tournaments t
     WHERE t.id=p_tournament_id
  ),false);
$function$;

-- Resolve the blind level from durable tournament state. This is the database
-- counterpart of TournamentManagerBase.resolveBlindLevel: persisted rows are
-- read verbatim, Spins continue their 1.4x/ten-chip ladder, and ordinary MTTs
-- continue at the observed late-ladder cadence (1.15x..1.6x) from the last
-- playable row. The result is restart-safe because the exponent is anchored to
-- the persisted array length, never to an in-memory array that grows.
CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_blinds(
  p_blind_structure text,
  p_current_level integer,
  p_variant text,
  p_tournament_type text,
  p_total_chips numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_levels jsonb;
  v_len integer;
  v_index integer;
  v_level jsonb;
  v_last_index integer;
  v_last jsonb;
  v_is_spin boolean;
  v_tail_count integer;
  v_tail_first numeric;
  v_tail_last numeric;
  v_ratio numeric := 1.4;
  v_factor numeric;
  v_sb numeric;
  v_bb numeric;
  v_ante numeric;
  v_max_bb numeric;
  v_scale numeric;
  v_capped boolean := false;
BEGIN
  v_levels := public.fn_safe_jsonb_array(p_blind_structure);
  v_len := jsonb_array_length(v_levels);
  IF v_len=0 THEN
    RAISE EXCEPTION 'Tournament blind structure is missing' USING ERRCODE='55000';
  END IF;
  v_index := GREATEST(COALESCE(p_current_level,0),0);

  -- A persisted level is authoritative and is never chip-capped in the engine.
  IF v_index<v_len THEN
    v_level := v_levels->v_index;
    v_sb := COALESCE(
      CASE WHEN COALESCE(v_level->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'smallBlind')::numeric END,
      CASE WHEN COALESCE(v_level->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'small_blind')::numeric END
    );
    v_bb := COALESCE(
      CASE WHEN COALESCE(v_level->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'bigBlind')::numeric END,
      CASE WHEN COALESCE(v_level->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'big_blind')::numeric END
    );
    v_ante := COALESCE(
      CASE WHEN COALESCE(v_level->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'ante')::numeric END,
      0
    );
    RETURN jsonb_build_object(
      'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
      'level_index',v_index,'source','persisted','blind_capped',false
    );
  END IF;

  v_is_spin := lower(COALESCE(p_variant,''))='spin'
            OR upper(COALESCE(p_tournament_type,''))='SPIN';
  IF v_is_spin THEN
    -- spinBlindsForLevel(index+1), including canonical values when a legacy
    -- persisted array is shorter than today's ten-row Spin ladder.
    v_bb := CASE v_index
      WHEN 0 THEN 20 WHEN 1 THEN 30 WHEN 2 THEN 40 WHEN 3 THEN 60
      WHEN 4 THEN 80 WHEN 5 THEN 100 WHEN 6 THEN 120 WHEN 7 THEN 150
      WHEN 8 THEN 180 WHEN 9 THEN 210
      ELSE round((210::numeric*power(1.4::numeric,v_index-9))/10)*10
    END;
    v_sb := round(v_bb/2);
    RETURN jsonb_build_object(
      'small_blind',v_sb,'big_blind',v_bb,'ante',0,
      'level_index',v_index,'source','spin_overflow','blind_capped',false
    );
  END IF;

  -- Ignore trailing break rows when choosing the overflow anchor.
  v_last_index := v_len-1;
  WHILE v_last_index>0
    AND lower(COALESCE(v_levels->v_last_index->>'isBreak','false'))='true'
  LOOP
    v_last_index := v_last_index-1;
  END LOOP;
  v_last := v_levels->v_last_index;

  -- Geometric mean of the last five positive advertised big-blind steps.
  WITH clean AS (
    SELECT e.ordinality::integer AS ord,
           COALESCE(
             CASE WHEN COALESCE(e.value->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (e.value->>'bigBlind')::numeric END,
             CASE WHEN COALESCE(e.value->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (e.value->>'big_blind')::numeric END
           ) AS bb
      FROM jsonb_array_elements(v_levels) WITH ORDINALITY AS e(value,ordinality)
  ), tail AS (
    SELECT ord,bb FROM clean WHERE bb>0 ORDER BY ord DESC LIMIT 5
  )
  SELECT count(*)::integer,
         (array_agg(bb ORDER BY ord))[1],
         (array_agg(bb ORDER BY ord DESC))[1]
    INTO v_tail_count,v_tail_first,v_tail_last
    FROM tail;
  IF v_tail_count>=2 AND v_tail_first>0 AND v_tail_last>v_tail_first THEN
    v_ratio := power(v_tail_last/v_tail_first,1::numeric/(v_tail_count-1));
    IF v_ratio<=1 THEN v_ratio := 1.4; END IF;
  END IF;
  v_ratio := LEAST(1.6,GREATEST(1.15,v_ratio));
  v_factor := power(
    v_ratio,
    LEAST(GREATEST(1,v_index-v_len+1),40)
  );

  v_sb := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'smallBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'small_blind')::numeric END,
    0
  )*v_factor,10000000);
  v_bb := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'bigBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'big_blind')::numeric END,
    0
  )*v_factor,10000000);
  v_ante := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'ante')::numeric END,
    0
  )*v_factor,10000000);

  -- Match capLevelToTournamentChips for generic overflow. The database wrapper
  -- supplies the exact durable chip issuance total; NULL means cap nothing.
  IF p_total_chips>0 THEN
    v_max_bb := p_total_chips/20;
    IF v_bb>v_max_bb AND v_max_bb>=2 THEN
      v_scale := v_max_bb/v_bb;
      v_bb := GREATEST(2,floor(v_bb*v_scale));
      v_sb := GREATEST(1,floor(v_sb*v_scale));
      v_ante := CASE WHEN v_ante>0 THEN GREATEST(1,floor(v_ante*v_scale)) ELSE 0 END;
      v_capped := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
    'level_index',v_index,'source','mtt_overflow',
    'overflow_ratio',v_ratio,'blind_capped',v_capped
  );
END;
$function$;

-- Bind the pure resolver to the tournament row and the same durable issuance
-- sources refreshChipCapInputs reads in the engine.
CREATE OR REPLACE FUNCTION public.fn_tournament_current_blinds(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_entrants bigint;
  v_rebuys bigint;
  v_addons bigint;
  v_total_chips numeric := NULL;
BEGIN
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;

  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_rebuys
    FROM public.wallet_transactions wt
   WHERE wt.related_entity_id=p_tournament_id AND wt.category='rebuy';
  SELECT count(*) INTO v_addons
    FROM public.wallet_transactions wt
   WHERE wt.related_entity_id=p_tournament_id AND wt.category='addon';
  IF COALESCE(v_t.starting_chips,0)>0 AND v_entrants>0 THEN
    v_total_chips := v_t.starting_chips*v_entrants
      +COALESCE(NULLIF(v_t.rebuy_chips,0),v_t.starting_chips)*v_rebuys
      +COALESCE(NULLIF(v_t.addon_chips,0),v_t.starting_chips)*v_addons;
  END IF;

  RETURN public.fn_resolve_tournament_blinds(
    v_t.blind_structure::text,
    COALESCE(v_t.current_level,0),
    v_t.variant,
    v_t.tournament_type,
    v_total_chips
  );
END;
$function$;

-- Closing entry is a durable workflow, not a boolean written on a tournament.
-- The funded pool can commit while the engine response is lost; this receipt
-- keeps the causal manager wake alive until every already-eliminated player's
-- recorded prize has been repriced against the final field and pool.
CREATE TABLE IF NOT EXISTS public.tournament_entry_close_receipts (
  tournament_id uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  close_mode text NOT NULL
    CHECK (close_mode IN ('levels','minutes','immediate','addon')),
  entry_closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  final_prize_pool numeric NOT NULL CHECK (final_prize_pool>=0),
  payout_structure_snapshot jsonb NOT NULL,
  manager_wake_id bigint,
  reprice_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_tournament_entry_close_receipts_pending
  ON public.tournament_entry_close_receipts(entry_closed_at,tournament_id)
  WHERE reprice_completed_at IS NULL;
ALTER TABLE public.tournament_entry_close_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_entry_close_receipts
  FROM PUBLIC,anon,authenticated,service_role;

-- Exact decimal counterpart of computePlacePrize. The last paid place takes
-- the residual after earlier rounded shares, so the ladder spends the pool to
-- the cent and the completion receipt proves the same arithmetic the engine
-- uses. This function is deliberately private to database-owned workflows.
CREATE OR REPLACE FUNCTION public.fn_tournament_place_prize_exact(
  p_pool numeric,
  p_structure text,
  p_place integer
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_arr jsonb := public.fn_safe_jsonb_array(p_structure);
  v_pool_cents numeric := GREATEST(round(COALESCE(p_pool,0)*100),0);
  v_total_bp numeric;
  v_last_place integer;
  v_remaining numeric;
  v_share numeric;
  r record;
BEGIN
  IF p_place IS NULL OR v_pool_cents<=0 OR jsonb_array_length(v_arr)=0 THEN
    RETURN 0;
  END IF;

  WITH numbered AS (
    SELECT e.value,e.ordinality,
           CASE WHEN COALESCE(e.value->>'place','') ~ '^[0-9]+$'
                THEN (e.value->>'place')::integer END AS place,
           CASE WHEN COALESCE(e.value->>'percentage','') ~ '^[0-9]+([.][0-9]+)?$'
                THEN GREATEST((e.value->>'percentage')::numeric,0) ELSE 0 END AS pct
      FROM jsonb_array_elements(v_arr) WITH ORDINALITY e(value,ordinality)
  ), clean AS (
    SELECT DISTINCT ON (place) place,round(pct*100) AS bp
      FROM numbered
     WHERE place>0
     ORDER BY place,ordinality
  )
  SELECT COALESCE(sum(bp),0),max(place)
    INTO v_total_bp,v_last_place
    FROM clean;
  IF v_total_bp<=0 OR v_last_place IS NULL THEN RETURN 0; END IF;

  v_remaining := v_pool_cents;
  FOR r IN
    WITH numbered AS (
      SELECT e.value,e.ordinality,
             CASE WHEN COALESCE(e.value->>'place','') ~ '^[0-9]+$'
                  THEN (e.value->>'place')::integer END AS place,
             CASE WHEN COALESCE(e.value->>'percentage','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN GREATEST((e.value->>'percentage')::numeric,0) ELSE 0 END AS pct
        FROM jsonb_array_elements(v_arr) WITH ORDINALITY e(value,ordinality)
    )
    SELECT DISTINCT ON (place) place,round(pct*100) AS bp
      FROM numbered
     WHERE place>0
     ORDER BY place,ordinality
  LOOP
    IF r.place=v_last_place THEN
      v_share := GREATEST(v_remaining,0);
    ELSE
      v_share := GREATEST(
        LEAST(v_remaining,round(v_pool_cents*r.bp/v_total_bp)),0);
    END IF;
    v_remaining := v_remaining-v_share;
    IF r.place=p_place THEN RETURN v_share/100; END IF;
  END LOOP;
  RETURN 0;
END;
$function$;

-- Internal finalizer. Callers own the same tournament row lock before they
-- enter, and this function takes it again defensively. It fits the payout
-- ladder to the final field before funding the guarantee, persists a receipt,
-- and emits the existing durable late-registration wake in the SAME commit.
-- No service or browser role may call this door directly.
CREATE OR REPLACE FUNCTION public.fn_finalize_tournament_entry_pool_locked(
  p_tournament_id uuid,
  p_source text,
  p_close_mode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_entry_close_receipts%ROWTYPE;
  v_result jsonb;
  v_field integer;
  v_structure jsonb;
  v_wake_id bigint;
  v_pool numeric;
  v_is_satellite boolean;
BEGIN
  IF p_close_mode NOT IN ('levels','minutes','immediate','addon') THEN
    RAISE EXCEPTION 'Invalid tournament entry close mode' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_found');
  END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_running','status',v_t.status);
  END IF;

  SELECT * INTO v_receipt
    FROM public.tournament_entry_close_receipts r
   WHERE r.tournament_id=p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    -- A DB-first/old-engine window may have consumed the first wake without
    -- understanding this receipt. Re-emit only when no unconsumed row remains;
    -- never increment the generation a current sweep is already processing.
    IF v_receipt.reprice_completed_at IS NULL
       AND (v_receipt.manager_wake_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.tournament_manager_wakes w
          WHERE w.id=v_receipt.manager_wake_id AND w.consumed_at IS NULL
       )) THEN
      v_wake_id := public.fn_emit_tournament_manager_wake(
        p_tournament_id,'late_registration');
      UPDATE public.tournament_entry_close_receipts
         SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
       WHERE tournament_id=p_tournament_id
       RETURNING * INTO v_receipt;
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'entry_closed',true,'finalized',true,
      'already_finalized',true,'close_mode',v_receipt.close_mode,
      'prize_pool',v_receipt.final_prize_pool,
      'payout_structure',v_receipt.payout_structure_snapshot,
      'reprice_pending',v_receipt.reprice_completed_at IS NULL,
      'retry_after_ms',NULL
    );
  END IF;

  SELECT count(*)::integer INTO v_field
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  IF v_field<1 THEN
    RAISE EXCEPTION 'Entry cannot close without a readable final field'
      USING ERRCODE='55000';
  END IF;

  v_is_satellite := lower(COALESCE(v_t.variant,''))='satellite'
                 OR upper(COALESCE(v_t.tournament_type,''))='SATELLITE'
                 OR v_t.satellite_target_id IS NOT NULL;

  -- Spins own the wheel-derived structure. Every other format uses the
  -- database's canonical payout-percent generator for the final field. This
  -- includes satellites: their finish path awards seats rather than cash, but
  -- hand-for-hand and display readers still require the stored field ladder.
  IF lower(COALESCE(v_t.variant,''))<>'spin'
     AND upper(COALESCE(v_t.tournament_type,''))<>'SPIN' THEN
    v_structure := public.fn_ca_payout_structure(
      v_field,COALESCE(v_t.payout_percent,10));
    IF jsonb_array_length(v_structure)=0 THEN
      RAISE EXCEPTION 'Final payout structure is unreadable' USING ERRCODE='55000';
    END IF;
    UPDATE public.tournaments
       SET payout_structure=v_structure::text
     WHERE id=p_tournament_id;
  ELSE
    v_structure := public.fn_safe_jsonb_array(v_t.payout_structure::text);
    IF jsonb_array_length(v_structure)=0 THEN
      RAISE EXCEPTION 'Spin payout structure is unreadable' USING ERRCODE='55000';
    END IF;
  END IF;

  IF COALESCE(v_t.prize_pool_finalized,false) THEN
    v_result := jsonb_build_object(
      'ok',true,'already_finalized',true,'prize_pool',COALESCE(v_t.prize_pool,0));
  ELSE
    v_result := public.fn_apply_prize_guarantee(
      p_tournament_id,COALESCE(NULLIF(btrim(p_source),''),'engine.entry_window_close'));
  END IF;
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR v_result->>'prize_pool' IS NULL THEN
    RAISE EXCEPTION 'Entry close could not fund/finalize its prize pool: %',
      COALESCE(v_result->>'reason','unreadable result') USING ERRCODE='55000';
  END IF;
  v_pool := (v_result->>'prize_pool')::numeric;

  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id;
  IF COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR round(COALESCE(v_t.prize_pool,0),2)<>round(v_pool,2) THEN
    RAISE EXCEPTION 'Entry close returned without an exact funded pool marker'
      USING ERRCODE='55000';
  END IF;

  -- Satellites keep the canonical field ladder for readers, but never cash-
  -- reprice eliminated finishers from it. Their immutable seat-or-cash plus
  -- remainder entitlements are materialized by the atomic satellite contract
  -- from this final funded pool; marking generic reprice complete prevents a
  -- manager from paying the display ladder as cash first.
  INSERT INTO public.tournament_entry_close_receipts(
    tournament_id,close_mode,entry_closed_at,final_prize_pool,
    payout_structure_snapshot,reprice_completed_at
  ) VALUES (
    p_tournament_id,p_close_mode,clock_timestamp(),v_pool,
    v_structure,CASE WHEN v_is_satellite THEN clock_timestamp() ELSE NULL END
  )
  RETURNING * INTO v_receipt;
  v_wake_id := public.fn_emit_tournament_manager_wake(
    p_tournament_id,'late_registration');
  UPDATE public.tournament_entry_close_receipts
     SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
   WHERE tournament_id=p_tournament_id;

  RETURN v_result || jsonb_build_object(
    'ok',true,'entry_closed',true,'finalized',true,
    'close_mode',p_close_mode,'payout_structure',v_structure,
    'reprice_pending',NOT v_is_satellite,'retry_after_ms',NULL
  );
END;
$function$;

-- One authoritative close-window decision for start, resume and level change.
-- Level caps keep precedence over minute caps, exactly like the registration
-- gate. A minute window returns ONLY a DB-relative delay; the engine never
-- compares a database timestamp with its own wall clock.
CREATE OR REPLACE FUNCTION public.fn_close_tournament_entry_window(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.entry_window_close'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_deadline timestamptz;
  v_retry_ms bigint;
  v_mode text;
BEGIN
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_running','status',v_t.status);
  END IF;

  IF COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)>0 THEN
    v_mode := 'levels';
    IF COALESCE(v_t.current_level,0)<COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)
       AND NOT COALESCE(v_t.prize_pool_finalized,false) THEN
      RETURN jsonb_build_object(
        'ok',true,'entry_closed',false,'window_mode',v_mode,
        'retry_after_ms',NULL);
    END IF;
  ELSIF COALESCE(v_t.late_reg_mins,0)>0 THEN
    v_mode := 'minutes';
    IF v_t.started_at IS NULL THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','started_at_required_for_minutes_window',
        'window_mode',v_mode);
    END IF;
    v_deadline := v_t.started_at+make_interval(mins=>v_t.late_reg_mins);
    IF clock_timestamp()<v_deadline
       AND NOT COALESCE(v_t.prize_pool_finalized,false) THEN
      v_retry_ms := GREATEST(
        ceil(extract(epoch FROM (v_deadline-clock_timestamp()))*1000),0)::bigint;
      RETURN jsonb_build_object(
        'ok',true,'entry_closed',false,'window_mode',v_mode,
        'retry_after_ms',v_retry_ms);
    END IF;
  ELSE
    v_mode := 'immediate';
  END IF;

  -- Add-on chips can still change the final pool. Close entry now, but let the
  -- persisted add-on deadline own finalization and its receipt.
  IF COALESCE(v_t.add_on_available,false)
     AND NOT COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object(
      'ok',true,'entry_closed',true,'window_mode',v_mode,
      'finalized',false,'finalization_deferred',true,
      'reason','addon_required','retry_after_ms',NULL);
  END IF;

  RETURN public.fn_finalize_tournament_entry_pool_locked(
    p_tournament_id,p_source,v_mode);
END;
$function$;

-- The add-on close shares the final field/guarantee/receipt authority above.
-- Replacing the earlier function here preserves its one persisted deadline
-- while making a response loss after the funded close recoverable.
CREATE OR REPLACE FUNCTION public.fn_close_tournament_addon_period(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.addon_period_end'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  IF v_t.addon_period_started_at IS NULL OR v_t.addon_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','addon_period_not_started');
  END IF;
  IF clock_timestamp()<v_t.addon_period_ends_at
     AND NOT COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','addon_period_open','ends_at',v_t.addon_period_ends_at);
  END IF;

  v_result := public.fn_finalize_tournament_entry_pool_locked(
    p_tournament_id,p_source,'addon');
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Add-on close could not fund/finalize its prize pool: %',
      COALESCE(v_result->>'reason','unknown') USING ERRCODE='55000';
  END IF;
  RETURN v_result || jsonb_build_object(
    'closed',true,'ends_at',v_t.addon_period_ends_at);
END;
$function$;

-- Mark the durable close receipt complete only after the database itself can
-- prove every eliminated row equals the exact final-field entitlement. A
-- service response saying "done" is insufficient evidence on its own.
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_entry_reprice(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_receipt public.tournament_entry_close_receipts%ROWTYPE;
  v_mismatch integer;
BEGIN
  -- Match the lock order used by close/finalize and the satellite entitlement
  -- workflow: tournament first, then its child receipt. Taking these in the
  -- opposite order lets a close replay (tournament -> receipt) deadlock a
  -- completion attempt (receipt -> tournament) exactly when recovery is trying
  -- to prove the durable obligation complete.
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;

  SELECT * INTO v_receipt
    FROM public.tournament_entry_close_receipts r
   WHERE r.tournament_id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','receipt_missing'); END IF;
  IF v_receipt.reprice_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'already_completed',true,'mismatches',0);
  END IF;
  IF COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR round(COALESCE(v_t.prize_pool,0),2)<>round(v_receipt.final_prize_pool,2)
     OR public.fn_safe_jsonb_array(v_t.payout_structure::text)
        IS DISTINCT FROM v_receipt.payout_structure_snapshot THEN
    RETURN jsonb_build_object('ok',false,'reason','final_pool_or_structure_drifted');
  END IF;

  SELECT count(*)::integer INTO v_mismatch
    FROM public.tournament_players tp
    CROSS JOIN LATERAL (
      SELECT public.fn_tournament_place_prize_exact(
        v_receipt.final_prize_pool,
        v_receipt.payout_structure_snapshot::text,
        tp.position) AS expected
    ) entitlement
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status='eliminated'
     AND (
       -- An eliminated row without its finishing place is unfinished causal
       -- work, not a zero-dollar entitlement. Letting it disappear from this
       -- proof would retire the close receipt before any later process can
       -- know which place must be repriced.
       tp.position IS NULL
       OR round(COALESCE(tp.prize,0),2) IS DISTINCT FROM round(entitlement.expected,2)
       OR (
         entitlement.expected>0
         AND (
           SELECT round(COALESCE(sum(p.amount),0),2)
             FROM public.tournament_payouts p
            WHERE p.tournament_id=p_tournament_id
              AND p.user_id=tp.user_id
              AND p.position=tp.position
              AND COALESCE(p.source,'')<>'satellite_seat'
         ) IS DISTINCT FROM round(entitlement.expected,2)
       )
     );
  IF v_mismatch>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','reprice_incomplete','mismatches',v_mismatch);
  END IF;

  UPDATE public.tournament_entry_close_receipts
     SET reprice_completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE tournament_id=p_tournament_id;
  RETURN jsonb_build_object('ok',true,'completed',true,'mismatches',0);
END;
$function$;

-- A table created inside the registration transaction cannot be handed to the
-- in-memory manager by that transaction's HTTP response. Keep that hand-off
-- durable: creation, receipt and manager wake commit together, and only the
-- manager that has admitted the table engine may acknowledge the receipt.
CREATE TABLE IF NOT EXISTS public.tournament_capacity_table_receipts (
  table_id uuid PRIMARY KEY
    REFERENCES public.tables(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL
    REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  manager_wake_id bigint NOT NULL
    REFERENCES public.tournament_manager_wakes(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  manager_admitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_tournament_capacity_table_receipts_pending
  ON public.tournament_capacity_table_receipts(tournament_id,created_at,table_id)
  WHERE manager_admitted_at IS NULL;
ALTER TABLE public.tournament_capacity_table_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_capacity_table_receipts
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ensure_late_registration_capacity(
  p_tournament_id uuid,
  p_reserved_entries integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_table_id uuid;
  v_table_number integer;
  v_level jsonb;
  v_variant text;
  v_format text;
  v_cap integer;
  v_sb numeric;
  v_bb numeric;
  v_ante numeric;
  v_active_entries bigint;
  v_live_capacity bigint;
  v_occupied_seats bigint;
  v_open_seats bigint;
  v_unseated_entries bigint;
  v_required_open_seats bigint;
  v_pending_table_ids jsonb := '[]'::jsonb;
  v_pending_table_count bigint := 0;
  v_wake_id bigint;
BEGIN
  IF p_reserved_entries NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'Capacity reservation must be zero or one'
      USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object(
      'ok',true,'created',false,'reason','tournament_not_running');
  END IF;
  -- Only a new reservation needs an open entry window. An already accepted
  -- `registered`/`playing` entrant remains owed a seat after the clock or
  -- field cap closes; p_reserved_entries=0 lets the manager satisfy that
  -- durable demand without reopening registration.
  IF p_reserved_entries>0
     AND NOT public.fn_tournament_late_registration_open(p_tournament_id) THEN
    RETURN jsonb_build_object(
      'ok',true,'created',false,'reason','entry_window_closed');
  END IF;

  v_variant := lower(COALESCE(NULLIF(v_t.game_type,''),'nlh'));
  v_format := lower(COALESCE(v_t.variant,''));
  v_cap := CASE
    WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'
      -- createTablesAndSeatPlayers and the Spin contract both own a
      -- three-handed table. `tournaments.max_players` is the field cap, not a
      -- second per-table Spin setting, so letting a stale value of 1 or 2
      -- shrink only an expansion table would split one event across two
      -- incompatible table contracts.
      THEN 3
    WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'
      THEN LEAST(COALESCE(NULLIF(v_t.max_players,0),6),9)
    ELSE LEAST(COALESCE(NULLIF(v_t.table_size,0),9),10)
  END;
  -- Tournament tables need one board only. This mirrors VariantRules.maxSeatsFor:
  -- floor((deck - 5 board cards) / hole cards), then the product's 10-seat cap.
  v_cap := LEAST(v_cap,CASE v_variant
    WHEN 'plo5' THEN 9
    WHEN 'plo6' THEN 7
    ELSE 10
  END);
  v_cap := GREATEST(v_cap,2);

  -- This is the re-check that closes the race. `registered` is included
  -- because a paid entrant is real demand before the manager promotes them to
  -- `playing`; registration itself contributes one reservation because its
  -- failed first attempt was rolled back before it reached this function.
  SELECT count(*) INTO v_active_entries
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status IN ('registered','playing');

  -- Sum the legal chairs AND the rows currently occupying those chairs. A
  -- nominal nine-seat table is not nine seats of usable capacity when a stale
  -- eliminated/closed-generation row still physically owns one of them. The
  -- old table-count multiplication could therefore strand a paid entrant
  -- forever while insisting capacity was sufficient.
  WITH live_tables AS (
    SELECT tb.id,
           LEAST(v_cap,GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_cap)))
             AS capacity
      FROM public.tables tb
     WHERE tb.tournament_id=p_tournament_id
       AND tb.status IN ('running','waiting','active')
       AND COALESCE(tb.is_deleted,false)=false
  ), occupancy AS (
    SELECT lt.id,lt.capacity,
           count(s.id) FILTER (
             WHERE s.seat_number BETWEEN 1 AND lt.capacity
           ) AS occupied
      FROM live_tables lt
      LEFT JOIN public.table_seats s
        ON s.table_id=lt.id AND s.left_at IS NULL
     GROUP BY lt.id,lt.capacity
  )
  SELECT COALESCE(sum(o.capacity),0),COALESCE(sum(o.occupied),0)
    INTO v_live_capacity,v_occupied_seats
    FROM occupancy o;
  v_open_seats := GREATEST(v_live_capacity-v_occupied_seats,0);

  -- Demand means an accepted active entry that does not already own a usable
  -- live chair. Count by entrant, not by seat row, so a duplicate-seat defect
  -- cannot make the field look larger and trigger another duplicate table.
  SELECT count(*) INTO v_unseated_entries
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status IN ('registered','playing')
     AND NOT EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND tb.status IN ('running','waiting','active')
          AND COALESCE(tb.is_deleted,false)=false
          AND s.user_id=tp.user_id
          AND s.left_at IS NULL
          AND s.seat_number BETWEEN 1 AND
              LEAST(v_cap,GREATEST(2,COALESCE(NULLIF(tb.max_players,0),v_cap)))
     );
  v_required_open_seats := v_unseated_entries+p_reserved_entries;

  IF v_required_open_seats<=v_open_seats THEN
    -- If an older manager consumed the wake but crashed before admitting the
    -- table, recreate the level-triggered signal. Never increment a wake that
    -- is still pending: its exact generation already represents this work.
    IF EXISTS (
      SELECT 1 FROM public.tournament_capacity_table_receipts r
       WHERE r.tournament_id=p_tournament_id AND r.manager_admitted_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM public.tournament_manager_wakes w
       WHERE w.tournament_id=p_tournament_id
         AND w.reason='late_registration' AND w.consumed_at IS NULL
    ) THEN
      v_wake_id := public.fn_emit_tournament_manager_wake(
        p_tournament_id,'late_registration');
      UPDATE public.tournament_capacity_table_receipts
         SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
       WHERE tournament_id=p_tournament_id AND manager_admitted_at IS NULL;
    END IF;
    SELECT COALESCE(jsonb_agg(p.table_id ORDER BY p.created_at,p.table_id),'[]'::jsonb),
           COALESCE(max(p.pending_count),0)
      INTO v_pending_table_ids,v_pending_table_count
      FROM (
        SELECT r.table_id,r.created_at,count(*) OVER () AS pending_count
          FROM public.tournament_capacity_table_receipts r
         WHERE r.tournament_id=p_tournament_id AND r.manager_admitted_at IS NULL
         ORDER BY r.created_at,r.table_id
         LIMIT 20
      ) p;
    RETURN jsonb_build_object(
      'ok',true,
      'created',false,
      'reason','capacity_sufficient',
      'active_entries',v_active_entries,
      'unseated_entries',v_unseated_entries,
      'reserved_entries',p_reserved_entries,
      'live_capacity',v_live_capacity,
      'occupied_seats',v_occupied_seats,
      'open_seats',v_open_seats,
      'pending_table_ids',v_pending_table_ids,
      'pending_table_count',v_pending_table_count,
      'remaining_deficit',0
    );
  END IF;

  v_level := public.fn_tournament_current_blinds(p_tournament_id);
  v_sb := (v_level->>'small_blind')::numeric;
  v_bb := (v_level->>'big_blind')::numeric;
  v_ante := (v_level->>'ante')::numeric;
  IF v_sb IS NULL OR v_bb IS NULL OR v_sb<0 OR v_bb<=0 OR v_ante<0 OR v_sb>=v_bb THEN
    RAISE EXCEPTION 'Tournament current blind level is invalid' USING ERRCODE='55000';
  END IF;

  SELECT count(*)+1 INTO v_table_number
    FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  INSERT INTO public.tables(
    club_id,tournament_id,name,game_type,game_variant,stakes,
    small_blind,big_blind,ante,min_buy_in,max_buy_in,max_players,
    current_players,status,action_time_seconds,
    big_blind_ante_enabled,all_in_or_fold,allow_rabbit_hunt
  ) VALUES (
    v_t.club_id,p_tournament_id,
    COALESCE(v_t.name,'Tournament')||' - Table '||v_table_number,
    'tournament',v_variant,v_sb::text||'/'||v_bb::text,
    v_sb,v_bb,v_ante,0,0,v_cap,0,'running',
    LEAST(120,GREATEST(10,COALESCE(v_t.action_time_seconds,15))),
    COALESCE(v_t.big_blind_ante,false),COALESCE(v_t.all_in_or_fold,false),
    COALESCE(v_t.allow_rabbit_hunt,true)
  ) RETURNING id INTO v_table_id;
  -- The manager wake is emitted before the receipt, but both are inside this
  -- transaction. Any failure below rolls the table and wake back together.
  v_wake_id := public.fn_emit_tournament_manager_wake(
    p_tournament_id,'late_registration');
  INSERT INTO public.tournament_capacity_table_receipts(
    table_id,tournament_id,manager_wake_id
  ) VALUES (v_table_id,p_tournament_id,v_wake_id);
  -- All still-unadmitted tables are now represented by the newest generation
  -- of the one level-triggered wake for this tournament/reason.
  UPDATE public.tournament_capacity_table_receipts
     SET manager_wake_id=v_wake_id,updated_at=clock_timestamp()
   WHERE tournament_id=p_tournament_id AND manager_admitted_at IS NULL;
  SELECT COALESCE(jsonb_agg(
           p.table_id ORDER BY p.current_created DESC,p.created_at,p.table_id
         ),'[]'::jsonb),
         COALESCE(max(p.pending_count),0)
    INTO v_pending_table_ids,v_pending_table_count
    FROM (
      SELECT r.table_id,r.created_at,r.table_id=v_table_id AS current_created,
             count(*) OVER () AS pending_count
        FROM public.tournament_capacity_table_receipts r
       WHERE r.tournament_id=p_tournament_id AND r.manager_admitted_at IS NULL
       ORDER BY (r.table_id=v_table_id) DESC,r.created_at,r.table_id
       LIMIT 20
    ) p;
  RETURN jsonb_build_object(
    'ok',true,
    'created',true,
    'table_id',v_table_id,
    'table_number',v_table_number,
    'table_capacity',v_cap,
    'active_entries',v_active_entries,
    'unseated_entries',v_unseated_entries,
    'reserved_entries',p_reserved_entries,
    'live_capacity_before',v_live_capacity,
    'live_capacity_after',v_live_capacity+v_cap,
    'occupied_seats',v_occupied_seats,
    'open_seats_before',v_open_seats,
    'open_seats_after',v_open_seats+v_cap,
    'pending_table_ids',v_pending_table_ids,
    'pending_table_count',v_pending_table_count,
    'remaining_deficit',GREATEST(v_required_open_seats-(v_open_seats+v_cap),0)
  );
END;
$function$;

-- Idempotent acknowledgement of an exact, bounded hand-off set. This function
-- never creates capacity; it only proves that a service manager has admitted
-- every returned table into its engine registry before the durable receipt is
-- allowed to leave the pending set.
CREATE OR REPLACE FUNCTION public.fn_ack_tournament_capacity_tables(
  p_tournament_id uuid,
  p_table_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_found integer;
  v_changed integer;
BEGIN
  SELECT array_agg(DISTINCT requested.table_id ORDER BY requested.table_id)
    INTO v_ids
    FROM unnest(p_table_ids) AS requested(table_id)
   WHERE requested.table_id IS NOT NULL;
  IF p_tournament_id IS NULL OR p_table_ids IS NULL OR v_ids IS NULL
     OR cardinality(v_ids)<>cardinality(p_table_ids)
     OR cardinality(v_ids)>20 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_exact_table_set');
  END IF;

  PERFORM 1
    FROM public.tournament_capacity_table_receipts r
   WHERE r.table_id=ANY(v_ids)
   ORDER BY r.table_id
   FOR UPDATE;
  SELECT count(*)::integer INTO v_found
    FROM public.tournament_capacity_table_receipts r
   WHERE r.table_id=ANY(v_ids) AND r.tournament_id=p_tournament_id;
  IF v_found<>cardinality(v_ids) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','table_receipt_or_tournament_mismatch');
  END IF;

  UPDATE public.tournament_capacity_table_receipts r
     SET manager_admitted_at=COALESCE(r.manager_admitted_at,clock_timestamp()),
         updated_at=clock_timestamp()
   WHERE r.table_id=ANY(v_ids) AND r.tournament_id=p_tournament_id
     AND r.manager_admitted_at IS NULL;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN jsonb_build_object(
    'ok',true,'requested',cardinality(v_ids),'newly_admitted',v_changed);
END;
$function$;

-- 20260908042000 installed a deliberately small wrapper around the historical
-- money function. Point that wrapper at the one capacity authority. A failed
-- first registration lives in a PL/pgSQL subtransaction, so its debit, roster
-- row and seat attempt are rolled back before the reservation is made; the
-- retry then runs while this outer transaction still owns the tournament lock.
DO $install_registration_capacity_wrapper$
DECLARE
  v_target text := 'fn_register_for_tournament';
  v_definition text := $registration_wrapper$
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(
  p_tournament_id uuid,
  p_seat_first_internal boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.fn_register_for_tournament_before_atomic_capacity_20260907(
      p_tournament_id,p_seat_first_internal);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE 'Late registration could not seat the player (%)%' THEN
      RAISE;
    END IF;
    PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id,1);
    v_result := public.fn_register_for_tournament_before_atomic_capacity_20260907(
      p_tournament_id,p_seat_first_internal);
  END;

  IF COALESCE((v_result->>'ok')::boolean,false)
     AND COALESCE((v_result->>'late_registration')::boolean,false) THEN
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id,'late_registration');
  END IF;
  RETURN v_result;
END;
$function$;
$registration_wrapper$;
BEGIN
  -- 20260908042400 preserves this capacity wrapper under a private name and
  -- installs a no-default lifecycle gate on the public signature. On an
  -- ordered migration replay, refresh the preserved capacity core instead of
  -- restoring DEFAULT false on the newer public function: PostgreSQL cannot
  -- remove that default with CREATE OR REPLACE, so the following 205918 replay
  -- would otherwise fail before reaching any of its assertions.
  IF to_regprocedure(
       'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)'
     ) IS NOT NULL THEN
    v_target := 'fn_register_for_tournament_before_atomic_lifecycle_gate';
  END IF;

  EXECUTE replace(
    v_definition,
    'CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(',
    'CREATE OR REPLACE FUNCTION public.' || quote_ident(v_target) || '('
  );
END;
$install_registration_capacity_wrapper$;

-- Nothing may retain the earlier registration-only door. Keeping it would
-- create a second capacity vocabulary and make a future caller choose between
-- two functions with different concurrency contracts.
DROP FUNCTION IF EXISTS public.fn_create_late_registration_capacity(uuid);

REVOKE ALL ON FUNCTION public.fn_tournament_late_registration_open(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_late_registration_open(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_current_blinds(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_current_blinds(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ensure_late_registration_capacity(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ensure_late_registration_capacity(uuid,integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_ack_tournament_capacity_tables(uuid,uuid[])
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ack_tournament_capacity_tables(uuid,uuid[])
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_place_prize_exact(numeric,text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_close_tournament_entry_window(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_close_tournament_entry_window(uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_entry_reprice(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_entry_reprice(uuid)
  TO service_role;
-- This migration replaces the add-on close after 20260908042000. Reassert its
-- service-only boundary on the final definition too.
REVOKE ALL ON FUNCTION public.fn_close_tournament_addon_period(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_close_tournament_addon_period(uuid,text)
  TO service_role;

DO $assert$
DECLARE
  v_blinds text := pg_get_functiondef(
    'public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)'::regprocedure);
  v_current text := pg_get_functiondef(
    'public.fn_tournament_current_blinds(uuid)'::regprocedure);
  v_probe jsonb;
  v_capacity text := pg_get_functiondef(
    'public.fn_ensure_late_registration_capacity(uuid,integer)'::regprocedure);
  v_capacity_ack text := pg_get_functiondef(
    'public.fn_ack_tournament_capacity_tables(uuid,uuid[])'::regprocedure);
  v_register text;
  v_close text := pg_get_functiondef(
    'public.fn_close_tournament_entry_window(uuid,text)'::regprocedure);
  v_finalize text := pg_get_functiondef(
    'public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)'::regprocedure);
  v_complete text := pg_get_functiondef(
    'public.fn_complete_tournament_entry_reprice(uuid)'::regprocedure);
BEGIN
  SELECT pg_get_functiondef(COALESCE(
           to_regprocedure(
             'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)'
           ),
           to_regprocedure('public.fn_register_for_tournament(uuid,boolean)')
         ))
    INTO v_register;

  IF position('spin_overflow' IN v_blinds)=0
     OR position('v_index-v_len+1' IN v_blinds)=0
     OR position('v_tail_count-1' IN v_blinds)=0
     OR position('p_total_chips/20' IN v_blinds)=0
     OR position('10000000' IN v_blinds)=0 THEN
    RAISE EXCEPTION 'database blind resolver drifted from engine overflow rules';
  END IF;
  IF position('wallet_transactions' IN v_current)=0
     OR position('wt.category=''rebuy''' IN v_current)=0
     OR position('wt.category=''addon''' IN v_current)=0
     OR position('fn_resolve_tournament_blinds' IN v_current)=0 THEN
    RAISE EXCEPTION 'current-blind wrapper lost durable chip-cap inputs';
  END IF;

  -- Executable parity fixtures: a minutes-only MTT can run beyond its stored
  -- rows, and a deep Spin continues its canonical ten-chip ladder.
  v_probe := public.fn_resolve_tournament_blinds(
    '[{"smallBlind":50,"bigBlind":100,"ante":10},{"smallBlind":75,"bigBlind":150,"ante":15}]',
    2,'freezeout','MTT',NULL);
  IF (v_probe->>'small_blind')::numeric<>112.5
     OR (v_probe->>'big_blind')::numeric<>225
     OR (v_probe->>'ante')::numeric<>22.5
     OR v_probe->>'source'<>'mtt_overflow' THEN
    RAISE EXCEPTION 'generic past-end blind parity failed: %',v_probe;
  END IF;
  v_probe := public.fn_resolve_tournament_blinds(
    '[{"smallBlind":50,"bigBlind":100,"ante":10},{"smallBlind":75,"bigBlind":150,"ante":15}]',
    2,'freezeout','MTT',4000);
  IF (v_probe->>'small_blind')::numeric<>100
     OR (v_probe->>'big_blind')::numeric<>200
     OR (v_probe->>'ante')::numeric<>20
     OR (v_probe->>'blind_capped')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'overflow chip-cap parity failed: %',v_probe;
  END IF;
  v_probe := public.fn_resolve_tournament_blinds(
    '[{"smallBlind":10,"bigBlind":20}]',10,'spin','SPIN',3000);
  IF (v_probe->>'small_blind')::numeric<>145
     OR (v_probe->>'big_blind')::numeric<>290
     OR (v_probe->>'ante')::numeric<>0
     OR v_probe->>'source'<>'spin_overflow' THEN
    RAISE EXCEPTION 'Spin past-end blind parity failed: %',v_probe;
  END IF;
  IF position('FOR UPDATE' IN v_capacity)=0
     OR position('fn_tournament_late_registration_open' IN v_capacity)=0
     OR position('fn_tournament_current_blinds' IN v_capacity)=0
     OR position('registered' IN v_capacity)=0
     OR position('playing' IN v_capacity)=0
     OR position('v_required_open_seats<=v_open_seats' IN v_capacity)=0
     OR position('tournament_capacity_table_receipts' IN v_capacity)=0
     OR position('pending_table_ids' IN v_capacity)=0
     OR position('fn_emit_tournament_manager_wake' IN v_capacity)=0
     OR position('No live tournament table exists to clone safely' IN v_capacity)>0 THEN
    RAISE EXCEPTION 'late-registration capacity is not one locked demand decision';
  END IF;
  IF position('FOR UPDATE' IN v_capacity_ack)=0
     OR position('manager_admitted_at' IN v_capacity_ack)=0 THEN
    RAISE EXCEPTION 'capacity table hand-off lost its exact manager admission proof';
  END IF;
  IF position('fn_ensure_late_registration_capacity(p_tournament_id,1)' IN v_register)=0
     OR position('fn_emit_tournament_manager_wake' IN v_register)=0 THEN
    RAISE EXCEPTION 'registration lost atomic capacity or durable manager wake';
  END IF;
  IF to_regprocedure(
       'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)'
     ) IS NOT NULL AND EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid='public.fn_register_for_tournament(uuid,boolean)'::regprocedure
          AND p.pronargdefaults<>0
     ) THEN
    RAISE EXCEPTION
      'ordered migration replay restored a default on the downstream registration lifecycle gate';
  END IF;
  IF position('FOR UPDATE' IN v_close)=0
     OR position('late_reg_levels' IN v_close)=0
     OR position('late_reg_mins' IN v_close)=0
     OR position('retry_after_ms' IN v_close)=0
     OR position('v_deadline-clock_timestamp()' IN v_close)=0
     OR position('fn_finalize_tournament_entry_pool_locked' IN v_close)=0 THEN
    RAISE EXCEPTION 'entry close lost its locked level/minute authority';
  END IF;
  IF position('fn_ca_payout_structure' IN v_finalize)=0
     OR position('fn_apply_prize_guarantee' IN v_finalize)=0
     OR position('tournament_entry_close_receipts' IN v_finalize)=0
     OR position('NOT v_is_satellite' IN v_finalize)=0
     OR position('fn_emit_tournament_manager_wake' IN v_finalize)=0 THEN
    RAISE EXCEPTION 'entry close lost atomic fund/structure/receipt/wake ownership';
  END IF;
  IF position('FOR UPDATE' IN v_complete)=0
     OR position('fn_tournament_place_prize_exact' IN v_complete)=0
     OR position('tp.position IS NULL' IN v_complete)=0
     OR position('FROM public.tournaments t' IN v_complete)=0
     OR position('FROM public.tournament_entry_close_receipts r' IN v_complete)
        <=position('FROM public.tournaments t' IN v_complete)
     OR position('reprice_completed_at' IN v_complete)=0 THEN
    RAISE EXCEPTION 'entry close completion lost exact proof or canonical lock order';
  END IF;
  IF NOT has_function_privilege(
       'service_role','public.fn_ensure_late_registration_capacity(uuid,integer)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_ensure_late_registration_capacity(uuid,integer)','EXECUTE')
     OR has_function_privilege(
       'anon','public.fn_ensure_late_registration_capacity(uuid,integer)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_ack_tournament_capacity_tables(uuid,uuid[])','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_ack_tournament_capacity_tables(uuid,uuid[])','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_tournament_current_blinds(uuid)','EXECUTE')
     OR has_function_privilege(
       'anon','public.fn_tournament_late_registration_open(uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_close_tournament_entry_window(uuid,text)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_complete_tournament_entry_reprice(uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_close_tournament_entry_window(uuid,text)','EXECUTE')
     OR has_function_privilege(
       'anon','public.fn_complete_tournament_entry_reprice(uuid)','EXECUTE')
     OR has_function_privilege(
       'service_role','public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)','EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_entry_close_receipts','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_capacity_table_receipts','UPDATE') THEN
    RAISE EXCEPTION 'capacity/entry-close primitives are not service-only RPC doors';
  END IF;
  IF to_regprocedure('public.fn_create_late_registration_capacity(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'obsolete registration-only capacity door still exists';
  END IF;
END;
$assert$;

-- The paid registration and its seat now share the transaction above.  The
-- minute cron was the former correctness mechanism; leaving it active would
-- preserve both the design defect and a measured hot-database query forever.
-- Retain the function only through the DB-first rolling window for an older
-- engine binary, but remove every exact scheduled caller now.
DO $retire_seatless_cron$
DECLARE
  v_job record;
BEGIN
  IF to_regclass('cron.job') IS NULL
     OR to_regprocedure('cron.unschedule(bigint)') IS NULL THEN
    RAISE EXCEPTION 'pg_cron catalog/API unavailable; seatless repair job cannot be retired';
  END IF;

  FOR v_job IN
    SELECT jobid
      FROM cron.job
     WHERE jobname='sweep-seatless-late-registrants'
        OR command LIKE '%public.fn_sweep_seatless_late_registrants()%'
     FOR UPDATE
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM cron.job
     WHERE jobname='sweep-seatless-late-registrants'
        OR command LIKE '%public.fn_sweep_seatless_late_registrants()%'
  ) THEN
    RAISE EXCEPTION 'seatless late-registration repair cron remains scheduled';
  END IF;
END;
$retire_seatless_cron$;

-- The atomic registration transaction is the replacement, so retaining a
-- callable reconstruction function would preserve a second correctness path
-- after its scheduler was removed. Retire the function in the same all-or-none
-- release transaction as the new capacity/seat authority.
DROP FUNCTION IF EXISTS public.fn_sweep_seatless_late_registrants();

DO $assert_legacy_seat_sweep_gone$
BEGIN
  IF to_regprocedure('public.fn_sweep_seatless_late_registrants()') IS NOT NULL THEN
    RAISE EXCEPTION 'seatless late-registration repair function remains callable';
  END IF;
END;
$assert_legacy_seat_sweep_gone$;

COMMIT;
