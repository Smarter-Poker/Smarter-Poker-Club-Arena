CREATE OR REPLACE FUNCTION public.fn_ca_account_balance(p_type text, p_entity uuid, p_club uuid, p_col text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v numeric; v_rows int;
BEGIN
  /* A BALANCE THAT DOES NOT EXIST IS NOT ZERO: an owner with no row is
     unreadable, and the replay skips what it cannot read rather than judging
     it against a fabricated zero. */
  CASE p_col
    WHEN 'club_members.chip_balance' THEN
      SELECT count(*), COALESCE(sum(chip_balance), 0) INTO v_rows, v FROM public.club_members WHERE user_id = p_entity;
    WHEN 'table_seats.stack' THEN
      -- the whole cash felt, exactly as fn_ca_supply_snapshot defines it
      SELECT count(*), COALESCE(sum(ts.stack), 0) INTO v_rows, v
        FROM public.table_seats ts
       WHERE ts.left_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id = ts.table_id AND t.tournament_id IS NOT NULL);
      v_rows := 1;  -- the felt always exists, even when every seat is empty
    WHEN 'clubs.chip_treasury' THEN
      SELECT count(*), COALESCE(sum(chip_treasury), 0) INTO v_rows, v FROM public.clubs WHERE id = p_entity;
    WHEN 'clubs.promo_balance' THEN
      SELECT count(*), COALESCE(sum(promo_balance), 0) INTO v_rows, v FROM public.clubs WHERE id = p_entity;
    WHEN 'clubs.insurance_balance' THEN
      SELECT count(*), COALESCE(sum(insurance_balance), 0) INTO v_rows, v FROM public.clubs WHERE id = p_entity;
    WHEN 'union_wallets.chip_balance' THEN
      SELECT count(*), COALESCE(sum(chip_balance), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.rake_wallet' THEN
      SELECT count(*), COALESCE(sum(rake_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.bbj_wallet' THEN
      SELECT count(*), COALESCE(sum(bbj_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.promo_wallet' THEN
      SELECT count(*), COALESCE(sum(promo_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.insurance_wallet' THEN
      SELECT count(*), COALESCE(sum(insurance_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.spin_reserve_wallet' THEN
      SELECT count(*), COALESCE(sum(spin_reserve_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'bbj_pools.main_balance' THEN
      SELECT count(*), COALESCE(sum(main_balance), 0) INTO v_rows, v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'bbj_pools.backup_balance' THEN
      SELECT count(*), COALESCE(sum(backup_balance), 0) INTO v_rows, v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'bbj_pools.promo_balance' THEN
      SELECT count(*), COALESCE(sum(promo_balance), 0) INTO v_rows, v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'spin_bonus_pools.balance' THEN
      SELECT count(*), COALESCE(sum(balance), 0) INTO v_rows, v FROM public.spin_bonus_pools WHERE club_id = p_entity OR id = p_entity;
    WHEN 'agents.promo_wallet_balance' THEN
      SELECT count(*), COALESCE(sum(promo_wallet_balance), 0) INTO v_rows, v FROM public.agents WHERE id = p_entity OR user_id = p_entity;
    WHEN 'agents.agent_wallet_balance' THEN
      SELECT count(*), COALESCE(sum(agent_wallet_balance), 0) INTO v_rows, v FROM public.agents WHERE id = p_entity OR user_id = p_entity;
    ELSE
      v_rows := 0; v := NULL;
  END CASE;
  IF COALESCE(v_rows, 0) = 0 THEN RETURN NULL; END IF;
  RETURN v;
END;
$function$
