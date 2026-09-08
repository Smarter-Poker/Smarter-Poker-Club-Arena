BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 6 OF 8 (UNION ACCOUNTING) - THE THREE DECISIONS, 2026-09-08. PART 1 OF 2.
   (Part 2, the money, is the next migration: a trigger on rake_records holds a
   ShareRowExclusive lock on the hottest table for the life of its transaction,
   and a money transaction is not short.)
   ---------------------------------------------------------------------------
   Dan, 2026-09-08: "THIS IS FOR YOU TO DECIDE WHAT TO DO, NOT ME." Three
   decisions the Phase 6 changelog had handed up. Each decided here, with the
   reasoning, under CLAUDE.md 10.9.

   1. TOURNAMENT ENTRY FEES EARN PLAYER RAKEBACK. A fee is rake: it is booked
      in rake_records, the union pays the clubs 90% of it per game type (Dan
      2026-09-03), and VIP and agent commission already attribute it to the
      player at settlement. Only the PLAYER RAKEBACK basis missed it, and only
      because fn_rakeback_recompute_day reads player_contributions and four of
      the five tournament writers never fill it (spin books do). Week of
      2026-08-31: spin entries 178,864.32 counted; MTT registrations 103,224.75,
      rebuys 5,949.30, satellite seats 8,475.50, spin settlements 30,433.20,
      human registrations 13.50 did not. Two players paying the same 10% fee,
      one earning rakeback and one not, is the asymmetry 10.5 forbids. From
      this migration on, ONE rule at the source table names the player on
      every tournament rake row that arrives without contributions:
      metadata.user_id when the writer names one, else an equal split across
      the field (the same spread fn_attribute_tournament_rake uses). Forward
      only: rows already written stay as they are, so no paid period moves and
      no pending period is re-based on a rule that did not exist when it was
      earned.

   2. STATEMENTS GO BACK ON, AND THE TWO STALE ONES ARE CREDITED. The
      statement now reads the rows round 1 paid from; switching
      weekly_invoices_enabled to 1 before the 2026-09-14 close means the first
      clean week gets a statement. But the gate also arms dunning
      (fn_union_age_invoices), and two statements are 19 days overdue:
      MIDWAY-2026-000001 (Club JAQK, 7,531.11) and MIDWAY-2026-000002 (SHARK
      CLUB, 220,615.68), the ECO square-up for the week of 2026-08-10. Both
      were computed on the first-joined-club rake basis that nothing written
      supports (SHARK's "rake generated 278,662.87" is most of the union's
      rake, attributed to it because most horses joined SHARK first) and on a
      club-cash-profit P&L of the horse fleet, and the attribution data that
      would let a correct figure be computed did not exist until 2026-09-02.
      A demand for 220,615.68 on a number the platform cannot stand behind is
      not chased. Each is credited in full, with the reason on the credit
      note the club receives; nothing is taken from a club for our defect
      (10.9 rule 3, applied to a club). The credit notes go FIRST, so the
      gate opens onto zero outstanding and no reminder fires.

   3. THE PHANTOM TREASURY CREDITS ARE RETIRED. Each ghost twin's second
      atomic_distribute_rake call credited the treasury again. READ, not
      assumed, by matching the credit rows themselves (a union_wallet
      transaction or chip_ledger leg carrying the twin's own created_at and
      amount, and one carrying the linked row's): Midway Union rake_wallet
      1,171 twins / 3,245.35 (the 99 hands of 20260907200330 among them);
      Deep Stack Society chip_treasury 239 twins / 442.70. Supply that no pot
      ever paid, in treasuries, not player balances. Retired through the
      platform's own door, fn_ca_burn (a keyed chip_retirement leg, a
      ca_mint_ledger row); the union's share first moves rake_wallet ->
      chip_balance with the same two-row transfer the weekly close writes,
      because the burn door draws from the bank. Both figures are re-measured
      here and the migration aborts if they moved. */

/* 1. one rule at the source: a tournament rake row names its player */
CREATE OR REPLACE FUNCTION public.fn_tournament_fee_names_its_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := NEW.metadata->>'user_id';
  v_pc  jsonb;
