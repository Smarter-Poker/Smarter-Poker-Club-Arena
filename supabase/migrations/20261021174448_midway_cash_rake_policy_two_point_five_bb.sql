-- Midway Union: 2.5 BB maximum at every cash stake/variant. Standalone clubs
-- inherit that default and may publish their own rate/cap. BBJ and tournament
-- entry fees are unchanged. No historical rows or money are rewritten.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.hand_history ADD COLUMN cash_rake_policy jsonb;
COMMENT ON COLUMN public.hand_history.cash_rake_policy IS
  'Frozen dealt chip-cash rake configuration, versioned independently of the historical stake/BBJ specification. NULL for older hands and Diamond/tournament hands.';

ALTER TABLE public.tables DROP CONSTRAINT tables_rake_percent_range,
  DROP CONSTRAINT tables_rake_cap_bb_range;
ALTER TABLE public.tables ADD CONSTRAINT tables_rake_percent_range CHECK
  (rake_percent IS NULL OR rake_percent = -1 OR (rake_percent >= 0 AND rake_percent <= 100)) NOT VALID,
  ADD CONSTRAINT tables_rake_cap_bb_range CHECK
  (rake_cap_bb IS NULL OR rake_cap_bb = -1 OR (rake_cap_bb >= 0 AND rake_cap_bb NOT IN ('NaN'::numeric, 'Infinity'::numeric))) NOT VALID;
ALTER TABLE public.clubs DROP CONSTRAINT clubs_default_rake_percent_range,
  DROP CONSTRAINT clubs_rake_cap_range;
ALTER TABLE public.clubs ADD CONSTRAINT clubs_default_rake_percent_range CHECK
  (default_rake_percent IS NULL OR default_rake_percent = -1 OR (default_rake_percent >= 0 AND default_rake_percent <= 100)) NOT VALID,
  ADD CONSTRAINT clubs_rake_cap_range CHECK
  (rake_cap IS NULL OR rake_cap = -1 OR (rake_cap >= 0 AND rake_cap NOT IN ('NaN'::numeric, 'Infinity'::numeric))) NOT VALID;

