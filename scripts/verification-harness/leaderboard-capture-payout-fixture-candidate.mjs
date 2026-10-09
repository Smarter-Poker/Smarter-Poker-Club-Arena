// UNQUALIFIED source adapter. Never connects, installs, or executes SQL.
// Future owning runner: install capture+payout candidates on EMPTY restored DB,
// THEN execute existing authorization and this fixture in one rollback socket.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const baselineFixture = new URL(
  './leaderboard-isolated-payout-regression-draft.sql',
  import.meta.url
);
export function buildCapturePayoutFixture(source = readFileSync(baselineFixture, 'utf8')) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    'a0b05846b457dd22cd2db7200f1f192f1ded1d0a501a901f499c9ab7d057d9f1'
  );
  function replaceOnce(before, after) {
    assert.equal(source.split(before).length, 2, 'Reviewed payout fixture anchor changed');
    source = source.replace(before, () => after);
  }
  replaceOnce('DO $cases$\nDECLARE', 'DO $cases$\n<<capture_cases>>\nDECLARE');
  replaceOnce(
    'DO $guard$\nBEGIN',
    `DO $guard$
BEGIN
  IF to_regclass('public.leaderboard_complete_captures') IS NULL
     OR to_regclass('public.leaderboard_round_basis_receipts') IS NULL
     OR EXISTS(SELECT 1 FROM public.leaderboard_basis_existing_clubs)
     OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
     OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts) THEN
    RAISE EXCEPTION 'Capture payout fixture requires candidate installed before synthetic clubs and empty captures';
  END IF;`
  );
  replaceOnce(
    "      IF case_name='new_player_zero_baseline_pays' AND (",
    `      -- Explicit HISTORICAL SYNTHETIC captures, not producer/calendar proof.
      -- Every case is a rollback subtransaction, so no immutable history is
      -- deleted or rewritten to reuse its dates. Complete domain is derived
      -- independently from exact synthetic counters, including empty opening.
      INSERT INTO public.leaderboard_complete_captures
        (capture_date,captured_at,capture_timezone,origin,source_contract,row_count,counter_hash,complete)
      SELECT snapshot_date,(snapshot_date+time '00:05') AT TIME ZONE 'UTC',
        'UTC','fn_snapshot_player_stats','applied_player_stats_v1',count(*),
        md5(string_agg((to_jsonb(c)-'snapshot_date')::text,E'\\n' ORDER BY club_id,user_id)),true
      FROM (SELECT snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,
        total_winnings,total_losses,total_rake,tournaments_played,tournaments_won
        FROM public.player_stats_snapshots) c GROUP BY snapshot_date;
      INSERT INTO public.leaderboard_capture_counters
        (snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,
         total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
      SELECT snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,
        total_winnings,total_losses,total_rake,tournaments_played,tournaments_won
      FROM public.player_stats_snapshots;
      IF case_name='new_player_zero_baseline_pays' AND (`
  );
  replaceOnce(
    "rejection NOT LIKE 'LEADERBOARD_SNAPSHOT_UNAVAILABLE|%'",
    "rejection IS DISTINCT FROM 'LEADERBOARD_CAPTURE_UNAVAILABLE'"
  );
  replaceOnce(
    'rejected := true; GET STACKED DIAGNOSTICS rejection=MESSAGE_TEXT;',
    'rejected := true; GET STACKED DIAGNOSTICS rejection=MESSAGE_TEXT,error_state=RETURNED_SQLSTATE;'
  );
  replaceOnce(
    "IF NOT rejected OR rejection IS DISTINCT FROM 'LEADERBOARD_CAPTURE_UNAVAILABLE' THEN",
    "IF NOT rejected OR error_state IS DISTINCT FROM '55000' OR rejection IS DISTINCT FROM 'LEADERBOARD_CAPTURE_UNAVAILABLE' THEN"
  );
  replaceOnce(
    'IF pg_temp.lb_financial_digest() IS DISTINCT FROM before_digest THEN',
    'IF pg_temp.lb_financial_digest() IS DISTINCT FROM before_digest OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts) THEN'
  );
  replaceOnce(
    '        after_digest := pg_temp.lb_financial_digest();',
    `        IF (SELECT count(*) FROM public.leaderboard_round_basis_receipts)<>1
           OR NOT EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts r
             WHERE r.club_id=club AND r.period='weekly' AND r.period_start=starts AND r.period_end=ends
               AND r.program_id=capture_cases.program_id AND r.program_version=version_number AND r.program_hash=md5(terms::text)
               AND r.basis_version='complete_capture_v2' AND r.basis->'complete'='true'::jsonb
               AND r.basis_hash=md5(r.basis::text)
               AND r.selected_board_hash=md5(r.selected_board::text)
               AND r.winners_hash=md5(r.winners::text)
               AND (SELECT COALESCE(sum((w->>'amount')::numeric),0) FROM jsonb_array_elements(r.winners) w)=expected_total
               AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.winners) w WHERE (w->>'amount')::numeric<=0)) THEN
          RAISE EXCEPTION 'Frozen complete basis receipt disagrees with independently reconciled award';
        END IF;
        before_digest := (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text)
          FROM public.leaderboard_round_basis_receipts r);
        -- Change ONLY mutable synthetic legacy reporting inputs. Neither the
        -- complete counters nor the persisted payout/basis receipt may change.
        UPDATE public.player_stats_snapshots SET total_winnings=total_winnings+777
          WHERE club_id=club AND snapshot_date=ends;
        after_digest := pg_temp.lb_financial_digest();`
  );
  replaceOnce(
    '           OR pg_temp.lb_financial_digest() IS DISTINCT FROM after_digest THEN',
    `           OR pg_temp.lb_financial_digest() IS DISTINCT FROM after_digest
           OR (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text)
               FROM public.leaderboard_round_basis_receipts r) IS DISTINCT FROM before_digest THEN`
  );
  replaceOnce(
    'SET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;\n',
    `${extendedPayoutCases}\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;\n`
  );
  assert.ok(source.endsWith('ROLLBACK;\n'));
  assert.equal(source.match(/^ROLLBACK;$/gm)?.length, 1);
  assert.doesNotMatch(source, /^COMMIT;/m);
  return '-- UNQUALIFIED complete-capture variant. Original baseline remains unchanged.\n' + source;
}

