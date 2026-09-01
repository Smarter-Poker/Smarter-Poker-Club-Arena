-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:51:26 UTC on kuklfnapbkmacvwxktbh.

-- ROOT CAUSE (23:45 UTC winner_prize_credit_failed x2): cross-club tournament
-- entry. Registration stamps tournament_players.club_id with the TOURNAMENT'S
-- club and debits the player's wallet in THEIR OWN club; the prize credit
-- then resolved only the stamped club, found no membership there, and refused
-- after 3 retries - the winner went unpaid. The credit now cascades:
--   1. the stamped club (unchanged fast path),
--   2. the club whose wallet actually paid this tournament's buy-in
--      (the buy-in receipt in chip_transactions is the evidence),
--   3. the player's home club,
--   4. their largest active membership,
-- and only then refuses. Conservation holds on every path: the prize leaves
-- prize liability and lands in exactly one player wallet, idempotency key
-- semantics unchanged.
CREATE OR REPLACE FUNCTION public.fn_credit_player_wallet_once(p_user_id uuid, p_amount numeric, p_idempotency_key text DEFAULT NULL::text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer; v_tourn uuid; v_club uuid; v_balance numeric;
  v_is_tournament boolean := false; v_has_any_club boolean;
  v_fallback uuid;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        -- FALSE, not void: the caller needs to know it must NOT write a
        -- ledger row for a credit somebody else already made.
        IF v_inserted = 0 THEN RETURN false; END IF;
    END IF;

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      v_is_tournament := true;
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN v_tourn := NULL;
      END;
      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id LIMIT 1;
        IF v_club IS NULL THEN
          SELECT t.club_id INTO v_club FROM tournaments t WHERE t.id = v_tourn;
          v_club := COALESCE(public.fn_player_home_club(p_user_id, NULL), v_club);
        END IF;
      END IF;
    END IF;

    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    IF v_club IS NOT NULL THEN
      PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
       WHERE user_id = p_user_id AND club_id = v_club
       RETURNING chip_balance INTO v_balance;
      IF v_balance IS NOT NULL THEN RETURN true; END IF;
    END IF;

    /* ZERO-DRIFT (2026-08-31): cross-club tournament entry - the stamped club
       holds no wallet for this player. Follow the money home instead of
       refusing a prize the pool already owes. */
    IF v_is_tournament AND v_tourn IS NOT NULL THEN
      SELECT ct.club_id INTO v_fallback
        FROM chip_transactions ct
        JOIN tournaments t ON t.id = v_tourn
       WHERE ct.from_user_id = p_user_id
         AND ct.transaction_type = 'tournament_buyin'
         AND ct.notes = 'Tournament buy-in: ' || t.name
         AND ct.created_at > COALESCE(t.started_at, t.created_at, now()) - interval '7 days'
         AND EXISTS (SELECT 1 FROM club_members m
                      WHERE m.user_id = p_user_id AND m.club_id = ct.club_id)
       ORDER BY ct.created_at DESC LIMIT 1;
      IF v_fallback IS NULL THEN
        v_fallback := public.fn_player_home_club(p_user_id, NULL);
      END IF;
      IF v_fallback IS NULL THEN
        SELECT m.club_id INTO v_fallback
          FROM club_members m
         WHERE m.user_id = p_user_id
           AND COALESCE(m.status, 'active') IN ('active','approved')
         ORDER BY COALESCE(m.chip_balance, 0) DESC, m.club_id LIMIT 1;
      END IF;
      IF v_fallback IS NOT NULL AND v_fallback IS DISTINCT FROM v_club THEN
        PERFORM public.fn_ensure_club_wallet(p_user_id, v_fallback);
        UPDATE club_members
           SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
         WHERE user_id = p_user_id AND club_id = v_fallback
         RETURNING chip_balance INTO v_balance;
        IF v_balance IS NOT NULL THEN RETURN true; END IF;
      END IF;
    END IF;

    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id)
      INTO v_has_any_club;

    IF v_is_tournament OR v_has_any_club THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical','credit_player_wallet',
              'Club Arena credit could not resolve a club wallet - payment refused rather than pooled',
              jsonb_build_object('user_id',p_user_id,'amount',p_amount,
                                 'idempotency_key',p_idempotency_key,'tournament_id',v_tourn));
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;

    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;

    RETURN true;
END;
$function$;;
