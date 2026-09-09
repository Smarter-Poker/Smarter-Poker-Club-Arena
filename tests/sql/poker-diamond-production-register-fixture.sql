-- Read-only production function snapshot, September 9, 2026.
-- Loaded only after the isolated fixture database guard and schema setup.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
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
  -- THE ARENA DOORS MOVE MONEY, THEY DO NOT ISSUE IT. A deposit takes diamonds out of
  -- profiles.diamonds and puts them in the platform club's member wallet; a withdrawal is the
  -- mirror. The player still owns them and the supply is unchanged, so the register must not
  -- follow either leg - the same treatment, for the same reason, as a player-to-player transfer
  -- above. Classified as 'spend' (deposit) and 'arena' (withdrawal), the register would have
  -- burned the float on the way in and minted it on the way out (2026-09-08).
  IF v_kind IN ('arena_deposit', 'arena_withdraw') THEN RETURN NULL; END IF;
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
    -- 'arcade%' only. The 'arena' CLASS now belongs to the arena doors, which are handled
    -- as transfers above; leaving it here would have made a withdrawal mint.
    ELSIF v_kind LIKE 'arcade%' THEN
      RETURN 'arena';
    ELSE
      RETURN 'reward';
    END IF;
  ELSE
    IF v_kind IN ('chip_mint', 'chip_purchase', 'mint_chips', 'diamonds_to_chips') OR v_class = 'bridge' THEN
      RETURN 'bridge';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'chargeback', 'clawback') THEN
      RETURN 'adjustment';
    ELSE
      RETURN 'spend';
    END IF;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_follows_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.fn_ca_register_diamond_journal_row(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- The diamonds already moved and the journal row stands. A register that
    -- could not be written is an incident, not a refused purchase.
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'MINT:register_follow_failed', 'critical', NEW.user_id, NEW.amount,
        'fn_ca_diamond_register_follows_journal',
        jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM,
                           'journal_id', NEW.id, 'reference_id', NEW.reference_id));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t record; v_origin text; v_action text; v_label text; v_actorlb text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT * INTO t FROM public.diamond_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = t.id) THEN
    RETURN false;
  END IF;
  v_origin := public.fn_ca_diamond_journal_origin(t.type, t.transaction_type, t.source, t.issuance_class, t.amount);
  IF v_origin IS NULL THEN RETURN false; END IF;

  v_action := CASE WHEN t.amount > 0 THEN 'mint' ELSE 'burn' END;
  v_after  := COALESCE(t.balance_after, 0);
  v_before := v_after - t.amount;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_label FROM public.profiles p WHERE p.id = t.user_id;
  v_label := COALESCE(v_label, t.user_id::text);
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_actorlb FROM public.profiles p WHERE p.id = v_actor;
  v_op := 'diamond-journal:' || v_origin || ':' || t.id::text;
  v_reason := CASE v_action
                WHEN 'mint' THEN 'The Mint issued ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
                ELSE 'The Mint retired ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
              END
              || COALESCE(NULLIF(btrim(t.description), ''), COALESCE(t.transaction_type, t.type, 'diamond movement'));

  -- NO GLOBAL LOCK ON THIS PATH. It used to hold pg_advisory_xact_lock('ca_mint_ledger:diamonds')
  -- to make supply_after an exact running total. An xact-scoped lock is held until the CALLER
  -- commits, so every diamond movement serialised the whole economy behind whatever transaction
  -- happened to be moving diamonds - and on 2026-09-08, once one transaction could claim several
  -- challenges at once, twenty-four movements died on lock_timeout and went unrecorded.
  --
  -- supply_after is therefore the supply OBSERVED as this row was written, not a serialised
  -- running total: two simultaneous movements may each omit the other. Nothing reads it. The
  -- authority on supply is fn_ca_mint_supply(), which sums the movements, and the identity that
  -- matters - that sum equals what players hold - does not depend on this column at all.
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'diamonds';
  v_supply := v_supply + CASE WHEN v_action = 'mint' THEN abs(t.amount) ELSE -abs(t.amount) END;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id, created_at)
  VALUES
    (v_op, v_action, 'diamonds', 'player', t.user_id, v_label, abs(t.amount),
     v_before, v_after, v_supply, v_reason,
     v_actor, v_actorlb, NULL, t.id, COALESCE(t.created_at, now()))
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END $function$
;

CREATE TRIGGER trg_ca_diamond_register_follows_journal AFTER INSERT ON public.diamond_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_diamond_register_follows_journal();
