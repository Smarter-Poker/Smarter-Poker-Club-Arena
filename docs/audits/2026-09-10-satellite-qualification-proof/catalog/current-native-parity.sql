BEGIN; DO $$ BEGIN IF current_database()<>'satellite_qualification_verified' OR current_setting('data_directory') NOT LIKE '/tmp/codex-satellite-cohort-pg17/%' THEN RAISE EXCEPTION 'Disposable satellite fixture only'; END IF; END $$;
SET check_function_bodies=false;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
SET search_path=public,extensions;
ALTER TABLE public."table_seats" ADD COLUMN "occupancy_id" uuid DEFAULT gen_random_uuid();
ALTER TABLE public."table_seats" ADD COLUMN "active_game_scope" text;
ALTER TABLE public."table_seats" ADD COLUMN "active_parent_key" text;
ALTER TABLE public."tables" ADD COLUMN "observer_show_cards" boolean DEFAULT false;
ALTER TABLE public."tables" ADD COLUMN "seat_game_scope" text;
ALTER TABLE public."tables" ADD COLUMN "seat_admission_key" text;
ALTER TABLE public."tournament_tickets" ADD COLUMN "source_satellite_award_place" integer;
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stack   TEXT;
  v_bypass  TEXT;
  v_allowed TEXT[] := ARRAY[
    'atomic_credit_wallet_and_log','atomic_deduct_wallet_and_log','atomic_wallet_transfer',
    'atomic_chip_transfer','fn_idempotent_credit_wallet','fn_idempotent_deduct_wallet',
    'fn_idempotent_wallet_transfer','atomic_table_buyin','atomic_table_cashout',
    'atomic_table_rebuy','atomic_table_addon','atomic_table_withdraw','atomic_seat_horse','player_leave_table','atomic_tournament_register',
    'atomic_tournament_unregister','atomic_cancel_tournament','distribute_tournament_prizes',
    'process_tournament_rebuy',
    'atomic_pay_player_rakeback','credit_agent_commission',
    'credit_player_rakeback','fn_cancel_cashout','fn_reject_cashout',
    'fn_clawback_chips_atomic','distribute_chips','mint_club_chips','add_chips','add_to_promo_wallet',
    'credit_player_wallet','deduct_player_wallet','wallet_internal_transfer','wallet_user_transfer',
    'create_user_wallets','reconcile_ledger_nightly',
    -- added 2026-08-15 with the chip-removal authority policy
    'fn_admin_remove_player_chips','fn_approve_cashout_atomic','fn_cancel_cashout_atomic',
    -- added 2026-08-21 with the diamond-backed Chip Mint (Dan's directive)
    'fn_mint_chips_from_diamonds',
    -- added 2026-08-23 with the Club Bank Cashier (Dan directive)
    'fn_club_bank_send',
    'fn_club_bank_claim_back', 'fn_promo_wallet_send',
    'fn_club_bank_reverse'
    -- removed 2026-08-31 (phase 6): execute_commission_payout, which credited a
    -- wallet, debited nothing and never marked the commission settled.
    -- removed 2026-09-01 (phase 7): atomic_pay_agent_settlement, a staff payout
    -- that decremented a column nothing incremented.
  ];
  v_fn TEXT;
BEGIN
  v_bypass := current_setting('app.bypass_wallet_guard', true);
  IF v_bypass = 'on' THEN RETURN NEW; END IF;
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  FOREACH v_fn IN ARRAY v_allowed LOOP
    IF v_stack ~ ('function (public\.)?' || v_fn || '\(') THEN
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION
    'Direct balance mutation on %.% is forbidden by Phase 4.1.6a guard. '
    'All balance changes must flow through the whitelisted SECURITY DEFINER '
    'RPCs (atomic_*, fn_idempotent_*, distribute_chips, mint_club_chips, etc.) '
    'that log to chip_ledger. Admin override: '
    'SELECT set_config(''app.bypass_wallet_guard'', ''on'', true);',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_chip_ledger_performed_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.performed_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must be a real user, got all-zero sentinel'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Cross-scope between two non-system entity types requires the operator
  -- to be identified - this catches callers who forget to thread userId.
  IF NEW.from_type <> NEW.to_type
     AND NEW.from_type NOT IN ('system_mint', 'system_burn')
     AND NEW.to_type   NOT IN ('system_mint', 'system_burn') THEN
    -- performed_by is already NOT NULL + non-zero here; nothing extra to do.
    NULL;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_tables_sync_rit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  -- If only one was provided, mirror to the other. If both differ, prefer
  -- whichever was just changed: when run_it_twice changed, copy to enabled;
  -- otherwise copy enabled → run_it_twice.
  IF TG_OP = 'INSERT' THEN
    IF NEW.run_it_twice_enabled IS NULL AND NEW.run_it_twice IS NOT NULL THEN
      NEW.run_it_twice_enabled := NEW.run_it_twice;
    ELSIF NEW.run_it_twice IS NULL AND NEW.run_it_twice_enabled IS NOT NULL THEN
      NEW.run_it_twice := NEW.run_it_twice_enabled;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Detect which side changed and mirror to the other.
    IF NEW.run_it_twice IS DISTINCT FROM OLD.run_it_twice
       AND NEW.run_it_twice_enabled IS NOT DISTINCT FROM OLD.run_it_twice_enabled THEN
      NEW.run_it_twice_enabled := NEW.run_it_twice;
    ELSIF NEW.run_it_twice_enabled IS DISTINCT FROM OLD.run_it_twice_enabled
          AND NEW.run_it_twice IS NOT DISTINCT FROM OLD.run_it_twice THEN
      NEW.run_it_twice := NEW.run_it_twice_enabled;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  -- An occupied table cannot close. The engine owns its departures.
  -- Do not convert this refusal into a warning and commit a closed table.
  PERFORM public.fn_cashout_seats_for_closing_table(NEW.id,'table '||NEW.status);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rec record;
BEGIN
  /* Tournament rake (entry fees, rebuys, satellite seats, spin books) is
     attributed ONCE, at settlement: fn_settle_tournament_rake ->
     fn_attribute_tournament_rake, by metadata.user_id or spread across the
     field. Awarding here as well credited every spin twice (2026-09-07). */
  IF COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object'
     OR COALESCE(NEW.rake_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  /* RAKE PAID IS RAKE EARNED (20260831100610): the credit is the player's
     share of NEW.rake_amount under the hand's own method, from the one
     allocator. Never the raw contribution - that is a pot figure, not rake. */
  FOR rec IN
    SELECT a.user_id, a.credit
      FROM public.fn_allocate_rake_credits(
             NEW.rake_amount, NEW.player_contributions,
             COALESCE(NEW.rake_method, 'DEALT_EQUAL')) a
  LOOP
    BEGIN
      PERFORM public.fn_award_vip_credit(rec.user_id, rec.credit, 'rake', NEW.id, 'Rake generated');
    EXCEPTION WHEN others THEN
      -- The rake is banked whether or not the points land; the ledger row
      -- is the audit and a warning is the trace.
      RAISE WARNING 'fn_award_vip_points_from_rake: % for user % on %', SQLERRM, rec.user_id, NEW.id;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_seed_bounty_head()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_head numeric;
BEGIN
  -- Already seeded by fn_register_for_tournament / fn_register_horse_for_tournament.
  IF COALESCE(NEW.current_bounty, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = NEW.tournament_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN NEW;
  END IF;

  v_head := round(COALESCE(v_t.bounty_amount, 0), 2);
  IF v_head <= 0 THEN RETURN NEW; END IF;

  -- EVERY bounty format, mystery included, puts the FLAT bounty on the head.
  -- The mystery value is drawn from the funded chest inventory at the knockout
  -- (fn_mystery_bounty_reserve), not from a PRNG at the till. mystery_bounty_value
  -- is deliberately left alone here: it is set by the reveal, from the chest.
  UPDATE tournament_players
     SET current_bounty = v_head
   WHERE id = NEW.id;

  -- Fund the pool by this entrant's bounty contribution.
  UPDATE tournaments
     SET bounty_pool = round(COALESCE(bounty_pool, 0) + v_head, 2)
   WHERE id = NEW.tournament_id;

  /**
   * REACHING THIS LINE MEANS NOBODY PAID FOR THIS HEAD (2026-08-29).
   *
   * The early return above catches every entrant who arrived through a
   * register RPC, because those pre-set the head from the collected buy-in
   * split. So the pool was just increased by an entrant with no recorded
   * contribution -- a satellite seat award, a ticket redemption, a backfill,
   * or a path that does not exist yet.
   *
   * Not blocked: see the migration header. Made loud, once per tournament, so
   * the question can be answered from evidence instead of assumption.
   */
  INSERT INTO financial_alerts (severity, source, message, context)
  SELECT 'warning', 'trg_seed_bounty_head',
         'Bounty pool funded for an entrant with no collected buy-in split',
         jsonb_build_object(
           'tournament_id', NEW.tournament_id,
           'head', v_head,
           'detail', 'this entrant did not arrive through a register RPC, so no bounty '
                  || 'contribution was collected for the head just added to bounty_pool; '
                  || 'fn_finalize_bounty_pool pays any unclaimed remainder to the champion')
   WHERE NOT EXISTS (
     SELECT 1 FROM financial_alerts
      WHERE source = 'trg_seed_bounty_head'
        AND resolved IS NOT TRUE
        AND context->>'tournament_id' = NEW.tournament_id::text);

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournament_completed_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status <> 'COMPLETED' OR COALESCE(OLD.status,'') = 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  INSERT INTO player_stats (user_id, club_id, tournaments_played, tournaments_won, updated_at)
  SELECT tp.user_id,
         NEW.club_id,
         1,
         CASE WHEN tp.position = 1 OR tp.status = 'winner' THEN 1 ELSE 0 END,
         now()
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.user_id IS NOT NULL
  ON CONFLICT (user_id, club_id) DO UPDATE
     SET tournaments_played = COALESCE(player_stats.tournaments_played,0)
                            + EXCLUDED.tournaments_played,
         tournaments_won    = COALESCE(player_stats.tournaments_won,0)
                            + EXCLUDED.tournaments_won,
         updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_table_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;               -- private games are never union-visible
    RETURN NEW;
  END IF;

  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      -- The union's OWN house club is not a union_clubs member; it carries the
      -- union on its clubs row. Without this, house-club games are unstamped
      -- and therefore invisible in every club lobby.
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
    IF v_union IS NOT NULL THEN NEW.union_id := v_union; END IF;
  END IF;

  -- A union game belongs to the UNION, not to whichever member club happened to
  -- create it. Point club_id at the union's own container row so every surface
  -- agrees on who runs the game.
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
    IF v_union IS NOT NULL THEN NEW.union_id := v_union; END IF;
  END IF;

  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_block_deleted_table_revival()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(OLD.is_deleted, false)
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('running','waiting','active','open') THEN
    NEW.status := OLD.status;      -- refuse the revival, keep it closed
    NEW.is_deleted := true;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_table_union_ownership_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_union_ownership_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_sync_club_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clubs uuid[];
  v_unions uuid[];
BEGIN
  -- Both sides, so a table MOVING between clubs or unions fixes the club it
  -- left as well as the one it joined.
  v_clubs := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
  ], NULL);
  v_unions := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.union_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.union_id END
  ], NULL);

  IF cardinality(v_clubs) > 0 THEN
    UPDATE clubs SET table_count = fn_live_table_count(id) WHERE id = ANY(v_clubs);
  END IF;

  -- Every club that can see a touched union's tables (members + the union row).
  IF cardinality(v_unions) > 0 THEN
    UPDATE clubs SET table_count = fn_live_table_count(id)
     WHERE id = ANY(v_unions)
        OR id IN (SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions));
  END IF;

  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- A SEAT KEEPS THE CLUB IT WAS SEATED UNDER (2026-09-10). Nothing that the
  -- stamp is derived from changed, and the seat already carries a club, so
  -- there is nothing to derive. This was 6.0 ms of club_members lookups on
  -- every stack write; see the migration header.
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
     AND NEW.club_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
    NEW.club_id := COALESCE(
      public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NEW.club_id),
      NEW.club_id
    );
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_entry_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.club_id IS NULL AND NEW.user_id IS NOT NULL AND NEW.tournament_id IS NOT NULL THEN
    NEW.club_id := public.fn_tournament_club_for_user(NEW.user_id, NEW.tournament_id, NULL);
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_whole_dollar_buyin()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.buy_in_amount IS DISTINCT FROM OLD.buy_in_amount
     OR NEW.buy_in_fee    IS DISTINCT FROM OLD.buy_in_fee
  THEN
    IF (COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
       <> round(COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0))
    THEN
      RAISE EXCEPTION
        'whole-dollar buy-in rule: buy_in_amount (%) + buy_in_fee (%) must total a whole number - split a whole total via splitBuyIn(), never surcharge the fee on top',
        NEW.buy_in_amount, NEW.buy_in_fee;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_clear_sitout_on_turnover()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL AND OLD.left_at IS NULL THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  ELSIF NEW.left_at IS NULL AND OLD.left_at IS NOT NULL
        AND NEW.is_sitting_out IS NOT DISTINCT FROM OLD.is_sitting_out THEN
    NEW.is_sitting_out := false;
    NEW.sit_out_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_release_seats_on_tournament_finish()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only on the TRANSITION into a finished state. Firing on every update of an
  -- already-finished row would rewrite left_at timestamps that are correct.
  IF NEW.status IN ('COMPLETED','CANCELLED')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN

    UPDATE table_seats ts
       SET left_at = COALESCE(NEW.ended_at, now())
      FROM tables t
     WHERE ts.table_id = t.id
       AND t.tournament_id = NEW.id
       AND ts.left_at IS NULL;

  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_on_table_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_terminal_now  boolean;
    v_terminal_before boolean;
    v_tournament_live boolean := false;
    v_seats int;
BEGIN
    v_terminal_now := lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished');
    v_terminal_before := lower(coalesce(OLD.status,'')) IN ('closed','completed','cancelled','finished');

    IF NEW.tournament_id IS NOT NULL THEN
        SELECT upper(coalesce(t.status,'')) NOT IN ('COMPLETED','CANCELLED')
          INTO v_tournament_live
          FROM public.tournaments t
         WHERE t.id = NEW.tournament_id;
        v_tournament_live := coalesce(v_tournament_live, false);
    END IF;

    -- A close releases the table's seats, UNLESS its tournament is still live,
    -- in which case the close is somebody else's mistake and the field plays on.
    IF v_terminal_now AND NOT v_terminal_before AND NOT v_tournament_live THEN
        /* PAY BEFORE RELEASING (2026-08-30). This released the seats and kept
           the chips: 1,036 exits worth 432,100.90 chips in a single day, every
           one a cash table. The refund has to happen first - after left_at is
           set the seat is no longer active and the stack cannot be reached.
           No-ops for tournament tables. */
        PERFORM public.fn_cashout_seats_for_closing_table(
                  NEW.id, 'table ' || coalesce(NEW.status,'closed'));

        UPDATE public.table_seats
           SET left_at = coalesce(NEW.updated_at, now())
         WHERE table_id = NEW.id
           AND left_at IS NULL;
    END IF;

    -- LOUD, and now NAMED. Only when the close strands players who are still
    -- seated; ordinary consolidation of an empty table is not an incident.
    IF v_terminal_now AND NOT v_terminal_before AND v_tournament_live THEN
        SELECT count(*)::int INTO v_seats
          FROM public.table_seats s
         WHERE s.table_id = NEW.id AND s.left_at IS NULL;

        IF v_seats > 0 THEN
            BEGIN
                INSERT INTO public.engine_recovery_events (table_id, event, detail, hand_count)
                VALUES (
                    NEW.id,
                    'table_closed_under_live_tournament',
                    jsonb_build_object(
                        'tournament_id',    NEW.tournament_id,
                        'old_status',       OLD.status,
                        'new_status',       NEW.status,
                        'seats_protected',  v_seats,
                        'application_name', coalesce(nullif(current_setting('application_name', true), ''), '(unset)'),
                        'db_role',          current_user,
                        'session_role',     session_user,
                        'client_addr',      coalesce(host(inet_client_addr()), '(local)'),
                        'txid',             txid_current()::text
                    )::text,
                    v_seats
                );
            EXCEPTION WHEN OTHERS THEN
                -- The log is a courtesy. It must never block a write.
                NULL;
            END;
        END IF;
    END IF;

    IF v_terminal_now <> v_terminal_before AND NEW.club_id IS NOT NULL THEN
        PERFORM public.fn_refresh_club_activity_counts(NEW.club_id);
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournament_player_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text;
BEGIN
  v_name := public.fn_player_display_name(NEW.user_id);
  IF v_name IS NOT NULL AND v_name <> '' THEN
    NEW.username := v_name;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_max int;
  v_have int;
  v_name text;
  v_status text;
  v_variant text;
  v_seat_first boolean;
BEGIN
  /* UNDER THE ROW LOCK (2026-09-06). This read the tournament without one, so
     two entries arriving together could both see room and both be admitted.
     Parent before child - the order every registration door already uses. */
  SELECT max_players, name, status, COALESCE(variant, '')
    INTO v_max, v_name, v_status, v_variant
    FROM public.tournaments WHERE id = NEW.tournament_id
    FOR NO KEY UPDATE;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  /* 'sng' JOINS 'spin' (2026-09-06). fn_sync_seat_first_player_count has
     always counted ('spin','sng') OR max <= 2 as seat-first; this said
     'spin' OR max <= 2. All 35 overfilled events were sng, and they qualified
     only on the <= 2 half - a six-max sng was outside the rule entirely. */
  v_seat_first := (v_variant IN ('spin', 'sng') OR v_max <= 2);

  -- A seat-first board sells its seats once. After it stops being joinable it
  -- admits nobody, however many of its entrants have since busted.
  IF v_seat_first
     AND upper(COALESCE(v_status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RAISE EXCEPTION
      'tournament_full: % is % and takes no further entrants',
      COALESCE(v_name, NEW.tournament_id::text), lower(v_status)
      USING ERRCODE = '23514';
  END IF;

  IF v_seat_first THEN
    /* AN ENTRY, NOT A SURVIVOR (2026-09-06). This branch used to exclude
       eliminated, winner, left, withdrawn, cancelled, refunded and busted -
       the right rule for a seat and the wrong one for an entry. On a
       two-handed board it meant a bust-out put a sold seat back on sale, and
       35 events took between 3 and 32 paid entries because of it. The board
       sold its seats; what became of the players who bought them is not a
       vacancy. */
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id;
  ELSE
    -- Multi-table events are unchanged: a busted entrant does not hold a seat
    -- against the next one on a board that is still filling.
    SELECT count(*) INTO v_have
      FROM public.tournament_players
     WHERE tournament_id = NEW.tournament_id
       AND COALESCE(status, 'registered') NOT IN
           ('eliminated', 'winner', 'left', 'withdrawn', 'cancelled', 'refunded', 'busted');
  END IF;

  IF v_have >= v_max THEN
    RAISE EXCEPTION
      'tournament_full: % already has % of % entrants', COALESCE(v_name, NEW.tournament_id::text), v_have, v_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_clear_seats_on_game_end()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table uuid;
BEGIN
  IF NEW.status IN ('COMPLETED', 'CANCELLED')
     AND COALESCE(OLD.status, '') IS DISTINCT FROM NEW.status THEN
    FOR v_table IN
      SELECT id FROM public.tables WHERE tournament_id = NEW.id
    LOOP
      -- Never reopen a table whose game is over: the recycler builds the next
      -- spin its own fresh table. What must not survive is the seat rows.
      PERFORM public.fn_clear_table_seats(v_table, false);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_change_syncs_seat_first_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_table_id uuid;
  v_tid uuid;
BEGIN
  v_table_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  IF v_table_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT tournament_id INTO v_tid
    FROM public.tables
   WHERE id = v_table_id;
  IF v_tid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.id = v_tid
       AND (lower(COALESCE(t.variant,'')) = 'spin'
            OR COALESCE(t.max_players,0) <= 2)
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_tid);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_zero_chip_field_elimination()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live int;
  v_zero int;
  v_status text;
BEGIN
  -- Only a transition INTO elimination, from a live seat, at zero chips.
  IF NEW.status <> 'eliminated' OR OLD.status <> 'playing' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.chips, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE COALESCE(chips, 0) <= 0)
    INTO v_live, v_zero
    FROM public.tournament_players
   WHERE tournament_id = NEW.tournament_id
     AND status = 'playing';

  -- More than one player left and NONE of them has a chip: the table has not
  -- been credited. Bust nobody. (At exactly one remaining player this is the
  -- legitimate "everybody busted in the same hand" tail, which the engine
  -- resolves by naming the last one out the winner - leave that alone.)
  IF v_live > 1 AND v_zero = v_live THEN
    SELECT upper(COALESCE(t.status, '')) INTO v_status
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;

    -- ...unless the event is already over. Nothing is going to credit those
    -- stacks now, and holding the write means the place stays unowned and
    -- unpayable forever. Refusing to bust somebody in a finished tournament
    -- does not protect them; it withholds their money.
    IF v_status IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN
      RAISE WARNING
        'allowing elimination in % (%): all % live player(s) read 0 chips, but the event is terminal - recording the finish',
        NEW.tournament_id, v_status, v_live;
      RETURN NEW;
    END IF;

    RAISE WARNING
      'refused elimination in %: all % live player(s) read 0 chips - uncredited stacks, not a bust',
      NEW.tournament_id, v_live;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_four_table_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live       int;
  v_is_closed  boolean;
  v_tournament uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A MOVE WITHIN ONE GAME IS NOT A FIFTH GAME (2026-09-05). Only the cluster
  -- executor sets this, for the one transaction in which a player changes
  -- chairs inside a game they are already in. It replaces the 041000 rule
  -- ("holds another live seat in this cluster"), which also let a player buy
  -- a second seat into a game they were already sitting in.
  IF current_setting('app.cash_seat_move', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT (t.status = 'closed'), t.tournament_id
    INTO v_is_closed, v_tournament
    FROM public.tables t
   WHERE t.id = NEW.table_id;
  IF COALESCE(v_is_closed, false) THEN
    RETURN NEW;
  END IF;

  /* THE ENTRY WAS ALREADY APPROVED AT THE DOOR (2026-09-09). An active
     entrant taking a chair in their own event is that entry being honoured,
     whether it is their first chair or their fifth move. The cap on entering
     lives in fn_enforce_booking_game_cap, which is the gate that can still
     say no while saying no is free. */
  IF v_tournament IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_live := public.fn_concurrent_game_load(NEW.user_id, NEW.id, NEW.table_id, v_tournament);

  IF v_live >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not take another',
      NEW.user_id, v_live
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before joining another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike. A chair in an event you are already entered in is the entry being honoured and is never refused here.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_one_live_tournament_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_other_table   uuid;
  v_other_seat    integer;
BEGIN
  IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
  FROM public.tables t
  WHERE t.id = NEW.table_id;

  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ts.table_id, ts.seat_number
    INTO v_other_table, v_other_seat
  FROM public.table_seats ts
  JOIN public.tables t2 ON t2.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND ts.user_id = NEW.user_id
    AND t2.tournament_id = v_tournament_id
    AND ts.id IS DISTINCT FROM NEW.id
  LIMIT 1;

  IF v_other_table IS NOT NULL THEN
    RAISE EXCEPTION
      'player % already holds a live seat in tournament % (table %, seat %) - one live seat per tournament',
      NEW.user_id, v_tournament_id, v_other_table, v_other_seat
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_log_seat_stack_exit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stack numeric;
  v_kind  text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=OLD.table_id AND c.asset='diamonds') THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- A departed seat being tidied up is not an exit: its stack left when
    -- left_at was stamped, and that is already recorded below.
    IF OLD.left_at IS NOT NULL THEN RETURN OLD; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'deleted';
  ELSE
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN RETURN NEW; END IF;
    v_stack := COALESCE(OLD.stack, 0);
    v_kind  := 'left';
  END IF;

  IF v_stack <= 0 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- CASH ONLY. A tournament stack is play money inside the event -- it credits
  -- no wallet when the seat ends, so it cannot be lost in the sense this table
  -- exists to detect. Filtering HERE rather than in the report keeps ~2,000
  -- meaningless rows an hour out of the audit trail entirely.
  IF EXISTS (SELECT 1 FROM public.tables t
              WHERE t.id = OLD.table_id AND t.tournament_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.ca_seat_stack_exits
    (seat_id, table_id, user_id, club_id, seat_number, stack, exit_kind, db_role, app_name)
  VALUES (OLD.id, OLD.table_id, OLD.user_id, OLD.club_id, OLD.seat_number,
          v_stack, v_kind, current_user,
          NULLIF(current_setting('application_name', true), ''));

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_field text := NULL;
BEGIN
  /* THE BADGE COLUMNS - what the lobby reads. These were already refused. */
  IF COALESCE(NEW.is_multi_day, false) IS TRUE THEN
    v_field := 'is_multi_day';
  ELSIF COALESCE(NEW.total_days, 1) > 1 THEN
    v_field := 'total_days';

  /* THE STRUCTURE COLUMNS - what would actually make a flight, and what was
     open until 2026-09-02. A row carrying these has no badge, so nothing warns
     anybody, and nothing on the platform advances a survivor or moves a pool
     between days. It would also switch on the day-2 exemption inside
     fn_uncollected_entry_check, excusing seats from the was-this-paid-for
     question on the strength of a Day 2 that does not exist. */
  ELSIF COALESCE(NEW.day_number, 1) > 1 THEN
    v_field := 'day_number';
  ELSIF NEW.parent_tournament_id IS NOT NULL THEN
    v_field := 'parent_tournament_id';
  ELSIF NEW.survivors_advance_to IS NOT NULL THEN
    v_field := 'survivors_advance_to';
  ELSIF NEW.flight_number IS NOT NULL THEN
    v_field := 'flight_number';
  ELSIF NEW.flight_end_chips_snapshot IS NOT NULL THEN
    v_field := 'flight_end_chips_snapshot';
  END IF;

  IF v_field IS NOT NULL THEN
    RAISE EXCEPTION
      'Multi day tournaments are not built yet (refused on %). There is no day '
      'end, no Day 2 resume and no flight merge, so this event would play down '
      'to a single winner in one session while the lobby promised otherwise, '
      'and a half built flight would excuse its seats from the uncollected '
      'entry check. Leave multi day off. Drop this trigger in the commit that '
      'implements Day 2.', v_field
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_new_seat_clear_sitout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.is_sitting_out := false;
  NEW.sit_out_at := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_insert_cancel_waitlist()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = NEW.table_id
     AND user_id  = NEW.user_id
     AND status IN ('waiting', 'notified');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournament_place_collision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing uuid;
BEGIN
  IF NEW.position IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.position IS NOT DISTINCT FROM OLD.position THEN
    RETURN NEW;
  END IF;

  SELECT tp.user_id INTO v_existing
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.tournament_id
     AND tp.position = NEW.position
     AND tp.user_id <> NEW.user_id
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Keep the forensic row: it is how the next reader learns this happened
    -- and which two players raced. Written before the raise so the INSERT is
    -- in a separate autonomous-ish path? It is not - it rolls back with the
    -- statement. That is acceptable: the RAISE below carries both user ids and
    -- the elimination path reports it as elimination_write_failed, which is a
    -- louder signal than a row in a table nobody queries.
    INSERT INTO tournament_place_collisions
      (tournament_id, place, user_id, existing_user_id, db_role, application)
    VALUES
      (NEW.tournament_id, NEW.position, NEW.user_id, v_existing,
       current_user, current_setting('application_name', true));

    RAISE EXCEPTION
      'finishing place % in tournament % is already held by % - refusing to stamp % on it (a contested place is paid TWICE, the prize idempotency key includes the user id)',
      NEW.position, NEW.tournament_id, v_existing, NEW.user_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournaments_rank_before_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ranked integer;
BEGIN
  v_ranked := public.fn_rank_survivors(NEW.id);

  IF NEW.ended_at IS NULL THEN
    NEW.ended_at := now();
  END IF;

  IF COALESCE(v_ranked, 0) > 0 THEN
    RAISE LOG 'tournament % completed with % unranked survivor(s); ranked by chips before the status flip',
      NEW.id, v_ranked;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_spin_completed_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unranked integer;
BEGIN
  IF COALESCE(NEW.variant, '') <> 'spin' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_unranked
    FROM public.tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.position IS NULL;

  IF v_unranked > 0 THEN
    RAISE EXCEPTION
      'refusing to complete Spin %: % seat(s) still have a null position after ranking. '
      'public.fn_rank_survivors should have filled these; check whether '
      'tournaments_rank_before_complete is still enabled.',
      NEW.id, v_unranked
      USING ERRCODE = 'check_violation';
  END IF;

  -- The money invariant is NOT knowable here: the prize credit lands up to
  -- ~87s after this flip (measured over 744 spins). Asking now produces a
  -- false critical on every slow credit. fn_spin_unpaid_check owns it.
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_tournaments_cancel_must_refund()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_receipt jsonb;
BEGIN
  v_receipt:=public.fn_ca_tournament_cancellation_receipt(NEW.id,NULL);
  IF COALESCE((v_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR v_receipt->>'status' IS DISTINCT FROM 'CANCELLED' THEN
    RAISE EXCEPTION 'Tournament % cannot be CANCELLED without its exact receipt',
      NEW.id USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournaments_guarantee_affordable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_union uuid; v_enforce boolean; v_club_name text;
  v_bank numeric; v_floor numeric; v_bank_label text;
  v_exposure numeric; v_this numeric; v_headroom numeric;
begin
  if coalesce(new.guaranteed_prize, 0) <= 0 or new.club_id is null then
    return new;
  end if;

  select c.union_id, coalesce(c.guarantee_enforcement_enabled, true), c.name,
         coalesce(c.guarantee_treasury_floor, 0)
    into v_union, v_enforce, v_club_name, v_floor
    from public.clubs c where c.id = new.club_id;
  if not found then return new; end if;

  if v_union is not null then
    select coalesce(uw.chip_balance, 0) into v_bank
      from public.union_wallets uw where uw.union_id = v_union;
    v_bank := coalesce(v_bank, 0);
    v_bank_label := 'union bank';
    v_floor := 0;

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
      join public.clubs c2 on c2.id = t.club_id
     where c2.union_id = v_union
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  else
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = new.club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
     where t.club_id = new.club_id
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  end if;

  v_this     := greatest(coalesce(new.guaranteed_prize,0) - coalesce(new.prize_pool,0), 0);
  v_headroom := v_bank - v_floor - v_exposure - v_this;

  if v_headroom < 0 then
    if v_enforce then
      raise exception
        'Club % cannot guarantee % chips: % holds %, floor %, already promised % on live events - short by %. Add chips to the bank to cover the guarantee.',
        coalesce(v_club_name, new.club_id::text), new.guaranteed_prize,
        v_bank_label, round(v_bank,2), round(v_floor,2), round(v_exposure,2), round(-v_headroom,2)
        using errcode = '55000';
    else
      insert into public.financial_alerts (severity, source, message, context)
      values ('critical', 'trg_tournaments_guarantee_affordable',
              'Guaranteed tournament announced that the ' || v_bank_label || ' cannot cover: '
                || coalesce(v_club_name, new.club_id::text),
              jsonb_build_object('club_id', new.club_id, 'union_id', v_union,
                                 'tournament_id', new.id,
                                 'guaranteed_prize', new.guaranteed_prize,
                                 'bank', v_bank, 'bank_label', v_bank_label,
                                 'floor', v_floor,
                                 'live_exposure', v_exposure, 'short_by', -v_headroom,
                                 'note', 'enforcement disabled for this club; no money was blocked'));
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_short_formats_never_break()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')
     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng')
  THEN
    NEW.synchronized_breaks := false;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_booking_game_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_load    int;
  v_tstatus text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NULL OR NEW.status NOT IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  -- registered -> playing at late registration is not a NEW claim.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('registered', 'playing') THEN
    RETURN NEW;
  END IF;

  SELECT tr.status INTO v_tstatus
    FROM public.tournaments tr
   WHERE tr.id = NEW.tournament_id;

  -- Once under way, entrants are counted by their SEATS and the seat trigger
  -- owns the rule. An unreadable tournament row is checked, not waved through.
  IF v_tstatus IS NOT NULL AND v_tstatus NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || NEW.user_id::text, 0));

  v_load := public.fn_concurrent_game_load(NEW.user_id, NULL, NULL, NEW.tournament_id);

  IF v_load >= 4 THEN
    RAISE EXCEPTION
      'FOUR TABLE LIMIT: user % is already committed to % games and may not enter another',
      NEW.user_id, v_load
      USING ERRCODE = '23514',
            HINT = 'Leave a table or unregister before entering another. A game is a live seat or a booking for a tournament that has not started. This limit applies to players and horses alike.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_sit_out_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.sit_out_at := CASE WHEN COALESCE(NEW.is_sitting_out, false)
                           THEN COALESCE(NEW.sit_out_at, now())
                           ELSE NULL END;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_sitting_out, false) AND NOT COALESCE(OLD.is_sitting_out, false) THEN
    -- Entering sit-out: start the clock.
    NEW.sit_out_at := now();
  ELSIF NOT COALESCE(NEW.is_sitting_out, false) THEN
    -- Not sitting out, by any route (sat back in, seat turned over, evicted).
    NEW.sit_out_at := NULL;
  ELSIF public.fn_freeze_bypass_active()
        AND NEW.sit_out_at IS NOT NULL
        AND NEW.sit_out_at IS DISTINCT FROM OLD.sit_out_at THEN
    -- Still sitting out, and the writer is the THAW (the only transaction
    -- that runs under app.freeze_bypass). It is giving this clock back the
    -- minutes the freeze took; honour the value it supplied.
    NULL;
  ELSE
    -- Still sitting out. HOLD THE ORIGINAL STAMP. An unrelated UPDATE to the
    -- row (a stack change, a time-bank decrement, a status write) must NOT
    -- restart the five minutes.
    NEW.sit_out_at := COALESCE(OLD.sit_out_at, NEW.sit_out_at, now());
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_no_live_seat_on_finished_game()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.status INTO v_status
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_status IN ('COMPLETED', 'CANCELLED') THEN
    NEW.left_at := now();
    NEW.is_sitting_out := false;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_notify_blinding_off()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_name text;
  v_stack text := '';
