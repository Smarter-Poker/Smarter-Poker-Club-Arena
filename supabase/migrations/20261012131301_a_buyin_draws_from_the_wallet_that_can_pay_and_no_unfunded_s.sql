-- 20261012131301_a_buyin_draws_from_the_wallet_that_can_pay_and_no_unfunded_s.sql
--
-- A BUY-IN DRAWS FROM THE WALLET THAT CAN PAY, AND NO UNFUNDED SEAT IS HELD
-- (Dan, 2026-10-12, items 4 and 5 of that day's list).
--
-- WHAT WAS WRONG, READ FROM ROWS
--
-- Dan, playing as kingfish (owner of Club JAQK, SHARK CLUB, Midway Union and
-- Deep Stack Society), could not buy into Midway Union cash games or
-- tournaments "even with chips in account". On 2026-10-11 at 21:48 UTC
-- fn_cash_game_join held him a chair at NLH 2/5 Classic Feeder (table_waitlist
-- row c4970393, position 0, expired unused). The buy-in sheet showed BALANCE
-- 4.50 against a 200 minimum; the Evening Mystery Bounty (PLO5) sign-up card
-- showed 0 Chips against a 15 entry. His SHARK CLUB wallet held about 2,650.
--
-- 1. A union game charges ONE member club: the club the player came in
--    through (when it is a member club), else their OLDEST membership.
--    For kingfish that was Club JAQK (4.50). fn_seat_club_for_user and
--    fn_tournament_club_for_user never looked at whether that wallet could
--    pay, so the buy-in refused while another of his clubs in the same union
--    could have covered it many times over.
-- 2. The Sign Up card read the union's house-club wallet (Midway Union,
--    0.00) because the client passed the tournament's club id; the entry is
--    charged elsewhere. (Client half of this fix: it now asks by tournament.)
-- 3. fn_cash_game_join held a chair for sixty seconds before anything asked
--    whether the player could pay for it, and fn_offer_open_seat offered a
--    waitlist chair the same way. The chair was kept from everyone behind
--    them, and the buy-in refused a minute later.
--
-- WHAT THIS CHANGES
--
-- Cash (atomic_table_buyin): when the default wallet cannot cover THIS
--   amount, the player's member club in the union that can (the richest; ties
--   to the oldest membership) is passed to the gate as the preferred club.
--   fn_seat_club_for_user already honours a preferred member club, so the
--   debit, the seat stamp and the later cash-out all name that club. Nothing
--   changes when the default wallet can pay, at a standalone club table, at a
--   Diamond table, or for a player already seated in the union (one club at a
--   time, Dan 2026-08-21).
-- Display (fn_player_spendable_balance): the buy-in sheet reads the wallet
--   the buy-in will spend (the same rule at the table's minimum), and the
--   Sign Up card reads the wallet the entry will spend.
-- Tournaments (fn_register_for_tournament, fn_register_horse_for_tournament,
--   fn_tournament_club_for_user): when the default member club cannot cover
--   the entry, the door declares the club that can for this transaction only
--   (app.ca_entry_paying_club, keyed on tournament and player). The debit,
--   the wallet log and the roster stamp resolve through
--   fn_tournament_club_for_user inside that transaction, so all three name
--   the same club. Once on the roster, a player's rebuys, re-entries,
--   add-ons, refunds and prizes resolve to the club stamped on their entry -
--   the wallet the buy-in actually left. A person and a horse go through the
--   identical rule (CLAUDE.md 10.5).
-- Holds (fn_cash_game_join, fn_offer_open_seat): no chair is held for a
--   player none of whose spendable wallets covers the table's minimum (rejoin
--   floor included). The join door refuses with INSUFFICIENT_CHIPS:<need>
--   before writing anything; the waitlist offer passes such a player over for
--   that seat and keeps their place, as it already does for a capped player.
--
-- WHAT DOES NOT CHANGE
--
-- No balance, ledger row, seat or entry is written by this migration. No
-- refusal is removed: the conditional debits remain the only authority, and a
-- player with no wallet that can pay is refused exactly as before. The union
-- house club is never chosen by the new rule (fn_seat_club_for_user only
-- honours member clubs). Every function below was copied from production and
-- proven byte-identical (md5 of pg_get_functiondef) before it was edited; the
-- guard refuses to install over anything else.
--
-- Wrap ALL DDL for one change in ONE transaction (production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)', '2f8b47a714db3f297aff3f7a2e814c44', 'fn_ca_cash_paying_club'),
      ('public.fn_player_spendable_balance(uuid,uuid,uuid,uuid)', '2eef81f95feb167a6d687dbb538f9bc2', 'fn_ca_cash_paying_club'),
      ('public.fn_tournament_club_for_user(uuid,uuid,uuid)', '344609ab3cf21094b9e85167bfb6655e', 'app.ca_entry_paying_club'),
      ('public.fn_register_for_tournament(uuid,boolean)', '0f3b104a1bf9431d70053c656fedc081', 'fn_ca_entry_paying_club'),
      ('public.fn_register_horse_for_tournament(uuid,uuid,boolean)', '026901ecf8d4c4909cea685dc51c69ee', 'fn_ca_entry_paying_club'),
      ('public.fn_cash_game_join(uuid)', 'e5c357a88eb80951528cfd51c86ae7e9', 'fn_ca_cash_wallet_covers'),
      ('public.fn_offer_open_seat(uuid,interval,interval)', '153c27efa0ce07bf7208b9561c281796', 'fn_ca_cash_wallet_covers')
    ) AS v(sig, pre, marker)
  LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.pre
       AND position(r.marker IN pg_get_functiondef(r.sig::regprocedure)) = 0 THEN
      RAISE EXCEPTION '% changed since this migration was written; re-derive it from the live definition', r.sig
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$preimage$;

