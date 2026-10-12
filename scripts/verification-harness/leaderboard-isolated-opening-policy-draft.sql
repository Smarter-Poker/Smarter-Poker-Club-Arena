-- UNQUALIFIED disposable-only regression preparation. Append after the exact
-- authorization fixture with ONLY its final ROLLBACK removed. Candidate function
-- replacements must already be installed in this same disposable database.
-- Every case self-aborts its subtransaction; final ROLLBACK removes all fixtures.
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $guard$ BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres'
    OR (SELECT count(*) FROM auth.users)<>5 OR (SELECT count(*) FROM public.clubs)<>3
    OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002'
      AND owner_id='90000000-0000-4000-8000-000000000002' AND chip_treasury=100000 AND promo_balance=0)
    OR EXISTS(SELECT 1 FROM public.club_opening_setups)
    OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches) THEN
    RAISE EXCEPTION 'Exact disposable opening fixture required';
  END IF;
END $guard$;
CREATE TEMP TABLE lb_opening_results(name text PRIMARY KEY,passed boolean,sqlstate text,stage text);
CREATE FUNCTION pg_temp.lb_opening_digest() RETURNS text LANGUAGE plpgsql AS $digest$
DECLARE relation text; rows jsonb; image jsonb:='{}'; BEGIN
  FOREACH relation IN ARRAY ARRAY['clubs','club_members','union_wallets','chip_ledger',
    'ca_mint_ledger','chip_transactions','wallet_transactions','club_wallet_transactions',
    'union_wallet_transactions','wallet_credit_idempotency','club_opening_setups',
    'club_opening_setup_funding','leaderboard_reward_program_versions','club_leaderboard_settings',
    'promotions','bbj_pools','spin_bonus_pools','spin_reserve_ledger','leaderboard_payout_batches'] LOOP
    EXECUTE format('SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.%I t',relation) INTO rows;
    image:=image||jsonb_build_object(relation,rows);
  END LOOP;
  RETURN md5(image::text);
END $digest$;
DO $cases$
DECLARE
  name text; stage text; state text; before_image text; replay_image text;
  club constant uuid:='92000000-0000-4000-8000-000000000002';
  owner constant uuid:='90000000-0000-4000-8000-000000000002';
  operation uuid; response jsonb; replay jsonb; rejected boolean;
  paid boolean; promotion boolean; extras boolean; overlay boolean;
  budget numeric; promo numeric; spin numeric; bbj numeric; bank numeric;
  correlation uuid; bbj_before numeric; spin_before numeric;
