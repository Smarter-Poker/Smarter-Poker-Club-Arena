-- UNQUALIFIED / UNWIRED / UNEXECUTED. Normative original Promo-only policy.
-- Append in the SAME isolated transaction after the real SQL authorization
-- fixture matrix, BEFORE its final ROLLBACK. Never execute on production.
-- Synthetic current-schema configuration (including ca_mint_policy) must be
-- established independently. No production configuration rows may be copied.
-- Missing-wallet fault remains excluded until its deletion dependencies are
-- inspected; do not delete wallets or disable triggers to manufacture it.
-- SQL-role/JWT tests below do NOT qualify actual GoTrue/PostgREST sessions.
\set ON_ERROR_STOP on
-- Explicit BEGIN protects against accidental autocommit invocation. When
-- appended to the authorization transaction it does not create a nested commit.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $guard$
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
     OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
     OR (SELECT count(*) FROM auth.users)<>5
     OR EXISTS(SELECT 1 FROM auth.users WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
     OR (SELECT count(*) FROM public.clubs)<>3
     OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches)
     OR EXISTS(SELECT 1 FROM public.leaderboard_payouts)
     OR EXISTS(SELECT 1 FROM public.player_stats_snapshots)
     OR EXISTS(SELECT 1 FROM public.club_opening_setups)
     OR EXISTS(SELECT 1 FROM public.clubs WHERE promo_balance IS DISTINCT FROM 0)
     OR (SELECT count(*) FROM public.union_wallets)<>1
     OR EXISTS(SELECT 1 FROM public.union_wallets WHERE promo_wallet IS DISTINCT FROM 0 OR chip_balance IS DISTINCT FROM 0)
     OR NOT EXISTS(SELECT 1 FROM public.ca_mint_policy WHERE id=1) THEN
    RAISE EXCEPTION 'Fresh isolated authorization fixture and synthetic Mint policy required';
  END IF;
END;
$guard$;
CREATE TEMP TABLE lb_funding_policy_results(name text PRIMARY KEY,passed boolean,sqlstate text,stage text);
CREATE FUNCTION pg_temp.lb_funding_digest() RETURNS text LANGUAGE plpgsql AS $$
DECLARE relation text; state jsonb:='{}'; rows jsonb;
BEGIN
  FOREACH relation IN ARRAY ARRAY['clubs','club_members','union_wallets','chip_ledger',
    'ca_mint_ledger','chip_transactions','wallet_transactions','club_wallet_transactions',
    'union_wallet_transactions','wallet_credit_idempotency','leaderboard_payout_batches',
    'leaderboard_payouts','club_opening_setups','club_opening_setup_funding',
    'leaderboard_reward_program_versions','leaderboard_payout_failures'] LOOP
    EXECUTE format('SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.%I t',relation) INTO rows;
    state:=state||jsonb_build_object(relation,rows);
  END LOOP;
  RETURN md5(state::text);
END;
$$;
DO $cases$
DECLARE
  case_name text; club uuid; owner uuid; funding_union uuid;
  affiliate constant uuid:='92000000-0000-4000-8000-000000000001';
  standalone constant uuid:='92000000-0000-4000-8000-000000000002';
  fixture_union constant uuid:='91000000-0000-4000-8000-000000000001';
  player constant uuid:='90000000-0000-4000-8000-000000000004';
  starts date; ends date; next_month date; version_number integer;
  program uuid; terms jsonb; response jsonb; replay jsonb;
  before_state text; after_state text; refused boolean; actor text;
  bank_before numeric; club_bank_before numeric; club_promo_before numeric;
  seed_before numeric; player_before numeric; correlation uuid; batch uuid;
  shortage_op uuid; shortage_bank numeric; shortage_player numeric;
  stage text; error_state text; member_preimage jsonb; club_preimage jsonb; changed integer;