-- ─── 1. The member club that can cover an amount ──────────────────────────
-- Among the player's ACTIVE memberships in clubs of this union, the richest
-- wallet that covers the amount (ties: oldest membership, then id), or NULL
-- when none does. Only union member clubs (union_clubs), never the union's
-- house club: fn_seat_club_for_user honours a preferred club only from that
-- list, so a house-club answer here would be silently ignored at the debit.
CREATE OR REPLACE FUNCTION public.fn_ca_union_wallet_that_can_pay(
  p_user_id uuid, p_union_id uuid, p_amount numeric)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT m.club_id
    FROM public.club_members m
   WHERE m.user_id = p_user_id
     AND m.status IN ('active', 'approved')
     AND p_union_id IS NOT NULL
     AND p_amount IS NOT NULL AND p_amount > 0
     AND COALESCE(m.chip_balance, 0) >= p_amount
     AND EXISTS (SELECT 1 FROM public.union_clubs uc
                  WHERE uc.club_id = m.club_id AND uc.union_id = p_union_id)
   ORDER BY m.chip_balance DESC, m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1
$function$;

-- ─── 2. Cash: the club to charge instead of the default, or NULL ──────────
-- NULL means "charge the default wallet as before": a standalone club table,
-- a Diamond or tournament table, a player already seated in this union (one
-- club at a time, Dan 2026-08-21), a default wallet that already covers the
-- amount, or no member club that does.
CREATE OR REPLACE FUNCTION public.fn_ca_cash_paying_club(
  p_user_id uuid, p_table_id uuid, p_preferred_club uuid, p_amount numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid;
  v_default uuid;
  v_balance numeric;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT t.union_id INTO v_union
    FROM public.tables t
    JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id
     AND t.tournament_id IS NULL
     AND c.asset IS DISTINCT FROM 'diamonds';
  IF v_union IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.table_seats ts
      JOIN public.tables t2 ON t2.id = ts.table_id
     WHERE ts.user_id = p_user_id AND ts.left_at IS NULL AND ts.club_id IS NOT NULL
       AND t2.union_id = v_union
       AND lower(coalesce(t2.status, '')) NOT IN ('closed','completed','cancelled','finished')
  ) THEN
    RETURN NULL;
  END IF;

  v_default := public.fn_seat_club_for_user(p_user_id, p_table_id, p_preferred_club);
  IF v_default IS NOT NULL THEN
    SELECT m.chip_balance INTO v_balance
      FROM public.club_members m
     WHERE m.user_id = p_user_id AND m.club_id = v_default
       AND m.status IN ('active', 'approved');
    IF COALESCE(v_balance, 0) >= p_amount THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN public.fn_ca_union_wallet_that_can_pay(p_user_id, v_union, p_amount);
END
$function$;

-- ─── 3. Cash: the least this player may buy in for at this table ──────────
-- The table minimum, raised by the player's chip-continuity rejoin floor and
-- capped at the table maximum: the same arithmetic the buy-in gate enforces.
CREATE OR REPLACE FUNCTION public.fn_ca_cash_entry_need(p_user_id uuid, p_table_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_min numeric;
  v_max numeric;
  v_tournament uuid;
  v_need numeric;
BEGIN
  SELECT t.min_buy_in, t.max_buy_in, t.tournament_id
    INTO v_min, v_max, v_tournament
    FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_need := COALESCE(v_min, 0);
  IF v_tournament IS NULL AND p_user_id IS NOT NULL THEN
    v_need := GREATEST(v_need, COALESCE(public.fn_cash_rejoin_floor(p_user_id, p_table_id), 0));
  END IF;
  IF v_max IS NOT NULL AND v_max > 0 THEN
    v_need := LEAST(v_need, v_max);
  END IF;
  RETURN GREATEST(v_need, 0);
END
$function$;

-- ─── 4. Cash: can any wallet the buy-in could spend cover the amount ──────
-- A Diamond table is answered by its own custody door, never here.
CREATE OR REPLACE FUNCTION public.fn_ca_cash_wallet_covers(
  p_user_id uuid, p_table_id uuid, p_preferred_club uuid, p_amount numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid;
  v_balance numeric;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
              WHERE t.id = p_table_id AND c.asset = 'diamonds') THEN
    RETURN true;
  END IF;

  v_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_preferred_club);
  IF v_club IS NOT NULL THEN
    SELECT m.chip_balance INTO v_balance
      FROM public.club_members m
     WHERE m.user_id = p_user_id AND m.club_id = v_club
       AND m.status IN ('active', 'approved');
    IF COALESCE(v_balance, 0) >= p_amount THEN
      RETURN true;
    END IF;
  END IF;

  RETURN public.fn_ca_cash_paying_club(p_user_id, p_table_id, p_preferred_club, p_amount) IS NOT NULL;
