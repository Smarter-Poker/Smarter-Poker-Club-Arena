-- 20260924033701_tournament_creation_refuses_what_the_client_refuses.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
/*
 * ===========================================================================
 *  TOURNAMENT CREATION REFUSES WHAT THE CLIENT REFUSES
 *  2026-09-24
 * ===========================================================================
 *
 * WHAT IS WRONG RIGHT NOW. The creation forms refuse configurations the
 * engine cannot run, and the database accepts every one of them from a direct
 * call to the same RPC:
 *
 *   a satellite with no target          pays cash instead of seats
 *   a rebuy or re-entry with no late    rebuy_levels, late_reg_levels and
 *     registration window               late_reg_mins are all 0, so the
 *                                       purchase window never opens
 *   a start time in the past            the discovery loop starts it at once
 *                                       or the auto-cancel takes it
 *   more seats than one deck can deal   PokerEngine.deal() throws mid-hand
 *                                       (PLO5 over 9, PLO6 over 7)
 *   a Sit And Go or Spin ladder whose   the server only checked it was
 *     blinds fall, or a level of 0 min  not empty
 *   a starting stack of 0 or less       refused only for new MTTs, by the
 *                                       blind contract trigger
 *
 * and fn_upsert_tournament_schedule checked none of the configuration at all,
 * so a schedule was first validated when the spawner tried to use it.
 *
 * THE FIX IS ONE LIST, NOT A THIRD COPY. public.fn_tournament_config_refusal
 * (p_config, p_surface) returns the first rule a p_config breaks, as the same
 * machine code the client uses (src/lib/tournamentCreationRules.ts, which
 * mirrors it line for line), or NULL when the engine can run it. It is called
 * from the two authoring RPCs:
 *
 *   fn_create_tournament            surface 'create', after the caller is
 *                                   authorised and before the governed
 *                                   creator writes anything
 *   fn_upsert_tournament_schedule   surface 'schedule', only when the stored
 *                                   configuration changes, exactly like the
 *                                   custom-break rule beside it, so an
 *                                   accepted schedule can still be switched
 *                                   on and off and renamed untouched
 *
 * 'schedule' differs only where the spawner (ScheduledTournamentService)
 * does: it owns the start time, a missing lateRegistrationLevels means 8, the
 * legacy rebuy and satellite spellings count, a Spin sits three to a table,
 * and a Sit And Go's default table is its own field.
 *
 * REBUY AND RE-ENTRY TOGETHER ARE SUPPORTED and stay accepted: the engine
 * opens both from one purchase window (TournamentBrainContext), a Free Buy
 * event carries both, and the table-config page has always sent both. A Free
 * Buy event is exempt from the window rule because zz_freerolls_are_free_buy
 * gives it rebuy levels of its own.
 *
 * The past-start rule allows five minutes of clock skew: the browser refuses
 * anything more than one minute old against its own clock, so a start the
 * browser accepts is not refused here because a device clock runs slow.
 *
 * WHAT DOES NOT CHANGE. No economics: buy-in, fee, guarantee, payout depth and
 * payout ladders are untouched, and the invalid-payoutPercent fallback to 10
 * is kept as it was. No existing tournament or schedule row is read or
 * written. Signatures, owners, ACLs, SECURITY DEFINER and search_path of both
 * RPCs are kept; each is edited by exact text substitution against its pinned
 * definition, never retyped. The governed creator
 * (fn_create_tournament_governed_legacy) and every trigger are untouched.
 *
 * THE PINS. Both preimages are the definitions installed by
 * 20260917204152_mtt_authored_ladders_only_contain_playing_levels.sql (its own
 * post-image md5s), which the later preparation migrations 20260917232232,
 * 20260918005809, 20260918023535 and 20260918093004 still carry as current.
 * They are the newest repo definitions; the live md5s must be confirmed
 * against production before this is installed. Anything else stops here, and
 * so does a second apply.
 *
 * Proven in an isolated cluster by scripts/ci/test-tournament-creation-rules.py:
 * preimage fidelity, install, every refusal on both surfaces, every
 * acceptance that must survive, an unchanged schedule left alone, privileges,
 * and a refused re-apply.
 */