BEGIN
  SELECT start_date,end_date INTO starts,ends FROM public.fn_leaderboard_period_window('weekly',-1);
  SELECT end_date INTO next_month FROM public.fn_leaderboard_period_window('monthly',0);
  FOREACH case_name IN ARRAY ARRAY['union_promo_only_pays_once','union_underfunded_refuses',
    'standalone_bank_never_falls_back','positive_seed_never_used_or_released',
    'overlay_save_refuses_without_effects','settlement_sql_roles_refuse'] LOOP
    BEGIN
      stage:='fixture_identity';
      club:=CASE WHEN case_name LIKE 'union_%' THEN affiliate ELSE standalone END;
      owner:=CASE WHEN club=affiliate THEN '90000000-0000-4000-8000-000000000001'::uuid
        ELSE '90000000-0000-4000-8000-000000000002'::uuid END;
      funding_union:=CASE WHEN club=affiliate THEN fixture_union ELSE NULL END;
      IF club=affiliate THEN
        stage:='union_mint';
        PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
        PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
        PERFORM set_config('request.jwt.claim.role','service_role',true);
        SET LOCAL ROLE service_role;
        response:=public.fn_ca_mint('chips','union',fixture_union,100,
          'Disposable leaderboard policy fixture','lb_policy_union_mint','seeded');
        RESET ROLE;
        IF (response->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Synthetic union Mint refused'; END IF;
      END IF;
      PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
      PERFORM set_config('request.jwt.claim.sub',owner::text,true);
      PERFORM set_config('request.jwt.claim.role','authenticated',true);
      IF case_name='positive_seed_never_used_or_released' THEN
        stage:='actual_opening_seed';
        SET LOCAL ROLE authenticated;
        -- Actual opening path: custom tagline, house rake schedule, BBJ/Spins/
        -- ordinary promotion disabled, paid profit board with minimum100 seed.
        response:=public.fn_complete_club_opening_setup(club,gen_random_uuid(),
          'Disposable Funding Policy',-1,-1,false,0,false,0,1,false,
          'leaderboard','Unused Promotion','',0,true,'profit',100,false);
        RESET ROLE;
        IF (response->>'success')::boolean IS DISTINCT FROM true
           OR (SELECT leaderboard_seed_remaining FROM public.club_opening_setups WHERE club_id=club) IS DISTINCT FROM 100 THEN
          RAISE EXCEPTION 'Actual opening seed fixture refused';
        END IF;
      END IF;
      stage:='actual_promo_funding';
      SET LOCAL ROLE authenticated;
      response:=public.fn_diamond_game_fund_promo(club,20,'lb_policy_fund_'||case_name);
      RESET ROLE;
      IF (response->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Actual Promo funding refused'; END IF;
      IF case_name='overlay_save_refuses_without_effects' THEN
        stage:='overlay_refusal';
        SELECT max(version) INTO version_number FROM public.leaderboard_reward_program_versions WHERE club_id=club;
        before_state:=pg_temp.lb_funding_digest(); refused:=false;
        BEGIN
          SET LOCAL ROLE authenticated;
          response:=public.fn_save_leaderboard_reward_setup(club,true,'profit',
            '[{"rank":1,"amount":10}]','[]','custom',version_number,gen_random_uuid(),true);
          RESET ROLE;
        EXCEPTION WHEN OTHERS THEN
          RESET ROLE;
          -- Proposed exact policy contract, NOT an installed error claim.
          -- Permission, stale-version, generic validation or underfunding
          -- failures cannot masquerade as an explicit Promo-only refusal.
          IF SQLSTATE IS DISTINCT FROM '22023' OR SQLERRM IS DISTINCT FROM
             'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'
          THEN RAISE; END IF;
          refused:=true;
        END;
        IF NOT refused OR pg_temp.lb_funding_digest() IS DISTINCT FROM before_state THEN
          RAISE EXCEPTION 'Overlay was not refused atomically';
        END IF;
      ELSE
        -- Historical metadata only, in this rolled-back synthetic fixture.
        stage:='chronology_preimage';
        SELECT to_jsonb(c) INTO STRICT club_preimage FROM public.clubs c WHERE id=club;
        SELECT to_jsonb(m) INTO STRICT member_preimage FROM public.club_members m WHERE club_id=club AND user_id=player;
        IF (club_preimage->>'created_at')::timestamptz IS DISTINCT FROM transaction_timestamp()
           OR (member_preimage->>'joined_at')::timestamptz IS DISTINCT FROM transaction_timestamp()
           OR (member_preimage->>'chip_balance')::numeric IS DISTINCT FROM 0
           OR member_preimage->>'role' IS DISTINCT FROM 'player'
           OR COALESCE(member_preimage->>'status','') NOT IN ('active','approved') THEN
          RAISE EXCEPTION 'Chronology requires fresh real zero-chip player and club';
        END IF;
        UPDATE public.clubs SET created_at=(starts-1)::timestamp AT TIME ZONE 'UTC' WHERE id=club;
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 OR (SELECT to_jsonb(c)-'created_at' FROM public.clubs c WHERE id=club)
           IS DISTINCT FROM club_preimage-'created_at' THEN RAISE EXCEPTION 'Club chronology changed non-time fields'; END IF;
        UPDATE public.club_members SET joined_at=(starts-1)::timestamp AT TIME ZONE 'UTC' WHERE club_id=club AND user_id=player;
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 OR (SELECT to_jsonb(m)-'joined_at' FROM public.club_members m WHERE club_id=club AND user_id=player)
           IS DISTINCT FROM member_preimage-'joined_at' THEN RAISE EXCEPTION 'Membership chronology changed non-time fields'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id=club AND user_id=player AND status IN ('active','approved')) THEN
          RAISE EXCEPTION 'Real member fixture absent';
        END IF;
        SELECT COALESCE(max(version),0)+1 INTO version_number FROM public.leaderboard_reward_program_versions WHERE club_id=club;
        stage:='historical_program';
        program:=gen_random_uuid();
        terms:=jsonb_build_object('club_id',club,'version',version_number,'rewards_enabled',true,
          'payout_metric','profit','weekly_prizes','[{"rank":1,"amount":10}]'::jsonb,
          'monthly_prizes','[]'::jsonb,'funding_owner_type',CASE WHEN funding_union IS NULL THEN 'club' ELSE 'union' END,
          'funding_union_id',funding_union,'weekly_effective_from',starts,'monthly_effective_from',next_month);
        INSERT INTO public.leaderboard_reward_program_versions(id,club_id,version,operation_id,
          rewards_enabled,payout_metric,weekly_prizes,monthly_prizes,suggestion_key,
          funding_owner_type,funding_union_id,weekly_effective_from,monthly_effective_from,
          published_by,program_hash,overlay_enabled)
        VALUES(program,club,version_number,gen_random_uuid(),true,'profit','[{"rank":1,"amount":10}]','[]','custom',
          CASE WHEN funding_union IS NULL THEN 'club' ELSE 'union' END,funding_union,starts,next_month,owner,md5(terms::text),false);
        INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,hands_played,hands_dealt,
          sum_big_blind,total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
        VALUES(player,club,starts,0,0,0,0,0,0,0,0),(player,club,ends,20,20,40,100,0,0,0,0);
        IF public.fn_get_leaderboard_reward_plan(club,'weekly',starts)->>'program_id' IS DISTINCT FROM program::text THEN
          RAISE EXCEPTION 'Actual selected program differs';
        END IF;
        IF case_name IN ('union_underfunded_refuses','standalone_bank_never_falls_back') THEN
          stage:='actual_shortage_transition';
          -- Publication must first pass its real funded-program constraint.
          -- Create the shortage through a supported conserving transfer.
          -- Union Promo goes to affiliate Promo, so a positive club float must
          -- still never substitute for the program's empty union funding owner.
          IF funding_union IS NOT NULL THEN
            shortage_op:=gen_random_uuid();
            SELECT chip_balance INTO shortage_bank FROM public.union_wallets WHERE union_id=funding_union;
            SELECT chip_balance INTO shortage_player FROM public.club_members WHERE club_id=club AND user_id=player;
            SELECT chip_treasury,promo_balance INTO club_bank_before,club_promo_before FROM public.clubs WHERE id=club;
            PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','service_role')::text,true);
            PERFORM set_config('request.jwt.claim.role','service_role',true);
            SET LOCAL ROLE service_role;
            response:=public.fn_union_promo_send(funding_union,20,'club',club,shortage_op,owner,
              'Disposable policy shortage fixture');
            RESET ROLE;
            IF response->>'destination' IS DISTINCT FROM 'club'
               OR (response->>'promo_after')::numeric IS DISTINCT FROM 0
               OR (response->>'club_promo_after')::numeric IS DISTINCT FROM club_promo_before+20
               OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM club_promo_before+20
               OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM club_bank_before
               OR (SELECT chip_balance FROM public.union_wallets WHERE union_id=funding_union) IS DISTINCT FROM shortage_bank
               OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM shortage_player
               OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=shortage_op
                 AND category='promo_send' AND from_type='union_wallet' AND from_entity_id=funding_union
                 AND from_label='union_wallets.promo_wallet' AND to_type='promo_wallet'
                 AND to_entity_id=club AND to_label='clubs.promo_balance' AND amount=20)<>1
               OR (SELECT count(*) FROM public.union_wallet_transactions WHERE period_id=shortage_op
                 AND union_id=funding_union AND club_id=club AND wallet='promo_wallet'
                 AND direction='debit' AND amount=20 AND balance_after=0 AND tx_type='promo_to_club')<>1 THEN
              RAISE EXCEPTION 'Union shortage transfer did not conserve custody';
            END IF;
          ELSE
            SET LOCAL ROLE authenticated;
            response:=public.fn_promo_disburse('club',club,'player',player,20,
              'Disposable policy shortage fixture',club,gen_random_uuid());
            RESET ROLE;
          END IF;
          IF (response->>'success')::boolean IS DISTINCT FROM true
             OR (funding_union IS NULL AND (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 0)
             OR (funding_union IS NOT NULL AND (SELECT promo_wallet FROM public.union_wallets WHERE union_wallets.union_id=funding_union) IS DISTINCT FROM 0) THEN
            RAISE EXCEPTION 'Actual conserving shortage transition refused';
          END IF;
        END IF;
        before_state:=pg_temp.lb_funding_digest();
        IF case_name='settlement_sql_roles_refuse' THEN
          stage:='sql_role_refusal';
          FOREACH actor IN ARRAY ARRAY[owner::text,player::text,'90000000-0000-4000-8000-000000000005','anon'] LOOP
            refused:=false;
            BEGIN
              IF actor='anon' THEN
                PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
                PERFORM set_config('request.jwt.claim.sub','',true);
                PERFORM set_config('request.jwt.claim.role','anon',true);
                SET LOCAL ROLE anon;
              ELSE
                PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
                PERFORM set_config('request.jwt.claim.sub',actor,true);
                PERFORM set_config('request.jwt.claim.role','authenticated',true);
                SET LOCAL ROLE authenticated;
              END IF;
              PERFORM public.fn_payout_leaderboard(club,'weekly','profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
              RESET ROLE;
            EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; refused:=true;
            END;
            IF NOT refused OR pg_temp.lb_funding_digest() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'SQL settlement role not refused atomically'; END IF;
          END LOOP;
        ELSE
          stage:='settlement_preimage';
          SELECT chip_treasury,promo_balance INTO club_bank_before,club_promo_before FROM public.clubs WHERE id=club;
          SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=club AND user_id=player;
          SELECT COALESCE(leaderboard_seed_remaining,0) INTO seed_before FROM public.club_opening_setups WHERE club_id=club;
          SELECT chip_balance INTO bank_before FROM public.union_wallets WHERE union_wallets.union_id=fixture_union;
          IF club_bank_before IS NULL OR club_promo_before IS NULL OR player_before IS NULL OR bank_before IS NULL
             OR (case_name='positive_seed_never_used_or_released' AND seed_before IS DISTINCT FROM 100) THEN
            RAISE EXCEPTION 'Money preimage requires exact non-null wallet rows';
          END IF;
          refused:=false;
          BEGIN
            stage:='actual_settlement';
            correlation:=gen_random_uuid();
            PERFORM set_config('app.ledger_correlation',correlation::text,true);
            PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
            PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
            PERFORM set_config('request.jwt.claim.role','service_role',true);
            SET LOCAL ROLE service_role;
            response:=public.fn_payout_leaderboard(club,'weekly','profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
            RESET ROLE;
          EXCEPTION WHEN OTHERS THEN
            RESET ROLE;
            IF SQLERRM NOT LIKE 'LEADERBOARD_PROMO_UNDERFUNDED|%' THEN RAISE; END IF;
            refused:=true;
          END;
          IF case_name IN ('union_underfunded_refuses','standalone_bank_never_falls_back') THEN
            IF NOT refused OR pg_temp.lb_funding_digest() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Underfunded round used another source or changed state'; END IF;
          ELSE
            stage:='independent_money_readback';
            IF refused OR (response->>'success')::boolean IS DISTINCT FROM true
               OR (response->>'total_paid')::numeric IS DISTINCT FROM 10 OR (response->>'seed_funded')::numeric IS DISTINCT FROM 0
               OR (response->>'overlay_funded')::numeric IS DISTINCT FROM 0 OR (response->>'promo_funded')::numeric IS DISTINCT FROM 10
               OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM club_bank_before
               OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM player_before+10
               OR (SELECT chip_balance FROM public.union_wallets WHERE union_wallets.union_id=fixture_union) IS DISTINCT FROM bank_before
               OR (funding_union IS NOT NULL AND ((SELECT promo_wallet FROM public.union_wallets WHERE union_wallets.union_id=funding_union) IS DISTINCT FROM 10
                 OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM club_promo_before))
               OR (funding_union IS NULL AND (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 10)
               OR (case_name='positive_seed_never_used_or_released' AND (SELECT leaderboard_seed_remaining FROM public.club_opening_setups WHERE club_id=club) IS DISTINCT FROM seed_before) THEN
              RAISE EXCEPTION 'Promo-only wallet and response invariants differ';
            END IF;
            SELECT id INTO batch FROM public.leaderboard_payout_batches WHERE id=(response->>'batch_id')::uuid
              AND program_id=program AND seed_funded=0 AND overlay_funded=0 AND promo_funded=10 AND total_paid=10 AND winner_count=1;
            IF batch IS NULL OR (SELECT count(*) FROM public.leaderboard_payouts WHERE batch_id=batch AND user_id=player AND payout_amount=10)<>1
               OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=format('leaderboard:%s:weekly:%s:%s',club,starts,player) AND user_id=player AND amount=10)
               OR (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger WHERE correlation_id=correlation AND category='leaderboard_payout') IS DISTINCT FROM 20
               OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation)<>2
               OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation
                 AND category='leaderboard_payout' AND from_type=CASE WHEN funding_union IS NULL THEN 'promo_wallet' ELSE 'union_wallet' END
                 AND from_entity_id=CASE WHEN funding_union IS NULL THEN club ELSE (SELECT id FROM public.union_wallets WHERE union_wallets.union_id=funding_union) END
                 AND to_type='leaderboard_round' AND to_entity_id=club AND amount=10
                 AND pre_from_balance=20 AND post_from_balance=10)<>1
               OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation AND from_type='leaderboard_round' AND from_entity_id=club AND to_type='player_wallet' AND to_entity_id=player AND amount=10)<>1 THEN
              RAISE EXCEPTION 'Independent batch credit receipt or journal evidence differs';
            END IF;
            after_state:=pg_temp.lb_funding_digest();
            stage:='settlement_replay';
            PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
            PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
            PERFORM set_config('request.jwt.claim.role','service_role',true);
            SET LOCAL ROLE service_role;
            replay:=public.fn_payout_leaderboard(club,'weekly','profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
            RESET ROLE;
            IF (replay->>'already_settled')::boolean IS DISTINCT FROM true OR replay->>'batch_id' IS DISTINCT FROM response->>'batch_id'
              OR pg_temp.lb_funding_digest() IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'Replay differs'; END IF;
          END IF;
        END IF;
      END IF;
      stage:='deferred_constraints';
      SET CONSTRAINTS ALL IMMEDIATE;
      RAISE EXCEPTION 'rollback passing synthetic case' USING ERRCODE='ZLP01';
    EXCEPTION WHEN SQLSTATE 'ZLP01' THEN INSERT INTO lb_funding_policy_results VALUES(case_name,true,NULL,NULL);
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS error_state=RETURNED_SQLSTATE;
        INSERT INTO lb_funding_policy_results VALUES(case_name,false,error_state,stage);
    END;
  END LOOP;
END;
$cases$;
SELECT * FROM lb_funding_policy_results ORDER BY name;
DO $$ BEGIN IF (SELECT count(*) FROM lb_funding_policy_results)<>6 OR EXISTS(SELECT 1 FROM lb_funding_policy_results WHERE NOT passed)
  THEN RAISE EXCEPTION 'Unqualified Promo-only normative funding cases failed'; END IF; END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
