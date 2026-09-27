-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820123829 "union_law_tournament_payouts_return_to_club"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 118589990e5aed224225a9fcc84a93d2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — TOURNAMENT PAYOUTS RETURN TO THE CLUB THAT PAID (2026-08-20, pass 4)
--
-- LEAK FOUND: tournament ENTRIES now debit club chips, but every tournament
-- PAYOUT still credited the single global player wallet:
--   * prizes            credit_player_wallet  key 'tourney:<id>:prize:...'
--   * bounties          credit_player_wallet  key 'tourney:<id>:bounty:...'
--   * own bounty        credit_player_wallet  key 'tourney:<id>:ownbounty:...'
--   * cancellations     atomic_cancel_tournament -> wallets
-- Every completed tournament therefore drained club wallets into global
-- wallets — a systematic, compounding breach of "each wallet for each club is
-- 100% separate and never commingled", and the exact mirror of the rebuy leak
-- closed in pass 3.
--
-- credit_player_wallet is generic (bonuses, referrals, daily rewards) and those
-- SHOULD stay on the global wallet, so the routing is keyed strictly off the
-- tournament idempotency key: a credit tagged 'tourney:<uuid>:' is tournament
-- money and goes back to the club that paid that player's entry. Everything
-- else is untouched. Entries with no club stamp keep the global wallet.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.credit_player_wallet(p_user_id uuid, p_amount numeric, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer;
  v_tourn uuid;
  v_club uuid;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
            RETURN;  -- already credited under this key: idempotent no-op
        END IF;
    END IF;

    -- UNION LAW: tournament money returns to the club that paid the entry.
    -- Recognised by the 'tourney:<uuid>:' key prefix used by prize, bounty and
    -- ownbounty credits. Non-tournament credits fall through unchanged.
    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN
        v_tourn := NULL;
      END;

      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club
          FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id
         LIMIT 1;
      END IF;
    END IF;

    IF v_club IS NOT NULL THEN
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount,
             updated_at   = NOW()
       WHERE user_id = p_user_id AND club_id = v_club;
      IF FOUND THEN
        RETURN;
      END IF;
      -- Membership vanished mid-tournament: fall back rather than burn chips.
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('warning','credit_player_wallet',
              'Tournament payout could not reach the entry club; credited the global wallet',
              jsonb_build_object('user_id',p_user_id,'tournament_id',v_tourn,
                                 'club_id',v_club,'amount',p_amount));
    END IF;

    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;
END;
$function$;

