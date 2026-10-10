CREATE OR REPLACE FUNCTION public.fn_ca_register_issuance_leg(p_ledger_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l record; v_action text; v_holder_type text; v_holder uuid; v_label text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO l FROM public.chip_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.chip_ledger_id = l.id) THEN
    RETURN false;
  END IF;
  IF l.category = 'correction' AND l.metadata->>'posted_via' = 'fn_ca_post_correction' THEN
    RETURN false;  -- a correction moves no balance (a_correction_is_not_a_mint)
  END IF;
  IF l.from_type = ANY (v_outside) AND NOT (l.to_type = ANY (v_outside)) THEN
    v_action := 'mint'; v_holder := l.to_entity_id;
    v_holder_type := CASE l.to_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSIF l.to_type = ANY (v_outside) AND NOT (l.from_type = ANY (v_outside)) THEN
    v_action := 'burn'; v_holder := l.from_entity_id;
    v_holder_type := CASE l.from_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSE
    RETURN false;  -- store to store, or circulating to circulating
  END IF;
  -- The autoledger stamps a union wallet's row with the union id; a union is
  -- also a row in clubs (is_union), so resolve by what the id actually is.
  IF v_holder_type = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_holder AND COALESCE(c.is_union, false)) THEN
    v_holder_type := 'union';
  END IF;
  IF v_holder IS NULL THEN
    v_holder_type := 'circulation';
  END IF;
  IF v_holder_type = 'circulation' THEN
    v_holder := '00000000-0000-0000-0000-00000000c1c0';  -- the circulation sentinel (the house is ...d1a0)
  END IF;
  v_label := CASE v_holder_type
    WHEN 'club'   THEN (SELECT c.name FROM public.clubs c WHERE c.id = v_holder)
    WHEN 'union'  THEN COALESCE((SELECT u.name FROM public.unions u WHERE u.id = v_holder), (SELECT c.name FROM public.clubs c WHERE c.id = v_holder))
    WHEN 'player' THEN (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) FROM public.profiles p WHERE p.id = v_holder)
    ELSE 'circulation' END;
  -- A leg written by hand (a linked compensating entry) carries no balances;
  -- the register still wants a pair, so the pair is the amount itself.
  /* A door that wrote its own register row but did not link the leg
     (fn_ca_burn looks the leg up by a shape it does not always match):
     adopt that row rather than write a second one. Same action, holder,
     amount, asset, within five seconds of the leg, not yet linked. */
  UPDATE public.ca_mint_ledger m
     SET chip_ledger_id = l.id
   WHERE m.id = (SELECT m2.id FROM public.ca_mint_ledger m2
                  WHERE m2.chip_ledger_id IS NULL AND m2.asset = 'chips' AND m2.action = v_action
                    AND m2.amount = l.amount AND m2.holder_id = v_holder
                    AND m2.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds'
                  ORDER BY m2.created_at LIMIT 1);
  IF FOUND THEN RETURN false; END IF;
  v_before := COALESCE(CASE WHEN v_action = 'mint' THEN l.pre_to_balance ELSE l.pre_from_balance END, 0);
  v_after  := COALESCE(CASE WHEN v_action = 'mint' THEN l.post_to_balance ELSE l.post_from_balance END,
                       v_before + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
       + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  v_op := 'ledger:' || l.id::text;
  v_reason := left(COALESCE(NULLIF(btrim(l.description), ''), l.category) || ' (' || l.category
              || CASE WHEN l.idempotency_key IS NOT NULL THEN ', key ' || l.idempotency_key ELSE '' END
              || '; registered from the journal leg)', 500);
  IF length(btrim(v_reason)) < 10 THEN v_reason := v_reason || ' - registered from the journal'; END IF;
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, db_role, chip_ledger_id, created_at)
  VALUES (v_op, v_action, 'chips', v_holder_type, v_holder, v_label, l.amount,
          v_before, v_after, v_supply, v_reason, l.performed_by, COALESCE(l.actor_service, l.db_role), l.db_role, l.id, l.created_at)
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END;
$function$
