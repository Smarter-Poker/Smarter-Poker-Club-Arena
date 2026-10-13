-- Execute once through the configured authenticated SQL path only after the
-- owning release receipt proves the exact new engine and client are serving,
-- all hands are drained, and this certified maintenance freeze is active.
-- DML only: no management apply_migration (its metadata DDL is refused here).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $activate$
DECLARE v_drop record; v_count integer;
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'diamond_jackpot_activation_requires_certified_freeze';
 END IF;
 IF public.fn_ca_diamond_economic_text('bbj_enabled') IS DISTINCT FROM 'no' THEN
   RAISE EXCEPTION 'diamond_jackpot_activation_switch_changed_or_already_active';
 END IF;
 IF to_regprocedure('public.fn_poker_diamond_jackpot_accept_hand()') IS NULL
    OR to_regprocedure('public.fn_poker_diamond_jackpot_hand_detail(uuid)') IS NULL
    OR to_regprocedure('public.fn_poker_diamond_jackpot_pay_mini(uuid,bigint,numeric,integer,uuid,uuid,uuid[])') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_atomic_commits'::regclass
       AND tgname='poker_diamond_jackpot_accept_hand' AND tgenabled='O') THEN
   RAISE EXCEPTION 'diamond_jackpot_activation_requires_installed_accepted_hand_contract';
 END IF;
 SELECT count(*) INTO v_count FROM public.poker_diamond_jackpot_pools p
   JOIN public.clubs c ON c.id=p.arena_id
   WHERE p.status='active' AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL;
 IF v_count<>1 THEN RAISE EXCEPTION 'diamond_jackpot_activation_pool_scope_changed'; END IF;
 IF public.fn_ca_diamond_economic_text('mini_bbj_enabled') IS NULL
    OR public.fn_ca_diamond_economic_text('mini_bbj_enabled') NOT IN ('yes','no')
    OR public.fn_ca_diamond_economic('bbj_min_dealt_in') IS NULL
    OR public.fn_ca_diamond_economic('bbj_min_dealt_in') NOT BETWEEN 2 AND 10
    OR public.fn_ca_diamond_economic('mini_bbj_reserve_floor') IS NULL
    OR public.fn_ca_diamond_economic('mini_bbj_reserve_floor')<0 THEN
   RAISE EXCEPTION 'diamond_jackpot_activation_settings_incomplete';
 END IF;
 FOR v_drop IN SELECT DISTINCT scope FROM public.ca_diamond_economics
   WHERE name='bbj_drop_per_hand' AND scope LIKE 'bb:%' LOOP
   IF public.fn_ca_diamond_economic('bbj_drop_per_hand',v_drop.scope) IS NULL
      OR public.fn_ca_diamond_economic('bbj_drop_per_hand',v_drop.scope)<0
      OR public.fn_ca_diamond_economic('bbj_min_pot',v_drop.scope) IS NULL
      OR public.fn_ca_diamond_economic('mini_bbj_amount',v_drop.scope) IS NULL
      OR public.fn_ca_diamond_economic('mini_bbj_amount',v_drop.scope)<0 THEN
     RAISE EXCEPTION 'diamond_jackpot_activation_stake_incomplete:%',v_drop.scope;
   END IF;
 END LOOP;
 INSERT INTO public.ca_diamond_economics(name,scope,value,value_text,units,
   approved_quote,approved_on,basis,recorded_by)
 VALUES('bbj_enabled','all',NULL,'yes','boolean',
   'finish up everything thats still pending and not finished OR STILL NEEDS T OBE FIXED, IMPROVED, ENHANCED OR OPTIMIZED STILL',
   CURRENT_DATE,
   'Authorized Diamond Arena BBJ and Mini BBJ completion. Qualified immutable accepted-hand integration is installed; exact new engine and client identities and drained certified freeze are verified by the owning release receipt before this one-time switch append. Existing player-funded whole-Diamond drop, split and payout settings are unchanged.',
   'Codex Diamond Arena completion 01a13096');
END $activate$;
COMMIT;
