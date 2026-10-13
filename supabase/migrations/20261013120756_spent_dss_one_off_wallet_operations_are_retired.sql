-- Reserved retirement of spent October 12 DSS operations; never invoke their bodies.
-- No payment, wallet, roster, schedule or business terms change.
-- @live-proof: to_regprocedure('public.ops_dss_midway_sweep(text)') IS NULL AND to_regprocedure('public.ops_dss_midway_go_live()') IS NULL AND to_regprocedure('public.ops_ledger_reset_declarations()') IS NULL
-- @live-proof: (SELECT count(*)=2 AND bool_and(status='retired') FROM public.ca_money_rpc_registry WHERE proname IN ('ops_dss_midway_sweep','ops_dss_midway_go_live'))
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$
DECLARE r record; p pg_proc%ROWTYPE;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.ops_dss_midway_sweep(text)','c21ae1d35c9570a54f15ebff5002dbbc',true),
 ('public.ops_dss_midway_go_live()','cb960711b56000d71cd7b54db8d91f00',true),
 ('public.ops_ledger_reset_declarations()','6f48b385af8e854b354dbf9f9b872308',false)
 ) v(signature,digest,definer) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(r.signature);
  IF NOT FOUND OR md5(pg_get_functiondef(p.oid))<>r.digest
   OR p.proowner<>'postgres'::regrole OR p.prosecdef IS DISTINCT FROM r.definer
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
   OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[] THEN
   RAISE EXCEPTION 'spent_dss_operation_preimage_changed: %',r.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM cron.job WHERE command ~* 'ops_dss_midway|ops_ledger_reset_declarations'
   OR jobname IN('dss-midway-go-live','dss-midway-go-live-retry-1','dss-midway-go-live-retry-2')) THEN
  RAISE EXCEPTION 'spent_dss_operation_still_scheduled' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE prokind IN ('f','p')
  AND oid NOT IN ('public.ops_dss_midway_sweep(text)'::regprocedure,
   'public.ops_dss_midway_go_live()'::regprocedure,
   'public.ops_ledger_reset_declarations()'::regprocedure)
  AND (prosrc ILIKE '%ops_dss_midway%' OR prosrc ILIKE '%ops_ledger_reset_declarations%')) THEN
  RAISE EXCEPTION 'spent_dss_operation_has_caller' USING ERRCODE='55000';
 END IF;
 FOR r IN SELECT * FROM (VALUES
 ('ops_dss_midway_sweep', 'One-off, signed off by Dan 2026-10-11. Moves Deep Stack Society''s blocking chips into Midway Union''s bank before the join: BBJ pool + club promo into the club bank via fn_close_club_wallets_on_union_join; horse-agent agent/promo wallets and human member wallets into the club bank via fn_club_bank_claim_back (owner identity); then the club bank into union_wallets.chip_balance in the exact ledger shape of fn_union_clawback_from_club (union_settlement, club_treasury -> union_bank, one leg journalled by the clubs trigger, union_wallets journal stood down, uwt clawback row). Revoked from anon/authenticated.'),
('ops_dss_midway_go_live', 'One-off, signed off by Dan 2026-10-11, fired by pg_cron at 2026-10-12 17:00 UTC. Runs ops_dss_midway_sweep, fn_union_close_club_tables_for_join, inserts union_clubs (join trigger enforces empty club), union_club_terms, releases the DSS horse seating hold via fn_ca_fleet_set_policy, unschedules itself. Moves money only through ops_dss_midway_sweep.')
 ) v(name,notes) LOOP
  PERFORM 1 FROM public.ca_money_rpc_registry m WHERE m.proname=r.name FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry m WHERE m.proname=r.name
    AND m.status='approved' AND m.notes=r.notes) THEN
   RAISE EXCEPTION 'spent_dss_registry_preimage_changed: %',r.name USING ERRCODE='55000';
  END IF;
 END LOOP;
END $guard$;
REVOKE ALL ON FUNCTION public.ops_dss_midway_go_live() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ops_dss_midway_sweep(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ops_ledger_reset_declarations() FROM PUBLIC,anon,authenticated,service_role;
DROP FUNCTION public.ops_dss_midway_go_live() RESTRICT;
DROP FUNCTION public.ops_dss_midway_sweep(text) RESTRICT;
DROP FUNCTION public.ops_ledger_reset_declarations() RESTRICT;
UPDATE public.ca_money_rpc_registry SET status='retired',
 notes=notes||' Retired by 20261013120756 after the dated DSS operation: no remaining callers or schedules; one-off functions removed with RESTRICT. Historical owner claims are not new authority.'
 WHERE proname IN('ops_dss_midway_sweep','ops_dss_midway_go_live');
COMMIT;
