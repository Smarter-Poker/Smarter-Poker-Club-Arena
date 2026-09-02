-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827225945; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Trivia phase 6: exact-value economy, atomic entries, durable inventory, and
-- authoritative session deadlines.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS diamond_transactions_user_reference_uidx
    ON public.diamond_transactions (user_id, reference_id)
    WHERE reference_id IS NOT NULL;

-- Exact-conservation Trivia types never receive the profile multiplier.
-- Trivia already has mode/wheel multipliers; applying the wallet multiplier
-- again inflated escrows, refunds, capped awards and prize pools.
CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(
    p_user_id uuid,
    p_amount integer,
    p_type text DEFAULT 'bonus'::text,
    p_description text DEFAULT NULL::text,
    p_reference_id text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_old_balance integer;
    v_new_balance integer;
    v_txn_id uuid;
    v_multiplier numeric(4,2) := 1.00;
    v_raw_amount integer := COALESCE(p_amount, 0);
    v_actual_amount integer;
    v_exact_type boolean;
BEGIN
    v_exact_type := p_type IN (
        'trivia_entry', 'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
        'pvp_stake', 'pvp_win', 'pvp_refund', 'pvp_tie_refund',
        'tournament_entry', 'tournament_entry_refund',
        'tournament_cancel_refund', 'tournament_prize'
    );

    IF p_reference_id IS NULL AND v_exact_type THEN
        RETURN jsonb_build_object('success', false, 'error', 'reference_id_required',
                                  'reference_required', true);
    END IF;

    IF p_reference_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.diamond_transactions
         WHERE user_id = p_user_id AND reference_id = p_reference_id
    ) THEN
        SELECT balance_after INTO v_new_balance
          FROM public.diamond_transactions
         WHERE user_id = p_user_id AND reference_id = p_reference_id
         LIMIT 1;
        RETURN jsonb_build_object('success', false, 'error', 'duplicate_reference',
                                  'duplicate', true, 'new_balance', v_new_balance);
    END IF;

    SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
      INTO v_old_balance, v_multiplier
      FROM public.profiles WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
    END IF;

    IF v_raw_amount > 0
       AND NOT v_exact_type
       AND p_type NOT IN (
           'purchase', 'deduction', 'adjustment', 'refund', 'transfer',
           'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
           'diamond_received', 'live_gift_received', 'live_gift_sent',
           'vip_daily', 'vip_stipend'
       )
       AND v_multiplier > 1.00 THEN
        v_actual_amount := round(v_raw_amount * v_multiplier);
    ELSE
        v_actual_amount := v_raw_amount;
        v_multiplier := 1.00;
    END IF;

    v_new_balance := v_old_balance + v_actual_amount;
    IF v_new_balance < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds',
                                  'new_balance', v_old_balance);
    END IF;

    UPDATE public.profiles
       SET diamonds = v_new_balance, diamond_balance = v_new_balance, updated_at = now()
     WHERE id = p_user_id;

    INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, reference_id, metadata
    ) VALUES (
        p_user_id, v_actual_amount, p_type, p_type,
        CASE WHEN v_actual_amount <> v_raw_amount
             THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
             ELSE p_description END,
        v_new_balance, p_reference_id,
        jsonb_build_object('reference_id', p_reference_id,
                           'raw_amount', v_raw_amount,
                           'multiplier', v_multiplier,
                           'exact_value', v_exact_type)
    ) RETURNING id INTO v_txn_id;

    RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance,
        'new_balance', v_new_balance, 'amount', v_actual_amount,
        'multiplier', v_multiplier, 'transaction_id', v_txn_id);
END;
$$;

ALTER TABLE public.trivia_sessions
    ADD COLUMN IF NOT EXISTS expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS survival_run_id uuid,
    ADD COLUMN IF NOT EXISTS survival_level integer,
    ADD COLUMN IF NOT EXISTS settlement_result jsonb;

ALTER TABLE public.trivia_sessions DROP CONSTRAINT IF EXISTS trivia_sessions_entry_state_check;
ALTER TABLE public.trivia_sessions ADD CONSTRAINT trivia_sessions_entry_state_check
    CHECK (entry_state IN ('legacy','free','vip','charged','continuation','ticket'));

