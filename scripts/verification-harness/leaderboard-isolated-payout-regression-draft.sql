-- UNQUALIFIED DRAFT. Never run against production, even inside a rollback.
-- Include in the SAME psql connection and explicit transaction, immediately
-- before the corrected authorization draft's final SET CONSTRAINTS/ROLLBACK.
-- That draft supplies the five synthetic accounts, clubs and real memberships.
-- This file ends the transaction with ROLLBACK; do not commit its fixtures.
-- Expected current-source failures: missing close is zero-paid success; a
-- one-cent two-player tie attempts an invalid zero-valued wallet credit.
-- Historical program INSERTs below are synthetic fixture configuration, not
-- evidence that the public publication RPC can backdate a real program.
-- Established-club cases explicitly date ONLY this synthetic club before the
-- closed period. This is isolated fixture metadata, not a business repair.
-- Newly created in-period club / zero prior activity remains UNQUALIFIED:
-- current source COALESCEs absent per-player baselines to zero, but supplies no
-- authoritative completeness/creation contract to distinguish lost history.
-- Membership age likewise does not prove prior play: the snapshot producer
-- copies only existing player_stats. The new-player case expects its supported
-- zero baseline; required-but-unavailable baseline qualification is unresolved
-- and is NOT represented by a blanket refusal or skipped passing coverage.
-- No trigger, RLS policy, ledger/funding constraint or function is replaced.
\set ON_ERROR_STOP on
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF session_user <> 'leaderboard_qualification_bootstrap'
     OR current_user <> 'leaderboard_qualification_bootstrap'
     OR current_database() <> 'postgres' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'Payout draft requires isolated bootstrap socket';
  END IF;
  IF (SELECT count(*) FROM auth.users) <> 5
     OR EXISTS (SELECT 1 FROM auth.users
       WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
     OR (SELECT count(*) FROM public.clubs) <> 3
     OR NOT EXISTS (SELECT 1 FROM public.clubs
       WHERE id='92000000-0000-4000-8000-000000000002'
         AND owner_id='90000000-0000-4000-8000-000000000002'
         AND union_id IS NULL AND NOT is_union)
     OR EXISTS (SELECT 1 FROM public.leaderboard_payout_batches)
     OR EXISTS (SELECT 1 FROM public.leaderboard_payouts)
     OR EXISTS (SELECT 1 FROM public.player_stats_snapshots) THEN
    RAISE EXCEPTION 'Payout draft requires exact synthetic authorization fixture';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_opening_setups
      WHERE club_id='92000000-0000-4000-8000-000000000002'
        AND leaderboard_seed_remaining <> 0) THEN
    RAISE EXCEPTION 'Payout draft requires no opening seed';
  END IF;
  IF NOT public.fn_leaderboard_prizes_are_valid('[{"rank":1,"amount":0.01}]') THEN
    RAISE EXCEPTION 'Cent-tie fixture no longer matches actual prize validator';
  END IF;
END;
$guard$;

-- The fifth account was a nonmember in the preceding authorization matrix.
-- Join it through the maintained real path only AFTER that matrix completed.
DO $join$
DECLARE result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    '{"sub":"90000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000005',true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  result := public.fn_join_club('92000000-0000-4000-8000-000000000002');
  IF result->>'role' IS DISTINCT FROM 'player'
     OR COALESCE(result->>'status','') NOT IN ('active','approved')
     OR (result->>'chip_balance')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Payout fixture second real membership failed';
  END IF;
  RESET ROLE;
END;
$join$;

