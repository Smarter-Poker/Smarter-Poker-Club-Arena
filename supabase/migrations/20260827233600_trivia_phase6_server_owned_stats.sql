-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827233600; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Trivia phase 6 follow-up: PvP/streak/telemetry statistics must be derived
-- from verified server state, never from a browser's claimed outcome.
BEGIN;

ALTER TABLE public.trivia_pvp_matches
    ADD COLUMN IF NOT EXISTS settlement_kind text,
    ADD COLUMN IF NOT EXISTS stats_recorded_at timestamptz;

ALTER TABLE public.trivia_pvp_matches
    DROP CONSTRAINT IF EXISTS trivia_pvp_matches_settlement_kind_check;
ALTER TABLE public.trivia_pvp_matches
    ADD CONSTRAINT trivia_pvp_matches_settlement_kind_check
    CHECK (settlement_kind IS NULL OR settlement_kind IN ('win','tie','refund','void'));

CREATE OR REPLACE FUNCTION public.record_trivia_pvp_stats_v2(p_match_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_match public.trivia_pvp_matches%ROWTYPE;
    v_side record;
    v_outcome text;
    v_stake integer;
    v_net_win integer;
BEGIN
    SELECT * INTO v_match
      FROM public.trivia_pvp_matches
     WHERE id = p_match_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success',false,'error','match_not_found');
    END IF;
    IF v_match.status <> 'complete' THEN
        RETURN jsonb_build_object('success',false,'error','match_not_complete');
    END IF;
    IF v_match.stats_recorded_at IS NOT NULL THEN
        RETURN jsonb_build_object('success',true,'deduped',true);
    END IF;

    v_stake := GREATEST(COALESCE(v_match.stake_amount,0),0);
    v_net_win := GREATEST((v_stake * 2 - floor(v_stake * 2 * 0.10)::integer) - v_stake,0);

    -- Mark and statistic writes share this transaction. Any failed upsert rolls
    -- the marker back, so a retry is both safe and complete.
    UPDATE public.trivia_pvp_matches
       SET stats_recorded_at = now()
     WHERE id = p_match_id;

    IF COALESCE(v_match.settlement_kind,
                CASE WHEN v_match.winner_id IS NULL THEN 'tie' ELSE 'win' END) <> 'void' THEN
        FOR v_side IN
            SELECT p.id AS user_id
              FROM public.profiles p
             WHERE p.id IN (v_match.player1_id, v_match.player2_id)
               AND COALESCE(p.is_horse,false) IS NOT TRUE
        LOOP
            v_outcome := CASE
                WHEN COALESCE(v_match.settlement_kind,
                              CASE WHEN v_match.winner_id IS NULL THEN 'tie' ELSE 'win' END)
                     IN ('tie','refund') THEN 'tie'
                WHEN v_match.winner_id = v_side.user_id THEN 'win'
                ELSE 'loss'
            END;

            INSERT INTO public.trivia_pvp_stats AS s (
                user_id,wins,losses,ties,win_streak,best_streak,
                total_diamonds_won,total_diamonds_lost,updated_at
            ) VALUES (
                v_side.user_id,
                CASE WHEN v_outcome='win' THEN 1 ELSE 0 END,
                CASE WHEN v_outcome='loss' THEN 1 ELSE 0 END,
                CASE WHEN v_outcome='tie' THEN 1 ELSE 0 END,
                CASE WHEN v_outcome='win' THEN 1 ELSE 0 END,
                CASE WHEN v_outcome='win' THEN 1 ELSE 0 END,
                CASE WHEN v_outcome='win' THEN v_net_win ELSE 0 END,
                CASE WHEN v_outcome='loss' THEN v_stake ELSE 0 END,
                now()
            ) ON CONFLICT (user_id) DO UPDATE SET
                wins=s.wins+CASE WHEN v_outcome='win' THEN 1 ELSE 0 END,
                losses=s.losses+CASE WHEN v_outcome='loss' THEN 1 ELSE 0 END,
                ties=s.ties+CASE WHEN v_outcome='tie' THEN 1 ELSE 0 END,
                win_streak=CASE WHEN v_outcome='win' THEN s.win_streak+1
                                WHEN v_outcome='loss' THEN 0 ELSE s.win_streak END,
                best_streak=GREATEST(s.best_streak,
                    CASE WHEN v_outcome='win' THEN s.win_streak+1 ELSE s.win_streak END),
                total_diamonds_won=s.total_diamonds_won+
                    CASE WHEN v_outcome='win' THEN v_net_win ELSE 0 END,
                total_diamonds_lost=s.total_diamonds_lost+
                    CASE WHEN v_outcome='loss' THEN v_stake ELSE 0 END,
                updated_at=now();
        END LOOP;
    END IF;

    RETURN jsonb_build_object('success',true,'deduped',false);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_trivia_pvp_stats_v2(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_trivia_pvp_stats_v2(uuid) TO service_role;

-- These legacy RPCs accepted browser-provided statistics. Verified session
-- settlement and record_trivia_pvp_stats_v2 now own those writes.
REVOKE EXECUTE ON FUNCTION public.fn_trivia_pvp_record_result(text,integer,uuid)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_trivia_streak(uuid,integer,integer,integer)
    FROM PUBLIC, anon, authenticated;

-- Skip telemetry had no binding to a paid hint/session and could be spammed to
-- poison quality metrics. Retire it until a server-bound event owns the write.
REVOKE EXECUTE ON FUNCTION public.increment_trivia_skipped(uuid)
    FROM PUBLIC, anon, authenticated;

-- Balance reads are served by authenticated, user-scoped application routes;
-- the raw RPC accepted an arbitrary user id.
REVOKE EXECUTE ON FUNCTION public.get_diamond_balance(uuid)
    FROM PUBLIC, anon, authenticated;

COMMIT;