BEGIN
  BEGIN
    -- Only the moment they GO away, never the moment they come back, and never
    -- a repeat while they stay away.
    IF NOT (COALESCE(NEW.is_sitting_out, false) OR COALESCE(NEW.is_away, false)) THEN
      RETURN NEW;
    END IF;
    IF (COALESCE(OLD.is_sitting_out, false) OR COALESCE(OLD.is_away, false)) THEN
      RETURN NEW;
    END IF;
    -- A seat they have already left is not blinding off.
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;

    -- Tournaments only. A cash seat that sits out simply stops being dealt in;
    -- it is not paying blinds to be absent, so there is nothing urgent to say.
    SELECT t.tournament_id INTO v_tournament_id FROM public.tables t WHERE t.id = NEW.table_id;
    IF v_tournament_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT COALESCE(NULLIF(btrim(tn.name), ''), 'Your Tournament')
      INTO v_name FROM public.tournaments tn WHERE tn.id = v_tournament_id;
    v_name := COALESCE(v_name, 'Your Tournament');

    IF COALESCE(NEW.stack, 0) > 0 THEN
      v_stack := ' You have ' || to_char(round(NEW.stack), 'FM999,999,999,990') || ' chips left.';
    END IF;

    -- Copy carried over verbatim from notifyBlindingOff() so the intent that
    -- was already written and reviewed is preserved exactly.
    PERFORM public.fn_raise_notification(
      NEW.user_id,
      'tournament_blinding_off',
      'You Are Being Blinded Off',
      'Your seat in ' || v_name || ' is posting blinds without you.' || v_stack || ' Tap to take your seat.',
      '/table/' || NEW.table_id::text,
      jsonb_build_object('tableId', NEW.table_id, 'tournamentId', v_tournament_id, 'action', 'blinding_off')
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let a notification interfere with the engine writing a seat.
    RAISE WARNING 'fn_notify_blinding_off failed for seat %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_wallet_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid; v_union uuid; v_table_club uuid; v_is_tournament_table boolean; v_day date;
  v_cash numeric:=0; v_tournament numeric:=0; r record;
BEGIN
  -- 2026-09-04: a table add-on (top-up), a rebuy and a refund move cash-table
  -- money too, and a tournament add-on, rebuy, refund or prize reversal moves
  -- tournament money; this knew buy-in, cash-out, tournament buy-in, prize
  -- and bounty alone. A row with a table is cash; a row with a tournament and
  -- no table is tournament. The sign is the row's own type, never its name.
  IF NOT ((NEW.category IN('buyin','cashout','addon','rebuy','refund') AND NEW.table_id IS NOT NULL)
    OR (NEW.category IN('tournament_buyin','prize','bounty','addon','rebuy','refund','prize_reversal')
        AND NEW.related_entity_id IS NOT NULL AND NEW.table_id IS NULL))
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive (20260906152215). The exclusive form serialised
     every chip movement on the platform behind one lock and held it to
     commit: 2,731 waits over a second in one day, 2,916 statement timeouts,
     and the deadlock cycles that failed prize credits. Shared holders never
     block each other; only the range rebuilds take the exclusive lock, and
     they still wait for every in-flight trigger before they delete a day. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.table_id IS NOT NULL THEN
    SELECT t.union_id,t.club_id,(t.tournament_id IS NOT NULL)
      INTO v_union,v_table_club,v_is_tournament_table
      FROM public.tables t WHERE t.id=NEW.table_id;
    IF v_is_tournament_table THEN RETURN NULL; END IF;
    IF v_union IS NULL THEN
      -- A standalone table: the club is the table's club.
      v_club:=v_table_club;
    ELSE
      SELECT cm.club_id INTO v_club FROM public.club_members cm
        JOIN public.union_clubs uc ON uc.club_id=cm.club_id AND uc.union_id=v_union
       WHERE cm.user_id=NEW.user_id
       ORDER BY cm.joined_at ASC NULLS LAST,cm.club_id LIMIT 1;
    END IF;
    v_cash:=CASE WHEN NEW.type='credit' THEN NEW.amount
                 WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    IF v_club IS NOT NULL THEN
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(v_club,NEW.user_id,v_day,v_cash,0,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET cash_net=d.cash_net+EXCLUDED.cash_net,updated_at=now();
    END IF;
  ELSE
    v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount
                       WHEN NEW.type='debit' THEN -NEW.amount ELSE 0 END;
    /* ORDER BY club_id: two credits to players of the same event upsert the
       shared ca_club_tournament_daily rows in one order, so they wait on each
       other instead of cycling. */
    FOR r IN SELECT c.club_id FROM public.ca_reporting_tournament_clubs_for_user(NEW.user_id) c
              ORDER BY c.club_id LOOP
      INSERT INTO public.ca_club_player_daily AS d
        (club_id,user_id,stat_date,cash_net,tournament_net,updated_at)
      VALUES(r.club_id,NEW.user_id,v_day,0,v_tournament,now())
      ON CONFLICT(club_id,user_id,stat_date) DO UPDATE
       SET tournament_net=d.tournament_net+EXCLUDED.tournament_net,updated_at=now();
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,winnings,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,v_day,v_tournament,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET winnings=d.winnings+EXCLUDED.winnings,updated_at=now();
      INSERT INTO public.ca_club_tournament_player_daily
        (club_id,tournament_id,user_id,stat_date,updated_at)
      VALUES(r.club_id,NEW.related_entity_id,NEW.user_id,v_day,now())
      ON CONFLICT(club_id,tournament_id,user_id,stat_date) DO UPDATE SET updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data wallet rollup failed for tx %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_rake_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_day date; r record;
BEGIN
  IF NOT NEW.is_tournament OR NEW.tournament_id IS NULL OR NEW.rake_amount=0
    THEN RETURN NULL; END IF;
  /* SHARED, not exclusive - see trg_ca_reporting_wallet_insert and
     20260906152215. */
  PERFORM pg_advisory_xact_lock_shared(918273645);
  v_day:=(NEW.created_at AT TIME ZONE 'UTC')::date;
  IF NEW.metadata ? 'user_id' THEN
    FOR r IN
      SELECT c.club_id FROM public.tournament_players tp
      CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
      WHERE tp.tournament_id=NEW.tournament_id
        AND tp.user_id::text=NEW.metadata->>'user_id'
      ORDER BY c.club_id
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,NEW.rake_amount,now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  ELSE
    FOR r IN
      WITH total AS (SELECT count(*)::numeric n FROM public.tournament_players
                      WHERE tournament_id=NEW.tournament_id), mapped AS (
        SELECT c.club_id FROM public.tournament_players tp
        CROSS JOIN LATERAL public.ca_reporting_tournament_clubs_for_user(tp.user_id) c
        WHERE tp.tournament_id=NEW.tournament_id)
      SELECT m.club_id,count(*)::numeric AS club_players,t.n AS total_players
        FROM mapped m CROSS JOIN total t GROUP BY m.club_id,t.n
       ORDER BY m.club_id
    LOOP
      INSERT INTO public.ca_club_tournament_daily AS d
        (club_id,tournament_id,stat_date,fee,updated_at)
      VALUES(r.club_id,NEW.tournament_id,v_day,
             NEW.rake_amount*r.club_players/NULLIF(r.total_players,0),now())
      ON CONFLICT(club_id,tournament_id,stat_date) DO UPDATE
       SET fee=d.fee+EXCLUDED.fee,updated_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data rake rollup failed for row %: %',NEW.id,SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tables_creation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_variant text := lower(coalesce(NEW.game_variant, 'nlh'));
  v_cap integer;
  v_name text;
BEGIN
  -- ── name hygiene ──
  v_name := btrim(coalesce(NEW.name, ''));
  v_name := replace(replace(v_name, '<', ''), '>', '');
  IF length(v_name) = 0 THEN
    RAISE EXCEPTION 'table name is required';
  END IF;
  IF length(v_name) > 60 THEN
    v_name := left(v_name, 60);
  END IF;
  NEW.name := v_name;

  -- ── action time ──
  IF NEW.action_time_seconds IS NOT NULL
     AND (NEW.action_time_seconds < 10 OR NEW.action_time_seconds > 120) THEN
    RAISE EXCEPTION 'action_time_seconds must be between 10 and 120 (got %)', NEW.action_time_seconds;
  END IF;

  IF coalesce(NEW.game_type, '') = 'cash' THEN
    -- ── seat law ──
    v_cap := CASE v_variant
               WHEN 'plo6' THEN 6
               WHEN 'plo5' THEN 7
               WHEN 'plo4' THEN 8
               WHEN 'plo8' THEN 8
               WHEN 'flo8' THEN 8
               ELSE 9
             END;
    IF coalesce(NEW.max_players, 0) < 2 THEN
      RAISE EXCEPTION 'a cash table needs at least 2 seats (got %)', NEW.max_players;
    END IF;
    IF NEW.max_players > v_cap THEN
      RAISE EXCEPTION 'seat law: % allows at most % seats (got %) - the deck cannot fund three run-it boards above that',
        v_variant, v_cap, NEW.max_players;
    END IF;

    -- ── blinds ──
    IF coalesce(NEW.small_blind, 0) <= 0 OR coalesce(NEW.big_blind, 0) <= 0 THEN
      RAISE EXCEPTION 'blinds must be positive (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;
    IF NEW.big_blind <= NEW.small_blind THEN
      RAISE EXCEPTION 'big blind must exceed small blind (sb=%, bb=%)', NEW.small_blind, NEW.big_blind;
    END IF;

    -- ── buy-in order ──
    IF NEW.min_buy_in IS NOT NULL AND NEW.max_buy_in IS NOT NULL
       AND NEW.min_buy_in > NEW.max_buy_in THEN
      RAISE EXCEPTION 'min_buy_in (%) cannot exceed max_buy_in (%)', NEW.min_buy_in, NEW.max_buy_in;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tables_autostart_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.tournament_id IS NULL
     AND NEW.auto_start_players IS NOT NULL
     AND NEW.max_players IS NOT NULL
     AND NEW.auto_start_players > NEW.max_players THEN
    RAISE EXCEPTION
      'auto_start_players (%) cannot exceed max_players (%) - the table would never deal',
      NEW.auto_start_players, NEW.max_players;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_payouts_are_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_key bigint := hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_terminal_root boolean := false;
BEGIN
  IF session_user = 'postgres'
     AND COALESCE(current_setting('app.payout_record_correction', true), '') =
         'i_am_correcting_the_record' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid = pg_backend_pid()
         AND l.locktype = 'advisory'
         AND l.database = (
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname = current_database())
         AND l.classid = (((v_terminal_key >> 32) & 4294967295)::oid)
         AND l.objid = ((v_terminal_key & 4294967295)::oid)
         AND l.objsubid = 1
         AND l.mode = 'ExclusiveLock'
         AND l.granted)
      INTO v_owns_terminal_root;

    IF v_owns_terminal_root
       AND public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'tournament_payouts is an append-only payout record; % is refused (tournament %, user %, position %)',
    TG_OP, OLD.tournament_id, OLD.user_id, OLD."position"
    USING ERRCODE = 'restrict_violation',
          HINT = 'A DBA correcting a bad row must SET LOCAL app.payout_record_correction = ''i_am_correcting_the_record'' in the same transaction, from a migration that says why.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_sev text;
  v_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSIF TG_TABLE_NAME = 'vip_points_ledger' THEN
      /* Phase 8 (2026-09-08). A VIP leg is written once, final: the award
         writer no longer inserts 0 and updates it afterwards. Nothing on this
         table may change. */
      v_allowed_update := false;
    ELSIF TG_TABLE_NAME = 'agent_commissions' THEN
      /* Phase 8. A commission row is what was earned on one hand. The only
         thing that happens to it afterwards is being settled, once. */
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
        AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
        AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND (OLD.settled_at IS NULL OR NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at);
    ELSIF TG_TABLE_NAME = 'rakeback_period_payouts' THEN
      /* Phase 8. What was paid, to whom, for which period, never changes;
         status, paid_at, wallet_transaction_id and failure_reason are the
         payout's own bookkeeping. */
      v_allowed_update :=
        NEW.payout_amount IS NOT DISTINCT FROM OLD.payout_amount
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.rakeback_period_id IS NOT DISTINCT FROM OLD.rakeback_period_id
        AND NEW.currency IS NOT DISTINCT FROM OLD.currency
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  /* Phase 8. fn_close_settlement_period inserts a payout row as its
     idempotency claim BEFORE debiting the treasury and deletes it again on a
     shortfall, inside the same transaction. That is a compensation, not a
     mutation of history, so this table's DELETE is allowed - and RECORDED,
     every time, so a person can tell a compensation from a hand on the
     table. The meter counts these. */
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'rakeback_period_payouts' THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true),
            COALESCE(v_reason, 'rakeback-payout-delete: compensation on a treasury shortfall, or maintenance without app.ledger_maintenance'),
            to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      -- a routine, recorded maintenance is filed, not shouted about
      SELECT k.severity INTO v_sev
        FROM public.ca_ledger_maintenance_kinds k WHERE k.kind = v_kind;
      v_sev := COALESCE(v_sev, 'warning');
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', v_sev,
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. The diamond journal is deleted from on an hourly cadence by the
    -- certification fleet. Keep the row and say who took it. Nothing here can
    -- refuse the DELETE the branch above has already permitted.
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, v_reason)
        ON CONFLICT (id) DO NOTHING;

        PERFORM public.fn_ca_diamond_incident(
          'DR5:journal_row_deleted_under_maintenance', 'info',
          (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
          'fn_ca_journal_append_only',
          jsonb_build_object('reason', v_reason,
                             'reference_id', v_j->>'reference_id',
                             'type', v_j->>'type',
                             'db_role', current_user));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_chip_ledger_enrich()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev text;
BEGIN
  NEW.amount := round(NEW.amount, 2);
  NEW.created_at := COALESCE(NEW.created_at, now());

  NEW.epoch_id      := COALESCE(NEW.epoch_id, public.fn_ca_current_epoch());
  NEW.actor_service := COALESCE(NEW.actor_service,
                                current_setting('application_name', true));
  NEW.db_role       := COALESCE(NEW.db_role, current_user);
  NEW.correlation_id := COALESCE(NEW.correlation_id,
      NULLIF(current_setting('app.ledger_correlation', true), '')::uuid);
  NEW.settlement_id  := COALESCE(NEW.settlement_id,
      NULLIF(current_setting('app.ledger_settlement', true), ''));
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := NULLIF(current_setting('app.ledger_idempotency_key', true), '');
    IF NEW.idempotency_key IS NOT NULL THEN
      -- consume-once: the next row in this transaction must not inherit it
      PERFORM set_config('app.ledger_idempotency_key', '', true);
    END IF;
  END IF;

  /* PHASE 6.4 (2026-09-05): EVERY LEG NAMES ITS HAND OR ITS EVENT. The doors
     that know the hand say so on app.ledger_hand_id (the rake door and the
     BBJ drop, since today) or on a 'bbj:<hand>' settlement; the rake
     settlement is not read for it because it carries a random key when the
     hand is unknown, and a guessed hand is worse than none; a spin's reserve legs
     carry the spin on their prize_liability side. Read them here, once, so
     the hand and the event are columns a per-hand audit can index on rather
     than strings it has to parse. 231,211 legs a day; 29,617 named a hand
     and 50,359 an event before this. */
  IF NEW.hand_id IS NULL THEN
    NEW.hand_id := NULLIF(current_setting('app.ledger_hand_id', true), '')::uuid;
    IF NEW.hand_id IS NULL AND NEW.settlement_id ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.hand_id := split_part(NEW.settlement_id, ':', 2)::uuid;
    END IF;
  END IF;
  IF NEW.tournament_id IS NULL THEN
    NEW.tournament_id := NULLIF(current_setting('app.ledger_tournament_id', true), '')::uuid;
    /* PHASE 6 GATE (2026-09-05): a prize_liability side IS the event, on every
       category, not only the two spin ones. This is what the 6.4 measurement
       missed: 777 tournament rake settlements in three hours (the fee leaving
       an event to a union rake wallet or a club treasury) and every tournament
       add-on named nothing. Read against the rows first: all 777 from_entity_id
       values are real tournaments. The FROM side wins when both sides are
       prize_liability (a satellite seat's pool transfer, which already stamps
       the satellite itself). */
    IF NEW.tournament_id IS NULL THEN
      IF NEW.from_type = 'prize_liability' THEN NEW.tournament_id := NEW.from_entity_id;
      ELSIF NEW.to_type = 'prize_liability' THEN NEW.tournament_id := NEW.to_entity_id;
      END IF;
    END IF;
  END IF;
  /* PHASE 6 GATE: and a table_stack side IS the table. Every cash buy-in,
     add-on and cash-out carries the table on its felt side (231, 53 and 222
     of each measured in the same window, every one a real table row) and
     none of them carried table_id. A cash buy-in is not a hand; the table is
     the name it has. */
  IF NEW.table_id IS NULL THEN
    IF NEW.to_type = 'table_stack' THEN NEW.table_id := NEW.to_entity_id;
    ELSIF NEW.from_type = 'table_stack' THEN NEW.table_id := NEW.from_entity_id;
    END IF;
  END IF;

  -- Tamper evidence: monotone sequence + per-row content checksum. NOT chained
  -- through the previous row's hash at insert time - that would put a global
  -- serialization point (and deadlock surface) inside every money transaction,
  -- which the availability policy forbids. prev_hash is best-effort forensics.
  NEW.chain_seq := nextval('public.chip_ledger_chain_seq');
  SELECT row_hash INTO v_prev
    FROM public.chip_ledger
   WHERE chain_seq = NEW.chain_seq - 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(extensions.digest(
      'v1'
      || '|' || NEW.chain_seq::text
      || '|' || COALESCE(NEW.epoch_id::text,'')
      || '|' || NEW.amount::text
      || '|' || NEW.from_type || ':' || COALESCE(NEW.from_entity_id::text,'')
      || '|' || NEW.to_type   || ':' || COALESCE(NEW.to_entity_id::text,'')
      || '|' || NEW.category
      || '|' || COALESCE(NEW.idempotency_key,'')
      || '|' || COALESCE(NEW.correlation_id::text,'')
      || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_tournaments_creation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_paid int;
BEGIN
  IF COALESCE(NEW.max_players, 0) <= 0 THEN
    RAISE EXCEPTION
      'tournament guard: max_players must be positive (got %) - a tournament with no seats can never start',
      NEW.max_players
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payout_structure IS NOT NULL
     AND jsonb_typeof(NEW.payout_structure::jsonb) = 'array' THEN
    v_paid := jsonb_array_length(NEW.payout_structure::jsonb);
    IF v_paid > NEW.max_players THEN
      RAISE EXCEPTION
        'tournament guard: % paid places for % seats - more places than players who can enter',
        v_paid, NEW.max_players
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_reject_automated_user_club_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_user_id uuid;
  v_automated boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'club_members' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
    v_automated := COALESCE(NEW.is_bot, false);
  ELSIF TG_TABLE_NAME = 'agents' THEN
    v_club_id := NEW.club_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'table_seats' THEN
    -- A historical/departed seat remains immutable evidence. Only a live seat
    -- can put an automated player back onto a user-created club table.
    IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
    SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    SELECT t.club_id INTO v_club_id
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    v_user_id := NEW.user_id;
  ELSE
    RAISE EXCEPTION 'Unsupported Automated-Club Guard Table: %', TG_TABLE_NAME;
  END IF;

  v_automated := v_automated OR COALESCE(
    (SELECT p.is_horse FROM public.profiles p WHERE p.id = v_user_id), false
  );

  IF v_automated AND NOT public.fn_ca_house_board_allows_automation(v_club_id) THEN
    RAISE EXCEPTION 'AUTOMATED_PLAYER_HOUSE_BOARD_ONLY: Automated Players Cannot Enter A User-Created Club'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_entry_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tclub uuid;
BEGIN
  -- Maintenance escape for deliberate service operations.
  IF current_setting('app.ca_entry_gate_skip', true) = '1' THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_tclub FROM public.tournaments t WHERE t.id = NEW.tournament_id;
  IF v_tclub IS NULL THEN
    RETURN NEW; -- clubless tournament: nothing to scope against
  END IF;
  IF NOT public.fn_ca_entry_scope_ok(NEW.user_id, v_tclub) THEN
    RAISE EXCEPTION 'tournament entry refused: player % has no club membership in the scope of tournament % (club/union %). Join a club in this union first.',
      NEW.user_id, NEW.tournament_id, v_tclub
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money. This table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- CHIP STANDARD (2026-09-05): A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A
  -- WRITE. When a balance write was permitted (a money table outside this
  -- guard, or a permitted role), its chip_ledger leg is written by the
  -- autoledger inside that same statement, at trigger depth 2 or more.
  -- Refusing the leg while the write stands is the one outcome the standard
  -- cannot allow: 104 BBJ bank moves (9.69 chips) lost their legs this way at :55 and
  -- :00 up to 09-05 06:58 (ca_ledger_write_failures, sqlstate 55006), each one an unexplained movement on the BBJ meter. A direct
  -- INSERT on chip_ledger from a client (depth 1) is still refused.
  IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
  v_managed_command boolean :=
    COALESCE(current_setting('app.managed_game_lifecycle', true), '') = 'on';
  v_protected_tournament_keys text[] := ARRAY[
    'name', 'start_time', 'max_players', 'buy_in_amount', 'buy_in_fee',
    'guaranteed_prize', 'late_reg_mins', 'starting_chips', 'blind_structure',
    'payout_structure', 'game_type', 'variant', 'tournament_type', 'is_rebuy',
    'rebuy_cost', 'rebuy_chips', 'rebuy_levels', 'add_on_available',
    'addon_cost', 'addon_chips', 'is_bounty', 'bounty_amount', 'is_pko',
    'is_mystery_bounty', 'mystery_bounty_min', 'mystery_bounty_max',
    'description', 'short_description', 'min_players', 'late_reg_levels',
    'is_reentry', 'max_rebuys', 'max_reentries', 'addon_levels',
    'addon_break_minutes', 'is_private', 'is_vip_only', 'ban_chat',
    'all_in_or_fold', 'label_as_new', 'hide_club_name', 'is_pinned',
    'action_time_seconds', 'table_size', 'accelerated_mtt', 'big_blind_ante',
    'authorized_to_register', 'early_bird_enabled', 'early_bird_chips',
    'bubble_protection', 'final_table_deal_enabled', 'restart_every_minutes',
    'synchronized_breaks', 'is_multi_day', 'total_days', 'is_xmtt',
    'union_id', 'satellite_target_id', 'satellite_seats', 'spin_type',
    'mystery_bounty_profile', 'mystery_bounty_activation',
    'mystery_bounty_activation_value', 'mystery_bounty_pool_percent',
    'mystery_bounty_top_percent', 'settings'
  ];
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF lower(COALESCE(NEW.status, '')) IN ('closed', 'deleted')
       AND lower(COALESCE(OLD.status, '')) NOT IN ('closed', 'deleted')
       AND EXISTS (
         SELECT 1
         FROM public.table_seats ts
         WHERE ts.table_id = NEW.id
           AND ts.left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'This table cannot be closed while players are seated'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine
       AND NOT v_managed_command
       AND (
         lower(COALESCE(NEW.status, '')) = 'deleted'
         AND lower(COALESCE(OLD.status, '')) <> 'deleted'
         OR COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false)
       ) THEN
      RAISE EXCEPTION 'Table lifecycle changes must use fn_close_managed_game'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (
       SELECT 1
       FROM public.tournament_players tp
       WHERE tp.tournament_id = NEW.id
     ) THEN
    IF NOT v_is_engine
       AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (to_jsonb(NEW) -> v_key) IS DISTINCT FROM (to_jsonb(OLD) -> v_key) THEN
          RAISE EXCEPTION 'This tournament cannot be modified after a player has registered'
            USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_is_engine
     AND NOT v_managed_command
     AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
     AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
    RAISE EXCEPTION 'Tournament lifecycle changes must use fn_close_managed_game'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF EXISTS (
      SELECT 1 FROM public.table_seats ts
       WHERE ts.table_id = OLD.id AND ts.left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'This table cannot be deleted while players are seated'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_is_engine THEN
      RAISE EXCEPTION 'Tables are closed through fn_close_managed_game, never deleted'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This tournament cannot be deleted after a player has registered'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_is_engine THEN
    RAISE EXCEPTION 'Tournaments are cancelled through fn_close_managed_game, never deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_capture_managed_game_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_kind text := CASE TG_TABLE_NAME WHEN 'tables' THEN 'table' ELSE 'tournament' END;
  v_contract jsonb;
  v_hash text;
  v_last_hash text;
  v_version integer;
  v_sqlstate text;
  v_message text;
  v_dedupe text;
BEGIN
  IF v_kind = 'table' AND to_jsonb(NEW) -> 'tournament_id' <> 'null'::jsonb THEN
    RETURN NEW;
  END IF;

  v_contract := public.fn_managed_game_contract_document(v_kind, to_jsonb(NEW));

  -- ── NOTHING IN THE CONTRACT MOVED (2026-09-06) ───────────────────────────
  -- The engine and the cluster controller write `current_players`, `status`,
  -- `lifecycle`, `last_activity_at` and the lease columns thousands of times
  -- an hour, and every one of those is in the document's denylist. Comparing
  -- the documents is the same test the hash comparison below performs, minus
  -- the advisory lock and the indexed read - and it is derived from the
  -- document rather than from a second copy of the denylist, so it cannot
  -- drift the day a contract column is added.
  IF TG_OP = 'UPDATE'
     AND v_contract IS NOT DISTINCT FROM
         public.fn_managed_game_contract_document(v_kind, to_jsonb(OLD)) THEN
    RETURN NEW;
  END IF;

  -- ── THE CAPTURE CANNOT REFUSE THE WRITE IT DESCRIBES ─────────────────────
  BEGIN
    v_hash := public.fn_managed_game_contract_hash(v_contract);

    -- Updates of one physical row normally serialize already. This lock also
    -- protects repair/import paths that can publish the same logical game from
    -- separate statements before either has allocated its next version.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_kind || ':' || NEW.id::text, 0));

    SELECT contract_hash, version
      INTO v_last_hash, v_version
      FROM public.managed_game_contract_versions
     WHERE game_kind = v_kind AND game_id = NEW.id
     ORDER BY version DESC
     LIMIT 1;

    IF v_last_hash IS NOT DISTINCT FROM v_hash THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.managed_game_contract_versions (
      game_kind, game_id, club_id, union_id, version, contract,
      contract_hash, published_by, change_reason
    ) VALUES (
      v_kind, NEW.id, NEW.club_id, NEW.union_id, COALESCE(v_version, 0) + 1,
      v_contract, v_hash, auth.uid(),
      CASE
        WHEN TG_OP = 'INSERT' THEN 'created'
        WHEN auth.uid() IS NULL THEN 'system_revision'
        ELSE 'operator_revision'
      END
    );

    RETURN NEW;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_dedupe := 'contract_capture:' || v_kind || ':' || coalesce(v_sqlstate, 'unknown');

    -- The handler must not be able to fail either. A detector that raises is
    -- the defect it was written to catch, one level up.
    BEGIN
      UPDATE public.ca_drift_incidents
         SET occurrences  = occurrences + 1,
             last_seen_at = now(),
             metadata     = metadata
                            || jsonb_build_object('last_game_id', NEW.id,
                                                  'message', v_message)
       WHERE source = 'managed_game_contract_capture'
         AND dedupe_key = v_dedupe
         AND status IN ('open', 'acknowledged', 'reconciling');
      IF NOT FOUND THEN
        -- `classification` and `layer` are CHECK-constrained enums, read off
        -- the live catalogue rather than guessed: 'contract_capture_failed'
        -- and 'schema' are in neither list, and writing them would have made
        -- this handler raise - the exact defect one level up.
        INSERT INTO public.ca_drift_incidents (
          source, dedupe_key, classification, severity, layer,
          club_id, union_id, entity_type, entity_id, suspected_cause, metadata
        ) VALUES (
          'managed_game_contract_capture', v_dedupe, 'unknown',
          'critical', 'projection',
          NEW.club_id, NEW.union_id, v_kind, NEW.id,
          'fn_capture_managed_game_contract raised ' || coalesce(v_sqlstate, '?') ||
            '. The game write SUCCEEDED; the contract version row is missing.',
          jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message,
                             'game_kind', v_kind, 'first_game_id', NEW.id,
                             'tg_op', TG_OP)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- the incident could not be filed; the WARNING below still speaks
    END;

    RAISE WARNING
      'managed game contract capture failed for % % (%): % - the % write was NOT refused; incident filed under source managed_game_contract_capture',
      v_kind, NEW.id, v_sqlstate, v_message, TG_TABLE_NAME;

    RETURN NEW;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_registered_tournament_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  v_old := public.fn_managed_game_contract_document('tournament', to_jsonb(OLD));
  v_new := public.fn_managed_game_contract_document('tournament', to_jsonb(NEW));

  -- auth.uid() is present for an operator/browser request and null for the
  -- service-role tournament engine. The engine may execute deterministic
  -- lifecycle adaptations such as fitting a payout ladder to the final field;
  -- those changes are captured as a new system revision below. Operators can
  -- never use that exception because their JWT keeps auth.uid() populated.
  IF auth.uid() IS NOT NULL AND v_old IS DISTINCT FROM v_new AND EXISTS (
    SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Tournament contract cannot be modified after a player has registered'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_start_readiness()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_readiness jsonb;
  v_enforce boolean;
BEGIN
  IF upper(COALESCE(OLD.status::text, '')) IN ('ANNOUNCED', 'REGISTERING')
     AND upper(COALESCE(NEW.status::text, '')) IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
    SELECT COALESCE(c.guarantee_enforcement_enabled, true)
      INTO v_enforce
      FROM public.clubs c
     WHERE c.id = NEW.club_id;

    -- Serialize every enforced commitment against the exact account the
    -- overlay trigger will debit. After this lock is acquired, a competing
    -- start has either fully committed or rolled back before readiness reads.
    IF COALESCE(v_enforce, true) THEN
      IF COALESCE(NEW.is_private, false) OR NEW.union_id IS NULL THEN
        PERFORM 1 FROM public.clubs c WHERE c.id = NEW.club_id FOR UPDATE;
      ELSE
        PERFORM 1 FROM public.union_wallets uw WHERE uw.union_id = NEW.union_id FOR UPDATE;
      END IF;
    END IF;

    v_readiness := public.fn_tournament_management_readiness_for_row(to_jsonb(NEW));

    IF NOT COALESCE((v_readiness ->> 'can_start')::boolean, false) THEN
      IF v_readiness ->> 'state' = 'funding_blocked' THEN
        RAISE EXCEPTION 'Tournament cannot start because its guarantee is short by % chips',
          v_readiness ->> 'short_by' USING ERRCODE = '55000';
      END IF;
      RAISE EXCEPTION 'Tournament cannot start because its published contract is incomplete'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_publish_readiness()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_readiness jsonb := public.fn_tournament_management_readiness_for_row(to_jsonb(NEW));
BEGIN
  IF v_readiness ->> 'state' = 'funding_blocked' THEN
    RAISE EXCEPTION 'Tournament cannot be published because its guarantee is short by % chips',
      v_readiness ->> 'short_by' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_emit_managed_game_row_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club  uuid := COALESCE(to_jsonb(NEW) ->> 'club_id', to_jsonb(OLD) ->> 'club_id')::uuid;
  v_id    uuid := COALESCE(to_jsonb(NEW) ->> 'id',      to_jsonb(OLD) ->> 'id')::uuid;
  v_watch text[];
BEGIN
  -- Tournament backing tables are represented by the tournament event itself.
  IF TG_TABLE_NAME = 'tables' THEN
    IF COALESCE(to_jsonb(NEW) ->> 'tournament_id',
                to_jsonb(OLD) ->> 'tournament_id') IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Exactly the columns fn_list_managed_games projects for this kind. Keep
    -- these two lists in step with that function: a column the board reads and
    -- this does not watch is a row that silently stops refreshing.
    v_watch := CASE TG_TABLE_NAME
      WHEN 'tables' THEN ARRAY[
        'club_id', 'union_id', 'tournament_id', 'is_deleted', 'name', 'status',
        'game_variant', 'current_players', 'max_players', 'small_blind',
        'big_blind', 'min_buy_in', 'max_buy_in', 'created_at']
      ELSE ARRAY[
        'club_id', 'union_id', 'name', 'status', 'game_type', 'variant',
        'current_players', 'max_players', 'start_time', 'created_at',
        'buy_in_amount', 'guaranteed_prize', 'prize_pool']
    END;

    IF (SELECT jsonb_object_agg(k, COALESCE(to_jsonb(OLD) -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
       IS NOT DISTINCT FROM
       (SELECT jsonb_object_agg(k, COALESCE(to_jsonb(NEW) -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
    THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    'game_changed', v_club, NULL, NULL,
    CASE WHEN TG_TABLE_NAME = 'tables' THEN 'table' ELSE 'tournament' END,
    v_id, NULL, jsonb_build_object('operation', lower(TG_OP)));
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_fallback numeric;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. payout table, from the field that actually entered ─────────────
     Only when nobody has registered yet. With registrations present,
     fn_guard_managed_game_lifecycle protects payout_structure and this
     trigger currently runs BEFORE it, so writing here refuses the whole
     start. Re-enabled once the trigger is renamed to sort after the guard.

     NOT FOR A SPIN (2026-09-02). A Spin's ladder comes from the tier the
     wheel drew - 10x is 80/20 - and this rule is "pay the top N% of the
     field", which on three seats rounds to one place and silently replaced
     every high multiplier with winner-take-all. 32 games, 1,592 chips. */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  IF NEW.variant IS DISTINCT FROM 'spin' THEN
    IF v_entrants > 0 AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = 'public.tournaments'::regclass
            AND tg.tgname = 'zz_ca_fund_overlay_on_lock')
    THEN
      NULL;  -- stand down: the guard would refuse the start
    ELSIF v_entrants > 0 THEN
      v_places := GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));
      BEGIN
        v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
      EXCEPTION WHEN OTHERS THEN v_existing := NULL; END;

      IF v_existing IS NULL
         OR jsonb_typeof(v_existing) <> 'array'
         OR jsonb_array_length(v_existing) = 0
         OR v_existing = '[{"place":1,"percentage":100}]'::jsonb
         OR jsonb_array_length(v_existing) <> v_places
      THEN
        NEW.payout_structure := public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text;
      END IF;
    END IF;
  END IF;

  /* ── 2. the guarantee overlay, from the main bank ─────────────────────── */
  v_pool_before := round(COALESCE(NEW.prize_pool,0),2);
  v_guarantee   := round(COALESCE(NEW.guaranteed_prize,0),2);

  /* A GUARANTEED SEAT IS A GUARANTEE (2026-09-02). A satellite's advertised
     seats are worth target buy-in + fee each; the engine awards every one of
     them, so the bank funds the shortfall here, like any other guarantee. */
  IF COALESCE(NEW.satellite_seats, 0) > 0
     AND (NEW.variant = 'satellite'
          OR UPPER(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
          OR NEW.satellite_target_id IS NOT NULL) THEN
    v_target := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
    IF v_target IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount,0) + COALESCE(t2.buy_in_fee,0)) * NEW.satellite_seats, 2)
        INTO v_seat_guarantee
        FROM public.tournaments t2 WHERE t2.id = v_target;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_short := GREATEST(0, v_guarantee - v_pool_before);
  IF v_short <= 0 THEN RETURN NEW; END IF;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR UPDATE;
    v_from := 'union_bank';
    v_store := 'union_wallets.chip_balance';
    IF COALESCE(v_bank,0) < v_short THEN
      /* THE MAIN BANK IS SHORT - FALL BACK TO THE CLUB TREASURY.
         Dan 2026-09-04. Refusing here meant advertising a guarantee and then
         not paying it. */
      SELECT chip_treasury INTO v_fallback
        FROM public.clubs WHERE id = NEW.club_id FOR UPDATE;

      IF COALESCE(v_fallback,0) >= v_short THEN
        v_from  := 'club_treasury';
        v_store := 'clubs.chip_treasury';
        PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
        UPDATE public.clubs
           SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
         WHERE id = NEW.club_id;
        PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
        PERFORM public.fn_raise_server_financial_alert(
          'warning', 'fn_ca_fund_overlay_on_lock',
          format('%s took its %s chip overlay from the club treasury: the union bank held only %s. The guarantee WAS met. Refill the union bank.',
                 COALESCE(NEW.name, NEW.id::text), v_short, COALESCE(v_bank,0)),
          jsonb_build_object('kind','overlay_funded_from_fallback','tournament_id',NEW.id,
            'shortfall',v_short,'union_bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        v_union := NULL;  -- the ledger row names the account that actually moved
      ELSE
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_ca_fund_overlay_on_lock',
          format('%s needs %s chips of overlay to meet its %s guarantee. The union bank holds %s and the club treasury holds %s. BOTH are short and the pool was NOT topped up.',
                 COALESCE(NEW.name, NEW.id::text), v_short, v_guarantee,
                 COALESCE(v_bank,0), COALESCE(v_fallback,0)),
          jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
            'shortfall',v_short,'bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        RETURN NEW;
      END IF;
    ELSE
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets
         SET chip_balance = chip_balance - v_short, updated_at = now()
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    END IF;
  ELSE
    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR UPDATE;
    v_from := 'club_treasury';
    v_store := 'clubs.chip_treasury';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the club treasury holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;

  NEW.prize_pool := round(v_pool_before + v_short, 2);

  -- Funding and its escrow/journal leg are one transaction. A failed
  -- journal insert must undo the bank debit and the advertised pool change.
  -- Retry only transient deadlocks; every final error propagates to the
  -- original status update, whose existing lifecycle can retry safely.
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
        v_short, 'overlay', NEW.club_id, NEW.id,
        format('Guarantee overlay from the main bank: %s (%s) was %s short of its %s guarantee - field made %s, bank paid %s',
               COALESCE(NEW.name, 'tournament'), NEW.id::text,
               v_short, v_guarantee,
               v_pool_before, v_short));
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_attempt = 3 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_record_frozen_pool_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.created_at < '2026-08-22' THEN
    BEGIN
      INSERT INTO public.ca_frozen_pool_deletions
        (wallet_id, user_id, wallet_type, deleted_balance, row_created_at,
         db_role, app_name, note)
      VALUES
        (OLD.id, OLD.user_id, OLD.wallet_type, COALESCE(OLD.balance,0), OLD.created_at,
         current_user, COALESCE(current_setting('application_name', true), ''),
         'pre-freeze wallet row deleted (cascade or direct)');
    EXCEPTION WHEN OTHERS THEN
      -- Never block an account teardown to record it.
      NULL;
    END;
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_rake_belongs_to_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner       uuid;   -- the club/union that owns the table or tournament
  v_owner_union uuid;   -- if the owner is a club in a union, that union
  v_is_union    boolean;
BEGIN
  IF NEW.club_id IS NULL THEN
    RETURN NEW;  -- a null club_id cannot enter another club's ledger
  END IF;

  IF NEW.table_id IS NOT NULL THEN
    SELECT club_id INTO v_owner FROM public.tables WHERE id = NEW.table_id;
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'rake references table % which does not exist', NEW.table_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.tournament_id IS NOT NULL THEN
    SELECT club_id INTO v_owner FROM public.tournaments WHERE id = NEW.tournament_id;
    IF v_owner IS NULL THEN
      RETURN NEW;  -- clubless tournament: nothing to scope against
    END IF;
  ELSE
    RETURN NEW;    -- neither table nor tournament: nothing to check
  END IF;

  -- The fast path: rake attributed to the owning entity itself.
  IF NEW.club_id = v_owner THEN
    RETURN NEW;
  END IF;

  -- Is the owner a UNION? Then member clubs may earn from its shared table.
  SELECT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_owner) INTO v_is_union;
  IF v_is_union THEN
    IF EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = NEW.club_id
         AND (c.union_id = v_owner
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = v_owner))
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'rake club isolation: club_id % is not a member of union % that owns this game',
      NEW.club_id, v_owner USING ERRCODE = 'check_violation';
  END IF;

  -- The owner is a CLUB. It may still legitimately attribute to a SIBLING in
  -- its own union (a union whose shared table is recorded under the hosting
  -- club rather than the union id). But NEVER outside that union - and a
  -- STANDALONE club (union_id NULL) has no siblings at all, so its ledger is
  -- sealed to itself.
  SELECT union_id INTO v_owner_union FROM public.clubs WHERE id = v_owner;
  IF v_owner_union IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id = NEW.club_id
       AND (c.union_id = v_owner_union OR c.id = v_owner_union
            OR EXISTS (SELECT 1 FROM public.union_clubs uc
                        WHERE uc.club_id = c.id AND uc.union_id = v_owner_union))
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'rake club isolation: club_id % may not receive rake from a game owned by club % (no shared union)',
    NEW.club_id, v_owner USING ERRCODE = 'check_violation';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_ladder_is_the_drawn_one()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_expected jsonb;
  v_actual   jsonb;
  v_booked jsonb;
BEGIN
  SELECT r.receipt INTO v_booked FROM public.spin_draw_receipts r
   WHERE r.tournament_id=NEW.id;
  IF v_booked IS NOT NULL THEN
    IF NEW.variant IS DISTINCT FROM 'spin'
       OR NEW.buy_in_amount IS DISTINCT FROM (v_booked->>'buy_in')::numeric
       OR NEW.starting_chips IS DISTINCT FROM (v_booked->>'starting_chips')::int THEN
      RAISE EXCEPTION 'A booked Spin keeps its funded entry and board contract' USING ERRCODE='23514';
    END IF;
    -- Do not project the secret before the engine's reveal. Once projected,
    -- clearing or replacing that result cannot detach it from its receipt.
    IF NEW.spin_multiplier IS NULL AND TG_OP='UPDATE' AND OLD.spin_multiplier IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.spin_multiplier IS DISTINCT FROM (v_booked->>'multiplier')::numeric THEN
      RAISE EXCEPTION 'A booked Spin keeps its original multiplier' USING ERRCODE='23514';
    END IF;
    v_expected := v_booked->'payout_structure';
    NEW.blind_structure := (v_booked->'blind_structure')::text;
  ELSIF COALESCE(NEW.variant,'') <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  -- Before the wheel is drawn there is no ladder to enforce.
  IF NEW.spin_multiplier IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_booked IS NULL THEN
    SELECT structure INTO v_expected
      FROM public.spin_payout_ladder WHERE multiplier = NEW.spin_multiplier;
  END IF;

  -- An unknown multiplier is a real question, not something to guess at.
  IF v_expected IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_actual := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_actual := NULL;
  END;

  IF v_actual IS NOT DISTINCT FROM v_expected THEN
    RETURN NEW;
  END IF;

  NEW.payout_structure := v_expected::text;

  BEGIN
    PERFORM public.fn_raise_server_financial_alert(
      'critical',
      'fn_spin_ladder_is_the_drawn_one',
      format('Spin %s (%sx) had its payout ladder overwritten with %s; the drawn ladder %s was restored before it could underpay anyone.',
             COALESCE(NEW.name, NEW.id::text), NEW.spin_multiplier,
             COALESCE(v_actual::text,'(unreadable)'), v_expected::text),
      jsonb_build_object('kind','spin_ladder_overwritten',
                         'tournament_id', NEW.id,
                         'multiplier', NEW.spin_multiplier,
                         'was', v_actual,
                         'restored_to', v_expected),
      NEW.id::text);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the correction matters more than the alarm
  END;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
  v_tournament_id uuid;
  v_variant text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id, t.variant, t.max_players, t.starting_chips
    INTO v_tournament_id, v_variant, v_max_players, v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack <= 0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack
        USING ERRCODE = 'check_violation',
              HINT = 'Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF lower(COALESCE(v_variant,'')) = 'spin'
       OR COALESCE(v_max_players,0) <= 2 THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips <= 0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id, v_starting_chips
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.stack IS DISTINCT FROM v_starting_chips THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id, NEW.table_id, NEW.seat_number, NEW.stack, v_starting_chips
          USING ERRCODE = 'check_violation',
                HINT = 'The paid seat transaction is the only starting-stack authority; no later top-up exists.';
      END IF;
    END IF;
  END IF;

  -- Cash seats with no funded stack preserve their existing reservation path.
  IF COALESCE(NEW.stack,0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_assign_tournament_player_seat_atomic',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path, ''), 'none'),
    COALESCE(auth.role(), 'none'),
    COALESCE(NULLIF(current_setting('application_name', true), ''), 'none'),
    NEW.table_id, NEW.seat_number, NEW.stack
    USING ERRCODE = 'check_violation',
          HINT = 'The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_freerolls_are_free_buy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed jsonb := '{}'::jsonb;
  v_stack   integer;
  v_op      text;
  v_priced  boolean;
BEGIN
  IF NOT public.fn_is_free_buy_event(
       NEW.buy_in_amount, NEW.buy_in_fee, NEW.tournament_type, NEW.variant
     ) THEN
    RETURN NEW;
  END IF;

  -- A live or finished event keeps the contract its players entered under.
  -- Inserts are always pre-start.
  IF TG_OP = 'UPDATE'
     AND upper(COALESCE(NEW.status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  v_stack := COALESCE(NULLIF(NEW.starting_chips, 0), 10000);

  /* A SCHEDULED FREE BUY PRICES ITSELF (Dan 2026-09-04). `free_buy` marks the
     5-a-day board, whose feature event charges 2.00. Every other freeroll -
     anything created with a 0 buy-in anywhere in the product - still gets the
     1.00 default forced on it, which is the 2026-09-02 law unchanged. A NULL
     or non-positive price is never honoured: that is a missing value, not a
     decision, and it falls through to the default. */
  v_priced := COALESCE(NEW.free_buy, false) AND COALESCE(NEW.rebuy_cost, 0) > 0;

  IF NEW.buy_in_fee IS DISTINCT FROM 0 THEN
    v_changed := v_changed || jsonb_build_object('buy_in_fee',
      jsonb_build_object('from', NEW.buy_in_fee, 'to', 0));
    NEW.buy_in_fee := 0;
  END IF;

  IF NOT COALESCE(NEW.is_rebuy, false) THEN
    v_changed := v_changed || jsonb_build_object('is_rebuy',
      jsonb_build_object('from', NEW.is_rebuy, 'to', true));
    NEW.is_rebuy := true;
  END IF;

  IF NOT COALESCE(NEW.add_on_available, false) THEN
    v_changed := v_changed || jsonb_build_object('add_on_available',
      jsonb_build_object('from', NEW.add_on_available, 'to', true));
    NEW.add_on_available := true;
  END IF;

  IF NOT v_priced AND NEW.rebuy_cost IS DISTINCT FROM 1.00 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_cost',
      jsonb_build_object('from', NEW.rebuy_cost, 'to', 1.00));
    NEW.rebuy_cost := 1.00;
  END IF;

  IF NOT v_priced AND NEW.addon_cost IS DISTINCT FROM 1.00 THEN
    v_changed := v_changed || jsonb_build_object('addon_cost',
      jsonb_build_object('from', NEW.addon_cost, 'to', 1.00));
    NEW.addon_cost := 1.00;
  END IF;

  /* A priced Free Buy that forgot its add-on price still gets one: the add-on
     matches the rebuy rather than falling to 1.00 under a 2.00 rebuy, which
     would be a price nobody chose. */
  IF v_priced AND COALESCE(NEW.addon_cost, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_cost',
      jsonb_build_object('from', NEW.addon_cost, 'to', NEW.rebuy_cost));
    NEW.addon_cost := NEW.rebuy_cost;
  END IF;

  IF COALESCE(NEW.rebuy_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_chips',
      jsonb_build_object('from', NEW.rebuy_chips, 'to', v_stack));
    NEW.rebuy_chips := v_stack;
  END IF;

  IF COALESCE(NEW.addon_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_chips',
      jsonb_build_object('from', NEW.addon_chips, 'to', v_stack));
    NEW.addon_chips := v_stack;
  END IF;

  IF COALESCE(NEW.rebuy_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_levels',
      jsonb_build_object('from', NEW.rebuy_levels, 'to', 4));
    NEW.rebuy_levels := 4;
  END IF;

  IF COALESCE(NEW.addon_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_levels',
      jsonb_build_object('from', NEW.addon_levels, 'to', 1));
    NEW.addon_levels := 1;
  END IF;

  IF NEW.max_rebuys IS NOT NULL AND NEW.max_rebuys <= 0 THEN
    v_changed := v_changed || jsonb_build_object('max_rebuys',
      jsonb_build_object('from', NEW.max_rebuys, 'to', NULL));
    NEW.max_rebuys := NULL;
  END IF;

  IF v_changed <> '{}'::jsonb THEN
    v_op := CASE
      WHEN COALESCE(current_setting('app.freeroll_free_buy_backfill', true), '') = 'on'
        THEN 'BACKFILL'
      ELSE TG_OP
    END;
    BEGIN
      INSERT INTO public.ca_freeroll_free_buy_log
        (tournament_id, tournament_name, op, status, changed)
      VALUES
        (NEW.id, NEW.name, v_op, NEW.status, v_changed);
    EXCEPTION WHEN OTHERS THEN
      -- The log is evidence, not a gate. Never let it block the row.
      RAISE WARNING 'fn_freerolls_are_free_buy: could not log % for %: %',
        v_op, NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_money_path_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_cat  text;
  v_mode text;
  v_exact_refund_token uuid;
BEGIN
  v_path := COALESCE(current_setting('app.money_path', true), '');
  IF v_path IN (
       'fn_settle_tournament_obligation',
       'fn_settle_satellite_tournament') THEN
    RETURN NEW;
  END IF;

  v_cat := lower(COALESCE(NEW.category, ''));

  -- The exact refund authority (fn_settle_tournament_refund_exact, the only
  -- payer of a tournament refund since 20260909165629) books an authorization
  -- row before its insert and stamps its token in app.ca_exact_refund_token;
  -- the escrow trigger consumes that row after this one fires. The credit is
  -- authorized when the row on the books names this tournament, this player
  -- and this amount. A token with no row is not an authority.
  IF v_cat = 'refund' THEN
    BEGIN
      v_exact_refund_token :=
        NULLIF(current_setting('app.ca_exact_refund_token', true), '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_exact_refund_token := NULL;
    END;
    IF v_exact_refund_token IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_refund_token
         AND a.tournament_id = NEW.related_entity_id
         AND a.user_id = NEW.user_id
         AND round(a.amount_paid_now, 2) = round(NEW.amount, 2)
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- The mode is data, so the way back is an UPDATE and not a deploy. A missing
  -- row means log: this guard never becomes stricter by accident.
  SELECT e.mode INTO v_mode FROM public.ca_money_path_enforcement e WHERE e.only_row;
  v_mode := COALESCE(v_mode, 'log');

  IF v_mode = 'refuse' THEN
    -- Nothing survives this raise, so the message carries the evidence: who
    -- wrote, from where, for how much, against which entity.
    RAISE EXCEPTION
      'R3: a % credit of % was written outside fn_settle_tournament_obligation (money_path=%, app=%, role=%, wallet_transactions.related_entity_id=%). Route it through fn_settle_tournament_obligation. To reopen the door: UPDATE public.ca_money_path_enforcement SET mode = ''log'';',
      COALESCE(NULLIF(v_cat, ''), '<none>'), NEW.amount, COALESCE(NULLIF(v_path, ''), '<none>'),
      COALESCE(NULLIF(current_setting('application_name', true), ''), '<none>'),
      session_user::text, NEW.related_entity_id
      USING ERRCODE = 'raise_exception';
  END IF;

  BEGIN
    INSERT INTO public.ca_money_path_violations
      (table_name, user_id, amount, category, description, related_entity_id,
       money_path, app_name, db_role)
    VALUES
      (TG_TABLE_NAME, NEW.user_id, NEW.amount, NEW.category, NEW.description,
       NEW.related_entity_id, NULLIF(v_path, ''),
       NULLIF(current_setting('application_name', true), ''),
       session_user::text);
  EXCEPTION WHEN OTHERS THEN
    -- The logger must never be the reason a credit fails.
    NULL;
  END;

  BEGIN
    -- Global scope (no entity dimension) so it files for every union; the
    -- tournament id travels in metadata only. INFO never pages.
    PERFORM public.fn_ca_raise_drift_incident(
      p_source         => 'r3_money_path_log',
      p_classification => 'unauthorized_adjustment',
      p_severity       => 'info',
      p_dedupe_key     => 'r3:' || v_cat || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24'),
      p_discrepancy    => NEW.amount,
      p_layer          => 'settlement',
      p_entity_type    => 'wallet_transactions',
      p_entity_id      => NEW.id,
      p_suspected_cause => 'a tournament-category credit was written outside fn_settle_tournament_obligation (R3, log-only)',
      p_metadata       => jsonb_build_object('category', NEW.category, 'money_path', NULLIF(v_path, ''),
                            'related_entity_id', NEW.related_entity_id,
                            'app_name', NULLIF(current_setting('application_name', true), ''),
                            'session_user', session_user::text));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_new_entries_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_cash boolean;
BEGIN
  /* Classify non-admissions before asking for the boundary. Departures,
     ordinary seat updates, tournament table balancing, earned satellite
     seats, and non-RUNNING status changes can arrive inside transactions that
     already own their own rows. They are not new entry and must never acquire
     this lock late. */
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'UPDATE'
       AND NOT (
         (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL)
         OR OLD.user_id IS DISTINCT FROM NEW.user_id
       ) THEN
      RETURN NEW;
    END IF;

    SELECT (t.tournament_id IS NULL) INTO v_is_cash
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    /* Tournament seating is movement inside an already-admitted field. This
       includes INSERT and reuse of a vacated destination row (UPDATE that
       clears left_at or changes user_id). Freezing the latter after its source
       seat was vacated strands a player between tables. New tournament entry
       remains guarded at tournament_players and in its canonical outer RPC. */
    IF NOT COALESCE(v_is_cash, true) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'tournaments' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'RUNNING' THEN
      RETURN NEW;
    END IF;
    /* This is not a new launch: fn_begin_tournament_launch_atomic already
       admitted it before the maintenance boundary. Only the private completion
       RPC can set this exact transaction-local marker, and the immutable
       incomplete receipt proves which launch it is completing. */
    IF OLD.status = 'REGISTERING'
       AND EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts r
          WHERE r.tournament_id = NEW.id
            AND r.completed_at IS NULL
            AND current_setting('app.atomic_tournament_launch', true)
                = NEW.id::text || ':' || r.launch_id::text
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_LAUNCH_RECEIPT_REQUIRED: REGISTERING to RUNNING belongs to the atomic launch completion RPC'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'tournament_players' THEN
    /* Every roster insertion must serialize on its tournament parent before
       launch completion proves the field. Canonical registration functions
       already take this lock before their first child mutation, so this is
       re-entrant there; it closes the direct-owner/legacy path that could
       otherwise commit a new registered row between completion's roster read
       and its RUNNING write. */
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
        USING ERRCODE = '23503';
    END IF;

    IF COALESCE(NEW.is_satellite_qualifier, false)
       AND NEW.source_satellite_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true)
           = NEW.source_satellite_id::text THEN
      RETURN NEW;
    END IF;
  END IF;

  /* Canonical RPCs own this already, so try-lock is re-entrant. A direct or
     previously unknown outer caller fails without waiting while it may hold
     other rows; this is the deadlock-safe backstop, not the normal path. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_entry_purchases_frozen() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'PLATFORM_FROZEN: scheduled maintenance has closed new entries. % on % was refused without moving chips.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55006',
          HINT = 'Retry after the maintenance break has ended.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_refuse_restricted_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_scope    text := coalesce(tg_argv[0], 'account');
  v_user     uuid;
  v_enforced boolean := false;
  v_tourney  uuid;
  v_row      public.ca_player_restrictions;
begin
  begin
    v_user := new.user_id;
    if v_user is null then
      return new;
    end if;

    -- THE HOT PATH, and the only thing that runs for a player nobody has
    -- restricted: one probe of the partial index
    -- ca_player_restrictions_active_by_user, which on a platform with no
    -- restrictions is a handful of pages. Everything below it - the
    -- table lookup, the policy read, the observation write - happens
    -- only for a player who genuinely carries a live restriction.
    if not exists (
      select 1 from public.ca_player_restrictions r
       where r.user_id = v_user
         and r.status = 'active'
         and (r.expires_at is null or r.expires_at > now())
    ) then
      return new;
    end if;

    -- THE SCOPE THIS WRITE ACTUALLY BELONGS TO. table_seats carries both
    -- cash and tournament seats and 97.8% of its rows are tournament
    -- ones, so the trigger argument is a DEFAULT, not an answer.
    if tg_table_name = 'table_seats' then
      select t.tournament_id into v_tourney
        from public.tables t where t.id = new.table_id;
      v_scope := case when v_tourney is not null then 'tournaments' else 'cash' end;
    end if;

    if not public.fn_ca_player_restricted(v_user, v_scope) then
      return new;
    end if;

    select restrictions_enforced into v_enforced
      from public.ca_operator_policy limit 1;
    v_enforced := coalesce(v_enforced, false);

    v_row := public.fn_ca_player_restriction_for(v_user, v_scope);

    if not v_enforced then
      insert into public.ca_restriction_observations
        (user_id, scope, restriction_id, table_name, op, would_refuse, detail)
      values (
        v_user, v_scope, v_row.id, tg_table_name, tg_op, true,
        jsonb_build_object(
          'reason_code', v_row.reason_code,
          'restriction_scope', v_row.scope,
          'applied_at', v_row.applied_at,
          'expires_at', v_row.expires_at,
          -- Which of the two ways in this was, so the evidence says
          -- whether the revive path is being used at all.
          'seating_op', tg_op,
          'tournament_id', v_tourney));
      return new;
    end if;

    raise exception
      'PLAYER_RESTRICTED: this account is restricted (%) and cannot % on %.',
      v_row.reason_code, tg_op, tg_table_name
      using errcode = '42501',
            hint = 'An operator applied this restriction. It can be lifted from the Players tab in the operator console.';

  exception
    when insufficient_privilege then
      raise;
    when others then
      return new;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_pol public.ca_mint_policy%ROWTYPE;
  v_24h numeric;
BEGIN
  IF NEW.from_type = ANY (v_outside) AND NOT (NEW.to_type = ANY (v_outside))
     AND NEW.category <> 'correction' THEN
    SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
    IF NEW.amount > v_pol.per_operation_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: % chips in one leg is over the per-operation ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        NEW.amount, v_pol.per_operation_cap_chips USING ERRCODE = 'P0403';
    END IF;
    v_24h := public.fn_ca_mint_issued_24h('chips', NEW.id) + NEW.amount;
    IF v_24h > v_pol.rolling_24h_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: this leg would bring the last 24 hours to % chips, over the rolling ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        v_24h, v_pol.rolling_24h_cap_chips USING ERRCODE = 'P0403';
    END IF;
  END IF;
  PERFORM public.fn_ca_register_issuance_leg(NEW.id);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ids uuid[];
BEGIN
  SELECT array_agg(n.id) INTO v_ids
    FROM new_rows n
   WHERE NOT coalesce(n.is_tournament, false) AND n.club_id IS NOT NULL;
  IF v_ids IS NOT NULL THEN
    PERFORM public.fn_ca_club_rake_daily_apply(v_ids);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily insert rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_lo date; v_hi date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Transition tables cannot be combined with a column list, so the
    -- trigger fires on every UPDATE and the filter is here. A hand_id relink
    -- or a metadata touch names no day.
    SELECT min(x.d), max(x.d) INTO v_lo, v_hi
      FROM (
        SELECT (o.created_at AT TIME ZONE 'UTC')::date AS d
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
            OR o.bbj_contribution IS DISTINCT FROM n.bbj_contribution
            OR o.pot_size IS DISTINCT FROM n.pot_size
            OR o.created_at IS DISTINCT FROM n.created_at
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.table_id IS DISTINCT FROM n.table_id
            OR o.is_tournament IS DISTINCT FROM n.is_tournament
            OR o.player_contributions IS DISTINCT FROM n.player_contributions
        UNION ALL
        SELECT (n.created_at AT TIME ZONE 'UTC')::date
          FROM old_rows o JOIN new_rows n ON n.id = o.id
         WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
            OR o.bbj_contribution IS DISTINCT FROM n.bbj_contribution
            OR o.pot_size IS DISTINCT FROM n.pot_size
            OR o.created_at IS DISTINCT FROM n.created_at
            OR o.club_id IS DISTINCT FROM n.club_id
            OR o.table_id IS DISTINCT FROM n.table_id
            OR o.is_tournament IS DISTINCT FROM n.is_tournament
            OR o.player_contributions IS DISTINCT FROM n.player_contributions
      ) x;
  ELSE
    SELECT min((o.created_at AT TIME ZONE 'UTC')::date), max((o.created_at AT TIME ZONE 'UTC')::date)
      INTO v_lo, v_hi
      FROM old_rows o;
  END IF;
  IF v_lo IS NOT NULL THEN
    -- include_today => true: somebody changed a rake row, and the rollup has
    -- to follow it today, not tomorrow.
    PERFORM public.fn_ca_club_rake_daily_rebuild_range(v_lo, v_hi, true);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ca_club_rake_daily change rollup failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_wallet_tx()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cat text := lower(COALESCE(NEW.category,''));
  v_amt numeric := round(COALESCE(NEW.amount,0),2);
  v_bounty numeric;
  v_split record;
  v_ent_count bigint;
  v_ent_amount numeric;
  v_wallet_count bigint;
  v_wallet_amount numeric;
  v_exact_token uuid := NULLIF(
    current_setting('app.ca_exact_refund_token',true),'')::uuid;
  v_authorization public.tournament_refund_authorizations%ROWTYPE;
  v_rows integer;
  v_credit_ledger_id uuid;
BEGIN
  IF NEW.related_entity_id IS NULL OR v_amt = 0 THEN RETURN NULL; END IF;
  IF NEW.type = 'debit' AND v_cat IN ('tournament_buyin','rebuy','addon') THEN
    SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
      NEW.related_entity_id,v_cat,v_amt);
    SELECT count(*),round(COALESCE(sum(e.gross),0),2)
      INTO v_ent_count,v_ent_amount
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=NEW.related_entity_id AND e.user_id=NEW.user_id
       AND e.entitlement_kind='wallet_charge'
       AND e.charge_category=v_cat;
    SELECT count(*),round(COALESCE(sum(w.amount),0),2)
      INTO v_wallet_count,v_wallet_amount
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=NEW.related_entity_id AND w.user_id=NEW.user_id
       AND w.type='debit' AND lower(w.category)=v_cat;
    IF v_ent_count IS DISTINCT FROM v_wallet_count
       OR v_ent_amount IS DISTINCT FROM v_wallet_amount THEN
      RAISE EXCEPTION
        'tournament wallet debit has no exact immutable charge entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    v_bounty := v_split.refund_bounty;
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,v_cat,p_gross_in => v_amt,p_bounty_in => v_bounty);
  ELSIF NEW.type = 'credit' AND v_cat = 'prize' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize',p_prize_out => v_amt);
  ELSIF NEW.type = 'debit' AND v_cat IN ('prize','prize_reversal') THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize reversal',p_prize_out => -v_amt);
  ELSIF NEW.type = 'credit' AND v_cat = 'bounty' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'bounty',p_bounty_out => v_amt);
  ELSIF NEW.type = 'credit' AND v_cat IN ('refund','tournament_refund') THEN
    IF v_exact_token IS NULL THEN
      RAISE EXCEPTION
        'tournament refund credits require the one-use exact refund authority'
        USING ERRCODE = '42501';
    ELSE
      SELECT * INTO v_authorization
        FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.tournament_id IS DISTINCT FROM NEW.related_entity_id
         OR v_authorization.user_id IS DISTINCT FROM NEW.user_id
         OR v_authorization.amount_paid_now IS DISTINCT FROM v_amt
         OR v_authorization.description IS DISTINCT FROM NEW.description
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_entitlements e
            WHERE e.id=v_authorization.entitlement_id
              AND e.tournament_id=NEW.related_entity_id
              AND e.user_id=NEW.user_id
              AND e.refund_wallet_club_id=
                    v_authorization.source_wallet_club_id
              AND e.gross=v_authorization.amount_paid_now
              AND e.refund_prize=v_authorization.refund_prize
              AND e.refund_bounty=v_authorization.refund_bounty
              AND e.refund_fee=v_authorization.refund_fee)
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.id = v_authorization.obligation_id
              AND o.tournament_id = NEW.related_entity_id
              AND o.kind = 'refund' AND o.place IS NULL
              AND o.user_id = NEW.user_id
              AND o.amount_paid IS NOT DISTINCT FROM
                    v_authorization.amount_paid_before)
         OR NOT EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency k
            WHERE k.key = v_authorization.idempotency_key
              AND k.user_id = NEW.user_id AND k.amount = v_amt) THEN
        RAISE EXCEPTION 'wallet refund has no exact authorized component tranche'
          USING ERRCODE = 'P0404';
      END IF;
      DELETE FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'exact refund authorization was not consumed once'
          USING ERRCODE = '40001';
      END IF;
      SELECT count(*),min(l.id::text)::uuid
        INTO v_rows,v_credit_ledger_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key = v_authorization.idempotency_key
         AND l.tournament_id = NEW.related_entity_id
         AND l.club_id = v_authorization.source_wallet_club_id
         AND l.category = 'refund'
         AND l.from_type = 'prize_liability'
         AND l.from_entity_id = NEW.related_entity_id
         AND l.to_type = 'player_wallet'
         AND l.to_entity_id = NEW.user_id
         AND l.amount = v_amt;
      IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
        RAISE EXCEPTION
          'wallet refund has no single exact source-club journal credit'
          USING ERRCODE = 'P0404';
      END IF;
      INSERT INTO public.tournament_refund_tranches(
        wallet_transaction_id,idempotency_key,tournament_id,obligation_id,user_id,
        source_wallet_club_id,entitlement_id,credit_ledger_id,
        amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
        source,description,created_at)
      VALUES(
        NEW.id,v_authorization.idempotency_key,NEW.related_entity_id,
        v_authorization.obligation_id,NEW.user_id,
        v_authorization.source_wallet_club_id,
        v_authorization.entitlement_id,v_credit_ledger_id,
        v_authorization.amount_paid_before,v_amt,
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee,v_authorization.source,
        NEW.description,transaction_timestamp());
      PERFORM public.fn_ca_escrow_apply_exact_refund(
        NEW.related_entity_id,'authorized exact refund',
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee);
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fee numeric := round(COALESCE(NEW.rake_amount,0),2);
BEGIN
  IF NOT COALESCE(NEW.is_tournament,false) OR NEW.tournament_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_fee < 0 AND NEW.source IN (
       'atomic_cancel_tournament',
       'fn_unregister_from_tournament') THEN
    RETURN NULL;
  END IF;
  IF NEW.source = 'fn_award_satellite_seat' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'satellite seat fee',
      p_satellite_fee_in => v_fee,p_satellite_in => -v_fee);
  ELSE
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'entry fee',p_fee_entries_in => v_fee);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_overlay_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Explicit rows only: the autoledger twin (description 'auto-ledgered ...')
  -- of the same debit is not a second overlay. None has been written since
  -- the lock trigger was fixed on 09-03; the shadow still skips them.
  IF COALESCE(NEW.description, '') LIKE 'auto-ledgered%' THEN RETURN NULL; END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'overlay', p_overlay_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_payout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'satellite seat out', p_prize_out => round(COALESCE(NEW.amount, 0), 2));
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.settled_at IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.settled_at IS NOT NULL THEN RETURN NULL; END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'fee settlement', p_fee_out => round(COALESCE(NEW.amount, 0), 2));
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_seat_on_closed_cluster_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lifecycle text;
  v_cluster uuid;
BEGIN
  IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT cluster_id, lifecycle INTO v_cluster, v_lifecycle FROM public.tables WHERE id = NEW.table_id;
  IF v_cluster IS NULL THEN RETURN NEW; END IF;
  IF v_lifecycle IN ('breaking', 'closed') THEN
    RAISE EXCEPTION 'TABLE_CLOSING: this table is % and takes no new players - the game will seat you at its next open table', v_lifecycle
      USING ERRCODE = 'check_violation';
  END IF;
  -- ONE SEAT PER GAME (2026-09-05). A must-move game is one game however many
  -- tables it has; a player holds one chair in it. The executor, changing that
  -- chair, declares itself and is let through; everybody else is refused.
  IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
     AND NEW.user_id IS NOT NULL
     AND EXISTS (SELECT 1
                   FROM public.table_seats ts
                   JOIN public.tables t ON t.id = ts.table_id
                  WHERE ts.user_id = NEW.user_id
                    AND ts.left_at IS NULL
                    AND ts.id IS DISTINCT FROM NEW.id
                    AND t.cluster_id = v_cluster
                    AND t.id <> NEW.table_id
                    AND t.lifecycle <> 'closed') THEN
    RAISE EXCEPTION 'ALREADY_IN_GAME: you already have a seat in this game - the game moves you between its tables itself'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_game_roster_track()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_game uuid;
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT cluster_id INTO v_game FROM public.tables WHERE id = NEW.table_id;
  IF v_game IS NULL THEN RETURN NEW; END IF;

  BEGIN
    IF NEW.left_at IS NULL THEN
      -- A live chair in the game. On the roster once, at the time of the
      -- first chair; a second chair (a move, mid-transaction) changes nothing.
      INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
      VALUES (v_game, NEW.user_id, coalesce(NEW.joined_at, now()))
      ON CONFLICT (game_id, user_id) WHERE left_at IS NULL DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL THEN
      -- The chair emptied. A move declares itself and is not a leave; a
      -- player with another live chair in the game, or a move still planned
      -- for them, is still in the game.
      IF current_setting('app.cash_seat_move', true) IS DISTINCT FROM 'on'
         AND NOT EXISTS (SELECT 1 FROM public.table_seats ts
                           JOIN public.tables t ON t.id = ts.table_id
                          WHERE ts.user_id = NEW.user_id AND ts.left_at IS NULL AND ts.id <> NEW.id
                            AND t.cluster_id = v_game AND t.lifecycle <> 'closed')
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                          WHERE m.player_id = NEW.user_id AND m.game_id = v_game AND m.state = 'pending') THEN
        UPDATE public.cash_game_roster SET left_at = now()
         WHERE game_id = v_game AND user_id = NEW.user_id AND left_at IS NULL;
        UPDATE public.cash_seat_change_requests
           SET status = 'cancelled', resolved_at = now(), note = 'left_game'
         WHERE game_id = v_game AND user_id = NEW.user_id AND status = 'requested';
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_cash_game_roster_track: % (seat %, user %)', SQLERRM, NEW.id, NEW.user_id;
  END;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_reserve_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.category = 'spin_entry' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.from_entity_id, 'spin pool to reserve', p_reserve_out => round(NEW.amount, 2));
  ELSIF NEW.category = 'spin_prize' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'spin prize from reserve', p_reserve_in => round(NEW.amount, 2));
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_horse_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.horse_id := NULL;
    RETURN NEW;
  END IF;

  SELECT CASE WHEN COALESCE(p.is_horse, false) THEN p.id ELSE NULL END
    INTO NEW.horse_id
    FROM public.profiles p
   WHERE p.id = NEW.user_id;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_closed_cluster_main_releases_index()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cluster_id IS NOT NULL
     AND NEW.main_index IS NOT NULL
     AND (NEW.lifecycle = 'closed' OR coalesce(NEW.is_deleted, false) = true)
  THEN
    NEW.main_index := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cluster_table_ceiling()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live integer;
  v_ceiling integer;
BEGIN
  IF NEW.cluster_id IS NULL THEN RETURN NEW; END IF;

  SELECT coalesce(g.cap_mains, 8) + 1 + CASE WHEN g.allow_second_feeder THEN 1 ELSE 0 END + 2
    INTO v_ceiling
    FROM public.cash_games g WHERE g.id = NEW.cluster_id;
  IF v_ceiling IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_live FROM public.tables t
   WHERE t.cluster_id = NEW.cluster_id
     AND coalesce(t.is_deleted, false) = false
     AND t.lifecycle <> 'closed';

  IF v_live >= v_ceiling THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (NEW.cluster_id, 'table_refused_at_ceiling',
            jsonb_build_object('live', v_live, 'ceiling', v_ceiling,
                               'role', NEW.role, 'main_index', NEW.main_index));
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_escrow_is_enforced()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.enforced THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id = NEW.tournament_id
       AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false))
  ) THEN
    RETURN NEW;
  END IF;
  /* A row that opens SHORT stays tracked: fn_ca_escrow_apply can open an
     escrow at first sight from the shadow of an event already in flight, and
     an event broken before the escrow saw it must not have its next payment
     refused by a guard switched on afterwards. */
  IF COALESCE(NEW.prize_balance, 0)  < -0.005
     OR COALESCE(NEW.bounty_balance, 0) < -0.005
     OR COALESCE(NEW.fee_balance, 0)    < -0.005 THEN
    RETURN NEW;
  END IF;
  NEW.enforced := true;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_transfer_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.metadata->>'entry_split_version' = '2' THEN
    IF round(NEW.amount,2) IS DISTINCT FROM round((NEW.metadata->>'entry_prize')::numeric
        + (NEW.metadata->>'entry_bounty')::numeric + (NEW.metadata->>'entry_fee')::numeric,2)
       OR (NEW.metadata->>'entry_prize')::numeric < 0
       OR (NEW.metadata->>'entry_bounty')::numeric < 0
       OR (NEW.metadata->>'entry_fee')::numeric < 0 THEN
      RAISE EXCEPTION 'Satellite transfer does not match its funded split' USING ERRCODE='23514';
    END IF;
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite split entry',
      p_gross_in => round(NEW.amount - (NEW.metadata->>'entry_fee')::numeric,2),
      p_bounty_in => (NEW.metadata->>'entry_bounty')::numeric);
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite seat in', p_satellite_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_retired_club_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_old_club_id uuid;
  v_maintenance boolean :=
    auth.uid() IS NULL
    AND coalesce(current_setting('app.club_retirement_maintenance', true), '') = 'on';
BEGIN
  IF v_maintenance THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := OLD.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = OLD.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = OLD.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
    ELSE
      v_club_id := OLD.club_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = NEW.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = NEW.agent_id;
    ELSE
      v_club_id := NEW.club_id;
    END IF;

    -- On UPDATE, check the source scope too. Moving a retained row to an active
    -- club must not become an escape hatch from a retired club's write freeze.
    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'unions' THEN
        v_old_club_id := OLD.id;
      ELSIF TG_TABLE_NAME = 'table_seats' THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.table_id;
      ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tournaments t
         WHERE t.id = OLD.tournament_id;
      ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
        SELECT cr.club_id INTO v_old_club_id FROM public.cashout_requests cr
         WHERE cr.id = OLD.cashout_request_id;
      ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
        SELECT a.club_id INTO v_old_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
      ELSE
        v_old_club_id := OLD.club_id;
      END IF;
    END IF;
  END IF;

  -- A union row can use a club UUID without an FK back to clubs. Serialize
  -- that conversion with the retirement RPC so it cannot create a union
  -- identity from a club that became retired in the same instant.
  IF TG_TABLE_NAME = 'unions' AND v_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('cashier-hierarchy:' || v_club_id::text, 0)
    );
  END IF;

  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id IN (v_club_id, v_old_club_id) AND c.lifecycle_status = 'retired'
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIRED: gameplay and cashier records are read-only'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered_inserted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_event record;
  v_occurred_at timestamptz := transaction_timestamp();
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT inserted.user_id
    FROM inserted_rows inserted
    WHERE inserted.status::text IN ('playing', 'eliminated', 'finished', 'winner')
    ORDER BY inserted.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('daily-missions-user:' || v_user_id::text, 0)
    );
  END LOOP;

  FOR v_event IN
    SELECT inserted.id, inserted.user_id, inserted.tournament_id
    FROM inserted_rows inserted
    WHERE inserted.status::text IN ('playing', 'eliminated', 'finished', 'winner')
    ORDER BY inserted.user_id, inserted.tournament_id, inserted.id
  LOOP
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        v_event.user_id,
        'tournament:' || v_event.tournament_id::text,
        '{"tournaments_played":1}'::jsonb,
        '{}'::jsonb,
        v_occurred_at
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions tournament event % for player % could not be queued: %',
        v_event.tournament_id,
        v_event.user_id,
        SQLERRM;
    END;
  END LOOP;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_daily_missions_tournament_registered_updated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_event record;
  v_occurred_at timestamptz := transaction_timestamp();
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT updated.user_id
    FROM updated_rows updated
    JOIN previous_rows previous ON previous.id = updated.id
    WHERE updated.status::text IN ('playing', 'eliminated', 'finished', 'winner')
      AND (
        previous.status IS NULL
        OR previous.status::text NOT IN ('playing', 'eliminated', 'finished', 'winner')
      )
    ORDER BY updated.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('daily-missions-user:' || v_user_id::text, 0)
    );
  END LOOP;

  FOR v_event IN
    SELECT updated.id, updated.user_id, updated.tournament_id
    FROM updated_rows updated
    JOIN previous_rows previous ON previous.id = updated.id
    WHERE updated.status::text IN ('playing', 'eliminated', 'finished', 'winner')
      AND (
        previous.status IS NULL
        OR previous.status::text NOT IN ('playing', 'eliminated', 'finished', 'winner')
      )
    ORDER BY updated.user_id, updated.tournament_id, updated.id
  LOOP
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        v_event.user_id,
        'tournament:' || v_event.tournament_id::text,
        '{"tournaments_played":1}'::jsonb,
        '{}'::jsonb,
        v_occurred_at
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions tournament event % for player % could not be queued: %',
        v_event.tournament_id,
        v_event.user_id,
        SQLERRM;
    END;
  END LOOP;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.zz_a_payout_row_carries_its_key()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  /* It fills the blank, it never refuses. A guard that can refuse a payout row
     could leave a credited player with no record of the credit, and that is the
     worse failure (CLAUDE.md 11.5). With a key present,
     uq_tournament_payouts_idempotency_key - which is partial, WHERE
     idempotency_key IS NOT NULL - can finally do the job it was built for. */
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := 'tourney:' || COALESCE(NEW.tournament_id::text, 'none') || ':' ||
                           COALESCE(NEW.source, 'payout') || ':' ||
                           COALESCE(NEW.user_id::text, 'none') || ':' ||
                           to_char(COALESCE(NEW.amount, 0), 'FM9999999990.00') || ':' ||
                           COALESCE(NEW.position::text, 'x');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.zz_chip_ledger_key_is_claimed_once()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* 99.92% of legs carry no key and this does nothing for them. */
  IF NEW.idempotency_key IS NULL THEN
    RETURN NEW;
  END IF;

  /* No ON CONFLICT: the unique violation IS the refusal, and it must reach the
     caller exactly as ux_chip_ledger_idempotency_key's does today. Both are
     live until the cut; either one refusing is the correct outcome. */
  INSERT INTO public.chip_ledger_idem (idempotency_key, leg_id, created_at)
  VALUES (NEW.idempotency_key, NEW.id, COALESCE(NEW.created_at, now()));

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_attested_day_is_restated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  r record;
  v_res jsonb;