-- Fund only synthetic Promo chips through the real bank-to-Promo door, with
-- its actual owner authorization, idempotency claim and journal intact.
DO $fund$
DECLARE result jsonb;
BEGIN
  IF (SELECT promo_balance FROM public.clubs
      WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 0
     OR (SELECT chip_treasury FROM public.clubs
      WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 100000 THEN
    RAISE EXCEPTION 'Synthetic standalone funding preimage differs';
  END IF;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
  PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  result := public.fn_diamond_game_fund_promo(
    '92000000-0000-4000-8000-000000000002',20,'leaderboard_isolated_payout_fund');
  IF (result->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Synthetic real Promo funding door refused';
  END IF;
  RESET ROLE;
  IF (SELECT promo_balance FROM public.clubs
      WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 20
     OR (SELECT chip_treasury FROM public.clubs
      WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 99980 THEN
    RAISE EXCEPTION 'Synthetic Promo funding did not persist exact transfer';
  END IF;
END;
$fund$;

CREATE TEMP TABLE lb_payout_draft_verdicts(case_name text PRIMARY KEY, passed boolean, sqlstate text, stage text);

-- Digest directly affected financial stores in the disposable fixture,
-- including recipients' actual home-club wallets and the refused pooled-wallet
-- fallback rather than assuming prizes land in this club. This is not a claim
-- of exhaustive schema/runtime reconciliation; that remains separate coverage.
CREATE FUNCTION pg_temp.lb_financial_digest() RETURNS text LANGUAGE sql AS $$
 SELECT md5(jsonb_build_object(
   'clubs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.clubs t),
   'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.club_members t),
   'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.profiles t),
   'union_wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.union_wallets t),
   'pooled_wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.wallets t),
   'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.chip_ledger t),
   'chip_history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.chip_transactions t),
   'club_wallet_history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.club_wallet_transactions t),
   'union_wallet_history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.union_wallet_transactions t),
   'wallet_history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.wallet_transactions t),
   'credit_keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.wallet_credit_idempotency t),
   'batches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.leaderboard_payout_batches t),
   'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.leaderboard_payouts t),
   'opening',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.club_opening_setups t),
   'failures',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.leaderboard_payout_failures t),
   'financial_alerts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.financial_alerts t)
 )::text);
$$;

DO $cases$
DECLARE
  case_name text;
  club constant uuid := '92000000-0000-4000-8000-000000000002';
  owner constant uuid := '90000000-0000-4000-8000-000000000002';
  player_a constant uuid := '90000000-0000-4000-8000-000000000004';
  player_b constant uuid := '90000000-0000-4000-8000-000000000005';
  starts date; ends date; monthly_next date;
  version_number integer; program_id uuid; operation_id uuid;
  prizes jsonb; terms jsonb; response jsonb; replay jsonb;
  before_digest text; after_digest text; before_players numeric;
  rejected boolean; rejection text; error_state text;
  expected_total numeric;
  close_date date; settlement_correlation uuid;
  original_created timestamptz; expected_created timestamptz; changed integer;
  original_bank numeric; original_promo numeric;
  membership_preimage jsonb;
BEGIN
  SELECT start_date,end_date INTO starts,ends
    FROM public.fn_leaderboard_period_window('weekly',-1);
  SELECT end_date INTO monthly_next FROM public.fn_leaderboard_period_window('monthly',0);
  -- Preserve actual creation/join/funding paths above. Change only chronology
  -- metadata on their synthetic result; all real triggers/constraints remain.
  IF session_user <> 'leaderboard_qualification_bootstrap'
     OR current_user <> 'leaderboard_qualification_bootstrap'
     OR current_database() <> 'postgres' OR inet_server_addr() IS NOT NULL
     OR (SELECT count(*) FROM auth.users) <> 5
     OR EXISTS (SELECT 1 FROM auth.users
         WHERE id::text NOT LIKE '90000000-0000-4000-8000-%') THEN
    RAISE EXCEPTION 'Chronology preparation requires exact isolated bootstrap fixture';
  END IF;
  SELECT created_at,chip_treasury,promo_balance
    INTO STRICT original_created,original_bank,original_promo
    FROM public.clubs WHERE id=club AND owner_id=owner AND union_id IS NULL AND NOT is_union;
  IF original_created IS NULL OR original_created < transaction_timestamp()
     OR original_created > clock_timestamp() THEN
    RAISE EXCEPTION 'Chronology preparation requires freshly actually created synthetic club';
  END IF;
  expected_created := (starts-1)::timestamp AT TIME ZONE 'UTC';
  UPDATE public.clubs SET created_at=expected_created
    WHERE id=club AND owner_id=owner AND created_at=original_created;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 OR NOT EXISTS (SELECT 1 FROM public.clubs
      WHERE id=club AND created_at=expected_created
        AND created_at < starts::timestamp AT TIME ZONE 'UTC'
        AND chip_treasury IS NOT DISTINCT FROM original_bank
        AND promo_balance IS NOT DISTINCT FROM original_promo) THEN
    RAISE EXCEPTION 'Established-club chronology or unchanged funding preimage assertion failed';
  END IF;
  IF (SELECT count(*) FROM public.club_members
      WHERE club_id=club AND user_id IN (player_a,player_b)
        AND joined_at >= transaction_timestamp() AND joined_at <= clock_timestamp()
        AND role::text='player' AND status::text IN ('active','approved')
        AND chip_balance=0) <> 2 THEN
    RAISE EXCEPTION 'Historical membership preparation requires exact fresh real joins';
  END IF;
  SELECT jsonb_agg(to_jsonb(m)-'joined_at' ORDER BY m.user_id)
    INTO membership_preimage FROM public.club_members m
    WHERE m.club_id=club AND m.user_id IN (player_a,player_b);
  UPDATE public.club_members SET joined_at=expected_created
    WHERE club_id=club AND user_id IN (player_a,player_b);
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>2 OR (SELECT count(*) FROM public.club_members
       WHERE club_id=club AND user_id IN (player_a,player_b)
         AND joined_at=expected_created AND joined_at < (starts::timestamp AT TIME ZONE 'UTC'))<>2
     OR (SELECT jsonb_agg(to_jsonb(m)-'joined_at' ORDER BY m.user_id)
         FROM public.club_members m WHERE m.club_id=club AND m.user_id IN (player_a,player_b))
       IS DISTINCT FROM membership_preimage THEN
    RAISE EXCEPTION 'Historical membership chronology changed non-chronology fixture data';
  END IF;
  FOREACH case_name IN ARRAY ARRAY[
    'missing_close_refuses_without_movement',
    'stale_close_refuses_without_movement',
    'new_player_zero_baseline_pays',
    'complete_close_pays_once',
    'genuine_empty_close_is_distinct',
    'positive_awards_only_for_cent_tie'
  ] LOOP
    -- Each case intentionally aborts its subtransaction even on PASS. Thus
    -- every case begins from the same funding/fixture state without cleanup
    -- deleting receipts, changing immutable versions or restoring balances.
    BEGIN
      SELECT COALESCE(max(version),0)+1 INTO version_number
        FROM public.leaderboard_reward_program_versions WHERE club_id=club;
      program_id := gen_random_uuid(); operation_id := gen_random_uuid();
      prizes := CASE WHEN case_name='positive_awards_only_for_cent_tie'
        THEN '[{"rank":1,"amount":0.01}]'::jsonb
        ELSE '[{"rank":1,"amount":10}]'::jsonb END;
      expected_total := CASE WHEN case_name='positive_awards_only_for_cent_tie' THEN 0.01 ELSE 10 END;
      terms := jsonb_build_object('club_id',club,'version',version_number,
        'rewards_enabled',true,'payout_metric','profit','weekly_prizes',prizes,
        'monthly_prizes','[]'::jsonb,'funding_owner_type','club','funding_union_id',NULL,
        'weekly_effective_from',starts,'monthly_effective_from',monthly_next);
      INSERT INTO public.leaderboard_reward_program_versions(
        id,club_id,version,operation_id,rewards_enabled,payout_metric,
        weekly_prizes,monthly_prizes,suggestion_key,funding_owner_type,
        funding_union_id,weekly_effective_from,monthly_effective_from,
        published_by,program_hash,overlay_enabled)
      VALUES(program_id,club,version_number,operation_id,true,'profit',prizes,'[]',
        'custom','club',NULL,starts,monthly_next,owner,md5(terms::text),false);
      IF public.fn_get_leaderboard_reward_plan(club,'weekly',starts)->>'program_id'
         IS DISTINCT FROM program_id::text THEN
        RAISE EXCEPTION 'Historical synthetic program was not the actual selected plan';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.clubs c
        JOIN public.leaderboard_reward_program_versions p ON p.club_id=c.id
        WHERE c.id=club AND p.id=program_id
          AND c.created_at=expected_created
          AND c.created_at < p.weekly_effective_from::timestamp AT TIME ZONE 'UTC'
          AND p.weekly_effective_from=starts AND starts<ends) THEN
        RAISE EXCEPTION 'Case does not model a club established before its historical program';
      END IF;

      IF case_name='new_player_zero_baseline_pays' THEN
        UPDATE public.club_members SET joined_at=((starts+1)::timestamp AT TIME ZONE 'UTC')
          WHERE club_id=club AND user_id=player_a AND joined_at=expected_created;
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 OR NOT EXISTS (SELECT 1 FROM public.club_members
          WHERE club_id=club AND user_id=player_a
            AND joined_at=((starts+1)::timestamp AT TIME ZONE 'UTC')
            AND joined_at<(ends::timestamp AT TIME ZONE 'UTC') AND chip_balance=0) THEN
          RAISE EXCEPTION 'New-player fixture join is not independently inside the round';
        END IF;
      ELSE
      INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,
        hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,
        total_rake,tournaments_played,tournaments_won)
      VALUES(player_a,club,starts,0,0,0,0,0,0,0,0);
      END IF;
      INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,
        hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,
        total_rake,tournaments_played,tournaments_won)
      VALUES(player_b,club,starts,0,0,0,0,0,0,0,0);
      close_date := CASE WHEN case_name='stale_close_refuses_without_movement'
        THEN ends-1 ELSE ends END;
      IF case_name <> 'missing_close_refuses_without_movement' THEN
        INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,
          hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,
          total_rake,tournaments_played,tournaments_won)
        VALUES(player_a,club,close_date,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0 ELSE 20 END,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0 ELSE 20 END,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0 ELSE 40 END,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0 ELSE 100 END,0,0,0,0),
          (player_b,club,close_date,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0 ELSE 20 END,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0 ELSE 20 END,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0 ELSE 40 END,
          CASE WHEN case_name='genuine_empty_close_is_distinct' THEN 0
               WHEN case_name='positive_awards_only_for_cent_tie' THEN 100 ELSE 50 END,0,0,0,0);
      END IF;
      IF case_name='new_player_zero_baseline_pays' AND (
        EXISTS (SELECT 1 FROM public.player_stats_snapshots
          WHERE club_id=club AND user_id=player_a AND snapshot_date<=starts)
        OR NOT EXISTS (SELECT 1 FROM public.fn_club_leaderboard_by_dates(
          club,'profit',starts,ends,10,0) r WHERE r.user_id=player_a
          AND r.rank=1 AND r.hands_played=20 AND r.total_winnings=100
          AND r.total_losses=0)) THEN
        RAISE EXCEPTION 'Actual ranking did not preserve legitimate new-player zero baseline';
      END IF;
      before_digest := pg_temp.lb_financial_digest();
      SELECT COALESCE(sum(chip_balance),0) INTO before_players
        FROM public.club_members WHERE user_id IN (player_a,player_b);
      PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
      PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
      PERFORM set_config('request.jwt.claim.role','service_role',true);
      SET LOCAL ROLE service_role;
      -- Test-owned correlation identifies every journal leg of this call;
      -- no source function or financial guard is bypassed by this tracing GUC.
      settlement_correlation := gen_random_uuid();
      PERFORM set_config('app.ledger_correlation',settlement_correlation::text,true);
      IF case_name IN ('missing_close_refuses_without_movement',
        'stale_close_refuses_without_movement') THEN
        rejected := false; rejection := NULL;
        BEGIN
          response := public.fn_payout_leaderboard(club,'weekly','profit',
            starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
        EXCEPTION WHEN OTHERS THEN
          rejected := true; GET STACKED DIAGNOSTICS rejection=MESSAGE_TEXT;
        END;
        RESET ROLE;
        -- Proposed typed contract for the source fix; change this expectation
        -- with the maintained authoritative error contract, never accept any
        -- unrelated failure as proof of snapshot safety.
        IF NOT rejected OR rejection NOT LIKE 'LEADERBOARD_SNAPSHOT_UNAVAILABLE|%' THEN
          RAISE EXCEPTION 'Missing closing basis did not produce snapshot-unavailable refusal';
        END IF;
        IF pg_temp.lb_financial_digest() IS DISTINCT FROM before_digest THEN
          RAISE EXCEPTION 'Unavailable closing basis changed financial state';
        END IF;
      ELSE
        response := public.fn_payout_leaderboard(club,'weekly','profit',
          starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
        RESET ROLE;
        IF case_name='genuine_empty_close_is_distinct' THEN expected_total := 0; END IF;
        IF (response->>'success')::boolean IS DISTINCT FROM true
           OR (response->>'already_settled')::boolean IS DISTINCT FROM false
           OR (response->>'total_paid')::numeric IS DISTINCT FROM expected_total
           OR (response->>'seed_funded')::numeric IS DISTINCT FROM 0
           OR (response->>'overlay_funded')::numeric IS DISTINCT FROM 0
           OR (response->>'promo_funded')::numeric IS DISTINCT FROM expected_total THEN
          RAISE EXCEPTION 'Actual settlement did not match independent Promo-only fixture oracle';
        END IF;
        IF (SELECT promo_balance FROM public.clubs WHERE id=club)
             IS DISTINCT FROM 20-expected_total
           OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM 99980
           OR (SELECT COALESCE(sum(chip_balance),0) FROM public.club_members
                 WHERE user_id IN (player_a,player_b))
             IS DISTINCT FROM before_players+expected_total
           OR (SELECT COALESCE(sum(payout_amount),0) FROM public.leaderboard_payouts
                 WHERE batch_id=(response->>'batch_id')::uuid) IS DISTINCT FROM expected_total
           OR (SELECT count(*) FROM public.leaderboard_payouts
                 WHERE batch_id=(response->>'batch_id')::uuid)
             <> CASE WHEN expected_total=0 THEN 0 ELSE 1 END THEN
          RAISE EXCEPTION 'Funding debit, player credits and actual receipts do not reconcile';
        END IF;
        IF expected_total>0 AND NOT EXISTS(SELECT 1 FROM public.leaderboard_payouts
          WHERE batch_id=(response->>'batch_id')::uuid AND user_id=player_a
            AND payout_amount=expected_total) THEN
          RAISE EXCEPTION 'Deterministic positive-award winner differs';
        END IF;
        -- Independent conserved-flow oracle: one source debit and one actual
        -- destination credit, with the real journal's shared correlation.
        -- Empty completed rounds must have no positive monetary journal legs.
        IF (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger
              WHERE correlation_id=settlement_correlation)
           IS DISTINCT FROM 2*expected_total
           OR (SELECT count(*) FROM public.chip_ledger
              WHERE correlation_id=settlement_correlation)
              <> CASE WHEN expected_total=0 THEN 0 ELSE 2 END
           OR (SELECT count(*) FROM public.chip_ledger
              WHERE correlation_id=settlement_correlation AND category='leaderboard_payout'
                AND from_type='promo_wallet' AND from_entity_id=club
                AND to_type='leaderboard_round' AND to_entity_id=club
                AND amount=expected_total AND pre_from_balance=20
                AND post_from_balance=20-expected_total)
              <> CASE WHEN expected_total=0 THEN 0 ELSE 1 END
           OR (SELECT count(*) FROM public.chip_ledger
              WHERE correlation_id=settlement_correlation AND category='leaderboard_payout'
                AND from_type='leaderboard_round' AND from_entity_id=club
                AND to_type='player_wallet' AND to_entity_id=player_a
                AND amount=expected_total
                AND post_to_balance-pre_to_balance=expected_total)
              <> CASE WHEN expected_total=0 THEN 0 ELSE 1 END
           OR (expected_total>0 AND NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency
              WHERE key=format('leaderboard:%s:weekly:%s:%s',club,starts,player_a)
                AND user_id=player_a AND amount=expected_total))
           OR (SELECT count(*) FROM public.wallet_transactions
              WHERE related_entity_id=program_id AND category='leaderboard_payout'
                AND user_id=player_a AND amount=expected_total AND type='credit')
              <> CASE WHEN expected_total=0 THEN 0 ELSE 1 END THEN
          RAISE EXCEPTION 'Correlated journal legs or recipient credit evidence differ';
        END IF;
        after_digest := pg_temp.lb_financial_digest();
        SET LOCAL ROLE service_role;
        replay := public.fn_payout_leaderboard(club,'weekly','profit',
          starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
        RESET ROLE;
        IF (replay->>'already_settled')::boolean IS DISTINCT FROM true
           OR replay->>'batch_id' IS DISTINCT FROM response->>'batch_id'
           OR pg_temp.lb_financial_digest() IS DISTINCT FROM after_digest THEN
          RAISE EXCEPTION 'Duplicate settlement changed financial state or receipt identity';
        END IF;
      END IF;
      SET CONSTRAINTS ALL IMMEDIATE;
      RAISE EXCEPTION USING ERRCODE='Q0001',MESSAGE='IsolatedCasePassedAndRolledBack';
    EXCEPTION
      WHEN SQLSTATE 'Q0001' THEN
        INSERT INTO lb_payout_draft_verdicts VALUES(case_name,true,NULL,NULL);
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS error_state=RETURNED_SQLSTATE;
        INSERT INTO lb_payout_draft_verdicts VALUES(case_name,false,error_state,'case_execution');
    END;
  END LOOP;
END;
$cases$;

TABLE lb_payout_draft_verdicts;
DO $verdict$
BEGIN
  IF (SELECT count(*) FROM lb_payout_draft_verdicts) <> 6
     OR EXISTS(SELECT 1 FROM lb_payout_draft_verdicts WHERE NOT passed) THEN
    RAISE EXCEPTION 'Isolated payout draft has unresolved failures; no qualification claimed';
  END IF;
END;
$verdict$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