BEGIN
  FOREACH name IN ARRAY ARRAY['paid_opening_promo_seed_zero','combined_promo_conservation',
    'display_only','insufficient_bank_atomic','overlay_atomic','same_identity_retry',
    'nested_publish_rollback','bbj_spins_unchanged'] LOOP
    BEGIN
      stage:='prepare'; operation:=gen_random_uuid(); paid:=name<>'display_only';
      promotion:=name='combined_promo_conservation'; extras:=name='bbj_spins_unchanged';
      overlay:=name='overlay_atomic'; budget:=CASE WHEN paid THEN 100 ELSE 0 END;
      promo:=CASE WHEN promotion THEN 100 ELSE 0 END;
      spin:=CASE WHEN extras THEN GREATEST(100,public.fn_spin_required_seed(1)) ELSE 0 END;
      bbj:=CASE WHEN extras THEN 100 ELSE 0 END;
      IF name='insufficient_bank_atomic' THEN budget:=100001; END IF;
      IF name='nested_publish_rollback' THEN
        SELECT operation_id INTO operation FROM public.leaderboard_reward_program_versions
          WHERE club_id=club ORDER BY version DESC LIMIT 1;
        IF operation IS NULL THEN RAISE EXCEPTION 'Existing exact publication operation required'; END IF;
      END IF;
      SELECT chip_treasury INTO bank FROM public.clubs WHERE id=club;
      SELECT COALESCE(sum(main_balance),0) INTO bbj_before FROM public.bbj_pools WHERE club_id=club AND union_id IS NULL;
      SELECT COALESCE(sum(balance),0) INTO spin_before FROM public.spin_bonus_pools WHERE club_id=club;
      correlation:=gen_random_uuid(); PERFORM set_config('app.ledger_correlation',correlation::text,true);
      before_image:=pg_temp.lb_opening_digest();
      PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
      PERFORM set_config('request.jwt.claim.sub',owner::text,true);
      PERFORM set_config('request.jwt.claim.role','authenticated',true);
      stage:='actual_opening'; rejected:=false;
      BEGIN
        SET LOCAL ROLE authenticated;
        response:=public.fn_complete_club_opening_setup(club,operation,'Disposable Opening Policy',
          -1,-1,extras,bbj,extras,spin,1,promotion,'leaderboard','Opening Promotion','',
          promo,paid,'profit',budget,overlay);
        RESET ROLE;
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        IF name='overlay_atomic' AND SQLSTATE='22023' AND SQLERRM=
          'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes' THEN rejected:=true;
        ELSIF name='insufficient_bank_atomic' AND SQLSTATE='P0001'
          AND SQLERRM LIKE 'Club Bank Has % Chips But Setup Requires %' THEN rejected:=true;
        ELSIF name='nested_publish_rollback' AND SQLSTATE='22023'
          AND SQLERRM='Leaderboard Publication Retry Key Was Reused For Different Prize Rules' THEN rejected:=true;
        ELSE RAISE; END IF;
      END;
      stage:='independent_readback';
      IF name IN('insufficient_bank_atomic','overlay_atomic','nested_publish_rollback') THEN
        IF NOT rejected OR pg_temp.lb_opening_digest() IS DISTINCT FROM before_image THEN
          RAISE EXCEPTION 'Opening refusal was not exact and atomic';
        END IF;
      ELSE
        IF rejected OR (response->>'success')::boolean IS DISTINCT FROM true
          OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM bank-budget-promo-spin-bbj
          OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM budget+promo
          OR (SELECT leaderboard_seed_remaining FROM public.club_opening_setups WHERE club_id=club) IS DISTINCT FROM 0
          OR (SELECT COALESCE(sum(amount),0) FROM public.club_opening_setup_funding WHERE club_id=club AND operation_id=operation)
             IS DISTINCT FROM budget+promo+spin+bbj THEN
          RAISE EXCEPTION 'Opening allocation conservation differs';
        END IF;
        IF paid AND NOT EXISTS(SELECT 1 FROM public.club_opening_setup_funding WHERE club_id=club
          AND operation_id=operation AND destination='leaderboard_prizes' AND amount=budget AND balance_after=budget+promo) THEN
          RAISE EXCEPTION 'Leaderboard actual Promo evidence missing';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.leaderboard_reward_program_versions WHERE club_id=club
          AND operation_id=operation AND rewards_enabled=paid AND NOT overlay_enabled) THEN
          RAISE EXCEPTION 'Opening publication identity differs';
        END IF;
        IF extras THEN
          IF NOT EXISTS(SELECT 1 FROM public.club_opening_setup_funding WHERE club_id=club AND operation_id=operation
              AND destination='bbj_main' AND amount=bbj)
            OR NOT EXISTS(SELECT 1 FROM public.club_opening_setup_funding WHERE club_id=club AND operation_id=operation
              AND destination='spin_reserve' AND amount=spin) THEN
            RAISE EXCEPTION 'BBJ/Spins owner allocation evidence differs';
          END IF;
          IF (SELECT COALESCE(sum(main_balance),0) FROM public.bbj_pools WHERE club_id=club AND union_id IS NULL)
               IS DISTINCT FROM bbj_before+bbj
            OR (SELECT COALESCE(sum(balance),0) FROM public.spin_bonus_pools WHERE club_id=club) IS DISTINCT FROM spin_before+spin
            OR NOT EXISTS(SELECT 1 FROM public.spin_bonus_pools WHERE club_id=club AND is_active
              AND seed_source_wallet='chip_treasury' AND seeded_amount=spin AND offered_max_stake=1
              AND activated_by=owner AND required_seed_at_activation=public.fn_spin_required_seed(1))
            OR (SELECT count(*) FROM public.spin_reserve_ledger WHERE club_id=club AND kind='seed' AND amount=spin AND balance_after=spin_before+spin)<>1
            OR (SELECT count(*) FROM public.spin_reserve_ledger WHERE club_id=club AND kind='activation' AND amount=0 AND balance_after=spin_before+spin)<>1 THEN
            RAISE EXCEPTION 'BBJ/Spins actual reserve readback differs';
          END IF;
        END IF;
        -- Independent journal net deltas, not sum-of-legs (one transfer can
        -- legitimately book one named leg or two via opening_setup).
        IF (SELECT COALESCE(sum(CASE WHEN to_type='club_treasury' AND to_entity_id=club THEN amount ELSE 0 END
              - CASE WHEN from_type='club_treasury' AND from_entity_id=club THEN amount ELSE 0 END),0)
              FROM public.chip_ledger WHERE correlation_id=correlation) IS DISTINCT FROM -(budget+promo+spin+bbj)
          OR (SELECT COALESCE(sum(CASE WHEN to_type='promo_wallet' AND to_entity_id=club THEN amount ELSE 0 END
              - CASE WHEN from_type='promo_wallet' AND from_entity_id=club THEN amount ELSE 0 END),0)
              FROM public.chip_ledger WHERE correlation_id=correlation) IS DISTINCT FROM budget+promo
          OR (SELECT COALESCE(sum(CASE WHEN to_type='spin_reserve' AND to_entity_id IN(SELECT id FROM public.spin_bonus_pools WHERE club_id=club) THEN amount ELSE 0 END
              - CASE WHEN from_type='spin_reserve' AND from_entity_id IN(SELECT id FROM public.spin_bonus_pools WHERE club_id=club) THEN amount ELSE 0 END),0)
              FROM public.chip_ledger WHERE correlation_id=correlation) IS DISTINCT FROM spin
          OR (SELECT COALESCE(sum(CASE WHEN to_type='bbj_pool' AND to_entity_id IN(SELECT id FROM public.bbj_pools WHERE club_id=club) THEN amount ELSE 0 END
              - CASE WHEN from_type='bbj_pool' AND from_entity_id IN(SELECT id FROM public.bbj_pools WHERE club_id=club) THEN amount ELSE 0 END),0)
              FROM public.chip_ledger WHERE correlation_id=correlation) IS DISTINCT FROM bbj THEN
          RAISE EXCEPTION 'Opening journal destination conservation differs';
        END IF;
        IF name='same_identity_retry' THEN
          stage:='retry'; replay_image:=pg_temp.lb_opening_digest();
          SET LOCAL ROLE authenticated;
          replay:=public.fn_complete_club_opening_setup(club,operation,'Disposable Opening Policy',
            -1,-1,false,0,false,0,1,false,'leaderboard','Opening Promotion','',0,true,'profit',100,false);
          RESET ROLE;
          IF (replay->>'already_completed')::boolean IS DISTINCT FROM true
            OR replay->>'operation_id' IS DISTINCT FROM operation::text
            OR pg_temp.lb_opening_digest() IS DISTINCT FROM replay_image THEN
            RAISE EXCEPTION 'Opening replay changed durable state';
          END IF;
        END IF;
      END IF;
      stage:='deferred_constraints'; SET CONSTRAINTS ALL IMMEDIATE;
      RAISE EXCEPTION USING ERRCODE='ZLO01',MESSAGE='DisposableCasePassedAndRolledBack';
    EXCEPTION WHEN SQLSTATE 'ZLO01' THEN INSERT INTO lb_opening_results VALUES(name,true,NULL,NULL);
      WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE;
        INSERT INTO lb_opening_results VALUES(name,false,state,stage);
    END;
  END LOOP;
END $cases$;
TABLE lb_opening_results;
DO $verdict$ BEGIN
  IF (SELECT count(*) FROM lb_opening_results)<>8 OR EXISTS(SELECT 1 FROM lb_opening_results WHERE NOT passed) THEN
    RAISE EXCEPTION 'Opening draft unresolved; no qualification claimed';
  END IF;
END $verdict$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