BEGIN
  IF v_reason IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    FOR r IN
      SELECT DISTINCT o.created_at::date AS day
        FROM old_rows o
        JOIN public.ca_ledger_day_manifests m ON m.day = o.created_at::date
       ORDER BY 1
    LOOP
      v_res := public.fn_ca_ledger_day_manifest(r.day, 'maintenance:' || v_reason);
      IF COALESCE((v_res->>'tampered')::boolean, false) THEN
        RAISE EXCEPTION 'the manifest for % could not be restated after maintenance "%": %', r.day, v_reason, v_res
          USING ERRCODE = 'P0403';
      END IF;
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT d.day
        FROM (SELECT created_at::date AS day FROM old_rows
              UNION
              SELECT created_at::date FROM new_rows) d
        JOIN public.ca_ledger_day_manifests m ON m.day = d.day
       ORDER BY 1
    LOOP
      v_res := public.fn_ca_ledger_day_manifest(r.day, 'maintenance:' || v_reason);
      IF COALESCE((v_res->>'tampered')::boolean, false) THEN
        RAISE EXCEPTION 'the manifest for % could not be restated after maintenance "%": %', r.day, v_reason, v_res
          USING ERRCODE = 'P0403';
      END IF;
    END LOOP;
  END IF;

  RETURN NULL;
