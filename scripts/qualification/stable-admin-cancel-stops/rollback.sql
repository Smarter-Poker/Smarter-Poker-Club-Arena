-- Recovery candidate; qualify separately before installation. Retains all receipts.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='decide_trivia_pvp_settlement_v1') <> '31dce1329eecdb516a9586fc88d111ae' THEN RAISE EXCEPTION 'refund rollback postimage drift: decide_trivia_pvp_settlement_v1'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.decide_trivia_pvp_settlement_v1(p_match_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_match public.trivia_pvp_matches%ROWTYPE;
    v_existing public.trivia_pvp_settlement_decisions%ROWTYPE;
    v_link1 public.trivia_pvp_session_links%ROWTYPE;
    v_link2 public.trivia_pvp_session_links%ROWTYPE;
    v_session1 public.trivia_sessions%ROWTYPE;
    v_session2 public.trivia_sessions%ROWTYPE;
    v_has_link1 boolean := false;
    v_has_link2 boolean := false;
    v_p1_is_horse boolean;
    v_p2_is_horse boolean;
    v_p1_charged boolean := false;
    v_p2_charged boolean := false;
    v_p1_submitted boolean := false;
    v_p2_submitted boolean := false;
    v_p1_correct integer;
    v_p2_correct integer;
    v_txn_count integer;
    v_exact_txn_count integer;
    v_stake integer;
    v_total_pot integer;
    v_rake integer;
    v_winner_payout integer;
    v_kind text;
    v_winner_id uuid;
    v_forfeit boolean := false;
    v_reference_family text;
    v_side_state jsonb;
    v_credit_plan jsonb := '[]'::jsonb;
    v_credit jsonb;
    v_credit_result jsonb;
    v_credited_amount integer := 0;
    v_credit_count integer := 0;
BEGIN
    IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'service_role required';
    END IF;
    IF p_match_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'invalid_match_id'
        );
    END IF;

    -- The match lock serializes decision creation. Lock children in stable side
    -- order before reading them so submit/expiry and link creation cannot race
    -- the decision snapshot.
    SELECT * INTO v_match
      FROM public.trivia_pvp_matches
     WHERE id = p_match_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'match_not_found'
        );
    END IF;

    SELECT * INTO v_existing
      FROM public.trivia_pvp_settlement_decisions
     WHERE match_id = p_match_id;
    IF FOUND THEN
        IF v_match.status NOT IN ('complete', 'completed') THEN
            RAISE EXCEPTION
                'settlement invariant failed: decision exists for non-terminal match % (%)',
                p_match_id, v_match.status;
        END IF;
        RETURN jsonb_build_object(
            'success', true,
            'state', 'replay',
            'replayed', true,
            'match_id', p_match_id,
            'match_status', v_match.status,
            'credit_count', jsonb_array_length(v_existing.credit_plan),
            'credited_amount', (
                SELECT COALESCE(sum((credit.value ->> 'amount')::integer), 0)::integer
                  FROM jsonb_array_elements(v_existing.credit_plan) AS credit(value)
            ),
            'decision', jsonb_build_object(
                'kind', v_existing.decision_kind,
                'forfeit', v_existing.forfeit,
                'winner_id', v_existing.winner_id,
                'player1_score', v_existing.player1_score,
                'player2_score', v_existing.player2_score,
                'reference_family', v_existing.reference_family,
                'sides', v_existing.side_state,
                'credits', v_existing.credit_plan
            )
        );
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.competitive_quarantine
         WHERE entity_type = 'trivia_pvp_match' AND entity_id = p_match_id
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'match_quarantined'
        );
    END IF;
    IF v_match.status NOT IN ('active', 'settling') THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', CASE
                WHEN v_match.status IN ('complete', 'completed')
                    THEN 'terminal_match_missing_decision'
                ELSE 'match_not_settleable'
            END
        );
    END IF;
    IF COALESCE(p_force, false)
       AND (v_match.created_at IS NULL
            OR v_match.created_at > clock_timestamp() - interval '30 minutes') THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'match_not_stale'
        );
    END IF;
    IF v_match.player1_id IS NULL OR v_match.player2_id IS NULL
       OR v_match.player1_id = v_match.player2_id
       OR v_match.stake_amount IS NULL
       OR v_match.stake_amount NOT IN (10, 25, 50, 100) THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'invalid_match'
        );
    END IF;

    SELECT p1.is_horse IS TRUE, p2.is_horse IS TRUE
      INTO v_p1_is_horse, v_p2_is_horse
      FROM public.profiles AS p1
      CROSS JOIN public.profiles AS p2
     WHERE p1.id = v_match.player1_id
       AND p2.id = v_match.player2_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'invalid_match_players'
        );
    END IF;

    IF jsonb_typeof(v_match.questions) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_match.questions) <> 20
       OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(v_match.questions) AS question(value)
            WHERE jsonb_typeof(question.value) IS DISTINCT FROM 'string'
               OR (question.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       OR (SELECT count(DISTINCT question.value #>> '{}')
             FROM jsonb_array_elements(v_match.questions) AS question(value)) <> 20 THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'invalid_match_roster'
        );
    END IF;

    PERFORM link.match_id
      FROM public.trivia_pvp_session_links AS link
     WHERE link.match_id = p_match_id
     ORDER BY link.side
     FOR UPDATE OF link;
    PERFORM session.id
      FROM public.trivia_pvp_session_links AS link
      JOIN public.trivia_sessions AS session ON session.id = link.session_id
     WHERE link.match_id = p_match_id
     ORDER BY link.side
     FOR UPDATE OF session;

    SELECT * INTO v_link1
      FROM public.trivia_pvp_session_links
     WHERE match_id = p_match_id AND side = 1;
    v_has_link1 := FOUND;
    IF v_has_link1 THEN
        SELECT * INTO v_session1 FROM public.trivia_sessions WHERE id = v_link1.session_id;
        IF NOT FOUND
           OR v_link1.user_id IS DISTINCT FROM v_match.player1_id
           OR v_session1.user_id IS DISTINCT FROM v_match.player1_id
           OR v_session1.mode IS DISTINCT FROM 'pvp'
           OR v_session1.status NOT IN ('open', 'submitted', 'expired')
           OR v_session1.entry_state IS DISTINCT FROM 'charged'
           OR v_session1.entry_cost IS DISTINCT FROM v_match.stake_amount
           OR array_ndims(v_session1.question_ids) IS DISTINCT FROM 1
           OR cardinality(v_session1.question_ids) <> 20
           OR array_position(v_session1.question_ids, NULL::uuid) IS NOT NULL
           OR (SELECT count(DISTINCT question_id)
                 FROM unnest(v_session1.question_ids) AS question_id) <> 20
           OR v_match.questions IS DISTINCT FROM to_jsonb(v_session1.question_ids)
           OR v_session1.created_at IS NULL
           OR v_match.created_at IS NULL
           OR v_session1.created_at < v_match.created_at - interval '1 second'
           OR v_session1.created_at > v_match.created_at + interval '30 minutes'
           OR v_session1.expires_at IS NULL
           OR v_session1.expires_at < v_session1.created_at
           OR v_session1.expires_at > v_match.created_at + interval '30 minutes'
           OR (v_session1.status = 'submitted' AND (
               v_session1.submitted_at IS NULL
               OR v_session1.submitted_at > v_session1.expires_at
               OR v_session1.correct_count IS NULL
               OR v_session1.correct_count NOT BETWEEN 0 AND 20
           )) THEN
            RETURN jsonb_build_object(
                'success', false, 'state', 'rejected', 'match_id', p_match_id,
                'error', 'player1_session_invalid'
            );
        END IF;
        v_p1_submitted := v_session1.status = 'submitted';
        v_p1_correct := CASE WHEN v_p1_submitted THEN v_session1.correct_count ELSE NULL END;
    END IF;

    SELECT count(*), count(*) FILTER (
               WHERE d.user_id = v_match.player1_id
                 AND d.amount = -v_match.stake_amount
                 AND COALESCE(
                     NULLIF(BTRIM(d.transaction_type), ''),
                     NULLIF(BTRIM(d.type), '')
                 ) = 'pvp_stake'
           )
      INTO v_txn_count, v_exact_txn_count
      FROM public.diamond_transactions AS d
     WHERE d.reference_id =
           'pvp_stake_' || p_match_id::text || '_' || v_match.player1_id::text;
    IF v_txn_count NOT IN (0, 1) OR v_txn_count <> v_exact_txn_count THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'player1_stake_invalid'
        );
    END IF;
    v_p1_charged := v_txn_count = 1;
    IF v_has_link1 AND NOT v_p1_charged THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'player1_stake_missing'
        );
    END IF;

    SELECT * INTO v_link2
      FROM public.trivia_pvp_session_links
     WHERE match_id = p_match_id AND side = 2;
    v_has_link2 := FOUND;
    IF v_has_link2 THEN
        SELECT * INTO v_session2 FROM public.trivia_sessions WHERE id = v_link2.session_id;
        IF NOT FOUND
           OR v_link2.user_id IS DISTINCT FROM v_match.player2_id
           OR v_session2.user_id IS DISTINCT FROM v_match.player2_id
           OR v_session2.mode IS DISTINCT FROM 'pvp'
           OR v_session2.status NOT IN ('open', 'submitted', 'expired')
           OR v_session2.entry_state IS DISTINCT FROM 'charged'
           OR v_session2.entry_cost IS DISTINCT FROM v_match.stake_amount
           OR array_ndims(v_session2.question_ids) IS DISTINCT FROM 1
           OR cardinality(v_session2.question_ids) <> 20
           OR array_position(v_session2.question_ids, NULL::uuid) IS NOT NULL
           OR (SELECT count(DISTINCT question_id)
                 FROM unnest(v_session2.question_ids) AS question_id) <> 20
           OR v_match.questions IS DISTINCT FROM to_jsonb(v_session2.question_ids)
           OR v_session2.created_at IS NULL
           OR v_match.created_at IS NULL
           OR v_session2.created_at < v_match.created_at - interval '1 second'
           OR v_session2.created_at > v_match.created_at + interval '30 minutes'
           OR v_session2.expires_at IS NULL
           OR v_session2.expires_at < v_session2.created_at
           OR v_session2.expires_at > v_match.created_at + interval '30 minutes'
           OR (v_session2.status = 'submitted' AND (
               v_session2.submitted_at IS NULL
               OR v_session2.submitted_at > v_session2.expires_at
               OR v_session2.correct_count IS NULL
               OR v_session2.correct_count NOT BETWEEN 0 AND 20
           )) THEN
            RETURN jsonb_build_object(
                'success', false, 'state', 'rejected', 'match_id', p_match_id,
                'error', 'player2_session_invalid'
            );
        END IF;
        v_p2_submitted := v_session2.status = 'submitted';
        v_p2_correct := CASE WHEN v_p2_submitted THEN v_session2.correct_count ELSE NULL END;
    END IF;

    SELECT count(*), count(*) FILTER (
               WHERE d.user_id = v_match.player2_id
                 AND d.amount = -v_match.stake_amount
                 AND COALESCE(
                     NULLIF(BTRIM(d.transaction_type), ''),
                     NULLIF(BTRIM(d.type), '')
                 ) = 'pvp_stake'
           )
      INTO v_txn_count, v_exact_txn_count
      FROM public.diamond_transactions AS d
     WHERE d.reference_id =
           'pvp_stake_' || p_match_id::text || '_' || v_match.player2_id::text;
    IF v_txn_count NOT IN (0, 1) OR v_txn_count <> v_exact_txn_count THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'player2_stake_invalid'
        );
    END IF;
    v_p2_charged := v_txn_count = 1;
    IF v_has_link2 AND NOT v_p2_charged THEN
        RETURN jsonb_build_object(
            'success', false, 'state', 'rejected', 'match_id', p_match_id,
            'error', 'player2_stake_missing'
        );
    END IF;

    IF v_p1_submitted AND v_p2_submitted THEN
        IF v_p1_correct > v_p2_correct THEN
            v_kind := 'win'; v_winner_id := v_match.player1_id;
        ELSIF v_p2_correct > v_p1_correct THEN
            v_kind := 'win'; v_winner_id := v_match.player2_id;
        ELSE
            v_kind := 'tie';
        END IF;
    ELSIF NOT COALESCE(p_force, false) THEN
        RETURN jsonb_build_object(
            'success', true,
            'state', 'pending',
            'replayed', false,
            'match_id', p_match_id,
            'pending_reason', CASE
                WHEN v_p1_submitted OR v_p2_submitted THEN 'opponent_not_finished'
                ELSE 'match_not_finished'
            END
        );
    ELSIF v_p1_submitted OR v_p2_submitted THEN
        IF v_p1_submitted THEN
            IF v_p2_charged THEN
                v_kind := 'win'; v_winner_id := v_match.player1_id; v_forfeit := true;
            ELSIF v_p1_charged THEN
                v_kind := 'refund';
            ELSE
                v_kind := 'void';
            END IF;
        ELSE
            IF v_p1_charged THEN
                v_kind := 'win'; v_winner_id := v_match.player2_id; v_forfeit := true;
            ELSIF v_p2_charged THEN
                v_kind := 'refund';
            ELSE
                v_kind := 'void';
            END IF;
        END IF;
    ELSIF v_p1_charged OR v_p2_charged THEN
        v_kind := 'refund';
    ELSE
        v_kind := 'void';
    END IF;

    v_stake := v_match.stake_amount;
    v_total_pot := v_stake * 2;
    v_rake := floor(v_total_pot * 0.10)::integer;
    v_winner_payout := v_total_pot - v_rake;
    IF v_kind = 'win' AND v_winner_id IS NOT NULL THEN
        v_credit_plan := v_credit_plan || jsonb_build_array(jsonb_build_object(
            'user_id', v_winner_id,
            'amount', v_winner_payout,
            'transaction_type', 'pvp_win',
            'description', 'PvP match won - ' || v_winner_payout::text
                || ' diamonds payout (pot ' || v_total_pot::text
                || ', rake ' || v_rake::text || ')',
            'reference_id', 'pvp_match_win_' || p_match_id::text
        ));
    ELSIF v_kind = 'tie' THEN
        IF v_p1_charged THEN
            v_credit_plan := v_credit_plan || jsonb_build_array(jsonb_build_object(
                'user_id', v_match.player1_id, 'amount', v_stake,
                'transaction_type', 'pvp_refund',
                'description', 'PvP tie - ' || v_stake::text || ' diamonds returned',
                'reference_id', 'pvp_tie_refund_' || p_match_id::text || '_' || v_match.player1_id::text
            ));
        END IF;
        IF v_p2_charged THEN
            v_credit_plan := v_credit_plan || jsonb_build_array(jsonb_build_object(
                'user_id', v_match.player2_id, 'amount', v_stake,
                'transaction_type', 'pvp_refund',
                'description', 'PvP tie - ' || v_stake::text || ' diamonds returned',
                'reference_id', 'pvp_tie_refund_' || p_match_id::text || '_' || v_match.player2_id::text
            ));
        END IF;
    ELSIF v_kind = 'refund' THEN
        IF v_p1_charged THEN
            v_credit_plan := v_credit_plan || jsonb_build_array(jsonb_build_object(
                'user_id', v_match.player1_id, 'amount', v_stake,
                'transaction_type', 'pvp_refund',
                'description', 'PvP match not completed - ' || v_stake::text || ' diamond stake refunded',
                'reference_id', 'pvp_refund_' || p_match_id::text || '_' || v_match.player1_id::text
            ));
        END IF;
        IF v_p2_charged THEN
            v_credit_plan := v_credit_plan || jsonb_build_array(jsonb_build_object(
                'user_id', v_match.player2_id, 'amount', v_stake,
                'transaction_type', 'pvp_refund',
                'description', 'PvP match not completed - ' || v_stake::text || ' diamond stake refunded',
                'reference_id', 'pvp_refund_' || p_match_id::text || '_' || v_match.player2_id::text
            ));
        END IF;
    END IF;

    v_side_state := jsonb_build_array(
        jsonb_build_object(
            'side', 1, 'user_id', v_match.player1_id,
            'session_id', CASE WHEN v_has_link1 THEN v_link1.session_id ELSE NULL END,
            'is_horse', v_p1_is_horse, 'charged', v_p1_charged,
            'submitted', v_p1_submitted, 'correct_count', v_p1_correct
        ),
        jsonb_build_object(
            'side', 2, 'user_id', v_match.player2_id,
            'session_id', CASE WHEN v_has_link2 THEN v_link2.session_id ELSE NULL END,
            'is_horse', v_p2_is_horse, 'charged', v_p2_charged,
            'submitted', v_p2_submitted, 'correct_count', v_p2_correct
        )
    );
    v_reference_family := 'pvp_settlement_' || p_match_id::text;

    INSERT INTO public.trivia_pvp_settlement_decisions (
        match_id, decision_kind, winner_id, player1_score, player2_score,
        forfeit, reference_family, side_state, credit_plan
    ) VALUES (
        p_match_id, v_kind, v_winner_id, v_p1_correct, v_p2_correct,
        v_forfeit, v_reference_family, v_side_state, v_credit_plan
    );

    UPDATE public.trivia_pvp_matches
       SET status = 'settling',
           settlement_kind = v_kind,
           winner_id = v_winner_id,
           player1_score = v_p1_correct,
           player2_score = v_p2_correct
     WHERE id = p_match_id;

    -- The decision, every wallet mutation, its diamond_transactions receipt,
    -- and the terminal match transition share this function's transaction.
    -- A wallet rejection raises, rolling all of them back together. A retry
    -- can therefore only see no decision (and recompute under the same locks)
    -- or a fully completed decision; partial payment is not a durable state.
    FOR v_credit IN
        SELECT value FROM jsonb_array_elements(v_credit_plan)
    LOOP
        SELECT public.add_diamonds_to_balance(
            (v_credit ->> 'user_id')::uuid,
            (v_credit ->> 'amount')::integer,
            v_credit ->> 'transaction_type',
            v_credit ->> 'description',
            v_credit ->> 'reference_id'
        ) INTO v_credit_result;

        IF COALESCE((v_credit_result ->> 'success')::boolean, false) IS NOT TRUE
           OR COALESCE((v_credit_result ->> 'duplicate')::boolean, false) IS TRUE
           OR (v_credit_result ->> 'amount')::integer
                IS DISTINCT FROM (v_credit ->> 'amount')::integer
           OR COALESCE((v_credit_result ->> 'multiplier')::numeric, 0) <> 1 THEN
            RAISE EXCEPTION 'atomic PvP credit rejected for match % reference %: %',
                p_match_id, v_credit ->> 'reference_id',
                COALESCE(v_credit_result::text, 'null');
        END IF;

        v_credited_amount := v_credited_amount + (v_credit ->> 'amount')::integer;
        v_credit_count := v_credit_count + 1;
    END LOOP;

    UPDATE public.trivia_pvp_matches
       SET status = 'complete',
           completed_at = clock_timestamp()
     WHERE id = p_match_id
       AND status = 'settling';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'atomic PvP terminal transition failed for match %', p_match_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'state', 'decided',
        'replayed', false,
        'match_id', p_match_id,
        'match_status', 'complete',
        'credit_count', v_credit_count,
        'credited_amount', v_credited_amount,
        'decision', jsonb_build_object(
            'kind', v_kind,
            'forfeit', v_forfeit,
            'winner_id', v_winner_id,
            'player1_score', v_p1_correct,
            'player2_score', v_p2_correct,
            'reference_family', v_reference_family,
            'sides', v_side_state,
            'credits', v_credit_plan
        )
    );