// Disposable-only acceptance cases. The original six-case baseline is intact.
// Every case rolls back even on PASS; no settled receipt is deleted to reset it.
const extendedPayoutCases = String.raw`
CREATE TEMP TABLE lb_extended_payout_verdicts(name text PRIMARY KEY,passed boolean,sqlstate text,stage text);
CREATE FUNCTION pg_temp.lb_fail_recipient_receipt() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
  IF NEW.category='leaderboard_payout' AND NEW.user_id='90000000-0000-4000-8000-000000000004' THEN
    IF (SELECT promo_balance FROM public.clubs WHERE id='92000000-0000-4000-8000-000000000002') IS DISTINCT FROM 10
       OR (SELECT count(*) FROM public.leaderboard_payout_batches)<>1
       OR (SELECT count(*) FROM public.leaderboard_round_basis_receipts)<>1
       OR (SELECT COALESCE(sum(chip_balance),0) FROM public.club_members WHERE user_id=NEW.user_id) IS DISTINCT FROM 10
       OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE user_id=NEW.user_id AND amount=10) THEN
      RAISE EXCEPTION 'Fault was reached before actual funding/batch/basis/recipient admission';
    END IF;
    RAISE EXCEPTION 'ISOLATED_RECIPIENT_RECEIPT_FAILURE' USING ERRCODE='ZLF01';
  END IF;
  RETURN NEW;
END;
$fault$;
DO $extended$
<<extended_cases>>
DECLARE
  case_name text; period_name text; club uuid; owner uuid; funding_union uuid;
  player constant uuid:='90000000-0000-4000-8000-000000000004';
  union_id constant uuid:='91000000-0000-4000-8000-000000000001';
  starts date; ends date; weekly_next date; monthly_next date;
  program_id uuid; version_number integer; terms jsonb; response jsonb; replay jsonb;
  preimage jsonb; changed integer; before_state text; after_state text; basis_before text;
  club_bank numeric; club_promo numeric; union_bank numeric; promo_before numeric; players_before numeric;
  correlation uuid; rejected boolean; failure_state text; failure_message text; stage text;
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
     OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
     OR (SELECT count(*) FROM auth.users)<>5 OR (SELECT count(*) FROM public.clubs)<>3
     OR EXISTS(SELECT 1 FROM auth.users WHERE id::text NOT LIKE '90000000-0000-4000-8000-%')
     OR EXISTS(SELECT 1 FROM public.leaderboard_payout_batches)
     OR EXISTS(SELECT 1 FROM public.leaderboard_round_basis_receipts)
     OR EXISTS(SELECT 1 FROM public.leaderboard_complete_captures)
     OR EXISTS(SELECT 1 FROM public.player_stats_snapshots) THEN
    RAISE EXCEPTION 'Extended payout requires exact empty disposable authorization/baseline fixture';
  END IF;
  FOREACH case_name IN ARRAY ARRAY['affiliate_union_promo_pays_once','canonical_monthly_pays_once',
    'insufficient_promo_bank_available_refuses','recipient_failure_rolls_back_then_retries'] LOOP
    BEGIN
      stage:='fixture';
      period_name:=CASE WHEN case_name='canonical_monthly_pays_once' THEN 'monthly' ELSE 'weekly' END;
      club:=CASE WHEN case_name='affiliate_union_promo_pays_once' THEN '92000000-0000-4000-8000-000000000001'::uuid
        ELSE '92000000-0000-4000-8000-000000000002'::uuid END;
      funding_union:=CASE WHEN case_name='affiliate_union_promo_pays_once' THEN union_id ELSE NULL END;
      owner:=CASE WHEN funding_union IS NULL THEN '90000000-0000-4000-8000-000000000002'::uuid
        ELSE '90000000-0000-4000-8000-000000000001'::uuid END;
      SELECT start_date,end_date INTO starts,ends FROM public.fn_leaderboard_period_window(period_name,-1);
      SELECT end_date INTO weekly_next FROM public.fn_leaderboard_period_window('weekly',0);
      SELECT end_date INTO monthly_next FROM public.fn_leaderboard_period_window('monthly',0);
      IF funding_union IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
        PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
        PERFORM set_config('request.jwt.claim.role','service_role',true);
        SET LOCAL ROLE service_role;
        response:=public.fn_ca_mint('chips','union',union_id,100,'Disposable extended payout fixture','lb_extended_union_mint','seeded');
        RESET ROLE;
        IF (response->>'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Actual union mint refused'; END IF;
        PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
        PERFORM set_config('request.jwt.claim.sub',owner::text,true);
        PERFORM set_config('request.jwt.claim.role','authenticated',true);
        SET LOCAL ROLE authenticated;
        response:=public.fn_diamond_game_fund_promo(club,20,'lb_extended_union_fund');
        RESET ROLE;
        IF (response->>'ok')::boolean IS DISTINCT FROM true
           OR (SELECT promo_wallet FROM public.union_wallets WHERE union_wallets.union_id=extended_cases.union_id) IS DISTINCT FROM 20
           OR (SELECT chip_balance FROM public.union_wallets WHERE union_wallets.union_id=extended_cases.union_id) IS DISTINCT FROM 80 THEN
          RAISE EXCEPTION 'Actual affiliated union Promo funding differs';
        END IF;
      END IF;
      -- ONLY chronology of these isolated synthetic rows changes. No wallet
      -- balance, trigger, membership role or complete-capture history is forged.
      SELECT to_jsonb(c) INTO STRICT preimage FROM public.clubs c WHERE id=club;
      UPDATE public.clubs SET created_at=(starts-1)::timestamp AT TIME ZONE 'UTC' WHERE id=club;
      GET DIAGNOSTICS changed=ROW_COUNT;
      IF changed<>1 OR (SELECT to_jsonb(c)-'created_at' FROM public.clubs c WHERE id=club)
        IS DISTINCT FROM preimage-'created_at' THEN RAISE EXCEPTION 'Club chronology changed other fields'; END IF;
      SELECT to_jsonb(m) INTO STRICT preimage FROM public.club_members m WHERE club_id=club AND user_id=player;
      IF preimage->>'role' IS DISTINCT FROM 'player' OR COALESCE(preimage->>'status','') NOT IN ('active','approved')
         OR (preimage->>'chip_balance')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Exact real zero-chip member required'; END IF;
      UPDATE public.club_members SET joined_at=(starts-1)::timestamp AT TIME ZONE 'UTC' WHERE club_id=club AND user_id=player;
      GET DIAGNOSTICS changed=ROW_COUNT;
      IF changed<>1 OR (SELECT to_jsonb(m)-'joined_at' FROM public.club_members m WHERE club_id=club AND user_id=player)
        IS DISTINCT FROM preimage-'joined_at' THEN RAISE EXCEPTION 'Member chronology changed other fields'; END IF;
      SELECT COALESCE(max(version),0)+1 INTO version_number FROM public.leaderboard_reward_program_versions WHERE club_id=club;
      program_id:=gen_random_uuid();
      terms:=jsonb_build_object('club_id',club,'version',version_number,'rewards_enabled',true,'payout_metric','profit',
        'weekly_prizes',CASE WHEN period_name='weekly' THEN '[{"rank":1,"amount":10}]'::jsonb ELSE '[]'::jsonb END,
        'monthly_prizes',CASE WHEN period_name='monthly' THEN '[{"rank":1,"amount":10}]'::jsonb ELSE '[]'::jsonb END,
        'funding_owner_type',CASE WHEN funding_union IS NULL THEN 'club' ELSE 'union' END,'funding_union_id',funding_union,
        'weekly_effective_from',CASE WHEN period_name='weekly' THEN starts ELSE weekly_next END,
        'monthly_effective_from',CASE WHEN period_name='monthly' THEN starts ELSE monthly_next END);
      INSERT INTO public.leaderboard_reward_program_versions(id,club_id,version,operation_id,rewards_enabled,payout_metric,
        weekly_prizes,monthly_prizes,suggestion_key,funding_owner_type,funding_union_id,weekly_effective_from,monthly_effective_from,published_by,program_hash,overlay_enabled)
      VALUES(program_id,club,version_number,gen_random_uuid(),true,'profit',terms->'weekly_prizes',terms->'monthly_prizes','custom',
        terms->>'funding_owner_type',funding_union,(terms->>'weekly_effective_from')::date,(terms->>'monthly_effective_from')::date,owner,md5(terms::text),false);
      IF public.fn_get_leaderboard_reward_plan(club,period_name,starts)->>'program_id' IS DISTINCT FROM program_id::text THEN
        RAISE EXCEPTION 'Actual canonical program selection differs'; END IF;
      INSERT INTO public.player_stats_snapshots(user_id,club_id,snapshot_date,hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
      VALUES(player,club,starts,0,0,0,0,0,0,0,0),(player,club,ends,20,20,40,100,0,0,0,0);
      INSERT INTO public.leaderboard_complete_captures(capture_date,captured_at,capture_timezone,origin,source_contract,row_count,counter_hash,complete)
      SELECT snapshot_date,(snapshot_date+time '00:05') AT TIME ZONE 'UTC','UTC','fn_snapshot_player_stats','applied_player_stats_v1',count(*),
        md5(string_agg((to_jsonb(c)-'snapshot_date')::text,E'\n' ORDER BY club_id,user_id)),true
      FROM (SELECT snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,total_rake,tournaments_played,tournaments_won
        FROM public.player_stats_snapshots) c GROUP BY snapshot_date;
      INSERT INTO public.leaderboard_capture_counters(snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,total_rake,tournaments_played,tournaments_won)
      SELECT snapshot_date,user_id,club_id,hands_played,hands_dealt,sum_big_blind,total_winnings,total_losses,total_rake,tournaments_played,tournaments_won FROM public.player_stats_snapshots;
      IF case_name='insufficient_promo_bank_available_refuses' THEN
        stage:='actual_shortage';
        PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner,'role','authenticated')::text,true);
        PERFORM set_config('request.jwt.claim.sub',owner::text,true);
        PERFORM set_config('request.jwt.claim.role','authenticated',true);
        SET LOCAL ROLE authenticated;
        response:=public.fn_promo_disburse('club',club,'player',player,20,'Disposable shortage fixture',club,gen_random_uuid());
        RESET ROLE;
        IF (response->>'success')::boolean IS DISTINCT FROM true OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 0
           OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=club AND chip_treasury>10) THEN RAISE EXCEPTION 'Conserving shortage with available Bank required'; END IF;
      END IF;
      SELECT chip_treasury,promo_balance INTO STRICT club_bank,club_promo FROM public.clubs WHERE id=club;
      SELECT chip_balance INTO STRICT union_bank FROM public.union_wallets WHERE union_wallets.union_id=extended_cases.union_id;
      promo_before:=CASE WHEN funding_union IS NULL THEN club_promo ELSE (SELECT promo_wallet FROM public.union_wallets WHERE union_wallets.union_id=funding_union) END;
      SELECT COALESCE(sum(chip_balance),0) INTO players_before FROM public.club_members WHERE user_id=player;
      before_state:=pg_temp.lb_financial_digest();
      basis_before:=(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text,'null')) FROM public.leaderboard_round_basis_receipts r);
      IF case_name='recipient_failure_rolls_back_then_retries' THEN
        IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='lb_isolated_recipient_failure') THEN RAISE EXCEPTION 'Fault trigger already exists'; END IF;
        CREATE TRIGGER lb_isolated_recipient_failure BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION pg_temp.lb_fail_recipient_receipt();
      END IF;
      stage:='actual_settlement'; rejected:=false;
      correlation:=gen_random_uuid();
      PERFORM set_config('app.ledger_correlation',correlation::text,true);
      PERFORM set_config('request.jwt.claims','{"sub":"90000000-0000-4000-8000-000000000001","role":"service_role"}',true);
      PERFORM set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
      PERFORM set_config('request.jwt.claim.role','service_role',true);
      BEGIN
        SET LOCAL ROLE service_role;
        response:=public.fn_payout_leaderboard(club,period_name,'profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
        RESET ROLE;
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE; rejected:=true; GET STACKED DIAGNOSTICS failure_state=RETURNED_SQLSTATE,failure_message=MESSAGE_TEXT;
      END;
      IF case_name IN ('insufficient_promo_bank_available_refuses','recipient_failure_rolls_back_then_retries') THEN
        IF NOT rejected OR (case_name='insufficient_promo_bank_available_refuses' AND
            (failure_state IS DISTINCT FROM 'P0001' OR failure_message IS DISTINCT FROM 'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires 10.00 Promo Chips But The Recorded Promo Wallet Holds 0.00'))
           OR (case_name='recipient_failure_rolls_back_then_retries' AND (failure_state IS DISTINCT FROM 'ZLF01' OR failure_message IS DISTINCT FROM 'ISOLATED_RECIPIENT_RECEIPT_FAILURE'))
           OR pg_temp.lb_financial_digest() IS DISTINCT FROM before_state
           OR (SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text,'null')) FROM public.leaderboard_round_basis_receipts r) IS DISTINCT FROM basis_before THEN
          RAISE EXCEPTION 'Expected exact refusal did not roll back money and basis'; END IF;
        IF case_name='recipient_failure_rolls_back_then_retries' THEN
          DROP TRIGGER lb_isolated_recipient_failure ON public.wallet_transactions;
          SET LOCAL ROLE service_role;
          response:=public.fn_payout_leaderboard(club,period_name,'profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
          RESET ROLE; rejected:=false;
        END IF;
      END IF;
      IF case_name<>'insufficient_promo_bank_available_refuses' THEN
        stage:='independent_readback';
        IF rejected OR (response->>'success')::boolean IS DISTINCT FROM true OR (response->>'already_settled')::boolean IS DISTINCT FROM false
           OR (response->>'total_paid')::numeric IS DISTINCT FROM 10 OR (response->>'promo_funded')::numeric IS DISTINCT FROM 10
           OR (response->>'seed_funded')::numeric IS DISTINCT FROM 0 OR (response->>'overlay_funded')::numeric IS DISTINCT FROM 0
           OR (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM club_bank
           OR (SELECT chip_balance FROM public.union_wallets WHERE union_wallets.union_id=extended_cases.union_id) IS DISTINCT FROM union_bank
           OR (SELECT COALESCE(sum(chip_balance),0) FROM public.club_members WHERE user_id=player) IS DISTINCT FROM players_before+10
           OR (funding_union IS NULL AND (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM promo_before-10)
           OR (funding_union IS NOT NULL AND ((SELECT promo_wallet FROM public.union_wallets WHERE union_wallets.union_id=funding_union) IS DISTINCT FROM promo_before-10
             OR (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM club_promo)) THEN RAISE EXCEPTION 'Promo-only conservation differs'; END IF;
        IF (SELECT count(*) FROM public.leaderboard_payout_batches WHERE id=(response->>'batch_id')::uuid AND club_id=club AND period=period_name
            AND total_paid=10 AND promo_funded=10 AND seed_funded=0 AND overlay_funded=0 AND winner_count=1)<>1
           OR (SELECT count(*) FROM public.leaderboard_payouts WHERE batch_id=(response->>'batch_id')::uuid AND user_id=player AND payout_amount=10)<>1
           OR (SELECT count(*) FROM public.leaderboard_round_basis_receipts r WHERE r.club_id=club AND r.period=period_name AND r.period_start=starts
             AND r.program_id=extended_cases.program_id AND r.program_hash=md5(terms::text) AND r.basis_hash=md5(r.basis::text) AND r.winners_hash=md5(r.winners::text))<>1
           OR (SELECT count(*) FROM public.wallet_credit_idempotency WHERE key=format('leaderboard:%s:%s:%s:%s',club,period_name,starts,player) AND user_id=player AND amount=10)<>1
           OR (SELECT count(*) FROM public.wallet_transactions WHERE related_entity_id=program_id AND category='leaderboard_payout' AND user_id=player AND amount=10 AND type='credit')<>1
           OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation)<>2
           OR (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger WHERE correlation_id=correlation) IS DISTINCT FROM 20
           OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation AND category='leaderboard_payout'
             AND from_type=CASE WHEN funding_union IS NULL THEN 'promo_wallet' ELSE 'union_wallet' END
             AND from_entity_id=CASE WHEN funding_union IS NULL THEN club ELSE (SELECT id FROM public.union_wallets WHERE union_wallets.union_id=funding_union) END
             AND to_type='leaderboard_round' AND to_entity_id=club AND amount=10 AND pre_from_balance=20 AND post_from_balance=10)<>1
           OR (SELECT count(*) FROM public.chip_ledger WHERE correlation_id=correlation AND category='leaderboard_payout' AND from_type='leaderboard_round'
             AND from_entity_id=club AND to_type='player_wallet' AND to_entity_id=player AND amount=10 AND post_to_balance-pre_to_balance=10)<>1 THEN
          RAISE EXCEPTION 'Independent exact recipient and source journal legs differ'; END IF;
        after_state:=pg_temp.lb_financial_digest();
        basis_before:=(SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text) FROM public.leaderboard_round_basis_receipts r);
        SET LOCAL ROLE service_role;
        replay:=public.fn_payout_leaderboard(club,period_name,'profit',starts::timestamp AT TIME ZONE 'UTC',ends::timestamp AT TIME ZONE 'UTC');
        RESET ROLE;
        IF (replay->>'already_settled')::boolean IS DISTINCT FROM true OR replay->>'batch_id' IS DISTINCT FROM response->>'batch_id'
           OR pg_temp.lb_financial_digest() IS DISTINCT FROM after_state
           OR (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY club_id,period,period_start)::text) FROM public.leaderboard_round_basis_receipts r) IS DISTINCT FROM basis_before THEN
          RAISE EXCEPTION 'Same-round replay changed money or frozen receipt'; END IF;
      END IF;
      SET CONSTRAINTS ALL IMMEDIATE;
      RAISE EXCEPTION 'ExtendedCasePassedAndRolledBack' USING ERRCODE='Q0001';
    EXCEPTION WHEN SQLSTATE 'Q0001' THEN INSERT INTO lb_extended_payout_verdicts VALUES(case_name,true,NULL,NULL);
      WHEN OTHERS THEN GET STACKED DIAGNOSTICS failure_state=RETURNED_SQLSTATE;
        INSERT INTO lb_extended_payout_verdicts VALUES(case_name,false,failure_state,stage);
    END;
  END LOOP;
END;
$extended$;
TABLE lb_extended_payout_verdicts;
DO $extended_verdict$
BEGIN
  IF (SELECT count(*) FROM lb_extended_payout_verdicts)<>4 OR EXISTS(SELECT 1 FROM lb_extended_payout_verdicts WHERE NOT passed) THEN
    RAISE EXCEPTION 'Extended payout cases remain unqualified'; END IF;
END;
$extended_verdict$;
`;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildCapturePayoutFixture());
  } catch {
    console.error('Capture payout fixture preparation refused; no runtime qualification');
    process.exitCode = 1;
  }
}