END $function$;

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

CREATE OR REPLACE FUNCTION public.fn_ca_arena_seat_is_same_asset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_club_asset text; v_arena uuid;
BEGIN
  BEGIN
    SELECT s.club_id INTO v_arena FROM public.ca_arena_settings s WHERE s.id = 1;
    IF v_arena IS NULL THEN RETURN NULL; END IF;   -- no arena yet: nothing to be inconsistent with
    SELECT c.asset INTO v_club_asset
      FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = NEW.table_id;
    IF v_club_asset IS NULL THEN RETURN NULL; END IF;
    -- The only asymmetry that can exist today: a seat at an arena (diamond) table funded from a
    -- chip club wallet, or the reverse. Both are a reporting error before they are a money one.
    IF (v_club_asset = 'diamonds') <> ((SELECT t.club_id FROM public.tables t WHERE t.id = NEW.table_id) = v_arena) THEN
      -- Flipping DR15 escalates what this files; it never refuses the seat, because a guard
      -- that can refuse a seat can strand a player mid-hand. The mode is READ here so the rule
      -- has a consumer and a flip means something (CLAUDE.md 10.86).
      PERFORM public.fn_ca_diamond_incident('DR15:cross_asset_seat',
        CASE WHEN public.fn_ca_diamond_rule_mode('DR15:cross_asset_seat') = 'refuse'
             THEN 'critical' ELSE 'warning' END, NEW.user_id, NEW.stack,
        'fn_ca_arena_seat_is_same_asset',
        jsonb_build_object('table_id', NEW.table_id, 'club_asset', v_club_asset, 'arena_club', v_arena));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- a seat is never refused by a reporting guard
  END;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_reentry_with_pending_bounty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status='eliminated' AND NEW.status='playing'
     AND EXISTS (SELECT 1 FROM public.tournament_bounty_obligations o
                  WHERE o.tournament_id=NEW.tournament_id
                    AND o.eliminated_user_id=NEW.user_id AND o.state='pending') THEN
    RAISE EXCEPTION 'prior bounty obligation is still pending for tournament %, player %',
      NEW.tournament_id, NEW.user_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_completed_with_pending_bounties()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
     AND (COALESCE(NEW.is_bounty,false) OR COALESCE(NEW.is_pko,false)
          OR COALESCE(NEW.is_mystery_bounty,false)) THEN
    IF public.fn_tournament_has_unsettled_bounties(NEW.id) THEN
      RAISE EXCEPTION 'tournament % has pending bounty obligations', NEW.id
        USING ERRCODE='check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_completion_receipts r
                    WHERE r.tournament_id=NEW.id AND r.pool_finalized_at IS NOT NULL) THEN
      RAISE EXCEPTION 'tournament % bounty pool has not been finalized', NEW.id
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_retire_manager_wakes_after_terminal_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF upper(COALESCE(NEW.status,'')) IN ('COMPLETED','CANCELLED','CANCELED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.tournament_manager_wakes
       SET consumed_at=COALESCE(consumed_at,clock_timestamp())
     WHERE tournament_id=NEW.id AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_refuse_mystery_activation_with_pending_heads()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.mystery_bounty_stage = 'active'
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'active' THEN
    IF public.fn_tournament_has_unsettled_bounties(NEW.id) THEN
      RAISE EXCEPTION 'tournament % has pending pre-mystery bounty obligations', NEW.id
        USING ERRCODE='check_violation';
    END IF;
    NEW.mystery_bounty_activation_generation :=
      OLD.mystery_bounty_activation_generation + 1;
  ELSIF NEW.mystery_bounty_activation_generation
            IS DISTINCT FROM OLD.mystery_bounty_activation_generation THEN
    RAISE EXCEPTION 'mystery activation generation is database-managed'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_receipt_mystery_activation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chest_count integer;
  v_pool_cents bigint;
  v_receipt public.tournament_mystery_activation_receipts%ROWTYPE;
BEGIN
  IF NEW.mystery_bounty_stage='active'
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'active' THEN
    SELECT count(*)::integer,COALESCE(sum(c.amount_cents),0)::bigint
      INTO v_chest_count,v_pool_cents
      FROM public.tournament_bounty_chests c WHERE c.tournament_id=NEW.id;
    IF v_chest_count<=0 OR v_pool_cents<=0
       OR v_pool_cents IS DISTINCT FROM NEW.mystery_bounty_pool_cents THEN
      RAISE EXCEPTION 'mystery activation inventory is missing or does not match its sealed pool'
        USING ERRCODE='check_violation';
    END IF;
    INSERT INTO public.tournament_mystery_activation_receipts
      (tournament_id,activation_generation,activated_at,chest_count,pool_cents)
    VALUES (NEW.id,NEW.mystery_bounty_activation_generation,
            COALESCE(NEW.mystery_bounty_activated_at,now()),v_chest_count,v_pool_cents)
    ON CONFLICT (tournament_id,activation_generation) DO NOTHING;
    SELECT * INTO v_receipt FROM public.tournament_mystery_activation_receipts
     WHERE tournament_id=NEW.id
       AND activation_generation=NEW.mystery_bounty_activation_generation;
    IF NOT FOUND OR v_receipt.chest_count<>v_chest_count
       OR v_receipt.pool_cents<>v_pool_cents THEN
      RAISE EXCEPTION 'mystery activation receipt identity conflict'
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_capture_satellite_economics_on_start()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_start boolean;
  v_is_satellite boolean;
  v_target public.tournaments%ROWTYPE;
  v_target_id uuid;
  v_seats integer;
  v_ticket numeric;
  v_required numeric;
  v_source_hash text;
  v_target_hash text;
  v_existing public.tournament_satellite_economic_snapshots%ROWTYPE;
BEGIN
  v_is_start := CASE
    WHEN TG_OP='INSERT' THEN upper(COALESCE(NEW.status,'')) IN
      ('RUNNING','COMPLETING','COMPLETED')
    ELSE upper(COALESCE(NEW.status,'')) IN ('RUNNING','COMPLETING','COMPLETED')
      AND upper(COALESCE(OLD.status,'')) NOT IN ('RUNNING','COMPLETING','COMPLETED')
  END;
  IF NOT v_is_start THEN RETURN NEW; END IF;
  v_is_satellite := lower(COALESCE(NEW.variant,''))='satellite'
    OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE'
    OR NEW.satellite_target_id IS NOT NULL;
  IF NOT v_is_satellite THEN RETURN NEW; END IF;

  v_target_id:=NEW.satellite_target_id;
  v_seats:=GREATEST(COALESCE(NEW.satellite_seats,0),0);
  IF v_target_id=NEW.id THEN
    RAISE EXCEPTION 'a satellite cannot target itself' USING ERRCODE='check_violation';
  END IF;
  IF v_target_id IS NULL THEN
    IF v_seats>0 THEN
      RAISE EXCEPTION 'a satellite cannot guarantee seats without a target'
        USING ERRCODE='check_violation';
    END IF;
    v_ticket:=0;
    v_target_hash:=NULL;
  ELSE
    -- Deliberately no target row lock. Every BEFORE trigger in this source
    -- start statement sees the same command snapshot, including the guarantee
    -- overlay that priced/funded the seat. Avoiding a target lock also prevents
    -- a source->target lock inversion with finish's target->source order.
    SELECT * INTO v_target FROM public.tournaments WHERE id=v_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'satellite target is missing' USING ERRCODE='foreign_key_violation';
    END IF;
    v_ticket:=round(GREATEST(COALESCE(v_target.buy_in_amount,0),0)
                    +GREATEST(COALESCE(v_target.buy_in_fee,0),0),2);
    IF v_ticket<=0 THEN
      RAISE EXCEPTION 'satellite target ticket value must be positive'
        USING ERRCODE='check_violation';
    END IF;
    v_target_hash:=public.fn_managed_game_contract_hash(
      public.fn_managed_game_contract_document('tournament',to_jsonb(v_target)));
  END IF;
  v_required:=round(v_seats*v_ticket,2);
  IF round(COALESCE(NEW.prize_pool,0),2)<v_required THEN
    RAISE EXCEPTION
      'satellite cannot start: funded pool % is below advertised seat promise %',
      round(COALESCE(NEW.prize_pool,0),2),v_required
      USING ERRCODE='check_violation';
  END IF;
  v_source_hash:=public.fn_managed_game_contract_hash(
    public.fn_managed_game_contract_document('tournament',to_jsonb(NEW)));

  INSERT INTO public.tournament_satellite_economic_snapshots(
    tournament_id,target_tournament_id,configured_seats,ticket_value,
    promised_seat_value,funded_source_pool,source_contract_hash,
    target_contract_hash,source_started_at,capture_source)
  VALUES (
    NEW.id,v_target_id,v_seats,v_ticket,v_required,
    round(COALESCE(NEW.prize_pool,0),2),v_source_hash,v_target_hash,
    NEW.started_at,'start_trigger')
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT * INTO v_existing
    FROM public.tournament_satellite_economic_snapshots
   WHERE tournament_id=NEW.id;
  IF ROW(v_existing.target_tournament_id,v_existing.configured_seats,
         v_existing.ticket_value,v_existing.promised_seat_value,
         v_existing.source_contract_hash,v_existing.target_contract_hash)
     IS DISTINCT FROM
     ROW(v_target_id,v_seats,v_ticket,v_required,v_source_hash,v_target_hash) THEN
    RAISE EXCEPTION 'satellite start conflicts with its frozen economic promise'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_guard_atomic_satellite_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_check jsonb;
BEGIN
  IF NEW.status='COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
     AND (lower(COALESCE(NEW.variant,''))='satellite'
       OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE'
       OR NEW.satellite_target_id IS NOT NULL) THEN
    IF OLD.status<>'COMPLETING' THEN
      RAISE EXCEPTION 'satellite tournament cannot complete from %',OLD.status
        USING ERRCODE='check_violation';
    END IF;
    v_check:=public.fn_check_atomic_satellite_finish(NEW.id);
    IF COALESCE((v_check->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite completion has no exact atomic receipt: %',v_check
        USING ERRCODE='check_violation';
    END IF;
    NEW.on_break:=false;
    NEW.break_started_at:=NULL;
    NEW.break_ends_at:=NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_place()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
  v_gate text := COALESCE(current_setting('app.atomic_tournament_place_batch', true), '');
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.kind IN ('place', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.kind IN ('place', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;

  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  /* The FK's parent cascade is the only legal delete after preparation. */
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;

  /* Settlement only updates the already-frozen payment progress. It never
     creates, deletes, rekeys, changes a recipient or changes an entitlement. */
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'tournament obligations frozen by an atomic place batch cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.kind, NEW.place, NEW.user_id,
         NEW.amount_owed, NEW.created_at, NEW.adjustment_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.kind, OLD.place, OLD.user_id,
         OLD.amount_owed, OLD.created_at, OLD.adjustment_id) THEN
    RAISE EXCEPTION
      'a frozen place obligation identity, recipient or entitlement cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'bubble_protection'
     AND NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION
      'a frozen Bubble Protection obligation source cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN
    RAISE EXCEPTION
      'tournament obligations for tournament % are frozen by their atomic place batch',
      OLD.tournament_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_paid + 0.005 < OLD.amount_paid
     OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION
      'a frozen place obligation payment record cannot move backwards'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_lock_atomic_place_tournament_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settled_at timestamptz;
  v_has_batch boolean := false;
BEGIN
  IF lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION
      'completed normal tournament % is terminal and cannot return to %',
      OLD.id, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  SELECT b.settled_at INTO v_settled_at
    FROM public.tournament_place_settlement_batches b
   WHERE b.tournament_id = OLD.id;
  v_has_batch := FOUND;

  IF v_has_batch
     AND (v_settled_at IS NULL
          OR OLD.status IS DISTINCT FROM 'COMPLETING'
          OR NEW.status IS DISTINCT FROM 'COMPLETED') THEN
    RAISE EXCEPTION
      'tournament % has an atomic place batch; status may only advance from COMPLETING to COMPLETED after full settlement',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournament_atomic_place_completion_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_batch                       public.tournament_place_settlement_batches%ROWTYPE;
  v_count                       integer := 0;
  v_open                        integer := 0;
  v_mismatches                  integer := 0;
  v_extra_prizes                integer := 0;
  v_player_count                integer := 0;
  v_unranked_count              integer := 0;
  v_distinct_positions          integer := 0;
  v_min_position                integer := 0;
  v_max_position                integer := 0;
  v_winner_count                integer := 0;
  v_winner_place_one            integer := 0;
  v_nonterminal_count           integer := 0;
  v_missing_bust_time           integer := 0;
  v_canonical_mismatches        integer := 0;
  v_payout_evidence_mismatches  integer := 0;
  v_unexpected_payout_evidence  integer := 0;
  v_bubble_user                 uuid;
  v_bubble_holders              integer := 0;
  v_bubble_obligations          integer := 0;
  v_bubble_matching             integer := 0;
  v_bubble_owed                 numeric := 0;
  v_bubble_paid                 numeric := 0;
  v_bubble_evidence             numeric := 0;
  v_bubble_conflicts            integer := 0;
  v_bubble_evidence_exists      boolean := false;
  v_bubble_required             boolean := false;
  v_bubble_contract_required    boolean := false;
  v_bubble_invalid              boolean := false;
  v_bubble_obligation_id        uuid;
  v_bubble_source               text;
  v_bubble_settled_at           timestamptz;
  v_total                       numeric := 0;
  v_escrow_balance              numeric := 0;
  v_escrow_enforced             boolean := false;
  v_escrow_found                boolean := false;
  v_fingerprint                 text;
  v_ftd_check                   jsonb;
BEGIN
  IF lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  /* During rollout the atomic deal migration lands after this normal-place
     migration. A single forged deal marker must not become a completion bypass
     in that interval. Only the later deal verifier can exempt the event, and
     its full batch/ledger/result proof must pass. Dynamic SQL keeps this
     migration installable before that function exists. */
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = NEW.id AND p.source = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = NEW.id AND o.kind = 'final_table_deal') THEN
    IF to_regprocedure('public.fn_check_atomic_final_table_deal(uuid)') IS NULL THEN
      RAISE EXCEPTION
        'final-table deal tournament % cannot complete before its atomic verifier is installed', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE 'SELECT public.fn_check_atomic_final_table_deal($1)'
       INTO v_ftd_check USING NEW.id;
    IF NOT COALESCE((v_ftd_check->>'ok')::boolean, false) THEN
      RAISE EXCEPTION
        'final-table deal tournament % failed atomic verification: %',
        NEW.id, COALESCE(v_ftd_check->>'reason', 'unknown')
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT COALESCE(NEW.prize_pool_finalized, false)
     OR round(COALESCE(NEW.prize_pool, 0), 2) + 0.005
        < round(COALESCE(NEW.guaranteed_prize, 0), 2) THEN
    RAISE EXCEPTION
      'normal tournament % cannot complete before its prize pool is funded and finalized', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_batch
    FROM public.tournament_place_settlement_batches b
   WHERE b.tournament_id = NEW.id;
  IF NOT FOUND OR v_batch.mode <> 'structure' OR v_batch.settled_at IS NULL THEN
    RAISE EXCEPTION 'normal tournament % cannot complete without a settled atomic place batch', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN
    RAISE EXCEPTION 'normal tournament % cannot complete without immutable escrow funding proof', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_batch.escrow_required > 0.005 THEN
    SELECT e.enforced, round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_balance
      FROM public.tournament_escrow e
     WHERE e.tournament_id = NEW.id
     FOR UPDATE;
    v_escrow_found := FOUND;
    IF NOT v_escrow_found OR NOT v_escrow_enforced OR v_escrow_balance < -0.005 THEN
      RAISE EXCEPTION
        'normal tournament % cannot complete without a live non-negative enforced prize escrow', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2),
         count(*) FILTER (WHERE o.amount_paid + 0.005 < o.amount_owed),
         md5(COALESCE(jsonb_agg(jsonb_build_object(
           'place', o.place, 'user_id', o.user_id,
           'club_id', tp.club_id,
           'cents', round(o.amount_owed * 100)::bigint)
           ORDER BY o.place), '[]'::jsonb)::text)
    INTO v_count, v_total, v_open, v_fingerprint
    FROM public.tournament_obligations o
    JOIN public.tournament_players tp
      ON tp.tournament_id = o.tournament_id
     AND tp.position = o.place AND tp.user_id = o.user_id
   WHERE o.tournament_id = NEW.id AND o.kind = 'place';

  SELECT count(*) INTO v_mismatches
    FROM public.tournament_obligations o
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id = o.tournament_id AND tp.position = o.place
   WHERE o.tournament_id = NEW.id AND o.kind = 'place'
     AND (tp.user_id IS NULL
          OR tp.user_id IS DISTINCT FROM o.user_id
          OR round(COALESCE(tp.prize, 0) * 100)::bigint
             <> round(o.amount_owed * 100)::bigint);

  SELECT count(*) INTO v_extra_prizes
    FROM public.tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
          AND o.place = tp.position AND o.user_id = tp.user_id
     );

  SELECT count(*), count(*) FILTER (WHERE tp.position IS NULL),
         count(DISTINCT tp.position), COALESCE(min(tp.position), 0),
         COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL)
    INTO v_player_count, v_unranked_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time
    FROM public.tournament_players tp
   WHERE tp.tournament_id = NEW.id;

  WITH eliminated AS (
    SELECT tp.id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.id AND tp.status = 'eliminated'
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM eliminated e
    JOIN public.tournament_players tp ON tp.id = e.id
   WHERE tp.position IS DISTINCT FROM e.canonical_position;

  SELECT count(*) INTO v_payout_evidence_mismatches
    FROM public.tournament_obligations o
    CROSS JOIN LATERAL (
      SELECT round(COALESCE(sum(p.amount), 0), 2) AS paid
        FROM public.tournament_payouts p
       WHERE p.tournament_id = o.tournament_id
         AND p.position = o.place
         AND p.user_id = o.user_id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   p.tournament_id, p.idempotency_key))
    ) evidence
   WHERE o.tournament_id = NEW.id AND o.kind = 'place'
     AND (o.amount_paid < -0.005
          OR o.amount_paid > o.amount_owed + 0.005
          OR abs(round(o.amount_paid, 2) - evidence.paid) > 0.005);

  SELECT count(*) INTO v_unexpected_payout_evidence
    FROM (
      SELECT p.position, p.user_id
        FROM public.tournament_payouts p
       WHERE p.tournament_id = NEW.id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   p.tournament_id, p.idempotency_key))
       GROUP BY p.position, p.user_id
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) evidence
   WHERE NOT EXISTS (
     SELECT 1 FROM public.tournament_obligations o
      WHERE o.tournament_id = NEW.id AND o.kind = 'place'
        AND o.place = evidence.position AND o.user_id = evidence.user_id
   );

  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = NEW.id
              AND o.kind = 'bubble_protection'
         ) OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = NEW.id
              AND p.source = 'bubble_protection'
            GROUP BY p.tournament_id
           HAVING abs(round(sum(p.amount), 2)) > 0.005
         )
    INTO v_bubble_evidence_exists;
  v_bubble_required := COALESCE(NEW.bubble_protection, false)
                       OR v_bubble_evidence_exists;
  v_bubble_contract_required := v_bubble_required
    AND v_batch.place_count > 0 AND v_player_count > v_batch.place_count;

  IF (v_bubble_evidence_exists OR v_bubble_contract_required)
     AND round(COALESCE(NEW.buy_in_amount, 0), 2) <= 0 THEN
    RAISE EXCEPTION
      'normal tournament % has Bubble Protection evidence with no valid published contract', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_bubble_evidence_exists AND NOT v_bubble_contract_required THEN
    RAISE EXCEPTION
      'normal tournament % has Bubble Protection evidence with no valid published contract', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_batch.bubble_contract_required IS DISTINCT FROM v_bubble_contract_required THEN
    v_bubble_invalid := true;
  END IF;

  IF v_bubble_contract_required THEN
    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
      INTO v_bubble_holders, v_bubble_user
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.id
       AND tp.position = v_batch.place_count + 1;

    SELECT count(*),
           count(*) FILTER (WHERE o.user_id = v_bubble_user AND o.place IS NULL),
           COALESCE(max(o.amount_owed) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0),
           COALESCE(max(o.amount_paid) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0)
      INTO v_bubble_obligations, v_bubble_matching, v_bubble_owed, v_bubble_paid
      FROM public.tournament_obligations o
     WHERE o.tournament_id = NEW.id AND o.kind = 'bubble_protection';

    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_bubble_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = NEW.id
       AND p.user_id = v_bubble_user AND p.position IS NULL
       AND p.source = 'bubble_protection';

    SELECT count(*) INTO v_bubble_conflicts
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = NEW.id
           AND p.source = 'bubble_protection'
           AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user)
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) unexpected_bubble;

    IF v_bubble_obligations = 1 AND v_bubble_matching = 1 THEN
      SELECT o.id, o.source, o.amount_owed, o.amount_paid, o.settled_at
        INTO v_bubble_obligation_id, v_bubble_source,
             v_bubble_owed, v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = NEW.id AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user
       FOR UPDATE;
    END IF;

    v_bubble_invalid := v_bubble_invalid
      OR v_bubble_holders <> 1 OR v_bubble_user IS NULL
      OR v_bubble_obligations <> 1 OR v_bubble_matching <> 1
      OR v_bubble_obligation_id IS DISTINCT FROM v_batch.bubble_obligation_id
      OR v_bubble_user IS DISTINCT FROM v_batch.bubble_user_id
      OR v_bubble_source IS DISTINCT FROM v_batch.bubble_source
      OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicPlaceSettlement')
      OR abs(v_bubble_owed - round(COALESCE(NEW.buy_in_amount, 0), 2)) > 0.005
      OR abs(v_bubble_owed - v_batch.bubble_amount_owed) > 0.005
      OR v_bubble_paid + 0.005 < v_bubble_owed
      OR v_bubble_paid + 0.005 < v_batch.bubble_amount_paid_before
      OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
      OR v_bubble_settled_at IS NULL
      OR v_bubble_conflicts > 0;
  ELSE
    v_bubble_invalid := v_bubble_invalid
      OR v_batch.bubble_obligation_id IS NOT NULL
      OR v_batch.bubble_user_id IS NOT NULL
      OR v_batch.bubble_source IS NOT NULL
      OR abs(v_batch.bubble_amount_owed) > 0.005
      OR abs(v_batch.bubble_amount_paid_before) > 0.005;
  END IF;

  IF v_count <> v_batch.place_count OR v_open <> 0
     OR abs(v_total - v_batch.amount_owed) > 0.005
     OR abs(v_batch.amount_owed - round(COALESCE(NEW.prize_pool, 0), 2)) > 0.005
     OR v_fingerprint <> v_batch.plan_fingerprint OR v_mismatches > 0
     OR v_extra_prizes > 0
     OR v_player_count = 0 OR v_unranked_count > 0
     OR v_distinct_positions <> v_player_count
     OR v_min_position <> 1 OR v_max_position <> v_player_count
     OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0
     OR v_canonical_mismatches <> 0
     OR v_payout_evidence_mismatches > 0
     OR v_unexpected_payout_evidence > 0
     OR v_bubble_invalid THEN
    RAISE EXCEPTION
      'normal tournament % cannot complete: batch count %, open %, total %, result mismatches %, extra prize rows %, players %, unranked %, rank range %..%, winners %, winner at place one %, nonterminal %, payout mismatches %, unexpected payout groups %, bubble obligations %, bubble conflicts %',
      NEW.id, v_count, v_open, v_total, v_mismatches, v_extra_prizes,
      v_player_count, v_unranked_count, v_min_position, v_max_position,
      v_winner_count, v_winner_place_one, v_nonterminal_count,
      v_payout_evidence_mismatches, v_unexpected_payout_evidence,
      v_bubble_obligations, v_bubble_conflicts
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refuse_normal_tournament_completed_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'normal tournament % cannot be inserted already completed; use the atomic settlement transition',
    NEW.id USING ERRCODE = 'check_violation';
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournament_pool_finalization_window_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_late_level_cap integer := COALESCE(NULLIF(NEW.late_reg_levels, 0),
                                       NULLIF(NEW.rebuy_levels, 0), 0);
  v_rebuy_level_cap integer := COALESCE(NULLIF(NEW.rebuy_levels, 0),
                                        NULLIF(NEW.late_reg_levels, 0), 0);
  v_current_level integer := COALESCE(NEW.current_level, 0);
  /* An unexpired future window is just as binding as one whose start clock has
     arrived. Finalizing it early would publish an add-on promise that the
     finalized-pool trigger later has to refuse. */
  v_addon_open boolean := COALESCE(NEW.add_on_available, false)
                          AND NEW.addon_period_ends_at IS NOT NULL
                          AND clock_timestamp() < NEW.addon_period_ends_at;