END
$function$;

-- ─── 5. Tournament: the club to charge instead of the default, or NULL ────
-- NULL means "charge the default wallet as before": a club (non-union) event,
-- a Diamond event, a player already on the roster, a free entry, a default
-- wallet that covers the entry, or no member club that does.
CREATE OR REPLACE FUNCTION public.fn_ca_entry_paying_club(p_user_id uuid, p_tournament_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record;
  v_charge numeric;
  v_default uuid;
  v_balance numeric;
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.union_id, t.buy_in_amount, t.buy_in_fee, t.bounty_amount,
         (COALESCE(t.is_bounty, false) OR COALESCE(t.is_pko, false)
          OR COALESCE(t.is_mystery_bounty, false)) AS is_bounty
    INTO v_t
    FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF NOT FOUND OR v_t.union_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF public.fn_ca_tournament_unit_cents(p_tournament_id) = 100 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id AND tp.user_id = p_user_id) THEN
    RETURN NULL;
  END IF;

  SELECT s.charge INTO v_charge
    FROM public.fn_tournament_entry_split(
      v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_t.is_bounty) s;
  IF v_charge IS NULL OR v_charge <= 0 THEN
    RETURN NULL;
  END IF;

  v_default := public.fn_tournament_club_for_user(p_user_id, p_tournament_id, NULL);
  IF v_default IS NOT NULL THEN
    SELECT m.chip_balance INTO v_balance
      FROM public.club_members m
     WHERE m.user_id = p_user_id AND m.club_id = v_default
       AND m.status IN ('active', 'approved');
    IF COALESCE(v_balance, 0) >= v_charge THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN public.fn_ca_union_wallet_that_can_pay(p_user_id, v_t.union_id, v_charge);
END
$function$;