END;
$function$
;
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ad_campaign_review') <> '0e1a37eff7ff4da786cd187ba6b5c77b' THEN RAISE EXCEPTION 'refund rollback postimage drift: fn_ad_campaign_review'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.fn_ad_campaign_review(p_campaign_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_c    public.ad_campaign%rowtype;
  v_ad   uuid;
  v_ref  jsonb;
  v_code text;
  v_target text;
BEGIN
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR public.fn_is_platform_admin()) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_decision');
  END IF;
  SELECT * INTO v_c FROM public.ad_campaign WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_c.status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_reviewed', 'status', v_c.status);
  END IF;
  IF p_decision = 'reject' THEN
    IF v_c.diamonds_charged > 0 AND v_c.submitted_by IS NOT NULL THEN
      v_ref := public.add_diamonds_to_balance(
        v_c.submitted_by, v_c.diamonds_charged, 'refund',
        'Club advert not approved: ' || v_c.name,
        'adcamp-refund:' || v_c.id::text
      );
      IF COALESCE((v_ref->>'success')::boolean, false) IS NOT TRUE
         AND COALESCE((v_ref->>'duplicate')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'refund failed: %', v_ref->>'error';
      END IF;
    END IF;
    UPDATE public.ad_campaign
       SET status = 'rejected', diamonds_refunded = diamonds_charged,
           reviewed_by = v_user, reviewed_at = now(), review_note = p_note, updated_at = now()
     WHERE id = p_campaign_id;
    RETURN jsonb_build_object('ok', true, 'status', 'rejected', 'diamonds_refunded', v_c.diamonds_charged);
  END IF;
  IF v_c.external_url IS NOT NULL THEN
    v_code := COALESCE(v_c.click_code, substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    v_target := '/c/' || v_code;
    UPDATE public.ad_campaign SET click_code = v_code WHERE id = p_campaign_id;
  ELSE
    v_code := NULL;
    v_target := v_c.target_url;
  END IF;
  INSERT INTO public.ad_catalog
    (ad_key, category, headline, body, glyph, target_url, cta_label, is_active,
     starts_at, ends_at, weight, created_by, image_url, advertiser_id, campaign_id, priority,
     poster_url)
  VALUES
    ('camp_' || replace(v_c.id::text, '-', ''),
     CASE WHEN v_c.club_id IS NULL THEN 'other' ELSE 'club' END,
     v_c.headline, NULL, NULL,
     v_target, NULL, true,
     v_c.starts_at, v_c.ends_at, 100, v_user, v_c.image_url, v_c.advertiser_id, v_c.id, v_c.priority,
     v_c.poster_url)
  RETURNING id INTO v_ad;
  INSERT INTO public.ad_placement (ad_id, slot, club_id, audience, daily_cap, is_active, image_url)
  VALUES (v_ad, v_c.slot,
          CASE WHEN v_c.scope = 'own_club' THEN v_c.club_id ELSE NULL END,
          'all', NULL, true, v_c.image_url);
  UPDATE public.ad_campaign
     SET status = 'approved', ad_id = v_ad,
         reviewed_by = v_user, reviewed_at = now(), review_note = p_note, updated_at = now()
   WHERE id = p_campaign_id;
  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'ad_id', v_ad, 'click_code', v_code);
END;
$function$
;
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ca_commerce_refund') <> '6321c124c7112a22ae0552bfa144d5ef' THEN RAISE EXCEPTION 'refund rollback postimage drift: fn_ca_commerce_refund'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.fn_ca_commerce_refund(p_purchase_id uuid, p_line_index integer, p_amount integer, p_reason text, p_request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_p public.ca_commerce_purchases;
  v_line jsonb;
  v_line_net integer;
  v_returned integer;
  v_credited integer;
  v_existing public.ca_commerce_refunds;
  v_ref text;
  v_credit jsonb;
  v_tx public.diamond_transactions;
  v_mint public.ca_mint_ledger;
  v_refund public.ca_commerce_refunds;
  v_refund_id uuid;
  v_detail text;
  v_ent public.ca_commerce_entitlements;
  v_restore jsonb := '[]'::jsonb;
  v_left integer;
  v_lot record;
  v_take integer;
  v_debt integer;
  v_full boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'staff_required');
  END IF;
  -- A refund credits the payer through add_diamonds_to_balance, and the
  -- profile wallet guard admits that write only from a service context or a
  -- named ledgered door. This door is not named there, so a staff member's
  -- browser session cannot complete a refund; say so in JSON before any
  -- work, instead of a raw 42501 from the guard mid-refund. Staff refunds go
  -- through a service-role route. Admitting this door in the guard is a
  -- permission change for the owner to make.
  -- The same test the guard applies, so this refuses exactly when it would.
  IF NOT public.fn_is_service_context() THEN
    RETURN jsonb_build_object('success', false, 'error', 'refund_requires_service_route');
  END IF;
  IF p_request_key IS NULL OR length(p_request_key) < 8 THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_key_required');
  END IF;
  SELECT * INTO v_existing FROM public.ca_commerce_refunds WHERE request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.purchase_id <> p_purchase_id OR v_existing.line_index <> p_line_index OR v_existing.gross <> p_amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'refund_id', v_existing.id, 'gross', v_existing.gross,
      'debt_settled', v_existing.debt_settled, 'net_increase', v_existing.net_increase, 'charged_this_attempt', 0);
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_required');
  END IF;
  SELECT * INTO v_p FROM public.ca_commerce_purchases WHERE id = p_purchase_id;
  IF v_p.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;
  -- Serialize by original purchase (D40).
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_refund:' || v_p.id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_commerce_scope:' || v_p.scope_kind || ':' || v_p.scope_id::text, 0));
  -- A concurrent request with the same key committed while this one waited
  -- for the lock: return its receipt instead of a key collision.
  SELECT * INTO v_existing FROM public.ca_commerce_refunds WHERE request_key = p_request_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.purchase_id <> p_purchase_id OR v_existing.line_index <> p_line_index OR v_existing.gross <> p_amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'request_key_reused');
    END IF;
    RETURN jsonb_build_object('success', true, 'is_replay', true, 'refund_id', v_existing.id, 'gross', v_existing.gross,
      'debt_settled', v_existing.debt_settled, 'net_increase', v_existing.net_increase, 'charged_this_attempt', 0);
  END IF;
  v_line := (SELECT l FROM jsonb_array_elements(v_p.lines) l WHERE (l->>'index')::integer = p_line_index);
  IF v_line IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'line_not_found'); END IF;
  v_line_net := (v_line->>'net')::integer;
  SELECT COALESCE(SUM(r.gross), 0)::integer INTO v_returned FROM public.ca_commerce_refunds r WHERE r.purchase_id = v_p.id AND r.line_index = p_line_index;
  -- Unused value of this line already credited into an upgrade that
  -- replaced its right is spent: it cannot also come back as a refund (R2 6.4).
  SELECT COALESCE(SUM((l->>'credit')::integer), 0)::integer INTO v_credited
    FROM public.ca_commerce_entitlements e
    JOIN public.ca_commerce_entitlements n ON n.id = e.superseded_by
    JOIN public.ca_commerce_purchases u ON u.id = n.purchase_id
    CROSS JOIN LATERAL jsonb_array_elements(u.lines) l
   WHERE e.purchase_id = v_p.id AND e.line_index = p_line_index
     AND l->>'replaces_entitlement_id' = e.id::text;
  IF v_line_net = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_paid_on_this_line');
  END IF;
  IF p_amount > v_line_net - v_returned - v_credited THEN
    RETURN jsonb_build_object('success', false, 'error', 'exceeds_refundable', 'refundable', GREATEST(v_line_net - v_returned - v_credited, 0), 'credited_to_upgrade', v_credited);
  END IF;
  v_full := (v_returned + p_amount = v_line_net);
  v_refund_id := gen_random_uuid();
  v_ref := 'ca-commerce-refund:' || v_refund_id::text;
  -- The payer's wallet row first, as every canonical writer does.
  PERFORM 1 FROM public.profiles p WHERE p.id = v_p.payer_id FOR UPDATE;

  -- Exact-value door: 'refund' is in the multiplier exception list, is
  -- classified refund and registered as issuance by the existing origin rule.
  v_credit := public.add_diamonds_to_balance(v_p.payer_id, p_amount, 'refund',
    'Club And Union Diamond Costs Refund: ' || left(p_reason, 120), v_ref);
  IF NOT COALESCE((v_credit->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_REFUSED' USING DETAIL = COALESCE(v_credit->>'error', 'unknown');
  END IF;
  IF COALESCE((v_credit->>'amount')::integer, -1) <> p_amount THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_NOT_EXACT' USING DETAIL = COALESCE(v_credit->>'amount', 'null');
  END IF;
  SELECT * INTO v_tx FROM public.diamond_transactions t WHERE t.user_id = v_p.payer_id AND t.reference_id = v_ref;
  IF v_tx.id IS NULL OR v_tx.amount <> p_amount OR v_tx.issuance_class <> 'refund' THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_JOURNAL_UNPROVED' USING DETAIL = v_ref;
  END IF;
  SELECT * INTO v_mint FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = v_tx.id;
  IF v_mint.id IS NULL OR v_mint.action <> 'mint' OR v_mint.asset <> 'diamonds' OR v_mint.amount <> p_amount THEN
    RAISE EXCEPTION 'CA_COMMERCE_REFUND_REGISTER_UNPROVED' USING DETAIL = v_ref;
  END IF;
  v_debt := COALESCE((v_credit->>'debt_settled')::integer, 0);

  -- Restore operation-linked lot provenance, bounded by what this purchase
  -- consumed and by each lot's present consumed figure (D39, D65).
  v_left := p_amount;
  FOR v_lot IN SELECT (a->>'lot_id')::uuid AS lot_id, (a->>'consumed_delta')::integer AS delta FROM jsonb_array_elements(v_p.lot_allocation) a ORDER BY 1 LOOP
    EXIT WHEN v_left <= 0;
    SELECT LEAST(v_left, v_lot.delta - COALESCE((SELECT SUM((x->>'restored')::integer) FROM public.ca_commerce_refunds r, jsonb_array_elements(r.lot_restoration) x WHERE r.purchase_id = v_p.id AND x->>'lot_id' = v_lot.lot_id::text), 0), l.consumed)
      INTO v_take FROM public.diamond_purchase_lots l WHERE l.id = v_lot.lot_id FOR UPDATE;
    IF v_take IS NULL OR v_take <= 0 THEN CONTINUE; END IF;
    UPDATE public.diamond_purchase_lots SET consumed = consumed - v_take WHERE id = v_lot.lot_id;
    v_restore := v_restore || jsonb_build_object('lot_id', v_lot.lot_id, 'restored', v_take);
    v_left := v_left - v_take;
  END LOOP;

  INSERT INTO public.ca_commerce_refunds (id, purchase_id, line_index, request_key, requested_by, reason, payer_id, gross, debt_settled, net_increase, diamond_tx_id, mint_op_id, lot_restoration, revoked_entitlement)
  VALUES (v_refund_id, v_p.id, p_line_index, p_request_key, COALESCE(v_actor, v_p.payer_id), p_reason, v_p.payer_id, p_amount, v_debt, p_amount - v_debt, v_tx.id, v_mint.op_id, v_restore, v_full)
  RETURNING * INTO v_refund;

  IF v_full THEN
    UPDATE public.ca_commerce_entitlements SET state = 'revoked', updated_at = now() WHERE purchase_id = v_p.id AND line_index = p_line_index AND state = 'effective' RETURNING * INTO v_ent;
    UPDATE public.ca_commerce_renewal_mandates SET state = 'cancelled', cancelled_at = now(), updated_at = now() WHERE entitlement_id = v_ent.id AND state = 'authorized';
  END IF;
  IF v_p.sponsorship_id IS NOT NULL THEN
    UPDATE public.ca_commerce_sponsorships SET committed = GREATEST(committed - p_amount, 0) WHERE id = v_p.sponsorship_id;
  END IF;

  INSERT INTO public.ca_commerce_events (kind, actor_id, scope_kind, scope_id, reference_id, detail)
  VALUES ('refund_committed', v_actor, v_p.scope_kind, v_p.scope_id, v_refund.id, jsonb_build_object('purchase_id', v_p.id, 'line_index', p_line_index, 'gross', p_amount, 'debt_settled', v_debt, 'net_increase', p_amount - v_debt, 'full', v_full));
  PERFORM public.fn_ca_commerce_notice(v_p.payer_id, 'refund:' || v_refund.id::text, 'club_commerce_refund',
    'Refund: ' || p_amount::text || ' Diamonds',
    'Refund: ' || p_amount::text || ' Diamonds; Applied To Existing Debt: ' || v_debt::text || '; Added To Available Balance: ' || (p_amount - v_debt)::text || '.',
    '/hub/club-arena/' || v_p.scope_kind || 's/' || v_p.scope_id::text || '/diamond-costs', jsonb_build_object('refund_id', v_refund.id));

  RETURN jsonb_build_object('success', true, 'is_replay', false, 'refund_id', v_refund.id, 'gross', p_amount, 'debt_settled', v_debt,
    'net_increase', p_amount - v_debt, 'diamond_tx_id', v_tx.id, 'mint_op_id', v_mint.op_id, 'lot_restoration', v_restore, 'entitlement_revoked', v_full);
EXCEPTION
  WHEN OTHERS THEN
    -- Every write above rolled back, so nothing was credited and nothing is
    -- credited twice on a retry. A refund the wallet cannot receive yet
    -- (balance headroom, D64) is refused whole; the same request key can be
    -- retried once the wallet has room. The owed amount remains provable
    -- from the original receipt and the absence of a refund row.
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM LIKE 'CA_COMMERCE_%' THEN
      RETURN jsonb_build_object('success', false, 'error', lower(replace(SQLERRM, 'CA_COMMERCE_', '')), 'detail', v_detail, 'retry_same_request_key', true);
    END IF;
    IF SQLSTATE = '23514' THEN
      RETURN jsonb_build_object('success', false, 'error', 'wallet_cannot_receive_yet', 'detail', SQLERRM, 'retry_same_request_key', true);
    END IF;
    RAISE;
END $function$
;
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_club_ad_cancel') <> 'f293a12171b25be3e5fe9fc6bfa1e07a' THEN RAISE EXCEPTION 'refund rollback postimage drift: fn_club_ad_cancel'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.fn_club_ad_cancel(p_campaign_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  v_c    public.ad_campaign%rowtype;
  v_ref  jsonb;
  v_owner uuid;
begin
  if v_user is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select * into v_c from public.ad_campaign where id = p_campaign_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_c.club_id is not null then
    if not public.fn_club_is_staff(v_c.club_id, v_user) then
      return jsonb_build_object('ok', false, 'reason', 'not_club_staff');
    end if;
  else
    select a.owner_user_id into v_owner from public.ad_advertiser a
     where a.id = v_c.advertiser_id and a.kind = 'sponsor' and a.self_serve;
    if v_owner is null or v_owner <> v_user then
      return jsonb_build_object('ok', false, 'reason', 'not_the_advertiser');
    end if;
  end if;
  if v_c.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'not_cancellable', 'status', v_c.status);
  end if;
  if v_c.diamonds_charged > 0 then
    v_ref := public.add_diamonds_to_balance(
      v_c.submitted_by, v_c.diamonds_charged, 'refund',
      'Club advert cancelled: ' || v_c.name,
      'adcamp-refund:' || v_c.id::text
    );
    if coalesce((v_ref->>'success')::boolean, false) is not true
       and coalesce((v_ref->>'duplicate')::boolean, false) is not true then
      raise exception 'refund failed: %', v_ref->>'error';
    end if;
  end if;
  update public.ad_campaign
     set status = 'cancelled', diamonds_refunded = diamonds_charged,
         reviewed_at = now(), updated_at = now()
   where id = p_campaign_id;
  return jsonb_build_object('ok', true, 'diamonds_refunded', v_c.diamonds_charged);
end;
$function$
;
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_diamond_purchase_refund') <> '6b887e78e2292468a999cf2a297b91e8' THEN RAISE EXCEPTION 'refund rollback postimage drift: fn_diamond_purchase_refund'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.fn_diamond_purchase_refund(p_purchase_id uuid, p_charge_amount_cents integer, p_refunded_amount_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_total integer; v_cumulative integer; v_target integer; v_delta integer; v_full boolean;
  v_intent jsonb; v_redemption jsonb; v_unwind jsonb; v_wallet jsonb;
  v_unwind_state text := 'not_requested'; v_balance integer; v_daily_cost integer := 150;
  v_available integer; v_applied integer := 0; v_shortfall integer := 0;
BEGIN
  IF p_charge_amount_cents IS NULL OR p_charge_amount_cents <= 0
     OR p_refunded_amount_cents IS NULL OR p_refunded_amount_cents < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_refund_amount');
  END IF;
  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;
  v_cumulative := GREATEST(COALESCE(v_purchase.refunded_amount_cents, 0),
    LEAST(p_charge_amount_cents, p_refunded_amount_cents));
  v_full := v_cumulative >= p_charge_amount_cents;

  IF v_purchase.status = 'refunded'
     AND COALESCE((v_purchase.metadata ->> 'refund_before_settlement')::boolean, false) THEN
    UPDATE public.diamond_purchases SET refunded_amount_cents = v_cumulative, updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'fully_refunded', true,
      'terminal_refund', true, 'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0) FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status = 'pending' THEN
    IF NOT v_full THEN RETURN jsonb_build_object('success', false, 'error', 'settlement_pending'); END IF;
    UPDATE public.diamond_purchases
       SET status = 'refunded', refunded_amount_cents = v_cumulative, refunded_diamonds = 0,
           refunded_at = COALESCE(refunded_at, now()),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refund_before_settlement', true),
           updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'fully_refunded', true, 'terminal_refund', true,
      'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0) FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status NOT IN ('completed', 'refunded') THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_settled');
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'profile_not_found'); END IF;
  v_total := COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0);
  v_target := GREATEST(COALESCE(v_purchase.refunded_diamonds, 0),
    LEAST(v_total, round(v_total::numeric * v_cumulative / p_charge_amount_cents)::integer));
  v_delta := GREATEST(0, v_target - COALESCE(v_purchase.refunded_diamonds, 0));
  v_intent := COALESCE(v_purchase.metadata -> 'redemption_intent', '{}'::jsonb);
  v_redemption := COALESCE(v_purchase.metadata -> 'redemption_result', '{}'::jsonb);
  IF v_full AND COALESCE(v_purchase.metadata ->> 'redemption_status', '') = 'completed'
     AND COALESCE(v_purchase.metadata ->> 'redemption_refund_status', '') NOT IN ('revoked', 'debt_recorded') THEN
    IF v_intent ->> 'kind' = 'club_shop' AND v_redemption ? 'purchase_id' THEN
      v_unwind := public.fn_refund_shop_purchase((v_intent ->> 'club_id')::uuid,
        (v_redemption ->> 'purchase_id')::uuid, v_purchase.user_id,
        'Card-funded Club Shop purchase reversed by Stripe refund');
      v_unwind_state := CASE WHEN COALESCE((v_unwind ->> 'success')::boolean, false) THEN 'revoked' ELSE 'debt_recorded' END;
    ELSIF v_intent ->> 'kind' = 'vip_daily' THEN
      IF v_profile.vip_tier = 'daily' AND v_profile.vip_expires_at IS NOT NULL
         AND v_redemption ? 'expires_at'
         AND abs(extract(epoch FROM (v_profile.vip_expires_at - (v_redemption ->> 'expires_at')::timestamptz))) < 2 THEN
        UPDATE public.profiles SET vip_expires_at = GREATEST(now(), vip_expires_at - interval '1 day'),
          is_vip = (vip_expires_at - interval '1 day') > now(), updated_at = now()
         WHERE id = v_purchase.user_id;
        v_wallet := public.add_diamonds_to_balance(v_purchase.user_id, v_daily_cost, 'refund',
          'Reversed card-funded VIP Daily Pass', 'card-redemption-refund:' || v_purchase.id::text);
        IF COALESCE((v_wallet ->> 'success')::boolean, false) IS NOT TRUE
           AND COALESCE((v_wallet ->> 'duplicate')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'daily_redemption_refund_failed:%', COALESCE(v_wallet ->> 'error', 'unknown');
        END IF;
        v_unwind_state := 'revoked';
      ELSE v_unwind_state := 'debt_recorded'; END IF;
    END IF;
  END IF;

  IF v_delta > 0 THEN
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_available FROM public.profiles WHERE id = v_purchase.user_id;
    v_available := GREATEST(COALESCE(v_available, 0), 0);
    v_applied := LEAST(v_delta, v_available);
    v_shortfall := v_delta - v_applied;

    IF v_applied > 0 THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, diamond_balance, 0) - v_applied,
             diamond_balance = COALESCE(diamonds, diamond_balance, 0) - v_applied, updated_at = now()
       WHERE id = v_purchase.user_id RETURNING diamonds INTO v_balance;
    ELSE
      v_balance := v_available;
    END IF;

    IF v_shortfall > 0 THEN
      INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason)
      VALUES (v_purchase.user_id, v_purchase.id, v_shortfall, 'chargeback_exceeds_balance');
      BEGIN
        PERFORM public.fn_ca_diamond_incident('DR1:chargeback_exceeds_balance', 'critical', v_purchase.user_id, v_shortfall,
          'fn_diamond_purchase_refund',
          jsonb_build_object('purchase_id', v_purchase.id, 'reversal_owed', v_delta, 'balance_applied', v_applied,
                             'debt_booked', v_shortfall, 'balance_after', v_balance));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;

    INSERT INTO public.diamond_transactions(user_id,type,amount,balance_after,description,
      reference_id,transaction_type,source,metadata,counterparty,issuance_class)
    VALUES (v_purchase.user_id,'refund',-v_applied,v_balance,'Stripe refund',
      'diamond-refund:' || v_purchase.id::text || ':' || v_target,'refund','stripe',
      jsonb_build_object('purchase_id',v_purchase.id,'chargeback_debt',v_shortfall > 0,
        'reversal_owed',v_delta,'balance_applied',v_applied,'debt_booked',v_shortfall),
      'purchase_clearing','refund');

    -- DR9: the lot carries what was reversed. A failure here is loud (review R2-13), never fatal.
    BEGIN
      UPDATE public.diamond_purchase_lots
         SET refunded = LEAST(issued - consumed, GREATEST(refunded, v_target))
       WHERE purchase_id = v_purchase.id;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.fn_ca_diamond_incident('DR9:purchase_lot_write_failed', 'critical', v_purchase.user_id, v_target,
          'fn_diamond_purchase_refund',
          jsonb_build_object('purchase_id', v_purchase.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'target', v_target));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END;
  ELSE
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_balance FROM public.profiles WHERE id = v_purchase.user_id;
  END IF;
  UPDATE public.diamond_purchases
     SET refunded_amount_cents = v_cumulative, refunded_diamonds = v_target,
         refunded_at = CASE WHEN v_full THEN COALESCE(refunded_at,now()) ELSE refunded_at END,
         status = CASE WHEN v_full THEN 'refunded' ELSE status END,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'redemption_refund_status',v_unwind_state,'refund_balance_after',v_balance,
           'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,
           'refunded_diamonds',v_target), updated_at=now()
   WHERE id=v_purchase.id;
  RETURN jsonb_build_object('success',true,'fully_refunded',v_full,'refunded_diamonds',v_target,
    'new_balance',v_balance,'redemption_refund_status',v_unwind_state,
    'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,'balance_applied',v_applied);
END;
$function$
;
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_refund_shop_purchase') <> 'e0af5916fa25f7f1d69f4479fb156814' THEN RAISE EXCEPTION 'refund rollback postimage drift: fn_refund_shop_purchase'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.fn_refund_shop_purchase(p_club_id uuid, p_purchase_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_purchase public.club_shop_purchases;
  v_inv      public.club_shop_inventory;
  v_credit   jsonb;
  v_saved    jsonb;
BEGIN
  SELECT * INTO v_purchase FROM public.club_shop_purchases
   WHERE id = p_purchase_id AND club_id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found');
  END IF;
  IF v_purchase.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'already_refunded', true, 'amount', v_purchase.price_paid
    );
  END IF;

  SELECT * INTO v_inv FROM public.club_shop_inventory
   WHERE purchase_id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_delivered');
  END IF;
  IF v_inv.status = 'redeemed' OR v_inv.redeemed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'already_redeemed',
      'detail', 'The purchased benefit was already delivered and cannot be revoked automatically.'
    );
  END IF;

  IF v_inv.status <> 'refunded' THEN
    UPDATE public.club_shop_inventory SET status = 'refunded' WHERE id = v_inv.id;
  END IF;

  IF v_purchase.currency = 'diamonds' THEN
    v_credit := public.add_diamonds_to_balance(
      v_purchase.buyer_id, v_purchase.price_paid, 'refund',
      COALESCE(NULLIF(p_reason, ''), 'Club Shop Purchase Refund'),
      'ca-shop-refund-' || p_purchase_id::text
    );
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE
       AND COALESCE((v_credit->>'duplicate')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'diamond refund credit failed: %', COALESCE(v_credit->>'error', 'unknown');
    END IF;
  ELSE
    /* THE REFUND NAMES WHERE ITS CHIPS COME FROM (2026-10-02, 20261002165749).
       A chip purchase retired its price (chip_debit, no recipient), so the
       refund puts those chips back into circulation: issuance_reserve,
       category refund, under this purchase's own operation key. Undeclared,
       fn_credit_chips refuses by name. The caller's declaration is restored. */
    v_saved := public.fn_ca_ledger_declaration_save(NULL);
    PERFORM public.fn_ca_declare_ledger('refund', 'issuance_reserve', NULL, NULL,
      'ca-shop-refund-' || p_purchase_id::text, NULL);
    v_credit := public.fn_credit_chips(
      p_club_id, v_purchase.buyer_id, v_purchase.price_paid,
      COALESCE(NULLIF(p_reason, ''), 'Shop purchase refund'),
      jsonb_build_object(
        'transaction_type', 'refund', 'purchase_id', p_purchase_id,
        'refunded_by', p_actor_id
      )
    );
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'refund credit failed: %', COALESCE(v_credit->>'error', 'unknown');
    END IF;
    PERFORM public.fn_ca_ledger_declaration_restore(v_saved);
  END IF;

  UPDATE public.club_shop_purchases SET refunded_at = now() WHERE id = p_purchase_id;
  IF v_purchase.stock_claimed THEN
    UPDATE public.club_shop_items SET stock = stock + 1
     WHERE id = v_purchase.item_id AND club_id = p_club_id AND stock IS NOT NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'amount', v_purchase.price_paid, 'currency', v_purchase.currency,
    'buyer_id', v_purchase.buyer_id,
    'balance_after', COALESCE(v_credit->'new_balance', v_credit->'balance_after')
  );