BEGIN
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false) THEN
    RAISE EXCEPTION
      'finalized tournament % prize pool cannot be reopened', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(NEW.prize_pool_finalized, false)
     OR COALESCE(OLD.prize_pool_finalized, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('ANNOUNCED', 'REGISTERING')
     AND (v_late_level_cap > 0 OR COALESCE(NEW.late_reg_mins, 0) > 0
          OR COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false)
          OR COALESCE(NEW.add_on_available, false)) THEN
    RAISE EXCEPTION
      'tournament % cannot finalize its prize pool before its post-start entry windows open', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'RUNNING' THEN
    IF v_late_level_cap > 0 AND v_current_level < v_late_level_cap THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before late registration level % closes',
        NEW.id, v_late_level_cap USING ERRCODE = 'check_violation';
    END IF;
    IF v_late_level_cap <= 0 AND COALESCE(NEW.late_reg_mins, 0) > 0
       AND (NEW.started_at IS NULL OR clock_timestamp()
            < NEW.started_at + make_interval(mins => NEW.late_reg_mins)) THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool while timed late registration is open', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false))
       AND v_rebuy_level_cap <= 0 AND COALESCE(NEW.late_reg_mins, 0) <= 0 THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool while an uncapped rebuy or re-entry offer is open', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false))
       AND v_rebuy_level_cap > 0 AND v_current_level < v_rebuy_level_cap THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before rebuy level % closes',
        NEW.id, v_rebuy_level_cap USING ERRCODE = 'check_violation';
    END IF;
    IF v_addon_open THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before its promised add-on window closes', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(NEW.add_on_available, false)
       AND (NEW.addon_period_started_at IS NULL OR NEW.addon_period_ends_at IS NULL) THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before its add-on window is durably bounded', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refuse_finalized_tournament_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_finalized boolean;
