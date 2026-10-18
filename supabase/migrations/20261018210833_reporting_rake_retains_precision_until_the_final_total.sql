-- Reserved by scripts/reserve-migration-version.sh.
-- The final live reconciliation reproduced a one-cent 7-day Data/Report
-- disagreement. The closed-day reporting producer rounded each table's rake
-- to four decimals before summing tables; fractional contribution shares can
-- cross a displayed cent after that rounding. Retain the exact existing fact
-- amount and round only the final displayed total. Recount only this derived
-- rake column for covered closed days; preserve wallets, immutable receipts,
-- other reporting fields, live-day trigger state and days before fact coverage.
-- The exact read-only repair basis qualified 11,725 rows in 1.51 seconds.
-- @live-proof: position('round(SUM(f.fee), 4)' in (SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_reporting_rollups_from_facts(date)'::regprocedure))=0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $patch$
DECLARE original text; revised text;
BEGIN
 original:=pg_get_functiondef('public.fn_ca_reporting_rollups_from_facts(date)'::regprocedure);
 IF md5(original)<>'9c0c488a34cac89c0d39100b5fd91132' THEN
  RAISE EXCEPTION 'Reporting precision producer changed or already installed';
 END IF;
 revised:=replace(original,'round(SUM(f.fee), 4), COALESCE(MAX(h.hands), 0)',
                           'SUM(f.fee), COALESCE(MAX(h.hands), 0)');
 IF revised=original THEN RAISE EXCEPTION 'Reporting precision source replacement missing'; END IF;
 EXECUTE revised;
END $patch$;
REVOKE ALL ON FUNCTION public.fn_ca_reporting_rollups_from_facts(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reporting_rollups_from_facts(date) TO service_role;
WITH exact AS MATERIALIZED (
 SELECT f.club_id,f.game_id,f.stat_date,sum(f.fee) rake
 FROM public.ca_club_data_fact f
 WHERE f.kind='CASH' AND f.stat_date>=public.fn_ca_club_data_facts_from()
  AND f.stat_date<(now() AT TIME ZONE 'UTC')::date
 GROUP BY f.club_id,f.game_id,f.stat_date
)
UPDATE public.club_table_daily d SET rake=f.rake
 FROM exact f WHERE d.club_id=f.club_id AND d.table_id=f.game_id
 AND d.stat_date=f.stat_date AND d.rake IS DISTINCT FROM f.rake;
COMMIT;
