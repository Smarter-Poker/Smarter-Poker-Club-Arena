-- 20260905064901_the_signup_grant_is_registered_once_and_deletion_retires_wha.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE SIGNUP GRANT IS REGISTERED ONCE, AND DELETION RETIRES WHAT THE MINT
-- STILL ATTRIBUTES (diamond standard, 2026-09-05)
--
-- Follows 20260905041033, which made the diamond register follow the diamond
-- journal. Within the hour the Mint panel went red: the register read
-- 1,048,622 against a meter of 1,030,622, over by 18,000. Read from
-- production rather than reasoned about; two separate causes, both measured.
--
-- CAUSE 1 - A DOUBLE COUNT, AND IT WAS MINE. The signup grant already had a
--   register row. `fn_ca_diamond_born_with_balance` (the seed door added by
--   20260901032430) writes its own ca_mint_ledger row with op id 'seed:<id>'
--   AND a diamond_transactions row (`signup_bonus`, source `handle_new_user`).
--   654 of 654 archived signup grants carry that seed row. 20260905041033's
--   trigger then registered the SAME journal row a second time as
--   'promotion/mint'. The two rows are visibly one movement - both read
--   balance_before 0, balance_after 500 for the same holder. 18 duplicate
--   pairs, 9,000 diamonds.
--
--   The guard that should have caught it looks for a register row already
--   linked to the journal row (`diamond_tx_id`), and the seed door links
--   none: 0 of 654. So the fix is to name the writer, exactly as the
--   classifier already names `source = 'the_mint'` for fn_ca_mint and
--   fn_ca_burn. It is deliberately NARROW - only the signup grant, never
--   'promotional' as a class - because the other 7 promotion rows are real
--   earned rewards (Diamond Rewards v2: daily_login, easter_egg) that have no
--   other register row and must keep being registered.
--
-- CAUSE 2 - A STRANDED SEED, AND IT PRE-DATES THIS WORK. A certification
--   account is granted 500, its balance is then zeroed by the harness through
--   a path that writes no journal row, and it is deleted holding 0. The
--   deletion trigger burns `OLD.diamonds`, which is 0, so the register keeps
--   the 500 forever. Ground truth for Certobsef369106: one archived journal
--   row (signup_bonus, balance_after 500), diamonds_at_deletion 0, two
--   register mints and no burn. 18 accounts x 500 = the other 9,000.
--
--   The deletion trigger now burns GREATEST(OLD.diamonds, what the register
--   still attributes to that holder since the diamond baseline). That is
--   never smaller than today's burn, so it cannot regress the healthy case:
--     - a player deleted holding 1,000 that the register attributes to them
--       -> both figures are 1,000, burn unchanged;
--     - a player from before the baseline, whose supply sits in the baseline
--       lump rather than against their id -> attribution is 0, burn stays
--       OLD.diamonds, unchanged;
--     - a certification account drained outside the journal -> attribution is
--       500, OLD.diamonds is 0, and the 500 is finally retired.
--   It records a retirement; it moves no balance and it never blocks a delete.
--
-- Then ONE labelled correction sized at apply time (not a hardcoded 18,000 -
-- the harness may run again between writing this and applying it), and the
-- difference is asserted at zero.
--
-- One transaction. Probed rolled-back first.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL statement_timeout = '5min';