BEGIN
  SELECT COALESCE(t.prize_pool_finalized, false)
    INTO v_finalized
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'registration is closed because tournament % prize pool is finalized',
      NEW.tournament_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_freeze_finalized_tournament_prize_pool()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delta numeric;
  v_candidate_count integer := 0;
BEGIN
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false) THEN
    RAISE EXCEPTION
      'finalized tournament % prize pool cannot be reopened', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND (NEW.payout_structure IS DISTINCT FROM OLD.payout_structure
          OR NEW.spin_multiplier IS DISTINCT FROM OLD.spin_multiplier) THEN
    RAISE EXCEPTION
      'finalized tournament % payout structure and Spin draw cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND round(COALESCE(NEW.guaranteed_prize, 0), 2)
         IS DISTINCT FROM round(COALESCE(OLD.guaranteed_prize, 0), 2) THEN
    RAISE EXCEPTION 'finalized tournament % guarantee cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND round(COALESCE(NEW.prize_pool, 0), 2)
         IS DISTINCT FROM round(COALESCE(OLD.prize_pool, 0), 2) THEN
    v_delta := round(COALESCE(OLD.prize_pool, 0) - COALESCE(NEW.prize_pool, 0), 2);

    IF v_delta > 0
       AND COALESCE(NEW.prize_pool, 0) >= 0
       AND COALESCE(NEW.prize_pool_finalized, false)
       AND OLD.status = 'COMPLETING'
       AND OLD.satellite_target_id IS NOT NULL
       AND current_setting('app.atomic_satellite_settlement', true) = OLD.id::text
       /* No second column may hitchhike on the narrowly admitted debit. */
       AND (to_jsonb(NEW) - 'prize_pool') = (to_jsonb(OLD) - 'prize_pool') THEN
      SELECT count(*)::integer
        INTO v_candidate_count
        FROM public.tournament_satellite_settlement_batches b
        JOIN public.tournament_satellite_entitlements e
          ON e.tournament_id = b.tournament_id
         AND e.target_tournament_id = b.target_tournament_id
         AND e.target_tournament_id = OLD.satellite_target_id
         AND round(e.ticket_value, 2) = v_delta
        JOIN public.tournament_players source_player
          ON source_player.tournament_id = OLD.id
         AND source_player.position = e.position
         AND source_player.status IN ('winner', 'eliminated')
        JOIN public.tournament_players target_player
          ON target_player.tournament_id = e.target_tournament_id
         AND target_player.user_id = source_player.user_id
         AND COALESCE(target_player.is_satellite_qualifier, false)
         AND target_player.source_satellite_id = OLD.id
        JOIN public.tournaments target
          ON target.id = e.target_tournament_id
       WHERE b.tournament_id = OLD.id
         AND b.settled_at IS NULL
         AND round(
               GREATEST(COALESCE(target.buy_in_amount, 0), 0)
               + GREATEST(COALESCE(target.buy_in_fee, 0), 0),
               2
             ) = v_delta
         AND (
           SELECT count(*)::integer
             FROM public.rake_records target_rake
            WHERE target_rake.tournament_id = target.id
              AND target_rake.source = 'fn_award_satellite_seat'
              AND target_rake.metadata->>'satellite_id' = OLD.id::text
              AND target_rake.metadata->>'user_id' = source_player.user_id::text
              AND target_rake.metadata->>'registration_id' = target_player.id::text
         ) = CASE WHEN COALESCE(target.buy_in_fee, 0) > 0 THEN 1 ELSE 0 END
         AND (
           SELECT count(*)::integer
             FROM public.rake_records exact_target_rake
            WHERE exact_target_rake.tournament_id = target.id
              AND exact_target_rake.source = 'fn_award_satellite_seat'
              AND exact_target_rake.metadata->>'satellite_id' = OLD.id::text
              AND exact_target_rake.metadata->>'user_id' = source_player.user_id::text
              AND exact_target_rake.metadata->>'registration_id' = target_player.id::text
              AND round(exact_target_rake.rake_amount, 2)
                  = round(COALESCE(target.buy_in_fee, 0), 2)
              AND round(COALESCE(exact_target_rake.pot_size, 0), 2) = v_delta
         ) = CASE WHEN COALESCE(target.buy_in_fee, 0) > 0 THEN 1 ELSE 0 END
         /* At this exact instruction the target seat exists, but the source
            payout and transfer journal do not. A replay or second debit has
            either one and therefore cannot match this predicate. */
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournament_payouts payout
            WHERE payout.tournament_id = OLD.id
              AND payout.user_id = source_player.user_id
              AND payout.position = e.position
              AND payout.source = 'satellite_seat'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.chip_ledger ledger
            WHERE ledger.idempotency_key =
              'tourney:' || OLD.id::text || ':seat:'
              || source_player.user_id::text || ':pool_transfer'
         );
    END IF;

    IF v_candidate_count = 1 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'finalized tournament % prize pool cannot change from % to %',
      NEW.id, OLD.prize_pool, NEW.prize_pool USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = OLD.tournament_id
      UNION ALL
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = NEW.tournament_id
      UNION ALL
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;
  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a result frozen by an atomic settlement batch cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.user_id, NEW.club_id, NEW.status,
         NEW.position, NEW.prize, NEW.eliminated_at, NEW.chips,
         NEW.registered_at, NEW.rebuys, NEW.add_on)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.user_id, OLD.club_id, OLD.status,
         OLD.position, OLD.prize, OLD.eliminated_at, OLD.chips,
         OLD.registered_at, OLD.rebuys, OLD.add_on) THEN
    RAISE EXCEPTION
      'a result frozen by an atomic settlement batch cannot change identity, payout club, status, position, prize, bust time or deal input'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_freeze_registered_tournament_settlement_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF ROW(NEW.variant, NEW.tournament_type, NEW.satellite_target_id,
         NEW.bubble_protection, round(COALESCE(NEW.buy_in_amount, 0), 2),
         round(COALESCE(NEW.guaranteed_prize, 0), 2))
     IS NOT DISTINCT FROM
     ROW(OLD.variant, OLD.tournament_type, OLD.satellite_target_id,
         OLD.bubble_protection, round(COALESCE(OLD.buy_in_amount, 0), 2),
         round(COALESCE(OLD.guaranteed_prize, 0), 2)) THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(OLD.status, '')) IN ('COMPLETING', 'COMPLETED')
     OR upper(COALESCE(NEW.status, '')) IN ('COMPLETING', 'COMPLETED') THEN
    RAISE EXCEPTION
      'tournament % settlement class, guarantee, Bubble Protection and buy-in are frozen once settlement begins',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'tournament % settlement class, guarantee, Bubble Protection and buy-in are frozen after its first entrant',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_freeze_atomic_final_table_deal_obligation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
  v_gate text := COALESCE(current_setting('app.atomic_final_table_deal_batch', true), '');
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.kind IN ('place', 'final_table_deal', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.kind IN ('place', 'final_table_deal', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;

  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'obligations frozen by an atomic final-table deal cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.kind, NEW.place, NEW.user_id,
         NEW.amount_owed, NEW.source, NEW.created_at, NEW.adjustment_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.kind, OLD.place, OLD.user_id,
         OLD.amount_owed, OLD.source, OLD.created_at, OLD.adjustment_id) THEN
    RAISE EXCEPTION
      'a frozen final-table-deal obligation identity, recipient or entitlement cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN
    RAISE EXCEPTION
      'final-table-deal obligations for tournament % are frozen by their atomic batch',
      OLD.tournament_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_paid + 0.005 < OLD.amount_paid
     OR NEW.amount_paid > NEW.amount_owed + 0.005
     OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION
      'a frozen final-table-deal payment record cannot move backwards or above its entitlement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_atomic_final_table_deal_completion_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_check jsonb;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.tournament_final_table_deal_batches b
        WHERE b.tournament_id = NEW.id
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = NEW.id AND o.kind = 'final_table_deal'
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = NEW.id AND p.source = 'final_table_deal'
     ) THEN
    RETURN NEW;
  END IF;

  v_check := public.fn_check_atomic_final_table_deal(NEW.id);
  IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN
    RAISE EXCEPTION
      'final-table-deal tournament % cannot complete: %', NEW.id, v_check::text
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_lock_atomic_final_table_deal_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settled_at timestamptz;
  v_has_batch boolean := false;
BEGIN
  SELECT b.settled_at INTO v_settled_at
    FROM public.tournament_final_table_deal_batches b
   WHERE b.tournament_id = OLD.id;
  v_has_batch := FOUND;

  IF v_has_batch
     AND (v_settled_at IS NULL
          OR OLD.status IS DISTINCT FROM 'COMPLETING'
          OR NEW.status IS DISTINCT FROM 'COMPLETED'
          OR current_setting('app.atomic_final_table_deal_batch', true)
               IS DISTINCT FROM OLD.id::text) THEN
    RAISE EXCEPTION
      'tournament % has an atomic final-table-deal batch; only its owning transaction may advance COMPLETING to COMPLETED after full settlement',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completed_certificate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_winner uuid;
  v_kind text;
  v_ready jsonb;
  v_existing public.tournament_finish_receipts%ROWTYPE;
BEGIN
  IF COALESCE(NEW.on_break,false) THEN
    RAISE EXCEPTION 'tournament % cannot complete while on_break remains true', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  v_kind := public.fn_tournament_finish_kind(NEW.id);

  IF v_kind = 'final_table_deal' THEN
    -- The final-table-deal domain RPC owns RUNNING -> COMPLETING -> COMPLETED
    -- in one transaction. Its settled immutable batch is the canonical winner
    -- claim and exists only in that same transaction before this trigger runs.
    IF OLD.status IS DISTINCT FROM 'COMPLETING'
       OR current_setting('app.atomic_final_table_deal_batch', true)
            IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'final-table-deal tournament % cannot complete from status %',
        NEW.id, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT b.chip_leader INTO v_winner
      FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id = NEW.id AND b.settled_at IS NOT NULL;
    IF v_winner IS NULL THEN
      RAISE EXCEPTION 'final-table-deal tournament % has no settled atomic winner claim', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.tournament_finish_receipts
      (tournament_id,winner_user_id,finish_kind,claim_source)
    VALUES (NEW.id,v_winner,v_kind,'atomic_final_table_deal')
    ON CONFLICT (tournament_id) DO NOTHING;
  ELSE
    -- Normal and satellite settlement consume an immutable RUNNING ->
    -- COMPLETING claim made before their domain plan is frozen. The certificate
    -- layer does not invent a missing claim for an out-of-band writer.
    IF OLD.status IS DISTINCT FROM 'COMPLETING' THEN
      RAISE EXCEPTION 'tournament % cannot complete from status %', NEW.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_winner
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.id
       AND tp.status = 'winner' AND tp.position = 1;
    IF v_winner IS NULL THEN
      RAISE EXCEPTION 'tournament % has no canonical winner', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT * INTO v_existing FROM public.tournament_finish_receipts
   WHERE tournament_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable finish claim', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_existing.winner_user_id IS DISTINCT FROM v_winner
     OR v_existing.finish_kind IS DISTINCT FROM v_kind THEN
    RAISE EXCEPTION 'tournament % completion conflicts with finish claim', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  v_ready := public.fn_tournament_finish_readiness(NEW.id,v_winner);
  IF COALESCE((v_ready->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % is not financially certified: %',
      NEW.id, COALESCE(v_ready->'failures','[]'::jsonb)
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.tournament_finish_receipts
     SET certified_at = COALESCE(certified_at,now()),
         completed_at = COALESCE(completed_at,COALESCE(NEW.ended_at,now())),
         evidence = COALESCE(evidence,v_ready),
         updated_at = now()
   WHERE tournament_id = NEW.id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completing_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_kind text;
  v_finish public.tournament_finish_receipts%ROWTYPE;
BEGIN
  IF NEW.status = 'COMPLETING' AND OLD.status IS DISTINCT FROM 'COMPLETING' THEN
    IF OLD.status IS DISTINCT FROM 'RUNNING' THEN
      RAISE EXCEPTION 'tournament % cannot claim completion from status %',
        NEW.id, OLD.status USING ERRCODE = 'check_violation';
    END IF;

    v_kind := public.fn_tournament_finish_kind(NEW.id);
    IF v_kind = 'final_table_deal' THEN
      IF current_setting('app.atomic_final_table_deal_batch', true)
           IS DISTINCT FROM NEW.id::text THEN
        RAISE EXCEPTION 'final-table-deal tournament % has no atomic claim owner', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;

    SELECT * INTO v_finish
      FROM public.tournament_finish_receipts f
     WHERE f.tournament_id = NEW.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % cannot enter COMPLETING without an immutable finish claim',
        NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF v_finish.finish_kind IS DISTINCT FROM v_kind THEN
      RAISE EXCEPTION 'tournament % COMPLETING claim has format conflict', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_setting('app.tournament_finish_claim', true)
         IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'tournament % COMPLETING claim has no RPC owner', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_serialize_entry_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* This is a backstop for a direct/unwrapped INSERT. A canonical RPC already
     owns the shared lock before touching any rows. An unexpected outer caller
     may already own unrelated rows, so waiting behind a queued maintenance
     writer here could form a soft deadlock. Fail the whole statement
     immediately and transactionally instead; the caller may retry from its
     outer boundary. */
  IF NOT pg_try_advisory_xact_lock_shared(530090, 1) THEN
    RAISE EXCEPTION
      'ENTRY_BOUNDARY_BUSY: maintenance announcement owns the entry boundary'
      USING ERRCODE = '40001';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_lock_tournament_start_time_during_launch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.start_time IS DISTINCT FROM OLD.start_time
     AND EXISTS (
       SELECT 1
         FROM public.tournament_launch_receipts r
        WHERE r.tournament_id = OLD.id
          AND r.completed_at IS NULL
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_LAUNCH_START_TIME_LOCKED: an incomplete launch receipt owns the advertised start'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_lock_tournament_player_launch_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_proof_open boolean;
  v_must_lock_live_seat_invariant boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.chips IS NOT DISTINCT FROM OLD.chips
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number THEN
    RETURN NEW;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id]
  END;

  /* A completed launch no longer needs every chip/link maintenance write to
     take its proof locks.  It DOES still need every mutation that can remove
     the active roster supporting a concurrent live-seat acquisition to share
     the same receipt -> tournament lock.  Without this distinction, a seat
     INSERT could prove an active roster while a concurrent DELETE or
     active-to-inactive UPDATE skipped the parent lock; each transaction could
     then commit the half of an impossible state it observed before the other.
     Identity changes and inactive/unknown status transitions stay on the
     conservative side.  Only same-active status/link/chip traffic may use the
     completed-launch fast path below. */
  v_must_lock_live_seat_invariant :=
    TG_OP = 'DELETE'
    OR (
      TG_OP = 'UPDATE'
      AND (
        NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NOT (
          OLD.status IN ('registered', 'playing')
          AND NEW.status IN ('registered', 'playing')
        )
      )
    );

  IF TG_OP <> 'INSERT' AND NOT v_must_lock_live_seat_invariant THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_lock_and_validate_tournament_live_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_ids uuid[];
  v_is_live_acquisition boolean := false;
  v_proof_open boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.seat_number IS NOT DISTINCT FROM OLD.seat_number
     AND NEW.stack IS NOT DISTINCT FROM OLD.stack
     AND NEW.left_at IS NOT DISTINCT FROM OLD.left_at THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT t.tournament_id INTO v_old_tournament_id
      FROM public.tables t
     WHERE t.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT t.tournament_id INTO v_new_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
  END IF;

  -- A CASH SEAT HAS NO LAUNCH PROOF TO LOCK (2026-09-10). With both ids NULL
  -- the body below cannot lock, refuse or require anything: v_ids would be
  -- {NULL,NULL}, the proof-open test is false, the lock helper returns on an
  -- empty set, and the roster check needs a tournament. Measured 6.4 ms per
  -- seat write on a cash table for that no-op; see the migration header.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[v_new_tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[v_old_tournament_id]
    ELSE ARRAY[v_old_tournament_id, v_new_tournament_id]
  END;

  IF TG_OP = 'INSERT' THEN
    v_is_live_acquisition := NEW.left_at IS NULL AND NEW.user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_is_live_acquisition := NEW.left_at IS NULL
      AND NEW.user_id IS NOT NULL
      AND (
        OLD.left_at IS NOT NULL
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.table_id IS DISTINCT FROM NEW.table_id
      );
  END IF;

  IF NOT v_is_live_acquisition THEN
    -- THE SAME ROWS AS `t.id = ANY(v_ids)`, WITHOUT A RE-PLAN PER CALL
    -- (2026-09-10). v_ids is {new} / {old} / {old,new} for INSERT / DELETE /
    -- UPDATE, and the side that is not assigned is NULL, which matches nothing
    -- in either form. With an array parameter PL/pgSQL keeps a custom plan and
    -- re-plans this statement on every seat write (0.83-0.99 ms measured);
    -- with two scalar parameters it adopts the generic plan (0.026 ms).
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE (t.id = v_old_tournament_id OR t.id = v_new_tournament_id)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  PERFORM *
    FROM public.fn_lock_tournament_launch_proof_parents(v_ids);

  IF TG_OP <> 'DELETE'
     AND NEW.left_at IS NULL
     AND NEW.user_id IS NOT NULL
     AND v_new_tournament_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_new_tournament_id
          AND p.user_id = NEW.user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament %',
      NEW.user_id, v_new_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_lock_and_classify_tournament_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
  v_parent_status text;
  v_launch_id uuid;
  v_launch_generation uuid;
  v_launch_completed_at timestamptz;
  v_proof_open boolean;
  v_needs_origin boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tournament_id IS NOT DISTINCT FROM OLD.tournament_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.current_players IS NOT DISTINCT FROM OLD.current_players
     AND NEW.max_players IS NOT DISTINCT FROM OLD.max_players
     AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted THEN
    RETURN NEW;
  END IF;

  v_ids := CASE
    WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.tournament_id]
    WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.tournament_id]
    ELSE ARRAY[OLD.tournament_id, NEW.tournament_id]
  END;

  v_needs_origin := TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL;
  IF TG_OP = 'UPDATE'
     AND OLD.tournament_id IS NULL
     AND NEW.tournament_id IS NOT NULL THEN
    v_needs_origin := true;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.tournament_id IS NOT NULL
     AND NEW.tournament_id IS DISTINCT FROM OLD.tournament_id THEN
    PERFORM *
      FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_ORIGIN_IMMUTABLE: table % cannot change tournament', OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF NOT v_needs_origin THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.tournaments t
        LEFT JOIN public.tournament_launch_receipts r
          ON r.tournament_id = t.id
       WHERE t.id = ANY(v_ids)
         AND (upper(t.status::text) = 'REGISTERING' OR r.completed_at IS NULL)
         AND (upper(t.status::text) = 'REGISTERING' OR r.tournament_id IS NOT NULL)
    ) INTO v_proof_open;
    IF NOT v_proof_open THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  IF v_needs_origin THEN
    SELECT locked.parent_status,
           locked.launch_id,
           locked.launch_lease_generation,
           locked.launch_completed_at
      INTO v_parent_status,
           v_launch_id,
           v_launch_generation,
           v_launch_completed_at
      FROM public.fn_lock_tournament_launch_proof_parents(
        ARRAY[NEW.tournament_id]
      ) AS locked;

    IF upper(v_parent_status) = 'RUNNING' THEN
      IF v_launch_id IS NOT NULL AND v_launch_completed_at IS NULL THEN
        RAISE EXCEPTION
          'TOURNAMENT_TABLE_ORIGIN_STATE_MISMATCH: RUNNING parent has an incomplete launch receipt'
          USING ERRCODE = '55000';
      END IF;
      INSERT INTO public.tournament_table_origins (
        table_id, tournament_id, origin_kind
      ) VALUES (
        NEW.id, NEW.tournament_id, 'capacity'
      );
    ELSIF upper(v_parent_status) = 'REGISTERING' THEN
      IF v_launch_id IS NULL THEN
        INSERT INTO public.tournament_table_origins (
          table_id, tournament_id, origin_kind
        ) VALUES (
          NEW.id, NEW.tournament_id, 'prelaunch'
        );
      ELSIF v_launch_completed_at IS NULL THEN
        INSERT INTO public.tournament_table_origins (
          table_id,
          tournament_id,
          origin_kind,
          launch_id,
          launch_lease_generation
        ) VALUES (
          NEW.id,
          NEW.tournament_id,
          'launch',
          v_launch_id,
          v_launch_generation
        );
      ELSE
        RAISE EXCEPTION
          'TOURNAMENT_TABLE_ORIGIN_STATE_MISMATCH: REGISTERING parent has a completed launch receipt'
          USING ERRCODE = '55000';
      END IF;
    ELSIF v_launch_id IS NULL THEN
      INSERT INTO public.tournament_table_origins (
        table_id, tournament_id, origin_kind
      ) VALUES (
        NEW.id, NEW.tournament_id, 'prelaunch'
      );
    ELSE
      RAISE EXCEPTION
        'STALE_TOURNAMENT_LAUNCH_TABLE: completed or inconsistent launch cannot create table %',
        NEW.id
        USING ERRCODE = '55000';
    END IF;
  ELSE
    PERFORM *
      FROM public.fn_lock_tournament_launch_proof_parents(v_ids);
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_assert_live_tournament_seat_has_roster()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_user_id uuid;
  v_parent_status text;
