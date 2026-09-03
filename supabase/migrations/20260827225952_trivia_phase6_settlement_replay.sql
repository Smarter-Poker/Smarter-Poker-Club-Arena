-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827225952; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Trivia phase 6: atomic/replayable settlement, streak/item wiring, deadline
-- enforcement, and failure-safe prize-wheel credits.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_trivia_session_answer(
    p_session_id uuid, p_user_id uuid, p_question_id uuid, p_display_index integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_session public.trivia_sessions%ROWTYPE;
    v_key text := p_question_id::text;
    v_stored jsonb;
BEGIN
    IF p_session_id IS NULL OR p_user_id IS NULL OR p_question_id IS NULL THEN
        RETURN jsonb_build_object('success',false,'error','missing_arguments');
    END IF;
    UPDATE public.trivia_sessions
       SET answers = answers || jsonb_build_object(
           v_key, jsonb_build_object(
               'd',GREATEST(-1,COALESCE(p_display_index,-1)),
               'n',(SELECT count(*) FROM jsonb_object_keys(answers)),
               'at',now()
           ))
     WHERE id=p_session_id AND user_id=p_user_id AND status='open'
       AND (expires_at IS NULL OR now() <= expires_at)
       AND question_ids @> ARRAY[p_question_id] AND NOT (answers ? v_key)
    RETURNING * INTO v_session;
    IF FOUND THEN
        RETURN jsonb_build_object('success',true,'stored',v_session.answers->v_key,'fresh',true);
    END IF;
    SELECT * INTO v_session FROM public.trivia_sessions
     WHERE id=p_session_id AND user_id=p_user_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','session_not_found'); END IF;
    IF v_session.status<>'open' THEN RETURN jsonb_build_object('success',false,'error','session_closed'); END IF;
    IF v_session.expires_at IS NOT NULL AND now()>v_session.expires_at THEN
        RETURN jsonb_build_object('success',false,'error','session_expired','expires_at',v_session.expires_at);
    END IF;
    IF NOT (v_session.question_ids @> ARRAY[p_question_id]) THEN
        RETURN jsonb_build_object('success',false,'error','question_not_in_session');
    END IF;
    v_stored:=v_session.answers->v_key;
    IF v_stored IS NOT NULL THEN
        RETURN jsonb_build_object('success',true,'stored',v_stored,'fresh',false);
    END IF;
    RETURN jsonb_build_object('success',false,'error','not_recorded');
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_trivia_session_answer(uuid,uuid,uuid,integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_trivia_session_answer(uuid,uuid,uuid,integer)
    TO service_role;

CREATE OR REPLACE FUNCTION public.award_trivia_run(
    p_session_id uuid, p_score integer, p_correct integer,
    p_total integer, p_diamonds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_session public.trivia_sessions%ROWTYPE;
    v_score int:=GREATEST(0,COALESCE(p_score,0));
    v_correct int:=GREATEST(0,COALESCE(p_correct,0));
    v_total int:=GREATEST(0,COALESCE(p_total,0));
    v_award int:=GREATEST(0,COALESCE(p_diamonds,0));
    v_result jsonb;
BEGIN
    IF p_session_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','missing_session_id'); END IF;
    IF v_correct>v_total THEN RETURN jsonb_build_object('success',false,'error','correct_exceeds_total'); END IF;
    UPDATE public.trivia_sessions SET status='submitted',submitted_at=now(),score=v_score,
           correct_count=v_correct,diamonds_awarded=v_award
     WHERE id=p_session_id AND status='open' RETURNING * INTO v_session;
    IF NOT FOUND THEN
        IF NOT EXISTS(SELECT 1 FROM public.trivia_sessions WHERE id=p_session_id) THEN
            RETURN jsonb_build_object('success',false,'error','session_not_found');
        END IF;
        RETURN jsonb_build_object('success',false,'error','already_submitted');
    END IF;
    IF v_award>0 THEN
        SELECT public.add_diamonds_to_balance(
            v_session.user_id,v_award,'trivia_run',
            'Trivia run reward ('||COALESCE(v_session.mode,'unknown')||')',
            'trivia_session_'||p_session_id::text
        ) INTO v_result;
        IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE
           AND COALESCE((v_result->>'duplicate')::boolean,false) IS NOT TRUE THEN
            RAISE EXCEPTION 'trivia payout rejected: %',COALESCE(v_result->>'error','unknown');
        END IF;
    END IF;
    RETURN jsonb_build_object('success',true,'session_id',p_session_id,'score',v_score,
        'correct_count',v_correct,'diamonds_awarded',v_award,
        'deduped',COALESCE((v_result->>'duplicate')::boolean,false),
        'new_balance',v_result->'new_balance');
END;
$$;

CREATE OR REPLACE FUNCTION public.award_trivia_run_v2(
    p_session_id uuid, p_score int, p_correct int, p_total int,
    p_answered int, p_diamonds int
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_session public.trivia_sessions%ROWTYPE;
    v_award jsonb;
    v_result jsonb;
    v_bonus jsonb;
    v_score_id uuid;
    v_existing public.trivia_scores%ROWTYPE;
    v_streak public.trivia_streaks%ROWTYPE;
    v_play_date date:=(now() AT TIME ZONE 'America/Chicago')::date;
    v_total_for_stats int;
    v_mode_cap int;
    v_earned_today int;
    v_clamped int;
    v_bonus_amount int:=0;
    v_new_streak int:=0;
    v_gap int;
    v_item_qty int;
BEGIN
    SELECT * INTO v_session FROM public.trivia_sessions WHERE id=p_session_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','session_not_found'); END IF;
    IF v_session.user_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','session_owner_missing'); END IF;
    IF v_session.status='submitted' THEN
        IF v_session.settlement_result IS NOT NULL THEN
            RETURN v_session.settlement_result || jsonb_build_object('replayed',true);
        END IF;
        SELECT id INTO v_score_id FROM public.trivia_scores WHERE session_id=p_session_id LIMIT 1;
        RETURN jsonb_build_object('success',true,'replayed',true,'session_id',p_session_id,
            'score',v_session.score,'correct_count',v_session.correct_count,
            'diamonds_awarded',COALESCE(v_session.diamonds_awarded,0),'score_id',v_score_id);
    END IF;
    IF v_session.status<>'open' THEN RETURN jsonb_build_object('success',false,'error','session_closed'); END IF;

    IF v_session.mode IN ('arcade','mtt','cash','icm','gto','mixed','endless','survival','time-attack')
       AND v_session.entry_state NOT IN ('charged','vip','continuation','ticket') THEN
        RETURN jsonb_build_object('success',false,'error','entry_not_verified');
    END IF;
    v_total_for_stats:=CASE WHEN v_session.mode IN ('endless','time-attack')
        THEN GREATEST(COALESCE(p_answered,0),COALESCE(p_correct,0))
        ELSE GREATEST(COALESCE(p_total,0),COALESCE(p_correct,0)) END;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        v_session.user_id::text||':'||v_session.mode||':'||v_play_date::text,0));
    v_mode_cap:=CASE v_session.mode
        WHEN 'daily' THEN 10 WHEN 'history' THEN 10 WHEN 'rules' THEN 10 WHEN 'pro' THEN 10
        WHEN 'arcade' THEN 40 WHEN 'survival' THEN 80 WHEN 'mtt' THEN 40
        WHEN 'cash' THEN 40 WHEN 'icm' THEN 40 WHEN 'gto' THEN 60
        WHEN 'mixed' THEN 40 WHEN 'endless' THEN 40 WHEN 'time-attack' THEN 40 ELSE 0 END;
    SELECT COALESCE(sum(diamonds_awarded),0)::int INTO v_earned_today
      FROM public.trivia_sessions WHERE user_id=v_session.user_id AND mode=v_session.mode
       AND status='submitted'
       AND (COALESCE(submitted_at,created_at) AT TIME ZONE 'America/Chicago')::date=v_play_date;
    v_clamped:=LEAST(GREATEST(COALESCE(p_diamonds,0),0),GREATEST(v_mode_cap-v_earned_today,0));

    SELECT public.award_trivia_run(p_session_id,p_score,p_correct,p_total,v_clamped) INTO v_award;
    IF COALESCE((v_award->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_award; END IF;

    IF v_session.mode='daily' THEN
        SELECT * INTO v_existing FROM public.trivia_scores
         WHERE user_id=v_session.user_id AND mode='daily' AND play_date=v_play_date
         ORDER BY created_at LIMIT 1 FOR UPDATE;
        IF FOUND THEN
            IF v_existing.server_verified IS NOT TRUE OR COALESCE(p_score,0)>COALESCE(v_existing.score,0) THEN
                UPDATE public.trivia_scores SET score=GREATEST(COALESCE(p_score,0),0),
                    correct_count=GREATEST(COALESCE(p_correct,0),0),total_questions=v_total_for_stats,
                    diamonds_earned=v_clamped,session_id=p_session_id,server_verified=true
                 WHERE id=v_existing.id RETURNING id INTO v_score_id;
            ELSE
                v_score_id:=v_existing.id;
            END IF;
        ELSE
            INSERT INTO public.trivia_scores(user_id,username,mode,score,correct_count,total_questions,
                diamonds_earned,play_date,session_id,server_verified)
            SELECT v_session.user_id,p.username,'daily',GREATEST(COALESCE(p_score,0),0),
                GREATEST(COALESCE(p_correct,0),0),v_total_for_stats,v_clamped,v_play_date,p_session_id,true
              FROM public.profiles p WHERE p.id=v_session.user_id RETURNING id INTO v_score_id;
        END IF;
    ELSE
        INSERT INTO public.trivia_scores(user_id,username,mode,score,correct_count,total_questions,
            diamonds_earned,play_date,session_id,server_verified)
        SELECT v_session.user_id,p.username,v_session.mode,GREATEST(COALESCE(p_score,0),0),
            GREATEST(COALESCE(p_correct,0),0),v_total_for_stats,v_clamped,v_play_date,p_session_id,true
          FROM public.profiles p WHERE p.id=v_session.user_id RETURNING id INTO v_score_id;
    END IF;
    IF v_score_id IS NULL THEN RAISE EXCEPTION 'profile_not_found_for_trivia_score'; END IF;

    -- Streak totals now follow the verified settlement path. A shield protects
    -- exactly one missed day and its consumption has an immutable ledger row.
    SELECT * INTO v_streak FROM public.trivia_streaks WHERE user_id=v_session.user_id FOR UPDATE;
    IF NOT FOUND THEN
        v_new_streak:=CASE WHEN v_session.mode='daily' THEN 1 ELSE 0 END;
        INSERT INTO public.trivia_streaks(user_id,current_streak,best_streak,last_play_date,
            total_games_played,total_correct,updated_at)
        VALUES(v_session.user_id,v_new_streak,v_new_streak,
            CASE WHEN v_session.mode='daily' THEN v_play_date ELSE NULL END,
            1,GREATEST(COALESCE(p_correct,0),0),now());
    ELSE
        v_new_streak:=COALESCE(v_streak.current_streak,0);
        IF v_session.mode='daily' AND v_streak.last_play_date IS DISTINCT FROM v_play_date THEN
            v_gap:=CASE WHEN v_streak.last_play_date IS NULL THEN NULL ELSE v_play_date-v_streak.last_play_date END;
            IF v_gap IS NULL THEN v_new_streak:=1;
            ELSIF v_gap=1 THEN v_new_streak:=v_new_streak+1;
            ELSIF v_gap=2 THEN
                UPDATE public.trivia_user_items SET quantity=quantity-1,updated_at=now()
                 WHERE user_id=v_session.user_id AND item_type='streak_shield' AND quantity>0
                RETURNING quantity INTO v_item_qty;
                IF FOUND THEN
                    v_new_streak:=v_new_streak+1;
                    INSERT INTO public.trivia_item_transactions(
                        user_id,item_type,amount,balance_after,transaction_type,reference_id,metadata)
                    VALUES(v_session.user_id,'streak_shield',-1,v_item_qty,'streak_protection',
                        'trivia_shield_'||p_session_id::text,jsonb_build_object('session_id',p_session_id));
                ELSE v_new_streak:=1; END IF;
            ELSE v_new_streak:=1; END IF;
        END IF;
        UPDATE public.trivia_streaks SET current_streak=v_new_streak,
            best_streak=GREATEST(COALESCE(best_streak,0),v_new_streak),
            last_play_date=CASE WHEN v_session.mode='daily' THEN v_play_date ELSE last_play_date END,
            total_games_played=COALESCE(total_games_played,0)+1,
            total_correct=COALESCE(total_correct,0)+GREATEST(COALESCE(p_correct,0),0),updated_at=now()
         WHERE user_id=v_session.user_id;
    END IF;

    IF v_session.mode='daily' AND COALESCE(p_total,0)>=10 AND COALESCE(p_answered,0)>=p_total THEN
        SELECT public.add_diamonds_to_balance(v_session.user_id,10,'trivia_daily_bonus',
            'Daily trivia completion bonus','trivia_daily_bonus_'||v_session.user_id::text||'_'||v_play_date::text)
          INTO v_bonus;
        IF COALESCE((v_bonus->>'success')::boolean,false) IS TRUE THEN v_bonus_amount:=10;
        ELSIF COALESCE((v_bonus->>'duplicate')::boolean,false) IS NOT TRUE THEN
            RAISE EXCEPTION 'daily bonus rejected: %',COALESCE(v_bonus->>'error','unknown');
        END IF;
    END IF;

    v_result:=v_award||jsonb_build_object('score_id',v_score_id,
        'daily_bonus_awarded',v_bonus_amount,
        'new_balance',COALESCE(v_bonus->'new_balance',v_award->'new_balance'),
        'replayed',false);
    UPDATE public.trivia_sessions SET settlement_result=v_result WHERE id=p_session_id;
    RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.award_trivia_run_v2(uuid,int,int,int,int,int)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_trivia_run_v2(uuid,int,int,int,int,int) TO service_role;

-- Item grants are valuable now that tickets/shields are consumed. Only the
-- verified wheel/settlement functions may mutate inventory.
REVOKE EXECUTE ON FUNCTION public.fn_trivia_grant_item(text,integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trivia_grant_item(text,integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_trivia_consume_item(text,integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_trivia_consume_item(text,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_trivia_prize_wheel_spin(p_score_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
    v_user uuid:=(SELECT auth.uid());
    v_score record;
    v_existing public.trivia_prize_wheel_spins%ROWTYPE;
    v_roll int; v_prize_id text; v_type text; v_base int;
    v_streak int:=0; v_mult numeric(4,2):=1; v_amount int;
    v_credit jsonb; v_item_qty int;
BEGIN
    IF (SELECT auth.role())='service_role' THEN
        SELECT user_id INTO v_user FROM public.trivia_scores WHERE id=p_score_id;
    END IF;
    IF v_user IS NULL THEN RETURN jsonb_build_object('success',false,'error','not_authenticated'); END IF;
    SELECT s.id,s.user_id,s.correct_count,s.total_questions,s.created_at,s.session_id,s.server_verified
      INTO v_score FROM public.trivia_scores s WHERE s.id=p_score_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','score_not_found'); END IF;
    IF v_score.user_id IS DISTINCT FROM v_user THEN RETURN jsonb_build_object('success',false,'error','not_your_score'); END IF;
    IF v_score.server_verified IS NOT TRUE OR v_score.session_id IS NULL OR NOT EXISTS(
        SELECT 1 FROM public.trivia_sessions ts WHERE ts.id=v_score.session_id
         AND ts.user_id=v_user AND ts.status='submitted' AND ts.correct_count=v_score.correct_count
    ) THEN RETURN jsonb_build_object('success',false,'error','score_not_server_verified'); END IF;
    IF COALESCE(v_score.total_questions,0)<5 OR v_score.correct_count IS DISTINCT FROM v_score.total_questions THEN
        RETURN jsonb_build_object('success',false,'error','not_a_perfect_game');
    END IF;
    IF v_score.created_at<now()-interval '30 minutes' THEN RETURN jsonb_build_object('success',false,'error','spin_window_expired'); END IF;
    SELECT * INTO v_existing FROM public.trivia_prize_wheel_spins WHERE score_id=p_score_id;
    IF FOUND THEN RETURN jsonb_build_object('success',true,'deduped',true,'prize_id',v_existing.prize_id,
        'prize_type',v_existing.prize_type,'prize_amount',v_existing.prize_amount,'multiplier',v_existing.multiplier); END IF;
    v_roll:=floor(random()*100)::int;
    IF v_roll<30 THEN v_prize_id:='diamond_5';v_type:='diamonds';v_base:=5;
    ELSIF v_roll<55 THEN v_prize_id:='diamond_10';v_type:='diamonds';v_base:=10;
    ELSIF v_roll<70 THEN v_prize_id:='diamond_25';v_type:='diamonds';v_base:=25;
    ELSIF v_roll<80 THEN v_prize_id:='diamond_50';v_type:='diamonds';v_base:=50;
    ELSIF v_roll<85 THEN v_prize_id:='diamond_100';v_type:='diamonds';v_base:=100;
    ELSIF v_roll<93 THEN v_prize_id:='streak_shield';v_type:='streak_shield';v_base:=1;
    ELSIF v_roll<98 THEN v_prize_id:='free_entry';v_type:='arcade_ticket';v_base:=1;
    ELSE v_prize_id:='mystery';v_type:='diamonds';v_base:=15; END IF;
    SELECT COALESCE(current_streak,0) INTO v_streak FROM public.trivia_streaks WHERE user_id=v_user;
    v_mult:=CASE WHEN v_streak>=100 THEN 5 WHEN v_streak>=30 THEN 3 WHEN v_streak>=14 THEN 2.5 WHEN v_streak>=7 THEN 2 ELSE 1 END;
    IF v_type='diamonds' THEN v_amount:=floor(v_base*v_mult)::int; ELSE v_amount:=v_base;v_mult:=1; END IF;
    INSERT INTO public.trivia_prize_wheel_spins(user_id,score_id,prize_id,prize_type,prize_amount,multiplier)
    VALUES(v_user,p_score_id,v_prize_id,v_type,v_amount,v_mult);
    IF v_type='diamonds' THEN
        SELECT public.add_diamonds_to_balance(v_user,v_amount,'trivia_prize_wheel',
            'Prize Wheel - '||v_prize_id,'trivia_wheel_'||p_score_id::text) INTO v_credit;
        IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE
           AND COALESCE((v_credit->>'duplicate')::boolean,false) IS NOT TRUE THEN
            RAISE EXCEPTION 'wheel credit rejected: %',COALESCE(v_credit->>'error','unknown');
        END IF;
    ELSE
        INSERT INTO public.trivia_user_items AS i(user_id,item_type,quantity,created_at,updated_at)
        VALUES(v_user,v_type,v_amount,now(),now()) ON CONFLICT(user_id,item_type)
        DO UPDATE SET quantity=i.quantity+v_amount,updated_at=now() RETURNING quantity INTO v_item_qty;
        INSERT INTO public.trivia_item_transactions(user_id,item_type,amount,balance_after,
            transaction_type,reference_id,metadata)
        VALUES(v_user,v_type,v_amount,v_item_qty,'prize_wheel','trivia_wheel_item_'||p_score_id::text,
            jsonb_build_object('score_id',p_score_id,'prize_id',v_prize_id));
    END IF;
    RETURN jsonb_build_object('success',true,'deduped',false,'prize_id',v_prize_id,
        'prize_type',v_type,'prize_amount',v_amount,'multiplier',v_mult,'credit',v_credit);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_trivia_prize_wheel_spin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_trivia_prize_wheel_spin(uuid) TO authenticated,service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

