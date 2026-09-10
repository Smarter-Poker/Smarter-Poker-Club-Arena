#!/usr/bin/env python3
"""Compose an UNEXECUTED, rollback-only native rake retry probe.

No database connection is opened by this program. Its generated SQL is only
for the already-owned empty local postgres database at port 55473. Inspect the
Mac's saved artifact and process state before executing it. The fully guarded
fixture has not yet passed seeding; preserve any resulting guard failure.
"""
from pathlib import Path
import argparse
import hashlib
import re


PREAMBLE = r"""\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';
DO $owned_local$
BEGIN
  IF current_database()<>'postgres' OR current_user<>'postgres'
     OR inet_server_addr() IS NOT NULL OR current_setting('port')<>'55473'
     OR EXISTS(SELECT 1 FROM auth.users)
     OR EXISTS(SELECT 1 FROM public.tournaments)
     OR EXISTS(SELECT 1 FROM pg_stat_activity
                WHERE datname=current_database() AND pid<>pg_backend_pid()) THEN
    RAISE EXCEPTION 'requires the exclusively owned empty local postgres database';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_tournament_rake(uuid,text)'::regprocedure)
       IS DISTINCT FROM 'e2f61a2c0639e77a015bff61f5703722'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_attribute_tournament_rake(uuid)'::regprocedure)
       IS DISTINCT FROM '45ec1fd0c7499311312e880ff8e99598'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.credit_club_rake_to_treasury(uuid,numeric)'::regprocedure)
       IS DISTINCT FROM '472e935f96e8efd1f7cef768e3276f86'
     OR to_regprocedure('public.fn_ca_lock_settlement_lane_global()') IS NOT NULL THEN
    RAISE EXCEPTION 'owned replay baseline differs; inspect before any fixture mutation';
  END IF;
END; $owned_local$;
CREATE TEMP TABLE rake_catalog_baseline AS
SELECT p.oid,to_jsonb(p) AS metadata FROM pg_proc p
 WHERE pronamespace='public'::regnamespace;
CREATE TEMP TABLE rake_trigger_baseline AS
SELECT t.oid,to_jsonb(t) AS metadata FROM pg_trigger t
 JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace;
CREATE FUNCTION pg_temp.rake_assert(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %',p_label; END IF;
  RAISE NOTICE 'PASS %',p_label;
END; $assert$;
"""

