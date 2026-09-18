-- Qualification only: full bounded business rows and exact affected catalog.
-- The original lane snapshot excludes only relhastriggers, a conservative
-- relcache hint. Definitions, owner/ACL, bindings and rows remain exact.
\ir ../spin-history-retention/database-state.sql
\ir ../spin-receipt-lane/state.sql
CREATE FUNCTION pg_temp.current_lane_state() RETURNS jsonb LANGUAGE sql AS $current_state$
 SELECT jsonb_build_object('catalog',pg_temp.receipt_lane_catalog(),
  'current_cohort',(SELECT jsonb_agg(jsonb_build_object('proc',to_jsonb(p),'comment',obj_description(p.oid,'pg_proc')) ORDER BY p.oid)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
    'fn_ca_lock_settlement_lane_for_finish','fn_ca_settlement_lane_doctrine',
    'fn_ca_tournament_terminal_receipt','fn_complete_tournament_terminal_pre_seat_guard'])),
  'handler',pg_temp.receipt_lane_handler(),'business',pg_temp.retention_database_state());
$current_state$;
