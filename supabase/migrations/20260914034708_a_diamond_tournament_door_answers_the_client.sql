-- ============================================================================
-- A DIAMOND TOURNAMENT DOOR ANSWERS THE CLIENT
-- ============================================================================
--
-- The third and last database piece of Phase 8. The first two put the money
-- where it belongs; this one makes the doors answer the way the client
-- already knows how to read, in three small in-place edits:
--
--   1. fn_poker_arena_context says whether tournaments are open, beside the
--      cash switch it already reports, so the lobby can label a Diamond event
--      "Not Open Yet" instead of offering a Register the server refuses.
--   2. The registration core answers an ordinary Diamond refusal (not enough
--      settled Diamonds, the door closed, an unsettled debt, an entry already
--      held) with {ok:false, reason} exactly as it answers a chip refusal,
--      instead of raising - a raise is what the client treats as an unknown
--      transport outcome, retries once and reports. Its success receipt also
--      names the asset and the wallet after the charge, so the client can
--      move the Diamond balance on screen without a second round trip.
--   3. The Diamond unregistration receipt carries the wallet after the refund
--      for the same reason.
--
-- The chip text of the registration core is still byte for byte what it was:
-- the migration pins the live md5 and proves the reverse substitution, as the
-- earlier two did. Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'tournaments_enabled is already on somewhere; this migration expects it closed';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 1. THE ARENA CONTEXT names the tournament switch.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_n integer;
v_old constant text := $o$    'cashGamesEnabled',v_club.asset='diamonds' AND COALESCE(
      (SELECT s.cash_games_enabled FROM public.ca_arena_settings s WHERE s.club_id=v_club.id),false));$o$;
v_new constant text := $n$    'cashGamesEnabled',v_club.asset='diamonds' AND COALESCE(
      (SELECT s.cash_games_enabled FROM public.ca_arena_settings s WHERE s.club_id=v_club.id),false),
    -- DIAMOND PHASE 8: the tournament switch, read the same way.
    'tournamentsEnabled',v_club.asset='diamonds' AND COALESCE(
      (SELECT s.tournaments_enabled FROM public.ca_arena_settings s WHERE s.club_id=v_club.id),false));$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_arena_context';
  IF md5(v_def) <> '6e086d02da060e50d118e0a08cd49452' THEN
    RAISE EXCEPTION 'fn_poker_arena_context is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the arena-context clause is not unique (% matches)', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_arena_context';
  IF md5(replace(v_def, v_new, v_old)) <> '6e086d02da060e50d118e0a08cd49452' THEN
    RAISE EXCEPTION 'fn_poker_arena_context is NOT the pinned text plus the one documented insertion';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 2. THE REGISTRATION CORE answers a Diamond refusal with a reason, and its
--    receipt names the asset and the wallet after the charge. In place, on
--    the text the first Phase 8 migration left (its md5 pinned here).
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_new text; v_n integer;
v_old1 constant text := $o$    v_player_id := gen_random_uuid();
    v_dia := public.fn_poker_diamond_tournament_charge(
      v_uid, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake,
      v_player_id, 'poker-tournament-entry:' || p_tournament_id::text || ':' || v_uid::text || ':' || v_player_id::text);$o$;
v_new1 constant text := $n$    v_player_id := gen_random_uuid();
    BEGIN
      v_dia := public.fn_poker_diamond_tournament_charge(
        v_uid, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake,
        v_player_id, 'poker-tournament-entry:' || p_tournament_id::text || ':' || v_uid::text || ':' || v_player_id::text);
    EXCEPTION WHEN OTHERS THEN
      -- DIAMOND PHASE 8: an ordinary refusal is answered the way the chip core
      -- answers one, with a reason the client can say; anything else is raised.
      IF SQLERRM LIKE '%insufficient_settled_diamonds%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_diamonds');
      ELSIF SQLERRM LIKE '%diamond_tournaments_not_open%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
      ELSIF SQLERRM LIKE '%diamond_debt_requires_settlement%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_debt_requires_settlement');
      ELSIF SQLERRM LIKE '%diamond_tournament_entry_already_held%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
      RAISE;
    END;$n$;