CREATE TABLE IF NOT EXISTS public.trivia_item_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    item_type text NOT NULL CHECK (item_type IN ('streak_shield','arcade_ticket','mystery_box')),
    amount integer NOT NULL CHECK (amount <> 0),
    balance_after integer NOT NULL CHECK (balance_after >= 0),
    transaction_type text NOT NULL,
    reference_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, reference_id)
);
ALTER TABLE public.trivia_item_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users view own trivia item ledger" ON public.trivia_item_transactions;
CREATE POLICY "Users view own trivia item ledger"
    ON public.trivia_item_transactions FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "Service role manages trivia item ledger" ON public.trivia_item_transactions;
CREATE POLICY "Service role manages trivia item ledger"
    ON public.trivia_item_transactions FOR ALL TO service_role
    USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON public.trivia_item_transactions FROM anon, authenticated;
GRANT SELECT ON public.trivia_item_transactions TO authenticated;

-- Solo entry, ticket redemption and survival continuation are one transaction.
CREATE OR REPLACE FUNCTION public.create_trivia_session_v2(
    p_session_id uuid,
    p_user_id uuid,
    p_mode text,
    p_question_ids uuid[],
    p_permutations jsonb,
    p_parent_session_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_existing public.trivia_sessions%ROWTYPE;
    v_parent public.trivia_sessions%ROWTYPE;
    v_cost int := CASE p_mode
        WHEN 'arcade' THEN 10 WHEN 'mtt' THEN 10 WHEN 'cash' THEN 10
        WHEN 'icm' THEN 10 WHEN 'gto' THEN 10 WHEN 'mixed' THEN 10
        WHEN 'endless' THEN 10 WHEN 'survival' THEN 10
        WHEN 'time-attack' THEN 10 ELSE 0 END;
    v_state text := 'free';
    v_charge jsonb;
    v_is_vip boolean := false;
    v_item_qty int;
    v_level int := NULL;
    v_run_id uuid := NULL;
    v_required int;
    v_expires timestamptz := CASE p_mode
        WHEN 'time-attack' THEN now() + interval '30 seconds'
        WHEN 'arcade' THEN now() + interval '180 seconds'
        ELSE now() + interval '6 hours' END;
BEGIN
    IF p_session_id IS NULL OR p_user_id IS NULL OR p_mode IS NULL
       OR COALESCE(array_length(p_question_ids, 1), 0) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_session');
    END IF;

    SELECT * INTO v_existing FROM public.trivia_sessions WHERE id = p_session_id;
    IF FOUND THEN
        IF v_existing.user_id = p_user_id AND v_existing.mode = p_mode THEN
            RETURN jsonb_build_object('success', true, 'duplicate', true,
                'entry_cost', v_existing.entry_cost, 'entry_state', v_existing.entry_state,
                'expires_at', v_existing.expires_at);
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'session_id_conflict');
    END IF;

    IF p_mode = 'survival' THEN
        IF p_parent_session_id IS NULL THEN
            v_level := 1;
            v_run_id := p_session_id;
        ELSE
            SELECT * INTO v_parent FROM public.trivia_sessions
             WHERE id = p_parent_session_id FOR UPDATE;
            IF NOT FOUND OR v_parent.user_id IS DISTINCT FROM p_user_id
               OR v_parent.mode <> 'survival' OR v_parent.status <> 'submitted'
               OR v_parent.created_at < now() - interval '6 hours' THEN
                RETURN jsonb_build_object('success', false, 'error', 'invalid_survival_continuation');
            END IF;
            v_level := COALESCE(v_parent.survival_level, 1) + 1;
            v_run_id := COALESCE(v_parent.survival_run_id, v_parent.id);
            IF v_level > 10 THEN
                RETURN jsonb_build_object('success', false, 'error', 'survival_complete');
            END IF;
            v_required := (ARRAY[17,18,18,19,19,19,20,20,20,20])[COALESCE(v_parent.survival_level, 1)];
            IF COALESCE(v_parent.correct_count, 0) < v_required THEN
                RETURN jsonb_build_object('success', false, 'error', 'survival_level_not_passed');
            END IF;
            IF EXISTS (SELECT 1 FROM public.trivia_sessions WHERE parent_session_id = p_parent_session_id) THEN
                RETURN jsonb_build_object('success', false, 'error', 'survival_continuation_used');
            END IF;
            v_cost := 0;
            v_state := 'continuation';
        END IF;
    END IF;

    IF v_cost > 0 AND v_state <> 'continuation' THEN
        SELECT COALESCE(is_vip, false)
               AND (vip_tier = 'lifetime' OR vip_expires_at > now())
          INTO v_is_vip FROM public.profiles WHERE id = p_user_id;
        IF v_is_vip THEN
            v_cost := 0;
            v_state := 'vip';
        ELSIF p_mode = 'arcade' THEN
            UPDATE public.trivia_user_items
               SET quantity = quantity - 1, updated_at = now()
             WHERE user_id = p_user_id AND item_type = 'arcade_ticket' AND quantity > 0
            RETURNING quantity INTO v_item_qty;
            IF FOUND THEN
                v_cost := 0;
                v_state := 'ticket';
                INSERT INTO public.trivia_item_transactions
                    (user_id,item_type,amount,balance_after,transaction_type,reference_id,metadata)
                VALUES (p_user_id,'arcade_ticket',-1,v_item_qty,'arcade_entry',
                        'trivia_ticket_'||p_session_id::text,
                        jsonb_build_object('session_id',p_session_id));
            END IF;
        END IF;

        IF v_cost > 0 THEN
            SELECT public.add_diamonds_to_balance(
                p_user_id, -v_cost, 'trivia_entry',
                'Trivia entry ('||p_mode||')', 'trivia_entry_'||p_session_id::text
            ) INTO v_charge;
            IF COALESCE((v_charge->>'success')::boolean, false) IS NOT TRUE THEN
                RETURN jsonb_build_object('success', false, 'error',
                    COALESCE(v_charge->>'error','insufficient_diamonds'));
            END IF;
            v_state := 'charged';
        END IF;
    END IF;

    INSERT INTO public.trivia_sessions (
        id,user_id,mode,question_ids,permutations,status,parent_session_id,
        entry_cost,entry_state,expires_at,survival_run_id,survival_level
    ) VALUES (
        p_session_id,p_user_id,p_mode,p_question_ids,COALESCE(p_permutations,'{}'),
        'open',p_parent_session_id,v_cost,v_state,v_expires,v_run_id,v_level
    );

    RETURN jsonb_build_object('success',true,'duplicate',false,'entry_cost',v_cost,
        'entry_state',v_state,'new_balance',v_charge->'new_balance','expires_at',v_expires,
        'survival_level',v_level);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.create_trivia_session_v2(uuid,uuid,text,uuid[],jsonb,uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_trivia_session_v2(uuid,uuid,text,uuid[],jsonb,uuid)
    TO service_role;

-- Atomic tournament registration: lock capacity/status, debit, insert and add
-- the exact net contribution in the same database transaction.
CREATE OR REPLACE FUNCTION public.enter_trivia_tournament_v2(
    p_tournament_id uuid, p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_t public.trivia_tournaments%ROWTYPE;
    v_profile public.profiles%ROWTYPE;
    v_fee int;
    v_net int;
    v_count int;
    v_charge jsonb;
    v_entry public.trivia_tournament_entries%ROWTYPE;
BEGIN
    IF (SELECT auth.role()) <> 'service_role' THEN RAISE EXCEPTION 'service_role required'; END IF;
    SELECT * INTO v_t FROM public.trivia_tournaments WHERE id=p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','tournament_not_found'); END IF;
    IF v_t.status NOT IN ('upcoming','registration','active')
       OR (v_t.status='active' AND COALESCE(v_t.current_round,0)>=1) THEN
        RETURN jsonb_build_object('success',false,'error','registration_closed');
    END IF;
    IF EXISTS (SELECT 1 FROM public.trivia_tournament_entries
                WHERE tournament_id=p_tournament_id AND user_id=p_user_id) THEN
        RETURN jsonb_build_object('success',false,'error','already_entered','duplicate',true);
    END IF;
    SELECT count(*)::int INTO v_count FROM public.trivia_tournament_entries
     WHERE tournament_id=p_tournament_id;
    IF v_t.max_players IS NOT NULL AND v_count >= v_t.max_players THEN
        RETURN jsonb_build_object('success',false,'error','tournament_full');
    END IF;
    SELECT * INTO v_profile FROM public.profiles WHERE id=p_user_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','profile_not_found'); END IF;
    IF NOT (COALESCE(v_profile.is_vip,false)
            AND (v_profile.vip_tier='lifetime' OR v_profile.vip_expires_at>now())) THEN
        RETURN jsonb_build_object('success',false,'error','vip_required');
    END IF;
    v_fee := GREATEST(COALESCE(v_t.entry_fee,0),0);
    v_net := v_fee - floor(v_fee*0.10)::int;
    IF v_fee > 0 THEN
        SELECT public.add_diamonds_to_balance(
            p_user_id,-v_fee,'tournament_entry',
            'Tournament entry - '||v_t.name,
            'trivia_tourn_entry_'||p_tournament_id::text||'_'||p_user_id::text
        ) INTO v_charge;
        IF COALESCE((v_charge->>'success')::boolean,false) IS NOT TRUE THEN
            RETURN jsonb_build_object('success',false,'error',
                COALESCE(v_charge->>'error','insufficient_diamonds'));
        END IF;
    END IF;
    INSERT INTO public.trivia_tournament_entries(tournament_id,user_id,score,created_at)
    VALUES(p_tournament_id,p_user_id,0,now()) RETURNING * INTO v_entry;
    UPDATE public.trivia_tournaments
       SET prize_pool=COALESCE(prize_pool,0)+v_net
     WHERE id=p_tournament_id
     RETURNING prize_pool INTO v_t.prize_pool;
    v_count := v_count+1;
    RETURN jsonb_build_object('success',true,'entry',to_jsonb(v_entry),
        'new_balance',v_charge->'new_balance','new_prize_pool',v_t.prize_pool,
        'entries_count',v_count);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.enter_trivia_tournament_v2(uuid,uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enter_trivia_tournament_v2(uuid,uuid) TO service_role;

-- Atomic PvP escrow + session + link. A roster is prepared before this call,
-- so an unservable game can no longer strand a stake.
CREATE OR REPLACE FUNCTION public.create_trivia_pvp_session_v2(
    p_session_id uuid, p_match_id uuid, p_user_id uuid,
    p_question_ids uuid[], p_permutations jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_m public.trivia_pvp_matches%ROWTYPE;
    v_existing uuid;
    v_stake int;
    v_charge jsonb;
BEGIN
    IF (SELECT auth.role()) <> 'service_role' THEN RAISE EXCEPTION 'service_role required'; END IF;
    SELECT * INTO v_m FROM public.trivia_pvp_matches WHERE id=p_match_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','match_not_found'); END IF;
    IF v_m.status <> 'active' THEN RETURN jsonb_build_object('success',false,'error','match_not_active'); END IF;
    IF v_m.created_at < now()-interval '30 minutes' THEN
        RETURN jsonb_build_object('success',false,'error','match_expired');
    END IF;
    IF p_user_id=v_m.player1_id THEN v_existing:=v_m.challenger_id;
    ELSIF p_user_id=v_m.player2_id THEN v_existing:=v_m.opponent_id;
    ELSE RETURN jsonb_build_object('success',false,'error','not_your_match'); END IF;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success',true,'duplicate',true,'session_id',v_existing);
    END IF;
    v_stake:=GREATEST(COALESCE(v_m.stake_amount,0),0);
    IF v_stake>0 THEN
        SELECT public.add_diamonds_to_balance(
            p_user_id,-v_stake,'pvp_stake','PvP stake - match '||p_match_id::text,
            'pvp_stake_'||p_match_id::text||'_'||p_user_id::text
        ) INTO v_charge;
        IF COALESCE((v_charge->>'success')::boolean,false) IS NOT TRUE
           AND COALESCE((v_charge->>'duplicate')::boolean,false) IS NOT TRUE THEN
            RETURN jsonb_build_object('success',false,'error',
                COALESCE(v_charge->>'error','insufficient_diamonds'));
        END IF;
    END IF;
    INSERT INTO public.trivia_sessions(
        id,user_id,mode,question_ids,permutations,status,entry_cost,entry_state,expires_at
    ) VALUES(
        p_session_id,p_user_id,'pvp',p_question_ids,COALESCE(p_permutations,'{}'),
        'open',v_stake,CASE WHEN v_stake>0 THEN 'charged' ELSE 'free' END,
        now()+interval '30 minutes'
    );
    IF p_user_id=v_m.player1_id THEN
        UPDATE public.trivia_pvp_matches SET challenger_id=p_session_id WHERE id=p_match_id;
    ELSE
        UPDATE public.trivia_pvp_matches SET opponent_id=p_session_id WHERE id=p_match_id;
    END IF;
    RETURN jsonb_build_object('success',true,'duplicate',false,'session_id',p_session_id,
                              'new_balance',v_charge->'new_balance');
END;
$$;
REVOKE EXECUTE ON FUNCTION public.create_trivia_pvp_session_v2(uuid,uuid,uuid,uuid[],jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_trivia_pvp_session_v2(uuid,uuid,uuid,uuid[],jsonb)
    TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