BEGIN
  /* Only a tournament row that arrives with no contributions and positive
     rake. Reversal rows (negative) and rows that already name their players
     (spin books) pass untouched. The VALUE is a weight: the allocator splits
     the rake equally under DEALT_EQUAL, so the amount stored is immaterial;
     rake_amount is used so a reader sees a fee, not a pot. */
  IF v_uid ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    NEW.player_contributions := jsonb_build_object(v_uid, NEW.rake_amount);
  ELSIF NEW.tournament_id IS NOT NULL THEN
    SELECT jsonb_object_agg(tp.user_id::text, NEW.rake_amount) INTO v_pc
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.tournament_id AND tp.user_id IS NOT NULL;
    IF v_pc IS NOT NULL THEN
      NEW.player_contributions := v_pc;
    END IF;
  END IF;
  IF NEW.player_contributions IS NOT NULL THEN
    NEW.rake_method := COALESCE(NEW.rake_method, 'DEALT_EQUAL');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tournament_fee_names_its_player ON public.rake_records;
CREATE TRIGGER trg_tournament_fee_names_its_player
  BEFORE INSERT ON public.rake_records
  FOR EACH ROW
  WHEN (NEW.is_tournament IS TRUE AND NEW.player_contributions IS NULL AND NEW.rake_amount > 0)
  EXECUTE FUNCTION public.fn_tournament_fee_names_its_player();

/* the rule, probed and rolled back */
DO $probe$
DECLARE v_club uuid; v_u1 uuid; v_u2 uuid; v_t uuid; v_rr uuid; v_pc jsonb; v_n int;
BEGIN
  BEGIN
    SELECT c.id INTO v_club FROM public.clubs c WHERE c.union_id IS NULL ORDER BY c.created_at LIMIT 1;
    SELECT p.id INTO v_u1 FROM public.profiles p ORDER BY p.id LIMIT 1;
    SELECT p.id INTO v_u2 FROM public.profiles p WHERE p.id <> v_u1 ORDER BY p.id LIMIT 1;
    -- a registration fee that names its player
    INSERT INTO public.rake_records (club_id, rake_amount, is_tournament, source, metadata)
    VALUES (v_club, 1.50, true, 'phase6_probe', jsonb_build_object('kind', 'tournament_entry_fee', 'user_id', v_u1))
    RETURNING id, player_contributions INTO v_rr, v_pc;
    IF v_pc IS DISTINCT FROM jsonb_build_object(v_u1::text, 1.50) THEN
      RAISE EXCEPTION 'probe: registration fee got contributions %', v_pc;
    END IF;
    SELECT count(*) INTO v_n FROM public.vip_points_ledger WHERE source_type = 'rake' AND source_id = v_rr;
    IF v_n <> 0 THEN RAISE EXCEPTION 'probe: the VIP trigger fired on a tournament row'; END IF;
    -- a userless spin settlement splits across the field
    SELECT tp.tournament_id INTO v_t FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE t.club_id = v_club AND tp.user_id IS NOT NULL
     GROUP BY tp.tournament_id HAVING count(*) >= 2 ORDER BY tp.tournament_id LIMIT 1;
    IF v_t IS NOT NULL THEN
      INSERT INTO public.rake_records (club_id, rake_amount, is_tournament, tournament_id, source, metadata)
      VALUES (v_club, 0.48, true, v_t, 'phase6_probe', jsonb_build_object('kind', 'spin_rake'))
      RETURNING player_contributions INTO v_pc;
      IF v_pc IS NULL OR (SELECT count(*) FROM jsonb_object_keys(v_pc)) < 2 THEN
        RAISE EXCEPTION 'probe: userless spin row was not split across the field: %', v_pc;
      END IF;
    END IF;
    -- a reversal row stays as written
    INSERT INTO public.rake_records (club_id, rake_amount, is_tournament, source, metadata)
    VALUES (v_club, -1.50, true, 'phase6_probe', jsonb_build_object('kind', 'spin_rake_refund', 'user_id', v_u1))
    RETURNING player_contributions INTO v_pc;
    IF v_pc IS NOT NULL THEN RAISE EXCEPTION 'probe: a reversal row was given contributions'; END IF;
    RAISE EXCEPTION 'FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'FIXTURE_ROLLBACK' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.rake_records WHERE source = 'phase6_probe') THEN
    RAISE EXCEPTION 'the probe committed its fixtures';
  END IF;
END $probe$;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tournament_fee_names_its_player' AND tgrelid = 'public.rake_records'::regclass) THEN
    RAISE EXCEPTION 'the tournament fee rule is not on the table';
  END IF;
END $assert$;

COMMIT;