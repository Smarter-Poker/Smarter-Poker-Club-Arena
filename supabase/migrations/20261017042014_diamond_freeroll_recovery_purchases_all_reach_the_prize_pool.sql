-- Reserved by scripts/new-migration.mjs. DA22, discovered during current native qualification.
-- A zero-entry Diamond freeroll rebuy/add-on is wholly prize funded under
-- the recorded economics answers. The new 100-Diamond price exposes the old
-- 10% fallback that rounded to zero at the former 1-Diamond price.
-- Charge and refund reconstruction use the same unit-aware ratio. Chip
-- calculations and paid Diamond events retain their existing fee rule.
-- Read-only production inventory found zero affected fee-bearing receipts;
-- refuse if that changed. No balance, receipt, price or historical row changes.
-- @live-proof: (SELECT public.fn_ca_tournament_purchase_fee_ratio(0,0,100)=0 AND public.fn_ca_tournament_purchase_fee_ratio(0,0,1)=0.1)
BEGIN;
SET LOCAL lock_timeout='5s';
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger l JOIN public.tournaments t ON t.id=l.tournament_id WHERE t.buy_in_amount=0 AND t.buy_in_fee=0 AND l.kind IN ('rebuy','reentry') AND l.fee_part>0) THEN
  RAISE EXCEPTION 'diamond_freeroll_fee_receipts_need_reconciliation';
 END IF;
 IF to_regprocedure('public.fn_ca_tournament_purchase_fee_ratio(numeric,numeric,integer)') IS NOT NULL THEN RAISE EXCEPTION 'diamond_freeroll_fee_migration_already_installed'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_tournament_fee_ratio(numeric,numeric)'::regprocedure)) <> '858c3f3cda609a0b427f294d1c9edf36' THEN RAISE EXCEPTION 'existing_fee_ratio_changed'; END IF;
END $guard$;
CREATE FUNCTION public.fn_ca_tournament_purchase_fee_ratio(p_buy_in numeric,p_buy_in_fee numeric,p_unit_cents integer)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $fee$
 SELECT CASE WHEN p_unit_cents=100 AND p_buy_in=0 AND p_buy_in_fee=0 THEN 0
 ELSE public.fn_ca_tournament_fee_ratio(p_buy_in,p_buy_in_fee) END;
$fee$;
ALTER FUNCTION public.fn_ca_tournament_purchase_fee_ratio(numeric,numeric,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_purchase_fee_ratio(numeric,numeric,integer) FROM PUBLIC,anon,authenticated,service_role;
DO $authority$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_purchase_fee_ratio(numeric,numeric,integer)'::regprocedure
  AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef AND provolatile='i'
  AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl::text='{postgres=X/postgres}') THEN
  RAISE EXCEPTION 'freeroll_fee_helper_authority_changed';
 END IF;
END $authority$;

DO $patch$
DECLARE before_def text;after_def text;before_meta jsonb;after_meta jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig) INTO before_def,before_meta FROM pg_proc WHERE oid='public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
 IF md5(before_def) <> '2077904b2bfc2c99287ad824548b3e92' THEN RAISE EXCEPTION 'freeroll_fee_preimage_changed: fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'; END IF;
 IF (length(before_def)-length(replace(before_def,'public.fn_ca_tournament_fee_ratio(
    v_t.buy_in_amount,v_t.buy_in_fee)','')))/length('public.fn_ca_tournament_fee_ratio(
    v_t.buy_in_amount,v_t.buy_in_fee)') <> 1 THEN RAISE EXCEPTION 'freeroll_fee_call_not_unique'; END IF;
 after_def:=replace(before_def,'public.fn_ca_tournament_fee_ratio(
    v_t.buy_in_amount,v_t.buy_in_fee)','public.fn_ca_tournament_purchase_fee_ratio(
    v_t.buy_in_amount,v_t.buy_in_fee,v_unit)');
 IF md5(after_def) <> '30b96a6e6fe359d10e186c68a023c8fd' THEN RAISE EXCEPTION 'freeroll_fee_postimage_changed'; END IF;
 EXECUTE after_def;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig) INTO after_meta FROM pg_proc WHERE oid='public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure)) <> '30b96a6e6fe359d10e186c68a023c8fd' THEN RAISE EXCEPTION 'freeroll_fee_installed_authority_changed'; END IF;
END $patch$;

DO $patch$
DECLARE before_def text;after_def text;before_meta jsonb;after_meta jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig) INTO before_def,before_meta FROM pg_proc WHERE oid='public.fn_ca_tournament_charge_split(uuid,text,numeric)'::regprocedure;
 IF md5(before_def) <> '6dbf9fd2d48c27277055502e5a5e47af' THEN RAISE EXCEPTION 'freeroll_fee_preimage_changed: fn_ca_tournament_charge_split(uuid,text,numeric)'; END IF;
 IF (length(before_def)-length(replace(before_def,'public.fn_ca_tournament_fee_ratio(
      v_t.buy_in_amount, v_t.buy_in_fee)','')))/length('public.fn_ca_tournament_fee_ratio(
      v_t.buy_in_amount, v_t.buy_in_fee)') <> 1 THEN RAISE EXCEPTION 'freeroll_fee_call_not_unique'; END IF;
 after_def:=replace(before_def,'public.fn_ca_tournament_fee_ratio(
      v_t.buy_in_amount, v_t.buy_in_fee)','public.fn_ca_tournament_purchase_fee_ratio(
      v_t.buy_in_amount, v_t.buy_in_fee, public.fn_ca_tournament_unit_cents(p_tournament_id))');
 IF md5(after_def) <> '26545c9dc6b043859f3090a915e5347a' THEN RAISE EXCEPTION 'freeroll_fee_postimage_changed'; END IF;
 EXECUTE after_def;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig) INTO after_meta FROM pg_proc WHERE oid='public.fn_ca_tournament_charge_split(uuid,text,numeric)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('public.fn_ca_tournament_charge_split(uuid,text,numeric)'::regprocedure)) <> '26545c9dc6b043859f3090a915e5347a' THEN RAISE EXCEPTION 'freeroll_fee_installed_authority_changed'; END IF;
END $patch$;

COMMIT;
