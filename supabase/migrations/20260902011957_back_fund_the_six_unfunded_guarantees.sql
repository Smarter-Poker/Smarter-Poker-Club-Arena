-- ═══════════════════════════════════════════════════════════════════════════
-- PAY THE SIX GUARANTEES THAT WERE NEVER TOPPED UP
--
-- The trigger makes overlays right from now on. These six already completed,
-- so it will never fire for them and their players are still short.
--
--   Union Grand Championship  2,500 guaranteed, pool 1,860, owed 640
--   Union Grand Championship  2,500 guaranteed, pool 2,040, owed 460
--   Union Mystery Bounty        800 guaranteed, pool   450, owed 350
--   Evening Mystery Bounty      400 guaranteed, pool   225, owed 175
--   Afternoon Bounty            200 guaranteed, pool   138, owed  62
--   Turbo Tuesday Opener        250 guaranteed, pool   234, owed  16
--                                                        total 1,703.00
--
-- A transfer, not a mint: the bank always had the money (both existing guards
-- verified that), nothing ever moved it.
--
-- HOW IT IS SPLIT. An overlay inflates every paid finishing position in
-- proportion, so each finisher gets shortfall x (their prize / prizes paid).
-- Verified in a rolled-back probe: the pro-rata lands exactly on each event's
-- shortfall with no rounding residual, 46 finishers, 1,703.00 to the cent.
--
-- WHICH CLUB IS CREDITED. tournament_players.club_id - stamped on entry by
-- fn_stamp_entry_club - NOT the tournament's club_id. A union event is played
-- by members of its constituent clubs: 11 of the 46 finishers hold no
-- club_members row in Midway Union because they entered from Club JAQK or
-- SHARK CLUB. Crediting the tournament's club silently missed all 11, and all
-- 11 are horses, who under the 2026-08-27 law are paid exactly as humans are.
-- The first probe paid 35 of 46; this pays 46 of 46.
--
-- NOTE ON JOURNALLING: this migration originally wrote its own chip_ledger
-- rows as well. It should not have - the balance writes are auto-journalled,
-- and because the category was declared first they came out correctly
-- categorised. The duplicates are removed in one_movement_one_journal_row.
-- ═══════════════════════════════════════════════════════════════════════════

DO $backfill$
DECLARE
  r record; v_paid numeric := 0; v_n int := 0; v_bank numeric;
  v_union uuid := 'fade0000-0000-0000-0000-000000000001';
BEGIN
  SELECT chip_balance INTO v_bank FROM public.union_wallets
   WHERE union_id = v_union FOR UPDATE;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);

  FOR r IN
    WITH u AS (
      SELECT tournament_id AS tid, name, delta AS shortfall
        FROM public.fn_ca_tournament_settlement_mismatch('48 hours')
       WHERE kind = 'underpaid'
    ), g AS (
      SELECT u.tid, u.name, u.shortfall, w.user_id, round(sum(w.amount),2) AS got
        FROM u JOIN public.wallet_transactions w
          ON w.related_entity_id = u.tid AND w.type = 'credit'
         AND COALESCE(w.category,'') <> 'bounty'
       GROUP BY u.tid, u.name, u.shortfall, w.user_id
    )
    SELECT g.tid, g.name, g.user_id,
           COALESCE(tp.club_id, t.club_id) AS pay_club,
           round(g.shortfall * g.got / NULLIF(sum(g.got) OVER (PARTITION BY g.tid),0), 2) AS owed
      FROM g
      JOIN public.tournaments t ON t.id = g.tid
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = g.tid AND tp.user_id = g.user_id
  LOOP
    CONTINUE WHEN r.owed IS NULL OR r.owed <= 0;

    UPDATE public.club_members
       SET chip_balance = chip_balance + r.owed
     WHERE user_id = r.user_id AND club_id = r.pay_club;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'no club_members row for % in club % - refusing to pay part of a guarantee',
        r.user_id, r.pay_club;
    END IF;

    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, amount, type, category, description, related_entity_id)
    VALUES (r.user_id, 'PLAYER', r.owed, 'credit', 'prize',
            'Guarantee overlay back-payment: ' || COALESCE(r.name, r.tid::text), r.tid);

    v_paid := v_paid + r.owed;
    v_n := v_n + 1;
  END LOOP;

  IF COALESCE(v_bank,0) < v_paid THEN
    RAISE EXCEPTION 'union bank holds % and the overlays total % - refusing a partial settlement',
      v_bank, v_paid;
  END IF;

  UPDATE public.union_wallets
     SET chip_balance = chip_balance - v_paid, updated_at = now()
   WHERE union_id = v_union;

  RAISE NOTICE 'overlay backfill: % finishers, % chips, union bank % -> %',
    v_n, v_paid, v_bank, v_bank - v_paid;
END $backfill$;

UPDATE public.ca_ratchet_baselines
   SET baseline = public.fn_ca_tournament_underpaid_count(),
       tightened_at = now()
 WHERE ratchet = 'tournament_underpaid_48h';