SEED = r"""
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','94010000-0000-0000-0000-000000000001',true);
-- This documented structural dependency is required by the ordinary social
-- profile trigger. The rows are synthetic and roll back with the fixture.
INSERT INTO auth.users(id,email) VALUES
 ('47965354-0e56-43ef-931c-ddaab82af765','rake-retry-social-dependency@example.invalid'),
 ('94010000-0000-0000-0000-000000000001','rake-retry-owner@example.invalid'),
 ('94010000-0000-0000-0000-000000000002','rake-retry-player@example.invalid');
SELECT pg_temp.rake_assert(EXISTS(SELECT 1 FROM public.users
 WHERE id='47965354-0e56-43ef-931c-ddaab82af765'),
 'ordinary auth trigger creates the synthetic social dependency');
SELECT pg_temp.rake_assert((SELECT count(*) FROM public.profiles
 WHERE id IN ('94010000-0000-0000-0000-000000000001','94010000-0000-0000-0000-000000000002'))=2,
 'ordinary auth triggers create both synthetic player profiles');
INSERT INTO public.clubs(id,name,owner_id)
 VALUES('94020000-0000-0000-0000-000000000001','Rake Retry Native Probe','94010000-0000-0000-0000-000000000001');
INSERT INTO public.club_wallets(club_id)
 VALUES('94020000-0000-0000-0000-000000000001') ON CONFLICT(club_id) DO NOTHING;
SELECT set_config('app.club_membership_source','join_club',true);
INSERT INTO public.club_members(club_id,user_id,role,status)
 VALUES('94020000-0000-0000-0000-000000000001','94010000-0000-0000-0000-000000000002','player','active');
SELECT set_config('app.club_membership_source','',true);
-- These structural fee rows exercise only settlement and attribution. They
-- are not registration, complete terminal-transition, or custody acceptance.
INSERT INTO public.tournaments(id,name,club_id,buy_in_amount,buy_in_fee,start_time,max_players,status,payout_structure)
 SELECT md5('rake-retry-event:'||i)::uuid,'Rake Retry Native Probe '||i,
 '94020000-0000-0000-0000-000000000001',9,1,now(),9,'COMPLETING',
 '[{"place":1,"percentage":100}]'::jsonb FROM generate_series(1,5) i;
-- Explicit synthetic opening custody follows the tracked atomic-terminal
-- rehearsal fixture. It isolates settlement/attribution; it is not evidence
-- that native registration or opening custody itself has been accepted.
INSERT INTO public.tournament_escrow(
 tournament_id,gross_in,fee_entries_in,satellite_fee_in,bounty_in,
 overlay_in,satellite_in,prize_out,bounty_out,fee_out,refund_prize,
 refund_bounty,refund_fee,reserve_out,reserve_in,prize_balance,
 bounty_balance,fee_balance,opened_from,opened_at,updated_at,enforced)
 SELECT md5('rake-retry-event:'||i)::uuid,
 10,0,0,0,0,0,0,0,0,0,0,0,0,0,10,0,0,
 'rake-retry-synthetic-opening-custody',now(),now(),true
 FROM generate_series(1,5) i;
-- Native rake-record triggers partition one fee chip from each opening.
INSERT INTO public.rake_records(id,club_id,tournament_id,rake_amount,is_tournament,metadata)
 SELECT md5('rake-retry-record:'||i)::uuid,'94020000-0000-0000-0000-000000000001',
 md5('rake-retry-event:'||i)::uuid,1,true,
 '{"user_id":"94010000-0000-0000-0000-000000000002"}'::jsonb
 FROM generate_series(1,5) i;
CREATE TEMP SEQUENCE rake_fault_attempt;
CREATE TEMP TABLE rake_fault_policy(sqlstate text NOT NULL,failures integer NOT NULL);
INSERT INTO rake_fault_policy VALUES('55P03',1);
CREATE FUNCTION pg_temp.rake_late_fault()
RETURNS trigger LANGUAGE plpgsql AS $fault$
DECLARE v_attempt bigint; v_policy record;
BEGIN
  IF NEW.user_id='94010000-0000-0000-0000-000000000002'::uuid THEN
    v_attempt:=nextval('pg_temp.rake_fault_attempt');
    SELECT * INTO STRICT v_policy FROM pg_temp.rake_fault_policy;
    IF v_attempt<=v_policy.failures THEN
      RAISE EXCEPTION 'synthetic late native attribution fault' USING ERRCODE=v_policy.sqlstate;
    END IF;
  END IF;
  RETURN NEW;
END; $fault$;
CREATE TRIGGER codex_rake_retry_native_fault
 AFTER INSERT OR UPDATE ON public.player_stats
 FOR EACH ROW EXECUTE FUNCTION pg_temp.rake_late_fault();
CREATE FUNCTION pg_temp.rake_state()
RETURNS jsonb LANGUAGE sql AS $state$
 SELECT jsonb_build_object(
  'club',(SELECT to_jsonb(c) FROM public.clubs c WHERE id='94020000-0000-0000-0000-000000000001'),
  'wallet',(SELECT to_jsonb(c) FROM public.club_wallets c WHERE club_id='94020000-0000-0000-0000-000000000001'),
  'journals',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.chip_ledger c WHERE club_id='94020000-0000-0000-0000-000000000001'),
  'escrow',(SELECT jsonb_agg(to_jsonb(c) ORDER BY tournament_id) FROM public.tournament_escrow c WHERE opened_from='rake-retry-synthetic-opening-custody'),
  'settlements',(SELECT jsonb_agg(to_jsonb(c) ORDER BY tournament_id) FROM public.tournament_rake_settlements c),
  'vip_ledger',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.vip_points_ledger c WHERE user_id='94010000-0000-0000-0000-000000000002'),
  'vip',(SELECT to_jsonb(c) FROM public.vip_points c WHERE user_id='94010000-0000-0000-0000-000000000002'),
  'carry',(SELECT to_jsonb(c) FROM public.vip_points_carry c WHERE user_id='94010000-0000-0000-0000-000000000002'),
  'stats',(SELECT to_jsonb(c) FROM public.player_stats c WHERE user_id='94010000-0000-0000-0000-000000000002' AND club_id='94020000-0000-0000-0000-000000000001'),
  'stats_receipts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY rake_record_id) FROM public.rakeback_stats_applied c WHERE user_id='94010000-0000-0000-0000-000000000002'),
  'commissions',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.agent_commissions c WHERE club_id='94020000-0000-0000-0000-000000000001'),
  'alerts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.financial_alerts c WHERE source='fn_settle_tournament_rake'));
$state$;
CREATE FUNCTION pg_temp.rake_case(p_case integer,p_state text,p_failures integer,p_expected_attempts integer,p_attributed boolean)
RETURNS void LANGUAGE plpgsql AS $case$
DECLARE tid uuid:=md5('rake-retry-event:'||p_case)::uuid; r jsonb; s jsonb;
  prior_treasury numeric; prior_vip bigint; prior_stats numeric; prior_custody numeric;
BEGIN
  UPDATE pg_temp.rake_fault_policy SET sqlstate=p_state,failures=p_failures;
  PERFORM setval('pg_temp.rake_fault_attempt',1,false);
  SELECT chip_treasury INTO prior_treasury FROM public.clubs WHERE id='94020000-0000-0000-0000-000000000001';
  SELECT count(*) INTO prior_vip FROM public.vip_points_ledger WHERE user_id='94010000-0000-0000-0000-000000000002';
  SELECT COALESCE(sum(total_rake),0) INTO prior_stats FROM public.player_stats WHERE user_id='94010000-0000-0000-0000-000000000002';
  SELECT COALESCE(sum(prize_balance+bounty_balance+fee_balance),0)+prior_treasury INTO prior_custody FROM public.tournament_escrow WHERE opened_from='rake-retry-synthetic-opening-custody';
  r:=public.fn_settle_tournament_rake(tid,'rake-retry-native-probe');
  PERFORM pg_temp.rake_assert((r->>'ok')::boolean AND (r->>'attributed')::boolean=p_attributed
    AND (SELECT is_called AND last_value=p_expected_attempts FROM pg_temp.rake_fault_attempt)
    AND (p_case=1 OR (r->>'attribution_attempts')::integer=p_expected_attempts),
    'case '||p_case||' native fault outcome and exact attempts');
  PERFORM pg_temp.rake_assert((SELECT chip_treasury FROM public.clubs WHERE id='94020000-0000-0000-0000-000000000001')=prior_treasury+1
    AND (SELECT count(*) FROM public.chip_ledger WHERE from_type='prize_liability' AND from_entity_id=tid AND to_type='club_treasury' AND category='rake' AND amount=1)=1,
    'case '||p_case||' one exact native treasury credit and journal');
  PERFORM pg_temp.rake_assert((SELECT sum(prize_balance+bounty_balance+fee_balance) FROM public.tournament_escrow WHERE opened_from='rake-retry-synthetic-opening-custody')
    +(SELECT chip_treasury FROM public.clubs WHERE id='94020000-0000-0000-0000-000000000001')=prior_custody
    AND (SELECT fee_out=1 AND fee_balance=0 AND prize_balance=9 AND bounty_balance=0 AND enforced FROM public.tournament_escrow WHERE tournament_id=tid),
    'case '||p_case||' opening custody conserved through one fee outflow');
  PERFORM pg_temp.rake_assert((SELECT count(*) FROM public.vip_points_ledger WHERE user_id='94010000-0000-0000-0000-000000000002')=prior_vip+CASE WHEN p_attributed THEN 1 ELSE 0 END
    AND (SELECT COALESCE(sum(total_rake),0) FROM public.player_stats WHERE user_id='94010000-0000-0000-0000-000000000002')=prior_stats+CASE WHEN p_attributed THEN 1 ELSE 0 END,
    'case '||p_case||' failed attempts leave no VIP or stats writes');
  PERFORM pg_temp.rake_assert((SELECT attributed_at IS NOT NULL FROM public.tournament_rake_settlements WHERE tournament_id=tid)=p_attributed
    AND (SELECT count(*) FROM public.financial_alerts WHERE source='fn_settle_tournament_rake' AND context->>'tournament_id'=tid::text)=CASE WHEN p_attributed THEN 0 ELSE 1 END,
    'case '||p_case||' completion marker and one failure alert');
  s:=pg_temp.rake_state();
  r:=public.fn_settle_tournament_rake(tid,'rake-retry-native-probe');
  PERFORM pg_temp.rake_assert((r->>'already_settled')::boolean AND pg_temp.rake_state()=s
    AND (SELECT last_value FROM pg_temp.rake_fault_attempt)=p_expected_attempts,
    'case '||p_case||' exact replay changes no money attribution or alerts');
END; $case$;
SELECT pg_temp.rake_case(1,'55P03',1,1,false);
"""

