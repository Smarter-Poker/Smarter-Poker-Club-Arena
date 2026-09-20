-- Exact semantic catalog plus full-state observer supplied by the retained oracle.
-- relhastriggers is a conservative relcache hint that DROP TRIGGER need not clear;
-- actual complete pg_trigger rows, not that hint, prove restored trigger absence.
-- snapshot.sql separately retains both raw hint observations without claiming equality.
CREATE FUNCTION pg_temp.receipt_lane_catalog() RETURNS jsonb LANGUAGE sql AS $catalog$
 SELECT jsonb_build_object(
  'public_schema',(SELECT to_jsonb(n) FROM pg_namespace n WHERE n.nspname='public'),
  'functions',(SELECT jsonb_agg(jsonb_build_object('proc',to_jsonb(p),'comment',obj_description(p.oid,'pg_proc')) ORDER BY p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
      'fn_ca_share_settlement_lane_for_table','fn_ca_lock_settlement_lane_global','fn_ca_lock_settlement_lane_for_tournament',
      'record_rake','calculate_cascading_commission','settle_hand_atomically','sp_compact_hand_history',
      'fn_complete_tournament_terminal','fn_settle_tournament_places'])),
  'triggers',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.tgrelid,t.tgname),'[]'::jsonb) FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgrelid IN('public.hand_history'::regclass,'public.settlement_idempotency_keys'::regclass)),
  'relations',(SELECT jsonb_agg(to_jsonb(c)-'relhastriggers' ORDER BY c.oid) FROM pg_class c WHERE c.oid IN
    ('public.hand_history'::regclass,'public.settlement_idempotency_keys'::regclass,'public.hand_history_compaction_policy'::regclass)))
$catalog$;
CREATE FUNCTION pg_temp.receipt_lane_handler() RETURNS jsonb LANGUAGE sql AS $handler$
 SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,
  'body_md5',md5(p.prosrc),'config',p.proconfig,'security_definer',p.prosecdef,'volatility',p.provolatile)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_ca_serialize_legacy_settlement_receipt_statement()')
$handler$;
