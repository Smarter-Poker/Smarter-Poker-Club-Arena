-- Reverse aggregate Spin entry rake inside the original cancellation transaction.
-- Per-player metadata filtering missed these rows. Preserve the original player
-- contribution map and source-row identity; subtract recorded reversals.
-- This changes attribution only: the existing refund already returns fee cash.
-- Isolated actual-function tests prove 0.48 nets to zero, 6 refunded once,
-- partial prior reversal, original attribution and rollback on reversal failure.
-- No historical fee records or balances are changed by this migration.
BEGIN;
DO $guard$ BEGIN
IF md5(pg_get_functiondef('public.atomic_cancel_tournament(uuid,uuid)'::regprocedure)) <> '569db67781ad732ceb352bd747901de7' THEN
RAISE EXCEPTION 'Atomic cancellation function changed; rebase correction'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_t RECORD; v_player RECORD; v_fee_row RECORD;
    v_paid NUMERIC; v_gross NUMERIC; v_fee_net NUMERIC; v_settle jsonb;
    v_refunded_count INT := 0; v_total_refunded NUMERIC := 0; v_fees_reversed NUMERIC := 0;
BEGIN
    SELECT * INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;

    IF v_uid IS NOT NULL AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
        RAISE EXCEPTION 'Only a club admin may cancel a tournament' USING ERRCODE = '42501';
    END IF;

    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
        RAISE EXCEPTION 'Tournament is already %', v_t.status;
    END IF;

    UPDATE tournaments
       SET status='CANCELLED', ended_at=NOW(), updated_at=NOW(),
           prize_pool=0, bounty_pool=0
     WHERE id=p_tournament_id;

    FOR v_player IN (
      SELECT tp.id, tp.user_id, COALESCE(tp.is_satellite_qualifier, false) AS is_q, tp.source_satellite_id
        FROM tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
    )
    LOOP
        -- v_gross: everything this entrant paid in (buy-in + fee, rebuys,
        -- add-ons) - the refund obligation's TOTAL (standard S13).
        -- v_paid: what is still owed after the refunds already on the ledger,
        -- the same net figure the old body credited.
        SELECT round(COALESCE(sum(
                 CASE WHEN w.type='debit' AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                      ELSE 0 END), 0), 2),
               round(COALESCE(sum(
                 CASE WHEN w.type='debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                      WHEN w.type='credit' AND w.category='refund' THEN -w.amount
                      ELSE 0 END), 0), 2)
          INTO v_gross, v_paid
          FROM wallet_transactions w
         WHERE w.user_id = v_player.user_id AND w.related_entity_id = p_tournament_id;

        /* CHIP STANDARD 5.3 (2026-09-05): A SATELLITE SEAT IS MONEY THE TARGET
           HOLDS. A qualifier paid nothing from a wallet, so the sums above read
           zero and a cancel used to refund them nothing while the seat's value
           (moved from the satellite's pool on the pool_transfer leg) stayed in
           this event's escrow. The seat is refunded in cash like any entry:
           what the satellite actually moved, less any refund already paid. A
           seat awarded before origin tracking (source NULL) names no leg and
           is left for the epoch reset gate, as before. */
        IF v_gross = 0 AND v_player.is_q AND v_player.source_satellite_id IS NOT NULL THEN
            SELECT round(COALESCE(sum(l.amount), 0), 2) INTO v_gross
              FROM chip_ledger l
             WHERE l.to_entity_id = p_tournament_id AND l.to_type = 'prize_liability'
               AND l.idempotency_key = 'tourney:' || v_player.source_satellite_id::text || ':seat:' || v_player.user_id::text || ':pool_transfer';
            v_paid := round(v_gross + v_paid, 2);
        END IF;

        IF v_paid > 0 THEN
            /* ONE PAYER (R3, 2026-09-02). User-keyed 'refund' obligation; the
               settle function seeds amount_paid from the refund credits already
               on the ledger and pays gross - seeded. A refused refund is
               skipped here exactly as a refused fn_credit_and_log was, and the
               deferred trigger tournaments_cancel_must_refund then refuses the
               whole cancel at commit because an entrant is still owed. */
            v_settle := public.fn_settle_tournament_obligation(
              p_tournament_id, 'refund', NULL, v_player.user_id, v_gross,
              'atomic_cancel_tournament',
              'Tournament cancellation refund: ' || COALESCE(v_t.name,'Unknown'));
            IF COALESCE((v_settle->>'ok')::boolean, false)
               AND COALESCE((v_settle->>'paid')::numeric, 0) > 0 THEN
                v_refunded_count := v_refunded_count + 1;
                v_total_refunded := v_total_refunded + (v_settle->>'paid')::numeric;
            END IF;
        END IF;

        IF v_t.club_id IS NOT NULL THEN
            SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_fee_net
              FROM rake_records r
             WHERE r.tournament_id = p_tournament_id AND r.is_tournament
               AND r.metadata->>'user_id' = v_player.user_id::text;
            IF v_fee_net > 0 THEN
                INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size,
                  num_players, bbj_contribution, is_tournament, tournament_id, source, metadata)
                VALUES (NULL, NULL, v_t.club_id, -v_fee_net, v_fee_net, 1, 0, true,
                  p_tournament_id, 'atomic_cancel_tournament',
                  jsonb_build_object('kind','tournament_fee_refund','user_id',v_player.user_id));
                v_fees_reversed := v_fees_reversed + v_fee_net;
            END IF;
        END IF;
    END LOOP;


    -- Spin entry fees are aggregate rows without metadata.user_id.
    -- Reverse each original row's remaining attribution in this cancellation,
    -- retaining its player contribution map and a durable source-row identity.
    IF v_t.variant = 'spin' AND v_t.club_id IS NOT NULL THEN
      FOR v_fee_row IN
        SELECT r.* FROM public.rake_records r
         WHERE r.tournament_id=p_tournament_id AND r.is_tournament
           AND r.source='fn_spin_book_entry' AND r.rake_amount>0
           AND NULLIF(r.metadata->>'user_id','') IS NULL
         ORDER BY r.id FOR UPDATE
      LOOP
        SELECT round(v_fee_row.rake_amount+COALESCE(sum(r.rake_amount),0),2)
          INTO v_fee_net FROM public.rake_records r
         WHERE r.tournament_id=p_tournament_id AND r.is_tournament
           AND r.source='atomic_cancel_tournament'
           AND r.metadata->>'kind'='spin_rake_refund'
           AND r.metadata->>'original_rake_record_id'=v_fee_row.id::text;
        IF v_fee_net > 0 THEN
            INSERT INTO public.rake_records
              (hand_id,table_id,club_id,rake_amount,pot_size,num_players,
               bbj_contribution,is_tournament,tournament_id,source,
               player_contributions,metadata)
            VALUES (NULL,NULL,v_fee_row.club_id,-v_fee_net,v_fee_row.pot_size,
                    v_fee_row.num_players,0,true,p_tournament_id,
                    'atomic_cancel_tournament',v_fee_row.player_contributions,
                    jsonb_build_object('kind','spin_rake_refund',
                                       'original_source','fn_spin_book_entry',
                                       'original_rake_record_id',v_fee_row.id));
            v_fees_reversed := v_fees_reversed + v_fee_net;
        END IF;
      END LOOP;
    END IF;

    IF v_fees_reversed > 0 THEN
        UPDATE tournaments SET total_rake = GREATEST(0, COALESCE(total_rake,0) - v_fees_reversed)
         WHERE id = p_tournament_id;
    END IF;

    UPDATE tournament_players SET status='eliminated', eliminated_at=NOW()
     WHERE tournament_id = p_tournament_id AND status IN ('registered','playing');
    UPDATE tables SET status='closed', current_players=0 WHERE tournament_id = p_tournament_id;

    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count,
      'total_refunded', v_total_refunded, 'fees_reversed', v_fees_reversed);
END; $function$;
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid) TO service_role;
COMMIT;