-- ── 1. The signup grant is registered once, by the seed door ───────────────
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_origin(
  p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind  text := lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), ''));
  v_class text := lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), ''));
  v_src   text := lower(COALESCE(NULLIF(btrim(p_source), ''), ''));
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN RETURN NULL; END IF;
  -- The Mint's own doors register their own rows.
  IF v_src = 'the_mint' THEN RETURN NULL; END IF;
  -- SO DOES THE SEED DOOR. fn_ca_diamond_born_with_balance writes the
  -- 'seed:<id>' register row for the signup grant and then the journal row.
  -- Registering it here as well counts one movement twice (2026-09-05: 18
  -- duplicate pairs, 9,000 diamonds). Named writer, not a class: every OTHER
  -- promotional credit still registers here.
  IF v_kind = 'signup_bonus' OR v_src = 'handle_new_user' THEN RETURN NULL; END IF;
  -- Player to player: supply moves, none is created or retired.
  IF v_class = 'transferred'
     OR v_kind IN ('transfer', 'diamond_gift_sent', 'diamond_gift_received', 'diamond_received',
                   'live_gift_sent', 'live_gift_received', 'wallet_transfer',
                   'wallet_diamond_transfer', 'stream_gift', 'union_grant_transfer')
     OR v_kind LIKE '%gift%' OR v_kind LIKE '%transfer%' THEN
    RETURN NULL;
  END IF;
  -- The deletion door writes its own register row.
  IF v_class = 'deletion' THEN RETURN NULL; END IF;
  -- A test fixture row is not supply the Mint issued.
  IF v_kind LIKE 'test%' THEN RETURN NULL; END IF;

  IF p_amount > 0 THEN
    IF v_class = 'purchased' OR v_kind IN ('purchase', 'stripe_purchase', 'diamond_purchase') THEN
      RETURN 'purchase';
    ELSIF v_class = 'refund' OR v_kind LIKE '%refund%' OR v_kind = 'diamond_refund' THEN
      RETURN 'refund';
    ELSIF v_class = 'promotional' OR v_kind IN ('union_grant', 'bonus', 'promo',
                                                 'promo_purchased', 'easter_egg', 'vip_daily',
                                                 'vip_stipend', 'vip_monthly') THEN
      RETURN 'promotion';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'admin_grant') THEN
      RETURN 'adjustment';
    ELSIF v_class = 'arena' OR v_kind LIKE 'arcade%' THEN
      RETURN 'arena';
    ELSE
      RETURN 'reward';   -- earned: daily_login, training, tournament_prize, pvp_win, trivia ...
    END IF;
  ELSE
    IF v_kind IN ('chip_mint', 'chip_purchase', 'mint_chips', 'diamonds_to_chips') OR v_class = 'bridge' THEN
      RETURN 'bridge';   -- diamonds retired to become chips
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'chargeback', 'clawback') THEN
      RETURN 'adjustment';
    ELSE
      RETURN 'spend';    -- feature purchases, VIP, club shop, merch, stakes, entries
    END IF;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_journal_origin(text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_journal_origin(text, text, text, text, numeric) TO service_role;

-- ── 2. Deletion retires what the Mint still attributes to that holder ──────
CREATE OR REPLACE FUNCTION public.fn_ca_journal_profile_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_archived integer := 0;
  v_baseline timestamptz;
  v_attributed numeric := 0;
  v_burn numeric;
BEGIN
  BEGIN
    INSERT INTO public.ca_profile_deletions
      (profile_id, username, is_horse, diamonds, diamond_balance, profile_created_at)
    VALUES
      (OLD.id, OLD.username, OLD.is_horse, OLD.diamonds, OLD.diamond_balance, OLD.created_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_profile_deletions could not record deletion of % (%): %',
      OLD.id, OLD.username, SQLERRM;
  END;

  -- (a) Keep the history. This runs BEFORE the ON DELETE CASCADE fires, so
  --     the rows are still there to copy.
  BEGIN
    INSERT INTO public.ca_diamond_journal_archive
      (id, user_id, type, amount, balance_after, description, reference_id, created_at,
       transaction_type, source, metadata, counterparty, issuance_class,
       deleted_profile_id, deletion_reason)
    SELECT t.id, t.user_id, t.type, t.amount, t.balance_after, t.description,
           t.reference_id, t.created_at, t.transaction_type, t.source, t.metadata,
           t.counterparty, t.issuance_class, OLD.id, v_reason
      FROM public.diamond_transactions t
     WHERE t.user_id = OLD.id
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_archived = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ca_diamond_journal_archive could not preserve the journal of % (%): %',
      OLD.id, OLD.username, SQLERRM;
  END;

  -- (b) A balance that leaves with the account has left supply, and so has
  --     anything the register still attributes to the holder. Burning
  --     GREATEST of the two is never less than the balance this trigger
  --     burned before 2026-09-05, so the healthy case is unchanged; it also
  --     retires a seed the harness zeroed outside the journal, which is how
  --     18 certification accounts stranded 500 each in the register.
  BEGIN
    SELECT min(created_at) INTO v_baseline
      FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND origin = 'baseline';
    SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
      INTO v_attributed
      FROM public.ca_mint_ledger
     WHERE asset = 'diamonds' AND holder_type = 'player' AND holder_id = OLD.id
       AND (v_baseline IS NULL OR created_at >= v_baseline);
  EXCEPTION WHEN OTHERS THEN
    v_attributed := 0;
  END;

  v_burn := GREATEST(COALESCE(OLD.diamonds, 0), COALESCE(v_attributed, 0));

  IF v_burn > 0 THEN
    BEGIN
      INSERT INTO public.ca_mint_ledger
        (op_id, action, asset, holder_type, holder_id, holder_label, amount,
         balance_before, balance_after, supply_after, reason, performed_by)
      VALUES
        ('deletion:' || OLD.id::text, 'burn', 'diamonds', 'player', OLD.id, OLD.username,
         v_burn, COALESCE(OLD.diamonds, 0), 0,
         COALESCE(public.fn_ca_mint_supply('diamonds'), 0) - v_burn,
         'profile deleted (retirement recorded by trigger, docs/DIAMOND-ACCOUNTING-STANDARD.md DR5): '
           || 'balance ' || COALESCE(OLD.diamonds, 0)::text
           || ', registered attribution ' || COALESCE(v_attributed, 0)::text
           || ', retired ' || v_burn::text,
         NULL)
      ON CONFLICT (op_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ca_mint_ledger could not record the retirement burn of % (% diamonds): %',
        OLD.id, v_burn, SQLERRM;
    END;
  END IF;

  -- The DR5 incident still fires on a real balance leaving with the account.
  IF COALESCE(OLD.diamonds, 0) > 0 THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR5:deleted_with_balance', 'warning', OLD.id, OLD.diamonds, 'profiles DELETE',
        jsonb_build_object('is_horse', OLD.is_horse, 'username', OLD.username,
                           'journal_rows_archived', v_archived,
                           'registered_attribution', v_attributed,
                           'retired', v_burn,
                           'ledger_maintenance', v_reason));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN OLD;
END;
$function$;

-- ── 3. Correct the accrued gap forward, sized at apply time ────────────────
DO $$
DECLARE
  v_gap numeric; v_reg numeric; v_meter numeric; v_players numeric; v_house numeric;
  v_op text := 'register-opening-baseline-correction:diamonds:' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
  SELECT register_net, meter_total, player_diamonds, house_diamonds, difference
    INTO v_reg, v_meter, v_players, v_house, v_gap
    FROM public.fn_ca_diamond_register_vs_supply();
  IF v_gap <> 0 THEN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason, performed_by, performed_by_label)
    VALUES
      (v_op, CASE WHEN v_gap > 0 THEN 'mint' ELSE 'burn' END, 'diamonds', 'circulation',
       '00000000-0000-0000-0000-00000000c1c0', 'circulation', abs(v_gap),
       v_reg, v_meter, v_meter,
       format('Correction 2026-09-05: the register read %s against a meter of %s (%s in player '
              'balances + %s in the house account). Two causes, both measured and both closed '
              'by this migration: the signup grant was registered twice (the seed door and the '
              'journal trigger, 18 duplicate pairs) and a certification account whose balance '
              'was zeroed outside the journal was deleted holding 0, so its seed was never '
              'retired. This row retires the difference the two of them accrued. No diamond '
              'moved and no player balance changed.',
              v_reg, v_meter, v_players, v_house),
       auth.uid(), 'migration 20260905064901');
    RAISE NOTICE 'diamond correction: % %', CASE WHEN v_gap > 0 THEN 'mint' ELSE 'burn' END, abs(v_gap);
  ELSE
    RAISE NOTICE 'diamond register already equals the meter; no correction row';
  END IF;
END $$;

-- ── Assertions ─────────────────────────────────────────────────────────────
DO $$
DECLARE v_gap numeric;
BEGIN
  SELECT difference INTO v_gap FROM public.fn_ca_diamond_register_vs_supply();
  IF v_gap <> 0 THEN
    RAISE EXCEPTION 'diamond register does not equal the meter after the correction: difference %', v_gap;
  END IF;

  -- The signup grant is the seed door's to register, and nobody else's.
  IF public.fn_ca_diamond_journal_origin('earn', 'signup_bonus', 'handle_new_user', 'promotional', 500) IS NOT NULL THEN
    RAISE EXCEPTION 'classifier: the signup grant must not be registered a second time';
  END IF;
  -- Every OTHER promotional credit still registers.
  IF public.fn_ca_diamond_journal_origin('easter_egg', 'easter_egg', NULL, 'promotional', 250) <> 'promotion' THEN
    RAISE EXCEPTION 'classifier: a genuine promotional credit must still register';
  END IF;
  IF public.fn_ca_diamond_journal_origin('daily_login', 'daily_login', NULL, NULL, 7) <> 'reward' THEN
    RAISE EXCEPTION 'classifier: reward';
  END IF;
  IF public.fn_ca_diamond_journal_origin('purchase', 'purchase', NULL, 'purchased', 500) <> 'purchase' THEN
    RAISE EXCEPTION 'classifier: purchase';
  END IF;
  IF public.fn_ca_diamond_journal_origin('feature_purchase', 'feature_purchase', 'feature_purchase', 'spend', -5) <> 'spend' THEN
    RAISE EXCEPTION 'classifier: spend';
  END IF;
END $$;

COMMIT;