BEGIN
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'DELETE' OR NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT t.tournament_id INTO v_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSE
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;
    v_tournament_id := OLD.tournament_id;
    v_user_id := OLD.user_id;
  END IF;

  IF v_tournament_id IS NOT NULL THEN
    SELECT t.status::text INTO v_parent_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;

  /* Terminal cleanup may intentionally close the roster and seats in
     separate idempotent requests.  The invariant is strict while the event
     is joinable or playable; finished/cancelled tables are separately barred
     from acquiring new live seats and may drain without being wedged. */
  IF v_tournament_id IS NOT NULL
     AND upper(COALESCE(v_parent_status, '')) IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = v_tournament_id
          AND s.user_id = v_user_id
          AND s.left_at IS NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament_id
          AND p.user_id = v_user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament % at commit',
      v_user_id, v_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_tournament_table_close_requires_empty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_parent_status text;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NOT (
       (lower(NEW.status::text) = 'closed'
        AND lower(OLD.status::text) IS DISTINCT FROM 'closed')
       OR (COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false))
     ) THEN
    RETURN NEW;
  END IF;

  SELECT upper(t.status::text)
    INTO v_parent_status
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id;

  /* Terminal cleanup has its own atomic settlement/seat-release contracts.
     The dangerous path is a joinable or playing event whose table is being
     removed underneath a field that may still acquire a seat. */
  IF v_parent_status IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
        WHERE s.table_id = OLD.id
          AND s.left_at IS NULL
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_CLOSE_NOT_EMPTY: table % still has a live seat', OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF lower(NEW.status::text) = 'closed' THEN
    NEW.current_players := 0;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refuse_live_seat_on_closed_tournament_table()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table_status text;
  v_is_deleted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.left_at IS NOT NULL
       OR NEW.user_id IS NULL
       OR (
         OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
       ) THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT lower(t.status::text), COALESCE(t.is_deleted, false)
    INTO v_table_status, v_is_deleted
    FROM public.tables t
   WHERE t.id = NEW.table_id
     AND t.tournament_id IS NOT NULL
   FOR SHARE;

  IF FOUND AND (v_table_status = 'closed' OR v_is_deleted) THEN
    RAISE EXCEPTION
      'TOURNAMENT_TABLE_CLOSED: table % cannot acquire a live seat', NEW.table_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_arena_structure()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_asset text;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    IF TG_OP='UPDATE' AND (NEW.asset,NEW.is_platform) IS DISTINCT FROM (OLD.asset,OLD.is_platform) THEN
      RAISE EXCEPTION 'Arena Asset Is Immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.asset='diamonds' AND auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT asset INTO v_asset FROM public.clubs WHERE id=NEW.club_id;
  IF TG_TABLE_NAME='club_members' AND TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
     AND EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Participation Cannot Become A Chip Membership' USING ERRCODE='23514';
  END IF;
  -- Branch before resolving fields: membership rows do not have union_id.
  IF TG_TABLE_NAME IN ('tables','tournaments') THEN
    IF TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
       AND (EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset IS DISTINCT FROM v_asset)
         OR (OLD.club_id IS NULL AND OLD.union_id IS NOT NULL AND v_asset='diamonds')) THEN
      RAISE EXCEPTION 'Game Asset Is Immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF v_asset='diamonds' THEN
    IF TG_TABLE_NAME='club_members' THEN
      IF TG_OP='INSERT' OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'automatic'
         OR NEW.agent_id IS NOT NULL OR NEW.parent_agent_id IS NOT NULL
         OR coalesce(NEW.chip_balance,0)<>0 OR coalesce(NEW.credit_limit,0)<>0
         OR coalesce(NEW.credit_used,0)<>0 OR coalesce(NEW.promo_balance,0)<>0
         OR coalesce(NEW.held_chips,0)<>0 THEN
        RAISE EXCEPTION 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='union_clubs' THEN
      RAISE EXCEPTION 'Diamond Arena Cannot Join A Union' USING ERRCODE='23514';
    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';
    ELSIF NEW.union_id IS NOT NULL THEN
      RAISE EXCEPTION 'Diamond Games Cannot Belong To A Union' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_chip_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' OR NOT EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
   WHERE c.user_id=NEW.user_id AND c.target_id=NEW.table_id AND c.purpose='cash_seat'
     AND c.entry_key='seat:'||NEW.id AND c.state='reserved' AND c.balance=NEW.stack
     AND c.seat_id IS NULL AND a.cash_games_enabled
 ) THEN
   RAISE EXCEPTION 'Diamond Seat Requires Atomic Custody Funding' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_elimination_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'eliminated' THEN
      NEW.elimination_sequence := nextval(
        'public.tournament_player_elimination_sequence'::regclass);
    ELSE
      NEW.elimination_sequence := NULL;
    END IF;
  ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'
        AND NEW.status::text = 'eliminated' THEN
    NEW.elimination_sequence := nextval(
      'public.tournament_player_elimination_sequence'::regclass);
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text IS DISTINCT FROM 'eliminated' THEN
    NEW.elimination_sequence := NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
    RAISE EXCEPTION 'elimination_sequence is database-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_charge_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_split record;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.from_type IS DISTINCT FROM 'player_wallet'
     OR NEW.to_type IS DISTINCT FROM 'prize_liability'
     OR NEW.to_entity_id IS DISTINCT FROM NEW.tournament_id
     OR lower(COALESCE(NEW.category,'')) NOT IN (
          'tournament_buyin','rebuy','addon') THEN
    RETURN NULL;
  END IF;
  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN
    RAISE EXCEPTION 'tournament charge ledger omitted player or source club'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
    NEW.tournament_id,NEW.category,NEW.amount);
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    NEW.tournament_id,NEW.from_entity_id,'wallet_charge',lower(NEW.category),
    NEW.club_id,round(NEW.amount,2),v_split.refund_prize,
    v_split.refund_bounty,v_split.refund_fee,NEW.id,NULL,NULL,NULL,
    'wallet_gross','atomic_wallet_charge',transaction_timestamp());
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_capture_satellite_seat_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_l public.chip_ledger%ROWTYPE;
  v_rows integer;
BEGIN
  IF NEW.delivery_kind IS DISTINCT FROM 'seat' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_h FROM public.tournament_satellite_settlements h
   WHERE h.tournament_id=NEW.tournament_id;
  SELECT * INTO v_l FROM public.chip_ledger l
   WHERE l.idempotency_key=NEW.idempotency_key||':pool_transfer'
     AND l.from_type='prize_liability'
     AND l.from_entity_id=NEW.tournament_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_h.target_id
     AND l.amount=NEW.amount;
  IF v_h.tournament_id IS NULL OR v_l.id IS NULL OR v_l.club_id IS NULL
     OR NEW.registration_id IS NULL
     OR v_h.ticket_cost IS DISTINCT FROM NEW.amount
     OR v_h.ticket_cost IS DISTINCT FROM
          round(v_h.target_buy_in+v_h.target_fee,2) THEN
    RAISE EXCEPTION
      'satellite seat award has no exact target contract and pool-transfer source'
      USING ERRCODE = 'P0404';
  END IF;
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    v_h.target_id,NEW.user_id,'satellite_seat','satellite_seat',
    v_l.club_id,NEW.amount,v_h.target_buy_in,0,v_h.target_fee,
    v_l.id,NEW.registration_id,NEW.tournament_id,NEW.place,
    'satellite_in','atomic_satellite_seat',transaction_timestamp())
  ON CONFLICT(source_ledger_id) DO NOTHING;
  SELECT count(*) INTO v_rows
    FROM public.tournament_refund_entitlements e
   WHERE e.source_ledger_id=v_l.id
     AND e.tournament_id=v_h.target_id AND e.user_id=NEW.user_id
     AND e.entitlement_kind='satellite_seat'
     AND e.charge_category='satellite_seat'
     AND e.refund_wallet_club_id=v_l.club_id
     AND e.gross=NEW.amount
     AND e.refund_prize=v_h.target_buy_in
     AND e.refund_bounty=0 AND e.refund_fee=v_h.target_fee
     AND e.registration_id=NEW.registration_id
     AND e.source_satellite_id=NEW.tournament_id
     AND e.source_award_place=NEW.place;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite seat entitlement identity conflicts with its source'
      USING ERRCODE = 'P0404';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_entry_ticket_is_guarded()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_token uuid := NULLIF(
    current_setting('app.ca_satellite_ticket_use_token',true),'')::uuid;
  v_authorization public.tournament_ticket_admission_authorizations%ROWTYPE;
  v_rows integer;
BEGIN
  IF TG_OP='DELETE' AND OLD.redemption_mode='tournament_entry_only' THEN
    RAISE EXCEPTION 'tournament-entry tickets are durable financial evidence'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.redemption_mode='tournament_entry_only' THEN
    IF ROW(NEW.id,NEW.club_id,NEW.issued_by,NEW.holder_id,NEW.value,NEW.note,
           NEW.redemption_mode,NEW.source_tournament_id,
           NEW.source_satellite_id,NEW.source_refund_entitlement_id,
           NEW.source_satellite_award_place,
           NEW.entry_prize,NEW.entry_bounty,NEW.entry_fee,NEW.created_at,
           NEW.cancelled_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.club_id,OLD.issued_by,OLD.holder_id,OLD.value,OLD.note,
           OLD.redemption_mode,OLD.source_tournament_id,
           OLD.source_satellite_id,OLD.source_refund_entitlement_id,
           OLD.source_satellite_award_place,
           OLD.entry_prize,OLD.entry_bounty,OLD.entry_fee,OLD.created_at,
           OLD.cancelled_at) THEN
      RAISE EXCEPTION 'tournament-entry ticket identity and rails are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.status='issued' AND NEW.status='redeemed'
              AND v_token IS NOT NULL
              AND OLD.redeemed_at IS NULL
              AND NEW.redeemed_at IS NOT NULL
              AND NEW.redeemed_at=transaction_timestamp()) THEN
        RAISE EXCEPTION
          'tournament-entry tickets can only be consumed by tournament admission'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO v_authorization
        FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id
       FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.user_id IS DISTINCT FROM OLD.holder_id
         OR NOT EXISTS(
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.id=v_authorization.registration_id
              AND tp.tournament_id=v_authorization.tournament_id
              AND tp.user_id=v_authorization.user_id
              AND tp.status::text IN ('registered','playing')) THEN
        RAISE EXCEPTION
          'tournament-entry ticket has no exact admission authorization'
          USING ERRCODE = '42501';
      END IF;
      DELETE FROM public.tournament_ticket_admission_authorizations a
       WHERE a.token=v_token AND a.ticket_id=OLD.id;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION
          'tournament-entry ticket admission authorization was not consumed once'
          USING ERRCODE = 'P0404';
      END IF;
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at THEN
      RAISE EXCEPTION
        'tournament-entry ticket redemption time is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_satellite_settlement_receipts_are_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'satellite settlement evidence is immutable; % is refused for tournament %',
    TG_OP, OLD.tournament_id USING ERRCODE = '55000';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_unregistration_rake_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournament_unregistration_receipts receipt
     WHERE ARRAY[OLD.id] && receipt.fee_reversal_ids
        OR ARRAY[OLD.id] && receipt.fee_source_rake_record_ids) THEN
    RAISE EXCEPTION
      'committed tournament unregistration rake evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_satellite_target_contract_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(OLD.entry_contract_locked,false)
     AND NEW.entry_contract_locked IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'tournament % funded-entry contract marker cannot be cleared',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.buy_in_amount,NEW.buy_in_fee,NEW.bounty_amount,
      NEW.rebuy_cost,NEW.addon_cost,
      NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,NEW.is_premium_spin,
      NEW.variant,NEW.tournament_type,NEW.club_id)
       IS NOT DISTINCT FROM
     (OLD.buy_in_amount,OLD.buy_in_fee,OLD.bounty_amount,
      OLD.rebuy_cost,OLD.addon_cost,
      OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,OLD.is_premium_spin,
      OLD.variant,OLD.tournament_type,OLD.club_id) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.entry_contract_locked,false) THEN
    RAISE EXCEPTION
      'tournament % economic contract is immutable after its first funded entry',
      OLD.id USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.tournament_id = OLD.id
       AND l.from_type = 'player_wallet'
       AND l.to_type = 'prize_liability'
       AND l.to_entity_id = OLD.id
       AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
  ) OR EXISTS (
    SELECT 1
      FROM public.tournament_satellite_settlements h
      JOIN public.tournament_satellite_awards a
        ON a.tournament_id = h.tournament_id
       AND a.delivery_kind IN ('seat','ticket')
     WHERE h.target_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'tournament % economic contract is immutable after its first funded entry',
      OLD.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_table_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.seat_game_scope := CASE WHEN NEW.cluster_id IS NULL
    THEN 'table:'||NEW.id::text ELSE 'cluster:'||NEW.cluster_id::text END;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_active_seat_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    NEW.active_game_scope := NULL;
  ELSE
    SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
    IF NOT FOUND OR NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'Active seat requires an existing table and player' USING ERRCODE='23514';
    END IF;
    IF NEW.active_game_scope IS NULL THEN
      -- A pre-migration empty table has no cached scope. Initialize only that
      -- parent, inside this admission transaction. Existing occupied tables
      -- never take this UPDATE path. Concurrent initialization is idempotent.
      UPDATE public.tables t SET seat_game_scope = CASE WHEN t.cluster_id IS NULL
        THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END
      WHERE t.id=NEW.table_id AND t.seat_game_scope IS NULL;
      SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
      IF NEW.active_game_scope IS NULL THEN
        RAISE EXCEPTION 'Active seat parent scope initialization failed' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_table_seat_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 NEW.seat_admission_key := CASE
   WHEN lower(coalesce(NEW.status,'')) IN ('closed','completed','cancelled','finished')
     OR NEW.lifecycle='closed' OR coalesce(NEW.is_deleted,false) OR coalesce(NEW.is_template,false) THEN 'closed'
   WHEN NEW.tournament_id IS NOT NULL THEN 'tournament:'||NEW.tournament_id::text
   ELSE 'cash' END;
 RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_require_live_seat_parent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE parent_key text;
BEGIN
 IF NEW.left_at IS NOT NULL THEN
  NEW.active_parent_key := NULL;
  RETURN NEW;
 END IF;
 SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active seat requires an existing parent table' USING ERRCODE='23514'; END IF;
 IF parent_key IS NULL THEN
  -- Only a pre-migration empty parent needs this initialization. Ordinary
  -- admissions do not update/lock the parent ahead of the native FK check.
  UPDATE public.tables t SET seat_admission_key = CASE
    WHEN lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished')
      OR t.lifecycle='closed' OR coalesce(t.is_deleted,false) OR coalesce(t.is_template,false) THEN 'closed'
    WHEN t.tournament_id IS NOT NULL THEN 'tournament:'||t.tournament_id::text
    ELSE 'cash' END
  WHERE t.id=NEW.table_id AND t.seat_admission_key IS NULL;
  SELECT t.seat_admission_key INTO parent_key FROM public.tables t WHERE t.id=NEW.table_id;
 END IF;
 IF parent_key IS NULL OR parent_key='closed' THEN
  RAISE EXCEPTION 'CLOSED_TABLE_REJECTS_ACTIVE_SEAT' USING ERRCODE='23514';
 END IF;

 IF TG_OP='INSERT' OR OLD.left_at IS NOT NULL
   OR OLD.table_id IS DISTINCT FROM NEW.table_id OR OLD.user_id IS DISTINCT FROM NEW.user_id THEN
  IF (current_setting('app.money_path',true) IN ('atomic_table_buyin','fn_horse_seat_from_treasury')
      OR current_setting('app.cash_seat_move',true)='on') AND parent_key<>'cash' THEN
   RAISE EXCEPTION 'CASH_PURCHASE_ONLY: cash admission cannot create tournament chips' USING ERRCODE='55000';
  END IF;
 END IF;
 NEW.active_parent_key := parent_key;
 RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_live_seat_acquisition_requires_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_tournament_status text;
  v_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_global boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.left_at IS NOT NULL OR NEW.user_id IS NULL
       OR (OLD.left_at IS NULL
         AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
         AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
         AND OLD.seat_number IS NOT DISTINCT FROM NEW.seat_number) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,''))
    INTO v_tournament_id,v_tournament_status
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.pid=pg_backend_pid()
       AND l.locktype='advisory'
       AND l.database=(
         SELECT d.oid FROM pg_catalog.pg_database d
          WHERE d.datname=current_database())
       AND l.classid=(((v_key>>32)&4294967295)::oid)
       AND l.objid=((v_key&4294967295)::oid)
       AND l.objsubid=1
       AND l.mode='ExclusiveLock'
       AND l.granted)
    INTO v_owns_global;
  IF NOT COALESCE(v_owns_global,false) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
      USING ERRCODE='55000',
            HINT='Use a canonical tournament seat purchase, registration, move, or assignment RPC.';
  END IF;
  IF v_tournament_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ACQUISITION_CLOSED: tournament %, status %',
      v_tournament_id,v_tournament_status
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_tournament_contract_is_draw()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
  v_multiplier numeric;
  v_prize numeric;
  v_old_sealed boolean;
