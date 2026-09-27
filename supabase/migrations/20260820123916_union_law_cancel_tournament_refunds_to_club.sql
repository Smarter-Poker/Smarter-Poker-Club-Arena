-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820123916 "union_law_cancel_tournament_refunds_to_club"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6b4e0f9dac8bbb48401808474c3cd6aa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — CANCELLATION REFUNDS RETURN TO THE PAYING CLUB (2026-08-20)
--
-- atomic_cancel_tournament refunded every entry to the global player wallet.
-- With entries now paid from club chips that moved money club -> global on any
-- cancelled tournament. Refunds now route by the entry's own club stamp, the
-- same rule used by unregister, cash-out and prize payouts.
--
-- Also fixes a real bug found while reading it: horses were EXCLUDED from
-- refunds (`is_horse = false`) yet their tournament_players rows are deleted
-- at the end, so a cancelled tournament destroyed every horse's entry fee
-- outright. Now that entries are paid from a club wallet that is settled
-- against real money, that silently burned club chips on every cancellation.
-- Horses are refunded to their club like anyone else.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_tournament RECORD;
    v_player RECORD;
    v_refund_amount NUMERIC;
    v_fee NUMERIC;
    v_refunded_count INT := 0;
    v_total_refunded NUMERIC := 0;
    v_fees_reversed NUMERIC := 0;
    v_credited boolean;
BEGIN
    SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
    IF v_tournament.status IN ('completed', 'canceled', 'CANCELLED') THEN
        RAISE EXCEPTION 'Tournament is already %', v_tournament.status;
    END IF;
    v_refund_amount := COALESCE(v_tournament.buy_in_amount, 0) + COALESCE(v_tournament.buy_in_fee, 0);
    v_fee := COALESCE(v_tournament.buy_in_fee, 0);
    UPDATE tournaments SET status = 'CANCELLED', ended_at = NOW(), updated_at = NOW() WHERE id = p_tournament_id;

    IF v_refund_amount > 0 THEN
        -- Every entrant is refunded. Horses were previously skipped while their
        -- rows were still deleted below, which destroyed their entry fee.
        FOR v_player IN (
          SELECT tp.user_id, tp.id, tp.club_id
            FROM tournament_players tp
           WHERE tp.tournament_id = p_tournament_id
             AND tp.user_id IS NOT NULL
        )
        LOOP
            v_credited := false;

            -- UNION LAW: back to the wallet that paid.
            IF v_player.club_id IS NOT NULL THEN
                UPDATE club_members
                   SET chip_balance = COALESCE(chip_balance,0) + v_refund_amount,
                       updated_at = NOW()
                 WHERE user_id = v_player.user_id AND club_id = v_player.club_id;
                v_credited := FOUND;
                IF NOT v_credited THEN
                    INSERT INTO financial_alerts (severity, source, message, context)
                    VALUES ('warning','atomic_cancel_tournament',
                            'Entry club membership missing at cancellation refund; refunded to the global wallet',
                            jsonb_build_object('user_id',v_player.user_id,'tournament_id',p_tournament_id,
                                               'club_id',v_player.club_id,'amount',v_refund_amount));
                END IF;
            END IF;

            IF NOT v_credited THEN
                UPDATE wallets SET balance = balance + v_refund_amount, updated_at = NOW()
                 WHERE user_id = v_player.user_id AND wallet_type = 'PLAYER';
                IF NOT FOUND THEN
                    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
                    VALUES (v_player.user_id, 'PLAYER', v_refund_amount, 0, NOW(), NOW());
                END IF;
            END IF;

            PERFORM log_wallet_transaction(v_player.user_id, 'PLAYER', v_refund_amount, 'credit', 'refund',
                'Tournament cancellation refund: ' || COALESCE(v_tournament.name, 'Unknown'), NULL, NULL, p_tournament_id);
            v_refunded_count := v_refunded_count + 1;
            v_total_refunded := v_total_refunded + v_refund_amount;

            IF v_fee > 0 THEN
                INSERT INTO rake_records (
                  hand_id, table_id, club_id, rake_amount, pot_size, num_players,
                  bbj_contribution, is_tournament, tournament_id, source, metadata
                ) VALUES (
                  NULL, p_tournament_id, v_tournament.club_id, -v_fee, v_fee, 1,
                  0, true, p_tournament_id, 'atomic_cancel_tournament',
                  jsonb_build_object('kind', 'tournament_fee_refund', 'user_id', v_player.user_id,
                                     'entry_club_id', v_player.club_id)
                );
                v_fees_reversed := v_fees_reversed + v_fee;
            END IF;
        END LOOP;
    END IF;

    IF v_fees_reversed > 0 THEN
        UPDATE tournaments SET total_rake = GREATEST(0, COALESCE(total_rake, 0) - v_fees_reversed)
         WHERE id = p_tournament_id;
        UPDATE unions SET total_rake = GREATEST(0, COALESCE(total_rake, 0) - v_fees_reversed)
         WHERE id = v_tournament.union_id AND v_tournament.union_id IS NOT NULL;
    END IF;

    DELETE FROM tournament_players WHERE tournament_id = p_tournament_id;
    UPDATE tables SET status = 'closed', current_players = 0 WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count,
      'total_refunded', v_total_refunded, 'fees_reversed', v_fees_reversed);
END; $function$;