v_old2 constant text := $o$    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23$o$;
v_new2 constant text := $n$    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    -- DIAMOND PHASE 8: the receipt names its asset and, for a Diamond entry,
    -- the wallet after the charge, so the client can move the balance it shows.
    'asset', CASE WHEN v_dia IS NOT NULL THEN 'diamonds' ELSE 'chips' END,
    'diamonds_after', CASE WHEN v_dia IS NOT NULL THEN (SELECT p.diamonds FROM public.profiles p WHERE p.id = v_uid) END,
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_register_for_tournament_before_atomic_capacity_20260907';
  IF md5(v_def) <> 'b61a71ab40f7c1f5da7913f7cd4e753c' THEN
    RAISE EXCEPTION 'the registration core is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[v_old1, v_old2] LOOP
    v_n := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
    IF v_n <> 1 THEN RAISE EXCEPTION 'a registration-core clause is not unique (% matches): %', v_n, left(v_new, 60); END IF;
  END LOOP;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_register_for_tournament_before_atomic_capacity_20260907';
  IF md5(replace(replace(v_def, v_new1, v_old1), v_new2, v_old2)) <> 'b61a71ab40f7c1f5da7913f7cd4e753c' THEN
    RAISE EXCEPTION 'the registration core is NOT the pinned text plus the two documented insertions';
  END IF;
  -- And the chip text underneath is still exactly the text the first Phase 8
  -- migration pinned: undoing its four insertions as well gives it back.
END $do$;

-- ---------------------------------------------------------------------------
-- 3. THE DIAMOND UNREGISTRATION RECEIPT carries the wallet after the refund.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_n integer;
v_old constant text := $o$    'registration_id',v_reg.id,'custody_id',v_refund->>'custody_id','obligation_id',v_refund->>'obligation_id');$o$;
v_new constant text := $n$    'registration_id',v_reg.id,'custody_id',v_refund->>'custody_id','obligation_id',v_refund->>'obligation_id',
    'asset','diamonds','diamonds_after',(SELECT p.diamonds FROM public.profiles p WHERE p.id=p_user_id));$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_diamond_tournament_unregister';
  IF md5(v_def) <> '3db98d05ceb29eb7e843b573d3b1d65a' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_unregister is not the text this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'the unregistration receipt clause is not unique (% matches)', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_poker_diamond_tournament_unregister';
  IF md5(replace(v_def, v_new, v_old)) <> '3db98d05ceb29eb7e843b573d3b1d65a' THEN
    RAISE EXCEPTION 'fn_poker_diamond_tournament_unregister is NOT the pinned text plus the one documented insertion';
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 4. THE ESTATE IS AS IT WAS.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  FOR r IN SELECT p.proname, pg_get_functiondef(p.oid) AS def, p.oid FROM pg_proc p
            WHERE p.pronamespace='public'::regnamespace AND p.proname IN (
              'fn_poker_arena_context','fn_register_for_tournament_before_atomic_capacity_20260907','fn_poker_diamond_tournament_unregister')
  LOOP
    IF r.proname='fn_poker_arena_context' AND (
         position($c$'tournamentsEnabled'$c$ in r.def)=0 OR position($c$'cashGamesEnabled'$c$ in r.def)=0) THEN
      RAISE EXCEPTION 'fn_poker_arena_context lost a switch';
    END IF;
    IF r.proname='fn_register_for_tournament_before_atomic_capacity_20260907' AND (
         position('public.atomic_deduct_wallet_and_log(' in r.def)=0
      OR position('public.fn_poker_diamond_tournament_charge(' in r.def)=0
      OR position($c$'reason', 'insufficient_diamonds'$c$ in r.def)=0) THEN
      RAISE EXCEPTION 'the registration core lost its chip debit, its Diamond charge or its Diamond reasons';
    END IF;
    IF r.proname='fn_poker_diamond_tournament_unregister' AND (
         position($c$'diamonds_after'$c$ in r.def)=0
      OR has_function_privilege('authenticated', r.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'the Diamond unregistration receipt is wrong or the function became a client door';
    END IF;
  END LOOP;
  RAISE NOTICE 'a Diamond tournament door answers the client: three receipts, nothing opened';
END $do$;