BEGIN
  IF NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.prize_pool IS NOT DISTINCT FROM OLD.prize_pool
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant,'')) <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  -- Preserve the audited terminal exception: cancellation may zero the
  -- contract only when no reserve booking ever existed or its exact unwind
  -- receipt is already durable in this transaction.
  IF upper(COALESCE(NEW.status::text,'')) IN ('CANCELLED','CANCELED')
     AND upper(COALESCE(OLD.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     AND NEW.prize_pool IS NOT DISTINCT FROM 0::numeric
     AND NEW.spin_multiplier IS NOT DISTINCT FROM OLD.spin_multiplier
     AND NEW.spin_locked_tiers IS NOT DISTINCT FROM OLD.spin_locked_tiers
     AND (
       (NOT EXISTS (
          SELECT 1 FROM public.spin_reserve_ledger r
           WHERE r.tournament_id=NEW.id
             AND r.kind IN ('contribution','jackpot_draw')))
       OR EXISTS (
          SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
           WHERE u.tournament_id=NEW.id)) THEN
    RETURN NEW;
  END IF;

  SELECT count(*),min(r.multiplier),min(round(-r.amount,2))
    INTO v_count,v_multiplier,v_prize
    FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=NEW.id AND r.kind='jackpot_draw';

  -- A Spin's fill-window deadline is not start truth. Until launch completion,
  -- the tournament status, started_at and immutable launch receipt all prove
  -- it has not started. Requiring zero reserve rows limits this door to the
  -- first two paid seats; the third-seat booking closes it permanently.
  IF v_count=0
     AND upper(COALESCE(OLD.status::text,''))
           IN ('ANNOUNCED','REGISTERING')
     AND upper(COALESCE(NEW.status::text,''))
           IN ('ANNOUNCED','REGISTERING')
     AND OLD.started_at IS NULL
     AND NEW.started_at IS NULL
     AND COALESCE(OLD.spin_multiplier,0)=0
     AND COALESCE(NEW.spin_multiplier,0)=0
     AND OLD.spin_locked_tiers IS NULL
     AND NEW.spin_locked_tiers IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=NEW.id
          AND r.completed_at IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.spin_reserve_ledger r
        WHERE r.tournament_id=NEW.id
          AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN NEW;
  END IF;

  IF v_count<>1
     OR NEW.spin_multiplier IS DISTINCT FROM v_multiplier
     OR NEW.prize_pool IS DISTINCT FROM v_prize THEN
    RAISE EXCEPTION
      'Spin % tournament contract must equal its one immutable reserve draw',
      NEW.id USING ERRCODE='P0404';
  END IF;
  v_old_sealed:=OLD.spin_multiplier IS NOT DISTINCT FROM v_multiplier
                AND OLD.prize_pool IS NOT DISTINCT FROM v_prize
                AND OLD.spin_locked_tiers IS NOT NULL;
  IF v_old_sealed THEN
    RAISE EXCEPTION 'Spin % published draw contract is immutable',NEW.id
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_scope text; v_key text; v_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
     AND OLD.active_game_scope IS NOT DISTINCT FROM NEW.active_game_scope
     AND OLD.active_parent_key IS NOT DISTINCT FROM NEW.active_parent_key THEN
    RETURN NEW; -- an FK re-checks only when a referencing column changes
  END IF;
  IF NEW.table_id IS NULL OR (NEW.active_game_scope IS NULL AND NEW.active_parent_key IS NULL) THEN
    RETURN NEW; -- MATCH SIMPLE
  END IF;
  SELECT t.seat_game_scope, t.seat_admission_key, true INTO v_scope, v_key, v_found
    FROM public.tables t WHERE t.id = NEW.table_id FOR KEY SHARE;
  IF NEW.active_game_scope IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_scope IS DISTINCT FROM NEW.active_game_scope) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "active_seat_game_scope_parent"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'active_seat_game_scope_parent',
            DETAIL = format('Key (table_id, active_game_scope)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_game_scope);
  END IF;
  IF NEW.active_parent_key IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_key IS DISTINCT FROM NEW.active_parent_key) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "live_seat_parent_cannot_close"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
            DETAIL = format('Key (table_id, active_parent_key)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_parent_key);
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_table_parent_keys_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.seat_admission_key IS NOT NULL AND NEW.seat_admission_key IS DISTINCT FROM OLD.seat_admission_key THEN
    IF EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.table_id = OLD.id AND s.active_parent_key = OLD.seat_admission_key) THEN
      RAISE EXCEPTION 'update or delete on table "tables" violates foreign key constraint "live_seat_parent_cannot_close" on table "table_seats"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
              DETAIL = format('Key (id, seat_admission_key)=(%s, %s) is still referenced from table "table_seats".', OLD.id, OLD.seat_admission_key);
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_table_scope_cascade()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.seat_game_scope IS NOT NULL AND NEW.seat_game_scope IS DISTINCT FROM OLD.seat_game_scope THEN
    UPDATE public.table_seats s SET active_game_scope = NEW.seat_game_scope
     WHERE s.table_id = NEW.id AND s.active_game_scope = OLD.seat_game_scope;
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    v_old_tournament_id:=NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_new_tournament_id:=NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
      USING ERRCODE='55000';
  END IF;
  v_tournament_id:=COALESCE(v_new_tournament_id,v_old_tournament_id);
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='chip_ledger' AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_seat_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id=OLD.table_id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id=NEW.table_id;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND v_new_tournament_id IS NOT NULL THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_new_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=COALESCE(v_new_tournament_id,v_old_tournament_id)) THEN
    RAISE EXCEPTION 'cancelled tournament seat evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_wallet_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN v_old_tournament_id:=OLD.related_entity_id; END IF;
  IF TG_OP<>'DELETE' THEN v_new_tournament_id:=NEW.related_entity_id; END IF;
  IF TG_OP='INSERT' AND v_new_tournament_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id=v_new_tournament_id) THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_new_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_old_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
                 WHERE h.tournament_id=v_new_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament wallet evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_parent_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=OLD.id) THEN
    RAISE EXCEPTION 'receipted cancellation % is immutable',OLD.id
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_status text;
  v_ended_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Tournament tables are durable event evidence. They close; they are never
    -- deleted. This unconditional rule needs no parent lock after PostgreSQL
    -- has already acquired the child row, so it cannot reverse terminal's
    -- tournament -> table order.
    IF OLD.tournament_id IS NOT NULL THEN
      RAISE EXCEPTION 'tournament table % is durable and cannot be deleted',OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'new table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tournament_id IS NOT NULL THEN
      -- INSERT has no child row to lock yet, so taking the parent first is
      -- deadlock-safe. If terminal owns it, this waits and then sees COMPLETED;
      -- if expansion owns it first, terminal waits and includes the new table.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
        FROM public.tournaments t
       WHERE t.id = NEW.tournament_id
       FOR SHARE;
      IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'cannot add table % to terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'table identity % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  -- Reassociation would be a child-row-first parent transition and would also
  -- change the immutable event table set. Tournament membership never moves.
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     AND (NEW.tournament_id IS NOT NULL OR OLD.tournament_id IS NOT NULL) THEN
    RAISE EXCEPTION 'table % tournament association is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF OLD.terminal_closed_at IS NOT NULL THEN
    IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.terminal_closed_at IS DISTINCT FROM OLD.terminal_closed_at
       OR lower(COALESCE(NEW.status::text,'')) <> 'closed'
       OR lower(COALESCE(NEW.lifecycle,'')) <> 'closed'
       OR NEW.current_players IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'terminal tournament table % cannot reopen or move',OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')),t.ended_at
      INTO v_new_status,v_ended_at
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      IF NEW.current_players IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'table % cannot reopen terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
      -- The existing game-end hook first clears current_players while leaving
      -- status unchanged. Coerce that one-way zero-player write directly to
      -- the terminal shape; delayed waiting/running writes can never reopen it.
      NEW.status := 'closed';
      NEW.lifecycle := 'closed';
      NEW.terminal_closed_at := COALESCE(v_ended_at,transaction_timestamp());
    ELSIF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'live tournament table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.terminal_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'unscoped table % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_status text;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_tournament_id := NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid IS DISTINCT FROM
       NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid THEN
      RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  ELSE
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;

  IF v_tournament_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND to_jsonb(OLD) ? 'terminal_closed_at' THEN
    v_old_marker := NULLIF(to_jsonb(OLD)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP <> 'DELETE' AND to_jsonb(NEW) ? 'terminal_closed_at' THEN
    v_new_marker := NULLIF(to_jsonb(NEW)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION '% rows cannot supply a terminal marker',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% terminal marker transition is not canonical',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  -- A journal row is durable testimony from the instant it names a
  -- tournament. Refuse its UPDATE/DELETE without taking a child-to-parent
  -- lock; a row trigger already owns the child tuple at this point. INSERT is
  -- the only operation that takes the root lock, which preserves the
  -- parent-to-child order used by both terminal authorities.
  IF TG_TABLE_NAME = 'chip_ledger' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = v_tournament_id)
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION
      'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_seat_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_status text;
  v_marker timestamptz;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT tb.tournament_id INTO v_old_tournament_id
      FROM public.tables tb WHERE tb.id = OLD.table_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id THEN
    -- Same table on both sides: one lookup answers for both (2026-09-10).
    v_new_tournament_id := v_old_tournament_id;
  ELSIF TG_OP <> 'DELETE' THEN
    SELECT tb.tournament_id INTO v_new_tournament_id
      FROM public.tables tb WHERE tb.id = NEW.table_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;

  -- A CASH SEAT WITH NO TERMINAL MARKER HAS NOTHING TO BE IMMUTABLE ABOUT
  -- (2026-09-10). With no tournament on either side and no marker on either
  -- side, every check below passes and the row is returned; return it here
  -- instead of after a status lookup and three receipt scans on a NULL id.
  IF v_old_tournament_id IS NULL AND v_new_tournament_id IS NULL
     AND v_old_marker IS NULL AND v_new_marker IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'seat % cannot move between tournament owners',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament seat % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'seat % terminal marker transition is not canonical',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id
     FOR SHARE;
    SELECT tb.terminal_closed_at INTO v_marker
      FROM public.tables tb
     WHERE tb.id = NEW.table_id
       AND tb.tournament_id = v_new_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')),tb.terminal_closed_at
      INTO v_status,v_marker
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = COALESCE(v_new_tournament_id,v_old_tournament_id))
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION 'terminal tournament seat % is immutable',
      CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_receipted_tournament_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    RAISE EXCEPTION 'terminal tournament % is immutable after closure',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_terminal_wallet_transaction_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.related_entity_id IS DISTINCT FROM OLD.related_entity_id THEN
    RAISE EXCEPTION 'wallet transaction ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT t.id INTO v_old_tournament_id FROM public.tournaments t
     WHERE t.id = OLD.related_entity_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT t.id INTO v_new_tournament_id FROM public.tournaments t
     WHERE t.id = NEW.related_entity_id;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new wallet transaction cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'wallet transaction terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal wallet transaction evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_escrow_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_new_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old_tournament_id := OLD.tournament_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_tournament_id := NEW.tournament_id; END IF;
  IF TG_OP = 'UPDATE'
     AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION 'tournament escrow ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION 'new tournament escrow cannot supply a terminal marker'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_old_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tournament escrow terminal marker transition is not canonical'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND v_new_tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
      FROM public.tournaments t
     WHERE t.id = v_new_tournament_id FOR SHARE;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_tournament_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_tournament_id) THEN
    RAISE EXCEPTION 'terminal tournament escrow evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_terminal_evidence_markers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_at timestamptz;
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) NOT IN
       ('COMPLETED','CANCELLED','CANCELED')
     OR (TG_OP = 'UPDATE' AND upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED')) THEN
    RETURN NEW;
  END IF;
  v_terminal_at := NEW.ended_at;
  IF v_terminal_at IS NULL OR NOT isfinite(v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % requires one finite close marker',NEW.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.tournament_players
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_obligations
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_payouts
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_rake_settlements
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.rake_records
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_chests
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_awards
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_guarantee_overlays
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.table_seats s
     SET terminal_closed_at = v_terminal_at
    FROM public.tables tb
   WHERE tb.id = s.table_id AND tb.tournament_id = NEW.id
     AND s.terminal_closed_at IS NULL;
  UPDATE public.wallet_transactions
     SET terminal_closed_at = v_terminal_at
   WHERE related_entity_id = NEW.id AND terminal_closed_at IS NULL;
  UPDATE public.tournament_bounty_award_recipients r
     SET terminal_closed_at = v_terminal_at
    FROM public.tournament_bounty_awards a
   WHERE a.id = r.award_id AND a.tournament_id = NEW.id
     AND r.terminal_closed_at IS NULL;
  UPDATE public.tournament_escrow
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id AND terminal_closed_at IS NULL;
  -- Contribution and jackpot-draw rows already have an unconditional
  -- append-only guard. Cancellation reversal/surplus rows intentionally do
  -- not, so give precisely those mutable Spin rows the terminal tuple marker.
  UPDATE public.spin_reserve_ledger
     SET terminal_closed_at = v_terminal_at
   WHERE tournament_id = NEW.id
     AND kind NOT IN ('contribution','jackpot_draw')
     AND terminal_closed_at IS NULL;

  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=NEW.id
                AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=NEW.id
          AND s.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=NEW.id
          AND r.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=NEW.id
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=NEW.id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_terminal_at) THEN
    RAISE EXCEPTION 'terminal tournament % did not stamp every mutable evidence row',
      NEW.id USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_status text;
  v_acquisition_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_acquisition_root boolean:=false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.is_satellite_qualifier IS DISTINCT FROM OLD.is_satellite_qualifier
       OR NEW.source_satellite_id IS DISTINCT FROM OLD.source_satellite_id) THEN
    RAISE EXCEPTION 'tournament player ownership and entry provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,OLD.source_satellite_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,NEW.source_satellite_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = OLD.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = NEW.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  -- Ticket admission and an exact pre-start ticket return are the only
  -- lifecycle edges that may respectively add or remove provenance after the
  -- source satellite has closed. Both enclosing authorities acquire the same
  -- terminal-global transaction lock before touching the target registration.
  -- The unregistration wrapper additionally exposes its exact operation while
  -- the owner-only core is active; a raw DELETE therefore cannot masquerade as
  -- a ticket return merely by reaching this trigger.
  IF TG_OP IN ('INSERT','DELETE') THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid=pg_backend_pid()
         AND l.locktype='advisory'
         AND l.database=(
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname=current_database())
         AND l.classid=(((v_acquisition_key>>32)&4294967295)::oid)
         AND l.objid=((v_acquisition_key&4294967295)::oid)
         AND l.objsubid=1
         AND l.mode='ExclusiveLock'
         AND l.granted)
      INTO v_owns_acquisition_root;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    -- The rolling satellite authority owns target before source. Take both
    -- roots in that same order so a direct provenance insert cannot invert
    -- the pair across its specialized and generic guards.
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite provenance'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOREACH v_source_id IN ARRAY v_source_ids LOOP
      IF v_source_id IS DISTINCT FROM NEW.tournament_id THEN
        SELECT upper(COALESCE(t.status::text,'')) INTO v_status
          FROM public.tournaments t
         WHERE t.id = v_source_id FOR SHARE;
        IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
           AND NOT COALESCE(v_owns_acquisition_root,false) THEN
          RAISE EXCEPTION 'completed satellite target provenance is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NOT (
       (TG_OP='INSERT' AND COALESCE(v_owns_acquisition_root,false))
       OR (TG_OP='DELETE'
           AND COALESCE(v_owns_acquisition_root,false)
           AND COALESCE(current_setting(
                 'app.tournament_seat_exit_operation',true),'')='unregister')
     )
     AND EXISTS (
    SELECT 1 FROM unnest(v_source_ids) source(id)
     WHERE public.fn_ca_has_committed_tournament_receipt(source.id)
  ) THEN
    RAISE EXCEPTION 'completed satellite target provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_satellite_target_rake_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_source_id uuid;
  v_new_source_id uuid;
  v_text text;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_text := OLD.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_old_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_text := NEW.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_new_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.metadata->>'satellite_id') IS DISTINCT FROM
         (OLD.metadata->>'satellite_id') THEN
    RAISE EXCEPTION 'satellite target rake ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker
     AND public.fn_ca_terminal_marker_transition_is_exact(
           to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
    RETURN NEW;
  END IF;
  -- A recognized satellite fee row is append-only. Refusing an already-locked
  -- UPDATE/DELETE before any parent lookup removes the child-to-source lock
  -- edge. INSERT locks the target first, then the source, matching the
  -- canonical satellite authority.
  IF TG_OP <> 'INSERT'
     AND COALESCE(v_old_source_id,v_new_source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'satellite target rake rows are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite rake evidence'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM NEW.tournament_id THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM v_old_source_id THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_source_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_source_id) THEN
    RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_target_id uuid;
  v_text text;
  v_row jsonb;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.from_entity_id IS DISTINCT FROM OLD.from_entity_id
       OR NEW.to_entity_id IS DISTINCT FROM OLD.to_entity_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR (NEW.metadata->>'satellite_id') IS DISTINCT FROM
          (OLD.metadata->>'satellite_id')) THEN
    RAISE EXCEPTION 'satellite transfer journal ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_row IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  ] LOOP
    IF v_row IS NULL THEN CONTINUE; END IF;
    v_text := v_row->>'tournament_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    IF v_row->>'from_type' = 'prize_liability' THEN
      v_text := v_row->>'from_entity_id';
      IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_source_ids := array_append(v_source_ids,v_text::uuid);
      END IF;
    END IF;
    v_text := split_part(COALESCE(v_row->>'idempotency_key',''),':',2);
    IF COALESCE(v_row->>'idempotency_key','') LIKE 'tourney:%:seat:%:pool_transfer'
       AND v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    v_text := v_row->'metadata'->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
  END LOOP;
  IF TG_OP <> 'INSERT' AND cardinality(v_source_ids) > 0 THEN
    RAISE EXCEPTION 'satellite transfer journal is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.to_type = 'prize_liability' THEN
    SELECT t.id INTO v_target_id FROM public.tournaments t
     WHERE t.id = NEW.to_entity_id;
    IF v_target_id IS NOT NULL THEN
      -- The transfer's AFTER trigger writes target escrow, so own the target
      -- before any source root exactly as fn_settle_satellite_tournament does.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_target_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'terminal target cannot accept a satellite transfer journal'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  FOR v_source_id IN
    SELECT DISTINCT source.id FROM unnest(v_source_ids) source(id)
     WHERE source.id IS NOT NULL ORDER BY source.id
  LOOP
    IF TG_OP = 'INSERT' AND v_source_id IS DISTINCT FROM v_target_id THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_source_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'completed satellite transfer journal is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF public.fn_ca_has_committed_tournament_receipt(v_source_id) THEN
      RAISE EXCEPTION 'completed satellite transfer journal is immutable'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_non_satellite_completed_requires_terminal_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF upper(COALESCE(NEW.status::text,'')) <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.variant::text,'')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type::text,'')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL
     OR NEW.satellite_target IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'non-satellite tournament % cannot become COMPLETED without its atomic terminal receipt',
      NEW.id USING ERRCODE = '55000';
  END IF;
  PERFORM public.fn_ca_tournament_terminal_receipt(NEW.id,NULL);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_repair_changed_days()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  IF TG_TABLE_NAME = 'wallet_transactions' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR r IN
        SELECT DISTINCT x.d FROM (
          SELECT (o.created_at AT TIME ZONE 'UTC')::date AS d
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.amount IS DISTINCT FROM n.amount
              OR o.type IS DISTINCT FROM n.type
              OR o.category IS DISTINCT FROM n.category
              OR o.user_id IS DISTINCT FROM n.user_id
              OR o.table_id IS DISTINCT FROM n.table_id
              OR o.related_entity_id IS DISTINCT FROM n.related_entity_id
              OR o.created_at IS DISTINCT FROM n.created_at
          UNION
          SELECT (n.created_at AT TIME ZONE 'UTC')::date
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.created_at IS DISTINCT FROM n.created_at
        ) x
        ORDER BY x.d
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    ELSE
      FOR r IN
        SELECT DISTINCT (o.created_at AT TIME ZONE 'UTC')::date AS d
          FROM old_rows o ORDER BY 1
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'rake_records' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR r IN
        SELECT DISTINCT x.d FROM (
          SELECT (o.created_at AT TIME ZONE 'UTC')::date AS d
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
              OR o.created_at IS DISTINCT FROM n.created_at
              OR o.tournament_id IS DISTINCT FROM n.tournament_id
              OR o.is_tournament IS DISTINCT FROM n.is_tournament
              OR o.metadata IS DISTINCT FROM n.metadata
              OR o.club_id IS DISTINCT FROM n.club_id
          UNION
          SELECT (n.created_at AT TIME ZONE 'UTC')::date
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.created_at IS DISTINCT FROM n.created_at
        ) x
        ORDER BY x.d
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    ELSE
      FOR r IN
        SELECT DISTINCT (o.created_at AT TIME ZONE 'UTC')::date AS d
          FROM old_rows o ORDER BY 1
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data changed-ledger repair failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cancel_cash_seat_moves_on_table_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
     OR (NEW.seat_admission_key = 'closed' AND OLD.seat_admission_key IS DISTINCT FROM 'closed') THEN
    -- the moves that name this table, and the swap partners of those moves
    UPDATE public.cash_seat_moves m
       SET state = 'cancelled', note = 'table_closed'
     WHERE m.state = 'pending'
       AND (m.from_table_id = NEW.id OR m.to_table_id = NEW.id
            OR EXISTS (SELECT 1 FROM public.cash_seat_moves p
                        WHERE p.id = m.swap_move_id AND p.state = 'pending'
                          AND (p.from_table_id = NEW.id OR p.to_table_id = NEW.id)));
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_follows_a_changed_fact()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old date;
  v_new date;
BEGIN
  -- A rollup reads who, how much, which way, what kind, which table, which
  -- event and when. An UPDATE that changes none of those (a terminal marker,
  -- a note) has nothing to repair.
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.category IS NOT DISTINCT FROM OLD.category
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.related_entity_id IS NOT DISTINCT FROM OLD.related_entity_id
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NULL;
  END IF;
  v_old := (OLD.created_at AT TIME ZONE 'UTC')::date;
  v_new := CASE WHEN TG_OP = 'UPDATE'
                THEN (NEW.created_at AT TIME ZONE 'UTC')::date ELSE v_old END;
  PERFORM public.ca_refresh_reporting_rollups(LEAST(v_old, v_new), GREATEST(v_old, v_new));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data changed-ledger repair failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_fn_close_sessions_when_table_closes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    /* A CLOSED TABLE CLOSES ITS SESSIONS (2026-09-10). See the migration of
       the same name. Fires on the transition INTO closed/deleted only, so a
       no-op status write on an already-closed table does nothing. */
    IF (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
       OR (COALESCE(NEW.is_deleted,false) AND NOT COALESCE(OLD.is_deleted,false)) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'table_closed'
       WHERE scope_type = 'table' AND scope_id = NEW.id AND closed_at IS NULL;
    END IF;
    RETURN NEW;
  END $function$;

CREATE OR REPLACE FUNCTION public.trg_fn_close_session_when_seat_vacated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  BEGIN
    IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
              WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
    /* A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10). Deferred: any
       proper close in this transaction has already run. Only a session that
       NOBODY closed is still open here, and that is the one this closes. */
    IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = NEW.table_id AND t.tournament_id IS NULL) THEN
      UPDATE public.cash_player_session
         SET closed_at = clock_timestamp(), closed_reason = 'seat_vacated'
       WHERE player_id = NEW.user_id AND scope_type = 'table'
         AND scope_id = NEW.table_id AND closed_at IS NULL;
    END IF;
    RETURN NULL;
  END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_bind_diamond_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
 UPDATE public.poker_diamond_custody
   SET seat_id=NEW.id,seat_joined_at=NEW.joined_at,occupancy_id=NEW.occupancy_id,state='active'
   WHERE user_id=NEW.user_id AND target_id=NEW.table_id AND purpose='cash_seat'
     AND entry_key='seat:'||NEW.id AND state='reserved' AND balance=NEW.stack AND seat_id IS NULL;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>1 THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_seat_keeps_custody()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ids uuid[];
BEGIN
 IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.id];
 ELSE v_ids:=ARRAY[OLD.id,NEW.id]; END IF;
 IF EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
   WHERE c.seat_id=ANY(v_ids) AND c.state='active'
     AND NOT EXISTS(SELECT 1 FROM public.table_seats s
       WHERE s.id=c.seat_id AND s.joined_at=c.seat_joined_at
         AND s.occupancy_id=c.occupancy_id AND s.user_id=c.user_id
         AND s.table_id=c.target_id AND s.club_id=c.arena_id
         AND s.left_at IS NULL AND s.stack=c.balance)
 ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_elimination_has_a_place()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_position integer;
  v_tournament text;
BEGIN
  /* THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10). An eliminated
     row is a finishing place: fn_complete_tournament_entry_reprice reads a row
     without one as an unfinished reprice and refuses the event for ever, and
     the engine's elimination sweep will not run until that proof passes.

     A DEFERRED CHECK READS THE ROW AT COMMIT, NOT THE STATEMENT. NEW is the
     tuple the firing statement produced, so a settlement that writes the status
     first and the place second would be refused on a row that is about to be
     correct - which is what happened to five satellites between 07:24 and
     07:52. Re-read; if the row is gone, there is nothing to judge. */
  SELECT tp.status, tp.position INTO v_status, v_position
    FROM public.tournament_players tp
   WHERE tp.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_status = 'eliminated' AND v_position IS NULL THEN
    SELECT t.status INTO v_tournament FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_tournament IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN
      RAISE EXCEPTION 'tournament % player % was recorded eliminated with no finishing place; a bust is recorded through the knockout door, which assigns the place',
        NEW.tournament_id, NEW.user_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER ca_reporting_rake_change_del AFTER DELETE ON public.rake_records REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days();
CREATE TRIGGER ca_reporting_rake_change_upd AFTER UPDATE ON public.rake_records REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days();
CREATE TRIGGER tournament_unregistration_rake_evidence_is_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_ca_unregistration_rake_evidence_is_immutable();
CREATE TRIGGER poker_bind_diamond_seat AFTER INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_poker_bind_diamond_seat();
CREATE CONSTRAINT TRIGGER zz_close_session_when_seat_vacated AFTER UPDATE OF left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_fn_close_session_when_seat_vacated();
CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody AFTER INSERT OR DELETE OR UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_seat_keeps_custody();
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();
CREATE TRIGGER zzzz_stamp_active_seat_game_scope BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_active_seat_game_scope();
CREATE TRIGGER zzzzz_require_live_seat_parent BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_require_live_seat_parent();
CREATE TRIGGER zzzzz_seat_parent_keys_match BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION trg_seat_parent_keys_match();
CREATE TRIGGER zz_cancel_cash_seat_moves_on_table_close AFTER UPDATE OF status, seat_admission_key ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_cancel_cash_seat_moves_on_table_close();
CREATE TRIGGER zz_close_sessions_when_table_closes AFTER UPDATE OF status, is_deleted ON public.tables FOR EACH ROW EXECUTE FUNCTION trg_fn_close_sessions_when_table_closes();
CREATE TRIGGER zzzz_stamp_table_game_scope BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_game_scope();
CREATE TRIGGER zzzz_stamp_table_seat_admission BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_seat_admission();
CREATE TRIGGER zzzzz_table_parent_keys_guard BEFORE UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_admission_key IS DISTINCT FROM new.seat_admission_key)) EXECUTE FUNCTION trg_table_parent_keys_guard();
CREATE TRIGGER zzzzz_table_scope_cascade AFTER UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_game_scope IS DISTINCT FROM new.seat_game_scope)) EXECUTE FUNCTION trg_table_scope_cascade();
CREATE CONSTRAINT TRIGGER tournament_elimination_has_a_place AFTER INSERT OR UPDATE OF status, "position" ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_tournament_elimination_has_a_place();
CREATE TRIGGER trg_clear_seats_on_game_end AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_clear_seats_on_game_end();
CREATE TRIGGER trg_release_seats_on_tournament_finish AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_release_seats_on_tournament_finish();
DROP TRIGGER "ca_reporting_wallet_change" ON public."wallet_transactions";
CREATE TRIGGER ca_reporting_wallet_change AFTER DELETE OR UPDATE OF user_id, amount, type, category, table_id, related_entity_id, created_at ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION trg_ca_reporting_follows_a_changed_fact();
CREATE TRIGGER ca_reporting_wallet_change_del AFTER DELETE ON public.wallet_transactions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days();
CREATE TRIGGER ca_reporting_wallet_change_upd AFTER UPDATE ON public.wallet_transactions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days();
UPDATE public.tables SET updated_at=updated_at;
UPDATE public.table_seats SET stack=stack;
ALTER TABLE public."chip_ledger" DROP CONSTRAINT "ck_whole_cents";
ALTER TABLE public."chip_ledger" ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID;
ALTER TABLE public."rake_records" DROP CONSTRAINT "ck_whole_cents";
ALTER TABLE public."rake_records" ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR ((rake_amount = round(rake_amount, 2)) AND (bbj_contribution = round(bbj_contribution, 2))))) NOT VALID;
ALTER TABLE public."table_seats" ADD CONSTRAINT "active_seat_requires_game_scope" CHECK ((((left_at IS NULL) AND (active_game_scope IS NOT NULL) AND (user_id IS NOT NULL) AND (table_id IS NOT NULL)) OR ((left_at IS NOT NULL) AND (active_game_scope IS NULL))));
ALTER TABLE public."table_seats" ADD CONSTRAINT "active_seat_requires_open_parent" CHECK ((((left_at IS NULL) AND (active_parent_key IS NOT NULL) AND (active_parent_key <> 'closed'::text)) OR ((left_at IS NOT NULL) AND (active_parent_key IS NULL))));
ALTER TABLE public."table_seats" ADD CONSTRAINT "one_committed_seat_per_game_player" UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."tables" ADD CONSTRAINT "table_game_scope_is_derived" CHECK (((seat_game_scope IS NULL) OR (seat_game_scope =
CASE
    WHEN (cluster_id IS NULL) THEN ('table:'::text || (id)::text)
    ELSE ('cluster:'::text || (cluster_id)::text)
END)));
ALTER TABLE public."tables" ADD CONSTRAINT "table_game_scope_parent_key" UNIQUE (id, seat_game_scope);
ALTER TABLE public."tables" ADD CONSTRAINT "table_seat_admission_is_derived" CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])) OR (lifecycle = 'closed'::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN 'closed'::text
    WHEN (tournament_id IS NOT NULL) THEN ('tournament:'::text || (tournament_id)::text)
    ELSE 'cash'::text
END)));
ALTER TABLE public."tables" ADD CONSTRAINT "table_seat_admission_parent_key" UNIQUE (id, seat_admission_key);
ALTER TABLE public."tournament_satellite_awards" DROP CONSTRAINT "tournament_satellite_awards_check";
ALTER TABLE public."tournament_satellite_awards" ADD CONSTRAINT "tournament_satellite_awards_check" CHECK (((((delivery_kind = 'seat'::text) AND (registration_id IS NOT NULL) AND (ticket_id IS NULL) AND (obligation_id IS NULL) AND (obligation_kind IS NULL) AND (payout_source = 'satellite_seat'::text)) OR ((delivery_kind = 'cash'::text) AND (registration_id IS NULL) AND (ticket_id IS NULL) AND (obligation_id IS NOT NULL) AND (obligation_kind = ANY (ARRAY['seat'::text, 'place'::text])) AND (payout_source <> 'satellite_seat'::text)) OR ((delivery_kind = 'ticket'::text) AND (registration_id IS NULL) AND (ticket_id IS NOT NULL) AND (obligation_id IS NULL) AND (obligation_kind IS NULL) AND (payout_source = 'satellite_ticket'::text))) IS TRUE));
ALTER TABLE public."tournament_satellite_awards" DROP CONSTRAINT "tournament_satellite_awards_delivery_kind_check";
ALTER TABLE public."tournament_satellite_awards" ADD CONSTRAINT "tournament_satellite_awards_delivery_kind_check" CHECK ((delivery_kind = ANY (ARRAY['seat'::text, 'cash'::text, 'ticket'::text])));
ALTER TABLE public."tournament_satellite_settlements" DROP CONSTRAINT "tournament_satellite_settlements_check2";
ALTER TABLE public."tournament_satellite_settlements" ADD CONSTRAINT "tournament_satellite_settlements_check2" CHECK ((ticket_award_count = ((seat_count + cash_ticket_count) + entry_ticket_count)));
ALTER TABLE public."tournament_satellite_settlements" ADD CONSTRAINT "tournament_satellite_settlements_receipt_version_check" CHECK ((receipt_version = 2));
ALTER TABLE public."tournament_tickets" ADD CONSTRAINT "tournament_tickets_direct_satellite_award_fkey" FOREIGN KEY (source_satellite_id, source_satellite_award_place) REFERENCES tournament_satellite_awards(tournament_id, place) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."tournament_tickets" DROP CONSTRAINT "tournament_tickets_satellite_entry_contract_check";
ALTER TABLE public."tournament_tickets" ADD CONSTRAINT "tournament_tickets_satellite_entry_contract_check" CHECK (((((redemption_mode = 'wallet_chips'::text) AND (source_tournament_id IS NULL) AND (source_satellite_id IS NULL) AND (source_refund_entitlement_id IS NULL) AND (source_satellite_award_place IS NULL) AND (entry_prize IS NULL) AND (entry_bounty IS NULL) AND (entry_fee IS NULL)) OR ((redemption_mode = 'tournament_entry_only'::text) AND (issued_by = '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid) AND (source_tournament_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (((source_refund_entitlement_id IS NOT NULL) AND (source_satellite_award_place IS NULL)) OR ((source_refund_entitlement_id IS NULL) AND (source_satellite_award_place > 0) AND (source_tournament_id <> source_satellite_id))) AND (entry_prize IS NOT NULL) AND (entry_prize >= (0)::numeric) AND (entry_prize = round(entry_prize, 2)) AND (entry_bounty IS NOT NULL) AND (entry_bounty >= (0)::numeric) AND (entry_bounty = round(entry_bounty, 2)) AND (entry_fee IS NOT NULL) AND (entry_fee >= (0)::numeric) AND (entry_fee = round(entry_fee, 2)) AND (value = round(((entry_prize + entry_bounty) + entry_fee), 2)))) IS TRUE));
ALTER TABLE public."tournaments" DROP CONSTRAINT "tournaments_spin_has_no_fee";
ALTER TABLE public."tournaments" ADD CONSTRAINT "tournaments_spin_has_no_fee" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR (((lower(COALESCE(variant, ''::text)) <> 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric)))) NOT VALID;
ALTER TABLE public."tournaments" DROP CONSTRAINT "tournaments_spin_no_extra_rake";
ALTER TABLE public."tournaments" ADD CONSTRAINT "tournaments_spin_no_extra_rake" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR ((variant IS DISTINCT FROM 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))) NOT VALID;
CREATE UNIQUE INDEX table_seats_occupancy_id_unique ON public.table_seats USING btree (occupancy_id);
CREATE INDEX idx_tables_cluster_open ON public.tables USING btree (cluster_id, role, main_index, created_at) WHERE (lifecycle <> 'closed'::text);
CREATE INDEX idx_tables_cluster_closed_status_drift ON public.tables USING btree (cluster_id) WHERE ((lifecycle = 'closed'::text) AND (status <> 'closed'::text));
CREATE INDEX ix_tournament_obligations_user_created ON public.tournament_obligations USING btree (user_id, created_at DESC, id DESC) WHERE (user_id IS NOT NULL);
CREATE UNIQUE INDEX tournament_ticket_one_direct_satellite_award ON public.tournament_tickets USING btree (source_satellite_id, source_satellite_award_place) WHERE (source_satellite_award_place IS NOT NULL);
CREATE INDEX idx_tournaments_updated_at ON public.tournaments USING btree (updated_at DESC);
ALTER TABLE public."table_seats" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();
ALTER TABLE public."table_seats" ALTER COLUMN "occupancy_id" SET NOT NULL;
ALTER TABLE public."table_seats" ALTER COLUMN "active_game_scope" DROP NOT NULL;
ALTER TABLE public."table_seats" ALTER COLUMN "active_parent_key" DROP NOT NULL;
ALTER TABLE public."tables" ALTER COLUMN "observer_show_cards" SET NOT NULL;
ALTER TABLE public."tables" ALTER COLUMN "seat_game_scope" DROP NOT NULL;
ALTER TABLE public."tables" ALTER COLUMN "seat_admission_key" DROP NOT NULL;
ALTER TABLE public."tournament_satellite_settlements" ALTER COLUMN "winner_id" SET NOT NULL;
ALTER TABLE public."tournament_satellite_settlements" ALTER COLUMN "entry_ticket_count" DROP DEFAULT;
ALTER TABLE public."tournament_tickets" ALTER COLUMN "source_satellite_award_place" DROP NOT NULL;
COMMIT;