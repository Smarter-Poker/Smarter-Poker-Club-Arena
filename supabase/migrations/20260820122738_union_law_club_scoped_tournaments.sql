-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820122738 "union_law_club_scoped_tournaments"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 36316808b12ef3944e11940f824dc994 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — CLUB-SCOPED TOURNAMENTS (2026-08-20, pass 3)
--
-- Cash play is fully club-scoped; tournaments were not. Registration, refunds
-- and rebuys/re-entries/add-ons all debited the single global player wallet,
-- so tournament money was still commingled and tournament rake was attributed
-- by first-joined membership rather than by the club the player actually
-- entered under.
--
-- This adds provenance to the tournament entry itself (tournament_players.
-- club_id), the mirror of table_seats.club_id, and routes every tournament
-- money path through it:
--   REGISTER   debits the entered club and stamps the entry.
--   UNREGISTER refunds to the SAME club, routed by the entry stamp.
--   REBUY/RE-ENTRY/ADD-ON debit the entry's club.
--   RAKE       attributes entry fees to the entry's club.
-- Entries with no stamp (legacy) keep using the global wallet, so nothing in
-- flight breaks and every entry stays internally consistent.
-- ============================================================================

ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id);

COMMENT ON COLUMN public.tournament_players.club_id IS
  'UNION LAW (Dan 2026-08-20): the club whose chips paid this entry. Entry fee '
  'rake belongs to that club only. NULL = legacy entry predating club-scoped '
  'chips; attribution falls back to first-joined membership.';

CREATE INDEX IF NOT EXISTS idx_tournament_players_club
  ON public.tournament_players (club_id, tournament_id);

-- Which club is this player entering the tournament under? -------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_t_club uuid; v_club uuid;
  v_is_horse boolean := false; v_n int; v_idx int;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_t_club
    FROM tournaments t WHERE t.id = p_tournament_id;

  IF v_union IS NULL THEN
    RETURN v_t_club;                       -- standalone club tournament
  END IF;

  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                  JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved'))
  THEN
    RETURN p_preferred_club;
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
END $function$;

-- Every entry carries its club, whatever code path created it ---------------
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

DROP TRIGGER IF EXISTS trg_tournament_players_stamp_club ON public.tournament_players;
CREATE TRIGGER trg_tournament_players_stamp_club
  BEFORE INSERT OR UPDATE ON public.tournament_players
  FOR EACH ROW
  WHEN (NEW.club_id IS NULL)
  EXECUTE FUNCTION public.fn_stamp_entry_club();

-- REGISTER -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_tournament_register(p_tournament_id uuid, p_user_id uuid, p_username text, p_total_cost numeric, p_current_bounty numeric, p_mystery_bounty_value numeric, p_is_bounty_tournament boolean, p_club_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_balance NUMERIC;
  v_player_id UUID;
  v_club uuid := NULL;
BEGIN
  IF public.fn_club_scoped_chips_enabled() THEN
    v_club := public.fn_tournament_club_for_user(p_user_id, p_tournament_id, p_club_id);
  END IF;

  IF v_club IS NOT NULL THEN
    -- UNION LAW: the entry is paid for with the entered club's chips.
    SELECT chip_balance INTO v_wallet_balance FROM club_members
     WHERE user_id = p_user_id AND club_id = v_club FOR UPDATE;
    IF NOT FOUND OR v_wallet_balance < p_total_cost THEN
      RAISE EXCEPTION 'Insufficient club chips for tournament entry.';
    END IF;
    UPDATE club_members SET chip_balance = chip_balance - p_total_cost, updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_club;
  ELSE
    SELECT balance INTO v_wallet_balance FROM wallets
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER' FOR UPDATE;
    IF NOT FOUND OR v_wallet_balance < p_total_cost THEN
      RAISE EXCEPTION 'Insufficient chips in Player Wallet.';
    END IF;
    UPDATE wallets SET balance = balance - p_total_cost, updated_at = NOW()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  END IF;

  IF p_is_bounty_tournament THEN
    INSERT INTO tournament_players (
      tournament_id, user_id, username, chips, status,
      current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings, club_id
    ) VALUES (
      p_tournament_id, p_user_id, p_username, 0, 'registered',
      p_current_bounty, p_mystery_bounty_value, 0, 0, v_club
    ) RETURNING id INTO v_player_id;
  ELSE
    INSERT INTO tournament_players (
      tournament_id, user_id, username, chips, status, club_id
    ) VALUES (
      p_tournament_id, p_user_id, p_username, 0, 'registered', v_club
    ) RETURNING id INTO v_player_id;
  END IF;

  RETURN v_player_id;
END;
$function$;

-- UNREGISTER: refund to the wallet that paid ---------------------------------
CREATE OR REPLACE FUNCTION public.atomic_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_refund_amount numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_deleted_count INT;
  v_tournament_name TEXT;
  v_club uuid;
BEGIN
  WITH deleted AS (
    DELETE FROM tournament_players
    WHERE tournament_id = p_tournament_id
      AND user_id = p_user_id
      AND status = 'registered'
    RETURNING id, club_id
  )
  SELECT COUNT(*), MAX(club_id::text)::uuid INTO v_deleted_count, v_club FROM deleted;

  IF v_deleted_count = 0 THEN
    RETURN FALSE;
  END IF;

  -- UNION LAW: money goes back where it came from, routed by the entry stamp.
  IF v_club IS NOT NULL THEN
    UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + p_refund_amount,
                            updated_at = NOW()
     WHERE user_id = p_user_id AND club_id = v_club;
    IF NOT FOUND THEN
      UPDATE wallets SET balance = balance + p_refund_amount, updated_at = NOW()
       WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('warning','atomic_tournament_unregister',
              'Entry club membership missing at refund; refunded to the global wallet',
              jsonb_build_object('user_id',p_user_id,'tournament_id',p_tournament_id,
                                 'club_id',v_club,'amount',p_refund_amount));
    END IF;
  ELSE
    UPDATE wallets SET balance = balance + p_refund_amount, updated_at = NOW()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  END IF;

  SELECT name INTO v_tournament_name FROM tournaments WHERE id = p_tournament_id;

  PERFORM log_wallet_transaction(
    p_user_id, 'PLAYER', p_refund_amount, 'credit', 'refund',
    'Tournament unregister refund: ' || COALESCE(v_tournament_name, 'Unknown'),
    NULL, NULL, p_tournament_id
  );

  RETURN TRUE;
END;
$function$;

