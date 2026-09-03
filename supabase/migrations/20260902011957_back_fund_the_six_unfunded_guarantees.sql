-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902011957; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PAY THE SIX GUARANTEES THAT WERE NEVER TOPPED UP
--
-- Dan: "ANY OVERLAYS ARE SUPPOSED TO BE FUNDED BY THE MAIN BANK." The trigger
-- in the_overlay_is_funded_by_the_main_bank_atomically makes that true from now
-- on. These six already completed, so the trigger will never fire for them and
-- their players are still short.
--
--   Union Grand Championship  2,500 guaranteed, pool 1,860, owed 640
--   Union Grand Championship  2,500 guaranteed, pool 2,040, owed 460
--   Union Mystery Bounty        800 guaranteed, pool   450, owed 350
--   Evening Mystery Bounty      400 guaranteed, pool   225, owed 175
--   Afternoon Bounty            200 guaranteed, pool   138, owed  62
--   Turbo Tuesday Opener        250 guaranteed, pool   234, owed  16
--                                                        total 1,703.00
--
-- WHY THE MONEY WAS ALWAYS THERE. Two guards already existed:
-- trg_tournaments_guarantee_affordable refuses a guarantee the bank cannot
-- cover, and fn_guard_tournament_start_readiness refuses to START an event
-- whose guarantee is short. Both check that the bank COULD pay. Neither ever
-- made it pay. That is the whole defect, and it is why this backfill is a
-- transfer and not a mint.
--
-- HOW IT IS SPLIT. An overlay inflates every paid finishing position in
-- proportion, so each finisher receives shortfall x (their prize / the prizes
-- actually paid). Verified in a rolled-back probe: the pro-rata lands exactly
-- on each event's shortfall with no rounding residual, across 46 finishers,
-- totalling 1,703.00 to the cent.
--
-- WHICH CLUB IS CREDITED. tournament_players.club_id, stamped on entry by
-- fn_stamp_entry_club - NOT the tournament's club_id. A union event is played
-- by members of its constituent clubs: 11 of the 46 finishers hold no
-- club_members row in Midway Union at all, because they entered from Club JAQK
-- or SHARK CLUB. Crediting the tournament's club silently missed all 11 - and
-- all 11 are horses, who under the 2026-08-27 law are paid exactly as humans
-- are. The first probe paid 35 of 46; this one pays 46 of 46.
-- ═══════════════════════════════════════════════════════════════════════════

DO $backfill$
DECLARE
  r record;
  v_paid  numeric := 0;
  v_n     int := 0;
  v_bank  numeric;
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
            'Guarantee overlay back-payment: ' || COALESCE(r.name, r.tid::text),
            r.tid);

    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
              'prize_liability', r.tid, 'player_wallet', r.user_id,
              r.owed, 'tournament_prize', r.pay_club, r.tid,
              'Guarantee overlay back-payment (main bank): ' || COALESCE(r.name, r.tid::text));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

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

  BEGIN
    INSERT INTO public.chip_ledger (
      performed_by, from_type, from_entity_id, to_type, to_entity_id,
      amount, category, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
            'union_bank', v_union, 'prize_liability', v_union,
            v_paid, 'overlay',
            'Main bank funding six guarantee overlays that were never topped up (2026-09-02 ruling)');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RAISE NOTICE 'overlay backfill: % finishers, % chips, union bank % -> %',
    v_n, v_paid, v_bank, v_bank - v_paid;
END $backfill$;

UPDATE public.ca_ratchet_baselines
   SET baseline = public.fn_ca_tournament_underpaid_count(),
       tightened_at = now()
 WHERE ratchet = 'tournament_underpaid_48h';