AFTER = r"""
SELECT pg_temp.rake_case(2,'55P03',1,2,true);
SELECT pg_temp.rake_case(3,'40P01',1,2,true);
SELECT pg_temp.rake_case(4,'55P03',99,4,false);
SELECT pg_temp.rake_case(5,'23514',1,1,false);
SELECT pg_temp.rake_assert(NOT EXISTS (
  SELECT 1 FROM rake_trigger_baseline b FULL JOIN pg_trigger t ON t.oid=b.oid
  WHERE b.oid IS NOT NULL AND to_jsonb(t) IS DISTINCT FROM b.metadata),
  'every pre-existing native trigger remains unchanged and enabled as before');
SELECT pg_temp.rake_assert(NOT EXISTS (
  SELECT 1 FROM rake_catalog_baseline b LEFT JOIN pg_proc p ON p.oid=b.oid
  WHERE b.oid<>'public.fn_settle_tournament_rake(uuid,text)'::regprocedure
    AND to_jsonb(p) IS DISTINCT FROM b.metadata),
  'all existing native helpers retain body identity metadata and privileges');
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
DO $verify_rollback$
BEGIN
  IF current_database()<>'postgres' OR current_user<>'postgres'
     OR inet_server_addr() IS NOT NULL OR current_setting('port')<>'55473'
     OR EXISTS(SELECT 1 FROM auth.users)
     OR EXISTS(SELECT 1 FROM public.tournaments)
     OR (SELECT md5(prosrc) FROM pg_proc
          WHERE oid=to_regprocedure('public.fn_settle_tournament_rake(uuid,text)'))
          IS DISTINCT FROM 'e2f61a2c0639e77a015bff61f5703722'
     OR to_regprocedure('public.fn_ca_lock_settlement_lane_global()') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL owned database baseline after rollback';
  END IF;
  RAISE NOTICE 'PASS owned database baseline after rollback';
END; $verify_rollback$;
SELECT current_database() AS database,(SELECT count(*) FROM auth.users) AS users,
 (SELECT count(*) FROM public.tournaments) AS tournaments,
 (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_tournament_rake(uuid,text)'::regprocedure) AS rake_body_after_rollback,
 to_regprocedure('public.fn_ca_lock_settlement_lane_global()') AS helper_after_rollback;
"""