END;
$function$
;
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_diamond_merch_order_atomic') <> '49235e828a91f44e49324cff92c6969a' THEN RAISE EXCEPTION 'refund rollback postimage drift: refund_diamond_merch_order_atomic'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.refund_diamond_merch_order_atomic(p_order_id uuid, p_actor_id uuid, p_reference_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_order public.merchandise_orders%ROWTYPE;
  v_from_status text;
  v_refund integer;
  v_wallet jsonb;
  v_stock_lines jsonb;
BEGIN
  IF p_reference_id IS NULL OR length(p_reference_id) < 16 OR length(p_reference_id) > 180 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reference');
  END IF;

  SELECT * INTO v_order
    FROM public.merchandise_orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;
  IF v_order.payment_method <> 'diamonds' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_diamond_order');
  END IF;
  IF v_order.status IN ('shipped', 'delivered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_fulfilled');
  END IF;
  IF COALESCE(v_order.metadata ->> 'fulfillment_mode', '') = 'automatic'
     OR NULLIF(v_order.metadata ->> 'printful_order_id', '') IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'provider_cancellation_required'
    );
  END IF;
  v_from_status := v_order.status;

  v_refund := GREATEST(0, v_order.diamonds_spent - v_order.refunded_diamonds);
  IF v_refund = 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'order_id', v_order.id,
      'refunded_diamonds', v_order.refunded_diamonds
    );
  END IF;

  v_wallet := public.add_diamonds_to_balance(
    v_order.user_id,
    v_refund,
    'refund',
    'Refund - Diamond merchandise order ' || v_order.id::text,
    p_reference_id
  );
  IF COALESCE((v_wallet ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Diamond merchandise refund wallet credit failed: %',
      COALESCE(v_wallet ->> 'error', 'unknown_error');
  END IF;

  IF NOT v_order.stock_restored THEN
    SELECT jsonb_agg(jsonb_build_object(
      'id', item ->> 'id',
      'variant_id', item ->> 'variantId',
      'qty', (item ->> 'quantity')::integer
    )) INTO v_stock_lines
      FROM jsonb_array_elements(v_order.items) AS item
     WHERE COALESCE((item ->> 'madeToOrder')::boolean, false) IS NOT TRUE;
    IF v_stock_lines IS NOT NULL THEN
      PERFORM public.release_merch_order(v_stock_lines);
    END IF;
  END IF;

  UPDATE public.merchandise_orders
     SET status = 'refunded',
         refunded_diamonds = diamonds_spent,
         refunded_at = now(),
         stock_restored = true,
         fulfillment_version = fulfillment_version + 1,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'fulfillment_status', 'refunded',
           'needs_review', false,
           'refunded_by', p_actor_id,
           'refunded_at', now()
         ),
         updated_at = now()
   WHERE id = v_order.id
   RETURNING * INTO v_order;

  INSERT INTO public.merchandise_order_events(
    order_id, actor_id, action, from_status, to_status, details
  ) VALUES (
    v_order.id, p_actor_id, 'refund', v_from_status, 'refunded',
    jsonb_build_object('diamonds', v_refund, 'reference_id', p_reference_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'duplicate', false,
    'order_id', v_order.id,
    'refunded_diamonds', v_refund,
    'new_balance', v_wallet -> 'new_balance',
    'fulfillment_version', v_order.fulfillment_version
  );
END;
$function$
;
DO $rollback$ BEGIN IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refund_diamond_merch_order_atomic_v2') <> '67cdbbf677a4cca0c186c402e35e7267' THEN RAISE EXCEPTION 'refund rollback postimage drift: refund_diamond_merch_order_atomic_v2'; END IF; END $rollback$;
CREATE OR REPLACE FUNCTION public.refund_diamond_merch_order_atomic_v2(p_order_id uuid, p_actor_id uuid, p_expected_version integer, p_reference_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_order public.merchandise_orders%ROWTYPE;
  v_from_status text;
  v_refund integer;
  v_wallet jsonb;
  v_stock_lines jsonb;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_version');
  END IF;
  IF p_reference_id IS NULL OR length(p_reference_id) < 16 OR length(p_reference_id) > 180 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_reference');
  END IF;

  SELECT * INTO v_order
    FROM public.merchandise_orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;
  IF v_order.payment_method <> 'diamonds' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_diamond_order');
  END IF;

  v_refund := GREATEST(0, v_order.diamonds_spent - v_order.refunded_diamonds);
  IF v_refund = 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'order_id', v_order.id,
      'refunded_diamonds', v_order.refunded_diamonds,
      'fulfillment_version', v_order.fulfillment_version
    );
  END IF;

  IF v_order.fulfillment_version IS DISTINCT FROM p_expected_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'version_conflict',
      'fulfillment_version', v_order.fulfillment_version
    );
  END IF;
  IF v_order.status IN ('shipped', 'delivered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_fulfilled');
  END IF;
  IF COALESCE(v_order.metadata ->> 'fulfillment_mode', '') = 'automatic'
     OR NULLIF(v_order.metadata ->> 'printful_order_id', '') IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'provider_cancellation_required'
    );
  END IF;
  v_from_status := v_order.status;

  v_wallet := public.add_diamonds_to_balance(
    v_order.user_id,
    v_refund,
    'refund',
    'Refund - Diamond merchandise order ' || v_order.id::text,
    p_reference_id
  );
  IF COALESCE((v_wallet ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Diamond merchandise refund wallet credit failed: %',
      COALESCE(v_wallet ->> 'error', 'unknown_error');
  END IF;

  IF NOT v_order.stock_restored THEN
    SELECT jsonb_agg(jsonb_build_object(
      'id', item ->> 'id',
      'variant_id', item ->> 'variantId',
      'qty', (item ->> 'quantity')::integer
    )) INTO v_stock_lines
      FROM jsonb_array_elements(v_order.items) AS item
     WHERE COALESCE((item ->> 'madeToOrder')::boolean, false) IS NOT TRUE;
    IF v_stock_lines IS NOT NULL THEN
      PERFORM public.release_merch_order(v_stock_lines);
    END IF;
  END IF;

  UPDATE public.merchandise_orders
     SET status = 'refunded',
         refunded_diamonds = diamonds_spent,
         refunded_at = now(),
         stock_restored = true,
         fulfillment_version = fulfillment_version + 1,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'fulfillment_status', 'refunded',
           'needs_review', false,
           'refunded_by', p_actor_id,
           'refunded_at', now()
         ),
         updated_at = now()
   WHERE id = v_order.id
   RETURNING * INTO v_order;

  INSERT INTO public.merchandise_order_events(
    order_id, actor_id, action, from_status, to_status, details
  ) VALUES (
    v_order.id, p_actor_id, 'refund', v_from_status, 'refunded',
    jsonb_build_object('diamonds', v_refund, 'reference_id', p_reference_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'duplicate', false,
    'order_id', v_order.id,
    'refunded_diamonds', v_refund,
    'new_balance', v_wallet -> 'new_balance',
    'fulfillment_version', v_order.fulfillment_version
  );
END;
$function$
;
DROP FUNCTION public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text);
DROP TRIGGER ca_emergency_registration ON public.tournament_players;
DROP TRIGGER ca_emergency_positive_issuance ON public.ca_mint_ledger;
DROP TRIGGER aa_ca_emergency_diamond_issuance ON public.diamond_transactions;
DROP TRIGGER ca_emergency_cashout ON public.cashout_requests;
DROP TRIGGER zz_ca_funded_return_journal ON public.chip_ledger;
DROP FUNCTION public.fn_ca_emergency_registration_guard();
DROP FUNCTION public.fn_ca_emergency_issuance_guard();
DROP FUNCTION public.fn_ca_emergency_diamond_journal_guard();
DROP FUNCTION public.fn_ca_emergency_cashout_guard();
DROP FUNCTION public.fn_ca_funded_chip_return_journal();
DROP FUNCTION public.fn_ca_authorize_funded_return(text,uuid,text,uuid,numeric,text);
DROP FUNCTION public.fn_ca_set_emergency_stop(text,boolean,bigint,text,uuid,uuid,text);
DROP FUNCTION public.fn_ca_assert_emergency_path(text);
DELETE FROM public.ca_declared_money_triggers WHERE (table_name,trigger_name) IN (('tournament_players','ca_emergency_registration'),('chip_ledger','zz_ca_funded_return_journal'));