CREATE FUNCTION public.fn_cash_rake_policy(p_table_id uuid)
RETURNS TABLE(scope text, percent numeric, cap_bb numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public, pg_temp AS $fn$
  WITH p AS (
    SELECT CASE WHEN t.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
                     OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid THEN 'midway'
                WHEN t.union_id IS NULL AND c.id IS NOT NULL AND c.union_id IS NULL THEN 'standalone'
                ELSE 'standard' END AS scope,
           COALESCE(CASE WHEN t.rake_percent >= 0 THEN t.rake_percent END,
                    CASE WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END, 10) AS pct,
           COALESCE(CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb END,
                    CASE WHEN c.rake_cap >= 0 THEN c.rake_cap END, 2.5) AS cap
      FROM public.tables t LEFT JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=p_table_id AND t.tournament_id IS NULL
  ) SELECT scope, LEAST(pct, CASE WHEN scope='standalone' THEN 100 ELSE 10 END),
           CASE WHEN scope='standalone' THEN cap ELSE LEAST(cap,2.5) END FROM p;
$fn$;
REVOKE ALL ON FUNCTION public.fn_cash_rake_policy(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_rake_policy(uuid) TO service_role;

-- Normalize out-of-policy future caps at the original write boundary. Existing
-- inherit sentinels remain inherit; runtime applies the policy even to old rows.
CREATE FUNCTION public.fn_midway_cash_rake_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp AS $fn$
DECLARE v_union uuid; v_asset text;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    IF NEW.asset='diamonds' THEN RETURN NEW; END IF;
    IF NEW.union_id='fade0000-0000-0000-0000-000000000001'::uuid
       OR NEW.id='fade0000-0000-0000-0000-000000000001'::uuid THEN
      NEW.rake_cap := CASE WHEN NEW.rake_cap > 2.5 THEN 2.5 ELSE NEW.rake_cap END;
      IF NEW.default_rake_percent > 10 THEN
        RAISE EXCEPTION 'Midway Cash Rake Is Limited To 10 Percent And 2.5 BB';
      END IF;
    END IF;
  ELSE
    IF NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
    SELECT c.union_id,c.asset INTO v_union,v_asset FROM public.clubs c WHERE c.id=NEW.club_id;
    IF v_asset='diamonds' THEN RETURN NEW; END IF;
    IF NEW.union_id='fade0000-0000-0000-0000-000000000001'::uuid
       OR v_union='fade0000-0000-0000-0000-000000000001'::uuid THEN
      NEW.rake_cap_bb := CASE WHEN NEW.rake_cap_bb > 2.5 THEN 2.5 ELSE NEW.rake_cap_bb END;
      IF NEW.rake_percent > 10 THEN
        RAISE EXCEPTION 'Midway Cash Rake Is Limited To 10 Percent And 2.5 BB';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_midway_cash_rake_write_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER midway_cash_rake_write_guard BEFORE INSERT OR UPDATE OF rake_percent,rake_cap_bb,club_id,union_id
 ON public.tables FOR EACH ROW EXECUTE FUNCTION public.fn_midway_cash_rake_write_guard();
CREATE TRIGGER midway_cash_rake_write_guard BEFORE INSERT OR UPDATE OF default_rake_percent,rake_cap,union_id
 ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.fn_midway_cash_rake_write_guard();

-- Recompute from the configuration captured when THIS hand was dealt. An
-- operator edit or an engine rollout must not retroactively reprice old hands.
CREATE FUNCTION public.fn_cash_rake_from_snapshot(p_pot numeric,p_dealt integer,p_saw_flop boolean,p_policy jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path TO public, pg_temp AS $fn$
DECLARE v_pct numeric; v_cap numeric; v_rung jsonb;
BEGIN
  IF p_policy->'cashPolicy'->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Unknown Cash Rake Policy Version';
  END IF;
  v_pct := (p_policy->>'percent')::numeric;
  v_cap := (p_policy->>'cap')::numeric;
  IF v_pct IS NULL OR v_pct NOT BETWEEN 0 AND 100 OR v_cap IS NULL OR v_cap < 0
     OR v_cap IN ('NaN'::numeric,'Infinity'::numeric) THEN
    RAISE EXCEPTION 'Invalid Cash Rake Policy Snapshot';
  END IF;
  IF COALESCE(p_dealt,0)<=2 THEN v_pct:=LEAST(v_pct,5); END IF;
  SELECT x INTO v_rung FROM jsonb_array_elements(p_policy->'playerCountCaps') x
   WHERE (x->>'players')::integer<=p_dealt ORDER BY (x->>'players')::integer DESC LIMIT 1;
  IF v_rung IS NOT NULL THEN v_cap:=LEAST(v_cap,(v_rung->>'cap')::numeric); END IF;
  IF NOT COALESCE(p_saw_flop,false) AND COALESCE((p_policy->>'noFlopNoDrop')::boolean,true) THEN RETURN 0; END IF;
  RETURN LEAST(round(COALESCE(p_pot,0)*v_pct,0)/100,v_cap);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_cash_rake_from_snapshot(numeric,integer,boolean,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_rake_from_snapshot(numeric,integer,boolean,jsonb) TO service_role;

DO $patch$
DECLARE v_before text; v_owner oid; v_acl aclitem[]; v_settings text[]; v_secdef boolean;
BEGIN
  v_before := pg_get_functiondef('public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure);
  IF md5(v_before) <> 'af3dc9e20983b85167bd126451a57e1c' THEN RAISE EXCEPTION 'fn_complete_club_opening_setup preimage mismatch'; END IF;
  SELECT proowner,proacl,proconfig,prosecdef INTO v_owner,v_acl,v_settings,v_secdef
    FROM pg_proc WHERE oid='public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure;
  IF 'fn_complete_club_opening_setup'=ANY(public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_complete_club_opening_setup','migration 20261021174448 midway cash policy');
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_complete_club_opening_setup(p_club_id uuid, p_operation_id uuid, p_tagline text, p_rake_percent numeric, p_rake_cap_bb numeric, p_bbj_enabled boolean, p_bbj_seed numeric, p_spins_enabled boolean, p_spin_seed numeric, p_spin_max_stake numeric, p_promo_enabled boolean, p_promo_type text, p_promo_name text, p_promo_description text, p_promo_budget numeric, p_leaderboard_rewards_enabled boolean, p_leaderboard_metric text, p_leaderboard_prize_budget numeric, p_leaderboard_overlay_enabled boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club public.clubs%ROWTYPE;
  v_existing public.club_opening_setups%ROWTYPE;
  v_rake numeric := round(COALESCE(p_rake_percent, -1), 2);
  v_cap numeric := round(COALESCE(p_rake_cap_bb, -1), 2);
  v_bbj_seed numeric := round(COALESCE(p_bbj_seed, 0), 2);
  v_spin_seed numeric := round(COALESCE(p_spin_seed, 0), 2);
  v_promo_budget numeric := round(COALESCE(p_promo_budget, 0), 2);
  v_leaderboard_budget numeric := round(COALESCE(p_leaderboard_prize_budget, 0), 2);
  v_spin_required numeric := 0;
  v_other_allocation numeric := 0;
  v_total_allocation numeric := 0;
  v_spin_result jsonb := '{}'::jsonb;
  v_pool_id uuid;
  v_bbj_after numeric := 0;
  v_promo_after numeric := 0;
  v_promotion_id uuid;
  v_leaderboard_result jsonb := '{}'::jsonb;
  v_program_version integer := 0;
  v_leaderboard_overlay boolean := COALESCE(p_leaderboard_rewards_enabled, false)
    AND COALESCE(p_leaderboard_overlay_enabled, false);
  v_bank_after numeric := 0;
  v_result jsonb;
  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '')), '\s+', ' ', 'g'), 72);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication Required';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID Is Required';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found';
  END IF;

  -- ONLY THE OWNER CAN COMPLETE IT, AND EVERYONE ELSE IS REFUSED HERE
  -- (2026-09-23). Every setup publishes a leaderboard program, and
  -- publication accepts only the club's owner or co-owner. The
  -- platform-admin branch that used to pass this check could never commit:
  -- it activated Spins and debited the Club Bank, then the publish refused
  -- it with 42501 and rolled all of it back. A co-owner never passed here.
  -- The one actor who can complete the whole setup is the owner, so the
  -- owner is the rule, and the refusal comes before anything moves.
  IF v_club.owner_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only The Club Owner Can Complete Opening Setup'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_club.is_union, false) OR v_club.union_id IS NOT NULL THEN
    RAISE EXCEPTION 'Union-Owned Economics Must Be Configured By The Union Lead';
  END IF;

  IF char_length(v_tagline) < 3 THEN
    RAISE EXCEPTION 'Write A Custom Club Tag Line Before Completing Setup';
  END IF;
  IF v_tagline ILIKE '%all fish of all shapes and sizes are welcome%'
     AND v_club.club_id <> 25450 THEN
    RAISE EXCEPTION 'That Tag Line Belongs To Shark Club';
  END IF;

  SELECT * INTO v_existing
  FROM public.club_opening_setups
  WHERE club_id = p_club_id
  FOR UPDATE;

  IF FOUND THEN
    v_result := jsonb_build_object(
      'success', true,
      'already_completed', true,
      'club_id', p_club_id,
      'club_bank_after', v_club.chip_treasury,
      'completed_at', v_existing.completed_at,
      'operation_id', v_existing.last_operation_id
    );
    RETURN v_result;
  END IF;

  IF COALESCE(p_leaderboard_overlay_enabled, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'
      USING ERRCODE = '22023';
  END IF;

  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 100) THEN
    RAISE EXCEPTION 'Rake Must Use The House Schedule Or Be Between 0 And 100 Percent';
  END IF;
  IF v_cap <> -1 AND (v_cap < 0 OR v_cap IN ('NaN'::numeric,'Infinity'::numeric)) THEN
    RAISE EXCEPTION 'Rake Cap Must Use The House Schedule Or Be A Finite Nonnegative Number Of Big Blinds';
  END IF;

  IF p_bbj_enabled AND v_bbj_seed < 100 THEN
    RAISE EXCEPTION 'BBJ Requires A Minimum 100-Chip Seed';
  END IF;
  IF NOT p_bbj_enabled THEN
    v_bbj_seed := 0;
  END IF;

  IF p_spins_enabled THEN
    IF p_spin_max_stake NOT IN (1, 2, 3, 5, 10, 20, 50, 100) THEN
      RAISE EXCEPTION 'Spin Maximum Stake Is Not A Supported Board Stake';
    END IF;
    v_spin_required := public.fn_spin_required_seed(p_spin_max_stake);
    IF v_spin_seed < GREATEST(100, v_spin_required) THEN
      RAISE EXCEPTION 'Spin Seed Must Be At Least % Chips For The Selected Board',
        GREATEST(100, v_spin_required);
    END IF;
  ELSE
    v_spin_seed := 0;
  END IF;

  IF p_promo_enabled THEN
    IF p_promo_type NOT IN ('leaderboard', 'rake_race', 'milestone', 'mystery', 'high_hand') THEN
      RAISE EXCEPTION 'Promotion Type Is Not Supported';
    END IF;
    IF length(btrim(COALESCE(p_promo_name, ''))) < 3 THEN
      RAISE EXCEPTION 'Promotion Name Must Be At Least 3 Characters';
    END IF;
    IF v_promo_budget < 100 THEN
      RAISE EXCEPTION 'A New Promotion Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_promo_budget := 0;
  END IF;

  IF p_leaderboard_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Leaderboard Metric Is Not Supported';
  END IF;
  IF p_leaderboard_rewards_enabled THEN
    IF v_leaderboard_budget < 100 THEN
      RAISE EXCEPTION 'A Prize Leaderboard Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_leaderboard_budget := 0;
  END IF;

  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;
  v_total_allocation := v_other_allocation + v_spin_seed;
  IF COALESCE(v_club.chip_treasury, 0) < v_total_allocation THEN
    RAISE EXCEPTION 'Club Bank Has % Chips But Setup Requires %',
      COALESCE(v_club.chip_treasury, 0), v_total_allocation;
  END IF;

  -- Spin activation owns its wallet debit, reserve credit, repayment metadata,
  -- and reserve ledger. Calling it inside this function keeps all setup steps
  -- in the same database transaction.
  IF p_spins_enabled THEN
    v_spin_result := public.fn_spin_activate(
      p_club_id,
      v_spin_seed,
      p_spin_max_stake,
      'chip_treasury',
      v_actor
    );
    IF NOT COALESCE((v_spin_result ->> 'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin Setup Failed: %', COALESCE(v_spin_result ->> 'reason', 'Unknown Reason');
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'spin_reserve', v_spin_seed,
      COALESCE((v_spin_result ->> 'balance')::numeric, v_spin_seed), v_actor
    );
  END IF;

  PERFORM set_config('app.ledger_category', 'club_opening_allocation', true);
  PERFORM set_config('app.ledger_counterparty', 'opening_setup', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  UPDATE public.clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) - v_other_allocation,
      promo_balance = COALESCE(promo_balance, 0) + v_promo_budget + v_leaderboard_budget,
      tagline = v_tagline,
      default_rake_percent = v_rake,
      rake_cap = v_cap,
      bbj_enabled = p_bbj_enabled,
      bbj_rake_enabled = p_bbj_enabled,
      spins_enabled = p_spins_enabled,
      spins_preseed_amount = v_spin_seed,
      spins_wallet_funding = 'CHIP_TREASURY',
      updated_at = now()
  WHERE id = p_club_id
  RETURNING chip_treasury, promo_balance INTO v_bank_after, v_promo_after;

  IF p_bbj_enabled THEN
    SELECT pool.id INTO v_pool_id
    FROM public.bbj_pools pool
    WHERE pool.club_id = p_club_id AND pool.union_id IS NULL
    ORDER BY (pool.status = 'active') DESC, pool.created_at
    LIMIT 1
    FOR UPDATE;

    IF v_pool_id IS NULL THEN
      INSERT INTO public.bbj_pools
        (club_id, main_balance, backup_balance, promo_balance, pool_amount, status)
      VALUES (p_club_id, v_bbj_seed, 0, 0, 0, 'active')
      RETURNING id, main_balance INTO v_pool_id, v_bbj_after;
    ELSE
      UPDATE public.bbj_pools
      SET main_balance = main_balance + v_bbj_seed,
          status = 'active',
          updated_at = now()
      WHERE id = v_pool_id
      RETURNING main_balance INTO v_bbj_after;
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'bbj_main', v_bbj_seed, v_bbj_after, v_actor);
  END IF;

  IF p_promo_enabled THEN
    INSERT INTO public.promotions (
      club_id, name, description, type, start_date, end_date, status,
      prize_pool, requirements, opt_in_required
    ) VALUES (
      p_club_id,
      left(btrim(p_promo_name), 80),
      left(btrim(COALESCE(p_promo_description, '')), 500),
      p_promo_type,
      now(),
      now() + interval '30 days',
      'active',
      v_promo_budget,
      'Created During Club Opening Setup',
      true
    ) RETURNING id INTO v_promotion_id;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'promo_wallet', v_promo_budget, v_promo_after, v_actor);
  END IF;

  -- New prize allocation is held in actual Promo; no new opening seed.
  INSERT INTO public.club_opening_setups (
    club_id, owner_id, rake_mode, rake_percent, rake_cap_bb,
    bbj_enabled, bbj_seeded_amount,
    spins_enabled, spin_seeded_amount, spin_max_stake,
    promo_enabled, promo_budget, promotion_id,
    leaderboard_rewards_enabled, leaderboard_metric, leaderboard_prize_budget,
    leaderboard_seed_remaining,
    last_operation_id
  ) VALUES (
    p_club_id, v_club.owner_id,
    CASE WHEN v_rake = -1 AND v_cap = -1 THEN 'house_schedule' ELSE 'custom' END,
    v_rake, v_cap,
    p_bbj_enabled, v_bbj_seed,
    p_spins_enabled, v_spin_seed, CASE WHEN p_spins_enabled THEN p_spin_max_stake ELSE 0 END,
    p_promo_enabled, v_promo_budget, v_promotion_id,
    p_leaderboard_rewards_enabled, p_leaderboard_metric, v_leaderboard_budget,
    0,
    p_operation_id
  );

  -- The program's current version, read under the club lock taken above.
  -- Publication locks this same club row, so nothing can publish between
  -- this read and the publish below. The hard-coded 0 this replaces refused
  -- (40001) every club that already had a program, even for Display Only.
  SELECT COALESCE(max(program.version), 0)
    INTO v_program_version
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id;

  -- Leaderboards always receive an explicit program. Display-only is the
  -- safe launch default; a paid program publishes a balanced weekly
  -- top-three plan that sums exactly to the new actual Promo allocation.
  -- New Club Bank overlays are refused before allocations.
  v_leaderboard_result := public.fn_publish_leaderboard_reward_program(
    p_club_id,
    p_leaderboard_rewards_enabled,
    p_leaderboard_metric,
    CASE WHEN p_leaderboard_rewards_enabled THEN jsonb_build_array(
      jsonb_build_object('rank', 1, 'amount', round(v_leaderboard_budget * 0.50, 2)),
      jsonb_build_object('rank', 2, 'amount', round(v_leaderboard_budget * 0.30, 2)),
      jsonb_build_object('rank', 3, 'amount', v_leaderboard_budget
        - round(v_leaderboard_budget * 0.50, 2)
        - round(v_leaderboard_budget * 0.30, 2))
    ) ELSE '[]'::jsonb END,
    '[]'::jsonb,
    'balanced',
    v_program_version,
    p_operation_id,
    v_leaderboard_overlay
  );

  IF p_leaderboard_rewards_enabled THEN
    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'leaderboard_prizes',
      v_leaderboard_budget, v_promo_after, v_actor
    );
  END IF;


  v_result := jsonb_build_object(
    'success', true,
    'already_completed', false,
    'club_id', p_club_id,
    'club_bank_after', v_bank_after,
    'allocated', v_total_allocation,
    'bbj_seeded', v_bbj_seed,
    'spin_seeded', v_spin_seed,
    'promo_budget', v_promo_budget,
    'promotion_id', v_promotion_id,
    'leaderboard_rewards_enabled', p_leaderboard_rewards_enabled,
    'leaderboard_prize_budget', v_leaderboard_budget,
    'leaderboard_overlay_enabled', v_leaderboard_overlay,
    'leaderboard', v_leaderboard_result,
    'spin', v_spin_result,
    'operation_id', p_operation_id
  );
  RETURN v_result;
END;
$function$
$definition$;
  IF md5(pg_get_functiondef('public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure)) <> 'aee7b2ccf1627d2e26f86f663c559648' THEN
    RAISE EXCEPTION 'fn_complete_club_opening_setup postimage mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure
    AND proowner=v_owner AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_settings AND prosecdef=v_secdef)
  THEN RAISE EXCEPTION 'fn_complete_club_opening_setup security identity changed'; END IF;
  IF 'fn_complete_club_opening_setup'=ANY(public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_complete_club_opening_setup','migration 20261021174448 midway cash policy');
  END IF;
END $patch$;
DO $patch$
DECLARE v_before text; v_owner oid; v_acl aclitem[]; v_settings text[]; v_secdef boolean;
BEGIN
  v_before := pg_get_functiondef('public.fn_rake_law_violations(interval)'::regprocedure);
  IF md5(v_before) <> '6fe1606ee718c52848c28fb1774673ea' THEN RAISE EXCEPTION 'fn_rake_law_violations preimage mismatch'; END IF;
  SELECT proowner,proacl,proconfig,prosecdef INTO v_owner,v_acl,v_settings,v_secdef
    FROM pg_proc WHERE oid='public.fn_rake_law_violations(interval)'::regprocedure;
  IF 'fn_rake_law_violations'=ANY(public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_rake_law_violations','migration 20261021174448 midway cash policy');
  END IF;
  EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_rake_law_violations(p_window interval DEFAULT '01:00:00'::interval)
 RETURNS TABLE(kind text, hand_id uuid, table_id uuid, occurred_at timestamp with time zone, small_blind numeric, big_blind numeric, pot numeric, rake numeric, allowed numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) AS bbj,
           hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb, t.club_id, t.id AS tid,
           t.max_players AS seats,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END), rr.num_players) AS dealt,
           COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
           hh.showdown IS NOT NULL AS has_showdown,
           /* The record says which street each action happened on. Read it,
              rather than guessing a flop from how many people put chips in:
              an ordinary multiway preflop pot clears any such count. */
           EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                    WHERE lower(COALESCE(a->>'stage', '')) IN ('flop','turn','river')
                       OR lower(COALESCE(a->'publicNode'->>'street', '')) IN ('flop','turn','river'))
             AS played_past_preflop,
           /* "I cannot tell" is its own outcome and must not be filed as
              "ended preflop": a hand with actions, none of which names a
              stage, is an unreadable record and stays a finding. */
           (jsonb_array_length(COALESCE(hh.actions, '[]'::jsonb)) > 0
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                              WHERE NULLIF(btrim(COALESCE(a->>'stage', '')), '') IS NOT NULL))
             AS streets_unreadable,
           CASE WHEN t.rake_percent >= 0 THEN t.rake_percent
                WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END AS ov_pct,
           CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb
                WHEN c.rake_cap >= 0 THEN c.rake_cap END AS ov_cap_bb,
           c.bbj_rake_enabled,
           hh.hand_number,
           hh.cash_rake_policy,
           /* A DIAMOND HAND IS NOT PRICED BY THE CHIP SPEC (2026-10-08). A
              Diamond table's rake_percent and rake_cap_bb are explicitly zero
              by rule (DiamondCashBoundary), so the chip spec reads them as a
              0% override; the hand is priced from ca_diamond_economics and
              fn_poker_diamond_settle_cash_hand refuses any other number. */
           COALESCE(c.asset = 'diamonds', false) AS diamond
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
      LEFT JOIN public.clubs c ON c.id = t.club_id
      LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'
       AND t.tournament_id IS NULL
       AND hh.tournament_id IS NULL
  ), f AS (
    SELECT h.*, CASE WHEN h.cash_rake_policy IS NOT NULL
                THEN public.fn_cash_rake_from_snapshot(h.pot,h.dealt,true,h.cash_rake_policy)
                ELSE e.rake END AS exp_rake
      FROM h
      CROSS JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb, h.seats) e
     WHERE h.board_n >= 3 AND h.dealt IS NOT NULL
       AND NOT h.diamond
  ), fb AS (
    SELECT f.*, public.fn_effective_bbj_drop(f.bb, f.dealt, true, f.club_id, f.tid, f.variant, f.sb, f.pot, f.rake) AS exp_bbj
      FROM f
  ), h0 AS (
    SELECT hh.id, hh.table_id, hh.created_at, hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) = 0
       AND hh.showdown IS NOT NULL
       AND COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) < 3
  ), hd AS (
    -- The Diamond rake law is the settler's recompute: the rake this hand
    -- recorded must be the rake its settlement receipt accepted.
    SELECT h.*,
           (SELECT (r.receipt->>'rake')::numeric
              FROM public.poker_diamond_hand_receipts r
             WHERE r.table_id = h.table_id AND r.hand_number = h.hand_number) AS settled_rake
      FROM h
     WHERE h.diamond
  )
  SELECT 'over_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake > exp_rake + 0.005
  UNION ALL
  SELECT 'under_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake < exp_rake - 0.005
  UNION ALL
  SELECT 'bbj_over_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj > exp_bbj + 0.005
  UNION ALL
  SELECT 'bbj_under_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj < exp_bbj - 0.005
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake, 0::numeric
    FROM h WHERE board_n = 0 AND NOT has_showdown AND rake + bbj > 0.005
     AND NOT diamond
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE board_n = 0 AND (has_showdown OR played_past_preflop OR streets_unreadable)
  UNION ALL
  SELECT 'impossible_showdown', id, table_id, created_at, sb, bb, pot, 0::numeric, NULL::numeric
    FROM h0
  UNION ALL
  SELECT 'players_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE dealt IS NULL AND board_n >= 3
  UNION ALL
  SELECT 'bbj_club_switch_ignored', id, table_id, created_at, sb, bb, pot, bbj, 0::numeric
    FROM h WHERE bbj_rake_enabled IS FALSE AND bbj > 0.005
  UNION ALL
  SELECT 'diamond_rake_unsettled', id, table_id, created_at, sb, bb, pot, rake, settled_rake
    FROM hd WHERE settled_rake IS DISTINCT FROM rake AND (settled_rake IS NOT NULL OR rake > 0.005);