def body(source: str, name: str, digest: str) -> None:
    matches = re.findall(r"CREATE OR REPLACE FUNCTION public\." + name
                         + r"\(.*?AS (\$[^$]*\$)(.*?)\1;", source, re.S)
    if len(matches) != 1 or hashlib.md5(matches[0][1].encode()).hexdigest() != digest:
        raise ValueError(f"unexpected recovered preimage body: {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preimage", type=Path, required=True)
    parser.add_argument("--restoration", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    preimage_bytes = args.preimage.read_bytes()
    restoration_bytes = args.restoration.read_bytes()
    if hashlib.sha256(preimage_bytes).hexdigest() != "ae3a6d579e21ee1c8b7f55780ab061e5bd3021e58dc525b9049ed5818b2cba0b":
        raise ValueError("native preimage file differs from the verified source")
    if hashlib.sha256(restoration_bytes).hexdigest() != "f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c":
        raise ValueError("restoration file differs from the verified source")
    preimage = preimage_bytes.decode("utf-8")
    body(preimage, "fn_settle_tournament_rake", "05a512317bb7bdcecfaec19ef8ee4e63")
    body(preimage, "fn_ca_lock_settlement_lane_global", "343015440ea5c84ee4ca7ae583c73d30")
    restoration = restoration_bytes.decode("utf-8")
    if restoration.count("\nBEGIN;\n") != 1 or restoration.count("\nCOMMIT;") != 1:
        raise ValueError("unexpected restoration transaction boundaries")
    if "rake retry restoration refused: current rake metadata differs" not in restoration:
        raise ValueError("apply the reviewed metadata-hardening transform first")
    restoration = restoration.replace("\nBEGIN;\n", "\n", 1).replace("\nCOMMIT;", "\n", 1)
    sql = PREAMBLE + preimage + SEED + restoration
    sql += "\n-- Replay the exact restoration to prove the idempotent branch.\n" + restoration + AFTER
    args.output.write_text(sql)
    print(f"prepared_unexecuted_sql_sha256={hashlib.sha256(sql.encode()).hexdigest()}")


if __name__ == "__main__":
    main()
