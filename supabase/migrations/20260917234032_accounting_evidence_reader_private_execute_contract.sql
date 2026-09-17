-- Restate the existing private execute contracts of this accounting delivery.
-- CREATE OR REPLACE preserved the installed private ACLs, read back after install.
-- Source-only checks cannot infer those unchanged ACLs. This guarded successor
-- states each contract explicitly without rewriting applied migration bytes.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $guard$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text)', 'b9fdb4ba6d4b9ad9cabe1450dd4b357f', '{postgres=X/postgres}'),
    ('public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)', 'b49649072c10703f40bb60ef6d0e31b9', '{postgres=X/postgres}'),
    ('public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid)', '939957ab53057c5ab2973fc8d5a3a3b3', '{postgres=X/postgres}'),
    ('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)', 'f5fe4f574d43082134178d377dcc6a9b', '{postgres=X/postgres}'),
    ('public.fn_cash_accept_hand_provenance(uuid,bigint,uuid,jsonb,numeric,numeric,numeric,text,jsonb)', '0201dc9ab47ebf759031ebc737900e67', '{postgres=X/postgres}'),
    ('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)', '96375c09a69beadb93e54397df0115c3', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_cash_provenance_immutable()', 'b94e2c8cc90828957144d06cd626f132', '{postgres=X/postgres}'),
    ('public.fn_cash_record_funding_application(uuid,numeric,numeric,uuid)', 'cfb7e5a9e43e8e5775a00132119d48a1', '{postgres=X/postgres}'),
    ('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)', 'b30ed407ba1f918e91834ebdf2857030', '{postgres=X/postgres}'),
    ('public.fn_club_members_ledger_writer()', '89c4ccea02b1efd780c41e11694e2a0a', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_detect_results_without_a_hand(integer)', 'b9c1fe61a43cde04484a8b124626e1e7', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_hand_history_prune_backlog()', '7eaba40f4568528a27ec53ee9ca37b2e', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)', 'b5b07fa131b40391a8ff46e654c89fe8', '{postgres=X/postgres}'),
    ('public.fn_pnl_cash_hand_evidence(uuid,bigint)', '79c1675f477cbd7b3ed80c91ab918ce0', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_prune_ca_hand_facts(integer)', '1daadc9f10eb53ce97519db956f8c90a', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.resolve_pending_addon(uuid,numeric)', '5eb2df5f9fe8f051aeac3931fa3b079e', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.sp_prune_hand_history(integer)', '52a56eefd5555bf016e5cbd7167f923e', '{postgres=X/postgres}')
  ) expected(signature, body_md5, private_acl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(r.signature)
      AND md5(p.prosrc)=r.body_md5 AND pg_get_userbyid(p.proowner)='postgres'
      AND p.proacl::text=r.private_acl) THEN
      RAISE EXCEPTION 'accounting predecessor or private ACL changed: %', r.signature;
    END IF;
  END LOOP;
END
$guard$;
REVOKE ALL ON FUNCTION public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atomic_table_addon_before_maintenance_announcement_gate(uuid,uuid,numeric,boolean,text) FROM service_role;
REVOKE ALL ON FUNCTION public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,uuid,numeric,uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_cash_accept_hand_provenance(uuid,bigint,uuid,jsonb,numeric,numeric,numeric,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_accept_hand_provenance(uuid,bigint,uuid,jsonb,numeric,numeric,numeric,text,jsonb) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_provenance_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_provenance_immutable() FROM service_role;
REVOKE ALL ON FUNCTION public.fn_cash_record_funding_application(uuid,numeric,numeric,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_record_funding_application(uuid,numeric,numeric,uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_club_members_ledger_writer() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_members_ledger_writer() TO service_role;
REVOKE ALL ON FUNCTION public.fn_detect_results_without_a_hand(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_detect_results_without_a_hand(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_hand_history_prune_backlog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_hand_history_prune_backlog() TO service_role;
REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_prune_ca_hand_facts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_ca_hand_facts(integer) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_pending_addon(uuid,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_pending_addon(uuid,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer) FROM service_role;
COMMIT;