$function$
$definition$;
  IF md5(pg_get_functiondef('public.fn_rake_law_violations(interval)'::regprocedure)) <> '69381ead05c4100837a85962c1352999' THEN
    RAISE EXCEPTION 'fn_rake_law_violations postimage mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_rake_law_violations(interval)'::regprocedure
    AND proowner=v_owner AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_settings AND prosecdef=v_secdef)
  THEN RAISE EXCEPTION 'fn_rake_law_violations security identity changed'; END IF;
  IF 'fn_rake_law_violations'=ANY(public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_rake_law_violations','migration 20261021174448 midway cash policy');
  END IF;
END $patch$;

-- Keep the operational reader aligned with the versioned cash policy.
DO $patch$
DECLARE v_acl aclitem[]; v_owner oid; v_cfg text[]; v_secdef boolean;
BEGIN
 IF md5(pg_get_functiondef('public.fn_effective_rake_config(uuid)'::regprocedure))<>'b78323bb4b98b5e1372f9560931a1640' THEN
   RAISE EXCEPTION 'fn_effective_rake_config preimage mismatch'; END IF;
 SELECT proacl,proowner,proconfig,prosecdef INTO v_acl,v_owner,v_cfg,v_secdef FROM pg_proc WHERE oid='public.fn_effective_rake_config(uuid)'::regprocedure;
 IF 'fn_effective_rake_config'=ANY(public.fn_ca_guard_watchlist()) THEN
  PERFORM public.fn_ca_declare_guard_redefinition('fn_effective_rake_config','migration 20261021174448 midway cash policy');
 END IF;
 EXECUTE $definition$
CREATE OR REPLACE FUNCTION public.fn_effective_rake_config(p_table_id uuid)
 RETURNS TABLE(table_id uuid, club_name text, source text, effective_percent numeric, effective_cap_bb numeric, note text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public, pg_temp AS $function$
 SELECT t.id,c.name,p.scope || ' cash policy v1',p.percent,p.cap_bb,
        'Cash policy v1 requires serving cashRakePolicyVersion=1; BBJ is independent.'
 FROM public.tables t LEFT JOIN public.clubs c ON c.id=t.club_id
 CROSS JOIN LATERAL public.fn_cash_rake_policy(t.id) p WHERE t.id=p_table_id;
$function$;
$definition$;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_effective_rake_config(uuid)'::regprocedure
   AND proacl IS NOT DISTINCT FROM v_acl AND proowner=v_owner AND proconfig IS NOT DISTINCT FROM v_cfg AND prosecdef=v_secdef)
 THEN RAISE EXCEPTION 'cash policy reader security changed'; END IF;
 IF 'fn_effective_rake_config'=ANY(public.fn_ca_guard_watchlist()) THEN
  PERFORM public.fn_ca_declare_guard_redefinition('fn_effective_rake_config','migration 20261021174448 midway cash policy');
 END IF;
END $patch$;

COMMIT;