--
-- HOW A READER SEES THIS IS LIVE. Each line below is read-only and must be true.
-- @live-proof: (SELECT NOT p.prosecdef AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_tournament_config_refusal(jsonb,text)'))
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_create_tournament(uuid,jsonb)'))) = 'bc5e5dcea11302574163b21f10b63465'
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)'))) = 'f56ec7122c5a2cc2b72f5b6f13aeefbb'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The two functions this migration edits, pinned exactly as the repo's newest
-- definitions carry them: definition, owner, configuration, ACL and security
-- mode. The substitutions below are only correct against these bytes.
DO $pin$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_create_tournament(uuid,jsonb)',
       '4c5c8783d1f6f534fdaf5cefbb460d62',
       ARRAY['search_path=public, extensions']::text[]),
      ('public.fn_upsert_tournament_schedule(jsonb)',
       'b8dd7cc8e0996889a936affdc732b664',
       ARRAY['search_path=public']::text[])
    ) AS v(sig, def_md5, config)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND md5(pg_get_functiondef(p.oid)) = r.def_md5
         AND p.proowner = 'postgres'::regrole
         AND p.proconfig = r.config
         AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
         AND p.prosecdef
    ) THEN
      RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_PREIMAGE_CHANGED: %', r.sig
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF to_regprocedure('public.fn_tournament_config_refusal(jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_VALIDATOR_ALREADY_EXISTS' USING ERRCODE = '55000';
  END IF;
END $pin$;

-- ── The one list ─────────────────────────────────────────────────────────────
-- SECURITY INVOKER over pg_catalog only: it reads nothing but its argument and
-- the clock. Its callers are SECURITY DEFINER functions owned by postgres.
CREATE FUNCTION public.fn_tournament_config_refusal(p_config jsonb, p_surface text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_schedule boolean;
  v_type     text;
  v_short    boolean;
  v_stack    numeric;
  v_start    timestamptz;
  v_target   jsonb;
  v_ok       boolean;
  v_total    numeric;
  v_level    jsonb;
  v_sb       numeric;
  v_bb       numeric;
  v_prev_sb  numeric;
  v_prev_bb  numeric;
  v_seen     boolean := false;
  v_variant  text;
  v_hole     int;
  v_deck     int;
  v_seats    numeric;
  v_rebuy    boolean;
  v_late     numeric;
  v_late_min numeric;
  v_buy_in   numeric;
BEGIN
  IF p_surface IS NULL OR p_surface NOT IN ('create', 'schedule') THEN
    RAISE EXCEPTION 'fn_tournament_config_refusal: unknown surface %', p_surface
      USING ERRCODE = '22023';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RETURN 'invalid_configuration';
  END IF;
  v_schedule := p_surface = 'schedule';

  BEGIN
    v_type := lower(COALESCE(NULLIF(btrim(p_config->>'type'), ''), 'mtt'));
    IF v_schedule AND v_type IN ('hu_sng', 'heads_up') THEN v_type := 'sng'; END IF;
    v_short := v_type IN ('sng', 'spin');

    -- 1. Starting stack: a whole number above zero, for every format.
    v_stack := NULLIF(p_config->>'startingStack', '')::numeric;
    IF v_stack IS NOT NULL AND (v_stack <= 0 OR v_stack <> trunc(v_stack)) THEN
      RETURN 'starting_stack_must_be_positive';
    END IF;

    -- 2. A start in the past is refused, never silently moved. Five minutes of
    --    skew for a device clock that runs slow.
    IF NOT v_schedule THEN
      v_start := NULLIF(p_config->>'startTime', '')::timestamptz;
      IF v_start IS NOT NULL AND v_start < now() - interval '5 minutes' THEN
        RETURN 'start_time_in_past';
      END IF;
    END IF;

    -- 3. A satellite names the event its seats go into.
    IF v_type = 'satellite' THEN
      IF v_schedule THEN
        v_target := COALESCE(p_config->'satelliteTarget', p_config->'satellite_target');
        -- COALESCE: with no target object every jsonb_typeof test is NULL, and
        -- NOT NULL would wave the satellite through.
        v_ok := COALESCE(
                (jsonb_typeof(v_target) = 'string' AND btrim(v_target #>> '{}') <> '')
             OR (jsonb_typeof(v_target) = 'object'
                 AND COALESCE(NULLIF(v_target->>'tournamentId', ''), NULLIF(v_target->>'tournament_id', '')) IS NOT NULL),
                false)
             OR COALESCE(btrim(p_config->>'satelliteTargetId'), '') <> ''
             OR COALESCE(btrim(p_config->>'satellite_target_id'), '') <> ''
             OR COALESCE(btrim(p_config->>'satelliteTargetName'), '') <> '';
      ELSE
        v_ok := COALESCE(btrim(p_config->>'satelliteTargetId'), '') <> '';
      END IF;
      IF NOT v_ok THEN
        RETURN 'satellite_target_required';
      END IF;
    END IF;

    -- 4. Payouts add up to 100, within the governed creator's tolerance of 1.
    IF jsonb_typeof(p_config->'payoutStructure') = 'array'
       AND jsonb_array_length(p_config->'payoutStructure') > 0 THEN
      SELECT COALESCE(SUM((e->>'percentage')::numeric), 0) INTO v_total
        FROM jsonb_array_elements(p_config->'payoutStructure') e;
      IF abs(v_total - 100) > 1 THEN
        RETURN 'payouts_must_total_100';
      END IF;
    END IF;

    -- 5. A Sit And Go or Spin ladder: positive durations, blinds never fall.
    --    Break rows (a flag, or 0/0 blinds) do not take part. A new MTT ladder
    --    is held to the fuller contract by tournaments_new_mtt_blind_contract.
    IF v_short AND jsonb_typeof(p_config->'blindStructure') = 'array' THEN
      FOR v_level IN SELECT value FROM jsonb_array_elements(p_config->'blindStructure') LOOP
        IF jsonb_typeof(v_level) <> 'object' THEN
          RETURN 'invalid_configuration';
        END IF;
        IF NULLIF(v_level->>'durationMinutes', '') IS NOT NULL
           AND (v_level->>'durationMinutes')::numeric <= 0 THEN
          RETURN 'blind_level_duration_invalid';
        END IF;
        v_sb := NULLIF(v_level->>'smallBlind', '')::numeric;
        v_bb := NULLIF(v_level->>'bigBlind', '')::numeric;
        CONTINUE WHEN COALESCE(v_level->>'isBreak', '') = 'true' OR (v_sb = 0 AND v_bb = 0);
        IF v_seen AND (v_sb < v_prev_sb OR v_bb < v_prev_bb) THEN
          RETURN 'blind_structure_must_not_decrease';
        END IF;
        v_prev_sb := v_sb;
        v_prev_bb := v_bb;
        v_seen := true;
      END LOOP;
    END IF;

    -- 6. No more seats at a table than one deck can deal: the deck, less one
    --    board, over the hole cards each seat takes (VariantRules.maxSeatsFor).
    v_variant := lower(btrim(COALESCE(p_config->>'gameVariant', 'NLH')));
    v_hole := CASE
      WHEN v_variant IN ('plo4', 'plo8', 'flo8') THEN 4
      WHEN v_variant = 'plo5' THEN 5
      WHEN v_variant = 'plo6' THEN 6
      WHEN v_variant = 'pineapple' THEN 3
      ELSE 2 END;
    v_deck := CASE WHEN v_variant LIKE 'short%' THEN 36 ELSE 52 END;
    IF v_schedule AND v_type = 'spin' THEN
      v_seats := 3;
    ELSE
      v_seats := round(NULLIF(p_config->>'tableSize', '')::numeric);
      IF v_seats IS NULL THEN
        v_seats := CASE
          WHEN v_schedule AND v_short
            THEN COALESCE(round(NULLIF(p_config->>'maxPlayers', '')::numeric), 2)
          ELSE 9 END;
      END IF;
      v_seats := LEAST(10, GREATEST(2, v_seats));
    END IF;
    IF v_seats > (v_deck - 5) / v_hole THEN
      RETURN 'table_size_exceeds_deck';
    END IF;

    -- 7. A rebuy or re-entry needs a late registration window to be sold in.
    IF v_schedule THEN
      v_rebuy := COALESCE(p_config->>'isRebuy', '') = 'true'
              OR COALESCE(p_config->>'rebuy', '') = 'true'
              OR COALESCE(p_config->>'isReentry', '') = 'true'
              OR v_type IN ('rebuy', 'reentry', 'mtt_rebuy', 'mtt_reentry');
      v_late := CASE
        WHEN v_short THEN 0
        WHEN NOT (p_config ? 'lateRegistrationLevels') THEN 8
        ELSE COALESCE(NULLIF(p_config->>'lateRegistrationLevels', '')::numeric, 0) END;
      v_late_min := 0;
    ELSE
      v_rebuy := COALESCE((p_config->>'isRebuy')::boolean, false)
              OR COALESCE((p_config->>'isReentry')::boolean, false);
      v_late := CASE WHEN v_short THEN 0
        ELSE COALESCE(NULLIF(p_config->>'lateRegistrationLevels', '')::numeric, 0) END;
      v_late_min := COALESCE(NULLIF(p_config->>'lateRegistrationMinutes', '')::numeric, 0);
    END IF;
    v_buy_in := COALESCE(NULLIF(p_config->>'buyIn', '')::numeric, 0);
    IF v_rebuy
       AND NOT (v_buy_in = 0 AND NOT v_short)   -- a Free Buy event has its own levels
       AND v_late <= 0 AND v_late_min <= 0 THEN
      RETURN 'rebuy_requires_late_registration';
    END IF;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range
      OR invalid_datetime_format OR datetime_field_overflow THEN
      RETURN 'invalid_configuration';
  END;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_config_refusal(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_config_refusal(jsonb, text) TO service_role;

COMMENT ON FUNCTION public.fn_tournament_config_refusal(jsonb, text) IS
  'The first tournament creation rule a p_config breaks, as a refusal code, or NULL. '
  'Surface create (fn_create_tournament) or schedule (fn_upsert_tournament_schedule). '
  'Mirrored line for line by src/lib/tournamentCreationRules.ts. 20260924033701.';

-- ── The two authoring RPCs, by exact substitution ────────────────────────────
-- Each old text must occur exactly once. Each new definition is pinned by md5
-- before it is executed, and the installed definition is pinned again after.
DO $patch$
DECLARE
  v_fn  regprocedure;
  v_def text;
  v_new text;
  v_old text;
  v_rep text;
  v_pairs text[][];
  i int;
BEGIN
  -- 1. fn_create_tournament: refuse before the governed creator writes.
  v_fn := 'public.fn_create_tournament(uuid,jsonb)'::regprocedure;
  v_def := pg_get_functiondef(v_fn);
  v_pairs := ARRAY[
    ARRAY[
$c1_old$  v_persisted jsonb;
BEGIN
$c1_old$,
$c1_new$  v_persisted jsonb;
  v_refusal text;
BEGIN
$c1_new$],
    ARRAY[
$c2_old$  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;
$c2_old$,
$c2_new$  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;

  -- The refusals the creation forms make, for every caller of this RPC
  -- (20260924033701). NULL means the engine can run this configuration.
  v_refusal := public.fn_tournament_config_refusal(p_config,'create');
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'error',v_refusal);
  END IF;
$c2_new$]];
  v_new := v_def;
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_old := v_pairs[i][1];
    v_rep := v_pairs[i][2];
    IF (length(v_new) - length(replace(v_new, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_SUBSTITUTION_NOT_UNIQUE: % #%', v_fn, i
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_old, v_rep);
  END LOOP;
  IF md5(v_new) <> 'bc5e5dcea11302574163b21f10b63465' THEN
    RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_PATCH_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> 'bc5e5dcea11302574163b21f10b63465' THEN
    RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_INSTALL_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;

  -- 2. fn_upsert_tournament_schedule: a changed configuration is checked with
  --    the same list; an unchanged one is left exactly as it was accepted.
  v_fn := 'public.fn_upsert_tournament_schedule(jsonb)'::regprocedure;
  v_def := pg_get_functiondef(v_fn);
  v_pairs := ARRAY[
    ARRAY[
$s1_old$  v_config_changed boolean := true;
BEGIN
$s1_old$,
$s1_new$  v_config_changed boolean := true;
  v_refusal   text;
BEGIN
$s1_new$],
    ARRAY[
$s2_old$    RETURN jsonb_build_object('error','custom_level_breaks_not_supported');
  END IF;

  IF v_id IS NULL THEN
$s2_old$,
$s2_new$    RETURN jsonb_build_object('error','custom_level_breaks_not_supported');
  END IF;

  -- The creation rules, checked when the configuration is written rather than
  -- first discovered by the spawner (20260924033701).
  IF v_config_changed THEN
    v_refusal := public.fn_tournament_config_refusal(v_config,'schedule');
    IF v_refusal IS NOT NULL THEN
      RETURN jsonb_build_object('error',v_refusal);
    END IF;
  END IF;

  IF v_id IS NULL THEN
$s2_new$]];
  v_new := v_def;
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_old := v_pairs[i][1];
    v_rep := v_pairs[i][2];
    IF (length(v_new) - length(replace(v_new, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_SUBSTITUTION_NOT_UNIQUE: % #%', v_fn, i
        USING ERRCODE = '55000';
    END IF;
    v_new := replace(v_new, v_old, v_rep);
  END LOOP;
  IF md5(v_new) <> 'f56ec7122c5a2cc2b72f5b6f13aeefbb' THEN
    RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_PATCH_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> 'f56ec7122c5a2cc2b72f5b6f13aeefbb' THEN
    RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_INSTALL_MISMATCH: %', v_fn USING ERRCODE = '55000';
  END IF;
END $patch$;

-- Owner, ACL, configuration and security mode survive CREATE OR REPLACE; prove it.
DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN (to_regprocedure('public.fn_create_tournament(uuid,jsonb)'),
                       to_regprocedure('public.fn_upsert_tournament_schedule(jsonb)'))
         AND p.proowner = 'postgres'::regrole
         AND p.prosecdef
         AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') <> 2 THEN
    RAISE EXCEPTION 'TOURNAMENT_CREATION_RULES_AUTHORITY_CHANGED' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