-- Internal helpers: called only from SECURITY DEFINER doors, which run as the
-- owner. No browser role may ask which of a player's clubs holds the most.
REVOKE ALL ON FUNCTION public.fn_ca_union_wallet_that_can_pay(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_cash_paying_club(uuid, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_cash_entry_need(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_cash_wallet_covers(uuid, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_entry_paying_club(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_union_wallet_that_can_pay(uuid, uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_paying_club(uuid, uuid, uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_entry_need(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_wallet_covers(uuid, uuid, uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_entry_paying_club(uuid, uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_t_club uuid; v_club uuid;
  v_is_horse boolean := false; v_n int; v_idx int;
  v_paying text;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_t_club
    FROM tournaments t WHERE t.id = p_tournament_id;

  IF v_union IS NULL THEN
    RETURN v_t_club;                       -- standalone club tournament
  END IF;

  /* THE WALLET THAT CAN PAY IS THE WALLET THAT PAYS (2026-10-12). A player in
     several clubs of one union was charged by their OLDEST membership even
     when it held 4.50 and another of their clubs held 2,653.74, so every
     union event refused them "Insufficient Balance" with chips in the
     account. The registration doors (fn_register_for_tournament and
     fn_register_horse_for_tournament - the same door for a person and a
     horse, CLAUDE.md 10.5) now ask fn_ca_entry_paying_club for the member
     club that can cover the entry when the default one cannot, and declare it
     for THIS transaction only. The debit, the wallet log and the entry stamp
     all resolve through here inside that one transaction, so they name the
     same wallet. Keyed on tournament AND player: another player resolved in
     the same transaction is never steered by it. */
  IF p_preferred_club IS NULL THEN
    v_paying := NULLIF(current_setting('app.ca_entry_paying_club', true), '');
    IF v_paying IS NOT NULL
       AND split_part(v_paying, ':', 1) = p_tournament_id::text
       AND split_part(v_paying, ':', 2) = p_user_id::text THEN
      RETURN split_part(v_paying, ':', 3)::uuid;
    END IF;
  END IF;

  /* THE HOST CLUB IS IN ITS OWN UNION (2026-09-10). A tournament hosted BY a
     union has club_id = union_id, and that house club is never a row in
     union_clubs. The membership test below joined union_clubs, so the
     tournament's own club could never be the preferred club - a satellite
     winner who IS a member of the host club was resolved to some other club
     and the ticket award was refused for a club mismatch. Friday Night
     Feature Satellite Heads-Up sat RUNNING for 16 hours on that refusal. The
     host club counts as in the union without needing the row. */
  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved')
                   AND (m.club_id = v_t_club
                        OR EXISTS (SELECT 1 FROM union_clubs uc
                                    WHERE uc.club_id = m.club_id AND uc.union_id = v_union)))
  THEN
    RETURN p_preferred_club;
  END IF;

  /* AN ENTRY'S LATER MONEY USES THE WALLET THE ENTRY CAME FROM (2026-10-12).
     Once a player is on the roster, the club stamped on their entry is the
     wallet the buy-in left, so a rebuy, re-entry, add-on, refund or prize
     resolves to it rather than re-deriving "oldest membership". Before today
     the two only agreed because both were the oldest membership; an entry
     paid from the wallet that could pay (above) would otherwise have been
     refunded into a different club. */
  SELECT tp.club_id INTO v_club
    FROM tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.user_id = p_user_id
     AND tp.club_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                  WHERE m.user_id = p_user_id AND m.club_id = tp.club_id
                    AND m.status IN ('active','approved'))
   LIMIT 1;
  IF v_club IS NOT NULL THEN
    RETURN v_club;
  END IF;

  SELECT COALESCE(p.is_horse, false) INTO v_is_horse FROM profiles p WHERE p.id = p_user_id;

  IF v_is_horse THEN
    -- Same stable home club a horse uses for cash play, so a horse's tournament
    -- and cash activity always belong to the same club.
    SELECT count(*) INTO v_n
      FROM club_members m
      JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
     WHERE m.user_id = p_user_id AND m.status IN ('active','approved');
    IF v_n > 1 THEN
      v_idx := (abs(hashtextextended(p_user_id::text, 0)) % v_n)::int;
      SELECT m.club_id INTO v_club
        FROM club_members m
        JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
       WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
       ORDER BY m.club_id OFFSET v_idx LIMIT 1;
      IF v_club IS NOT NULL THEN RETURN v_club; END IF;
    END IF;
  END IF;

  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid, p_seat_first_internal boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
  v_paying uuid;
  v_result jsonb;
BEGIN
  IF public.fn_caller_session_is_live() IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE='28000';
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,auth.uid());
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  /* THE WALLET THAT CAN PAY (2026-10-12). See fn_tournament_club_for_user:
     when the member club this entry would default to cannot cover it and
     another of the player's clubs in the union can, that club pays. Declared
     for this transaction only and cleared after the core returns. */
  v_paying := public.fn_ca_entry_paying_club(auth.uid(), p_tournament_id);
  IF v_paying IS NOT NULL THEN
    PERFORM set_config('app.ca_entry_paying_club',
      p_tournament_id::text || ':' || auth.uid()::text || ':' || v_paying::text, true);
  END IF;
  v_result := public.fn_register_for_tournament_before_terminal_seat_gate(
    p_tournament_id,p_seat_first_internal);
  PERFORM set_config('app.ca_entry_paying_club', '', true);
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
  v_paying uuid;
  v_result jsonb;
BEGIN
  -- 20261005224736 / A18 (horse_entry_funding, recorded 2026-10-05) and
  -- CLAUDE.md 10.5 (HORSES ARE PLAYERS - NO EXCEPTIONS). The owner's answer
  -- reads: "a horse funds its Diamond entry from its own balance, through the
  -- ordinary Diamond registration door a person uses." So this is no longer a
  -- blanket refusal resting on a Phase-9 assumption; it is that answer, READ
  -- AT CALL TIME. Changing the answer is one INSERT into ca_diamond_economics
  -- and no code change - 'own_balance' is never hard-coded as the decision.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    DECLARE
      v_horse_entry_funding text;
    BEGIN
      BEGIN
        v_horse_entry_funding :=
          public.fn_ca_diamond_economic_text('horse_entry_funding','all');
      EXCEPTION WHEN SQLSTATE 'P0D01' THEN
        -- No answer recorded. Refuse by name below rather than guess which
        -- funding the owner meant.
        v_horse_entry_funding := NULL;
      END;
      IF v_horse_entry_funding = 'funding_account' THEN
        -- House money, and there is no funding path for it yet. Refused by
        -- name, and the reason names the setting that produced the refusal.
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_funding_account_not_open',
          'horse_entry_funding',v_horse_entry_funding);
      ELSIF v_horse_entry_funding IS DISTINCT FROM 'own_balance' THEN
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_entry_funding_unrecognised',
          'horse_entry_funding',v_horse_entry_funding);
      END IF;
      -- 'own_balance': fall through. The horse takes the same seat-acquisition
      -- lock and the same registration chain a person takes, and pays from its
      -- own profiles.diamonds through the same Diamond door (10.5).
    END;
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  /* THE WALLET THAT CAN PAY (2026-10-12), exactly as the person's door
     (fn_register_for_tournament) does it - CLAUDE.md 10.5, a horse is
     charged by the same rule. Only when this entry is paid from a wallet. */
  IF COALESCE(p_allow_wallet_charge, false) THEN
    v_paying := public.fn_ca_entry_paying_club(p_user_id, p_tournament_id);
    IF v_paying IS NOT NULL THEN
      PERFORM set_config('app.ca_entry_paying_club',
        p_tournament_id::text || ':' || p_user_id::text || ':' || v_paying::text, true);
    END IF;
  END IF;
  v_result := public.fn_register_horse_for_tournament_before_terminal_gate(
    p_tournament_id,p_user_id,p_allow_wallet_charge);
  PERFORM set_config('app.ca_entry_paying_club', '', true);
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_player_spendable_balance(p_user_id uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid := NULL;
  v_club_name text := NULL;
  v_balance numeric := 0;
  v_source text := 'club_chips';
  v_paying uuid := NULL;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( p_user_id IS DISTINCT FROM auth.uid() AND NOT EXISTS (SELECT 1 FROM club_members cm                   WHERE cm.user_id = p_user_id                     AND cm.agent_id = auth.uid()) AND NOT EXISTS (SELECT 1 FROM club_members cm2                   JOIN union_clubs uc ON uc.club_id = cm2.club_id                   WHERE cm2.user_id = p_user_id                     AND public.fn_is_union_overseer(uc.union_id, auth.uid())))) THEN RAISE EXCEPTION 'not_authorised'; END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('balance', 0, 'source', 'none', 'club_id', NULL, 'club_name', NULL);
  END IF;

  IF p_table_id IS NOT NULL THEN
    -- Seated or sitting down: the seat's own club is the wallet that will be
    -- debited by a rebuy or add-on.
    SELECT ts.club_id INTO v_club
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
     LIMIT 1;
    IF v_club IS NULL THEN
      v_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
      -- THE SHEET SHOWS THE WALLET THE BUY-IN WILL SPEND (2026-10-12). When
      -- the default member club cannot cover this table's minimum and another
      -- of the player's clubs in the union can, atomic_table_buyin spends that
      -- one (fn_ca_cash_paying_club), so the balance shown is that one too.
      v_paying := public.fn_ca_cash_paying_club(
        p_user_id, p_table_id, p_club_id,
        public.fn_ca_cash_entry_need(p_user_id, p_table_id));
      IF v_paying IS NOT NULL THEN
        v_club := v_paying;
      END IF;
    END IF;
  ELSIF p_tournament_id IS NOT NULL THEN
    -- THE DISPLAY READS THE DEBIT'S RESOLVER (2026-09-13). A tournament entry
    -- is stamped (fn_stamp_entry_club) and charged (atomic_deduct_wallet_and_log
    -- from fn_register_for_tournament, which declares no app.ledger_club_id) by
    -- fn_tournament_club_for_user(user, tournament, NULL): the tournament's own
    -- club for a club event, and for a union-hosted event the player's OLDEST
    -- member club in the union. The preferred club is NULL here for the same
    -- reason it is NULL there - the registration path passes none - so the
    -- wallet this returns is the wallet the entry leaves. Passing p_club_id
    -- (tournaments.club_id, the union's house club) instead resolved to the
    -- house-club wallet, which is not the one charged. Verified against Dan's
    -- own Lunch Rush entry: stamped and debited Club JAQK, shown 'Midway Union'.
    --
    -- 2026-10-12: the registration doors now pay from the member club that
    -- can cover the entry when the default one cannot (fn_ca_entry_paying_club),
    -- so the Sign Up card reads that wallet first.
    v_club := COALESCE(
      public.fn_ca_entry_paying_club(p_user_id, p_tournament_id),
      public.fn_tournament_club_for_user(p_user_id, p_tournament_id, NULL));
  ELSIF p_club_id IS NOT NULL THEN
    SELECT m.club_id INTO v_club
      FROM club_members m
     WHERE m.user_id = p_user_id AND m.club_id = p_club_id
     LIMIT 1;
  END IF;

  IF v_club IS NULL THEN
    v_club := public.fn_player_home_club(p_user_id, p_club_hint => NULL);
  END IF;

  IF v_club IS NOT NULL THEN
    SELECT COALESCE(chip_balance, 0) INTO v_balance
      FROM club_members WHERE user_id = p_user_id AND club_id = v_club;
    SELECT c.name INTO v_club_name FROM clubs c WHERE c.id = v_club;
  ELSE
    -- No club anywhere: a pure smarter.poker user, whose only wallet is global.
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM wallets WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    v_source := 'smarter_poker_wallet';
  END IF;

  RETURN jsonb_build_object(
    'balance', COALESCE(v_balance, 0),
    'source', v_source,
    'club_id', v_club,
    'club_name', v_club_name,
    'club_scoped', true
  );
END $function$
;

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_replay jsonb;
  v_paying uuid;
BEGIN
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Chips Move In Hundredths At Most' USING ERRCODE = '22003';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Cannot buy in for another user' USING ERRCODE = '42501';
  END IF;

  v_request := jsonb_build_object(
    'door', 'atomic_table_buyin',
    'user_id', p_user_id,
    'table_id', p_table_id,
    'seat_number', p_seat_number,
    'amount', p_amount,
    'auto_rebuy', p_auto_rebuy,
    'club_id', p_club_id
  );
  v_replay := public.fn_claim_entry_purchase_receipt(
    'cash_transaction', p_idempotency_key::text, v_request
  );
  IF NOT COALESCE((v_replay->>'claimed')::boolean, false) THEN
    RETURN;
  END IF;
  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transaction_idempotency_keys k
     WHERE k.key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical cash key does not prove its table and seat'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: scheduled maintenance has closed cash buy-ins; no chips moved'
      USING ERRCODE = '55006', HINT = 'Retry after the maintenance break has ended.';
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
            WHERE t.id=p_table_id AND c.asset='diamonds') THEN
    PERFORM public.fn_poker_diamond_buyin(p_user_id,p_table_id,p_seat_number,
      p_amount,p_auto_rebuy,p_club_id,p_idempotency_key);
  ELSE
    /* THE WALLET THAT CAN PAY IS THE WALLET THAT PAYS (2026-10-12). At a
       union table the buy-in charged the club the player entered through, or
       their oldest membership, even when that wallet could not cover it and
       another of their clubs in the same union could. Dan was refused at
       every Midway Union game with 4.50 in Club JAQK and 2,653.74 in SHARK
       CLUB. When the default wallet cannot cover THIS amount, the member club
       that can is named instead; the gate below still resolves, debits and
       stamps through fn_seat_club_for_user, which honours it. A player already
       seated in the union keeps the club they sit for (one club at a time),
       and nothing changes when the default wallet can pay. */
    v_paying := public.fn_ca_cash_paying_club(p_user_id, p_table_id, p_club_id, p_amount);
    PERFORM public.atomic_table_buyin_before_maintenance_announcement_gate(
    p_user_id, p_table_id, p_seat_number, p_amount, p_auto_rebuy,
    COALESCE(v_paying, p_club_id), p_idempotency_key
  );
  END IF;
  PERFORM public.fn_record_entry_purchase_receipt(
    'cash_transaction',
    p_idempotency_key::text,
    v_request,
    jsonb_build_object('completed', true)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_game_join(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  g record; s record; t record; h record;
  v_position integer; v_count integer;
  v_hold_ttl CONSTANT interval := interval '60 seconds';
  v_hold_until timestamptz;
  v_probe_table uuid;
  v_need numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in to join a game' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF NOT g.enabled THEN
    RAISE EXCEPTION 'GAME_CLOSED: this game is not taking players' USING ERRCODE = 'check_violation';
  END IF;
  -- Booted for low VPIP: no seat in this game until the bar lifts (Dan 2026-09-05).
  IF public.fn_cash_game_barred_seconds(g.id, v_uid) IS NOT NULL THEN
    RAISE EXCEPTION 'GAME_BARRED:%', public.fn_cash_game_barred_seconds(g.id, v_uid) USING ERRCODE = 'check_violation';
  END IF;

  -- Already in the game: say where.
  SELECT ts.table_id, ts.seat_number, tb.name, tb.role, tb.main_index
    INTO s
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
   LIMIT 1;
  IF FOUND THEN
    UPDATE public.cash_game_waitlist SET status = 'seated', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seated', 'table_id', s.table_id,
                              'seat_number', s.seat_number, 'table_name', s.name,
                              'role', s.role, 'main_index', s.main_index);
  END IF;

  -- NO CHAIR IS HELD FOR A PLAYER WHO CANNOT PAY FOR IT (Dan 2026-10-12: "A
  -- player should not be able to hold a seat if they don't have sufficient
  -- chips. That should be checked before the seat is reserved."). The door
  -- used to hold a chair for sixty seconds first and let the buy-in refuse
  -- afterwards, which kept the chair from everyone behind them for nothing.
  -- Any wallet the buy-in could spend counts (fn_ca_cash_wallet_covers), and
  -- the figure is the game's own minimum for this player, rejoin floor
  -- included. Nothing has been written yet, so the refusal leaves no hold and
  -- no place in line.
  SELECT tb.id INTO v_probe_table
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.lifecycle <> 'closed'
   ORDER BY (tb.lifecycle IN ('live', 'opening')) DESC, tb.created_at ASC
   LIMIT 1;
  IF v_probe_table IS NOT NULL THEN
    v_need := public.fn_ca_cash_entry_need(v_uid, v_probe_table);
    IF NOT public.fn_ca_cash_wallet_covers(v_uid, v_probe_table, NULL, v_need) THEN
      RAISE EXCEPTION 'INSUFFICIENT_CHIPS:%', v_need
        USING ERRCODE = 'check_violation',
              HINT = 'Add chips through the cashier, then join the game.';
    END IF;
  END IF;

  -- THE DOOR HOLDS THE CHAIR IT HANDS OUT (2026-09-10). A 'seat' answer used
  -- to hold nothing, so two players told about the same last chair both got
  -- it and the second was refused at the buy-in door. The chair is held now
  -- with the same row the open-seat offer writes (notified, 60 s), which the
  -- buy-in gate, the open-seat count and the census already honour.
  --
  -- ASKING TWICE IS ONE HOLD. A caller already holding a live chair in this
  -- game is told the same table again and the hold is refreshed. (Their own
  -- hold is subtracted by fn_cash_game_open_seats, so without this a second
  -- click would move them to another table while the first hold stood.)
  SELECT w.id, w.table_id, tb.name, tb.role, tb.main_index
    INTO h
    FROM public.table_waitlist w JOIN public.tables tb ON tb.id = w.table_id
   WHERE w.user_id = v_uid AND w.status = 'notified' AND w.hold_expires_at > now()
     AND tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle IN ('live', 'opening')
   ORDER BY w.hold_expires_at DESC LIMIT 1;
  IF FOUND THEN
    v_hold_until := now() + v_hold_ttl;
    UPDATE public.table_waitlist SET hold_expires_at = v_hold_until WHERE id = h.id;
    -- ONE LIVE HOLD PER PLAYER PER GAME, on this branch too: any other hold
    -- of theirs in this game lapses now.
    UPDATE public.table_waitlist w SET status = 'expired'
      FROM public.tables tb
     WHERE tb.id = w.table_id AND tb.cluster_id = g.id AND w.id <> h.id
       AND w.user_id = v_uid AND w.status = 'notified';
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', h.table_id, 'table_name', h.name,
                              'role', h.role, 'main_index', h.main_index,
                              -- the chairs open TO THIS CALLER: the one they hold counts
                              'open_seats', public.fn_cash_game_open_seats(h.table_id) + 1,
                              'hold_expires_at', v_hold_until);
  END IF;

  -- The shortest live Main with an unreserved open chair, then the feeder
  -- (opening or live). Never a breaking or closed table. Each candidate is
  -- LOCKED on the key the buy-in gate takes for that table and re-read under
  -- the lock, so two callers in the same instant cannot both be handed the
  -- last chair: the second sees the first's hold and moves to the next
  -- candidate, or to the waitlist.
  FOR t IN
    SELECT tb.id, tb.name, tb.role, tb.main_index,
           (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL) AS seated
      FROM public.tables tb
     WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle IN ('live', 'opening')
       AND public.fn_cash_game_open_seats(tb.id) > 0
     ORDER BY (tb.role = 'feeder') ASC, seated ASC, tb.main_index ASC NULLS LAST, tb.created_at ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || t.id::text, 0));
    CONTINUE WHEN public.fn_cash_game_open_seats(t.id) <= 0;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = t.id
                                 AND tb.status IN ('waiting', 'running', 'active')
                                 AND tb.lifecycle IN ('live', 'opening'));
    v_hold_until := now() + v_hold_ttl;
    -- ONE LIVE HOLD PER PLAYER PER GAME: a hold of theirs on any other table
    -- of this game lapses now.
    UPDATE public.table_waitlist w SET status = 'expired'
      FROM public.tables tb
     WHERE tb.id = w.table_id AND tb.cluster_id = g.id AND w.table_id <> t.id
       AND w.user_id = v_uid AND w.status = 'notified';
    -- The hold: a live row of theirs at this table becomes it (keeping the
    -- place in line it already had), else one is written with position 0 -
    -- a line is 1-based, so 0 says "the join door's hold" without a schema change.
    UPDATE public.table_waitlist
       SET status = 'notified', notified_at = now(), hold_expires_at = v_hold_until
     WHERE table_id = t.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    IF NOT FOUND THEN
      INSERT INTO public.table_waitlist (table_id, user_id, position, status, notified_at, hold_expires_at)
      VALUES (t.id, v_uid, 0, 'notified', now(), v_hold_until);
    END IF;
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', t.id, 'table_name', t.name,
                              'role', t.role, 'main_index', t.main_index,
                              'open_seats', public.fn_cash_game_open_seats(t.id) + 1,
                              'hold_expires_at', v_hold_until);
  END LOOP;

  -- Nothing open anywhere: hold the place. One live row per game per player.
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
  VALUES (g.id, v_uid, 'waiting')
  ON CONFLICT DO NOTHING;
  SELECT count(*) + 1 INTO v_position FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND w.created_at < (SELECT created_at FROM public.cash_game_waitlist x
                          WHERE x.game_id = g.id AND x.user_id = v_uid AND x.status IN ('waiting', 'notified') LIMIT 1);
  SELECT count(*) INTO v_count FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  RETURN jsonb_build_object('ok', true, 'action', 'waitlisted', 'position', v_position, 'waiting', v_count,
                            'opening_hold_since', g.opening_hold_since,
                            'tables', (SELECT count(*) FROM public.tables tb WHERE tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
                                          AND coalesce(tb.is_deleted, false) = false));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_offer_open_seat(p_table_id uuid, p_offer_ttl interval DEFAULT '00:01:00'::interval, p_entry_ttl interval DEFAULT '24:00:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tbl      record;
  v_next     record;
  v_notif_id uuid;
  v_expired  int := 0;
  v_cap      int := 1;
  v_selected boolean := false;
  v_legacy_holds integer := 0;
BEGIN
  -- Share the actual seat admission key with cash-game joins and buy-ins.
  -- A busy table is left untouched; a caller may already hold sweep rows,
  -- so waiting for another claimant here can invert that caller's locks.
  IF p_table_id IS NOT NULL AND NOT pg_try_advisory_xact_lock(
       hashtextextended('table_seat:' || p_table_id::text, 0)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_claim_busy');
  END IF;

  SELECT COALESCE(max_concurrent_holds, 1) INTO v_cap FROM public.waitlist_policy WHERE id;
  IF v_cap IS NULL THEN v_cap := 1; END IF;

  SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players
    INTO v_tbl
    FROM public.tables t
   WHERE t.id = p_table_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF v_tbl.tournament_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_table');
  END IF;

  -- The cached lobby count cannot authorize an exclusive chair offer.
  v_tbl.current_players := (SELECT count(*) FROM public.table_seats s
                            WHERE s.table_id=p_table_id AND s.left_at IS NULL);
  IF v_tbl.current_players >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  WITH dead AS (
    UPDATE public.table_waitlist
       SET status = 'expired'
     WHERE table_id = p_table_id
       AND status = 'notified'
       AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) < now()
    RETURNING user_id
  )
  INSERT INTO public.notifications (user_id, type, title, message, data)
  SELECT d.user_id,
         'waitlist_offer_expired',
         'Seat Offer Expired',
         'Your Seat At ' || COALESCE(v_tbl.name, 'The Table') ||
           ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
         jsonb_build_object('table_id', p_table_id, '_push', 'skip')
    FROM dead d;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE table_id = p_table_id
     AND status = 'waiting'
     AND created_at < now() - p_entry_ttl;

  UPDATE public.table_waitlist w
     SET status = 'seated'
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = p_table_id
          AND s.left_at IS NULL
          AND s.user_id = w.user_id
     );

  -- This same reader also reserves pending non-swap seat moves. Re-read it
  -- after expiry and under the common table key, just like the join door.
  -- Pre-column offers retain their original notified_at + TTL reservation.
  -- The shared reader counts explicit hold_expires_at values only.
  SELECT count(*) INTO v_legacy_holds FROM public.table_waitlist h
   WHERE h.table_id=p_table_id AND h.status='notified'
     AND h.hold_expires_at IS NULL AND h.notified_at+p_offer_ttl>now();
  IF COALESCE(public.fn_cash_game_open_seats(p_table_id),0) <= v_legacy_holds THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'open_seats_already_held', 'offers_expired', v_expired
    );
  END IF;

  -- THE HEAD OF THE QUEUE, LOCKED, AND NOT ALREADY HOLDING A SEAT ELSEWHERE.
  -- A hold is exclusive, so handing one player several at once takes seats
  -- away from everybody behind them. Skipping a capped player leaves their
  -- place in line untouched: they are passed over for THIS seat only.
  --
  -- 2026-08-31 (Dan, binding: horses are never skipped): the is_horse
  -- exclusion that used to sit in this predicate is GONE. Whoever is first in
  -- line is offered the seat. The JOIN to profiles stays: it is no longer read
  -- to exclude anyone, but dropping it would newly qualify waitlist rows whose
  -- user has no profile row at all.
  FOR v_next IN
  SELECT w.id, w.user_id, COALESCE(p.is_horse, false) AS is_horse
    FROM public.table_waitlist w
    JOIN public.profiles p ON p.id = w.user_id
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND (
       v_cap = 0
       OR (
         SELECT count(*) FROM public.table_waitlist h
          WHERE h.user_id = w.user_id
            AND h.status = 'notified'
            AND COALESCE(h.hold_expires_at, h.notified_at + p_offer_ttl) > now()
       ) < v_cap
     )
   ORDER BY w.created_at, w.id
     FOR UPDATE OF w SKIP LOCKED
  LOOP
    -- Queue-row locks on different tables do not serialize this player's
    -- offer allowance. A nonblocking claim preserves other queue members'
    -- progress without waiting while this transaction owns a table key.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended('waitlist_offer_user:' || v_next.user_id::text, 0));
    CONTINUE WHEN v_cap > 0 AND (
      SELECT count(*) FROM public.table_waitlist h
       WHERE h.user_id=v_next.user_id AND h.status='notified'
         AND COALESCE(h.hold_expires_at,h.notified_at+p_offer_ttl)>now()
    ) >= v_cap;
    -- NO CHAIR IS HELD FOR A PLAYER WHO CANNOT PAY FOR IT (Dan 2026-10-12).
    -- A player in line whose wallets cannot cover this table's minimum is
    -- passed over for THIS seat and keeps their place, exactly as a capped
    -- player is above; the same rule for every player in line (10.5).
    CONTINUE WHEN NOT public.fn_ca_cash_wallet_covers(
      v_next.user_id, p_table_id, NULL,
      public.fn_ca_cash_entry_need(v_next.user_id, p_table_id));
    v_selected := true;
    EXIT;
  END LOOP;

  IF NOT v_selected THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'nobody_waiting', 'offers_expired', v_expired
    );
  END IF;

  UPDATE public.table_waitlist
     SET status = 'notified',
         notified_at = now(),
         hold_expires_at = now() + p_offer_ttl
   WHERE id = v_next.id;

  -- The notification row is written for every player alike, so the queue's
  -- audit trail is identical. Only the PUSH flag differs: a horse has no
  -- device to push to, which is the sanctioned identification-for-display use,
  -- and it reuses the `_push:skip` marker the expiry notification above
  -- already uses. It decides how a message is delivered, never whether a seat
  -- is offered.
  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (
    v_next.user_id,
    'waitlist_seat_open',
    'Seat Open',
    'A Seat Just Opened At ' || COALESCE(v_tbl.name, 'Your Waitlisted Table') ||
      '. It Is Held For You For 60 Seconds. Sit Down Now To Claim It.',
    CASE WHEN v_next.is_horse
         THEN jsonb_build_object('table_id', p_table_id, '_push', 'skip')
         ELSE jsonb_build_object('table_id', p_table_id)
    END
  )
  RETURNING id INTO v_notif_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_next.user_id,
    'table_name', v_tbl.name,
    'notification_id', v_notif_id,
    'hold_expires_in_seconds', EXTRACT(epoch FROM p_offer_ttl)::int,
    'offers_expired', v_expired
  );
END
$function$
;

COMMIT;
