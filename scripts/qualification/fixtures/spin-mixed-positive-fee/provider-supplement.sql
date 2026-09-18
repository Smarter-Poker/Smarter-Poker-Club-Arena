-- SOURCE ONLY / NATIVE UNRUN. Private fixture supplement, never a production migration.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public,pg_temp;
SET LOCAL timezone='UTC';
SELECT set_config('qualification.execution_uuid', :'execution_uuid', true) AS execution_uuid;
DO $boundary$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
    OR current_setting('session_replication_role')<>'origin'
    OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('qualification.execution_uuid') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid'),'-','')
 THEN RAISE EXCEPTION 'positive-fee provider requires exact isolated PG17 owner/socket boundary' USING ERRCODE='55000'; END IF;
END $boundary$;
CREATE OR REPLACE FUNCTION pg_temp.positive_fee_relation(n text) RETURNS jsonb LANGUAGE sql STABLE AS $reader$
SELECT jsonb_build_object('name',r.relname,'kind',r.relkind,'owner',pg_get_userbyid(r.relowner),'acl',r.relacl::text,'rls',r.relrowsecurity,'force_rls',r.relforcerowsecurity,
'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid,false),'owned_sequence',pg_get_serial_sequence('public.'||n,a.attname),'sequence',(SELECT jsonb_build_object('owner',pg_get_userbyid(sc.relowner),'acl',sc.relacl::text,'type',format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,'max',s.seqmax::text,'min',s.seqmin::text,'cache',s.seqcache::text,'cycle',s.seqcycle) FROM pg_class sc JOIN pg_sequence s ON s.seqrelid=sc.oid WHERE sc.oid=to_regclass(pg_get_serial_sequence('public.'||n,a.attname)))) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'definition',pg_get_constraintdef(c.oid,false),'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred) ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid=r.oid),'[]'::jsonb),
'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'nulls_not_distinct',i.indnullsnotdistinct) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),'[]'::jsonb),
'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END ORDER BY role_oid) FROM unnest(p.polroles) role_oid),'using',pg_get_expr(p.polqual,p.polrelid,false),'check',pg_get_expr(p.polwithcheck,p.polrelid,false)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=r.oid),'[]'::jsonb),
'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,false),'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'handler',t.tgfoid::regprocedure::text) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=r.oid AND NOT t.tgisinternal),'[]'::jsonb))
FROM pg_class r WHERE r.oid=to_regclass('public.'||n)
$reader$;
CREATE OR REPLACE FUNCTION pg_temp.positive_fee_tournament_target(pretty boolean) RETURNS jsonb LANGUAGE sql STABLE AS $target$
SELECT jsonb_build_object(
'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid,false)) ORDER BY a.attname),'[]'::jsonb) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.tournaments'::regclass AND NOT a.attisdropped AND a.attname=ANY(ARRAY['format_contract','max_players','restart_source_id'])),
'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'definition',pg_get_constraintdef(c.oid,pretty),'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred) ORDER BY c.conname),'[]'::jsonb) FROM pg_constraint c WHERE c.conrelid='public.tournaments'::regclass AND c.conname=ANY(ARRAY['tournament_prize_math_contract_valid','tournaments_format_contract_known','tournaments_heads_up_rake_within_5_pct','tournaments_recorded_entry_capacity','tournaments_restart_source_id_fkey'])),
'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'primary',i.indisprimary,'nulls_not_distinct',i.indnullsnotdistinct) ORDER BY ic.relname),'[]'::jsonb) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid='public.tournaments'::regclass AND ic.relname='tournaments_one_restart_per_source'))
$target$;
CREATE OR REPLACE FUNCTION pg_temp.positive_fee_untouched() RETURNS jsonb LANGUAGE sql STABLE AS $untouched$
SELECT jsonb_build_object('tournaments',(SELECT jsonb_set(jsonb_set(jsonb_set(jsonb_set(r,'{columns}',(SELECT coalesce(jsonb_agg(x ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(r->'columns') WITH ORDINALITY a(x,ord) WHERE x->>'name' NOT IN ('format_contract','max_players','restart_source_id'))),'{constraints}',(SELECT coalesce(jsonb_agg(x ORDER BY x->>'name'),'[]'::jsonb) FROM jsonb_array_elements(r->'constraints') a(x) WHERE x->>'name' NOT IN ('tournament_prize_math_contract_valid','tournaments_format_contract_known','tournaments_heads_up_rake_within_5_pct','tournaments_recorded_entry_capacity','tournaments_restart_source_id_fkey'))),'{indexes}',(SELECT coalesce(jsonb_agg(x ORDER BY x->>'name'),'[]'::jsonb) FROM jsonb_array_elements(r->'indexes') a(x) WHERE x->>'name'<>'tournaments_one_restart_per_source')),'{triggers}','[]'::jsonb) FROM (SELECT pg_temp.positive_fee_relation('tournaments') r) v),
'other_bindings',(SELECT coalesce(jsonb_agg(jsonb_build_object('relation',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled,'handler_oid',t.tgfoid::text) ORDER BY c.relname,t.tgname),'[]'::jsonb) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.oid IN ('public.tables'::regclass,'public.table_seats'::regclass,'public.tournament_players'::regclass) AND NOT t.tgisinternal AND t.tgname NOT IN ('union_pnl_original_inventory','union_pnl_original_inventory_no_truncate')))
$untouched$;
DO $preimage$ DECLARE expected jsonb; actual jsonb; name text; has_rows boolean; BEGIN
FOR name IN SELECT jsonb_array_elements_text($capture$["accounting_cash_accrual_batches","accounting_cash_accrual_cutover","accounting_cash_rake_sources","accounting_tournament_fee_cutover","ca_mtt_admission_contract","union_pnl_inventory_events","union_pnl_original_flows","union_pnl_transaction_frames"]$capture$::jsonb) LOOP IF to_regclass('public.'||name) IS NOT NULL THEN RAISE EXCEPTION 'positive-fee provider requires absent relation: %',name; END IF; END LOOP;
FOR name IN SELECT jsonb_array_elements_text($capture$["accounting_agreement_history","accounting_period_recompute_requests","accounting_routed_settlement_runs","accounting_tournament_fee_batches","accounting_tournament_fee_recognitions","accounting_tournament_fee_sources","accounting_tournament_recognized_sources","agent_commissions","agents","chip_ledger","club_members","clubs","hand_history","rake_records","table_seats","tables","tournament_players","tournament_terminal_settlements","tournaments","union_clubs","union_wallet_transactions"]$capture$::jsonb) LOOP EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I LIMIT 1)',name) INTO has_rows; IF has_rows THEN RAISE EXCEPTION 'positive-fee provider requires empty estate: %',name USING ERRCODE='55000'; END IF; END LOOP;
IF pg_temp.positive_fee_tournament_target(false) IS DISTINCT FROM $capture${"columns":[{"acl":null,"name":"max_players","type":"integer","default":null,"identity":"","not_null":true,"generated":""}],"constraints":[{"name":"tournament_prize_math_contract_valid","type":"c","definition":"CHECK ((((payout_math_version = 1) AND (payout_unit_cents = 1)) OR ((payout_math_version = 2) AND (payout_unit_cents = ANY (ARRAY[1, 100])) AND (upper(COALESCE(tournament_type, ''::text)) = 'MTT'::text) AND (COALESCE(max_players, 0) > 2) AND (lower(COALESCE(variant, ''::text)) <> ALL (ARRAY['spin'::text, 'sng'::text, 'satellite'::text])) AND (NOT COALESCE(is_premium_spin, false)) AND (satellite_target_id IS NULL) AND (satellite_target IS NULL))))","validated":true,"deferrable":false,"deferred":false},{"name":"tournaments_heads_up_rake_within_5_pct","type":"c","definition":"CHECK (((max_players IS NULL) OR (max_players > 2) OR (COALESCE(buy_in_fee, (0)::numeric) <= (round(((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.05), 2) + 0.005)))) NOT VALID","validated":false,"deferrable":false,"deferred":false}],"indexes":[]}$capture$::jsonb THEN RAISE EXCEPTION 'positive-fee tournament targeted preimage differs' USING ERRCODE='55000'; END IF;
FOR expected IN SELECT value FROM jsonb_array_elements($capture$[{"signature":"enforce_chip_ledger_performed_by()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"ce4ab3013be283d66ab9afd1e861b552","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"90aec8c54e892a4d6977a232c5d50342","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_accounting_agreement_capture()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"746fab25cd56f6ad761325e7c0d525d5","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_agreement_history_immutable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3fa4099435ff1e9d5c48fa1934b63549","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_accounting_cash_commission_source_guard()","absent":true},{"signature":"fn_accounting_cash_source_immutable()","absent":true},{"signature":"fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)","absent":true},{"signature":"fn_accounting_terms_at(text,text,timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"7ce22d801a2020499695febf374adabb","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_commission_source_guard()","absent":true},{"signature":"fn_accounting_tournament_fee_commit_capture()","absent":true},{"signature":"fn_accounting_tournament_fee_receipt_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"bdc4ee4b75e3471cd33a5ed4b250ec0f","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_fee_source_immutable()","absent":true},{"signature":"fn_accounting_tournament_recognized_evidence_immutable()","absent":true},{"signature":"fn_accounting_transfer_document_on_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"bf9d870bfc52d44c1d2cc33860dfd71a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_admin_holds_no_player_wallet()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3c54c86c548917606c846febfadf704b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_agent_credit_control_revision_v1()","absent":true},{"signature":"fn_agents_staff_earn_no_rakeback()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"17346b77ec8f5a1d6d42dca3eb06e061","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_audit_club_entry_mutation()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"d26149a3b10aa00618a98f5076ebf079","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_audit_club_member_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"06515aa426034c1174450e2dc37204ef","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_award_vip_points_from_rake()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"23ee9b47483898b695bbdf7afea48b01","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_block_browser_balance_inserts()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"88e61c03b82bedcdc67113f795355d4a","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_block_browser_balance_writes()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"c7390598f411e7d6bc4b8daf00e12c6e","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_ca_attested_day_is_restated()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public","TimeZone=UTC"],"full_md5":"268e0f244b2df7f88b933530b1cad822","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_autoledger()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2ff8923b4c2d8fd3d343cf37acce0f2c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_autoledger_delete()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"c6d7e02df8b654fbccc3e8844418bd01","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_capture_tournament_charge_entitlement()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"01e84bcd7825d2e905fef3ec220b3a47","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_capture_tournament_credit_ledger()","absent":true},{"signature":"fn_ca_chip_ledger_enrich()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"5931f47d922eea26ab1ea2b12f3f7c8c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_chip_store_declared()","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d5b08956826e56a0d414db4bfd022d3b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_overlay_leg()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"1b916fb576271d94c481099c11ca8b93","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_rake_record()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0dc096bb5615758ed945365a45997c8c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_reserve_leg()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0d7f735d58aadeb6fe03e9daf5e21a92","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_seat_transfer_leg()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e9c56f9c21635b21c7cf0d456eb18b8a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_fund_overlay_on_lock()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"a18b13b709dc1e4d37b38f55a00eb6f4","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_guard_mtt_admission_contract()","absent":true},{"signature":"fn_ca_guard_new_satellite_target()","absent":true},{"signature":"fn_ca_guard_tournament_format()","absent":true},{"signature":"fn_ca_guard_tournament_restart_source()","absent":true},{"signature":"fn_ca_is_new_mtt(jsonb)","absent":true},{"signature":"fn_ca_issuance_leg_is_registered()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"7a41ac630bad489e02f05f47ff5ffa1e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_journal_append_only()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"ac9d66e60d077d886981c428c71e5c3c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_legacy_tournament_format(jsonb)","absent":true},{"signature":"fn_ca_lock_mtt_admission_contract()","absent":true},{"signature":"fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"24fc93502f66beb34c31e1a16c87a147","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_new_tournament_is_unlimited(jsonb)","absent":true},{"signature":"fn_ca_normalize_new_mtt_capacity()","absent":true},{"signature":"fn_ca_reject_automated_user_club_row()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"7c73094df30c90f94a78cbbd5d24f504","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_tournament_format_identity(jsonb)","absent":true},{"signature":"fn_ca_tournament_recorded_format(uuid)","absent":true},{"signature":"fn_ca_tournament_recorded_seat_first(uuid,boolean)","absent":true},{"signature":"fn_ca_tournament_seat_cap(uuid)","absent":true},{"signature":"fn_ca_unregistration_rake_evidence_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"4d035b0d2f169db1cdbe987078448e99","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_caller_session_is_live()","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=pg_catalog, public, auth"],"full_md5":"23ffeea99f9d9e76102ecbf6185222c0","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_cancelled_tournament_evidence_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"55061034adb7416d401622572397c7d2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_cancelled_tournament_parent_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"45afe1986ef3e5a382aab017dcf3689c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_capture_accounting_tournament_fee(uuid,jsonb)","absent":true},{"signature":"fn_capture_managed_game_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp"],"full_md5":"28e259c9fd0c76f39c5ca5b5f0328777","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_clear_seats_on_game_end()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"9660c076fa2d1739a01ed360933f3c26","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"162eba07a4e75f16ae21e5ca809ee595","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_member_notes_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"cc7bae672aea44a800052d2aba490360","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_bot_follows_horse()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"02033ded814911b9a5a74ecf91dfa2e9","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_ledger_writer()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"1f8bc3e17233defa23ebfda4e30015db","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_no_agent_cycle()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"a7ad3c53fcab80a15831e71544b53c56","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_role_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2374cfedbbe89d3a69c75cdfdb240fe6","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_club_members_staff_earn_no_rakeback()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"09ae811a57faa517720d493d89262f31","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_create_seat_first_game_atomic(uuid,jsonb)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=30s"],"full_md5":"92cbf5680d78bdbaa4309412b3d19dfd","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_deep_stack_society_cannot_be_deleted_by_accident()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"213a7fa40330c703cb23dc001a99d31e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_emit_managed_game_row_event()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2042d20f7a0f3951352069a279e75362","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_emit_management_access_event()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"9963925e6cd6da557b9de6f1749db0fd","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_agent_commission_bounds()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3e4f5df422b121391cc40f711ae5b5ee","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_club_enters_union_empty()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"23c5f3b77830234a6c0181474fe8caee","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_four_club_limit()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"4c27b1c5f7b438dfa569699d19f2200a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_tournament_union_ownership_update()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"5c7ea135e9566b108e96ed3af5a9f5d2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_whole_dollar_buyin()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"652e99519fb365b9ed5fb23e70519e49","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_freerolls_are_free_buy()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b4cd5955cb813a63b6364b9b9f1de844","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_agent_agreement()","absent":true},{"signature":"fn_guard_managed_game_delete()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"bef4392e9fa3124cecaaf74a739e465b","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_guard_managed_game_lifecycle()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"16d4a93cbee7574608e18287bf555f24","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_guard_membership_lifecycle_write()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"bb2eca3ab004597dbd9137f78951e943","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_new_mtt_blind_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"15dd4f5521cfc9a285bef1cfc97931cd","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_rake_belongs_to_club()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"04f17832e28e53b2ca5b33eb3b8e0982","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_guard_registered_tournament_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"8c110d7334b93cc527b6d4dfe8bb5fcb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_retired_club_mutation()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"b82be212e7ccf2a15637c231861ff993","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_completed_certificate()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"8a05956d1fd25d649f1f80b133ed3ed0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_completing_claim()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"311ed77e7726f0c7515859a9140d526c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_mystery_creation_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"07d896448e45728a89fc46eafc2a0eeb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_prize_math_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"9db38ea56f880456fdbbc29394c4cb27","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_publish_readiness()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"0aa1e473750e160884700c441d3953e2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_start_readiness()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"f2ee43657b769c37527ae2974101bb06","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_membership_approval_gate()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b5edea413fa87af75f47b925a23b1d10","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_membership_starts_with_zero_chips()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e865fa31892646611ec011821a9fd219","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_non_satellite_completed_requires_terminal_receipt()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"f2da9a0bcf45eec68489fe51fd6f224b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_poker_guard_arena_structure()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"f17675dd0b647abda7b0b9d8772c9c0e","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_poker_reject_diamond_hierarchy()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"49037a2bf4322d2a327bc9141a7a7a89","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb)","absent":true},{"signature":"fn_receipt_mystery_activation()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"222c1ea113b7df08cdfad43078022074","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_receipted_tournament_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"961aa627ed8cb88d11b4750ef3464be5","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_recompute_club_level_on_member_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0a761d5d6027c26ddbe4a7760d23d434","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_recompute_union_level_on_club_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"102d867367cdc4e88cba99ecc53763c9","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_refuse_completed_with_pending_bounties()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"36b386279189cbd1e5a5a9541ba3ec94","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_refuse_mystery_activation_with_pending_heads()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"b9be582a1a903cf71e2e32795dd1527e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_refuse_new_entries_while_frozen()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"0af4299f549c144ce93b2f37914f6b4e","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_refuse_while_frozen()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"3a866372172806a8a69cc3d37413f0cc","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_release_seats_on_tournament_finish()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"7e9ab84b48a96dda6029414f889ab39f","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_require_explicit_club_membership_source()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3c4e9aa515a8b8c8226fdf18332156a3","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_retire_manager_wakes_after_terminal_status()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"2fa4c2d4bb63ece41ed78c3f11cd770c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_feeds_only_a_deliverable_target()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"4251f65adfd51a29967a346af7ae98f1","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_target_contract_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"68f353273fb27d0eee5021481192e902","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_target_rake_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"42499ae4d7edff6b56e2211a9149a64a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_transfer_ledger_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"b2affe52c4e95101c985c30c483d5127","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_seat_change_syncs_seat_first_count()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"f5b45635a8203fc8fbd95282d4770dc8","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_short_formats_never_break()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"c1a3d79a8fd639618e81ec1b2f25abe7","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_spin_book_entry(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"3e861cfde0bda50d16bc836a665bf4ab","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_spin_ladder_is_the_drawn_one()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2a2786ee7663657383c4930c90842051","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_spin_rake_rate(numeric)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"dad580a8513512273e6109b4fea19edd","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_spin_reserve_pool(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d3596faa39ba012e437d769386f8a057","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_spin_tournament_contract_is_draw()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"747fc99476b082256141d42003a6c478","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_stamp_accounting_tournament_fee(uuid)","absent":true},{"signature":"fn_stamp_tournament_terminal_evidence_markers()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"eeec4e4610901fe4b44b0b8f270d1ef7","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_stamp_tournament_union_ownership()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"feb3b58d1e4af815e6d499d8ed8d6c6c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_agent_player_counts()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"76a5848cfdb6c1674b48cb62ae1f22dd","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_club_member_count()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2abaebf91e89f56487f01b25d7e3ac98","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_club_union_mirror()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"119b0030a566ae5701cdecfa81aee13e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_mfa_required_on_club_role()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"b09cbcddc87075221d72aee3899e97b4","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_sync_seat_first_player_count(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"6ca19586d771591fb674d07e4b0c323c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_union_membership_table_counts()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d0f49fa15340884a978759cfaf54ab88","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_take_seat_and_buy_in(uuid,integer)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp","statement_timeout=30s"],"full_md5":"a965493d4837187d433b3cdd40c5da81","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, extensions"],"full_md5":"d5ec9bc535b1a0b84140af8a48da8640","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_terminal_tournament_evidence_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"a129e4214f59e7f95ffe397e2245bbd0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_tournament_fee_names_its_player()","owner":"postgres","acl":"{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"a34e26b81ceeda38237b739245ff11f6","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_tournaments_creation_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"625347745f78aca51aaa83bb769072a7","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_tournaments_refuse_unbuilt_multi_day()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"c52fa39e800b18f319a8171cb52ab637","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_union_pnl_capture_original_flow()","absent":true},{"signature":"fn_union_pnl_inventory_immutable()","absent":true},{"signature":"fn_union_pnl_inventory_observe()","absent":true},{"signature":"fn_union_pnl_inventory_project(text,jsonb)","absent":true},{"signature":"fn_union_pnl_original_frame()","absent":true},{"signature":"fn_union_week_start(timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"103f192a228084dad0e4268c36c82c4b","volatility":"i","security_definer":false,"kind":"f"},{"signature":"guard_agent_wallet_direct_update()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"736aa9e92265453c3015223562108141","volatility":"v","security_definer":false,"kind":"f"},{"signature":"lock_club_cashier_hierarchy_mutation()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"2bf2e0dc1876c5b1238603fc18558907","volatility":"v","security_definer":false,"kind":"f"},{"signature":"sync_agent_wallet_columns()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"3a3d351dd05b5dc13b525b7eb4635e5c","volatility":"v","security_definer":false,"kind":"f"},{"signature":"trg_agent_commission_rollup_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"4ec76190867a2fe990abddeb01b8cad5","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_agent_commission_rollup_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"50cb43eb54b7924b39c25b9816f450a0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_atomic_final_table_deal_completion_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"38bf96ba348994fd40264584c26107d8","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_auto_recompute_club_level()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"91f239bc0f5b75e5147ef6bd19ff761b","volatility":"v","security_definer":false,"kind":"f"},{"signature":"trg_ca_club_rake_daily_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0eff9721f6fb1f9d0295184eaafab2f2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_ca_club_rake_daily_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"4bb7c4d64021796803829faacbcddbb0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_ca_reporting_rake_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"77a5bc5c710f2dbc04b547cab55672a0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_ca_reporting_repair_changed_days()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"601c605e44856e42ee0d00e72a0fdb1e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_capture_satellite_economics_on_start()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"9a39bb425387ade0232c76f78267d598","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_freeze_finalized_tournament_prize_pool()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d58236d778465cfd5f4c1e25933f77f4","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_freeze_registered_tournament_settlement_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"caf4aedb5da06e764930e61d9ed7158e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_guard_atomic_satellite_completion()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"8ac917a51ecde732a1f9c27527c87219","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_lock_atomic_final_table_deal_status()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b16256830158e669defcff8751cb5be7","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_lock_atomic_place_tournament_status()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0923d477f8cbb2c11eaa7c6acf0f8f5d","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_lock_tournament_start_time_during_launch()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"41d41eef67325a9e463043269d19b9bf","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_refuse_normal_tournament_completed_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b1ed0b6d633f570d0c5038edce75b62c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_spin_completed_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"47439a8a8cde90ed307f9f79f4eb3a95","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournament_atomic_place_completion_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"18cf8159e315f322ac7cc09e1f913671","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournament_completed_stats()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"074f801970b6e6e90c2370a63816ba28","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournament_pool_finalization_window_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"6ba00817ea7d386e3c1d37212b9c9866","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournaments_cancel_must_refund()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"a4643c9ed980e3008369884e3ac2a96c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournaments_guarantee_affordable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"91f977eaec85de7f6b478d37184e9732","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournaments_rank_before_complete()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"89f80b8b181cf7717fcdee2a94d161ed","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_union_rake_weekly()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e3dacea902d1b1e3053326c07ec90b56","volatility":"v","security_definer":true,"kind":"f"},{"signature":"update_updated_at_column()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"54801f8bc343c4928383a3e7a1d57d61","volatility":"v","security_definer":false,"kind":"f"},{"signature":"zz_chip_ledger_key_is_claimed_once()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"57a2b2eb1bc5b1c5ac36394c2ac23bcd","volatility":"v","security_definer":true,"kind":"f"}]$capture$::jsonb) LOOP
IF expected ? 'absent' THEN IF to_regprocedure('public.'||(expected->>'signature')) IS NOT NULL THEN RAISE EXCEPTION 'expected absent function: %',expected->>'signature'; END IF; ELSE
SELECT jsonb_build_object('signature',expected->>'signature','owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',to_jsonb(p.proconfig),'full_md5',md5(pg_get_functiondef(p.oid)),'volatility',p.provolatile,'security_definer',p.prosecdef,'kind',p.prokind) INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(expected->>'signature'));
IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'positive-fee function preimage differs: %',expected->>'signature' USING ERRCODE='55000'; END IF; END IF; END LOOP;
FOR expected IN SELECT value FROM jsonb_array_elements($capture$[{"name":"accounting_agreement_history","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"id","type":"bigint","not_null":true,"identity":"d","generated":"","acl":null,"default":null,"owned_sequence":"public.accounting_agreement_history_id_seq","sequence":{"owner":"postgres","acl":"{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}","type":"bigint","start":"1","increment":"1","max":"9223372036854775807","min":"1","cache":"1","cycle":false}},{"name":"entity_type","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"entity_key","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"club_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"subject_user_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"event_type","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"observed_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"clock_timestamp()","owned_sequence":null,"sequence":null},{"name":"transaction_id","type":"bigint","not_null":true,"identity":"","generated":"","acl":null,"default":"txid_current()","owned_sequence":null,"sequence":null},{"name":"actor_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"before_terms","type":"jsonb","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"after_terms","type":"jsonb","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null}],"constraints":[{"name":"accounting_agreement_history_check","type":"c","definition":"CHECK (((before_terms IS NOT NULL) OR (after_terms IS NOT NULL)))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_agreement_history_entity_type_check","type":"c","definition":"CHECK ((entity_type = ANY (ARRAY['agents'::text, 'club_members'::text, 'union_clubs'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_agreement_history_event_type_check","type":"c","definition":"CHECK ((event_type = ANY (ARRAY['baseline'::text, 'INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_agreement_history_pkey","type":"p","definition":"PRIMARY KEY (id)","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"accounting_agreement_history_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX accounting_agreement_history_pkey ON public.accounting_agreement_history USING btree (id)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"accounting_agreement_history_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_immutable BEFORE DELETE OR UPDATE ON public.accounting_agreement_history FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"},{"name":"accounting_agreement_history_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_no_truncate BEFORE TRUNCATE ON public.accounting_agreement_history FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"}]},{"name":"agents","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,anon=xtm/postgres,authenticated=rxtm/postgres,service_role=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":"gen_random_uuid()","owned_sequence":null,"sequence":null},{"name":"user_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"club_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"membership_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"role","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"status","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":"'active'::text","owned_sequence":null,"sequence":null},{"name":"parent_agent_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"commission_rate","type":"numeric(5,4)","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"player_rakeback_rate","type":"numeric(5,4)","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"credit_limit","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"credit_used","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"is_prepaid","type":"boolean","not_null":true,"identity":"","generated":"","acl":null,"default":"false","owned_sequence":null,"sequence":null},{"name":"business_balance","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"player_balance","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"promo_balance","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"total_players","type":"integer","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"active_player_count","type":"integer","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"sub_agent_count","type":"integer","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"weekly_rake_generated","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"lifetime_earnings","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"joined_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null},{"name":"last_active_at","type":"timestamp with time zone","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"created_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null},{"name":"updated_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null},{"name":"auto_rakeback_enabled","type":"boolean","not_null":false,"identity":"","generated":"","acl":null,"default":"true","owned_sequence":null,"sequence":null},{"name":"rakeback_percentage","type":"numeric(5,4)","not_null":false,"identity":"","generated":"","acl":null,"default":"0.0000","owned_sequence":null,"sequence":null},{"name":"agent_wallet_balance","type":"numeric(18,2)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"player_wallet_balance","type":"numeric(18,4)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"promo_wallet_balance","type":"numeric(18,2)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"lifetime_rake_generated","type":"numeric(18,4)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null}],"constraints":[{"name":"agents_agent_wallet_balance_nonneg","type":"c","definition":"CHECK ((agent_wallet_balance >= (0)::numeric))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_club_id_fkey","type":"f","definition":"FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE","validated":true,"deferrable":false,"deferred":false},{"name":"agents_club_id_user_id_key","type":"u","definition":"UNIQUE (club_id, user_id)","validated":true,"deferrable":false,"deferred":false},{"name":"agents_commission_rate_check","type":"c","definition":"CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= 0.70)))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_credit_used_check","type":"c","definition":"CHECK ((credit_used >= (0)::numeric))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_pkey","type":"p","definition":"PRIMARY KEY (id)","validated":true,"deferrable":false,"deferred":false},{"name":"agents_player_rakeback_rate_check","type":"c","definition":"CHECK (((player_rakeback_rate >= (0)::numeric) AND (player_rakeback_rate <= 0.50)))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_promo_wallet_balance_nonneg","type":"c","definition":"CHECK ((promo_wallet_balance >= (0)::numeric))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_role_check","type":"c","definition":"CHECK ((role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_status_check","type":"c","definition":"CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"check_credit","type":"c","definition":"CHECK (((credit_used <= credit_limit) OR (is_prepaid = true)))","validated":true,"deferrable":false,"deferred":false},{"name":"chk_player_wallet_balance_is_two_decimal_places","type":"c","definition":"CHECK (((player_wallet_balance IS NULL) OR (player_wallet_balance = round(player_wallet_balance, 2))))","validated":true,"deferrable":false,"deferred":false},{"name":"fk_agents_parent","type":"f","definition":"FOREIGN KEY (parent_agent_id) REFERENCES agents(id)","validated":true,"deferrable":false,"deferred":false},{"name":"fk_agents_user_id_profiles","type":"f","definition":"FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"agents_club_id_user_id_key","ready":true,"valid":true,"unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX agents_club_id_user_id_key ON public.agents USING btree (club_id, user_id)","nulls_not_distinct":false},{"live":true,"name":"agents_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id)","nulls_not_distinct":false}],"policies":[{"name":"agents_cashier_scoped_read","check":null,"roles":["authenticated"],"using":"((user_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'all'::text) OR ((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'downline'::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id)))","command":"r","permissive":true},{"name":"agents_svc","check":null,"roles":["service_role"],"using":"true","command":"*","permissive":true},{"name":"union_overseer_read","check":null,"roles":["authenticated"],"using":"(( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid)))","command":"r","permissive":true}],"triggers":[{"name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, user_id, parent_agent_id, role, status, commission_rate, player_rakeback_rate, is_prepaid ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_capture()"},{"name":"guard_agent_wallet_direct_update","enabled":"O","definition":"CREATE TRIGGER guard_agent_wallet_direct_update BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION guard_agent_wallet_direct_update()","deferrable":false,"deferred":false,"handler":"guard_agent_wallet_direct_update()"},{"name":"poker_arena_no_hierarchy","enabled":"O","definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()","deferrable":false,"deferred":false,"handler":"fn_poker_reject_diamond_hierarchy()"},{"name":"trg_agents_commission_bounds","enabled":"O","definition":"CREATE TRIGGER trg_agents_commission_bounds BEFORE INSERT OR UPDATE OF commission_rate ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_enforce_agent_commission_bounds()","deferrable":false,"deferred":false,"handler":"fn_enforce_agent_commission_bounds()"},{"name":"trg_agents_human_user_club_only","enabled":"O","definition":"CREATE TRIGGER trg_agents_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()","deferrable":false,"deferred":false,"handler":"fn_ca_reject_automated_user_club_row()"},{"name":"trg_agents_staff_earn_no_rakeback","enabled":"O","definition":"CREATE TRIGGER trg_agents_staff_earn_no_rakeback BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate ON public.agents FOR EACH ROW WHEN (((COALESCE(new.commission_rate, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.player_rakeback_rate, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_agents_staff_earn_no_rakeback()","deferrable":false,"deferred":false,"handler":"fn_agents_staff_earn_no_rakeback()"},{"name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","deferrable":false,"deferred":false,"handler":"fn_ca_autoledger()"},{"name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","deferrable":false,"deferred":false,"handler":"fn_ca_autoledger_delete()"},{"name":"trg_ca_autoledger_insert","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.agents FOR EACH ROW WHEN (((COALESCE(new.agent_wallet_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.promo_wallet_balance, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","deferrable":false,"deferred":false,"handler":"fn_ca_autoledger()"},{"name":"trg_deep_stack_agents_are_protected","enabled":"O","definition":"CREATE TRIGGER trg_deep_stack_agents_are_protected BEFORE DELETE ON public.agents FOR EACH ROW WHEN ((old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()","deferrable":false,"deferred":false,"handler":"fn_deep_stack_society_cannot_be_deleted_by_accident()"},{"name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","deferrable":false,"deferred":false,"handler":"fn_guard_retired_club_mutation()"},{"name":"trg_sync_agent_wallets","enabled":"O","definition":"CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION sync_agent_wallet_columns()","deferrable":false,"deferred":false,"handler":"sync_agent_wallet_columns()"}]},{"name":"ca_chip_store_coverage","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"store","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"treatment","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"counted_by","type":"text","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"notes","type":"text","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"added_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null}],"constraints":[{"name":"ca_chip_store_coverage_pkey","type":"p","definition":"PRIMARY KEY (store)","validated":true,"deferrable":false,"deferred":false},{"name":"ca_chip_store_coverage_treatment_check","type":"c","definition":"CHECK ((treatment = ANY (ARRAY['counted'::text, 'noncirculating'::text, 'uncounted'::text])))","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"ca_chip_store_coverage_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX ca_chip_store_coverage_pkey ON public.ca_chip_store_coverage USING btree (store)","nulls_not_distinct":false}],"policies":[],"triggers":[]}]$capture$::jsonb) LOOP actual:=pg_temp.positive_fee_relation(expected->>'name'); IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'positive-fee relation preimage differs: %',expected->>'name' USING ERRCODE='55000'; END IF; END LOOP;
SELECT COALESCE(jsonb_agg(jsonb_build_object('relation',r.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true)) ORDER BY r.relname,t.tgname),'[]'::jsonb) INTO actual FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace WHERE ns.nspname='public' AND NOT t.tgisinternal AND (r.relname IN ('accounting_agreement_history','accounting_cash_accrual_batches','accounting_cash_accrual_cutover','accounting_cash_rake_sources','accounting_tournament_fee_cutover','agent_commissions','agents','ca_mtt_admission_contract','chip_ledger','club_members','rake_records','tournaments','union_clubs','union_pnl_inventory_events','union_pnl_original_flows','union_pnl_transaction_frames','union_wallet_transactions') OR (r.relname IN ('tables','table_seats','tournaments','tournament_players') AND (t.tgname IN ('union_pnl_original_inventory','union_pnl_original_inventory_no_truncate') OR t.tgfoid=to_regprocedure('public.fn_union_pnl_inventory_observe()'))));
IF actual IS DISTINCT FROM $capture$[{"relation":"accounting_agreement_history","name":"accounting_agreement_history_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_immutable BEFORE DELETE OR UPDATE ON accounting_agreement_history FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()"},{"relation":"accounting_agreement_history","name":"accounting_agreement_history_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_no_truncate BEFORE TRUNCATE ON accounting_agreement_history FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()"},{"relation":"agent_commissions","name":"poker_arena_no_hierarchy","enabled":"O","definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()"},{"relation":"agent_commissions","name":"trg_agent_commission_rollup_del","enabled":"O","definition":"CREATE TRIGGER trg_agent_commission_rollup_del AFTER DELETE ON agent_commissions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_change()"},{"relation":"agent_commissions","name":"trg_agent_commission_rollup_ins","enabled":"O","definition":"CREATE TRIGGER trg_agent_commission_rollup_ins AFTER INSERT ON agent_commissions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_insert()"},{"relation":"agent_commissions","name":"trg_agent_commission_rollup_upd","enabled":"O","definition":"CREATE TRIGGER trg_agent_commission_rollup_upd AFTER UPDATE ON agent_commissions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_change()"},{"relation":"agent_commissions","name":"trg_ca_append_only","enabled":"O","definition":"CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only()"},{"relation":"agents","name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, user_id, parent_agent_id, role, status, commission_rate, player_rakeback_rate, is_prepaid ON agents FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()"},{"relation":"agents","name":"guard_agent_wallet_direct_update","enabled":"O","definition":"CREATE TRIGGER guard_agent_wallet_direct_update BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION guard_agent_wallet_direct_update()"},{"relation":"agents","name":"poker_arena_no_hierarchy","enabled":"O","definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()"},{"relation":"agents","name":"trg_agents_commission_bounds","enabled":"O","definition":"CREATE TRIGGER trg_agents_commission_bounds BEFORE INSERT OR UPDATE OF commission_rate ON agents FOR EACH ROW EXECUTE FUNCTION fn_enforce_agent_commission_bounds()"},{"relation":"agents","name":"trg_agents_human_user_club_only","enabled":"O","definition":"CREATE TRIGGER trg_agents_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()"},{"relation":"agents","name":"trg_agents_staff_earn_no_rakeback","enabled":"O","definition":"CREATE TRIGGER trg_agents_staff_earn_no_rakeback BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate ON agents FOR EACH ROW WHEN (COALESCE(new.commission_rate, 0::numeric) <> 0::numeric OR COALESCE(new.player_rakeback_rate, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_agents_staff_earn_no_rakeback()"},{"relation":"agents","name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')"},{"relation":"agents","name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')"},{"relation":"agents","name":"trg_ca_autoledger_insert","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON agents FOR EACH ROW WHEN (COALESCE(new.agent_wallet_balance, 0::numeric) <> 0::numeric OR COALESCE(new.promo_wallet_balance, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')"},{"relation":"agents","name":"trg_deep_stack_agents_are_protected","enabled":"O","definition":"CREATE TRIGGER trg_deep_stack_agents_are_protected BEFORE DELETE ON agents FOR EACH ROW WHEN (old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()"},{"relation":"agents","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()"},{"relation":"agents","name":"trg_sync_agent_wallets","enabled":"O","definition":"CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION sync_agent_wallet_columns()"},{"relation":"chip_ledger","name":"aa_ca_capture_tournament_charge_entitlement","enabled":"O","definition":"CREATE TRIGGER aa_ca_capture_tournament_charge_entitlement AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.tournament_id IS NOT NULL AND new.from_type = 'player_wallet'::text AND new.to_type = 'prize_liability'::text) EXECUTE FUNCTION fn_ca_capture_tournament_charge_entitlement()"},{"relation":"chip_ledger","name":"ab_ca_chip_store_declared","enabled":"O","definition":"CREATE TRIGGER ab_ca_chip_store_declared BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_store_declared()"},{"relation":"chip_ledger","name":"accounting_transfer_document","enabled":"O","definition":"CREATE TRIGGER accounting_transfer_document AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.status = 'posted'::text AND ((new.from_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text])) OR new.from_type = 'settlement_suspense'::text AND new.category = 'rakeback'::text) AND (new.to_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text]))) EXECUTE FUNCTION fn_accounting_transfer_document_on_insert()"},{"relation":"chip_ledger","name":"cancelled_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER cancelled_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_evidence_is_immutable()"},{"relation":"chip_ledger","name":"satellite_transfer_ledger_is_immutable","enabled":"O","definition":"CREATE TRIGGER satellite_transfer_ledger_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_satellite_transfer_ledger_is_immutable()"},{"relation":"chip_ledger","name":"terminal_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER terminal_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_evidence_is_immutable()"},{"relation":"chip_ledger","name":"trg_ca_append_only","enabled":"O","definition":"CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only()"},{"relation":"chip_ledger","name":"trg_ca_chip_ledger_enrich","enabled":"O","definition":"CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich()"},{"relation":"chip_ledger","name":"trg_chip_ledger_performed_by","enabled":"O","definition":"CREATE TRIGGER trg_chip_ledger_performed_by BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION enforce_chip_ledger_performed_by()"},{"relation":"chip_ledger","name":"zz_ca_attested_day_is_restated_del","enabled":"O","definition":"CREATE TRIGGER zz_ca_attested_day_is_restated_del AFTER DELETE ON chip_ledger REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_attested_day_is_restated()"},{"relation":"chip_ledger","name":"zz_ca_attested_day_is_restated_upd","enabled":"O","definition":"CREATE TRIGGER zz_ca_attested_day_is_restated_upd AFTER UPDATE ON chip_ledger REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_attested_day_is_restated()"},{"relation":"chip_ledger","name":"zz_ca_escrow_overlay_leg","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_overlay_leg AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.to_type = 'prize_liability'::text AND (new.category = 'overlay'::text OR new.category = 'correction'::text AND (new.from_type = ANY (ARRAY['union_bank'::text, 'club_treasury'::text])))) EXECUTE FUNCTION fn_ca_escrow_on_overlay_leg()"},{"relation":"chip_ledger","name":"zz_ca_escrow_reserve_leg","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_reserve_leg AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.category = ANY (ARRAY['spin_entry'::text, 'spin_prize'::text])) EXECUTE FUNCTION fn_ca_escrow_on_reserve_leg()"},{"relation":"chip_ledger","name":"zz_ca_escrow_seat_transfer_leg","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_seat_transfer_leg AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.to_type = 'prize_liability'::text AND new.idempotency_key ~~ 'tourney:%:seat:%:pool_transfer'::text) EXECUTE FUNCTION fn_ca_escrow_on_seat_transfer_leg()"},{"relation":"chip_ledger","name":"zz_ca_issuance_leg_is_registered","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER zz_ca_issuance_leg_is_registered AFTER INSERT ON chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.from_type = ANY (ARRAY['system_mint'::text, 'system_burn'::text, 'issuance_reserve'::text, 'chip_retirement'::text])) OR (new.to_type = ANY (ARRAY['system_mint'::text, 'system_burn'::text, 'issuance_reserve'::text, 'chip_retirement'::text]))) EXECUTE FUNCTION fn_ca_issuance_leg_is_registered()"},{"relation":"chip_ledger","name":"zz_chip_ledger_key_is_claimed_once","enabled":"O","definition":"CREATE TRIGGER zz_chip_ledger_key_is_claimed_once BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION zz_chip_ledger_key_is_claimed_once()"},{"relation":"chip_ledger","name":"zz_freeze_guard","enabled":"O","definition":"CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen()"},{"relation":"club_members","name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF club_id, user_id, agent_id, parent_agent_id, role, status, is_active, commission_rate, rakeback_rate, player_rakeback_pct ON club_members FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()"},{"relation":"club_members","name":"club_members_updated_at","enabled":"O","definition":"CREATE TRIGGER club_members_updated_at BEFORE UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()"},{"relation":"club_members","name":"lock_cashier_hierarchy_insert_delete","enabled":"O","definition":"CREATE TRIGGER lock_cashier_hierarchy_insert_delete BEFORE INSERT OR DELETE ON club_members FOR EACH ROW EXECUTE FUNCTION lock_club_cashier_hierarchy_mutation()"},{"relation":"club_members","name":"lock_cashier_hierarchy_update","enabled":"O","definition":"CREATE TRIGGER lock_cashier_hierarchy_update BEFORE UPDATE OF club_id, agent_id, role, status ON club_members FOR EACH ROW EXECUTE FUNCTION lock_club_cashier_hierarchy_mutation()"},{"relation":"club_members","name":"poker_arena_membership_guard","enabled":"O","definition":"CREATE TRIGGER poker_arena_membership_guard BEFORE INSERT OR UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure()"},{"relation":"club_members","name":"trg_admin_holds_no_player_wallet","enabled":"O","definition":"CREATE TRIGGER trg_admin_holds_no_player_wallet BEFORE INSERT OR UPDATE OF role, chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_admin_holds_no_player_wallet()"},{"relation":"club_members","name":"trg_approval_gate_ins","enabled":"O","definition":"CREATE TRIGGER trg_approval_gate_ins BEFORE INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_approval_gate()"},{"relation":"club_members","name":"trg_approval_gate_upd","enabled":"O","definition":"CREATE TRIGGER trg_approval_gate_upd BEFORE UPDATE OF status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_approval_gate()"},{"relation":"club_members","name":"trg_audit_club_join","enabled":"O","definition":"CREATE TRIGGER trg_audit_club_join AFTER INSERT OR UPDATE OF status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_audit_club_entry_mutation()"},{"relation":"club_members","name":"trg_audit_club_member_delete","enabled":"O","definition":"CREATE TRIGGER trg_audit_club_member_delete AFTER DELETE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_audit_club_member_change()"},{"relation":"club_members","name":"trg_audit_club_member_update","enabled":"O","definition":"CREATE TRIGGER trg_audit_club_member_update AFTER UPDATE OF role, status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_audit_club_member_change()"},{"relation":"club_members","name":"trg_block_browser_balance_inserts","enabled":"O","definition":"CREATE TRIGGER trg_block_browser_balance_inserts BEFORE INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_block_browser_balance_inserts()"},{"relation":"club_members","name":"trg_block_browser_balance_writes","enabled":"O","definition":"CREATE TRIGGER trg_block_browser_balance_writes BEFORE UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_block_browser_balance_writes()"},{"relation":"club_members","name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF promo_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('promo_balance=promo_wallet')"},{"relation":"club_members","name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('chip_balance=player_wallet', 'promo_balance=promo_wallet')"},{"relation":"club_members","name":"trg_ca_autoledger_insert","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON club_members FOR EACH ROW WHEN (COALESCE(new.chip_balance, 0::numeric) <> 0::numeric OR COALESCE(new.promo_balance, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_ca_autoledger('chip_balance=player_wallet', 'promo_balance=promo_wallet')"},{"relation":"club_members","name":"trg_club_member_notes_guard","enabled":"O","definition":"CREATE TRIGGER trg_club_member_notes_guard BEFORE UPDATE OF nickname, notes ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_member_notes_guard()"},{"relation":"club_members","name":"trg_club_members_audit_chip_movement","enabled":"O","definition":"CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW WHEN (old.chip_balance IS DISTINCT FROM new.chip_balance) EXECUTE FUNCTION fn_club_members_ledger_writer()"},{"relation":"club_members","name":"trg_club_members_bot_follows_horse","enabled":"O","definition":"CREATE TRIGGER trg_club_members_bot_follows_horse BEFORE INSERT OR UPDATE OF user_id, is_bot ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_bot_follows_horse()"},{"relation":"club_members","name":"trg_club_members_emit_management_access","enabled":"O","definition":"CREATE TRIGGER trg_club_members_emit_management_access AFTER INSERT OR DELETE OR UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event()"},{"relation":"club_members","name":"trg_club_members_guard_lifecycle_write","enabled":"O","definition":"CREATE TRIGGER trg_club_members_guard_lifecycle_write BEFORE UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_guard_membership_lifecycle_write()"},{"relation":"club_members","name":"trg_club_members_human_user_club_only","enabled":"O","definition":"CREATE TRIGGER trg_club_members_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id, is_bot ON club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()"},{"relation":"club_members","name":"trg_club_members_level_sync","enabled":"O","definition":"CREATE TRIGGER trg_club_members_level_sync AFTER INSERT OR DELETE OR UPDATE OF role, status ON club_members FOR EACH ROW EXECUTE FUNCTION trg_auto_recompute_club_level()"},{"relation":"club_members","name":"trg_club_members_no_agent_cycle_ins","enabled":"O","definition":"CREATE TRIGGER trg_club_members_no_agent_cycle_ins BEFORE INSERT ON club_members FOR EACH ROW WHEN (new.agent_id IS NOT NULL) EXECUTE FUNCTION fn_club_members_no_agent_cycle()"},{"relation":"club_members","name":"trg_club_members_no_agent_cycle_upd","enabled":"O","definition":"CREATE TRIGGER trg_club_members_no_agent_cycle_upd BEFORE UPDATE OF agent_id ON club_members FOR EACH ROW WHEN (new.agent_id IS NOT NULL AND new.agent_id IS DISTINCT FROM old.agent_id) EXECUTE FUNCTION fn_club_members_no_agent_cycle()"},{"relation":"club_members","name":"trg_club_members_require_explicit_join","enabled":"O","definition":"CREATE TRIGGER trg_club_members_require_explicit_join BEFORE INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_require_explicit_club_membership_source()"},{"relation":"club_members","name":"trg_club_members_role_guard","enabled":"O","definition":"CREATE TRIGGER trg_club_members_role_guard BEFORE UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_role_guard()"},{"relation":"club_members","name":"trg_club_members_staff_earn_no_rakeback","enabled":"O","definition":"CREATE TRIGGER trg_club_members_staff_earn_no_rakeback BEFORE INSERT OR UPDATE ON club_members FOR EACH ROW WHEN ((new.role = ANY (ARRAY['co_owner'::text, 'admin'::text])) AND (COALESCE(new.player_rakeback_pct, 0::numeric) <> 0::numeric OR COALESCE(new.rakeback_rate, 0::numeric) <> 0::numeric OR COALESCE(new.commission_rate, 0::numeric) <> 0::numeric)) EXECUTE FUNCTION fn_club_members_staff_earn_no_rakeback()"},{"relation":"club_members","name":"trg_deep_stack_members_are_protected","enabled":"O","definition":"CREATE TRIGGER trg_deep_stack_members_are_protected BEFORE DELETE ON club_members FOR EACH ROW WHEN (old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()"},{"relation":"club_members","name":"trg_four_club_limit_ins","enabled":"O","definition":"CREATE TRIGGER trg_four_club_limit_ins BEFORE INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit()"},{"relation":"club_members","name":"trg_four_club_limit_upd","enabled":"O","definition":"CREATE TRIGGER trg_four_club_limit_upd BEFORE UPDATE OF status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit()"},{"relation":"club_members","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()"},{"relation":"club_members","name":"trg_membership_starts_with_zero_chips","enabled":"O","definition":"CREATE TRIGGER trg_membership_starts_with_zero_chips BEFORE INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_starts_with_zero_chips()"},{"relation":"club_members","name":"trg_recompute_club_level_on_member_change","enabled":"O","definition":"CREATE TRIGGER trg_recompute_club_level_on_member_change AFTER INSERT OR DELETE OR UPDATE OF role, status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_recompute_club_level_on_member_change()"},{"relation":"club_members","name":"trg_sync_agent_player_counts","enabled":"O","definition":"CREATE TRIGGER trg_sync_agent_player_counts AFTER INSERT OR DELETE OR UPDATE OF agent_id, club_id, is_active ON club_members FOR EACH ROW EXECUTE FUNCTION fn_sync_agent_player_counts()"},{"relation":"club_members","name":"trg_sync_club_member_count","enabled":"O","definition":"CREATE TRIGGER trg_sync_club_member_count AFTER INSERT OR DELETE OR UPDATE OF status, club_id, role ON club_members FOR EACH ROW EXECUTE FUNCTION fn_sync_club_member_count()"},{"relation":"club_members","name":"trg_sync_mfa_required_on_club_role","enabled":"O","definition":"CREATE TRIGGER trg_sync_mfa_required_on_club_role AFTER INSERT OR UPDATE OF role, user_id ON club_members FOR EACH ROW EXECUTE FUNCTION fn_sync_mfa_required_on_club_role()"},{"relation":"club_members","name":"zz_freeze_guard","enabled":"O","definition":"CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_balance')"},{"relation":"rake_records","name":"ca_reporting_rake_change_del","enabled":"O","definition":"CREATE TRIGGER ca_reporting_rake_change_del AFTER DELETE ON rake_records REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days()"},{"relation":"rake_records","name":"ca_reporting_rake_change_upd","enabled":"O","definition":"CREATE TRIGGER ca_reporting_rake_change_upd AFTER UPDATE ON rake_records REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days()"},{"relation":"rake_records","name":"ca_reporting_rake_insert","enabled":"O","definition":"CREATE TRIGGER ca_reporting_rake_insert AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION trg_ca_reporting_rake_insert()"},{"relation":"rake_records","name":"cancelled_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER cancelled_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_evidence_is_immutable()"},{"relation":"rake_records","name":"satellite_target_rake_is_immutable","enabled":"O","definition":"CREATE TRIGGER satellite_target_rake_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_satellite_target_rake_is_immutable()"},{"relation":"rake_records","name":"terminal_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER terminal_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_evidence_is_immutable()"},{"relation":"rake_records","name":"tournament_unregistration_rake_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER tournament_unregistration_rake_evidence_is_immutable BEFORE DELETE OR UPDATE ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_ca_unregistration_rake_evidence_is_immutable()"},{"relation":"rake_records","name":"trg_award_vip_points_from_rake","enabled":"O","definition":"CREATE TRIGGER trg_award_vip_points_from_rake AFTER INSERT ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_award_vip_points_from_rake()"},{"relation":"rake_records","name":"trg_ca_club_rake_daily_del","enabled":"O","definition":"CREATE TRIGGER trg_ca_club_rake_daily_del AFTER DELETE ON rake_records REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_change()"},{"relation":"rake_records","name":"trg_ca_club_rake_daily_ins","enabled":"O","definition":"CREATE TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON rake_records REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_insert()"},{"relation":"rake_records","name":"trg_ca_club_rake_daily_upd","enabled":"O","definition":"CREATE TRIGGER trg_ca_club_rake_daily_upd AFTER UPDATE ON rake_records REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_change()"},{"relation":"rake_records","name":"trg_guard_rake_belongs_to_club","enabled":"O","definition":"CREATE TRIGGER trg_guard_rake_belongs_to_club BEFORE INSERT OR UPDATE ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_guard_rake_belongs_to_club()"},{"relation":"rake_records","name":"trg_tournament_fee_names_its_player","enabled":"O","definition":"CREATE TRIGGER trg_tournament_fee_names_its_player BEFORE INSERT ON rake_records FOR EACH ROW WHEN (new.is_tournament IS TRUE AND new.player_contributions IS NULL AND new.rake_amount > 0::numeric) EXECUTE FUNCTION fn_tournament_fee_names_its_player()"},{"relation":"rake_records","name":"zz_ca_escrow_rake_record","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_rake_record AFTER INSERT ON rake_records FOR EACH ROW WHEN (new.is_tournament IS TRUE AND new.tournament_id IS NOT NULL) EXECUTE FUNCTION fn_ca_escrow_on_rake_record()"},{"relation":"tournaments","name":"aa_guard_tournament_completing_claim","enabled":"D","definition":"CREATE TRIGGER aa_guard_tournament_completing_claim BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_completing_claim()"},{"relation":"tournaments","name":"aaa_guard_atomic_satellite_completion","enabled":"D","definition":"CREATE TRIGGER aaa_guard_atomic_satellite_completion BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_guard_atomic_satellite_completion()"},{"relation":"tournaments","name":"cancelled_tournament_parent_is_immutable","enabled":"O","definition":"CREATE TRIGGER cancelled_tournament_parent_is_immutable BEFORE DELETE OR UPDATE OF status, variant, tournament_type, satellite_target_id, satellite_target, satellite_seats, prize_pool, prize_pool_finalized, bounty_pool, bounty_pool_paid, is_bounty, is_pko, is_mystery_bounty, mystery_bounty_stage, mystery_bounty_pool_cents, club_id, ended_at, total_rake, current_players, on_break, break_started_at, break_ends_at ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_parent_is_immutable()"},{"relation":"tournaments","name":"non_satellite_completed_requires_terminal_receipt","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER non_satellite_completed_requires_terminal_receipt AFTER INSERT OR UPDATE OF status ON tournaments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_non_satellite_completed_requires_terminal_receipt()"},{"relation":"tournaments","name":"poker_arena_tournament_guard","enabled":"O","definition":"CREATE TRIGGER poker_arena_tournament_guard BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure()"},{"relation":"tournaments","name":"receipted_tournament_is_immutable","enabled":"O","definition":"CREATE TRIGGER receipted_tournament_is_immutable BEFORE DELETE OR UPDATE OF status, variant, tournament_type, satellite_target_id, satellite_target, satellite_seats, prize_pool, prize_pool_finalized, bounty_pool, bounty_pool_paid, is_bounty, is_pko, is_mystery_bounty, mystery_bounty_stage, mystery_bounty_pool_cents, club_id, ended_at, current_players, on_break, break_started_at, break_ends_at ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_receipted_tournament_is_immutable()"},{"relation":"tournaments","name":"satellite_feeds_only_a_deliverable_target","enabled":"O","definition":"CREATE TRIGGER satellite_feeds_only_a_deliverable_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_satellite_feeds_only_a_deliverable_target()"},{"relation":"tournaments","name":"satellite_target_contract_is_immutable","enabled":"O","definition":"CREATE TRIGGER satellite_target_contract_is_immutable BEFORE UPDATE OF buy_in_amount, buy_in_fee, bounty_amount, rebuy_cost, addon_cost, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type, club_id, entry_contract_locked ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_satellite_target_contract_is_immutable()"},{"relation":"tournaments","name":"spin_tournament_contract_is_draw","enabled":"O","definition":"CREATE TRIGGER spin_tournament_contract_is_draw BEFORE UPDATE OF spin_multiplier, prize_pool, spin_locked_tiers ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_spin_tournament_contract_is_draw()"},{"relation":"tournaments","name":"stamp_tournament_terminal_evidence_markers","enabled":"O","definition":"CREATE TRIGGER stamp_tournament_terminal_evidence_markers AFTER INSERT OR UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_terminal_evidence_markers()"},{"relation":"tournaments","name":"tournament_completed_stats","enabled":"O","definition":"CREATE TRIGGER tournament_completed_stats AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_completed_stats()"},{"relation":"tournaments","name":"tournament_prize_math_contract","enabled":"O","definition":"CREATE TRIGGER tournament_prize_math_contract BEFORE INSERT OR UPDATE OF payout_math_version, payout_unit_cents, club_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_prize_math_contract()"},{"relation":"tournaments","name":"tournament_start_time_locked_during_launch","enabled":"O","definition":"CREATE TRIGGER tournament_start_time_locked_during_launch BEFORE UPDATE OF start_time ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_lock_tournament_start_time_during_launch()"},{"relation":"tournaments","name":"tournaments_cancel_must_refund","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER tournaments_cancel_must_refund AFTER UPDATE ON tournaments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((upper(COALESCE(new.status, ''::text)) = ANY (ARRAY['CANCELLED'::text, 'CANCELED'::text])) AND upper(COALESCE(old.status, ''::text)) IS DISTINCT FROM upper(COALESCE(new.status, ''::text))) EXECUTE FUNCTION trg_tournaments_cancel_must_refund()"},{"relation":"tournaments","name":"tournaments_creation_guard","enabled":"O","definition":"CREATE TRIGGER tournaments_creation_guard BEFORE INSERT ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_creation_guard()"},{"relation":"tournaments","name":"tournaments_guarantee_affordable_ins","enabled":"O","definition":"CREATE TRIGGER tournaments_guarantee_affordable_ins BEFORE INSERT ON tournaments FOR EACH ROW WHEN (COALESCE(new.guaranteed_prize, 0::numeric) > 0::numeric) EXECUTE FUNCTION trg_tournaments_guarantee_affordable()"},{"relation":"tournaments","name":"tournaments_guarantee_affordable_upd","enabled":"O","definition":"CREATE TRIGGER tournaments_guarantee_affordable_upd BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (COALESCE(new.guaranteed_prize, 0::numeric) > 0::numeric AND new.guaranteed_prize IS DISTINCT FROM old.guaranteed_prize) EXECUTE FUNCTION trg_tournaments_guarantee_affordable()"},{"relation":"tournaments","name":"tournaments_mystery_creation_contract","enabled":"O","definition":"CREATE TRIGGER tournaments_mystery_creation_contract BEFORE INSERT OR UPDATE OF is_mystery_bounty, mystery_bounty_profile, mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent, mystery_bounty_top_percent ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_mystery_creation_contract()"},{"relation":"tournaments","name":"tournaments_new_mtt_blind_contract","enabled":"O","definition":"CREATE TRIGGER tournaments_new_mtt_blind_contract BEFORE INSERT OR UPDATE OF blind_structure, starting_chips, tournament_type, variant, max_players ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_new_mtt_blind_contract()"},{"relation":"tournaments","name":"tournaments_rank_before_complete","enabled":"O","definition":"CREATE TRIGGER tournaments_rank_before_complete BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_tournaments_rank_before_complete()"},{"relation":"tournaments","name":"tournaments_short_formats_never_break","enabled":"O","definition":"CREATE TRIGGER tournaments_short_formats_never_break BEFORE INSERT OR UPDATE OF tournament_type, variant, synchronized_breaks ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_short_formats_never_break()"},{"relation":"tournaments","name":"tournaments_spin_completed_guard","enabled":"O","definition":"CREATE TRIGGER tournaments_spin_completed_guard BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_spin_completed_guard()"},{"relation":"tournaments","name":"trg_clear_seats_on_game_end","enabled":"O","definition":"CREATE TRIGGER trg_clear_seats_on_game_end AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_clear_seats_on_game_end()"},{"relation":"tournaments","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()"},{"relation":"tournaments","name":"trg_receipt_mystery_activation","enabled":"O","definition":"CREATE TRIGGER trg_receipt_mystery_activation AFTER UPDATE OF mystery_bounty_stage ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_receipt_mystery_activation()"},{"relation":"tournaments","name":"trg_refuse_completed_with_pending_bounties","enabled":"O","definition":"CREATE TRIGGER trg_refuse_completed_with_pending_bounties BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_refuse_completed_with_pending_bounties()"},{"relation":"tournaments","name":"trg_refuse_mystery_activation_with_pending_heads","enabled":"O","definition":"CREATE TRIGGER trg_refuse_mystery_activation_with_pending_heads BEFORE UPDATE OF mystery_bounty_stage, mystery_bounty_activation_generation ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_refuse_mystery_activation_with_pending_heads()"},{"relation":"tournaments","name":"trg_release_seats_on_tournament_finish","enabled":"O","definition":"CREATE TRIGGER trg_release_seats_on_tournament_finish AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_release_seats_on_tournament_finish()"},{"relation":"tournaments","name":"trg_retire_manager_wakes_after_terminal_status","enabled":"O","definition":"CREATE TRIGGER trg_retire_manager_wakes_after_terminal_status AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_retire_manager_wakes_after_terminal_status()"},{"relation":"tournaments","name":"trg_tournaments_capture_management_contract","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_capture_management_contract AFTER INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_capture_managed_game_contract()"},{"relation":"tournaments","name":"trg_tournaments_emit_game_management_event","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_emit_game_management_event AFTER INSERT OR DELETE OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_emit_managed_game_row_event()"},{"relation":"tournaments","name":"trg_tournaments_managed_delete_guard","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_managed_delete_guard BEFORE DELETE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_delete()"},{"relation":"tournaments","name":"trg_tournaments_managed_lifecycle_guard","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_managed_lifecycle_guard BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_lifecycle()"},{"relation":"tournaments","name":"trg_tournaments_publish_readiness","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_publish_readiness AFTER INSERT OR UPDATE OF guaranteed_prize, club_id, union_id, is_private, variant, tournament_type, satellite_target_id, satellite_target, satellite_seats ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_publish_readiness()"},{"relation":"tournaments","name":"trg_tournaments_refuse_unbuilt_multi_day","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_refuse_unbuilt_multi_day BEFORE INSERT OR UPDATE OF is_multi_day, total_days, day_number, parent_tournament_id, survivors_advance_to, flight_number, flight_end_chips_snapshot ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_refuse_unbuilt_multi_day()"},{"relation":"tournaments","name":"trg_tournaments_registered_contract_lock","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_registered_contract_lock BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_registered_tournament_contract()"},{"relation":"tournaments","name":"trg_tournaments_start_readiness","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_start_readiness BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_start_readiness()"},{"relation":"tournaments","name":"trg_tournaments_union_ownership","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_union_ownership BEFORE INSERT ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_union_ownership()"},{"relation":"tournaments","name":"trg_tournaments_union_ownership_upd","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_union_ownership_upd BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_enforce_tournament_union_ownership_update()"},{"relation":"tournaments","name":"trg_whole_dollar_buyin","enabled":"O","definition":"CREATE TRIGGER trg_whole_dollar_buyin BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_enforce_whole_dollar_buyin()"},{"relation":"tournaments","name":"zz_ca_fund_overlay_on_lock","enabled":"O","definition":"CREATE TRIGGER zz_ca_fund_overlay_on_lock BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_fund_overlay_on_lock()"},{"relation":"tournaments","name":"zz_freerolls_are_free_buy","enabled":"O","definition":"CREATE TRIGGER zz_freerolls_are_free_buy BEFORE INSERT OR UPDATE OF buy_in_amount, buy_in_fee, tournament_type, variant, is_rebuy, add_on_available, rebuy_cost, addon_cost, rebuy_chips, addon_chips, rebuy_levels, addon_levels, max_rebuys ON tournaments FOR EACH ROW WHEN (COALESCE(new.buy_in_amount, 0::numeric) = 0::numeric) EXECUTE FUNCTION fn_freerolls_are_free_buy()"},{"relation":"tournaments","name":"zz_freeze_launch_guard","enabled":"O","definition":"CREATE TRIGGER zz_freeze_launch_guard BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status = 'RUNNING'::text AND old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION fn_refuse_new_entries_while_frozen()"},{"relation":"tournaments","name":"zzz_spin_ladder_is_the_drawn_one","enabled":"O","definition":"CREATE TRIGGER zzz_spin_ladder_is_the_drawn_one BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_spin_ladder_is_the_drawn_one()"},{"relation":"tournaments","name":"zzzy_lock_atomic_place_tournament_status","enabled":"O","definition":"CREATE TRIGGER zzzy_lock_atomic_place_tournament_status BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status IS DISTINCT FROM old.status) EXECUTE FUNCTION trg_lock_atomic_place_tournament_status()"},{"relation":"tournaments","name":"zzzz_capture_satellite_economics_on_start","enabled":"O","definition":"CREATE TRIGGER zzzz_capture_satellite_economics_on_start BEFORE INSERT OR UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_capture_satellite_economics_on_start()"},{"relation":"tournaments","name":"zzzz_freeze_finalized_tournament_prize_pool","enabled":"D","definition":"CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized, payout_structure, spin_multiplier ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_finalized_tournament_prize_pool()"},{"relation":"tournaments","name":"zzzz_freeze_registered_tournament_settlement_contract","enabled":"O","definition":"CREATE TRIGGER zzzz_freeze_registered_tournament_settlement_contract BEFORE UPDATE OF variant, tournament_type, satellite_target_id, bubble_protection, buy_in_amount, guaranteed_prize ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_registered_tournament_settlement_contract()"},{"relation":"tournaments","name":"zzzz_refuse_normal_tournament_completed_insert","enabled":"O","definition":"CREATE TRIGGER zzzz_refuse_normal_tournament_completed_insert BEFORE INSERT ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text) EXECUTE FUNCTION trg_refuse_normal_tournament_completed_insert()"},{"relation":"tournaments","name":"zzzz_tournament_pool_finalization_window_guard","enabled":"D","definition":"CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard BEFORE UPDATE OF prize_pool_finalized ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_pool_finalization_window_guard()"},{"relation":"tournaments","name":"zzzz_tournaments_atomic_place_completion_guard","enabled":"D","definition":"CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_tournament_atomic_place_completion_guard()"},{"relation":"tournaments","name":"zzzzy_lock_atomic_final_table_deal_status","enabled":"O","definition":"CREATE TRIGGER zzzzy_lock_atomic_final_table_deal_status BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status IS DISTINCT FROM old.status) EXECUTE FUNCTION trg_lock_atomic_final_table_deal_status()"},{"relation":"tournaments","name":"zzzzz_tournaments_atomic_final_table_deal_completion_guard","enabled":"D","definition":"CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_atomic_final_table_deal_completion_guard()"},{"relation":"tournaments","name":"zzzzzz_tournaments_financial_certificate","enabled":"D","definition":"CREATE TRIGGER zzzzzz_tournaments_financial_certificate BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION fn_guard_tournament_completed_certificate()"},{"relation":"union_clubs","name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, union_id, club_commission_rate, rate_cash, rate_mtt, rate_sng, rate_spin, rate_satellite ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()"},{"relation":"union_clubs","name":"poker_arena_union_guard","enabled":"O","definition":"CREATE TRIGGER poker_arena_union_guard BEFORE INSERT OR UPDATE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure()"},{"relation":"union_clubs","name":"trg_club_enters_a_union_empty","enabled":"O","definition":"CREATE TRIGGER trg_club_enters_a_union_empty BEFORE INSERT ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_enforce_club_enters_union_empty()"},{"relation":"union_clubs","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()"},{"relation":"union_clubs","name":"trg_recompute_union_level_on_club_change","enabled":"O","definition":"CREATE TRIGGER trg_recompute_union_level_on_club_change AFTER INSERT OR DELETE OR UPDATE OF union_id, club_id ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_recompute_union_level_on_club_change()"},{"relation":"union_clubs","name":"trg_union_clubs_emit_management_access","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_emit_management_access AFTER INSERT OR DELETE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event()"},{"relation":"union_clubs","name":"trg_union_clubs_reassignment_management_access","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_reassignment_management_access AFTER UPDATE OF union_id, club_id ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event()"},{"relation":"union_clubs","name":"trg_union_clubs_sync_mirror","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_sync_mirror AFTER INSERT OR DELETE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_sync_club_union_mirror()"},{"relation":"union_clubs","name":"trg_union_clubs_sync_table_counts","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_sync_table_counts AFTER INSERT OR DELETE OR UPDATE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_sync_union_membership_table_counts()"},{"relation":"union_wallet_transactions","name":"trg_ca_append_only","enabled":"O","definition":"CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only()"},{"relation":"union_wallet_transactions","name":"union_rake_weekly_maintain","enabled":"O","definition":"CREATE TRIGGER union_rake_weekly_maintain AFTER INSERT ON union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION trg_union_rake_weekly()"}]$capture$::jsonb THEN RAISE EXCEPTION 'positive-fee trigger cohort preimage differs' USING ERRCODE='55000'; END IF;
END $preimage$;
CREATE TEMP TABLE positive_fee_untouched_before ON COMMIT DROP AS SELECT pg_temp.positive_fee_untouched() AS value;
ALTER TABLE public.accounting_agreement_history ALTER COLUMN id SET GENERATED ALWAYS;
ALTER TABLE public.accounting_agreement_history ALTER COLUMN club_id DROP NOT NULL;
ALTER TABLE public.accounting_agreement_history ADD COLUMN union_id uuid;
ALTER TABLE public.accounting_agreement_history DROP CONSTRAINT accounting_agreement_history_entity_type_check;
ALTER TABLE public.tournaments ALTER COLUMN max_players DROP NOT NULL;
ALTER TABLE public.tournaments ADD COLUMN format_contract text;
ALTER TABLE public.tournaments ADD COLUMN restart_source_id uuid;
ALTER TABLE public.tournaments DROP CONSTRAINT tournament_prize_math_contract_valid;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournament_prize_math_contract_valid" CHECK (payout_math_version = 1 AND payout_unit_cents = 1 OR payout_math_version = 2 AND (payout_unit_cents = ANY (ARRAY[1, 100])) AND upper(COALESCE(tournament_type, ''::text)) = 'MTT'::text AND (COALESCE(max_players, 0) > 2 OR NOT format_contract IS DISTINCT FROM 'mtt-v2'::text) AND (lower(COALESCE(variant, ''::text)) <> ALL (ARRAY['spin'::text, 'sng'::text, 'satellite'::text])) AND NOT COALESCE(is_premium_spin, false) AND satellite_target_id IS NULL AND satellite_target IS NULL);
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_format_contract_known" CHECK (format_contract IS NULL OR (format_contract = ANY (ARRAY['mtt-v1'::text, 'mtt-v2'::text, 'seat-first-satellite-v1'::text, 'sng-v1'::text, 'spin-v1'::text])));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_recorded_entry_capacity" CHECK (NOT format_contract IS DISTINCT FROM 'mtt-v2'::text AND max_players IS NULL AND COALESCE(min_players, 0) >= 3 OR format_contract IS DISTINCT FROM 'mtt-v2'::text AND COALESCE(max_players > 0, false));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_restart_source_id_fkey" FOREIGN KEY (restart_source_id) REFERENCES tournaments(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE UNIQUE INDEX tournaments_one_restart_per_source ON public.tournaments USING btree (restart_source_id) WHERE (restart_source_id IS NOT NULL);
ALTER TABLE public.agents ADD COLUMN credit_control_revision bigint DEFAULT 0 NOT NULL;
CREATE TABLE public."accounting_cash_accrual_batches" (
 "rake_record_id" uuid NOT NULL,
 "hand_id" uuid NOT NULL,
 "earned_at" timestamp with time zone NOT NULL,
 "source_fingerprint" text NOT NULL,
 "status" text NOT NULL,
 "plan" jsonb,
 "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE TABLE public."accounting_cash_accrual_cutover" (
 "singleton" boolean DEFAULT true NOT NULL,
 "starts_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE TABLE public."accounting_cash_rake_sources" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "rake_record_id" uuid NOT NULL,
 "player_id" uuid NOT NULL,
 "club_id" uuid NOT NULL,
 "union_id" uuid,
 "coordinator_union_id" uuid,
 "earned_at" timestamp with time zone NOT NULL,
 "rake_credit" numeric NOT NULL,
 "contract" jsonb NOT NULL,
 "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE TABLE public."accounting_tournament_fee_cutover" (
 "singleton" boolean DEFAULT true NOT NULL,
 "starts_at" timestamp with time zone NOT NULL
);
CREATE TABLE public."ca_mtt_admission_contract" (
 "singleton" boolean DEFAULT true NOT NULL,
 "abi" text NOT NULL
);
CREATE TABLE public."union_pnl_inventory_events" (
 "event_id" bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.union_pnl_inventory_events_event_id_seq START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1 NO CYCLE) NOT NULL,
 "source_name" text NOT NULL,
 "row_id" uuid NOT NULL,
 "observed_at" timestamp with time zone NOT NULL,
 "transaction_id" xid8 NOT NULL,
 "operation" text NOT NULL,
 "before_row" jsonb,
 "after_row" jsonb
);
CREATE TABLE public."union_pnl_original_flows" (
 "ledger_id" uuid NOT NULL,
 "transaction_id" xid8 NOT NULL,
 "recognized_at" timestamp with time zone NOT NULL,
 "game_scope" jsonb NOT NULL,
 "ledger_snapshot" jsonb NOT NULL
);
CREATE TABLE public."union_pnl_transaction_frames" (
 "transaction_id" xid8 NOT NULL,
 "observed_at" timestamp with time zone NOT NULL,
 "book_start" timestamp with time zone NOT NULL
);
ALTER TABLE public."accounting_agreement_history" ADD CONSTRAINT "accounting_agreement_history_entity_type_check" CHECK ((entity_type = ANY (ARRAY['agents'::text, 'club_members'::text, 'union_clubs'::text, 'unions'::text])));
ALTER TABLE public."accounting_agreement_history" ADD CONSTRAINT "accounting_agreement_history_scope_check" CHECK ((((entity_type = 'unions'::text) AND (union_id IS NOT NULL) AND (club_id IS NULL) AND (subject_user_id IS NULL) AND (entity_key = (union_id)::text)) OR ((entity_type <> 'unions'::text) AND (club_id IS NOT NULL) AND (union_id IS NULL))));
ALTER TABLE public."accounting_cash_accrual_batches" ADD CONSTRAINT "accounting_cash_accrual_batches_check" CHECK (((status = 'accrued'::text) = (plan IS NOT NULL)));
ALTER TABLE public."accounting_cash_accrual_batches" ADD CONSTRAINT "accounting_cash_accrual_batches_hand_id_key" UNIQUE (hand_id);
ALTER TABLE public."accounting_cash_accrual_batches" ADD CONSTRAINT "accounting_cash_accrual_batches_pkey" PRIMARY KEY (rake_record_id);
ALTER TABLE public."accounting_cash_accrual_batches" ADD CONSTRAINT "accounting_cash_accrual_batches_status_check" CHECK ((status = ANY (ARRAY['accrued'::text, 'legacy_unverified'::text])));
ALTER TABLE public."accounting_cash_accrual_cutover" ADD CONSTRAINT "accounting_cash_accrual_cutover_pkey" PRIMARY KEY (singleton);
ALTER TABLE public."accounting_cash_accrual_cutover" ADD CONSTRAINT "accounting_cash_accrual_cutover_singleton_check" CHECK (singleton);
ALTER TABLE public."accounting_cash_rake_sources" ADD CONSTRAINT "accounting_cash_rake_sources_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounting_cash_rake_sources" ADD CONSTRAINT "accounting_cash_rake_sources_rake_credit_check" CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public."accounting_cash_rake_sources" ADD CONSTRAINT "accounting_cash_rake_sources_rake_record_id_player_id_key" UNIQUE (rake_record_id, player_id);
ALTER TABLE public."accounting_tournament_fee_cutover" ADD CONSTRAINT "accounting_tournament_fee_cutover_pkey" PRIMARY KEY (singleton);
ALTER TABLE public."accounting_tournament_fee_cutover" ADD CONSTRAINT "accounting_tournament_fee_cutover_singleton_check" CHECK (singleton);
ALTER TABLE public."agents" ADD CONSTRAINT "agents_credit_control_revision_nonnegative" CHECK ((credit_control_revision >= 0));
ALTER TABLE public."ca_mtt_admission_contract" ADD CONSTRAINT "ca_mtt_admission_contract_abi_check" CHECK ((abi = ANY (ARRAY['legacy-capacity-v1'::text, 'unlimited-mtt-v2'::text])));
ALTER TABLE public."ca_mtt_admission_contract" ADD CONSTRAINT "ca_mtt_admission_contract_pkey" PRIMARY KEY (singleton);
ALTER TABLE public."ca_mtt_admission_contract" ADD CONSTRAINT "ca_mtt_admission_contract_singleton_check" CHECK (singleton);
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_check" CHECK (((before_row IS NOT NULL) OR (after_row IS NOT NULL)));
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_check1" CHECK ((((before_row IS NULL) OR ((jsonb_typeof(before_row) = 'object'::text) AND ((before_row ->> 'id'::text) = (row_id)::text))) IS TRUE));
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_check2" CHECK ((((after_row IS NULL) OR ((jsonb_typeof(after_row) = 'object'::text) AND ((after_row ->> 'id'::text) = (row_id)::text))) IS TRUE));
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_check3" CHECK ((((operation = ANY (ARRAY['baseline'::text, 'INSERT'::text])) AND (before_row IS NULL) AND (after_row IS NOT NULL)) OR ((operation = 'UPDATE'::text) AND (before_row IS NOT NULL) AND (after_row IS NOT NULL)) OR ((operation = 'DELETE'::text) AND (before_row IS NOT NULL) AND (after_row IS NULL))));
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_observed_at_check" CHECK (isfinite(observed_at));
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_operation_check" CHECK ((operation = ANY (ARRAY['baseline'::text, 'INSERT'::text, 'UPDATE'::text, 'DELETE'::text])));
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_pkey" PRIMARY KEY (event_id);
ALTER TABLE public."union_pnl_inventory_events" ADD CONSTRAINT "union_pnl_inventory_events_source_name_check" CHECK ((source_name = ANY (ARRAY['union_clubs'::text, 'tables'::text, 'table_seats'::text, 'tournaments'::text, 'tournament_players'::text])));
ALTER TABLE public."union_pnl_original_flows" ADD CONSTRAINT "union_pnl_original_flows_pkey" PRIMARY KEY (ledger_id);
ALTER TABLE public."union_pnl_transaction_frames" ADD CONSTRAINT "union_pnl_transaction_frames_observed_at_check" CHECK (isfinite(observed_at));
ALTER TABLE public."union_pnl_transaction_frames" ADD CONSTRAINT "union_pnl_transaction_frames_pkey" PRIMARY KEY (transaction_id);
CREATE INDEX accounting_agreement_history_club_time ON public.accounting_agreement_history USING btree (club_id, observed_at, id);
CREATE INDEX accounting_agreement_history_entity_time ON public.accounting_agreement_history USING btree (entity_type, entity_key, observed_at, id);
CREATE INDEX accounting_agreement_history_union_time ON public.accounting_agreement_history USING btree (union_id, observed_at, id) WHERE (entity_type = 'unions'::text);
CREATE INDEX accounting_cash_accrual_batches_earned ON public.accounting_cash_accrual_batches USING btree (earned_at, status);
CREATE INDEX accounting_cash_rake_sources_bank_period ON public.accounting_cash_rake_sources USING btree (union_id, earned_at) WHERE (union_id IS NOT NULL);
CREATE INDEX accounting_cash_rake_sources_coordinator_period ON public.accounting_cash_rake_sources USING btree (coordinator_union_id, earned_at, club_id);
CREATE INDEX accounting_cash_rake_sources_period ON public.accounting_cash_rake_sources USING btree (club_id, earned_at, player_id);
CREATE UNIQUE INDEX agents_agreement_club_and_id ON public.agents USING btree (club_id, id);
CREATE INDEX idx_agents_club ON public.agents USING btree (club_id);
CREATE INDEX idx_agents_parent ON public.agents USING btree (parent_agent_id);
CREATE INDEX idx_agents_user ON public.agents USING btree (user_id);
CREATE INDEX union_pnl_inventory_boundary ON public.union_pnl_inventory_events USING btree (observed_at, event_id);
CREATE INDEX union_pnl_inventory_identity ON public.union_pnl_inventory_events USING btree (source_name, row_id, event_id DESC);
CREATE INDEX union_pnl_inventory_transaction ON public.union_pnl_inventory_events USING btree (transaction_id, source_name);
CREATE INDEX union_pnl_original_flows_expr_recognized_at_idx ON public.union_pnl_original_flows USING btree (((game_scope ->> 'game_union_id'::text)), recognized_at);
ALTER TABLE public."accounting_cash_accrual_batches" ADD CONSTRAINT "accounting_cash_accrual_batches_rake_record_id_fkey" FOREIGN KEY (rake_record_id) REFERENCES rake_records(id);
ALTER TABLE public."accounting_cash_rake_sources" ADD CONSTRAINT "accounting_cash_rake_sources_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id);
ALTER TABLE public."accounting_cash_rake_sources" ADD CONSTRAINT "accounting_cash_rake_sources_player_id_fkey" FOREIGN KEY (player_id) REFERENCES auth.users(id);
ALTER TABLE public."accounting_cash_rake_sources" ADD CONSTRAINT "accounting_cash_rake_sources_rake_record_id_fkey" FOREIGN KEY (rake_record_id) REFERENCES accounting_cash_accrual_batches(rake_record_id);
ALTER TABLE public."agents" ADD CONSTRAINT "agents_parent_in_same_club" FOREIGN KEY (club_id, parent_agent_id) REFERENCES agents(club_id, id);
ALTER TABLE public."union_pnl_original_flows" ADD CONSTRAINT "union_pnl_original_flows_transaction_id_fkey" FOREIGN KEY (transaction_id) REFERENCES union_pnl_transaction_frames(transaction_id);
ALTER TABLE public."accounting_agreement_history" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."accounting_agreement_history"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."accounting_agreement_history" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_agreement_history" TO "postgres";
GRANT SELECT ON TABLE public."accounting_agreement_history" TO "service_role";
ALTER TABLE public."accounting_cash_accrual_batches" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."accounting_cash_accrual_batches"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."accounting_cash_accrual_batches" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_cash_accrual_batches" TO "postgres";
GRANT SELECT ON TABLE public."accounting_cash_accrual_batches" TO "service_role";
ALTER TABLE public."accounting_cash_accrual_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_cash_accrual_cutover" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."accounting_cash_accrual_cutover"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."accounting_cash_accrual_cutover" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_cash_accrual_cutover" TO "postgres";
GRANT SELECT ON TABLE public."accounting_cash_accrual_cutover" TO "service_role";
ALTER TABLE public."accounting_cash_accrual_cutover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_cash_rake_sources" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."accounting_cash_rake_sources"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."accounting_cash_rake_sources" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_cash_rake_sources" TO "postgres";
GRANT SELECT ON TABLE public."accounting_cash_rake_sources" TO "service_role";
ALTER TABLE public."accounting_cash_rake_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_tournament_fee_cutover" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."accounting_tournament_fee_cutover"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."accounting_tournament_fee_cutover" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_tournament_fee_cutover" TO "postgres";
GRANT SELECT ON TABLE public."accounting_tournament_fee_cutover" TO "service_role";
ALTER TABLE public."accounting_tournament_fee_cutover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ca_mtt_admission_contract" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."ca_mtt_admission_contract"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."ca_mtt_admission_contract" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."ca_mtt_admission_contract" TO "postgres";
ALTER TABLE public."ca_mtt_admission_contract" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."union_pnl_inventory_events" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."union_pnl_inventory_events"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."union_pnl_inventory_events" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."union_pnl_inventory_events" TO "postgres";
ALTER TABLE public."union_pnl_inventory_events" ENABLE ROW LEVEL SECURITY;
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('s',c.relowner))) x WHERE c.oid=to_regclass('public.union_pnl_inventory_events_event_id_seq') LOOP EXECUTE 'REVOKE ALL ON SEQUENCE public.union_pnl_inventory_events_event_id_seq FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.union_pnl_inventory_events_event_id_seq TO "postgres";
ALTER TABLE public."union_pnl_original_flows" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."union_pnl_original_flows"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."union_pnl_original_flows" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."union_pnl_original_flows" TO "postgres";
ALTER TABLE public."union_pnl_original_flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."union_pnl_transaction_frames" OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass('public."union_pnl_transaction_frames"') LOOP EXECUTE 'REVOKE ALL ON TABLE public."union_pnl_transaction_frames" FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."union_pnl_transaction_frames" TO "postgres";
ALTER TABLE public."union_pnl_transaction_frames" ENABLE ROW LEVEL SECURITY;

-- Captured pg_get_functiondef MD5 eefa92172db730cfc9c739800d3bc12a
CREATE OR REPLACE FUNCTION public.fn_accounting_agent_terms_at(p_club_id uuid, p_user_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE identities text[]; identity_key text; v jsonb; result jsonb; active_count int:=0;
BEGIN
 -- Service-only EXECUTE ACL also permits private source-owner triggers.
 IF p_club_id IS NULL OR p_user_id IS NULL OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 -- Find candidate identities from history, then resolve each identity at the
 -- earning time. A later move/deletion closes the old identity; filtering the
 -- history by club before selecting its latest event would resurrect that row.
 SELECT array_agg(DISTINCT entity_key) INTO identities FROM public.accounting_agreement_history
  WHERE entity_type='agents' AND club_id=p_club_id AND subject_user_id=p_user_id AND observed_at<=p_at;
 IF identities IS NULL THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 FOREACH identity_key IN ARRAY identities LOOP
  v:=public.fn_accounting_terms_at('agents',identity_key,p_at);
  IF v->'terms'->>'club_id'=p_club_id::text AND v->'terms'->>'user_id'=p_user_id::text
     AND v->'terms'->>'status'='active' THEN
   active_count:=active_count+1; result:=v;
  END IF;
 END LOOP;
 IF active_count=0 THEN RAISE EXCEPTION 'accounting_terms_not_active' USING ERRCODE='55000'; END IF;
 IF active_count>1 THEN RAISE EXCEPTION 'accounting_terms_ambiguous' USING ERRCODE='55000'; END IF;
 RETURN result;
END $function$;
ALTER FUNCTION public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone) TO "service_role";

-- Captured pg_get_functiondef MD5 64cada14be0804682ca22bf136dd01c0
CREATE OR REPLACE FUNCTION public.fn_accounting_cash_commission_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE source public.accounting_cash_rake_sources%ROWTYPE; matches int;
BEGIN
 IF NEW.source_type='cash_rake_accrual' THEN
  SELECT * INTO source FROM public.accounting_cash_rake_sources WHERE id=NEW.source_id;
  IF NOT FOUND OR NEW.club_id IS DISTINCT FROM source.club_id OR NEW.created_at IS DISTINCT FROM source.earned_at THEN
   RAISE EXCEPTION 'cash_commission_source_receipt_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(source.contract->'tiers') t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount
    AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'cash_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('rake','rake_settlement') AND EXISTS(
  SELECT 1 FROM public.rake_records r CROSS JOIN public.accounting_cash_accrual_cutover c
   WHERE c.singleton AND r.hand_id=NEW.source_id AND r.created_at>=c.starts_at
     AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL) THEN
  RAISE EXCEPTION 'cash_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_accounting_cash_commission_source_guard() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_cash_commission_source_guard()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_cash_commission_source_guard() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_cash_commission_source_guard() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_cash_commission_source_guard() TO "service_role";

-- Captured pg_get_functiondef MD5 0d79f2823f390072ddab8abfa8a5263f
CREATE OR REPLACE FUNCTION public.fn_accounting_cash_source_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE old_source_id uuid;new_source_id uuid;hand uuid;
BEGIN
 IF TG_TABLE_NAME='rake_records' THEN
  old_source_id:=OLD.id;new_source_id:=NEW.id;
 ELSE
  IF TG_OP<>'INSERT' THEN old_source_id:=OLD.rake_record_id; END IF;
  IF TG_OP<>'DELETE' THEN new_source_id:=NEW.rake_record_id; END IF;
 END IF;
 -- The commission writer and every source mutation share the same hand key.
 -- A source edit which began before accrual must finish before it is frozen.
 FOR hand IN SELECT DISTINCT r.hand_id FROM public.rake_records r WHERE r.id IN(old_source_id,new_source_id) AND r.hand_id IS NOT NULL ORDER BY r.hand_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||hand::text,0));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id IN(old_source_id,new_source_id)) THEN
  RAISE EXCEPTION 'recorded_cash_earning_source_is_immutable' USING ERRCODE='55000';
 END IF;
 RETURN COALESCE(NEW,OLD);
END $function$;
ALTER FUNCTION public.fn_accounting_cash_source_immutable() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_cash_source_immutable()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_cash_source_immutable() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_cash_source_immutable() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_cash_source_immutable() TO "service_role";

-- Captured pg_get_functiondef MD5 df9bfbca2abf9f596921ad60363abafe
CREATE OR REPLACE FUNCTION public.fn_accounting_earning_contract(p_club_id uuid, p_player_id uuid, p_rake numeric, p_game_union_id uuid, p_terms_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE member jsonb;agent jsonb;terms jsonb;chain jsonb;remaining numeric;rate numeric;amount numeric;
 seen uuid[];agent_id uuid;parent_id uuid;agent_user uuid;direct_user uuid;union_count int;coordinator_union uuid;union_agreement jsonb;union_house boolean;
BEGIN
 -- Private EXECUTE grants admit only trusted source owners, including the
 -- registration trigger running for a human. Public wrappers verify actors.
 IF p_club_id IS NULL OR p_player_id IS NULL OR p_terms_at IS NULL OR NOT isfinite(p_terms_at) OR p_terms_at>clock_timestamp()
  OR p_rake IS NULL OR p_rake<0 OR p_rake<>round(p_rake,2) OR p_rake::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'invalid_accounting_earning_contract' USING ERRCODE='22023'; END IF;
  SELECT count(*),(array_agg((uc.after_terms->>'union_id')::uuid))[1],
   (jsonb_agg(jsonb_build_object('history_id',uc.id,'observed_at',uc.observed_at,'terms',uc.after_terms)))->0
   INTO union_count,coordinator_union,union_agreement FROM (
    SELECT DISTINCT ON(h.entity_key) h.id,h.observed_at,h.after_terms FROM public.accounting_agreement_history h
     WHERE h.entity_type='union_clubs' AND h.club_id=p_club_id AND h.observed_at<=p_terms_at
     ORDER BY h.entity_key,h.observed_at DESC,h.id DESC) uc
    WHERE uc.after_terms IS NOT NULL AND uc.after_terms->>'club_id'=p_club_id::text;
  SELECT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=p_club_id AND c.is_union IS TRUE
   AND p_game_union_id IS NOT NULL AND (c.id=p_game_union_id OR c.union_id=p_game_union_id)) INTO union_house;
  IF union_house THEN coordinator_union:=p_game_union_id;union_agreement:=NULL; END IF;
  IF union_count>1 OR (p_game_union_id IS NOT NULL AND NOT union_house AND (union_count<>1 OR coordinator_union IS DISTINCT FROM p_game_union_id))
  THEN RAISE EXCEPTION 'cash_commission_earning_club_not_observed' USING ERRCODE='23514'; END IF;
  member:=public.fn_accounting_terms_at('club_members',p_club_id::text||':'||p_player_id::text,p_terms_at);
  terms:=member->'terms';
  IF terms IS NULL OR terms='null'::jsonb OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'user_id' IS DISTINCT FROM p_player_id::text
   OR (terms->>'status' IS NULL OR terms->>'status' NOT IN('active','approved')) OR COALESCE((terms->>'is_active')::boolean,true)=false
  THEN RAISE EXCEPTION 'cash_commission_membership_not_active_at_earning' USING ERRCODE='23514'; END IF;
  direct_user:=NULLIF(terms->>'agent_id','')::uuid; agent:=NULL;
  IF direct_user IS NOT NULL THEN
   agent:=public.fn_accounting_agent_terms_at(p_club_id,direct_user,p_terms_at);
  ELSE
   BEGIN agent:=public.fn_accounting_agent_terms_at(p_club_id,p_player_id,p_terms_at);
   EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IN('accounting_terms_not_observed','accounting_terms_not_active') THEN agent:=NULL; ELSE RAISE; END IF; END;
  END IF;
  remaining:=p_rake;chain:='[]';seen:=ARRAY[]::uuid[];
  WHILE agent IS NOT NULL AND agent->'terms' IS NOT NULL AND agent->'terms'<>'null'::jsonb LOOP
   terms:=agent->'terms'; agent_id:=(terms->>'id')::uuid;agent_user:=(terms->>'user_id')::uuid;
   IF agent_id IS NULL OR agent_user IS NULL OR agent_id=ANY(seen) OR cardinality(seen)>=64
    OR terms->>'club_id' IS DISTINCT FROM p_club_id::text OR terms->>'status' IS DISTINCT FROM 'active'
    OR terms->>'role' IS NULL OR terms->>'role' NOT IN('super_agent','agent','sub_agent')
   THEN RAISE EXCEPTION 'cash_commission_hierarchy_invalid_at_earning' USING ERRCODE='23514'; END IF;
   seen:=array_append(seen,agent_id);
   rate:=(terms->>'commission_rate')::numeric;
   IF rate>1 THEN rate:=rate/100; END IF;
   IF rate IS NULL OR rate<0 OR rate>1 OR rate::text IN('NaN','Infinity','-Infinity')
   THEN RAISE EXCEPTION 'cash_commission_rate_invalid_at_earning' USING ERRCODE='23514'; END IF;
   -- Preserve the installed agreement model: each upline rate applies to the
   -- remaining rake after the preceding tier. Round each payable to cents.
   amount:=round(remaining*rate,2);
   chain:=chain||jsonb_build_array(jsonb_build_object('agent_id',agent_id,'user_id',agent_user,
    'role',terms->>'role','depth',cardinality(seen),'rake_basis',p_rake,'remaining_basis',remaining,
    'rate',rate,'amount',amount,'agreement',agent));
   remaining:=remaining-amount;
   parent_id:=NULLIF(terms->>'parent_agent_id','')::uuid;
   IF parent_id IS NULL THEN agent:=NULL; ELSE agent:=public.fn_accounting_terms_at('agents',parent_id::text,p_terms_at); END IF;
  END LOOP;
 RETURN jsonb_build_object('player_id',p_player_id,'club_id',p_club_id,'union_id',p_game_union_id,
  'coordinator_union_id',coordinator_union,'rake_credit',p_rake,'membership',member,'tiers',chain,
  'club_residual',remaining,'union_agreement',union_agreement,'is_union_house',union_house,'terms_at',p_terms_at);
END $function$;
ALTER FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone) TO "postgres";

-- Captured pg_get_functiondef MD5 d262f82e6e75fc3e6830f75972e4b823
CREATE OR REPLACE FUNCTION public.fn_accounting_terms_at(p_entity_type text, p_entity_key text, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE h public.accounting_agreement_history%ROWTYPE;
BEGIN
 -- Service-only EXECUTE ACL also permits private source-owner triggers.
 IF p_entity_type NOT IN('agents','club_members','union_clubs') OR p_entity_type IS NULL
    OR p_entity_key IS NULL OR p_entity_key='' OR p_at IS NULL OR NOT isfinite(p_at) OR p_at>transaction_timestamp()
 THEN RAISE EXCEPTION 'invalid_accounting_terms_request' USING ERRCODE='22023'; END IF;
 SELECT * INTO h FROM public.accounting_agreement_history
  WHERE entity_type=p_entity_type AND entity_key=p_entity_key AND observed_at<=p_at
  ORDER BY observed_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_terms_not_observed' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('history_id',h.id,'observed_at',h.observed_at,'terms',h.after_terms);
END $function$;
ALTER FUNCTION public.fn_accounting_terms_at(text,text,timestamp with time zone) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_terms_at(text,text,timestamp with time zone)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_terms_at(text,text,timestamp with time zone) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_terms_at(text,text,timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_terms_at(text,text,timestamp with time zone) TO "service_role";

-- Captured pg_get_functiondef MD5 7bfe57c82e08e6a939a16c0c27c7a28d
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_commission_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE s record;matches int;BEGIN
 IF NEW.source_type='tournament_fee_accrual' THEN
  SELECT f.*,r.recognized_at,r.disposition,b.status accounting_status INTO s FROM public.accounting_tournament_fee_sources f
   JOIN public.accounting_tournament_recognized_sources r ON r.source_id=f.id
   JOIN public.accounting_tournament_fee_recognitions b ON b.tournament_id=r.tournament_id WHERE f.id=NEW.source_id;
  IF NOT FOUND OR s.disposition IS DISTINCT FROM 'earned' OR s.accounting_status IS DISTINCT FROM 'recognized'
   OR NEW.club_id IS DISTINCT FROM s.club_id OR NEW.created_at IS DISTINCT FROM s.recognized_at THEN
   RAISE EXCEPTION 'tournament_commission_recognized_source_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(s.contract->'tiers')t
   WHERE t->>'user_id'=NEW.user_id::text AND (t->>'amount')::numeric=NEW.amount AND (t->>'rate')::numeric=NEW.commission_rate AND NEW.amount>0;
  IF matches<>1 THEN RAISE EXCEPTION 'tournament_commission_disagrees_with_recorded_entitlement' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_type IN('tournament_fee','tournament_rake_settlement') THEN
  RAISE EXCEPTION 'tournament_commission_requires_canonical_source_writer' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_commission_source_guard() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_tournament_commission_source_guard()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_commission_source_guard() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_commission_source_guard() TO "postgres";

-- Captured pg_get_functiondef MD5 afae8152bd03fdb018b4a0d21f4b8f58
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_commit_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$BEGIN
 PERFORM public.fn_stamp_accounting_tournament_fee(NEW.id);RETURN NULL;
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_commit_capture() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_tournament_fee_commit_capture()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_commit_capture() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_fee_commit_capture() TO "postgres";

-- Captured pg_get_functiondef MD5 709027685f4ff30a06b36e8fb65618cb
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_source_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$BEGIN
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=OLD.id)
  AND (TG_OP='DELETE' OR public.fn_accounting_tournament_fee_fingerprint(OLD) IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(NEW)) THEN
  RAISE EXCEPTION 'captured_tournament_fee_source_is_immutable' USING ERRCODE='55000';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_source_immutable() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_tournament_fee_source_immutable()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_source_immutable() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_fee_source_immutable() TO "postgres";

-- Captured pg_get_functiondef MD5 a5a71f9b0ba989721663a85cbb407ea9
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE event uuid;BEGIN
 IF TG_TABLE_NAME='rake_records' THEN
  event:=CASE WHEN TG_OP='INSERT' THEN NEW.tournament_id ELSE OLD.tournament_id END;
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=event)
   AND (TG_OP<>'UPDATE' OR public.fn_accounting_tournament_fee_fingerprint(OLD) IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(NEW)) THEN
   RAISE EXCEPTION 'recognized_tournament_fee_evidence_is_immutable' USING ERRCODE='55000'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE
   (TG_TABLE_NAME='chip_ledger' AND bank_journal_id=OLD.id) OR (TG_TABLE_NAME='union_wallet_transactions' AND union_wallet_transaction_id=OLD.id)) THEN
   RAISE EXCEPTION 'recognized_tournament_fee_bank_receipt_is_immutable' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_tournament_recognized_evidence_immutable()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_recognized_evidence_immutable() TO "postgres";

-- Captured pg_get_functiondef MD5 164aae2fca35c964331ed8aecd225411
CREATE OR REPLACE FUNCTION public.fn_accounting_transfer_document_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NEW.category='correction' THEN PERFORM public.fn_accounting_correction_prepare(NEW.id);END IF;
 PERFORM public.fn_invoice_accounting_ledger_transfer(NEW.id);
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_accounting_transfer_document_on_insert() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_accounting_transfer_document_on_insert()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_transfer_document_on_insert() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_transfer_document_on_insert() TO "postgres";

-- Captured pg_get_functiondef MD5 5ec011a69c2c9e9bc5c2da28f226ba25
CREATE OR REPLACE FUNCTION public.fn_agent_credit_control_revision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.credit_control_revision IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'credit_control_revision_is_managed' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.credit_control_revision IS DISTINCT FROM OLD.credit_control_revision THEN
  RAISE EXCEPTION 'credit_control_revision_is_managed' USING ERRCODE='23514';END IF;
 IF ROW(NEW.club_id,NEW.user_id,NEW.credit_limit,NEW.credit_used,NEW.is_prepaid,NEW.status,NEW.role,NEW.parent_agent_id)
    IS DISTINCT FROM ROW(OLD.club_id,OLD.user_id,OLD.credit_limit,OLD.credit_used,OLD.is_prepaid,OLD.status,OLD.role,OLD.parent_agent_id) THEN
  IF OLD.credit_control_revision=9223372036854775807 THEN
   RAISE EXCEPTION 'credit_control_revision_exhausted' USING ERRCODE='22003';END IF;
  NEW.credit_control_revision:=OLD.credit_control_revision+1;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_agent_credit_control_revision_v1() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_agent_credit_control_revision_v1()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_agent_credit_control_revision_v1() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_agent_credit_control_revision_v1() TO "postgres";

-- Captured pg_get_functiondef MD5 24028ae5df74069cadea2df80124569a
CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rec record;
BEGIN
  /* Tournament rake (entry fees, rebuys, satellite seats, spin books) is
     attributed ONCE, at settlement: fn_settle_tournament_rake ->
     fn_attribute_tournament_rake, by metadata.user_id or spread across the
     field. Awarding here as well credited every spin twice (2026-09-07). */
  IF COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.player_contributions IS NULL OR jsonb_typeof(NEW.player_contributions) <> 'object'
     OR COALESCE(NEW.rake_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  /* RAKE PAID IS RAKE EARNED (20260831100610): the credit is the player's
     share of NEW.rake_amount under the hand's own method, from the one
     allocator. Never the raw contribution - that is a pot figure, not rake. */
  FOR rec IN
    SELECT a.user_id, a.credit
      FROM public.fn_allocate_rake_credits(
             NEW.rake_amount, NEW.player_contributions,
             COALESCE(NEW.rake_method, 'DEALT_EQUAL')) a
     -- One order for VIP rows everywhere (2026-09-17): the tournament finish
     -- credits its players by player_id; a hand crediting the same players
     -- in seat order met it in the middle on vip_points_carry (three-way
     -- deadlocks at 11:46 and 12:32 UTC).
     ORDER BY a.user_id
  LOOP
    BEGIN
      PERFORM public.fn_award_vip_credit(rec.user_id, rec.credit, 'rake', NEW.id, 'Rake generated');
    EXCEPTION WHEN others THEN
      -- The rake is banked whether or not the points land; the ledger row
      -- is the audit and a warning is the trace.
      RAISE WARNING 'fn_award_vip_points_from_rake: % for user % on %', SQLERRM, rec.user_id, NEW.id;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_award_vip_points_from_rake() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_award_vip_points_from_rake()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_award_vip_points_from_rake() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_award_vip_points_from_rake() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_award_vip_points_from_rake() TO "service_role";

-- Captured pg_get_functiondef MD5 9ec1394628e0c6291963d5f76801a3d1
CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_charge_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_split record;
  v_original_entitlement uuid;
BEGIN
  IF NEW.tournament_id IS NULL
     OR NEW.from_type IS DISTINCT FROM 'player_wallet'
     OR NEW.to_type IS DISTINCT FROM 'prize_liability'
     OR NEW.to_entity_id IS DISTINCT FROM NEW.tournament_id
     OR lower(COALESCE(NEW.category,'')) NOT IN (
          'tournament_buyin','rebuy','addon') THEN
    RETURN NULL;
  END IF;
  IF NEW.from_entity_id IS NULL OR NEW.club_id IS NULL THEN
    RAISE EXCEPTION 'tournament charge ledger omitted player or source club'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
    NEW.tournament_id,NEW.category,NEW.amount);
  INSERT INTO public.tournament_refund_entitlements(
    tournament_id,user_id,entitlement_kind,charge_category,
    refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
    source_ledger_id,registration_id,source_satellite_id,source_award_place,
    escrow_bucket,evidence_kind,created_at)
  VALUES(
    NEW.tournament_id,NEW.from_entity_id,'wallet_charge',lower(NEW.category),
    NEW.club_id,round(NEW.amount,2),v_split.refund_prize,
    v_split.refund_bounty,v_split.refund_fee,NEW.id,NULL,NULL,NULL,
    'wallet_gross','atomic_wallet_charge',transaction_timestamp()) RETURNING id INTO v_original_entitlement;
  PERFORM set_config('app.pnl_tournament_entitlement',v_original_entitlement::text,true);
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_ca_capture_tournament_charge_entitlement() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_capture_tournament_charge_entitlement()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_capture_tournament_charge_entitlement() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_capture_tournament_charge_entitlement() TO "postgres";

-- Captured pg_get_functiondef MD5 81b1abbedb544e2fca0f8edec7d27cae
CREATE OR REPLACE FUNCTION public.fn_ca_capture_tournament_credit_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NEW.tournament_id IS NOT NULL AND NEW.from_type='prize_liability'
    AND NEW.from_entity_id=NEW.tournament_id AND NEW.to_type='player_wallet'
    AND NEW.category IN ('tournament_prize','bounty','refund','tournament_refund') THEN
   PERFORM set_config('app.pnl_tournament_credit_ledger',NEW.id::text,true);
 END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_capture_tournament_credit_ledger() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_capture_tournament_credit_ledger()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_capture_tournament_credit_ledger() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_capture_tournament_credit_ledger() TO "postgres";

-- Captured pg_get_functiondef MD5 93f3e46a957abb7a42d4a2cfaff42fcb
CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_fallback numeric;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. payout table, from the field that actually entered ─────────────
     Only when nobody has registered yet. With registrations present,
     fn_guard_managed_game_lifecycle protects payout_structure and this
     trigger currently runs BEFORE it, so writing here refuses the whole
     start. Re-enabled once the trigger is renamed to sort after the guard.

     NOT FOR A SPIN (2026-09-02). A Spin's ladder comes from the tier the
     wheel drew - 10x is 80/20 - and this rule is "pay the top N% of the
     field", which on three seats rounds to one place and silently replaced
     every high multiplier with winner-take-all. 32 games, 1,592 chips. */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  -- A recovered RUNNING transition is not a new payout contract. The row
  -- is locked by its owning UPDATE; prepared/paid terms cannot be refitted
  -- to today's field. Keep the existing overlay transaction below intact.
  IF public.fn_tournament_payout_terms_committed_v1(OLD.id) THEN
    IF OLD.prize_pool_finalized IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Committed tournament payout terms have no finalized pool'
        USING ERRCODE='55000';
    END IF;
  ELSIF lower(COALESCE(NEW.variant,''))<>'spin'
        AND upper(COALESCE(NEW.tournament_type,''))<>'SPIN' THEN
    IF v_entrants > 0 AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = 'public.tournaments'::regclass
            AND tg.tgname = 'zz_ca_fund_overlay_on_lock')
    THEN
      NULL;  -- stand down: the guard would refuse the start
    ELSIF v_entrants > 0 THEN
      v_places := GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));
      BEGIN
        v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
      EXCEPTION WHEN OTHERS THEN v_existing := NULL; END;

      IF v_existing IS NULL
         OR jsonb_typeof(v_existing) <> 'array'
         OR jsonb_array_length(v_existing) = 0
         OR v_existing = '[{"place":1,"percentage":100}]'::jsonb
         OR jsonb_array_length(v_existing) <> v_places
      THEN
        NEW.payout_structure := public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text;
      END IF;
    END IF;
  END IF;

  /* ── 2. the guarantee overlay, from the main bank ─────────────────────── */
  v_pool_before := round(COALESCE(NEW.prize_pool,0),2);
  v_guarantee   := round(COALESCE(NEW.guaranteed_prize,0),2);

  /* A GUARANTEED SEAT IS A GUARANTEE (2026-09-02). A satellite's advertised
     seats are worth target buy-in + fee each; the engine awards every one of
     them, so the bank funds the shortfall here, like any other guarantee. */
  IF COALESCE(NEW.satellite_seats, 0) > 0
     AND (NEW.variant = 'satellite'
          OR UPPER(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
          OR NEW.satellite_target_id IS NOT NULL) THEN
    v_target := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
    IF v_target IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount,0) + COALESCE(t2.buy_in_fee,0)) * NEW.satellite_seats, 2)
        INTO v_seat_guarantee
        FROM public.tournaments t2 WHERE t2.id = v_target;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_short := GREATEST(0, v_guarantee - v_pool_before);
  IF v_short <= 0 THEN RETURN NEW; END IF;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR UPDATE;
    v_from := 'union_bank';
    v_store := 'union_wallets.chip_balance';
    IF COALESCE(v_bank,0) < v_short THEN
      /* THE MAIN BANK IS SHORT - FALL BACK TO THE CLUB TREASURY.
         Dan 2026-09-04. Refusing here meant advertising a guarantee and then
         not paying it. */
      SELECT chip_treasury INTO v_fallback
        FROM public.clubs WHERE id = NEW.club_id FOR UPDATE;

      IF COALESCE(v_fallback,0) >= v_short THEN
        v_from  := 'club_treasury';
        v_store := 'clubs.chip_treasury';
        PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
        UPDATE public.clubs
           SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
         WHERE id = NEW.club_id;
        PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
        PERFORM public.fn_raise_server_financial_alert(
          'warning', 'fn_ca_fund_overlay_on_lock',
          format('%s took its %s chip overlay from the club treasury: the union bank held only %s. The guarantee WAS met. Refill the union bank.',
                 COALESCE(NEW.name, NEW.id::text), v_short, COALESCE(v_bank,0)),
          jsonb_build_object('kind','overlay_funded_from_fallback','tournament_id',NEW.id,
            'shortfall',v_short,'union_bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        v_union := NULL;  -- the ledger row names the account that actually moved
      ELSE
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_ca_fund_overlay_on_lock',
          format('%s needs %s chips of overlay to meet its %s guarantee. The union bank holds %s and the club treasury holds %s. BOTH are short and the pool was NOT topped up.',
                 COALESCE(NEW.name, NEW.id::text), v_short, v_guarantee,
                 COALESCE(v_bank,0), COALESCE(v_fallback,0)),
          jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
            'shortfall',v_short,'bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        RETURN NEW;
      END IF;
    ELSE
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets
         SET chip_balance = chip_balance - v_short, updated_at = now()
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    END IF;
  ELSE
    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR UPDATE;
    v_from := 'club_treasury';
    v_store := 'clubs.chip_treasury';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the club treasury holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;

  NEW.prize_pool := round(v_pool_before + v_short, 2);

  -- Funding and its escrow/journal leg are one transaction. A failed
  -- journal insert must undo the bank debit and the advertised pool change.
  -- Retry only transient deadlocks; every final error propagates to the
  -- original status update, whose existing lifecycle can retry safely.
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
        v_short, 'overlay', NEW.club_id, NEW.id,
        format('Guarantee overlay from the main bank: %s (%s) was %s short of its %s guarantee - field made %s, bank paid %s',
               COALESCE(NEW.name, 'tournament'), NEW.id::text,
               v_short, v_guarantee,
               v_pool_before, v_short));
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_attempt = 3 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_ca_fund_overlay_on_lock() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_fund_overlay_on_lock()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_overlay_on_lock() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_overlay_on_lock() TO "service_role";

-- Captured pg_get_functiondef MD5 fcc387285004f30705c61e91f315d523
CREATE OR REPLACE FUNCTION public.fn_ca_guard_mtt_admission_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_expected jsonb := $prepared${"functions":[{"signature":"public.fn_settle_tournament_rake(uuid,text)","definition_md5":"0492f5a78bc3c84d54c24fd45549a0be","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_satellite_settlement_receipt(uuid,uuid)","definition_md5":"5288fd960eac2c85d955b8c8150f9f93","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)","definition_md5":"35808158e9c73902be5a55293624d003","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_tournament_late_registration_open(uuid)","definition_md5":"0a189819d8064f393f5de5b12a2c51f4","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_lock_settlement_lane_global()","definition_md5":"7c759bb7a639c3124de2607bdbf12577","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_satellite_settlement_receipts_are_append_only()","definition_md5":"ec03d8976766c413a35a1e29fffd2654","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_rank_survivors(uuid)","definition_md5":"ef53b38023c2cc3dd223c344c6c82dcb","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_managed_game_contract_document(text,jsonb)","definition_md5":"ecbcdaa38256199da944b92ff071ed18","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_managed_game_contract_hash(jsonb)","definition_md5":"1aa2f356d6d3b17135cf5505ec4166f5","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_tournament_management_readiness_for_row(jsonb)","definition_md5":"0b9fecc5c10bdcf459510bbb19a3268a","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_sync_seat_first_player_count(uuid)","definition_md5":"0e4acaf0ff080d4dafd1aa85068cf0b2","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_guard_managed_game_contract_version()","definition_md5":"95b0c11437e95b3862558a4d27434ccf","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)","definition_md5":"92ab8b6d14cecd75bb945bbe2e6bc12b","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)","definition_md5":"2d8c9bd676a8ee02e009dd470fbfd585","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)","definition_md5":"f757226e48412a8c37b0c4770549c2e3","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ensure_late_registration_capacity(uuid,integer)","definition_md5":"cee652fdd8962e43b8e2861bf5c5407e","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.trg_tournaments_rank_before_complete()","definition_md5":"89f80b8b181cf7717fcdee2a94d161ed","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_short_formats_never_break()","definition_md5":"fb3adc8a9ea6346e34fee79945f9046a","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_tournaments_creation_guard()","definition_md5":"f5dcb63005864b24bf422c6628cb169e","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_guard_managed_game_lifecycle()","definition_md5":"e4e6dbe534f8ed1fc7fa03fcad968114","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_capture_managed_game_contract()","definition_md5":"28e259c9fd0c76f39c5ca5b5f0328777","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_emit_managed_game_row_event()","definition_md5":"9706ead97b5e6f495957bfd02a6eb282","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_guard_new_mtt_blind_contract()","definition_md5":"aac67e5c89eaa564744a97a85b5f3fbb","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_fund_overlay_on_lock()","definition_md5":"93f3e46a957abb7a42d4a2cfaff42fcb","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_guard_seat_creation()","definition_md5":"b3e14f411d43b01e84fd614c87f8bf6a","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_seat_change_syncs_seat_first_count()","definition_md5":"3d222458b40d5aec09f8f1e88bf60d53","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_award_vip_points_from_rake()","definition_md5":"24028ae5df74069cadea2df80124569a","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_enforce_tournament_capacity()","definition_md5":"c89a358115c8cd06ff93cfffc2aab84f","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.ca_club_tournaments(uuid,integer,integer)","definition_md5":"4637d9ee6db98fddcd88597ed3b31411","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)","definition_md5":"8a9b893eeb07cbcf518782391e757c2c","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_tournament_seat_cap(uuid)","definition_md5":"557b6fd0f941fd7ee803f408580224db","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)","definition_md5":"3fc3f147808ab3ecc50982f5b6968bff","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_community_search(text,text,integer)","definition_md5":"43733303ec00de630c740bae68257a58","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)","definition_md5":"d1a25ca8de559144fe83b7639634baff","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_create_seat_first_game_atomic(uuid,jsonb)","definition_md5":"0669e34f1376e42d734f7632ea35eb6a","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_create_tournament_governed_legacy(uuid,jsonb)","definition_md5":"bf284ab7932447a7d2e49a1fa7deb9d8","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)","definition_md5":"503a9f90806bf5498ebd0b006dcc0641","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_freeroll_fill_targets(uuid)","definition_md5":"4e4e4aa8fd25b41beac236ad5e74449b","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_list_managed_games(text,uuid,timestamp with time zone,text,uuid,integer,integer,integer,text,uuid,integer)","definition_md5":"aab6ac28551b11fdb6b74d7fcd430580","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_overlay_at_risk(uuid)","definition_md5":"2c4f699472be892cd81073a26828c3e0","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_poker_diamond_create_tournament(jsonb)","definition_md5":"6d82bede82370a9cc15d71b5ce1699f5","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)","definition_md5":"39f95b499619cab7a1eb65ff583aa638","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_release_phantom_seat_claims()","definition_md5":"21628db27f7430a3414cbd2b893a660f","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_seat_first_boards_ready()","definition_md5":"52d79b624a2f58a1800ccc1ddb496ed1","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)","definition_md5":"28f1d2ea26fb3b3f2bc3af3d817393bf","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)","definition_md5":"67a6b85f00a785e22c4d89c6168253d3","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_tournament_atomic_register(uuid,uuid,uuid,numeric)","definition_md5":"c92af85df41906063958185a4250a130","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_tournament_entry_cap_reached(uuid)","definition_md5":"9a34a1460abf1c71f24d88bce182e488","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_tournament_progress_metrics(integer,integer)","definition_md5":"41bd10a2a01fe9100ffa95c0ab090c39","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_update_managed_game(text,uuid,jsonb)","definition_md5":"8616bc6b7c535f0f6eebb97fb0204ad4","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.get_club_home(text)","definition_md5":"a81d488c364fd20d7015a7bae2b774e4","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)","definition_md5":"49383fc3339fb0d380bfad9ab8ecb0c8","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)","definition_md5":"5a2839b0a3e84f650c12428c079d47d7","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)","definition_md5":"8e5cfccfbe100dce021dd17603832e40","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_process_tournament_chip_purchase_money_v1(uuid,uuid,text,numeric,numeric,integer,text)","definition_md5":"158742fd17635f19402a289a378989c7","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)","definition_md5":"0286145366f00c7cad0a996f05630851","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_tournament_rebuy_window(uuid)","definition_md5":"c01c205eef6f1687af9d61ed45d95e8a","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)","definition_md5":"d219ceeed1041eed5cf2c543315eb91b","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)","definition_md5":"9eb078e5860e9bdd8c0afcdbffc02504","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_collect_bounty(uuid,uuid,uuid,jsonb)","definition_md5":"e76385f1c13c9a8e88165d231bda7d6a","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)","definition_md5":"be0bc3420eca1e0c6e579c35b31fed43","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)","definition_md5":"2c34f4cb405753e1180aa59bfb8b1f35","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)","definition_md5":"6f6c1f2c98c19bea585f331536ebbdeb","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_pko_claim_predecessor_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone)","definition_md5":"bae3424d1a86266cf693bc5bce422847","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb)","definition_md5":"eec5afffa1cee9e5106f911c873ce4ce","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_sweep_pending_tournament_bounties(uuid,integer)","definition_md5":"30ca1181317d0f76d7a549ceab37b493","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)","definition_md5":"a6adf208eae8476128f197c16f83d6c5","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_assert_tournament_chip_grant(uuid,uuid,uuid,numeric,text)","definition_md5":"c49fa16f6be47ed9ca2e72b2f2b9da07","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_collect_bounty_obligation(uuid)","definition_md5":"a1e36b2a6907d83c606d08ed5eb888d7","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_accounting_tournament_terminal_fee_receipt(uuid)","definition_md5":"6e446f6d6d19ec8b28b31d124a8c6ac3","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_lock_settlement_lane_for_satellite_finish(uuid)","definition_md5":"0aaaac620ce2f34f2cd9523c4323a12e","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)","definition_md5":"d5339cec8b0e00be748c4c15bc3dba83","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid)","definition_md5":"e56aa8c8280c59e2f0406ea6c504dc4e","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_accounting_tournament_fee_fingerprint(rake_records)","definition_md5":"dd55cceba87b1578472171e1c80ba1fb","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_lock_settlement_lane_for_finish(uuid)","definition_md5":"76e4c6b5291bab20f0cfc65dd060022b","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_accounting_tournament_fee_net_plan(uuid)","definition_md5":"d8231a3f9219ecacb5ae68ee3aebe435","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_get_tournament_satellite_entitlement_depth(uuid)","definition_md5":"37b4bc689c391a5334b54ce3bd2ab8d3","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_materialize_satellite_entitlements_locked(uuid)","definition_md5":"155140246ae8a144ffb0a549f1092fa3","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid)","definition_md5":"195878da781227b47753a28dbc7bc978","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_stamp_accounting_tournament_fee(uuid)","definition_md5":"7e7495ff6800996d72b5ab27008a33a6","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_capture_accounting_tournament_fee(uuid,jsonb)","definition_md5":"e83638c8e5401469c336fe378505fbac","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb)","definition_md5":"b647df60b45c25183638f4cdbaec57fd","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)","definition_md5":"df9bfbca2abf9f596921ad60363abafe","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_accounting_tournament_fee_receipt_immutable()","definition_md5":"bdc4ee4b75e3471cd33a5ed4b250ec0f","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_accounting_cash_source_immutable()","definition_md5":"0d79f2823f390072ddab8abfa8a5263f","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_accounting_tournament_fee_commit_capture()","definition_md5":"afae8152bd03fdb018b4a0d21f4b8f58","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_accounting_tournament_fee_source_immutable()","definition_md5":"709027685f4ff30a06b36e8fb65618cb","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_accounting_tournament_recognized_evidence_immutable()","definition_md5":"a5a71f9b0ba989721663a85cbb407ea9","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)","definition_md5":"d8aa6508707a5da0b3b61cc85b644e2f","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.trg_require_satellite_economics_at_entry_close()","definition_md5":"1c93d532cd49329e3c7e11ee7f6de48b","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_tournament_payout_terms_committed_v1(uuid)","definition_md5":"918c62cbcc182d43a6a27edeb2c1c107","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone)","definition_md5":"0f362f2b4a55f82d627dddccd1da481e","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)","definition_md5":"acbb83c13660c3eda2d9f52fec0c7bd5","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_complete_tournament_launch_atomic(uuid,uuid)","definition_md5":"ab0d03139203d89e16a0cfdae4e1e292","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)","definition_md5":"d300cf2470354e570ebb02fdecff0537","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_lock_mtt_admission_contract()","definition_md5":"10644d522bb50245f76942ecce735cbc","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_legacy_tournament_format(jsonb)","definition_md5":"a83410b4370de8d24e561709dd800ccd","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_tournament_format_identity(jsonb)","definition_md5":"49173db4a4cb01024d37e292d9471795","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_proven_legacy_tournament_format(jsonb)","definition_md5":"ed6d13b779fd7e01786d3a395429ff77","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_guard_tournament_format()","definition_md5":"ff6655365bfdd99ae31dc897568f31e7","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_tournament_recorded_format(uuid)","definition_md5":"a7357dd1366f930eba6cd7f404090bbd","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_tournament_is_unlimited(uuid)","definition_md5":"fd66c28075f1d7c63b9d763632592471","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_tournament_admission_snapshot(uuid[])","definition_md5":"a72bddf2f9fb2e091a16cac223f6d76d","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)","definition_md5":"a0718c687780f7cf3ce36f50c558f456","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)","definition_md5":"faeb38ce1a2e975dc80468abaf74c588","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_tournament_recorded_seat_first(uuid,boolean)","definition_md5":"00e225cc67cf595af35831e981106d93","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_is_new_mtt(jsonb)","definition_md5":"dff4202458ea4b5b940e78050e6de91c","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_new_tournament_is_unlimited(jsonb)","definition_md5":"34b80f98d9d110072ae6951bb4377ee0","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_normalize_new_mtt_capacity()","definition_md5":"06cbd73a8011fac92e0c51b8d752b3da","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_fixed_tournament_waitlist_only()","definition_md5":"e5b36a9c98ae3241005588c47347b6eb","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_satellite_target_accepts_new_feeder(uuid)","definition_md5":"3933ec28773f12a1da9b02952ad99ed4","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_guard_new_satellite_target()","definition_md5":"69247df72bfb68c7148c1a7f9ea4cfd7","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_guard_tournament_restart_source()","definition_md5":"afe57e7d2b37feba95af19b41f9f2df5","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ensure_scheduled_mtt_satellite(jsonb)","definition_md5":"2d6c587397a4c36060e7f3bae474d96d","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_read_mtt_admission_contract()","definition_md5":"7f595febb21665580b47f8b992a5cf45","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_can_manage_tournament_schedule(uuid,uuid,uuid)","definition_md5":"8615be02f04279934a416c5536c37607","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_create_tournament(uuid,jsonb)","definition_md5":"4c5c8783d1f6f534fdaf5cefbb460d62","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_upsert_tournament_schedule(jsonb)","definition_md5":"b8dd7cc8e0996889a936affdc732b664","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_assert_satellite_cohort_standings(uuid)","definition_md5":"432010914abab6babb5f2bad9c1ea447","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_satellite_cohort_receipt(uuid,uuid[])","definition_md5":"3207bb2d0d632688e10889bb7ef8ed08","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_ca_settle_satellite_cohort(uuid,uuid[])","definition_md5":"b99a9d24f3c0c3f931414f7dd25bb317","owner":"postgres","acl":["postgres=X/postgres"]},{"signature":"public.fn_settle_satellite_qualifiers(uuid,uuid[])","definition_md5":"815388758f5ecafc4768e9d0238bb63c","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_resolve_satellite_qualifier_outcome(uuid,uuid[])","definition_md5":"670f4ddc09578988747ce0b7ee73d596","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_get_satellite_qualifier_state(uuid)","definition_md5":"c98348c74d821296e277f94b2987bdec","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_get_my_satellite_qualifier_result(uuid)","definition_md5":"d2e429f8425166112c94d68b2858ae4e","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres"]},{"signature":"public.fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone)","definition_md5":"eefa92172db730cfc9c739800d3bc12a","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_accounting_terms_at(text,text,timestamp with time zone)","definition_md5":"d262f82e6e75fc3e6830f75972e4b823","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_active_maintenance_release_boundary()","definition_md5":"0d9548e27105b7172d83be4f7d10ea47","owner":"postgres","acl":["anon=X/postgres","authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_entry_purchases_frozen()","definition_md5":"0b05e2e7905caf71f14c8327a172cea0","owner":"postgres","acl":["authenticated=X/postgres","postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_money_rpc_balance_columns()","definition_md5":"53e86c9945bde2a5830232f59a365fdd","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_money_rpc_registry_guard()","definition_md5":"03928ac3da782be33306c2e07b0b8977","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]},{"signature":"public.fn_ca_money_rpc_writes_balances(text)","definition_md5":"1b13d12e02c7f7b719fcfae4153dcb1f","owner":"postgres","acl":["postgres=X/postgres","service_role=X/postgres"]}],"triggers":[["managed_game_contract_versions","trg_managed_game_contract_version_immutable","CREATE TRIGGER trg_managed_game_contract_version_immutable BEFORE DELETE OR UPDATE ON public.managed_game_contract_versions FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_contract_version()","O"],["rake_records","accounting_cash_source_immutable","CREATE TRIGGER accounting_cash_source_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_source_immutable()","O"],["rake_records","accounting_tournament_fee_commit_capture","CREATE CONSTRAINT TRIGGER accounting_tournament_fee_commit_capture AFTER INSERT ON public.rake_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.is_tournament IS TRUE) AND (new.rake_amount > (0)::numeric))) EXECUTE FUNCTION fn_accounting_tournament_fee_commit_capture()","O"],["rake_records","accounting_tournament_fee_source_immutable","CREATE TRIGGER accounting_tournament_fee_source_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_source_immutable()","O"],["rake_records","accounting_tournament_recognized_evidence_immutable","CREATE TRIGGER accounting_tournament_recognized_evidence_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable()","O"],["rake_records","trg_award_vip_points_from_rake","CREATE TRIGGER trg_award_vip_points_from_rake AFTER INSERT ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_award_vip_points_from_rake()","O"],["table_seats","trg_ca_guard_seat_creation","CREATE TRIGGER trg_ca_guard_seat_creation BEFORE INSERT OR UPDATE OF left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_seat_creation()","O"],["table_seats","trg_seat_change_syncs_seat_first_count","CREATE TRIGGER trg_seat_change_syncs_seat_first_count AFTER INSERT OR DELETE OR UPDATE OF left_at ON public.table_seats FOR EACH ROW WHEN ((pg_trigger_depth() < 2)) EXECUTE FUNCTION fn_seat_change_syncs_seat_first_count()","O"],["table_seats","zz_freeze_entry_guard","CREATE TRIGGER zz_freeze_entry_guard BEFORE INSERT OR UPDATE OF left_at, user_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_refuse_new_entries_while_frozen()","O"],["tables","trg_tables_capture_management_contract","CREATE TRIGGER trg_tables_capture_management_contract AFTER INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_capture_managed_game_contract()","O"],["tables","trg_tables_emit_game_management_event","CREATE TRIGGER trg_tables_emit_game_management_event AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_emit_managed_game_row_event()","O"],["tables","trg_tables_managed_lifecycle_guard","CREATE TRIGGER trg_tables_managed_lifecycle_guard BEFORE UPDATE OF status, is_deleted ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_lifecycle()","O"],["tournament_launch_receipts","tournament_launch_receipt_is_immutable","CREATE TRIGGER tournament_launch_receipt_is_immutable BEFORE DELETE OR UPDATE ON public.tournament_launch_receipts FOR EACH ROW EXECUTE FUNCTION trg_tournament_launch_receipt_is_immutable()","O"],["tournament_players","trg_enforce_tournament_capacity","CREATE TRIGGER trg_enforce_tournament_capacity BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_enforce_tournament_capacity()","O"],["tournament_players","zz_freeze_entry_guard","CREATE TRIGGER zz_freeze_entry_guard BEFORE INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_refuse_new_entries_while_frozen()","O"],["tournament_refund_entitlements","tournament_refund_entitlements_append_only","CREATE TRIGGER tournament_refund_entitlements_append_only BEFORE DELETE OR UPDATE ON public.tournament_refund_entitlements FOR EACH ROW EXECUTE FUNCTION fn_satellite_settlement_receipts_are_append_only()","O"],["tournament_refund_tranches","tournament_refund_tranches_append_only","CREATE TRIGGER tournament_refund_tranches_append_only BEFORE DELETE OR UPDATE ON public.tournament_refund_tranches FOR EACH ROW EXECUTE FUNCTION fn_satellite_settlement_receipts_are_append_only()","O"],["tournament_satellite_awards","tournament_satellite_awards_append_only","CREATE TRIGGER tournament_satellite_awards_append_only BEFORE DELETE OR UPDATE ON public.tournament_satellite_awards FOR EACH ROW EXECUTE FUNCTION fn_satellite_settlement_receipts_are_append_only()","O"],["tournament_satellite_remainders","tournament_satellite_remainders_append_only","CREATE TRIGGER tournament_satellite_remainders_append_only BEFORE DELETE OR UPDATE ON public.tournament_satellite_remainders FOR EACH ROW EXECUTE FUNCTION fn_satellite_settlement_receipts_are_append_only()","O"],["tournament_satellite_settlements","tournament_satellite_settlements_append_only","CREATE TRIGGER tournament_satellite_settlements_append_only BEFORE DELETE OR UPDATE ON public.tournament_satellite_settlements FOR EACH ROW EXECUTE FUNCTION fn_satellite_settlement_receipts_are_append_only()","O"],["tournament_unregistration_receipts","tournament_unregistration_receipts_append_only","CREATE TRIGGER tournament_unregistration_receipts_append_only BEFORE DELETE OR UPDATE ON public.tournament_unregistration_receipts FOR EACH ROW EXECUTE FUNCTION fn_satellite_settlement_receipts_are_append_only()","O"],["tournaments","a0_tournaments_dual_entry_capacity","CREATE TRIGGER a0_tournaments_dual_entry_capacity BEFORE INSERT OR UPDATE OF max_players, tournament_type, variant, satellite_target_id, satellite_target ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_normalize_new_mtt_capacity()","O"],["tournaments","a1_tournaments_restart_source","CREATE TRIGGER a1_tournaments_restart_source BEFORE INSERT OR DELETE OR UPDATE OF restart_source_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_restart_source()","O"],["tournaments","a2_tournaments_new_satellite_target","CREATE TRIGGER a2_tournaments_new_satellite_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type, club_id, union_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_new_satellite_target()","O"],["tournaments","tournaments_creation_guard","CREATE TRIGGER tournaments_creation_guard BEFORE INSERT ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_creation_guard()","O"],["tournaments","tournaments_new_mtt_blind_contract","CREATE TRIGGER tournaments_new_mtt_blind_contract BEFORE INSERT OR UPDATE OF blind_structure, starting_chips, tournament_type, variant, max_players ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_new_mtt_blind_contract()","O"],["tournaments","tournaments_rank_before_complete","CREATE TRIGGER tournaments_rank_before_complete BEFORE UPDATE ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION trg_tournaments_rank_before_complete()","O"],["tournaments","tournaments_short_formats_never_break","CREATE TRIGGER tournaments_short_formats_never_break BEFORE INSERT OR UPDATE OF tournament_type, variant, synchronized_breaks ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_short_formats_never_break()","O"],["tournaments","trg_tournaments_capture_management_contract","CREATE TRIGGER trg_tournaments_capture_management_contract AFTER INSERT OR UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_capture_managed_game_contract()","O"],["tournaments","trg_tournaments_emit_game_management_event","CREATE TRIGGER trg_tournaments_emit_game_management_event AFTER INSERT OR DELETE OR UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_emit_managed_game_row_event()","O"],["tournaments","trg_tournaments_managed_lifecycle_guard","CREATE TRIGGER trg_tournaments_managed_lifecycle_guard BEFORE UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_lifecycle()","O"],["tournaments","zz_ca_fund_overlay_on_lock","CREATE TRIGGER zz_ca_fund_overlay_on_lock BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_fund_overlay_on_lock()","O"],["tournaments","zz_freeze_launch_guard","CREATE TRIGGER zz_freeze_launch_guard BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = 'RUNNING'::text) AND (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION fn_refuse_new_entries_while_frozen()","O"],["tournaments","zzzzzzz_tournaments_record_format","CREATE TRIGGER zzzzzzz_tournaments_record_format BEFORE INSERT OR UPDATE OF format_contract, tournament_type, variant, max_players, min_players, table_size, satellite_target_id, satellite_target, club_id, union_id ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_format()","O"],["tournament_waitlists","tournament_waitlists_fixed_format_only","CREATE TRIGGER tournament_waitlists_fixed_format_only BEFORE INSERT OR UPDATE OF tournament_id ON public.tournament_waitlists FOR EACH ROW EXECUTE FUNCTION fn_ca_fixed_tournament_waitlist_only()","O"],["accounting_tournament_fee_batches","accounting_tournament_fee_batches_immutable","CREATE TRIGGER accounting_tournament_fee_batches_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_fee_batches","accounting_tournament_fee_batches_no_truncate","CREATE TRIGGER accounting_tournament_fee_batches_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_fee_cutover","accounting_tournament_fee_cutover_immutable","CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_fee_cutover","accounting_tournament_fee_cutover_no_truncate","CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_fee_recognitions","accounting_tournament_fee_recognitions_immutable","CREATE TRIGGER accounting_tournament_fee_recognitions_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_recognitions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_fee_recognitions","accounting_tournament_fee_recognitions_no_truncate","CREATE TRIGGER accounting_tournament_fee_recognitions_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_recognitions FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_fee_sources","accounting_tournament_fee_sources_immutable","CREATE TRIGGER accounting_tournament_fee_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_fee_sources","accounting_tournament_fee_sources_no_truncate","CREATE TRIGGER accounting_tournament_fee_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_recognized_sources","accounting_tournament_recognized_sources_immutable","CREATE TRIGGER accounting_tournament_recognized_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_recognized_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["accounting_tournament_recognized_sources","accounting_tournament_recognized_sources_no_truncate","CREATE TRIGGER accounting_tournament_recognized_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_recognized_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","O"],["tournament_entry_close_receipts","aaa_require_satellite_economics_at_entry_close","CREATE TRIGGER aaa_require_satellite_economics_at_entry_close BEFORE INSERT ON public.tournament_entry_close_receipts FOR EACH ROW EXECUTE FUNCTION trg_require_satellite_economics_at_entry_close()","O"],["ca_mtt_admission_contract","ca_mtt_admission_contract_immutable","CREATE TRIGGER ca_mtt_admission_contract_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.ca_mtt_admission_contract FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","O"],["ca_mtt_admission_contract","ca_mtt_admission_contract_no_truncate","CREATE TRIGGER ca_mtt_admission_contract_no_truncate BEFORE TRUNCATE ON public.ca_mtt_admission_contract FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","O"]],"constraints":[["tournament_launch_receipts","tournament_launch_receipts_tournament_id_fkey","FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT",true],["tournament_satellite_settlements","tournament_satellite_settlements_advertised_seats_check","CHECK ((advertised_seats >= 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_cash_ticket_count_check","CHECK ((cash_ticket_count >= 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check","CHECK ((target_id <> tournament_id))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check1","CHECK ((ticket_cost = (target_buy_in + target_fee)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check10","CHECK ((released_seat_count = cardinality(released_seat_ids)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check11","CHECK ((source_closed_at <= settled_at))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check12","CHECK ((source_escrow_closed_at <= settled_at))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check13","CHECK ((released_seat_ids <@ source_seat_ids))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check14","CHECK (((((remainder = (0)::numeric) AND (bubble_user_id IS NULL) AND (bubble_position IS NULL)) OR ((remainder > (0)::numeric) AND (bubble_user_id IS NOT NULL) AND (bubble_position = (ticket_award_count + 1)) AND (bubble_position <= field_size))) IS TRUE))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check2","CHECK ((ticket_award_count = ((seat_count + cash_ticket_count) + entry_ticket_count)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check3","CHECK ((ticket_award_count <= field_size))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check4","CHECK ((pool = (((ticket_award_count)::numeric * ticket_cost) + remainder)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check5","CHECK ((pool >= ((advertised_seats)::numeric * ticket_cost)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check6","CHECK ((remainder < ticket_cost))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check7","CHECK (((target_was_missing IS FALSE) AND (target_contract_version IS NULL)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check8","CHECK ((source_table_count = cardinality(source_table_ids)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_check9","CHECK ((source_seat_count = cardinality(source_seat_ids)))",true],["tournament_satellite_settlements","tournament_satellite_settlements_entry_ticket_count_check","CHECK ((entry_ticket_count >= 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_field_size_check","CHECK ((field_size > 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_pkey","PRIMARY KEY (tournament_id)",true],["tournament_satellite_settlements","tournament_satellite_settlements_pool_check","CHECK (((pool >= (0)::numeric) AND (pool = round(pool, 2))))",true],["tournament_satellite_settlements","tournament_satellite_settlements_receipt_version_check","CHECK ((((receipt_version = 2) AND (winner_id IS NOT NULL) AND (qualifier_ids IS NULL)) OR ((receipt_version = 3) AND (winner_id IS NULL) AND (qualifier_ids IS NOT NULL) AND (array_ndims(qualifier_ids) = 1) AND (cardinality(qualifier_ids) > 0) AND (array_position(qualifier_ids, NULL::uuid) IS NULL) AND (cardinality(qualifier_ids) <= ticket_award_count))))",true],["tournament_satellite_settlements","tournament_satellite_settlements_released_seat_count_check","CHECK ((released_seat_count >= 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_released_seat_ids_check","CHECK ((array_position(released_seat_ids, NULL::uuid) IS NULL))",true],["tournament_satellite_settlements","tournament_satellite_settlements_remainder_check","CHECK (((remainder >= (0)::numeric) AND (remainder = round(remainder, 2))))",true],["tournament_satellite_settlements","tournament_satellite_settlements_seat_count_check","CHECK ((seat_count >= 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_source_escrow_close_note_check","CHECK ((length(btrim(source_escrow_close_note)) > 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_source_seat_count_check","CHECK ((source_seat_count >= 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_source_seat_ids_check","CHECK ((array_position(source_seat_ids, NULL::uuid) IS NULL))",true],["tournament_satellite_settlements","tournament_satellite_settlements_source_table_count_check","CHECK ((source_table_count > 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_source_table_ids_check","CHECK ((array_position(source_table_ids, NULL::uuid) IS NULL))",true],["tournament_satellite_settlements","tournament_satellite_settlements_target_buy_in_check","CHECK (((target_buy_in >= (0)::numeric) AND (target_buy_in = round(target_buy_in, 2))))",true],["tournament_satellite_settlements","tournament_satellite_settlements_target_fee_check","CHECK (((target_fee >= (0)::numeric) AND (target_fee = round(target_fee, 2))))",true],["tournament_satellite_settlements","tournament_satellite_settlements_target_id_fkey","FOREIGN KEY (target_id) REFERENCES tournaments(id) ON DELETE RESTRICT",true],["tournament_satellite_settlements","tournament_satellite_settlements_ticket_award_count_check","CHECK ((ticket_award_count >= 0))",true],["tournament_satellite_settlements","tournament_satellite_settlements_ticket_cost_check","CHECK (((ticket_cost > (0)::numeric) AND (ticket_cost = round(ticket_cost, 2))))",true],["tournament_satellite_settlements","tournament_satellite_settlements_tournament_id_fkey","FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT",true],["tournaments","tournament_prize_math_contract_valid","CHECK ((((payout_math_version = 1) AND (payout_unit_cents = 1)) OR ((payout_math_version = 2) AND (payout_unit_cents = ANY (ARRAY[1, 100])) AND (upper(COALESCE(tournament_type, ''::text)) = 'MTT'::text) AND ((COALESCE(max_players, 0) > 2) OR (NOT (format_contract IS DISTINCT FROM 'mtt-v2'::text))) AND (lower(COALESCE(variant, ''::text)) <> ALL (ARRAY['spin'::text, 'sng'::text, 'satellite'::text])) AND (NOT COALESCE(is_premium_spin, false)) AND (satellite_target_id IS NULL) AND (satellite_target IS NULL))))",true],["tournaments","tournaments_format_contract_known","CHECK (((format_contract IS NULL) OR (format_contract = ANY (ARRAY['mtt-v1'::text, 'mtt-v2'::text, 'seat-first-satellite-v1'::text, 'sng-v1'::text, 'spin-v1'::text]))))",true],["tournaments","tournaments_heads_up_rake_within_5_pct","CHECK (((max_players IS NULL) OR (max_players > 2) OR (COALESCE(buy_in_fee, (0)::numeric) <= (round(((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.05), 2) + 0.005)))) NOT VALID",false],["tournaments","tournaments_recorded_entry_capacity","CHECK ((((NOT (format_contract IS DISTINCT FROM 'mtt-v2'::text)) AND (max_players IS NULL) AND (COALESCE(min_players, 0) >= 3)) OR ((format_contract IS DISTINCT FROM 'mtt-v2'::text) AND COALESCE((max_players > 0), false))))",true],["tournaments","tournaments_restart_source_id_fkey","FOREIGN KEY (restart_source_id) REFERENCES tournaments(id) ON UPDATE RESTRICT ON DELETE RESTRICT",true],["tournaments","tournaments_status_check","CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text])))",true],["ca_mtt_admission_contract","ca_mtt_admission_contract_abi_check","CHECK ((abi = ANY (ARRAY['legacy-capacity-v1'::text, 'unlimited-mtt-v2'::text])))",true],["ca_mtt_admission_contract","ca_mtt_admission_contract_pkey","PRIMARY KEY (singleton)",true],["ca_mtt_admission_contract","ca_mtt_admission_contract_singleton_check","CHECK (singleton)",true]],"columns":[["tournament_satellite_settlements","winner_id","uuid",false,null,null],["tournament_satellite_settlements","receipt_version","integer",true,null,"2"],["tournament_satellite_settlements","qualifier_ids","uuid[]",false,null,null],["tournaments","max_players","integer",false,null,null],["tournaments","format_contract","text",false,null,null],["tournaments","restart_source_id","uuid",false,null,null],["ca_mtt_admission_contract","singleton","boolean",true,null,"true"],["ca_mtt_admission_contract","abi","text",true,null,null]],"indexes":[["tournament_satellite_settlements_pkey","CREATE UNIQUE INDEX tournament_satellite_settlements_pkey ON public.tournament_satellite_settlements USING btree (tournament_id)",true,true],["ca_mtt_admission_contract_pkey","CREATE UNIQUE INDEX ca_mtt_admission_contract_pkey ON public.ca_mtt_admission_contract USING btree (singleton)",true,true],["tournaments_one_restart_per_source","CREATE UNIQUE INDEX tournaments_one_restart_per_source ON public.tournaments USING btree (restart_source_id) WHERE (restart_source_id IS NOT NULL)",true,true],["idx_tournaments_status_start_time","CREATE INDEX idx_tournaments_status_start_time ON public.tournaments USING btree (status, start_time)",true,true]],"event_triggers":[{"name":"ab_ca_money_rpc_registered","tags":["CREATE FUNCTION"],"event":"ddl_command_end","owner":"postgres","enabled":"O","function":"fn_ca_money_rpc_registry_guard()"}],"cohort_registry":{"proname":"fn_ca_settle_satellite_cohort","status":"approved","notes":"Private recorded-format satellite settlement: service-role wrapper, admission and finish locks, immutable qualifier receipt, atomic target-entry/ticket/cash journals and exact source closeout."}}$prepared$::jsonb;
 v_pin jsonb; v_oid oid; v_actual jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.singleton IS NOT DISTINCT FROM OLD.singleton AND NEW.abi IS NOT DISTINCT FROM OLD.abi THEN
   RETURN NEW;
  END IF;
  IF OLD.singleton IS TRUE AND NEW.singleton IS TRUE
     AND OLD.abi='legacy-capacity-v1' AND NEW.abi='unlimited-mtt-v2' THEN
   -- UPDATE already owns the ABI row. Never wait for maintenance in reverse
   -- order: the owning row-only transaction obtains maintenance first.
   IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION 'MTT_ACTIVATION_MAINTENANCE_ORDER_REFUSED' USING ERRCODE='55000';
   END IF;
   IF current_setting('transaction_isolation')<>'read committed'
      OR current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'MTT_ACTIVATION_REQUIRES_ORIGIN_READ_COMMITTED' USING ERRCODE='55000';
   END IF;
   IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'MTT_ACTIVATION_MAINTENANCE_FROZEN' USING ERRCODE='55000';
   END IF;
   -- No DDL, parent FOR UPDATE, or financial effects after ABI exclusion.
   -- These are the exact final authorities produced by the eight preparation
   -- migrations, installed L03 authoring rules and reviewed L04 cohort closure.
   -- pg_get_functiondef includes volatility/security/configuration.
   FOR v_pin IN SELECT value FROM jsonb_array_elements(v_expected->'functions') LOOP
    v_oid:=to_regprocedure(v_pin->>'signature');
    SELECT jsonb_build_object('definition_md5',md5(pg_get_functiondef(p.oid)),
      'owner',pg_get_userbyid(p.proowner),'acl',
      (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner)))a))
      INTO v_actual FROM pg_proc p WHERE p.oid=v_oid;
    IF v_actual IS DISTINCT FROM v_pin-'signature' THEN
     RAISE EXCEPTION 'MTT_ACTIVATION_AUTHORITY_DRIFT: %',v_pin->>'signature' USING ERRCODE='55000';
    END IF;
   END LOOP;
   FOR v_pin IN SELECT value FROM jsonb_array_elements(v_expected->'triggers') LOOP
    SELECT jsonb_build_array(t.tgrelid::regclass::text,t.tgname,pg_get_triggerdef(t.oid),t.tgenabled)
      INTO v_actual FROM pg_trigger t
      WHERE t.tgrelid=to_regclass('public.'||(v_pin->>0)) AND t.tgname=v_pin->>1;
    IF v_actual IS DISTINCT FROM v_pin THEN
     RAISE EXCEPTION 'MTT_ACTIVATION_TRIGGER_DRIFT: %.%',v_pin->>0,v_pin->>1 USING ERRCODE='55000';
    END IF;
   END LOOP;
   FOR v_pin IN SELECT value FROM jsonb_array_elements(v_expected->'constraints') LOOP
    SELECT jsonb_build_array(x.conrelid::regclass::text,x.conname,pg_get_constraintdef(x.oid),x.convalidated)
      INTO v_actual FROM pg_constraint x
      WHERE x.conrelid=to_regclass('public.'||(v_pin->>0)) AND x.conname=v_pin->>1;
    IF v_actual IS DISTINCT FROM v_pin OR EXISTS(
      SELECT 1 FROM pg_trigger t JOIN pg_constraint x ON x.oid=t.tgconstraint
       WHERE x.conrelid=to_regclass('public.'||(v_pin->>0)) AND x.conname=v_pin->>1
         AND t.tgenabled<>'O') THEN
     RAISE EXCEPTION 'MTT_ACTIVATION_CONSTRAINT_DRIFT: %.%',v_pin->>0,v_pin->>1 USING ERRCODE='55000';
    END IF;
   END LOOP;
   FOR v_pin IN SELECT value FROM jsonb_array_elements(v_expected->'columns') LOOP
    SELECT jsonb_build_array(a.attrelid::regclass::text,a.attname,a.atttypid::regtype::text,
      a.attnotnull,a.attacl,pg_get_expr(d.adbin,d.adrelid)) INTO v_actual
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=to_regclass('public.'||(v_pin->>0)) AND a.attname=v_pin->>1 AND NOT a.attisdropped;
    IF v_actual IS DISTINCT FROM v_pin THEN
     RAISE EXCEPTION 'MTT_ACTIVATION_COLUMN_DRIFT: %.%',v_pin->>0,v_pin->>1 USING ERRCODE='55000';
    END IF;
   END LOOP;
   FOR v_pin IN SELECT value FROM jsonb_array_elements(v_expected->'indexes') LOOP
    SELECT jsonb_build_array(i.indexrelid::regclass::text,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready)
      INTO v_actual FROM pg_index i WHERE i.indexrelid=to_regclass('public.'||(v_pin->>0));
    IF v_actual IS DISTINCT FROM v_pin THEN
     RAISE EXCEPTION 'MTT_ACTIVATION_INDEX_DRIFT: %',v_pin->>0 USING ERRCODE='55000';
    END IF;
   END LOOP;
   FOR v_pin IN SELECT value FROM jsonb_array_elements(v_expected->'event_triggers') LOOP
    SELECT jsonb_build_object('name',e.evtname,'tags',e.evttags,'event',e.evtevent,
      'owner',pg_get_userbyid(e.evtowner),'enabled',e.evtenabled,'function',e.evtfoid::regprocedure::text)
      INTO v_actual FROM pg_event_trigger e WHERE e.evtname=v_pin->>'name';
    IF v_actual IS DISTINCT FROM v_pin THEN
     RAISE EXCEPTION 'MTT_ACTIVATION_EVENT_GUARD_DRIFT: %',v_pin->>'name' USING ERRCODE='55000';
    END IF;
   END LOOP;
   SELECT jsonb_build_object('proname',proname,'status',status,'notes',notes) INTO v_actual
     FROM public.ca_money_rpc_registry WHERE proname='fn_ca_settle_satellite_cohort';
   IF v_actual IS DISTINCT FROM v_expected->'cohort_registry' THEN
    RAISE EXCEPTION 'MTT_ACTIVATION_COHORT_REGISTRY_DRIFT' USING ERRCODE='55000';
   END IF;
   SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',
     (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(coalesce(c.relacl,acldefault('r',c.relowner)))a),
     'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity) INTO v_actual
     FROM pg_class c WHERE c.oid='public.ca_mtt_admission_contract'::regclass;
   IF v_actual IS DISTINCT FROM '{"owner":"postgres","acl":["postgres=arwdDxtm/postgres"],"rls":true,"force_rls":false}'::jsonb
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.ca_mtt_admission_contract'::regclass)
      OR (SELECT count(*) FROM public.ca_mtt_admission_contract)<>1
      OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.ca_mtt_admission_contract'::regclass AND NOT tgisinternal)<>2
      OR (SELECT count(*) FROM pg_attribute WHERE attrelid='public.ca_mtt_admission_contract'::regclass AND attnum>0 AND NOT attisdropped)<>2 THEN
    RAISE EXCEPTION 'MTT_ACTIVATION_PRIVATE_CONTRACT_DRIFT' USING ERRCODE='55000';
   END IF;
   -- Terminal historical rows intentionally may remain unqualified. Existing
   -- active-parent index and exact uppercase status constraint bound this read.
   IF EXISTS(SELECT 1 FROM public.tournaments WHERE status IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING')
     AND (format_contract IS NULL OR format_contract NOT IN ('mtt-v1','seat-first-satellite-v1','sng-v1','spin-v1'))) THEN
    RAISE EXCEPTION 'MTT_ACTIVATION_ACTIVE_FORMAT_UNQUALIFIED' USING ERRCODE='55000';
   END IF;
   RETURN NEW;
  END IF;
 END IF;
 RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_IMMUTABLE' USING ERRCODE='55000';
END $function$;
ALTER FUNCTION public.fn_ca_guard_mtt_admission_contract() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_guard_mtt_admission_contract()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_guard_mtt_admission_contract() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_mtt_admission_contract() TO "postgres";

-- Captured pg_get_functiondef MD5 69247df72bfb68c7148c1a7f9ea4cfd7
CREATE OR REPLACE FUNCTION public.fn_ca_guard_new_satellite_target()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_abi text; v_target uuid:=COALESCE(NEW.satellite_target_id,NEW.satellite_target);
 v_target_row public.tournaments%ROWTYPE; v_supported boolean;
BEGIN
 IF TG_OP='UPDATE' AND
   (NEW.satellite_target_id,NEW.satellite_target,NEW.is_bounty,NEW.is_pko,NEW.is_mystery_bounty,
    NEW.is_premium_spin,NEW.variant,NEW.tournament_type,NEW.club_id,NEW.union_id)
   IS NOT DISTINCT FROM
   (OLD.satellite_target_id,OLD.satellite_target,OLD.is_bounty,OLD.is_pko,OLD.is_mystery_bounty,
    OLD.is_premium_spin,OLD.variant,OLD.tournament_type,OLD.club_id,OLD.union_id) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF v_abi='legacy-capacity-v1' THEN RETURN NEW;END IF;
 IF NEW.satellite_target_id IS NOT NULL AND NEW.satellite_target IS NOT NULL
    AND NEW.satellite_target_id<>NEW.satellite_target THEN
  RAISE EXCEPTION 'SATELLITE_TARGET_POINTER_CONTRADICTION' USING ERRCODE='22023';
 END IF;
 -- Under READ COMMITTED the post-lock query sees a just-committed feeder.
 -- A repeatable snapshot could otherwise permit an incompatible target edit.
 IF current_setting('transaction_isolation')<>'read committed'
    AND (TG_OP='UPDATE' OR v_target IS NOT NULL) THEN
  RAISE EXCEPTION 'SATELLITE_CONTRACT_REQUIRES_READ_COMMITTED' USING ERRCODE='0A000';
 END IF;
 v_supported:=NEW.is_bounty IS FALSE AND NEW.is_pko IS FALSE AND NEW.is_mystery_bounty IS FALSE
   AND NEW.is_premium_spin IS FALSE
   AND lower(btrim(COALESCE(NEW.variant,''))) NOT IN
    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND lower(btrim(COALESCE(NEW.tournament_type,''))) NOT IN
    ('spin','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty')
   AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds');
 IF TG_OP='UPDATE' AND (NOT v_supported OR v_target IS NOT NULL
      OR lower(COALESCE(NEW.variant,''))='satellite' OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE')
   AND EXISTS(SELECT 1 FROM public.tournaments s WHERE s.format_contract='mtt-v2'
     AND (s.satellite_target_id=NEW.id OR s.satellite_target=NEW.id) AND s.id<>NEW.id
     AND upper(COALESCE(s.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')) THEN
  RAISE EXCEPTION 'SATELLITE_LIVE_TARGET_CANNOT_BECOME_UNSUPPORTED' USING ERRCODE='22023';
 END IF;
 IF v_target IS NULL AND (lower(COALESCE(NEW.variant,''))='satellite'
    OR upper(COALESCE(NEW.tournament_type,''))='SATELLITE') THEN
  RAISE EXCEPTION 'SATELLITE_NEW_TARGET_REQUIRED' USING ERRCODE='22023';
 END IF;
 IF v_target IS NOT NULL THEN
  IF NOT v_supported THEN RAISE EXCEPTION 'SATELLITE_NEW_SOURCE_UNSUPPORTED' USING ERRCODE='22023';END IF;
  SELECT * INTO v_target_row FROM public.tournaments WHERE id=v_target FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target)
     OR (NEW.union_id IS NOT NULL AND v_target_row.union_id IS DISTINCT FROM NEW.union_id)
     OR (NEW.union_id IS NULL AND (v_target_row.club_id IS DISTINCT FROM NEW.club_id OR v_target_row.union_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'SATELLITE_NEW_TARGET_UNSUPPORTED' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_new_satellite_target() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_guard_new_satellite_target()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_guard_new_satellite_target() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_new_satellite_target() TO "postgres";

-- Captured pg_get_functiondef MD5 ff6655365bfdd99ae31dc897568f31e7
CREATE OR REPLACE FUNCTION public.fn_ca_guard_tournament_format()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text; v_abi text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.format_contract IS NOT NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IS_DATABASE_ASSIGNED' USING ERRCODE='22023';
    END IF;
    v_abi:=public.fn_ca_lock_mtt_admission_contract();
    IF v_abi='unlimited-mtt-v2' AND public.fn_ca_is_new_mtt(to_jsonb(NEW)) THEN
      IF NEW.max_players IS NOT NULL OR COALESCE(NEW.min_players,0)<3 THEN
        RAISE EXCEPTION 'MTT_V2_CAPACITY_NOT_NORMALIZED' USING ERRCODE='23514';
      END IF;
      v_format:='mtt-v2';
    ELSE
      v_format:=public.fn_ca_legacy_tournament_format(to_jsonb(NEW));
    END IF;
    IF v_format IS NULL THEN
      RAISE EXCEPTION 'TOURNAMENT_LEGACY_FORMAT_AMBIGUOUS' USING ERRCODE='23514';
    END IF;
    NEW.format_contract:=v_format;
    RETURN NEW;
  END IF;
  IF NEW.format_contract IS DISTINCT FROM OLD.format_contract THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF OLD.format_contract='mtt-v2' THEN
    IF NOT public.fn_ca_is_new_mtt(to_jsonb(NEW)) OR NEW.max_players IS NOT NULL
       OR COALESCE(NEW.min_players,0)<3 THEN
      RAISE EXCEPTION 'TOURNAMENT_FORMAT_IDENTITY_CONFLICT' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF public.fn_ca_tournament_format_identity(to_jsonb(NEW))
      IS DISTINCT FROM public.fn_ca_tournament_format_identity(to_jsonb(OLD))
     AND (OLD.format_contract IS NULL
          OR public.fn_ca_legacy_tournament_format(to_jsonb(NEW)) IS DISTINCT FROM OLD.format_contract) THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_IDENTITY_CONFLICT' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_tournament_format() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_guard_tournament_format()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_guard_tournament_format() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_tournament_format() TO "postgres";

-- Captured pg_get_functiondef MD5 afe57e7d2b37feba95af19b41f9f2df5
CREATE OR REPLACE FUNCTION public.fn_ca_guard_tournament_restart_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_source public.tournaments%ROWTYPE; v_target_row public.tournaments%ROWTYPE;
 v_abi text; v_target uuid; v_column text; v_total numeric; v_fee numeric; v_mtt boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.restart_source_id IS NOT NULL THEN RAISE EXCEPTION 'TOURNAMENT_RESTART_HISTORY_IMMUTABLE' USING ERRCODE='22023';END IF;
  RETURN OLD;
 ELSIF TG_OP='UPDATE' THEN
  IF NEW.restart_source_id IS DISTINCT FROM OLD.restart_source_id THEN
   RAISE EXCEPTION 'TOURNAMENT_RESTART_SOURCE_IMMUTABLE' USING ERRCODE='22023';END IF;
  RETURN NEW;
 END IF;
 IF NEW.restart_source_id IS NULL THEN RETURN NEW;END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'service_role required for tournament restart' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF public.fn_entry_purchases_frozen() THEN RAISE EXCEPTION 'TOURNAMENT_RESTART_PLATFORM_FROZEN' USING ERRCODE='55000';END IF;
 SELECT * INTO v_source FROM public.tournaments WHERE id=NEW.restart_source_id FOR UPDATE;
 IF NOT FOUND OR upper(COALESCE(v_source.status,''))<>'COMPLETED' OR v_source.ended_at IS NULL
    OR v_source.schedule_id IS NOT NULL OR COALESCE(v_source.restart_every_minutes,0)<=0
    OR NEW.club_id IS DISTINCT FROM v_source.club_id OR NEW.union_id IS DISTINCT FROM v_source.union_id
    OR NEW.game_type IS DISTINCT FROM v_source.game_type OR NEW.status IS DISTINCT FROM 'REGISTERING'
    OR NEW.current_players IS DISTINCT FROM 0 OR NEW.schedule_id IS NOT NULL OR NEW.start_time IS NULL
    OR NOT isfinite(NEW.start_time) OR NEW.start_time<=clock_timestamp() THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_INVALID_SOURCE' USING ERRCODE='22023';END IF;
 -- NULL terminal parents have no historical exemption. Seat-first/Spin games
 -- are replaced by their board, never cloned by the timed restart path.
 v_mtt:=v_source.format_contract IN ('mtt-v1','mtt-v2');
 IF v_source.format_contract IS NULL OR v_source.format_contract NOT IN ('mtt-v1','mtt-v2','sng-v1')
    OR NEW.format_contract IS NOT NULL
    OR (v_mtt AND NOT public.fn_ca_is_new_mtt(to_jsonb(NEW)))
    OR (v_source.format_contract='sng-v1' AND (COALESCE(v_source.max_players,0)<=2
      OR public.fn_ca_is_new_mtt(to_jsonb(NEW))
      OR v_source.satellite_target_id IS NOT NULL OR v_source.satellite_target IS NOT NULL)) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_FORMAT_MISMATCH' USING ERRCODE='22023';END IF;
 FOREACH v_column IN ARRAY ARRAY['club_id','union_id','is_xmtt','name','game_type','variant','tournament_type','starting_chips','blind_structure','payout_structure','payout_percent','guaranteed_prize','late_reg_levels','late_reg_mins','rebuy_levels','is_rebuy','is_reentry','rebuy_cost','rebuy_chips','add_on_available','addon_cost','addon_chips','addon_levels','is_bounty','bounty_amount','is_pko','is_mystery_bounty','mystery_bounty_min','mystery_bounty_max','mystery_bounty_profile','mystery_bounty_activation','mystery_bounty_activation_value','mystery_bounty_pool_percent','mystery_bounty_regular_pool_percent','mystery_bounty_top_percent','spin_type','satellite_seats','is_private','short_description','is_vip_only','ban_chat','all_in_or_fold','label_as_new','hide_club_name','action_time_seconds','table_size','accelerated_mtt','addon_break_minutes','big_blind_ante','authorized_to_register','early_bird_enabled','early_bird_chips','bubble_protection','final_table_deal_enabled','restart_every_minutes','synchronized_breaks','max_rebuys','max_reentries','is_multi_day','total_days','is_pinned'] LOOP
  IF to_jsonb(NEW)->v_column IS DISTINCT FROM to_jsonb(v_source)->v_column THEN
   RAISE EXCEPTION 'TOURNAMENT_RESTART_BUSINESS_MISMATCH: %',v_column USING ERRCODE='22023';END IF;
 END LOOP;
 IF ((v_abi='legacy-capacity-v1' OR NOT v_mtt) AND (NEW.max_players IS DISTINCT FROM v_source.max_players
      OR NEW.min_players IS DISTINCT FROM v_source.min_players))
    OR (v_abi='unlimited-mtt-v2' AND v_mtt AND (NEW.max_players IS NOT NULL
      OR NEW.min_players IS DISTINCT FROM GREATEST(3,COALESCE(v_source.min_players,3)))) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_CAPACITY_MISMATCH' USING ERRCODE='22023';END IF;
 -- The existing caller only repairs an out-of-policy legacy fee split. Its
 -- player-paid total is fixed, and compliant booked splits pass unchanged.
 v_total:=v_source.buy_in_amount+v_source.buy_in_fee;
 v_fee:=LEAST(v_source.buy_in_fee,trunc(v_total*0.1*100)/100);
 IF v_total IS NULL OR v_total::text IN ('NaN','Infinity','-Infinity')
    OR NEW.buy_in_fee IS DISTINCT FROM v_fee OR NEW.buy_in_amount IS DISTINCT FROM v_total-v_fee THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_PRICE_MISMATCH' USING ERRCODE='22023';END IF;
 IF (v_source.satellite_target_id IS NOT NULL AND v_source.satellite_target IS NOT NULL
      AND v_source.satellite_target_id<>v_source.satellite_target)
    OR (NEW.satellite_target_id IS NOT NULL AND NEW.satellite_target IS NOT NULL
      AND NEW.satellite_target_id<>NEW.satellite_target) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_MISMATCH' USING ERRCODE='22023';END IF;
 v_target:=COALESCE(v_source.satellite_target_id,v_source.satellite_target);
 IF COALESCE(NEW.satellite_target_id,NEW.satellite_target) IS DISTINCT FROM v_target
    OR (v_target IS NULL AND (upper(COALESCE(v_source.tournament_type,''))='SATELLITE'
      OR lower(COALESCE(v_source.variant,''))='satellite')) THEN
  RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_MISMATCH' USING ERRCODE='22023';END IF;
 IF v_target IS NOT NULL THEN
  SELECT * INTO v_target_row FROM public.tournaments WHERE id=v_target FOR UPDATE;
  IF NOT FOUND OR upper(v_target_row.status) NOT IN ('ANNOUNCED','REGISTERING')
    OR v_target_row.start_time IS NULL OR NOT isfinite(v_target_row.start_time)
    OR v_target_row.start_time<=NEW.start_time OR v_target_row.prize_pool_finalized IS TRUE
    OR (NEW.union_id IS NOT NULL AND v_target_row.union_id IS DISTINCT FROM NEW.union_id)
    OR (NEW.union_id IS NULL AND (v_target_row.club_id IS DISTINCT FROM NEW.club_id OR v_target_row.union_id IS NOT NULL))
    OR NOT public.fn_ca_satellite_target_accepts_new_feeder(v_target) THEN
   RAISE EXCEPTION 'TOURNAMENT_RESTART_TARGET_UNAVAILABLE' USING ERRCODE='22023';END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_guard_tournament_restart_source() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_guard_tournament_restart_source()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_guard_tournament_restart_source() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_tournament_restart_source() TO "postgres";

-- Captured pg_get_functiondef MD5 dff4202458ea4b5b940e78050e6de91c
CREATE OR REPLACE FUNCTION public.fn_ca_is_new_mtt(p_row jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN false
    -- A genuine satellite target has product meaning; an empty object does not.
    WHEN (jsonb_typeof(p_row->'satellite_target_id')='string'
          AND NULLIF(btrim(p_row->>'satellite_target_id'),'') IS NOT NULL)
      OR (jsonb_typeof(p_row->'satelliteTargetId')='string'
          AND NULLIF(btrim(p_row->>'satelliteTargetId'),'') IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM (VALUES(p_row->'satellite_target'),(p_row->'satelliteTarget')) s(target)
         WHERE (jsonb_typeof(target)='string'
                AND NULLIF(btrim(target#>>'{}'),'') IS NOT NULL)
            OR (jsonb_typeof(target)='object' AND (
                 (jsonb_typeof(target->'tournamentId')='string'
                  AND NULLIF(btrim(target->>'tournamentId'),'') IS NOT NULL)
                 OR (jsonb_typeof(target->'tournament_id')='string'
                  AND NULLIF(btrim(target->>'tournament_id'),'') IS NOT NULL)))
      ) THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry') THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('sng','spin','hu_sng','heads_up') THEN false
    ELSE lower(btrim(COALESCE(p_row->>'variant',''))) IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry')
  END;
$function$;
ALTER FUNCTION public.fn_ca_is_new_mtt(jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_is_new_mtt(jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_is_new_mtt(jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_new_mtt(jsonb) TO "postgres";

-- Captured pg_get_functiondef MD5 a83410b4370de8d24e561709dd800ccd
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_tournament_format(p_row jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    WHEN upper(p_row->>'tournament_type')='SPIN' AND lower(p_row->>'variant')='spin'
      AND p_row->>'max_players'='3'
      AND NULLIF(p_row->>'satellite_target_id','') IS NULL
      AND NULLIF(p_row->>'satellite_target','') IS NULL THEN 'spin-v1'
    WHEN upper(p_row->>'tournament_type')='SNG' AND lower(p_row->>'variant')='sng'
      AND CASE WHEN coalesce(p_row->>'max_players','')~'^[0-9]+$'
               THEN (p_row->>'max_players')::numeric>=2 ELSE false END
      AND NULLIF(p_row->>'satellite_target_id','') IS NULL
      AND NULLIF(p_row->>'satellite_target','') IS NULL THEN 'sng-v1'
    WHEN upper(p_row->>'tournament_type')='SATELLITE' AND lower(p_row->>'variant')='sng'
      AND p_row->>'max_players'='2' AND p_row->>'min_players'='2'
      AND p_row->>'table_size'='2'
      AND coalesce(NULLIF(p_row->>'satellite_target_id',''),NULLIF(p_row->>'satellite_target','')) IS NOT NULL
      AND (NULLIF(p_row->>'satellite_target_id','') IS NULL
           OR NULLIF(p_row->>'satellite_target','') IS NULL
           OR p_row->>'satellite_target_id'=p_row->>'satellite_target')
      THEN 'seat-first-satellite-v1'
    WHEN upper(p_row->>'tournament_type') IN ('MTT','XMTT')
      AND lower(p_row->>'variant') IN
        ('freezeout','rebuy','reentry','bounty','progressive_bounty','mystery_bounty','satellite','mtt')
      AND CASE WHEN coalesce(p_row->>'max_players','')~'^[0-9]+$'
               THEN (p_row->>'max_players')::numeric>2 ELSE false END THEN 'mtt-v1'
    ELSE NULL END
$function$;
ALTER FUNCTION public.fn_ca_legacy_tournament_format(jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_legacy_tournament_format(jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_legacy_tournament_format(jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_legacy_tournament_format(jsonb) TO "postgres";

-- Captured pg_get_functiondef MD5 10644d522bb50245f76942ecce735cbc
CREATE OR REPLACE FUNCTION public.fn_ca_lock_mtt_admission_contract()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
  SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton FOR SHARE;
  IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
    RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
  END IF;
  RETURN v_abi;
END $function$;
ALTER FUNCTION public.fn_ca_lock_mtt_admission_contract() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_lock_mtt_admission_contract()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_lock_mtt_admission_contract() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_mtt_admission_contract() TO "postgres";

-- Captured pg_get_functiondef MD5 2d8c9bd676a8ee02e009dd470fbfd585
CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid:=p_tournament_id;
  v_table_tournament_id uuid;
  v_status text;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, p_table_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  IF p_user_id IS NOT NULL THEN
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_table_tournament_id
      FROM public.tables tb
     WHERE tb.id=p_table_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','table_not_found');
    END IF;
    IF v_table_tournament_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_tournament_table');
    END IF;
    IF v_tournament_id IS NOT NULL
       AND v_tournament_id IS DISTINCT FROM v_table_tournament_id THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','table_tournament_mismatch');
    END IF;
    v_tournament_id:=v_table_tournament_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_or_table_required');
  END IF;

  -- Launch completion already owns receipt -> tournament. Re-entering these
  -- locks from every seat root makes the historical aa_ launch-proof trigger
  -- a no-op lock acquisition rather than a late inversion.
  PERFORM r.tournament_id
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=v_tournament_id
   ORDER BY r.tournament_id
   FOR UPDATE;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t
   WHERE t.id=v_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_seatable','status',v_status);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_tournament_id,
    'table_id',p_table_id,'status',v_status);
END;
$function$;
ALTER FUNCTION public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid) TO "postgres";

-- Captured pg_get_functiondef MD5 34b80f98d9d110072ae6951bb4377ee0
CREATE OR REPLACE FUNCTION public.fn_ca_new_tournament_is_unlimited(p_config jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 RETURN v_abi='unlimited-mtt-v2' AND public.fn_ca_is_new_mtt(p_config);
END $function$;
ALTER FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_new_tournament_is_unlimited(jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_ca_new_tournament_is_unlimited(jsonb) TO "service_role";

-- Captured pg_get_functiondef MD5 06cbd73a8011fac92e0c51b8d752b3da
CREATE OR REPLACE FUNCTION public.fn_ca_normalize_new_mtt_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_unlimited boolean;
BEGIN
 v_unlimited:=public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW));
 IF TG_OP='INSERT' THEN
  IF v_unlimited THEN
   IF public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'MTT_CREATION_PLATFORM_FROZEN' USING ERRCODE='55000';
   END IF;
   NEW.max_players:=NULL;
   NEW.min_players:=GREATEST(3,COALESCE(NEW.min_players,3));
   IF COALESCE(NEW.satellite_target_id,NEW.satellite_target) IS NOT NULL
      AND (upper(COALESCE(NEW.tournament_type,'')) IN ('SNG','SPIN')
           OR lower(COALESCE(NEW.variant,'')) IN ('sng','spin')) THEN
    RAISE EXCEPTION 'NEW_SATELLITE_REQUIRES_SCHEDULED_MTT_CONFIG' USING ERRCODE='55000';
   END IF;
  END IF;
 ELSIF OLD.format_contract='mtt-v2' THEN
  IF NOT v_unlimited THEN
   RAISE EXCEPTION 'MTT_V2_REQUIRES_ACTIVE_ADMISSION' USING ERRCODE='55000';
  END IF;
  NEW.max_players:=NULL;
 ELSIF v_unlimited AND OLD.format_contract='mtt-v1' THEN
  -- A now-irrelevant cap edit cannot rewrite an accepted version1 contract.
  NEW.max_players:=OLD.max_players;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_normalize_new_mtt_capacity() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_normalize_new_mtt_capacity()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_normalize_new_mtt_capacity() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_normalize_new_mtt_capacity() TO "postgres";

-- Captured pg_get_functiondef MD5 49173db4a4cb01024d37e292d9471795
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_format_identity(p_row jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
    'id',p_row->'id','club_id',p_row->'club_id','union_id',p_row->'union_id',
    'tournament_type',p_row->'tournament_type','variant',p_row->'variant',
    'max_players',p_row->'max_players','min_players',p_row->'min_players',
    'table_size',p_row->'table_size',
    'satellite_target_id',p_row->'satellite_target_id','satellite_target',p_row->'satellite_target')
$function$;
ALTER FUNCTION public.fn_ca_tournament_format_identity(jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_tournament_format_identity(jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_tournament_format_identity(jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_format_identity(jsonb) TO "postgres";

-- Captured pg_get_functiondef MD5 a7357dd1366f930eba6cd7f404090bbd
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text;
BEGIN
  SELECT format_contract INTO v_format FROM public.tournaments WHERE id=p_tournament_id;
  IF NOT FOUND OR v_format IS NULL OR v_format NOT IN
     ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1') THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_NOT_PROVEN' USING ERRCODE='55000';
  END IF;
  RETURN v_format;
END $function$;
ALTER FUNCTION public.fn_ca_tournament_recorded_format(uuid) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_tournament_recorded_format(uuid)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_format(uuid) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_recorded_format(uuid) TO "postgres";

-- Captured pg_get_functiondef MD5 00e225cc67cf595af35831e981106d93
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_recorded_seat_first(p_tournament_id uuid, p_terminal_cleanup boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text; v_cap integer; v_status text;
BEGIN
 SELECT t.format_contract,t.max_players,upper(COALESCE(t.status::text,''))
 INTO v_format,v_cap,v_status FROM public.tournaments t WHERE t.id=p_tournament_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
 END IF;
 IF p_terminal_cleanup IS TRUE AND v_format IS NULL
    AND v_status IN ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN false;
 END IF;
 v_format:=public.fn_ca_tournament_recorded_format(p_tournament_id);
 RETURN v_format IN ('spin-v1','seat-first-satellite-v1')
     OR (v_format='sng-v1' AND v_cap BETWEEN 1 AND 2);
END $function$;
ALTER FUNCTION public.fn_ca_tournament_recorded_seat_first(uuid,boolean) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_tournament_recorded_seat_first(uuid,boolean)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_seat_first(uuid,boolean) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_recorded_seat_first(uuid,boolean) TO "postgres";

-- Captured pg_get_functiondef MD5 557b6fd0f941fd7ee803f408580224db
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_seat_cap(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_variant text;
  v_format text;
  v_cap integer;
BEGIN
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;
  v_variant:=lower(COALESCE(NULLIF(v_t.game_type,''),'nlh'));
  v_format:=public.fn_ca_tournament_recorded_format(p_tournament_id);
  v_cap:=CASE
    WHEN v_format='spin-v1'
      THEN 3
    WHEN v_format='seat-first-satellite-v1' THEN 2
    WHEN v_format='sng-v1'
      THEN LEAST(COALESCE(NULLIF(v_t.max_players,0),6),9)
    ELSE LEAST(COALESCE(NULLIF(v_t.table_size,0),9),10)
  END;
  v_cap:=LEAST(v_cap,CASE v_variant
    WHEN 'plo5' THEN 9
    WHEN 'plo6' THEN 7
    ELSE 10
  END);
  RETURN GREATEST(v_cap,2);
END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_seat_cap(uuid) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_ca_tournament_seat_cap(uuid)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_tournament_seat_cap(uuid) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_seat_cap(uuid) TO "postgres";

-- Captured pg_get_functiondef MD5 e83638c8e5401469c336fe378505fbac
CREATE OR REPLACE FUNCTION public.fn_capture_accounting_tournament_fee(p_rake_record_id uuid, p_manifest jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
 r public.rake_records%ROWTYPE; t record; previous record; cutoff timestamptz;
 manifest jsonb; item jsonb; contributors jsonb:='[]'; contract jsonb;
 e record; l record; tp record; source_type text; expected_kind text;
 player uuid; club uuid; registration uuid; ledger_id uuid; entitlement_id uuid;
 actual_union uuid; charged_at timestamptz; weight numeric; total_weight numeric:=0;
 total_cents bigint; floor_total bigint; remainder_cents bigint; credit numeric;
 allocated numeric:=0; seen_players uuid[]:='{}'; seen_entitlements uuid[]:='{}';
 fingerprint text; result_ids uuid[]:='{}'; new_id uuid; n integer; row_plan record;
BEGIN
 -- Private EXECUTE grants are the boundary: this owner-only helper also runs
 -- inside a legitimate authenticated human's original charge transaction.
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 IF NOT FOUND OR r.is_tournament IS DISTINCT FROM true OR r.tournament_id IS NULL
  OR r.hand_id IS NOT NULL OR r.rake_amount IS NULL OR r.rake_amount<=0
  OR r.rake_amount<>round(r.rake_amount,2) OR r.rake_amount::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_fee:'||r.id::text,0));
 fingerprint:=public.fn_accounting_tournament_fee_fingerprint(r);
 SELECT * INTO previous FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id;
 IF FOUND THEN
  IF previous.source_fingerprint IS DISTINCT FROM fingerprint THEN
   RAISE EXCEPTION 'captured_tournament_fee_source_changed' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(id ORDER BY player_id),count(*),sum(rake_credit)
   INTO result_ids,n,allocated FROM public.accounting_tournament_fee_sources WHERE rake_record_id=r.id;
  IF n=0 OR allocated IS DISTINCT FROM previous.rake_amount THEN
   RAISE EXCEPTION 'captured_tournament_fee_incomplete' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
   'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',true,'payable',false);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF cutoff IS NULL OR r.created_at<cutoff OR r.created_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000';
 END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514';
 END IF;
 actual_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 manifest:=COALESCE(p_manifest,r.metadata->'accounting_fee_source');
 IF (p_manifest IS NULL AND r.metadata->>'accounting_source_version' IS DISTINCT FROM '2')
  OR jsonb_typeof(manifest) IS DISTINCT FROM 'object'
  OR NOT(manifest ? 'union_id')
  OR NULLIF(manifest->>'union_id','')::uuid IS DISTINCT FROM actual_union
  OR manifest->>'game_type' IS DISTINCT FROM lower(t.tournament_type)
  OR jsonb_typeof(manifest->'contributors') IS DISTINCT FROM 'array'
  OR jsonb_array_length(manifest->'contributors')=0
 THEN RAISE EXCEPTION 'tournament_fee_producer_manifest_required' USING ERRCODE='23514'; END IF;
 expected_kind:=CASE r.source
  WHEN 'fn_register_for_tournament' THEN 'tournament_entry_fee'
  WHEN 'fn_register_horse_for_tournament' THEN 'tournament_entry_fee'
  WHEN 'fn_award_satellite_seat' THEN 'satellite_seat_entry_fee'
  WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket_entry_fee'
  WHEN 'fn_spin_book_entry' THEN 'spin_rake'
  WHEN 'process_tournament_rebuy' THEN r.metadata->>'kind' END;
 IF expected_kind IS NULL OR r.metadata->>'kind' IS DISTINCT FROM expected_kind
  OR (r.source='process_tournament_rebuy' AND expected_kind NOT IN('tournament_rebuy_fee','tournament_reentry_fee'))
 THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
 n:=jsonb_array_length(manifest->'contributors');
 IF (r.source='fn_spin_book_entry' AND n<>3) OR (r.source<>'fn_spin_book_entry' AND n<>1) THEN
  RAISE EXCEPTION 'tournament_fee_contributor_count_invalid' USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(manifest->'contributors') LOOP
  player:=(item->>'player_id')::uuid;club:=(item->>'club_id')::uuid;
  registration:=(item->>'registration_id')::uuid;ledger_id:=(item->>'charge_ledger_id')::uuid;
  entitlement_id:=(item->>'entitlement_id')::uuid;charged_at:=(item->>'charged_at')::timestamptz;
  weight:=(item->>'weight')::numeric;
  IF player IS NULL OR club IS NULL OR registration IS NULL OR ledger_id IS NULL OR entitlement_id IS NULL
   OR charged_at IS NULL OR NOT isfinite(charged_at) OR charged_at<cutoff OR charged_at>r.created_at
   OR weight IS NULL OR weight<=0 OR weight<>round(weight,2) OR weight::text IN('NaN','Infinity','-Infinity')
   OR player=ANY(seen_players) OR entitlement_id=ANY(seen_entitlements)
  THEN RAISE EXCEPTION 'tournament_fee_contributor_invalid' USING ERRCODE='23514'; END IF;
  seen_players:=array_append(seen_players,player);seen_entitlements:=array_append(seen_entitlements,entitlement_id);
  SELECT * INTO e FROM public.tournament_refund_entitlements WHERE id=entitlement_id;
  SELECT * INTO l FROM public.chip_ledger WHERE id=ledger_id;
  SELECT * INTO tp FROM public.tournament_players WHERE id=registration;
  IF e.id IS NULL OR l.id IS NULL OR tp.id IS NULL OR e.tournament_id IS DISTINCT FROM r.tournament_id
   OR e.user_id IS DISTINCT FROM player OR e.refund_wallet_club_id IS DISTINCT FROM club
   OR e.source_ledger_id IS DISTINCT FROM ledger_id OR e.created_at IS DISTINCT FROM charged_at
   OR tp.tournament_id IS DISTINCT FROM r.tournament_id OR tp.user_id IS DISTINCT FROM player OR tp.club_id IS DISTINCT FROM club
   OR l.created_at IS DISTINCT FROM charged_at OR l.amount IS DISTINCT FROM e.gross
  THEN RAISE EXCEPTION 'tournament_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
  IF r.source='fn_spin_book_entry' THEN
   -- A Spin has one aggregate fee, three exact paid entries, and one immutable
   -- reserve contribution. Weights are paid entry amounts, never mutable rebuys.
   IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM 'tournament_buyin'
    OR e.gross IS DISTINCT FROM weight OR l.from_type IS DISTINCT FROM 'player_wallet'
    OR l.from_entity_id IS DISTINCT FROM player OR l.to_type IS DISTINCT FROM 'prize_liability'
    OR l.to_entity_id IS DISTINCT FROM r.tournament_id OR l.club_id IS DISTINCT FROM club
    OR l.category IS DISTINCT FROM 'tournament_buyin'
    OR (r.player_contributions->>player::text)::numeric IS DISTINCT FROM weight
   THEN RAISE EXCEPTION 'spin_fee_charge_evidence_mismatch' USING ERRCODE='23514'; END IF;
  ELSE
   IF e.refund_fee IS DISTINCT FROM r.rake_amount OR weight IS DISTINCT FROM r.rake_amount
    OR r.metadata->>'user_id' IS DISTINCT FROM player::text
   THEN RAISE EXCEPTION 'tournament_fee_amount_evidence_mismatch' USING ERRCODE='23514'; END IF;
   IF r.source IN('fn_register_for_tournament','fn_register_horse_for_tournament','process_tournament_rebuy') THEN
    source_type:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
    IF e.entitlement_kind IS DISTINCT FROM 'wallet_charge' OR e.charge_category IS DISTINCT FROM source_type
     OR l.from_type IS DISTINCT FROM 'player_wallet' OR l.from_entity_id IS DISTINCT FROM player
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.club_id IS DISTINCT FROM club OR l.category IS DISTINCT FROM source_type
     OR (r.source<>'process_tournament_rebuy' AND r.metadata->>'registration_id' IS DISTINCT FROM registration::text)
    THEN RAISE EXCEPTION 'tournament_fee_wallet_evidence_mismatch' USING ERRCODE='23514'; END IF;
   ELSIF r.source='fn_register_for_tournament_with_ticket' THEN
    IF e.entitlement_kind IS DISTINCT FROM 'tournament_ticket' OR e.registration_id IS DISTINCT FROM registration
     OR e.source_ticket_id IS NULL OR r.metadata->>'ticket_id' IS DISTINCT FROM e.source_ticket_id::text
     OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
     OR l.from_type IS DISTINCT FROM 'escrow' OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.category IS DISTINCT FROM 'ticket_redeem'
    THEN RAISE EXCEPTION 'tournament_fee_ticket_evidence_mismatch' USING ERRCODE='23514'; END IF;
   ELSE
    IF e.entitlement_kind IS DISTINCT FROM 'satellite_seat' OR e.registration_id IS DISTINCT FROM registration
     OR e.source_satellite_id IS NULL OR r.metadata->>'satellite_id' IS DISTINCT FROM e.source_satellite_id::text
     OR r.metadata->>'registration_id' IS DISTINCT FROM registration::text
     OR l.from_type IS DISTINCT FROM 'prize_liability' OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
     OR l.to_type IS DISTINCT FROM 'prize_liability' OR l.to_entity_id IS DISTINCT FROM r.tournament_id
     OR l.category IS DISTINCT FROM 'tournament_buyin'
    THEN RAISE EXCEPTION 'tournament_fee_satellite_evidence_mismatch' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
  contributors:=contributors||jsonb_build_array(item);total_weight:=total_weight+weight;
 END LOOP;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3
   OR (SELECT count(DISTINCT (x->>'weight')::numeric) FROM jsonb_array_elements(contributors)x)<>1
   OR NOT EXISTS(SELECT 1 FROM public.spin_reserve_ledger s
      WHERE s.id=(manifest->>'spin_reserve_id')::uuid AND s.tournament_id=r.tournament_id
       AND s.kind='contribution' AND s.seats=3 AND s.house_rake=r.rake_amount
       AND s.amount=total_weight-r.rake_amount AND s.buy_in=total_weight/3)
  THEN RAISE EXCEPTION 'spin_fee_reserve_evidence_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 total_cents:=(r.rake_amount*100)::bigint;
 SELECT sum(floor(total_cents*(x->>'weight')::numeric/total_weight)) INTO floor_total FROM jsonb_array_elements(contributors)x;
 remainder_cents:=total_cents-floor_total;
 INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,source_manifest)
  VALUES(r.id,r.tournament_id,fingerprint,r.rake_amount,manifest);
 -- Largest remainder; UUID order breaks exact fractional ties reproducibly.
 FOR row_plan IN
  SELECT x, floor(total_cents*(x->>'weight')::numeric/total_weight)
    +CASE WHEN row_number() OVER(ORDER BY total_cents*(x->>'weight')::numeric/total_weight
       -floor(total_cents*(x->>'weight')::numeric/total_weight) DESC,x->>'player_id')<=remainder_cents THEN 1 ELSE 0 END cents
   FROM jsonb_array_elements(contributors)x ORDER BY x->>'player_id'
 LOOP
  item:=row_plan.x;credit:=row_plan.cents/100.0;
  contract:=public.fn_accounting_earning_contract((item->>'club_id')::uuid,(item->>'player_id')::uuid,
    credit,actual_union,(item->>'charged_at')::timestamptz);
  IF contract->>'player_id' IS DISTINCT FROM item->>'player_id' OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
   OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
   OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
   OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (item->>'charged_at')::timestamptz
  THEN RAISE EXCEPTION 'tournament_fee_contract_scope_mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_tournament_fee_sources(rake_record_id,tournament_id,player_id,club_id,union_id,
   coordinator_union_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)
  VALUES(r.id,r.tournament_id,(item->>'player_id')::uuid,(item->>'club_id')::uuid,actual_union,
   NULLIF(contract->>'coordinator_union_id','')::uuid,manifest->>'game_type',(item->>'registration_id')::uuid,
   (item->>'charge_ledger_id')::uuid,(item->>'entitlement_id')::uuid,(item->>'charged_at')::timestamptz,credit,contract)
  RETURNING id INTO new_id;
  result_ids:=array_append(result_ids,new_id);allocated:=allocated+credit;
 END LOOP;
 IF allocated IS DISTINCT FROM r.rake_amount THEN RAISE EXCEPTION 'tournament_fee_credit_not_conserved' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('accounting_version',2,'status','captured','rake_record_id',r.id,
  'tournament_id',r.tournament_id,'source_ids',result_ids,'rake_credit',allocated,'replayed',false,'payable',false);
END $function$;
ALTER FUNCTION public.fn_capture_accounting_tournament_fee(uuid,jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_capture_accounting_tournament_fee(uuid,jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_capture_accounting_tournament_fee(uuid,jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_capture_accounting_tournament_fee(uuid,jsonb) TO "postgres";

-- Captured pg_get_functiondef MD5 e7cae5f2fc19ef0d2c47e528764abd5a
CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_ledger uuid;
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text)
    RETURNING id INTO v_original_ledger;
    -- Private original-debit callers read this immediately after their UPDATE.
    PERFORM set_config('app.cash_original_debit_ledger',v_original_ledger::text,true);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_club_members_ledger_writer() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_club_members_ledger_writer()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_club_members_ledger_writer() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_club_members_ledger_writer() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_club_members_ledger_writer() TO "service_role";

-- Captured pg_get_functiondef MD5 0669e34f1376e42d734f7632ea35eb6a
CREATE OR REPLACE FUNCTION public.fn_create_seat_first_game_atomic(p_tournament_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_existing public.tournaments%ROWTYPE;
  v_existing_table public.tables%ROWTYPE;
  v_existing_table_count integer;
  v_created public.tournaments%ROWTYPE;
  v_table_id uuid;
  v_club_id uuid;
  v_union_id uuid;
  v_name text;
  v_game_type text;
  v_table_variant text;
  v_variant text;
  v_tournament_type text;
  v_buy_in numeric;
  v_buy_in_fee numeric;
  v_guarantee numeric;
  v_starting_chips integer;
  v_max_players integer;
  v_min_players integer;
  v_table_size integer;
  v_blinds jsonb;
  v_payouts jsonb;
  v_start_time timestamptz;
  v_late_reg_levels integer;
  v_late_reg_mins integer;
  v_satellite_target_id uuid;
  v_satellite_seats integer;
  v_short_description text;
  v_requested_current_players integer;
  v_requested_status text;
  v_first_level jsonb;
  v_small_blind numeric;
  v_big_blind numeric;
  v_admission_abi text;
BEGIN
  IF p_tournament_id IS NULL OR p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_REQUEST'
      USING ERRCODE = '22023';
  END IF;

  /* Every accepted request key must be represented by the durable pair below.
     Rejecting unknown keys prevents an idempotent replay from appearing exact
     after a caller adds configuration this creator silently ignores. */
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_config) AS supplied(key)
     WHERE supplied.key NOT IN (
       'club_id', 'union_id', 'name', 'game_type', 'variant',
       'tournament_type', 'buy_in_amount', 'buy_in_fee', 'guaranteed_prize',
       'starting_chips', 'max_players', 'min_players', 'table_size',
       'current_players', 'status', 'blind_structure', 'payout_structure',
       'start_time', 'late_reg_levels', 'late_reg_mins',
       'satellite_target_id', 'satellite_seats', 'short_description',
       'spin_multiplier', 'spin_locked_tiers'
     )
  ) THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY'
      USING ERRCODE = '22023';
  END IF;

  /* This is an entry-producing transaction. It takes the same first lock as
     every purchase path, before the idempotency key or either game row. */
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  v_admission_abi:=public.fn_ca_lock_mtt_admission_contract();
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:seat-first-create:' || p_tournament_id::text, 0)
  );

  v_club_id := NULLIF(p_config->>'club_id', '')::uuid;
  v_union_id := NULLIF(p_config->>'union_id', '')::uuid;
  v_name := NULLIF(btrim(p_config->>'name'), '');
  v_game_type := NULLIF(btrim(p_config->>'game_type'), '');
  v_table_variant := lower(v_game_type);
  v_variant := lower(NULLIF(btrim(p_config->>'variant'), ''));
  v_tournament_type := upper(NULLIF(btrim(p_config->>'tournament_type'), ''));
  v_buy_in := COALESCE(NULLIF(p_config->>'buy_in_amount', '')::numeric, 0);
  v_buy_in_fee := COALESCE(NULLIF(p_config->>'buy_in_fee', '')::numeric, 0);
  v_guarantee := COALESCE(NULLIF(p_config->>'guaranteed_prize', '')::numeric, 0);
  v_starting_chips := NULLIF(p_config->>'starting_chips', '')::integer;
  v_max_players := NULLIF(p_config->>'max_players', '')::integer;
  v_min_players := COALESCE(NULLIF(p_config->>'min_players', '')::integer, v_max_players);
  v_table_size := COALESCE(NULLIF(p_config->>'table_size', '')::integer, v_max_players);
  v_blinds := p_config->'blind_structure';
  v_payouts := COALESCE(p_config->'payout_structure', '[]'::jsonb);
  v_start_time := NULLIF(p_config->>'start_time', '')::timestamptz;
  v_late_reg_levels := COALESCE(NULLIF(p_config->>'late_reg_levels', '')::integer, 0);
  v_late_reg_mins := COALESCE(NULLIF(p_config->>'late_reg_mins', '')::integer, 0);
  v_satellite_target_id := NULLIF(p_config->>'satellite_target_id', '')::uuid;
  v_satellite_seats := NULLIF(p_config->>'satellite_seats', '')::integer;
  v_short_description := NULLIF(btrim(p_config->>'short_description'), '');
  v_requested_current_players :=
    COALESCE(NULLIF(p_config->>'current_players', '')::integer, 0);
  v_requested_status :=
    upper(COALESCE(NULLIF(btrim(p_config->>'status'), ''), 'REGISTERING'));

  IF v_club_id IS NULL
     OR v_name IS NULL
     OR v_game_type IS NULL
     OR v_variant IS NULL
     OR v_tournament_type IS NULL
     OR v_starting_chips IS NULL OR v_starting_chips <= 0
     OR v_max_players IS NULL OR v_max_players < 2 OR v_max_players > 3
     OR v_min_players < 2 OR v_min_players > v_max_players
     OR v_table_size <> v_max_players
     OR v_start_time IS NULL
     OR jsonb_typeof(v_blinds) <> 'array'
     OR jsonb_array_length(v_blinds) = 0
     OR jsonb_typeof(v_payouts) <> 'array'
     OR NOT (v_variant = 'spin' OR v_max_players = 2)
     OR v_tournament_type NOT IN ('SPIN', 'SNG', 'SATELLITE')
     OR v_table_variant NOT IN ('nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'flh', 'flo8')
     OR v_requested_current_players <> 0
     OR v_requested_status <> 'REGISTERING'
     OR NULLIF(p_config->>'spin_multiplier', '') IS NOT NULL
     OR (
       p_config ? 'spin_locked_tiers'
       AND jsonb_typeof(p_config->'spin_locked_tiers') IS DISTINCT FROM 'null'
     )
     OR (v_tournament_type = 'SPIN' AND (v_variant <> 'spin' OR v_max_players <> 3))
     OR (
       v_tournament_type = 'SATELLITE'
       AND (
         v_satellite_target_id IS NULL
         OR v_satellite_seats IS NULL
         OR v_satellite_seats <= 0
         OR v_satellite_seats > v_max_players
       )
     )
     OR (
       v_tournament_type <> 'SATELLITE'
       AND (v_satellite_target_id IS NOT NULL OR v_satellite_seats IS NOT NULL)
     )
     OR v_buy_in < 0 OR v_buy_in_fee < 0 OR v_guarantee < 0 THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_CONFIG'
      USING ERRCODE = '22023';
  END IF;

  v_first_level := v_blinds->0;
  v_small_blind := COALESCE(
    NULLIF(v_first_level->>'smallBlind', '')::numeric,
    NULLIF(v_first_level->>'small_blind', '')::numeric,
    NULLIF(v_first_level->>'sb', '')::numeric
  );
  v_big_blind := COALESCE(
    NULLIF(v_first_level->>'bigBlind', '')::numeric,
    NULLIF(v_first_level->>'big_blind', '')::numeric,
    NULLIF(v_first_level->>'bb', '')::numeric
  );
  IF v_small_blind IS NULL OR v_small_blind <= 0
     OR v_big_blind IS NULL OR v_big_blind < v_small_blind THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_BLINDS'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    SELECT count(*) INTO v_existing_table_count
      FROM public.tables tb
     WHERE tb.tournament_id = p_tournament_id
       AND COALESCE(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running');

    IF v_existing_table_count <> 1 THEN
      RAISE EXCEPTION
        'SEAT_FIRST_ATOMIC_PARTIAL_STATE: tournament % has % joinable tables',
        p_tournament_id, v_existing_table_count
        USING ERRCODE = '23514';
    END IF;

    SELECT tb.* INTO v_existing_table
      FROM public.tables tb
     WHERE tb.tournament_id = p_tournament_id
       AND COALESCE(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running')
     ORDER BY tb.created_at, tb.id
     LIMIT 1
     FOR UPDATE;
    v_table_id := v_existing_table.id;

    IF v_existing.club_id IS DISTINCT FROM v_club_id
       OR v_existing.union_id IS DISTINCT FROM v_union_id
       OR v_existing.name IS DISTINCT FROM v_name
       OR lower(v_existing.game_type) IS DISTINCT FROM lower(v_game_type)
       OR lower(v_existing.variant) IS DISTINCT FROM v_variant
       OR upper(v_existing.tournament_type) IS DISTINCT FROM v_tournament_type
       OR v_existing.buy_in_amount IS DISTINCT FROM v_buy_in
       OR v_existing.buy_in_fee IS DISTINCT FROM v_buy_in_fee
       OR v_existing.guaranteed_prize IS DISTINCT FROM v_guarantee
       OR v_existing.starting_chips IS DISTINCT FROM v_starting_chips
       OR v_existing.max_players IS DISTINCT FROM v_max_players
       OR v_existing.min_players IS DISTINCT FROM v_min_players
       OR v_existing.table_size IS DISTINCT FROM v_table_size
       OR (v_existing.blind_structure)::jsonb IS DISTINCT FROM v_blinds
       OR (v_existing.payout_structure)::jsonb IS DISTINCT FROM v_payouts
       OR v_existing.start_time IS DISTINCT FROM v_start_time
       OR v_existing.late_reg_levels IS DISTINCT FROM v_late_reg_levels
       OR v_existing.late_reg_mins IS DISTINCT FROM v_late_reg_mins
       OR v_existing.satellite_target_id IS DISTINCT FROM v_satellite_target_id
       OR v_existing.satellite_seats IS DISTINCT FROM v_satellite_seats
       OR v_existing.short_description IS DISTINCT FROM v_short_description
       OR v_existing_table.club_id IS DISTINCT FROM v_club_id
       OR v_existing_table.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_existing_table.name IS DISTINCT FROM v_name
       OR lower(v_existing_table.game_type) IS DISTINCT FROM 'tournament'
       OR lower(v_existing_table.game_variant) IS DISTINCT FROM v_table_variant
       OR v_existing_table.stakes IS DISTINCT FROM
          (v_small_blind::text || '/' || v_big_blind::text)
       OR v_existing_table.small_blind IS DISTINCT FROM v_small_blind
       OR v_existing_table.big_blind IS DISTINCT FROM v_big_blind
       OR v_existing_table.min_buy_in IS DISTINCT FROM 0::numeric
       OR v_existing_table.max_buy_in IS DISTINCT FROM 0::numeric
       OR v_existing_table.max_players IS DISTINCT FROM v_max_players THEN
      RAISE EXCEPTION 'SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH: %', p_tournament_id
        USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'replayed', true,
      'tournament', to_jsonb(v_existing),
      'table_id', v_table_id
    );
  END IF;

  IF v_admission_abi='unlimited-mtt-v2' AND v_satellite_target_id IS NOT NULL THEN
    RAISE EXCEPTION 'NEW_SATELLITE_REQUIRES_SCHEDULED_MTT_CONFIG' USING ERRCODE='55000';
  END IF;

  INSERT INTO public.tournaments (
    id, club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips,
    max_players, min_players, table_size, current_players, status,
    blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins,
    satellite_target_id, satellite_seats, short_description
  ) VALUES (
    p_tournament_id, v_club_id, v_union_id, v_name, v_game_type, v_variant,
    v_tournament_type, v_buy_in, v_buy_in_fee, v_guarantee, v_starting_chips,
    v_max_players, v_min_players, v_table_size, 0, 'REGISTERING',
    v_blinds::text, v_payouts::text, v_start_time,
    v_late_reg_levels, v_late_reg_mins,
    v_satellite_target_id, v_satellite_seats, v_short_description
  ) RETURNING * INTO v_created;

  INSERT INTO public.tables (
    club_id, tournament_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in,
    max_players, current_players, status
  ) VALUES (
    v_club_id, p_tournament_id, v_name, 'tournament', v_table_variant,
    v_small_blind::text || '/' || v_big_blind::text,
    v_small_blind, v_big_blind, 0, 0,
    v_max_players, 0, 'waiting'
  ) RETURNING id INTO v_table_id;

  RETURN jsonb_build_object(
    'ok', true,
    'replayed', false,
    'tournament', to_jsonb(v_created),
    'table_id', v_table_id
  );
END;
$function$;
ALTER FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_create_seat_first_game_atomic(uuid,jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_create_seat_first_game_atomic(uuid,jsonb) TO "service_role";

-- Captured pg_get_functiondef MD5 9706ead97b5e6f495957bfd02a6eb282
CREATE OR REPLACE FUNCTION public.fn_emit_managed_game_row_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_document jsonb := to_jsonb(NEW);
  v_old_document jsonb := to_jsonb(OLD);
  v_club  uuid := COALESCE(v_new_document ->> 'club_id', v_old_document ->> 'club_id')::uuid;
  v_id    uuid := COALESCE(v_new_document ->> 'id',      v_old_document ->> 'id')::uuid;
  v_watch text[];
BEGIN
  -- Tournament backing tables are represented by the tournament event itself.
  IF TG_TABLE_NAME = 'tables' THEN
    IF COALESCE(v_new_document ->> 'tournament_id',
                v_old_document ->> 'tournament_id') IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Exactly the columns fn_list_managed_games projects for this kind. Keep
    -- these two lists in step with that function: a column the board reads and
    -- this does not watch is a row that silently stops refreshing.
    v_watch := CASE TG_TABLE_NAME
      WHEN 'tables' THEN ARRAY[
        'club_id', 'union_id', 'tournament_id', 'is_deleted', 'name', 'status',
        'game_variant', 'current_players', 'max_players', 'small_blind',
        'big_blind', 'min_buy_in', 'max_buy_in', 'created_at']
      ELSE ARRAY[
        'club_id', 'union_id', 'name', 'status', 'game_type', 'variant',
        'current_players', 'max_players', 'start_time', 'created_at',
        'buy_in_amount', 'guaranteed_prize', 'prize_pool']
    END;

    IF (SELECT jsonb_object_agg(k, COALESCE(v_old_document -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
       IS NOT DISTINCT FROM
       (SELECT jsonb_object_agg(k, COALESCE(v_new_document -> k, 'null'::jsonb))
          FROM unnest(v_watch) AS k)
    THEN
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    'game_changed', v_club, NULL, NULL,
    CASE WHEN TG_TABLE_NAME = 'tables' THEN 'table' ELSE 'tournament' END,
    v_id, NULL, jsonb_build_object('operation', lower(TG_OP)));
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_emit_managed_game_row_event() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_emit_managed_game_row_event()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_emit_managed_game_row_event() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_emit_managed_game_row_event() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_emit_managed_game_row_event() TO "service_role";

-- Captured pg_get_functiondef MD5 0603b05f5046cbaa057228acd3a5c331
CREATE OR REPLACE FUNCTION public.fn_guard_agent_agreement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE parent public.agents%ROWTYPE;child record;field text;new_value numeric;old_value numeric;parent_value numeric;child_value numeric;
 old_terms jsonb;new_terms jsonb;parent_terms jsonb;new_edge boolean;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.club_id IS DISTINCT FROM OLD.club_id) THEN
  RAISE EXCEPTION 'agent financial account identity is immutable; create a separate account for another club or user' USING ERRCODE='23514';END IF;
 -- All agreement RPCs take this same club lock before reading terms. Direct
 -- writes also pass this guard; the financial account's club is immutable.
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||NEW.club_id::text,0));
 old_terms:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 new_terms:=to_jsonb(NEW);
 new_edge:=TG_OP='INSERT' OR NEW.parent_agent_id IS DISTINCT FROM OLD.parent_agent_id OR NEW.club_id IS DISTINCT FROM OLD.club_id;
 IF NEW.parent_agent_id IS NOT NULL THEN
  SELECT * INTO parent FROM public.agents WHERE id=NEW.parent_agent_id AND club_id=NEW.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'parent agent must belong to the same club' USING ERRCODE='23514';END IF;
  IF NEW.parent_agent_id=NEW.id OR EXISTS(WITH RECURSIVE chain AS (
    SELECT id,parent_agent_id FROM public.agents WHERE id=NEW.parent_agent_id AND club_id=NEW.club_id
    UNION SELECT a.id,a.parent_agent_id FROM public.agents a JOIN chain c ON a.id=c.parent_agent_id WHERE a.club_id=NEW.club_id
   ) SELECT 1 FROM chain WHERE id=NEW.id) THEN
   RAISE EXCEPTION 'agent hierarchy cannot contain a cycle' USING ERRCODE='23514';END IF;
  IF new_edge AND (parent.role='sub_agent' OR parent.status IS DISTINCT FROM 'active') THEN
   RAISE EXCEPTION 'new parent must be an active agent or super agent' USING ERRCODE='23514';END IF;
  parent_terms:=to_jsonb(parent);
 END IF;
 IF NEW.role='sub_agent' AND (TG_OP='INSERT' OR NEW.role IS DISTINCT FROM OLD.role)
  AND EXISTS(SELECT 1 FROM public.agents c WHERE c.parent_agent_id=NEW.id) THEN
  RAISE EXCEPTION 'a sub-agent cannot have agent children' USING ERRCODE='23514';END IF;

 FOREACH field IN ARRAY ARRAY['commission_rate','player_rakeback_rate','credit_limit'] LOOP
  new_value:=(new_terms->>field)::numeric;old_value:=(old_terms->>field)::numeric;
  IF TG_OP='INSERT' OR new_value IS DISTINCT FROM old_value THEN
   IF new_value IS NULL OR new_value::text IN('NaN','Infinity','-Infinity') OR new_value<0
    OR (field='credit_limit' AND new_value<>round(new_value,2))
    OR (field='commission_rate' AND new_value>0.70)
    OR (field='player_rakeback_rate' AND new_value>0.50) THEN
    RAISE EXCEPTION 'invalid agent agreement value: %',field USING ERRCODE='23514';END IF;
  END IF;
  IF NEW.parent_agent_id IS NOT NULL AND (new_edge OR new_value IS DISTINCT FROM old_value) THEN
   parent_value:=(parent_terms->>field)::numeric;
   IF parent_value IS NOT NULL AND greatest(new_value-parent_value,0)>
      (CASE WHEN new_edge THEN 0 ELSE greatest(old_value-parent_value,0) END) THEN
    RAISE EXCEPTION 'agent % cannot exceed or worsen its parent cap',field USING ERRCODE='23514';END IF;
  END IF;
  IF TG_OP='UPDATE' AND new_value IS DISTINCT FROM old_value THEN
   FOR child IN SELECT to_jsonb(a) AS terms FROM public.agents a WHERE a.parent_agent_id=NEW.id AND a.club_id=NEW.club_id LOOP
    child_value:=(child.terms->>field)::numeric;
    IF child_value IS NOT NULL AND greatest(child_value-new_value,0)>greatest(child_value-old_value,0) THEN
     RAISE EXCEPTION 'agent % cannot be reduced below an existing child agreement',field USING ERRCODE='23514';END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_guard_agent_agreement() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_guard_agent_agreement()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_guard_agent_agreement() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_guard_agent_agreement() TO "postgres";

-- Captured pg_get_functiondef MD5 e4e6dbe534f8ed1fc7fa03fcad968114
CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
  v_managed_command boolean :=
    COALESCE(current_setting('app.managed_game_lifecycle', true), '') = 'on';
  v_protected_tournament_keys text[] := ARRAY[
    'name', 'start_time', 'max_players', 'buy_in_amount', 'buy_in_fee',
    'guaranteed_prize', 'late_reg_mins', 'starting_chips', 'blind_structure',
    'payout_structure', 'game_type', 'variant', 'tournament_type', 'is_rebuy',
    'rebuy_cost', 'rebuy_chips', 'rebuy_levels', 'add_on_available',
    'addon_cost', 'addon_chips', 'is_bounty', 'bounty_amount', 'is_pko',
    'is_mystery_bounty', 'mystery_bounty_min', 'mystery_bounty_max',
    'description', 'short_description', 'min_players', 'late_reg_levels',
    'is_reentry', 'max_rebuys', 'max_reentries', 'addon_levels',
    'addon_break_minutes', 'is_private', 'is_vip_only', 'ban_chat',
    'all_in_or_fold', 'label_as_new', 'hide_club_name', 'is_pinned',
    'action_time_seconds', 'table_size', 'accelerated_mtt', 'big_blind_ante',
    'authorized_to_register', 'early_bird_enabled', 'early_bird_chips',
    'bubble_protection', 'final_table_deal_enabled', 'restart_every_minutes',
    'synchronized_breaks', 'is_multi_day', 'total_days', 'is_xmtt',
    'union_id', 'satellite_target_id', 'satellite_seats', 'spin_type',
    'mystery_bounty_profile', 'mystery_bounty_activation',
    'mystery_bounty_activation_value', 'mystery_bounty_pool_percent',
    'mystery_bounty_top_percent', 'settings'
  ];
  v_key text;
  v_new_document jsonb;
  v_old_document jsonb;
BEGIN
  IF TG_TABLE_NAME = 'tables' THEN
    IF lower(COALESCE(NEW.status, '')) IN ('closed', 'deleted')
       AND lower(COALESCE(OLD.status, '')) NOT IN ('closed', 'deleted')
       AND EXISTS (
         SELECT 1
         FROM public.table_seats ts
         WHERE ts.table_id = NEW.id
           AND ts.left_at IS NULL
       ) THEN
      RAISE EXCEPTION 'This table cannot be closed while players are seated'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine
       AND NOT v_managed_command
       AND (
         lower(COALESCE(NEW.status, '')) = 'deleted'
         AND lower(COALESCE(OLD.status, '')) <> 'deleted'
         OR COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false)
       ) THEN
      RAISE EXCEPTION 'Table lifecycle changes must use fn_close_managed_game'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (
       SELECT 1
       FROM public.tournament_players tp
       WHERE tp.tournament_id = NEW.id
     ) THEN
    IF NOT v_is_engine
       AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
       AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
      RAISE EXCEPTION 'This tournament cannot be cancelled after a player has registered'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_is_engine THEN
      v_new_document := to_jsonb(NEW);
      v_old_document := to_jsonb(OLD);
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN
          RAISE EXCEPTION 'This tournament cannot be modified after a player has registered'
            USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_is_engine
     AND NOT v_managed_command
     AND upper(COALESCE(NEW.status, '')) IN ('CANCELLED', 'CANCELED')
     AND upper(COALESCE(OLD.status, '')) NOT IN ('CANCELLED', 'CANCELED') THEN
    RAISE EXCEPTION 'Tournament lifecycle changes must use fn_close_managed_game'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_managed_game_lifecycle() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_guard_managed_game_lifecycle()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_guard_managed_game_lifecycle() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_lifecycle() TO "service_role";

-- Captured pg_get_functiondef MD5 aac67e5c89eaa564744a97a85b5f3fbb
CREATE OR REPLACE FUNCTION public.fn_guard_new_mtt_blind_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE contract jsonb;
BEGIN
  IF (TG_OP='INSERT' OR OLD.format_contract IN ('mtt-v1','mtt-v2'))
     AND public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN
    IF TG_OP='UPDATE' AND OLD.format_contract IN ('mtt-v1','mtt-v2')
       AND NEW.blind_structure IS NOT DISTINCT FROM OLD.blind_structure
       AND NEW.starting_chips IS NOT DISTINCT FROM OLD.starting_chips THEN RETURN NEW; END IF;
    contract:=public.fn_ca_mtt_blind_contract(NEW.blind_structure,NEW.starting_chips);
    NEW.blind_speed:=contract->>'blind_speed';
    NEW.is_turbo:=(contract->>'is_turbo')::boolean;
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.tournament_type,''))<>'MTT'
     OR lower(COALESCE(NEW.variant,'')) IN ('spin','sng')
     OR COALESCE(NEW.max_players,0)<=2 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.blind_structure IS NOT DISTINCT FROM OLD.blind_structure
     AND NEW.starting_chips IS NOT DISTINCT FROM OLD.starting_chips
     AND upper(COALESCE(OLD.tournament_type,''))='MTT'
     AND lower(COALESCE(OLD.variant,'')) NOT IN ('spin','sng')
     AND COALESCE(OLD.max_players,0)>2 THEN RETURN NEW; END IF;
  contract:=public.fn_ca_mtt_blind_contract(NEW.blind_structure,NEW.starting_chips);
  NEW.blind_speed:=contract->>'blind_speed';
  NEW.is_turbo:=(contract->>'is_turbo')::boolean;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_guard_new_mtt_blind_contract() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_guard_new_mtt_blind_contract()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_guard_new_mtt_blind_contract() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_guard_new_mtt_blind_contract() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_guard_new_mtt_blind_contract() TO "service_role";

-- Captured pg_get_functiondef MD5 b647df60b45c25183638f4cdbaec57fd
CREATE OR REPLACE FUNCTION public.fn_post_accounting_commission_source(p_source_id uuid, p_source_type text, p_earned_at timestamp with time zone, p_contract jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE tier jsonb;commission_id uuid;count_rows integer:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_source_id IS NULL OR p_source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')
  OR p_source_type IS NULL OR p_earned_at IS NULL OR NOT isfinite(p_earned_at)
  OR jsonb_typeof(p_contract->'tiers') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'invalid_accounting_commission_source' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id=(p_contract->>'club_id')::uuid
  AND p_earned_at>=s.period_start AND p_earned_at<s.period_end)
 THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
  FOR tier IN SELECT value FROM jsonb_array_elements(p_contract->'tiers') LOOP
   IF (tier->>'amount')::numeric>0 THEN
    -- source_id identifies the real per-player source receipt above; it is
    -- never a fabricated hand identifier. Existing unique keys now distinguish
    -- two players with the same agent and one agent earning in two clubs.
    INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,notes,created_at)
     VALUES((p_contract->>'club_id')::uuid,(tier->>'user_id')::uuid,(tier->>'amount')::numeric,(tier->>'rate')::numeric,
      p_source_type,p_source_id,'Commission from recorded earning agreement; tier '||(tier->>'depth'),p_earned_at)
     RETURNING id INTO commission_id;
    count_rows:=count_rows+1;
   END IF;
   UPDATE public.agents SET lifetime_rake_generated=COALESCE(lifetime_rake_generated,0)+(p_contract->>'rake_credit')::numeric,
    weekly_rake_generated=COALESCE(weekly_rake_generated,0)+CASE WHEN public.fn_union_week_start(p_earned_at)=public.fn_union_week_start(now())
      THEN (p_contract->>'rake_credit')::numeric ELSE 0 END,
    last_active_at=now(),updated_at=now()
    WHERE id=(tier->>'agent_id')::uuid AND club_id=(p_contract->>'club_id')::uuid AND user_id=(tier->>'user_id')::uuid;
   -- Display counters exist only while the agent profile exists. The earned
   -- liability belongs to its recorded user and club even after retirement.
  END LOOP;
 RETURN count_rows;
END $function$;
ALTER FUNCTION public.fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb) TO "postgres";

-- Captured pg_get_functiondef MD5 3d222458b40d5aec09f8f1e88bf60d53
CREATE OR REPLACE FUNCTION public.fn_seat_change_syncs_seat_first_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_table_id uuid;
  v_tid uuid;
BEGIN
  v_table_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.table_id ELSE NEW.table_id END;
  IF v_table_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT tournament_id INTO v_tid
    FROM public.tables
   WHERE id = v_table_id;
  IF v_tid IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
     WHERE t.id = v_tid
       AND public.fn_ca_tournament_recorded_seat_first(t.id, true)
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_tid);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
ALTER FUNCTION public.fn_seat_change_syncs_seat_first_count() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_seat_change_syncs_seat_first_count()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_seat_change_syncs_seat_first_count() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_seat_change_syncs_seat_first_count() TO "postgres";

-- Captured pg_get_functiondef MD5 fb3adc8a9ea6346e34fee79945f9046a
CREATE OR REPLACE FUNCTION public.fn_short_formats_never_break()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (TG_OP='INSERT' OR OLD.format_contract IN ('mtt-v1','mtt-v2'))
     AND public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF upper(COALESCE(NEW.tournament_type, '')) IN ('SPIN', 'SNG')
     OR lower(COALESCE(NEW.variant, '')) IN ('spin', 'sng')
  THEN
    NEW.synchronized_breaks := false;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_short_formats_never_break() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_short_formats_never_break()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_short_formats_never_break() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_short_formats_never_break() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_short_formats_never_break() TO "service_role";

-- Captured pg_get_functiondef MD5 7e7495ff6800996d72b5ab27008a33a6
CREATE OR REPLACE FUNCTION public.fn_stamp_accounting_tournament_fee(p_rake_record_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.rake_records%ROWTYPE;t record;e record;tp record;item record;reserve_id uuid;
 manifest jsonb;contributors jsonb:='[]';game_union uuid;expected_entitlement text;
 expected_category text;uid uuid;reg uuid;count_rows int;cutoff timestamptz;legacy boolean:=false;
BEGIN
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR UPDATE;
 IF NOT FOUND OR NOT r.is_tournament OR r.rake_amount<=0 THEN
  RAISE EXCEPTION 'positive_chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id) THEN
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches WHERE rake_record_id=r.id AND status='legacy_unverified') THEN
   RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
  END IF;
  RETURN public.fn_capture_accounting_tournament_fee(r.id);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
 IF r.created_at IS DISTINCT FROM transaction_timestamp() OR cutoff IS NULL OR r.created_at<cutoff THEN
  RAISE EXCEPTION 'tournament_fee_not_captured_by_original_producer' USING ERRCODE='55000'; END IF;
 SELECT id,club_id,union_id,is_private,tournament_type INTO t FROM public.tournaments WHERE id=r.tournament_id FOR SHARE;
 IF NOT FOUND OR public.fn_poker_diamond_tournament(r.tournament_id) THEN
  RAISE EXCEPTION 'chip_tournament_fee_required' USING ERRCODE='23514'; END IF;
 game_union:=CASE WHEN t.is_private THEN NULL ELSE t.union_id END;
 IF r.source='fn_spin_book_entry' THEN
  IF jsonb_typeof(r.player_contributions) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r.player_contributions))<>3 THEN
   RAISE EXCEPTION 'spin_fee_exact_paid_contributors_required' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT key::uuid player_id,value::numeric weight FROM jsonb_each_text(r.player_contributions) ORDER BY key LOOP
   SELECT * INTO tp FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=item.player_id;
   IF NOT FOUND OR tp.club_id IS NULL THEN RAISE EXCEPTION 'spin_fee_entry_club_missing' USING ERRCODE='23514'; END IF;
   SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
   SELECT * INTO e FROM public.tournament_refund_entitlements x
    WHERE x.tournament_id=r.tournament_id AND x.user_id=item.player_id AND x.entitlement_kind='wallet_charge'
     AND x.charge_category='tournament_buyin' AND x.created_at=tp.registered_at AND x.gross=item.weight;
   contributors:=contributors||jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
    'registration_id',tp.id,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',item.weight));
   legacy:=legacy OR e.created_at<cutoff;
  END LOOP;
  SELECT count(*) INTO count_rows FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
  IF count_rows<>1 THEN RAISE EXCEPTION 'spin_fee_exact_reserve_required' USING ERRCODE='23514'; END IF;
  SELECT id INTO reserve_id FROM public.spin_reserve_ledger s WHERE s.tournament_id=r.tournament_id AND s.kind='contribution';
 ELSE
  IF NOT COALESCE(r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false) THEN
   RAISE EXCEPTION 'tournament_fee_exact_player_required' USING ERRCODE='23514'; END IF;
  uid:=(r.metadata->>'user_id')::uuid;
  expected_entitlement:=CASE r.source WHEN 'fn_register_for_tournament' THEN 'wallet_charge'
   WHEN 'fn_register_horse_for_tournament' THEN 'wallet_charge' WHEN 'process_tournament_rebuy' THEN 'wallet_charge'
   WHEN 'fn_award_satellite_seat' THEN 'satellite_seat' WHEN 'fn_register_for_tournament_with_ticket' THEN 'tournament_ticket' END;
  expected_category:=CASE WHEN r.source='process_tournament_rebuy' THEN 'rebuy' ELSE 'tournament_buyin' END;
  IF expected_entitlement IS NULL THEN RAISE EXCEPTION 'tournament_fee_source_unsupported' USING ERRCODE='55000'; END IF;
  reg:=NULLIF(r.metadata->>'registration_id','')::uuid;
  IF reg IS NULL AND r.source='process_tournament_rebuy' THEN
   SELECT id INTO reg FROM public.tournament_players WHERE tournament_id=r.tournament_id AND user_id=uid;
  END IF;
  IF reg IS NULL THEN RAISE EXCEPTION 'tournament_fee_exact_registration_required' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO count_rows FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  IF count_rows<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_charge_ambiguous' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM public.tournament_refund_entitlements x
   WHERE x.tournament_id=r.tournament_id AND x.user_id=uid AND x.created_at=r.created_at AND x.refund_fee=r.rake_amount
    AND x.entitlement_kind=expected_entitlement
    AND (CASE WHEN expected_entitlement='wallet_charge' THEN x.charge_category=expected_category ELSE x.registration_id=reg END);
  contributors:=jsonb_build_array(jsonb_build_object('player_id',e.user_id,'club_id',e.refund_wallet_club_id,
   'registration_id',reg,'charge_ledger_id',e.source_ledger_id,'entitlement_id',e.id,'charged_at',e.created_at,'weight',r.rake_amount));
 END IF;
 IF legacy THEN
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified');
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false);
 END IF;
 manifest:=jsonb_build_object('union_id',game_union,'game_type',lower(t.tournament_type),'contributors',contributors,'spin_reserve_id',reserve_id);
 -- Original tournament evidence may already be sealed by a satellite receipt.
 -- Capture its manifest on the accounting batch; never rewrite that raw row.
 BEGIN
  RETURN public.fn_capture_accounting_tournament_fee(r.id,manifest);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  -- Missing observed agreement may not destroy a proved original fee charge.
  -- This subtransaction rolls back every contributor receipt before recording
  -- the entire batch as unavailable. No partial commission can become payable.
  IF SQLERRM NOT IN('accounting_terms_not_observed','accounting_terms_not_active') THEN RAISE; END IF;
  INSERT INTO public.accounting_tournament_fee_batches(rake_record_id,tournament_id,source_fingerprint,rake_amount,status,source_manifest)
   VALUES(r.id,r.tournament_id,public.fn_accounting_tournament_fee_fingerprint(r),r.rake_amount,'legacy_unverified',
    manifest||jsonb_build_object('capture_reason',SQLERRM));
  RETURN jsonb_build_object('accounting_version',2,'status','legacy_unverified','rake_record_id',r.id,'payable',false,'reason',SQLERRM);
 END;
END $function$;
ALTER FUNCTION public.fn_stamp_accounting_tournament_fee(uuid) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_stamp_accounting_tournament_fee(uuid)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_stamp_accounting_tournament_fee(uuid) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_stamp_accounting_tournament_fee(uuid) TO "postgres";

-- Captured pg_get_functiondef MD5 0e4acaf0ff080d4dafd1aa85068cf0b2
CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table      uuid;
  v_seats      integer := 0;
  v_seat_first boolean := false;
  v_is_spin    boolean := false;
  v_cap        integer := 0;
  v_variant    text := '';
  v_book       jsonb;
BEGIN
  -- This is an AFTER-seat helper. It must never acquire a new global lock
  -- after PostgreSQL already owns the changed seat row. Every legitimate
  -- create/revive root pre-acquires terminal -> mission -> launch -> tournament,
  -- and the earliest BEFORE trigger refuses a raw writer that did not.
  SELECT public.fn_ca_tournament_recorded_seat_first(t.id, true),
         t.format_contract = 'spin-v1',
         COALESCE(t.max_players, 0),
         COALESCE(t.variant, '')
    INTO v_seat_first, v_is_spin, v_cap, v_variant
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Freeze the complete table/seat set before choosing the occupied table.
  -- UUID order is deterministic across every transaction using this owner.
  PERFORM tb.id
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
   ORDER BY tb.id
   FOR UPDATE;

  PERFORM s.id
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) <> 'closed'
     AND s.left_at IS NULL
   ORDER BY s.table_id, s.seat_number, s.id
   FOR UPDATE OF s;

  v_table := public.fn_tournament_primary_table(p_tournament_id);

  IF v_table IS NULL THEN
    IF COALESCE(v_seat_first, false) THEN
      SELECT count(*) INTO v_seats
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.left_at IS NULL;
      UPDATE public.tournaments SET current_players = v_seats
       WHERE id = p_tournament_id
         AND current_players IS DISTINCT FROM v_seats;
      RETURN v_seats;
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND left_at IS NULL;

  UPDATE public.tables SET current_players = v_seats
   WHERE id = v_table
     AND current_players IS DISTINCT FROM v_seats;

  IF COALESCE(v_seat_first, false) THEN
    UPDATE public.tournaments SET current_players = v_seats
     WHERE id = p_tournament_id
       AND current_players IS DISTINCT FROM v_seats;
  END IF;

  IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
    v_book := public.fn_spin_book_entry(p_tournament_id);
    IF COALESCE((v_book->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'paid third seat could not book Spin %: %',
        p_tournament_id,v_book USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF COALESCE(v_seat_first, false)
     AND v_cap > 0 AND v_seats >= v_cap THEN
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object(
          'tournament_id', p_tournament_id,
          'variant', v_variant,
          'max_players', v_cap,
          'paid_seats', v_seats,
          'filled_at', now()
        ),
        'seat_first_ready',
        'seat_first',
        false
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'fn_sync_seat_first_player_count: realtime.send failed for %: %',
        p_tournament_id, SQLERRM;
    END;
  END IF;

  RETURN v_seats;
END;
$function$;
ALTER FUNCTION public.fn_sync_seat_first_player_count(uuid) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_sync_seat_first_player_count(uuid)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO "postgres";

-- Captured pg_get_functiondef MD5 67a6b85f00a785e22c4d89c6168253d3
CREATE OR REPLACE FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(p_table_id uuid, p_seat_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_tbl        record;
  v_t          record;
  v_reg        jsonb;
  v_seat_cap   integer;
  v_taken      integer;
  v_mine       integer;
  v_stack      numeric;
  v_err        text;
BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM set_config('app.money_path', 'fn_take_seat_and_buy_in', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  -- "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO SIT DOWN AND BUY CHIPS AND GET
  -- DEALT A HAND. THAT CAN NEVER HAPPEN." It could, because this project
  -- issues SEVEN-DAY access tokens and PostgREST verifies a JWT locally -
  -- signature and exp only. It never asks GoTrue whether the session behind
  -- that token still exists, so signing out left a bearer token that kept
  -- spending real chips as its owner for the rest of the week. The engine
  -- was never fooled (it verifies through auth.getUser, which checks the
  -- session), only the database was. fn_caller_session_is_live closes that
  -- gap at the money door itself.
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_take_seat_and_buy_in requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, tournament_id, max_players, status
    INTO v_tbl FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_tbl.tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_game_table');
  END IF;
  IF v_tbl.status = 'closed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_closed');
  END IF;

  SELECT id, status, variant, max_players, starting_chips, name
    INTO v_t FROM public.tournaments WHERE id = v_tbl.tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;

  IF NOT public.fn_ca_tournament_recorded_seat_first(v_t.id, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  -- The chips this seat is buying. Known now, because the board decides it.
  v_stack := COALESCE(v_t.starting_chips, 0);

  v_seat_cap := COALESCE(NULLIF(v_tbl.max_players, 0), v_t.max_players, 3);

  IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > v_seat_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_seat');
  END IF;

  SELECT seat_number INTO v_mine
    FROM public.table_seats
   WHERE table_id = p_table_id AND user_id = v_uid AND left_at IS NULL LIMIT 1;
  IF v_mine IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_seated', true,
      'table_id', p_table_id, 'seat_number', v_mine);
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_already_started');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.table_seats
     WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END IF;

  PERFORM public.fn_sync_seat_first_player_count(v_t.id);

  v_reg := public.fn_register_for_tournament(v_t.id, true);
  IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_reg->>'reason', '') <> 'already_registered' THEN
    RETURN jsonb_build_object('ok', false,
      'reason', COALESCE(v_reg->>'reason', 'buy_in_failed'));
  END IF;

  UPDATE public.tournament_players
     SET status = 'playing', chips = v_stack, table_id = p_table_id, seat_number = p_seat_number
   WHERE tournament_id = v_t.id AND user_id = v_uid;

  UPDATE public.table_seats
     SET user_id = v_uid, stack = v_stack, left_at = NULL, joined_at = now(), is_sitting_out = false
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
      VALUES (p_table_id, v_uid, p_seat_number, v_stack);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'seat_taken' USING ERRCODE = '55000';
    END;
  END IF;

  v_taken := COALESCE(public.fn_sync_seat_first_player_count(v_t.id), 0);
  IF v_taken = 0 THEN
    SELECT count(*) INTO v_taken FROM public.table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
  END IF;

  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id,
    'seat_number', p_seat_number, 'stack', v_stack, 'seat_reserved', true,
    'seats_taken', v_taken, 'seats_needed', v_seat_cap,
    'starts_now', v_taken >= v_seat_cap,
    'cost', COALESCE((v_reg->>'cost')::numeric, 0))
    -- DIAMOND PHASE 8: a Diamond seat purchase names its asset and the
    -- wallet after the charge, as the lobby receipt does, so the client can
    -- move the balance it shows. Absent on the already_registered answer,
    -- which carries no charge.
    || CASE WHEN v_reg ? 'asset'
         THEN jsonb_build_object('asset', v_reg->'asset', 'diamonds_after', v_reg->'diamonds_after')
         ELSE '{}'::jsonb END;

EXCEPTION
  WHEN sqlstate '55000' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  WHEN sqlstate '23514' THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE '%FOUR TABLE LIMIT%' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'table_limit_reached',
        'limit', 4);
    END IF;
    RAISE;
END;
$function$;
ALTER FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer) TO "postgres";

-- Captured pg_get_functiondef MD5 f5dcb63005864b24bf422c6628cb169e
CREATE OR REPLACE FUNCTION public.fn_tournaments_creation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_paid int;
BEGIN
  IF public.fn_ca_new_tournament_is_unlimited(to_jsonb(NEW)) THEN
    RETURN NEW; -- The earlier normalizer and final recorded-format constraint own NULL.
  END IF;
  IF COALESCE(NEW.max_players, 0) <= 0 THEN
    RAISE EXCEPTION
      'tournament guard: max_players must be positive (got %) - a tournament with no seats can never start',
      NEW.max_players
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payout_structure IS NOT NULL
     AND jsonb_typeof(NEW.payout_structure::jsonb) = 'array' THEN
    v_paid := jsonb_array_length(NEW.payout_structure::jsonb);
    IF v_paid > NEW.max_players THEN
      RAISE EXCEPTION
        'tournament guard: % paid places for % seats - more places than players who can enter',
        v_paid, NEW.max_players
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_tournaments_creation_guard() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_tournaments_creation_guard()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_tournaments_creation_guard() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_tournaments_creation_guard() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_tournaments_creation_guard() TO "service_role";

-- Captured pg_get_functiondef MD5 df060874f0ffaf8105cce1d3bdaed35b
CREATE OR REPLACE FUNCTION public.fn_union_pnl_capture_original_flow()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE frame public.union_pnl_transaction_frames; scope jsonb;
BEGIN
 -- These are the original cash/table and tournament/liability journal legs.
 -- Other wallet transfers, rakeback and P&L payments are not poker winnings.
 IF NOT ((NEW.from_type IN ('player_wallet','club_treasury') AND NEW.to_type IN ('table_stack','prize_liability'))
  OR (NEW.to_type IN ('player_wallet','club_treasury') AND NEW.from_type IN ('table_stack','prize_liability'))) THEN RETURN NULL; END IF;
 frame:=public.fn_union_pnl_original_frame();
 IF NEW.tournament_id IS NOT NULL THEN
  SELECT jsonb_build_object('game_union_id',t.union_id,'host_club_id',t.club_id,'tournament_id',t.id,'is_private',t.is_private,'asset','chips','unit_scale',2)
  INTO scope FROM public.tournaments t WHERE t.id=NEW.tournament_id;
 ELSE
  SELECT jsonb_build_object('game_union_id',t.union_id,'host_club_id',t.club_id,'tournament_id',t.tournament_id,'is_private',t.is_private,'asset','chips','unit_scale',2)
  INTO scope FROM public.tables t WHERE t.id=NEW.table_id;
 END IF;
 INSERT INTO public.union_pnl_original_flows VALUES(NEW.id,frame.transaction_id,frame.observed_at,COALESCE(scope,'{}'),to_jsonb(NEW));
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_union_pnl_capture_original_flow() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_union_pnl_capture_original_flow()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_union_pnl_capture_original_flow() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_capture_original_flow() TO "postgres";

-- Captured pg_get_functiondef MD5 307d83a1ee3d912bade24c48144aa801
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'original_pnl_inventory_is_immutable' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_immutable() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_union_pnl_inventory_immutable()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_immutable() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_immutable() TO "postgres";

-- Captured pg_get_functiondef MD5 11c7c788d943a11375a15819e78873ba
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_observe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prior jsonb; following jsonb; frame public.union_pnl_transaction_frames;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'pnl_inventory_source_truncate_refused' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN prior:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN following:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 IF prior IS NOT DISTINCT FROM following THEN RETURN NULL; END IF;
 frame:=public.fn_union_pnl_original_frame();
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 VALUES(TG_TABLE_NAME,(COALESCE(following,prior)->>'id')::uuid,frame.observed_at,frame.transaction_id,TG_OP,prior,following);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_observe() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_union_pnl_inventory_observe()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_observe() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_observe() TO "postgres";

-- Captured pg_get_functiondef MD5 cc819d2476a0252326e7bdd4e72d468f
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_project(p_source text, p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE keys text[]; result jsonb;
BEGIN
 IF p_row IS NULL THEN RETURN NULL; END IF;
 keys:=CASE p_source
  WHEN 'union_clubs' THEN ARRAY['id','union_id','club_id','joined_at']
  WHEN 'tables' THEN ARRAY['id','club_id','union_id','tournament_id','is_private']
  WHEN 'table_seats' THEN ARRAY['id','table_id','user_id','club_id','occupancy_id','joined_at','left_at','stack']
  WHEN 'tournaments' THEN ARRAY['id','club_id','union_id','is_private','status','started_at','ended_at','prize_pool','bounty_pool','bounty_pool_paid']
  WHEN 'tournament_players' THEN ARRAY['id','tournament_id','user_id','club_id','status','registered_at','eliminated_at','prize','bounty_winnings','source_satellite_id']
  ELSE NULL END;
 IF keys IS NULL OR NOT p_row ?& keys THEN RAISE EXCEPTION 'pnl_inventory_source_contract_changed:%',p_source USING ERRCODE='55000'; END IF;
 SELECT jsonb_object_agg(k,p_row->k) INTO result FROM unnest(keys) k;
 RETURN result;
END $function$;
ALTER FUNCTION public.fn_union_pnl_inventory_project(text,jsonb) OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_union_pnl_inventory_project(text,jsonb)') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_project(text,jsonb) FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_inventory_project(text,jsonb) TO "postgres";

-- Captured pg_get_functiondef MD5 9a6559774cc1ed4ed49b315a3428abdb
CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_frame()
 RETURNS union_pnl_transaction_frames
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE frame public.union_pnl_transaction_frames; observed timestamptz; book timestamptz;
BEGIN
 SELECT * INTO frame FROM public.union_pnl_transaction_frames WHERE transaction_id=pg_current_xact_id();
 IF FOUND THEN RETURN frame; END IF;
 observed:=clock_timestamp(); book:=public.fn_union_week_start(observed);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
 observed:=clock_timestamp();
 IF public.fn_union_week_start(observed)<>book THEN
  book:=public.fn_union_week_start(observed);
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  observed:=clock_timestamp();
  IF public.fn_union_week_start(observed)<>book THEN RAISE EXCEPTION 'pnl_frame_clock_crossed_twice' USING ERRCODE='40001'; END IF;
 END IF;
 INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),observed,book) RETURNING * INTO frame;
 RETURN frame;
END $function$;
ALTER FUNCTION public.fn_union_pnl_original_frame() OWNER TO "postgres";
DO $acl$ DECLARE r text; BEGIN FOR r IN SELECT DISTINCT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END FROM pg_proc c CROSS JOIN LATERAL aclexplode(COALESCE(c.proacl,acldefault('f',c.proowner))) x WHERE c.oid=to_regprocedure('public.fn_union_pnl_original_frame()') LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.fn_union_pnl_original_frame() FROM '||CASE WHEN r='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_original_frame() TO "postgres";
INSERT INTO public.ca_mtt_admission_contract SELECT * FROM jsonb_populate_recordset(NULL::public.ca_mtt_admission_contract,$capture$[{"abi":"legacy-capacity-v1","singleton":true}]$capture$::jsonb);
CREATE TRIGGER accounting_cash_batch_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_accrual_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_batch_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_accrual_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_source_no_truncate BEFORE TRUNCATE ON public.accounting_cash_rake_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_cash_commission_source_guard BEFORE INSERT ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_commission_source_guard();
CREATE TRIGGER accounting_tournament_commission_source_guard BEFORE INSERT ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_commission_source_guard();
CREATE TRIGGER zz_guard_agent_agreement BEFORE INSERT OR UPDATE OF id, user_id, club_id, parent_agent_id, role, commission_rate, player_rakeback_rate, credit_limit ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_guard_agent_agreement();
CREATE TRIGGER zzzz_credit_control_revision_v1 BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_agent_credit_control_revision_v1();
CREATE TRIGGER ca_mtt_admission_contract_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.ca_mtt_admission_contract FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract();
CREATE TRIGGER ca_mtt_admission_contract_no_truncate BEFORE TRUNCATE ON public.ca_mtt_admission_contract FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract();
CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable();
CREATE TRIGGER original_union_pnl_flow AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_capture_original_flow();
CREATE TRIGGER zz_tournament_accounting_credit_ledger AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_capture_tournament_credit_ledger();
CREATE TRIGGER accounting_cash_source_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_source_immutable();
CREATE CONSTRAINT TRIGGER accounting_tournament_fee_commit_capture AFTER INSERT ON public.rake_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.is_tournament IS TRUE) AND (new.rake_amount > (0)::numeric))) EXECUTE FUNCTION fn_accounting_tournament_fee_commit_capture();
CREATE TRIGGER accounting_tournament_fee_source_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_source_immutable();
CREATE TRIGGER accounting_tournament_recognized_evidence_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.table_seats FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tables FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER a0_tournaments_dual_entry_capacity BEFORE INSERT OR UPDATE OF max_players, tournament_type, variant, satellite_target_id, satellite_target ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_normalize_new_mtt_capacity();
CREATE TRIGGER a1_tournaments_restart_source BEFORE INSERT OR DELETE OR UPDATE OF restart_source_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_restart_source();
CREATE TRIGGER a2_tournaments_new_satellite_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type, club_id, union_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_new_satellite_target();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON tournaments FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER zzzzzzz_tournaments_record_format BEFORE INSERT OR UPDATE OF format_contract, tournament_type, variant, max_players, min_players, table_size, satellite_target_id, satellite_target, club_id, union_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_format();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.union_clubs FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER original_pnl_inventory_events_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_inventory_events FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_original_flows FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_transaction_frames FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable();
CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE DELETE OR UPDATE ON public.union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable();
DO $verify$ DECLARE expected jsonb;actual jsonb;name text;has_rows boolean;BEGIN
FOR expected IN SELECT value FROM jsonb_array_elements($capture$[{"signature":"enforce_chip_ledger_performed_by()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"ce4ab3013be283d66ab9afd1e861b552","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_accounting_agent_terms_at(uuid,uuid,timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"eefa92172db730cfc9c739800d3bc12a","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_accounting_agreement_capture()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"746fab25cd56f6ad761325e7c0d525d5","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_agreement_history_immutable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3fa4099435ff1e9d5c48fa1934b63549","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_accounting_cash_commission_source_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"64cada14be0804682ca22bf136dd01c0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_cash_source_immutable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0d79f2823f390072ddab8abfa8a5263f","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_earning_contract(uuid,uuid,numeric,uuid,timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"df9bfbca2abf9f596921ad60363abafe","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_accounting_terms_at(text,text,timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"d262f82e6e75fc3e6830f75972e4b823","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_commission_source_guard()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"7bfe57c82e08e6a939a16c0c27c7a28d","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_fee_commit_capture()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"afae8152bd03fdb018b4a0d21f4b8f58","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_fee_receipt_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"bdc4ee4b75e3471cd33a5ed4b250ec0f","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_fee_source_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"709027685f4ff30a06b36e8fb65618cb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_recognized_evidence_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"a5a71f9b0ba989721663a85cbb407ea9","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_accounting_transfer_document_on_insert()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"164aae2fca35c964331ed8aecd225411","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_admin_holds_no_player_wallet()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3c54c86c548917606c846febfadf704b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_agent_credit_control_revision_v1()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog"],"full_md5":"5ec011a69c2c9e9bc5c2da28f226ba25","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_agents_staff_earn_no_rakeback()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"17346b77ec8f5a1d6d42dca3eb06e061","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_audit_club_entry_mutation()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"d26149a3b10aa00618a98f5076ebf079","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_audit_club_member_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"06515aa426034c1174450e2dc37204ef","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_award_vip_points_from_rake()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"24028ae5df74069cadea2df80124569a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_block_browser_balance_inserts()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"88e61c03b82bedcdc67113f795355d4a","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_block_browser_balance_writes()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"c7390598f411e7d6bc4b8daf00e12c6e","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_ca_attested_day_is_restated()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public","TimeZone=UTC"],"full_md5":"268e0f244b2df7f88b933530b1cad822","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_autoledger()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2ff8923b4c2d8fd3d343cf37acce0f2c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_autoledger_delete()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"c6d7e02df8b654fbccc3e8844418bd01","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_capture_tournament_charge_entitlement()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"9ec1394628e0c6291963d5f76801a3d1","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_capture_tournament_credit_ledger()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"81b1abbedb544e2fca0f8edec7d27cae","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_chip_ledger_enrich()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"5931f47d922eea26ab1ea2b12f3f7c8c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_chip_store_declared()","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d5b08956826e56a0d414db4bfd022d3b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_overlay_leg()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"1b916fb576271d94c481099c11ca8b93","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_rake_record()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0dc096bb5615758ed945365a45997c8c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_reserve_leg()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0d7f735d58aadeb6fe03e9daf5e21a92","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_escrow_on_seat_transfer_leg()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e9c56f9c21635b21c7cf0d456eb18b8a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_fund_overlay_on_lock()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"93f3e46a957abb7a42d4a2cfaff42fcb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_guard_mtt_admission_contract()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"fcc387285004f30705c61e91f315d523","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_guard_new_satellite_target()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"69247df72bfb68c7148c1a7f9ea4cfd7","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_guard_tournament_format()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"ff6655365bfdd99ae31dc897568f31e7","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_guard_tournament_restart_source()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"afe57e7d2b37feba95af19b41f9f2df5","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_is_new_mtt(jsonb)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"dff4202458ea4b5b940e78050e6de91c","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_ca_issuance_leg_is_registered()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"7a41ac630bad489e02f05f47ff5ffa1e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_journal_append_only()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"ac9d66e60d077d886981c428c71e5c3c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_legacy_tournament_format(jsonb)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"a83410b4370de8d24e561709dd800ccd","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_ca_lock_mtt_admission_contract()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"10644d522bb50245f76942ecce735cbc","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"2d8c9bd676a8ee02e009dd470fbfd585","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_new_tournament_is_unlimited(jsonb)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"34b80f98d9d110072ae6951bb4377ee0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_normalize_new_mtt_capacity()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"06cbd73a8011fac92e0c51b8d752b3da","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_reject_automated_user_club_row()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"7c73094df30c90f94a78cbbd5d24f504","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_tournament_format_identity(jsonb)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"49173db4a4cb01024d37e292d9471795","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_ca_tournament_recorded_format(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"a7357dd1366f930eba6cd7f404090bbd","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_ca_tournament_recorded_seat_first(uuid,boolean)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"],"full_md5":"00e225cc67cf595af35831e981106d93","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_ca_tournament_seat_cap(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"557b6fd0f941fd7ee803f408580224db","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_ca_unregistration_rake_evidence_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"4d035b0d2f169db1cdbe987078448e99","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_caller_session_is_live()","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=pg_catalog, public, auth"],"full_md5":"23ffeea99f9d9e76102ecbf6185222c0","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_cancelled_tournament_evidence_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"55061034adb7416d401622572397c7d2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_cancelled_tournament_parent_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"45afe1986ef3e5a382aab017dcf3689c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_capture_accounting_tournament_fee(uuid,jsonb)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"e83638c8e5401469c336fe378505fbac","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_capture_managed_game_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp"],"full_md5":"28e259c9fd0c76f39c5ca5b5f0328777","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_clear_seats_on_game_end()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"9660c076fa2d1739a01ed360933f3c26","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"162eba07a4e75f16ae21e5ca809ee595","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_member_notes_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"cc7bae672aea44a800052d2aba490360","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_bot_follows_horse()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"02033ded814911b9a5a74ecf91dfa2e9","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_ledger_writer()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e7cae5f2fc19ef0d2c47e528764abd5a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_no_agent_cycle()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"a7ad3c53fcab80a15831e71544b53c56","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_club_members_role_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2374cfedbbe89d3a69c75cdfdb240fe6","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_club_members_staff_earn_no_rakeback()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"09ae811a57faa517720d493d89262f31","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_create_seat_first_game_atomic(uuid,jsonb)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=30s"],"full_md5":"0669e34f1376e42d734f7632ea35eb6a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_deep_stack_society_cannot_be_deleted_by_accident()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"213a7fa40330c703cb23dc001a99d31e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_emit_managed_game_row_event()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"9706ead97b5e6f495957bfd02a6eb282","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_emit_management_access_event()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"9963925e6cd6da557b9de6f1749db0fd","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_agent_commission_bounds()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3e4f5df422b121391cc40f711ae5b5ee","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_club_enters_union_empty()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"23c5f3b77830234a6c0181474fe8caee","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_four_club_limit()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"4c27b1c5f7b438dfa569699d19f2200a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_tournament_union_ownership_update()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"5c7ea135e9566b108e96ed3af5a9f5d2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_enforce_whole_dollar_buyin()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"652e99519fb365b9ed5fb23e70519e49","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_freerolls_are_free_buy()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b4cd5955cb813a63b6364b9b9f1de844","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_agent_agreement()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"0603b05f5046cbaa057228acd3a5c331","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_managed_game_delete()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"bef4392e9fa3124cecaaf74a739e465b","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_guard_managed_game_lifecycle()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e4e6dbe534f8ed1fc7fa03fcad968114","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_guard_membership_lifecycle_write()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"bb2eca3ab004597dbd9137f78951e943","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_new_mtt_blind_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"aac67e5c89eaa564744a97a85b5f3fbb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_rake_belongs_to_club()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"04f17832e28e53b2ca5b33eb3b8e0982","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_guard_registered_tournament_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"8c110d7334b93cc527b6d4dfe8bb5fcb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_retired_club_mutation()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"b82be212e7ccf2a15637c231861ff993","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_completed_certificate()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"8a05956d1fd25d649f1f80b133ed3ed0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_completing_claim()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"311ed77e7726f0c7515859a9140d526c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_mystery_creation_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"07d896448e45728a89fc46eafc2a0eeb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_prize_math_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"9db38ea56f880456fdbbc29394c4cb27","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_publish_readiness()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"0aa1e473750e160884700c441d3953e2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_guard_tournament_start_readiness()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"f2ee43657b769c37527ae2974101bb06","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_membership_approval_gate()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b5edea413fa87af75f47b925a23b1d10","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_membership_starts_with_zero_chips()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e865fa31892646611ec011821a9fd219","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_non_satellite_completed_requires_terminal_receipt()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"f2da9a0bcf45eec68489fe51fd6f224b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_poker_guard_arena_structure()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"f17675dd0b647abda7b0b9d8772c9c0e","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_poker_reject_diamond_hierarchy()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"49037a2bf4322d2a327bc9141a7a7a89","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_post_accounting_commission_source(uuid,text,timestamp with time zone,jsonb)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"b647df60b45c25183638f4cdbaec57fd","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_receipt_mystery_activation()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"222c1ea113b7df08cdfad43078022074","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_receipted_tournament_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"961aa627ed8cb88d11b4750ef3464be5","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_recompute_club_level_on_member_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0a761d5d6027c26ddbe4a7760d23d434","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_recompute_union_level_on_club_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"102d867367cdc4e88cba99ecc53763c9","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_refuse_completed_with_pending_bounties()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"36b386279189cbd1e5a5a9541ba3ec94","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_refuse_mystery_activation_with_pending_heads()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"b9be582a1a903cf71e2e32795dd1527e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_refuse_new_entries_while_frozen()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"0af4299f549c144ce93b2f37914f6b4e","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_refuse_while_frozen()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"3a866372172806a8a69cc3d37413f0cc","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_release_seats_on_tournament_finish()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"7e9ab84b48a96dda6029414f889ab39f","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_require_explicit_club_membership_source()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3c4e9aa515a8b8c8226fdf18332156a3","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_retire_manager_wakes_after_terminal_status()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"2fa4c2d4bb63ece41ed78c3f11cd770c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_feeds_only_a_deliverable_target()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"4251f65adfd51a29967a346af7ae98f1","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_target_contract_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"68f353273fb27d0eee5021481192e902","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_target_rake_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"42499ae4d7edff6b56e2211a9149a64a","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_satellite_transfer_ledger_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"b2affe52c4e95101c985c30c483d5127","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_seat_change_syncs_seat_first_count()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"3d222458b40d5aec09f8f1e88bf60d53","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_short_formats_never_break()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"fb3adc8a9ea6346e34fee79945f9046a","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_spin_book_entry(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"3e861cfde0bda50d16bc836a665bf4ab","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_spin_ladder_is_the_drawn_one()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2a2786ee7663657383c4930c90842051","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_spin_rake_rate(numeric)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"dad580a8513512273e6109b4fea19edd","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_spin_reserve_pool(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d3596faa39ba012e437d769386f8a057","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_spin_tournament_contract_is_draw()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"747fc99476b082256141d42003a6c478","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_stamp_accounting_tournament_fee(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"7e7495ff6800996d72b5ab27008a33a6","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_stamp_tournament_terminal_evidence_markers()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"eeec4e4610901fe4b44b0b8f270d1ef7","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_stamp_tournament_union_ownership()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"feb3b58d1e4af815e6d499d8ed8d6c6c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_agent_player_counts()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"76a5848cfdb6c1674b48cb62ae1f22dd","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_club_member_count()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"2abaebf91e89f56487f01b25d7e3ac98","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_club_union_mirror()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"119b0030a566ae5701cdecfa81aee13e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_mfa_required_on_club_role()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"b09cbcddc87075221d72aee3899e97b4","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_sync_seat_first_player_count(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"0e4acaf0ff080d4dafd1aa85068cf0b2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_sync_union_membership_table_counts()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d0f49fa15340884a978759cfaf54ab88","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_take_seat_and_buy_in(uuid,integer)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp","statement_timeout=30s"],"full_md5":"a965493d4837187d433b3cdd40c5da81","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, extensions"],"full_md5":"67a6b85f00a785e22c4d89c6168253d3","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_terminal_tournament_evidence_is_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"a129e4214f59e7f95ffe397e2245bbd0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_tournament_fee_names_its_player()","owner":"postgres","acl":"{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"a34e26b81ceeda38237b739245ff11f6","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_tournaments_creation_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"f5dcb63005864b24bf422c6628cb169e","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_tournaments_refuse_unbuilt_multi_day()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"c52fa39e800b18f319a8171cb52ab637","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_union_pnl_capture_original_flow()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"df060874f0ffaf8105cce1d3bdaed35b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_union_pnl_inventory_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"307d83a1ee3d912bade24c48144aa801","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_union_pnl_inventory_observe()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"11c7c788d943a11375a15819e78873ba","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_union_pnl_inventory_project(text,jsonb)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"cc819d2476a0252326e7bdd4e72d468f","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_union_pnl_original_frame()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"9a6559774cc1ed4ed49b315a3428abdb","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_union_week_start(timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"103f192a228084dad0e4268c36c82c4b","volatility":"i","security_definer":false,"kind":"f"},{"signature":"guard_agent_wallet_direct_update()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"736aa9e92265453c3015223562108141","volatility":"v","security_definer":false,"kind":"f"},{"signature":"lock_club_cashier_hierarchy_mutation()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"2bf2e0dc1876c5b1238603fc18558907","volatility":"v","security_definer":false,"kind":"f"},{"signature":"sync_agent_wallet_columns()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"3a3d351dd05b5dc13b525b7eb4635e5c","volatility":"v","security_definer":false,"kind":"f"},{"signature":"trg_agent_commission_rollup_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"4ec76190867a2fe990abddeb01b8cad5","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_agent_commission_rollup_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"50cb43eb54b7924b39c25b9816f450a0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_atomic_final_table_deal_completion_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"38bf96ba348994fd40264584c26107d8","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_auto_recompute_club_level()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"91f239bc0f5b75e5147ef6bd19ff761b","volatility":"v","security_definer":false,"kind":"f"},{"signature":"trg_ca_club_rake_daily_change()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0eff9721f6fb1f9d0295184eaafab2f2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_ca_club_rake_daily_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"4bb7c4d64021796803829faacbcddbb0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_ca_reporting_rake_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"77a5bc5c710f2dbc04b547cab55672a0","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_ca_reporting_repair_changed_days()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"601c605e44856e42ee0d00e72a0fdb1e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_capture_satellite_economics_on_start()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"9a39bb425387ade0232c76f78267d598","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_freeze_finalized_tournament_prize_pool()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"d58236d778465cfd5f4c1e25933f77f4","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_freeze_registered_tournament_settlement_contract()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"caf4aedb5da06e764930e61d9ed7158e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_guard_atomic_satellite_completion()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"8ac917a51ecde732a1f9c27527c87219","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_lock_atomic_final_table_deal_status()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b16256830158e669defcff8751cb5be7","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_lock_atomic_place_tournament_status()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"0923d477f8cbb2c11eaa7c6acf0f8f5d","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_lock_tournament_start_time_during_launch()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"41d41eef67325a9e463043269d19b9bf","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_refuse_normal_tournament_completed_insert()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"b1ed0b6d633f570d0c5038edce75b62c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_spin_completed_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"47439a8a8cde90ed307f9f79f4eb3a95","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournament_atomic_place_completion_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"18cf8159e315f322ac7cc09e1f913671","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournament_completed_stats()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"074f801970b6e6e90c2370a63816ba28","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournament_pool_finalization_window_guard()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"6ba00817ea7d386e3c1d37212b9c9866","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournaments_cancel_must_refund()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"a4643c9ed980e3008369884e3ac2a96c","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournaments_guarantee_affordable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"91f977eaec85de7f6b478d37184e9732","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_tournaments_rank_before_complete()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"89f80b8b181cf7717fcdee2a94d161ed","volatility":"v","security_definer":true,"kind":"f"},{"signature":"trg_union_rake_weekly()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"e3dacea902d1b1e3053326c07ec90b56","volatility":"v","security_definer":true,"kind":"f"},{"signature":"update_updated_at_column()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"54801f8bc343c4928383a3e7a1d57d61","volatility":"v","security_definer":false,"kind":"f"},{"signature":"zz_chip_ledger_key_is_claimed_once()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"57a2b2eb1bc5b1c5ac36394c2ac23bcd","volatility":"v","security_definer":true,"kind":"f"}]$capture$::jsonb) LOOP
SELECT jsonb_build_object('signature',expected->>'signature','owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',to_jsonb(p.proconfig),'full_md5',md5(pg_get_functiondef(p.oid)),'volatility',p.provolatile,'security_definer',p.prosecdef,'kind',p.prokind) INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(expected->>'signature'));
IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'positive-fee function readback differs: %',expected->>'signature' USING ERRCODE='55000'; END IF; END LOOP;
FOR expected IN SELECT value FROM jsonb_array_elements($capture$[{"name":"accounting_agreement_history","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"force_rls":false,"columns":[{"name":"id","type":"bigint","not_null":true,"identity":"a","generated":"","acl":null,"default":null,"owned_sequence":"public.accounting_agreement_history_id_seq","sequence":{"owner":"postgres","acl":"{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}","type":"bigint","start":"1","increment":"1","max":"9223372036854775807","min":"1","cache":"1","cycle":false}},{"name":"entity_type","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"entity_key","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"club_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"subject_user_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"event_type","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"observed_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"clock_timestamp()","owned_sequence":null,"sequence":null},{"name":"transaction_id","type":"bigint","not_null":true,"identity":"","generated":"","acl":null,"default":"txid_current()","owned_sequence":null,"sequence":null},{"name":"actor_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"before_terms","type":"jsonb","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"after_terms","type":"jsonb","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"union_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null}],"constraints":[{"name":"accounting_agreement_history_check","type":"c","definition":"CHECK (((before_terms IS NOT NULL) OR (after_terms IS NOT NULL)))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_agreement_history_entity_type_check","type":"c","definition":"CHECK ((entity_type = ANY (ARRAY['agents'::text, 'club_members'::text, 'union_clubs'::text, 'unions'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_agreement_history_event_type_check","type":"c","definition":"CHECK ((event_type = ANY (ARRAY['baseline'::text, 'INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_agreement_history_pkey","type":"p","definition":"PRIMARY KEY (id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_agreement_history_scope_check","type":"c","definition":"CHECK ((((entity_type = 'unions'::text) AND (union_id IS NOT NULL) AND (club_id IS NULL) AND (subject_user_id IS NULL) AND (entity_key = (union_id)::text)) OR ((entity_type <> 'unions'::text) AND (club_id IS NOT NULL) AND (union_id IS NULL))))","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"accounting_agreement_history_club_time","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX accounting_agreement_history_club_time ON public.accounting_agreement_history USING btree (club_id, observed_at, id)","nulls_not_distinct":false},{"live":true,"name":"accounting_agreement_history_entity_time","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX accounting_agreement_history_entity_time ON public.accounting_agreement_history USING btree (entity_type, entity_key, observed_at, id)","nulls_not_distinct":false},{"live":true,"name":"accounting_agreement_history_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX accounting_agreement_history_pkey ON public.accounting_agreement_history USING btree (id)","nulls_not_distinct":false},{"live":true,"name":"accounting_agreement_history_union_time","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX accounting_agreement_history_union_time ON public.accounting_agreement_history USING btree (union_id, observed_at, id) WHERE (entity_type = 'unions'::text)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"accounting_agreement_history_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_immutable BEFORE DELETE OR UPDATE ON public.accounting_agreement_history FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"},{"name":"accounting_agreement_history_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_no_truncate BEFORE TRUNCATE ON public.accounting_agreement_history FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"}]},{"name":"accounting_cash_accrual_batches","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"force_rls":false,"columns":[{"name":"rake_record_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"hand_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"earned_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"source_fingerprint","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"status","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"plan","type":"jsonb","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"recorded_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"clock_timestamp()","owned_sequence":null,"sequence":null}],"constraints":[{"name":"accounting_cash_accrual_batches_check","type":"c","definition":"CHECK (((status = 'accrued'::text) = (plan IS NOT NULL)))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_accrual_batches_hand_id_key","type":"u","definition":"UNIQUE (hand_id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_accrual_batches_pkey","type":"p","definition":"PRIMARY KEY (rake_record_id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_accrual_batches_rake_record_id_fkey","type":"f","definition":"FOREIGN KEY (rake_record_id) REFERENCES rake_records(id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_accrual_batches_status_check","type":"c","definition":"CHECK ((status = ANY (ARRAY['accrued'::text, 'legacy_unverified'::text])))","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"accounting_cash_accrual_batches_earned","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX accounting_cash_accrual_batches_earned ON public.accounting_cash_accrual_batches USING btree (earned_at, status)","nulls_not_distinct":false},{"live":true,"name":"accounting_cash_accrual_batches_hand_id_key","ready":true,"valid":true,"unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX accounting_cash_accrual_batches_hand_id_key ON public.accounting_cash_accrual_batches USING btree (hand_id)","nulls_not_distinct":false},{"live":true,"name":"accounting_cash_accrual_batches_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX accounting_cash_accrual_batches_pkey ON public.accounting_cash_accrual_batches USING btree (rake_record_id)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"accounting_cash_batch_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_cash_batch_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_accrual_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"},{"name":"accounting_cash_batch_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_cash_batch_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"}]},{"name":"accounting_cash_accrual_cutover","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"force_rls":false,"columns":[{"name":"singleton","type":"boolean","not_null":true,"identity":"","generated":"","acl":null,"default":"true","owned_sequence":null,"sequence":null},{"name":"starts_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"clock_timestamp()","owned_sequence":null,"sequence":null}],"constraints":[{"name":"accounting_cash_accrual_cutover_pkey","type":"p","definition":"PRIMARY KEY (singleton)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_accrual_cutover_singleton_check","type":"c","definition":"CHECK (singleton)","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"accounting_cash_accrual_cutover_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX accounting_cash_accrual_cutover_pkey ON public.accounting_cash_accrual_cutover USING btree (singleton)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"accounting_cash_cutover_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_cash_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_accrual_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"},{"name":"accounting_cash_cutover_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_cash_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"}]},{"name":"accounting_cash_rake_sources","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"force_rls":false,"columns":[{"name":"id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":"gen_random_uuid()","owned_sequence":null,"sequence":null},{"name":"rake_record_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"player_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"club_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"union_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"coordinator_union_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"earned_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"rake_credit","type":"numeric","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"contract","type":"jsonb","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"recorded_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"clock_timestamp()","owned_sequence":null,"sequence":null}],"constraints":[{"name":"accounting_cash_rake_sources_club_id_fkey","type":"f","definition":"FOREIGN KEY (club_id) REFERENCES clubs(id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_rake_sources_pkey","type":"p","definition":"PRIMARY KEY (id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_rake_sources_player_id_fkey","type":"f","definition":"FOREIGN KEY (player_id) REFERENCES auth.users(id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_rake_sources_rake_credit_check","type":"c","definition":"CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_rake_sources_rake_record_id_fkey","type":"f","definition":"FOREIGN KEY (rake_record_id) REFERENCES accounting_cash_accrual_batches(rake_record_id)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_cash_rake_sources_rake_record_id_player_id_key","type":"u","definition":"UNIQUE (rake_record_id, player_id)","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"accounting_cash_rake_sources_bank_period","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX accounting_cash_rake_sources_bank_period ON public.accounting_cash_rake_sources USING btree (union_id, earned_at) WHERE (union_id IS NOT NULL)","nulls_not_distinct":false},{"live":true,"name":"accounting_cash_rake_sources_coordinator_period","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX accounting_cash_rake_sources_coordinator_period ON public.accounting_cash_rake_sources USING btree (coordinator_union_id, earned_at, club_id)","nulls_not_distinct":false},{"live":true,"name":"accounting_cash_rake_sources_period","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX accounting_cash_rake_sources_period ON public.accounting_cash_rake_sources USING btree (club_id, earned_at, player_id)","nulls_not_distinct":false},{"live":true,"name":"accounting_cash_rake_sources_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX accounting_cash_rake_sources_pkey ON public.accounting_cash_rake_sources USING btree (id)","nulls_not_distinct":false},{"live":true,"name":"accounting_cash_rake_sources_rake_record_id_player_id_key","ready":true,"valid":true,"unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX accounting_cash_rake_sources_rake_record_id_player_id_key ON public.accounting_cash_rake_sources USING btree (rake_record_id, player_id)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"accounting_cash_source_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_cash_source_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"},{"name":"accounting_cash_source_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_cash_source_no_truncate BEFORE TRUNCATE ON public.accounting_cash_rake_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_history_immutable()"}]},{"name":"accounting_tournament_fee_cutover","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"force_rls":false,"columns":[{"name":"singleton","type":"boolean","not_null":true,"identity":"","generated":"","acl":null,"default":"true","owned_sequence":null,"sequence":null},{"name":"starts_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null}],"constraints":[{"name":"accounting_tournament_fee_cutover_pkey","type":"p","definition":"PRIMARY KEY (singleton)","validated":true,"deferrable":false,"deferred":false},{"name":"accounting_tournament_fee_cutover_singleton_check","type":"c","definition":"CHECK (singleton)","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"accounting_tournament_fee_cutover_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX accounting_tournament_fee_cutover_pkey ON public.accounting_tournament_fee_cutover USING btree (singleton)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"accounting_tournament_fee_cutover_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_tournament_fee_receipt_immutable()"},{"name":"accounting_tournament_fee_cutover_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","deferrable":false,"deferred":false,"handler":"fn_accounting_tournament_fee_receipt_immutable()"}]},{"name":"agents","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,anon=xtm/postgres,authenticated=rxtm/postgres,service_role=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":"gen_random_uuid()","owned_sequence":null,"sequence":null},{"name":"user_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"club_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"membership_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"role","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"status","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":"'active'::text","owned_sequence":null,"sequence":null},{"name":"parent_agent_id","type":"uuid","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"commission_rate","type":"numeric(5,4)","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"player_rakeback_rate","type":"numeric(5,4)","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"credit_limit","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"credit_used","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"is_prepaid","type":"boolean","not_null":true,"identity":"","generated":"","acl":null,"default":"false","owned_sequence":null,"sequence":null},{"name":"business_balance","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"player_balance","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"promo_balance","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"total_players","type":"integer","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"active_player_count","type":"integer","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"sub_agent_count","type":"integer","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"weekly_rake_generated","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"lifetime_earnings","type":"numeric(15,2)","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"joined_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null},{"name":"last_active_at","type":"timestamp with time zone","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"created_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null},{"name":"updated_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null},{"name":"auto_rakeback_enabled","type":"boolean","not_null":false,"identity":"","generated":"","acl":null,"default":"true","owned_sequence":null,"sequence":null},{"name":"rakeback_percentage","type":"numeric(5,4)","not_null":false,"identity":"","generated":"","acl":null,"default":"0.0000","owned_sequence":null,"sequence":null},{"name":"agent_wallet_balance","type":"numeric(18,2)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"player_wallet_balance","type":"numeric(18,4)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"promo_wallet_balance","type":"numeric(18,2)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"lifetime_rake_generated","type":"numeric(18,4)","not_null":false,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null},{"name":"credit_control_revision","type":"bigint","not_null":true,"identity":"","generated":"","acl":null,"default":"0","owned_sequence":null,"sequence":null}],"constraints":[{"name":"agents_agent_wallet_balance_nonneg","type":"c","definition":"CHECK ((agent_wallet_balance >= (0)::numeric))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_club_id_fkey","type":"f","definition":"FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE","validated":true,"deferrable":false,"deferred":false},{"name":"agents_club_id_user_id_key","type":"u","definition":"UNIQUE (club_id, user_id)","validated":true,"deferrable":false,"deferred":false},{"name":"agents_commission_rate_check","type":"c","definition":"CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= 0.70)))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_credit_control_revision_nonnegative","type":"c","definition":"CHECK ((credit_control_revision >= 0))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_credit_used_check","type":"c","definition":"CHECK ((credit_used >= (0)::numeric))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_parent_in_same_club","type":"f","definition":"FOREIGN KEY (club_id, parent_agent_id) REFERENCES agents(club_id, id)","validated":true,"deferrable":false,"deferred":false},{"name":"agents_pkey","type":"p","definition":"PRIMARY KEY (id)","validated":true,"deferrable":false,"deferred":false},{"name":"agents_player_rakeback_rate_check","type":"c","definition":"CHECK (((player_rakeback_rate >= (0)::numeric) AND (player_rakeback_rate <= 0.50)))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_promo_wallet_balance_nonneg","type":"c","definition":"CHECK ((promo_wallet_balance >= (0)::numeric))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_role_check","type":"c","definition":"CHECK ((role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"agents_status_check","type":"c","definition":"CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"check_credit","type":"c","definition":"CHECK (((credit_used <= credit_limit) OR (is_prepaid = true)))","validated":true,"deferrable":false,"deferred":false},{"name":"chk_player_wallet_balance_is_two_decimal_places","type":"c","definition":"CHECK (((player_wallet_balance IS NULL) OR (player_wallet_balance = round(player_wallet_balance, 2))))","validated":true,"deferrable":false,"deferred":false},{"name":"fk_agents_parent","type":"f","definition":"FOREIGN KEY (parent_agent_id) REFERENCES agents(id)","validated":true,"deferrable":false,"deferred":false},{"name":"fk_agents_user_id_profiles","type":"f","definition":"FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"agents_agreement_club_and_id","ready":true,"valid":true,"unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX agents_agreement_club_and_id ON public.agents USING btree (club_id, id)","nulls_not_distinct":false},{"live":true,"name":"agents_club_id_user_id_key","ready":true,"valid":true,"unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX agents_club_id_user_id_key ON public.agents USING btree (club_id, user_id)","nulls_not_distinct":false},{"live":true,"name":"agents_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id)","nulls_not_distinct":false},{"live":true,"name":"idx_agents_club","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_agents_club ON public.agents USING btree (club_id)","nulls_not_distinct":false},{"live":true,"name":"idx_agents_parent","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_agents_parent ON public.agents USING btree (parent_agent_id)","nulls_not_distinct":false},{"live":true,"name":"idx_agents_user","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX idx_agents_user ON public.agents USING btree (user_id)","nulls_not_distinct":false}],"policies":[{"name":"agents_cashier_scoped_read","check":null,"roles":["authenticated"],"using":"((user_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'all'::text) OR ((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'downline'::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id)))","command":"r","permissive":true},{"name":"agents_svc","check":null,"roles":["service_role"],"using":"true","command":"*","permissive":true},{"name":"union_overseer_read","check":null,"roles":["authenticated"],"using":"(( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid)))","command":"r","permissive":true}],"triggers":[{"name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, user_id, parent_agent_id, role, status, commission_rate, player_rakeback_rate, is_prepaid ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()","deferrable":false,"deferred":false,"handler":"fn_accounting_agreement_capture()"},{"name":"guard_agent_wallet_direct_update","enabled":"O","definition":"CREATE TRIGGER guard_agent_wallet_direct_update BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION guard_agent_wallet_direct_update()","deferrable":false,"deferred":false,"handler":"guard_agent_wallet_direct_update()"},{"name":"poker_arena_no_hierarchy","enabled":"O","definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()","deferrable":false,"deferred":false,"handler":"fn_poker_reject_diamond_hierarchy()"},{"name":"trg_agents_commission_bounds","enabled":"O","definition":"CREATE TRIGGER trg_agents_commission_bounds BEFORE INSERT OR UPDATE OF commission_rate ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_enforce_agent_commission_bounds()","deferrable":false,"deferred":false,"handler":"fn_enforce_agent_commission_bounds()"},{"name":"trg_agents_human_user_club_only","enabled":"O","definition":"CREATE TRIGGER trg_agents_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()","deferrable":false,"deferred":false,"handler":"fn_ca_reject_automated_user_club_row()"},{"name":"trg_agents_staff_earn_no_rakeback","enabled":"O","definition":"CREATE TRIGGER trg_agents_staff_earn_no_rakeback BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate ON public.agents FOR EACH ROW WHEN (((COALESCE(new.commission_rate, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.player_rakeback_rate, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_agents_staff_earn_no_rakeback()","deferrable":false,"deferred":false,"handler":"fn_agents_staff_earn_no_rakeback()"},{"name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","deferrable":false,"deferred":false,"handler":"fn_ca_autoledger()"},{"name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","deferrable":false,"deferred":false,"handler":"fn_ca_autoledger_delete()"},{"name":"trg_ca_autoledger_insert","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.agents FOR EACH ROW WHEN (((COALESCE(new.agent_wallet_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.promo_wallet_balance, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","deferrable":false,"deferred":false,"handler":"fn_ca_autoledger()"},{"name":"trg_deep_stack_agents_are_protected","enabled":"O","definition":"CREATE TRIGGER trg_deep_stack_agents_are_protected BEFORE DELETE ON public.agents FOR EACH ROW WHEN ((old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()","deferrable":false,"deferred":false,"handler":"fn_deep_stack_society_cannot_be_deleted_by_accident()"},{"name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","deferrable":false,"deferred":false,"handler":"fn_guard_retired_club_mutation()"},{"name":"trg_sync_agent_wallets","enabled":"O","definition":"CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION sync_agent_wallet_columns()","deferrable":false,"deferred":false,"handler":"sync_agent_wallet_columns()"},{"name":"zz_guard_agent_agreement","enabled":"O","definition":"CREATE TRIGGER zz_guard_agent_agreement BEFORE INSERT OR UPDATE OF id, user_id, club_id, parent_agent_id, role, commission_rate, player_rakeback_rate, credit_limit ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_guard_agent_agreement()","deferrable":false,"deferred":false,"handler":"fn_guard_agent_agreement()"},{"name":"zzzz_credit_control_revision_v1","enabled":"O","definition":"CREATE TRIGGER zzzz_credit_control_revision_v1 BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_agent_credit_control_revision_v1()","deferrable":false,"deferred":false,"handler":"fn_agent_credit_control_revision_v1()"}]},{"name":"ca_chip_store_coverage","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"store","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"treatment","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"counted_by","type":"text","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"notes","type":"text","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"added_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":"now()","owned_sequence":null,"sequence":null}],"constraints":[{"name":"ca_chip_store_coverage_pkey","type":"p","definition":"PRIMARY KEY (store)","validated":true,"deferrable":false,"deferred":false},{"name":"ca_chip_store_coverage_treatment_check","type":"c","definition":"CHECK ((treatment = ANY (ARRAY['counted'::text, 'noncirculating'::text, 'uncounted'::text])))","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"ca_chip_store_coverage_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX ca_chip_store_coverage_pkey ON public.ca_chip_store_coverage USING btree (store)","nulls_not_distinct":false}],"policies":[],"triggers":[]},{"name":"ca_mtt_admission_contract","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"singleton","type":"boolean","not_null":true,"identity":"","generated":"","acl":null,"default":"true","owned_sequence":null,"sequence":null},{"name":"abi","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null}],"constraints":[{"name":"ca_mtt_admission_contract_abi_check","type":"c","definition":"CHECK ((abi = ANY (ARRAY['legacy-capacity-v1'::text, 'unlimited-mtt-v2'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"ca_mtt_admission_contract_pkey","type":"p","definition":"PRIMARY KEY (singleton)","validated":true,"deferrable":false,"deferred":false},{"name":"ca_mtt_admission_contract_singleton_check","type":"c","definition":"CHECK (singleton)","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"ready":true,"valid":true,"definition":"CREATE UNIQUE INDEX ca_mtt_admission_contract_pkey ON public.ca_mtt_admission_contract USING btree (singleton)","name":"ca_mtt_admission_contract_pkey","unique":true,"primary":true,"nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"ca_mtt_admission_contract_immutable","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.ca_mtt_admission_contract FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","deferrable":false,"deferred":false,"handler":"fn_ca_guard_mtt_admission_contract()"},{"name":"ca_mtt_admission_contract_no_truncate","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_no_truncate BEFORE TRUNCATE ON public.ca_mtt_admission_contract FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","deferrable":false,"deferred":false,"handler":"fn_ca_guard_mtt_admission_contract()"}]},{"name":"union_pnl_inventory_events","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"event_id","type":"bigint","not_null":true,"identity":"a","generated":"","acl":null,"default":null,"owned_sequence":"public.union_pnl_inventory_events_event_id_seq","sequence":{"acl":"{postgres=rwU/postgres}","max":"9223372036854775807","min":"1","type":"bigint","cache":"1","cycle":false,"owner":"postgres","start":"1","increment":"1"}},{"name":"source_name","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"row_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"observed_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"transaction_id","type":"xid8","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"operation","type":"text","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"before_row","type":"jsonb","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"after_row","type":"jsonb","not_null":false,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null}],"constraints":[{"name":"union_pnl_inventory_events_check","type":"c","definition":"CHECK (((before_row IS NOT NULL) OR (after_row IS NOT NULL)))","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_inventory_events_check1","type":"c","definition":"CHECK ((((before_row IS NULL) OR ((jsonb_typeof(before_row) = 'object'::text) AND ((before_row ->> 'id'::text) = (row_id)::text))) IS TRUE))","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_inventory_events_check2","type":"c","definition":"CHECK ((((after_row IS NULL) OR ((jsonb_typeof(after_row) = 'object'::text) AND ((after_row ->> 'id'::text) = (row_id)::text))) IS TRUE))","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_inventory_events_check3","type":"c","definition":"CHECK ((((operation = ANY (ARRAY['baseline'::text, 'INSERT'::text])) AND (before_row IS NULL) AND (after_row IS NOT NULL)) OR ((operation = 'UPDATE'::text) AND (before_row IS NOT NULL) AND (after_row IS NOT NULL)) OR ((operation = 'DELETE'::text) AND (before_row IS NOT NULL) AND (after_row IS NULL))))","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_inventory_events_observed_at_check","type":"c","definition":"CHECK (isfinite(observed_at))","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_inventory_events_operation_check","type":"c","definition":"CHECK ((operation = ANY (ARRAY['baseline'::text, 'INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_inventory_events_pkey","type":"p","definition":"PRIMARY KEY (event_id)","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_inventory_events_source_name_check","type":"c","definition":"CHECK ((source_name = ANY (ARRAY['union_clubs'::text, 'tables'::text, 'table_seats'::text, 'tournaments'::text, 'tournament_players'::text])))","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"union_pnl_inventory_boundary","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX union_pnl_inventory_boundary ON public.union_pnl_inventory_events USING btree (observed_at, event_id)","nulls_not_distinct":false},{"live":true,"name":"union_pnl_inventory_events_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX union_pnl_inventory_events_pkey ON public.union_pnl_inventory_events USING btree (event_id)","nulls_not_distinct":false},{"live":true,"name":"union_pnl_inventory_identity","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX union_pnl_inventory_identity ON public.union_pnl_inventory_events USING btree (source_name, row_id, event_id DESC)","nulls_not_distinct":false},{"live":true,"name":"union_pnl_inventory_transaction","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX union_pnl_inventory_transaction ON public.union_pnl_inventory_events USING btree (transaction_id, source_name)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"original_pnl_inventory_events_immutable","enabled":"O","definition":"CREATE TRIGGER original_pnl_inventory_events_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_inventory_events FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable()","deferrable":false,"deferred":false,"handler":"fn_union_pnl_inventory_immutable()"}]},{"name":"union_pnl_original_flows","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"ledger_id","type":"uuid","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"transaction_id","type":"xid8","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"recognized_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"game_scope","type":"jsonb","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"ledger_snapshot","type":"jsonb","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null}],"constraints":[{"name":"union_pnl_original_flows_pkey","type":"p","definition":"PRIMARY KEY (ledger_id)","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_original_flows_transaction_id_fkey","type":"f","definition":"FOREIGN KEY (transaction_id) REFERENCES union_pnl_transaction_frames(transaction_id)","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"union_pnl_original_flows_expr_recognized_at_idx","ready":true,"valid":true,"unique":false,"primary":false,"definition":"CREATE INDEX union_pnl_original_flows_expr_recognized_at_idx ON public.union_pnl_original_flows USING btree (((game_scope ->> 'game_union_id'::text)), recognized_at)","nulls_not_distinct":false},{"live":true,"name":"union_pnl_original_flows_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX union_pnl_original_flows_pkey ON public.union_pnl_original_flows USING btree (ledger_id)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"original_pnl_immutable","enabled":"O","definition":"CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_original_flows FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable()","deferrable":false,"deferred":false,"handler":"fn_union_pnl_inventory_immutable()"}]},{"name":"union_pnl_transaction_frames","kind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres}","rls":true,"force_rls":false,"columns":[{"name":"transaction_id","type":"xid8","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"observed_at","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null},{"name":"book_start","type":"timestamp with time zone","not_null":true,"identity":"","generated":"","acl":null,"default":null,"owned_sequence":null,"sequence":null}],"constraints":[{"name":"union_pnl_transaction_frames_observed_at_check","type":"c","definition":"CHECK (isfinite(observed_at))","validated":true,"deferrable":false,"deferred":false},{"name":"union_pnl_transaction_frames_pkey","type":"p","definition":"PRIMARY KEY (transaction_id)","validated":true,"deferrable":false,"deferred":false}],"indexes":[{"live":true,"name":"union_pnl_transaction_frames_pkey","ready":true,"valid":true,"unique":true,"primary":true,"definition":"CREATE UNIQUE INDEX union_pnl_transaction_frames_pkey ON public.union_pnl_transaction_frames USING btree (transaction_id)","nulls_not_distinct":false}],"policies":[],"triggers":[{"name":"original_pnl_immutable","enabled":"O","definition":"CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_transaction_frames FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable()","deferrable":false,"deferred":false,"handler":"fn_union_pnl_inventory_immutable()"}]}]$capture$::jsonb) LOOP actual:=pg_temp.positive_fee_relation(expected->>'name'); IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'positive-fee relation readback differs: %',expected->>'name' USING ERRCODE='55000'; END IF; END LOOP;
SELECT COALESCE(jsonb_agg(jsonb_build_object('relation',r.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',CASE WHEN r.relname='tournaments' THEN pg_get_triggerdef(t.oid,true) ELSE pg_get_triggerdef(t.oid,false) END,'handler',t.tgfoid::regprocedure::text) ORDER BY r.relname,t.tgname),'[]'::jsonb) INTO actual FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace WHERE ns.nspname='public' AND NOT t.tgisinternal AND (r.relname IN ('accounting_agreement_history','accounting_cash_accrual_batches','accounting_cash_accrual_cutover','accounting_cash_rake_sources','accounting_tournament_fee_cutover','agent_commissions','agents','ca_mtt_admission_contract','chip_ledger','club_members','rake_records','tournaments','union_clubs','union_pnl_inventory_events','union_pnl_original_flows','union_pnl_transaction_frames','union_wallet_transactions') OR (r.relname IN ('tables','table_seats','tournaments','tournament_players') AND (t.tgname IN ('union_pnl_original_inventory','union_pnl_original_inventory_no_truncate') OR t.tgfoid=to_regprocedure('public.fn_union_pnl_inventory_observe()'))));
IF actual IS DISTINCT FROM $capture$[{"relation":"accounting_agreement_history","name":"accounting_agreement_history_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_immutable BEFORE DELETE OR UPDATE ON public.accounting_agreement_history FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_agreement_history","name":"accounting_agreement_history_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history_no_truncate BEFORE TRUNCATE ON public.accounting_agreement_history FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_cash_accrual_batches","name":"accounting_cash_batch_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_cash_batch_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_accrual_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_cash_accrual_batches","name":"accounting_cash_batch_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_cash_batch_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_cash_accrual_cutover","name":"accounting_cash_cutover_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_cash_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_accrual_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_cash_accrual_cutover","name":"accounting_cash_cutover_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_cash_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_cash_rake_sources","name":"accounting_cash_source_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_cash_source_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_rake_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_cash_rake_sources","name":"accounting_cash_source_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_cash_source_no_truncate BEFORE TRUNCATE ON public.accounting_cash_rake_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()","handler":"fn_accounting_agreement_history_immutable()"},{"relation":"accounting_tournament_fee_cutover","name":"accounting_tournament_fee_cutover_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_fee_cutover_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_cutover FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","handler":"fn_accounting_tournament_fee_receipt_immutable()"},{"relation":"accounting_tournament_fee_cutover","name":"accounting_tournament_fee_cutover_no_truncate","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_fee_cutover_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_cutover FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()","handler":"fn_accounting_tournament_fee_receipt_immutable()"},{"relation":"agent_commissions","name":"accounting_cash_commission_source_guard","enabled":"O","definition":"CREATE TRIGGER accounting_cash_commission_source_guard BEFORE INSERT ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_commission_source_guard()","handler":"fn_accounting_cash_commission_source_guard()"},{"relation":"agent_commissions","name":"accounting_tournament_commission_source_guard","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_commission_source_guard BEFORE INSERT ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_commission_source_guard()","handler":"fn_accounting_tournament_commission_source_guard()"},{"relation":"agent_commissions","name":"poker_arena_no_hierarchy","enabled":"O","definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()","handler":"fn_poker_reject_diamond_hierarchy()"},{"relation":"agent_commissions","name":"trg_agent_commission_rollup_del","enabled":"O","definition":"CREATE TRIGGER trg_agent_commission_rollup_del AFTER DELETE ON public.agent_commissions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_change()","handler":"trg_agent_commission_rollup_change()"},{"relation":"agent_commissions","name":"trg_agent_commission_rollup_ins","enabled":"O","definition":"CREATE TRIGGER trg_agent_commission_rollup_ins AFTER INSERT ON public.agent_commissions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_insert()","handler":"trg_agent_commission_rollup_insert()"},{"relation":"agent_commissions","name":"trg_agent_commission_rollup_upd","enabled":"O","definition":"CREATE TRIGGER trg_agent_commission_rollup_upd AFTER UPDATE ON public.agent_commissions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_agent_commission_rollup_change()","handler":"trg_agent_commission_rollup_change()"},{"relation":"agent_commissions","name":"trg_ca_append_only","enabled":"O","definition":"CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.agent_commissions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only()","handler":"fn_ca_journal_append_only()"},{"relation":"agents","name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, user_id, parent_agent_id, role, status, commission_rate, player_rakeback_rate, is_prepaid ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()","handler":"fn_accounting_agreement_capture()"},{"relation":"agents","name":"guard_agent_wallet_direct_update","enabled":"O","definition":"CREATE TRIGGER guard_agent_wallet_direct_update BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION guard_agent_wallet_direct_update()","handler":"guard_agent_wallet_direct_update()"},{"relation":"agents","name":"poker_arena_no_hierarchy","enabled":"O","definition":"CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()","handler":"fn_poker_reject_diamond_hierarchy()"},{"relation":"agents","name":"trg_agents_commission_bounds","enabled":"O","definition":"CREATE TRIGGER trg_agents_commission_bounds BEFORE INSERT OR UPDATE OF commission_rate ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_enforce_agent_commission_bounds()","handler":"fn_enforce_agent_commission_bounds()"},{"relation":"agents","name":"trg_agents_human_user_club_only","enabled":"O","definition":"CREATE TRIGGER trg_agents_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()","handler":"fn_ca_reject_automated_user_club_row()"},{"relation":"agents","name":"trg_agents_staff_earn_no_rakeback","enabled":"O","definition":"CREATE TRIGGER trg_agents_staff_earn_no_rakeback BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate ON public.agents FOR EACH ROW WHEN (((COALESCE(new.commission_rate, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.player_rakeback_rate, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_agents_staff_earn_no_rakeback()","handler":"fn_agents_staff_earn_no_rakeback()"},{"relation":"agents","name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","handler":"fn_ca_autoledger()"},{"relation":"agents","name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","handler":"fn_ca_autoledger_delete()"},{"relation":"agents","name":"trg_ca_autoledger_insert","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.agents FOR EACH ROW WHEN (((COALESCE(new.agent_wallet_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.promo_wallet_balance, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet')","handler":"fn_ca_autoledger()"},{"relation":"agents","name":"trg_deep_stack_agents_are_protected","enabled":"O","definition":"CREATE TRIGGER trg_deep_stack_agents_are_protected BEFORE DELETE ON public.agents FOR EACH ROW WHEN ((old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()","handler":"fn_deep_stack_society_cannot_be_deleted_by_accident()"},{"relation":"agents","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","handler":"fn_guard_retired_club_mutation()"},{"relation":"agents","name":"trg_sync_agent_wallets","enabled":"O","definition":"CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION sync_agent_wallet_columns()","handler":"sync_agent_wallet_columns()"},{"relation":"agents","name":"zz_guard_agent_agreement","enabled":"O","definition":"CREATE TRIGGER zz_guard_agent_agreement BEFORE INSERT OR UPDATE OF id, user_id, club_id, parent_agent_id, role, commission_rate, player_rakeback_rate, credit_limit ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_guard_agent_agreement()","handler":"fn_guard_agent_agreement()"},{"relation":"agents","name":"zzzz_credit_control_revision_v1","enabled":"O","definition":"CREATE TRIGGER zzzz_credit_control_revision_v1 BEFORE INSERT OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_agent_credit_control_revision_v1()","handler":"fn_agent_credit_control_revision_v1()"},{"relation":"ca_mtt_admission_contract","name":"ca_mtt_admission_contract_immutable","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.ca_mtt_admission_contract FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","handler":"fn_ca_guard_mtt_admission_contract()"},{"relation":"ca_mtt_admission_contract","name":"ca_mtt_admission_contract_no_truncate","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_no_truncate BEFORE TRUNCATE ON public.ca_mtt_admission_contract FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()","handler":"fn_ca_guard_mtt_admission_contract()"},{"relation":"chip_ledger","name":"aa_ca_capture_tournament_charge_entitlement","enabled":"O","definition":"CREATE TRIGGER aa_ca_capture_tournament_charge_entitlement AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.tournament_id IS NOT NULL) AND (new.from_type = 'player_wallet'::text) AND (new.to_type = 'prize_liability'::text))) EXECUTE FUNCTION fn_ca_capture_tournament_charge_entitlement()","handler":"fn_ca_capture_tournament_charge_entitlement()"},{"relation":"chip_ledger","name":"ab_ca_chip_store_declared","enabled":"O","definition":"CREATE TRIGGER ab_ca_chip_store_declared BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_store_declared()","handler":"fn_ca_chip_store_declared()"},{"relation":"chip_ledger","name":"accounting_tournament_recognized_bank_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable()","handler":"fn_accounting_tournament_recognized_evidence_immutable()"},{"relation":"chip_ledger","name":"accounting_transfer_document","enabled":"O","definition":"CREATE TRIGGER accounting_transfer_document AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.status = 'posted'::text) AND ((new.from_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text])) OR ((new.from_type = 'settlement_suspense'::text) AND (new.category = 'rakeback'::text))) AND (new.to_type = ANY (ARRAY['union_wallet'::text, 'union_bank'::text, 'club_treasury'::text, 'player_wallet'::text, 'agent_wallet'::text])))) EXECUTE FUNCTION fn_accounting_transfer_document_on_insert()","handler":"fn_accounting_transfer_document_on_insert()"},{"relation":"chip_ledger","name":"cancelled_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER cancelled_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_evidence_is_immutable()","handler":"fn_cancelled_tournament_evidence_is_immutable()"},{"relation":"chip_ledger","name":"original_union_pnl_flow","enabled":"O","definition":"CREATE TRIGGER original_union_pnl_flow AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_capture_original_flow()","handler":"fn_union_pnl_capture_original_flow()"},{"relation":"chip_ledger","name":"satellite_transfer_ledger_is_immutable","enabled":"O","definition":"CREATE TRIGGER satellite_transfer_ledger_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_satellite_transfer_ledger_is_immutable()","handler":"fn_satellite_transfer_ledger_is_immutable()"},{"relation":"chip_ledger","name":"terminal_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER terminal_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_evidence_is_immutable()","handler":"fn_terminal_tournament_evidence_is_immutable()"},{"relation":"chip_ledger","name":"trg_ca_append_only","enabled":"O","definition":"CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only()","handler":"fn_ca_journal_append_only()"},{"relation":"chip_ledger","name":"trg_ca_chip_ledger_enrich","enabled":"O","definition":"CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich()","handler":"fn_ca_chip_ledger_enrich()"},{"relation":"chip_ledger","name":"trg_chip_ledger_performed_by","enabled":"O","definition":"CREATE TRIGGER trg_chip_ledger_performed_by BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION enforce_chip_ledger_performed_by()","handler":"enforce_chip_ledger_performed_by()"},{"relation":"chip_ledger","name":"zz_ca_attested_day_is_restated_del","enabled":"O","definition":"CREATE TRIGGER zz_ca_attested_day_is_restated_del AFTER DELETE ON public.chip_ledger REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_attested_day_is_restated()","handler":"fn_ca_attested_day_is_restated()"},{"relation":"chip_ledger","name":"zz_ca_attested_day_is_restated_upd","enabled":"O","definition":"CREATE TRIGGER zz_ca_attested_day_is_restated_upd AFTER UPDATE ON public.chip_ledger REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_attested_day_is_restated()","handler":"fn_ca_attested_day_is_restated()"},{"relation":"chip_ledger","name":"zz_ca_escrow_overlay_leg","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_overlay_leg AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.to_type = 'prize_liability'::text) AND ((new.category = 'overlay'::text) OR ((new.category = 'correction'::text) AND (new.from_type = ANY (ARRAY['union_bank'::text, 'club_treasury'::text])))))) EXECUTE FUNCTION fn_ca_escrow_on_overlay_leg()","handler":"fn_ca_escrow_on_overlay_leg()"},{"relation":"chip_ledger","name":"zz_ca_escrow_reserve_leg","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_reserve_leg AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN ((new.category = ANY (ARRAY['spin_entry'::text, 'spin_prize'::text]))) EXECUTE FUNCTION fn_ca_escrow_on_reserve_leg()","handler":"fn_ca_escrow_on_reserve_leg()"},{"relation":"chip_ledger","name":"zz_ca_escrow_seat_transfer_leg","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_seat_transfer_leg AFTER INSERT ON public.chip_ledger FOR EACH ROW WHEN (((new.to_type = 'prize_liability'::text) AND (new.idempotency_key ~~ 'tourney:%:seat:%:pool_transfer'::text))) EXECUTE FUNCTION fn_ca_escrow_on_seat_transfer_leg()","handler":"fn_ca_escrow_on_seat_transfer_leg()"},{"relation":"chip_ledger","name":"zz_ca_issuance_leg_is_registered","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER zz_ca_issuance_leg_is_registered AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.from_type = ANY (ARRAY['system_mint'::text, 'system_burn'::text, 'issuance_reserve'::text, 'chip_retirement'::text])) OR (new.to_type = ANY (ARRAY['system_mint'::text, 'system_burn'::text, 'issuance_reserve'::text, 'chip_retirement'::text])))) EXECUTE FUNCTION fn_ca_issuance_leg_is_registered()","handler":"fn_ca_issuance_leg_is_registered()"},{"relation":"chip_ledger","name":"zz_chip_ledger_key_is_claimed_once","enabled":"O","definition":"CREATE TRIGGER zz_chip_ledger_key_is_claimed_once BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION zz_chip_ledger_key_is_claimed_once()","handler":"zz_chip_ledger_key_is_claimed_once()"},{"relation":"chip_ledger","name":"zz_freeze_guard","enabled":"O","definition":"CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen()","handler":"fn_refuse_while_frozen()"},{"relation":"chip_ledger","name":"zz_tournament_accounting_credit_ledger","enabled":"O","definition":"CREATE TRIGGER zz_tournament_accounting_credit_ledger AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_capture_tournament_credit_ledger()","handler":"fn_ca_capture_tournament_credit_ledger()"},{"relation":"club_members","name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF club_id, user_id, agent_id, parent_agent_id, role, status, is_active, commission_rate, rakeback_rate, player_rakeback_pct ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()","handler":"fn_accounting_agreement_capture()"},{"relation":"club_members","name":"club_members_updated_at","enabled":"O","definition":"CREATE TRIGGER club_members_updated_at BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()","handler":"update_updated_at_column()"},{"relation":"club_members","name":"lock_cashier_hierarchy_insert_delete","enabled":"O","definition":"CREATE TRIGGER lock_cashier_hierarchy_insert_delete BEFORE INSERT OR DELETE ON public.club_members FOR EACH ROW EXECUTE FUNCTION lock_club_cashier_hierarchy_mutation()","handler":"lock_club_cashier_hierarchy_mutation()"},{"relation":"club_members","name":"lock_cashier_hierarchy_update","enabled":"O","definition":"CREATE TRIGGER lock_cashier_hierarchy_update BEFORE UPDATE OF club_id, agent_id, role, status ON public.club_members FOR EACH ROW EXECUTE FUNCTION lock_club_cashier_hierarchy_mutation()","handler":"lock_club_cashier_hierarchy_mutation()"},{"relation":"club_members","name":"poker_arena_membership_guard","enabled":"O","definition":"CREATE TRIGGER poker_arena_membership_guard BEFORE INSERT OR UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure()","handler":"fn_poker_guard_arena_structure()"},{"relation":"club_members","name":"trg_admin_holds_no_player_wallet","enabled":"O","definition":"CREATE TRIGGER trg_admin_holds_no_player_wallet BEFORE INSERT OR UPDATE OF role, chip_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_admin_holds_no_player_wallet()","handler":"fn_admin_holds_no_player_wallet()"},{"relation":"club_members","name":"trg_approval_gate_ins","enabled":"O","definition":"CREATE TRIGGER trg_approval_gate_ins BEFORE INSERT ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_approval_gate()","handler":"fn_membership_approval_gate()"},{"relation":"club_members","name":"trg_approval_gate_upd","enabled":"O","definition":"CREATE TRIGGER trg_approval_gate_upd BEFORE UPDATE OF status ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_approval_gate()","handler":"fn_membership_approval_gate()"},{"relation":"club_members","name":"trg_audit_club_join","enabled":"O","definition":"CREATE TRIGGER trg_audit_club_join AFTER INSERT OR UPDATE OF status ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_audit_club_entry_mutation()","handler":"fn_audit_club_entry_mutation()"},{"relation":"club_members","name":"trg_audit_club_member_delete","enabled":"O","definition":"CREATE TRIGGER trg_audit_club_member_delete AFTER DELETE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_audit_club_member_change()","handler":"fn_audit_club_member_change()"},{"relation":"club_members","name":"trg_audit_club_member_update","enabled":"O","definition":"CREATE TRIGGER trg_audit_club_member_update AFTER UPDATE OF role, status ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_audit_club_member_change()","handler":"fn_audit_club_member_change()"},{"relation":"club_members","name":"trg_block_browser_balance_inserts","enabled":"O","definition":"CREATE TRIGGER trg_block_browser_balance_inserts BEFORE INSERT ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_block_browser_balance_inserts()","handler":"fn_block_browser_balance_inserts()"},{"relation":"club_members","name":"trg_block_browser_balance_writes","enabled":"O","definition":"CREATE TRIGGER trg_block_browser_balance_writes BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_block_browser_balance_writes()","handler":"fn_block_browser_balance_writes()"},{"relation":"club_members","name":"trg_ca_autoledger","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF promo_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('promo_balance=promo_wallet')","handler":"fn_ca_autoledger()"},{"relation":"club_members","name":"trg_ca_autoledger_delete","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('chip_balance=player_wallet', 'promo_balance=promo_wallet')","handler":"fn_ca_autoledger_delete()"},{"relation":"club_members","name":"trg_ca_autoledger_insert","enabled":"O","definition":"CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.club_members FOR EACH ROW WHEN (((COALESCE(new.chip_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.promo_balance, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_ca_autoledger('chip_balance=player_wallet', 'promo_balance=promo_wallet')","handler":"fn_ca_autoledger()"},{"relation":"club_members","name":"trg_club_member_notes_guard","enabled":"O","definition":"CREATE TRIGGER trg_club_member_notes_guard BEFORE UPDATE OF nickname, notes ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_club_member_notes_guard()","handler":"fn_club_member_notes_guard()"},{"relation":"club_members","name":"trg_club_members_audit_chip_movement","enabled":"O","definition":"CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON public.club_members FOR EACH ROW WHEN ((old.chip_balance IS DISTINCT FROM new.chip_balance)) EXECUTE FUNCTION fn_club_members_ledger_writer()","handler":"fn_club_members_ledger_writer()"},{"relation":"club_members","name":"trg_club_members_bot_follows_horse","enabled":"O","definition":"CREATE TRIGGER trg_club_members_bot_follows_horse BEFORE INSERT OR UPDATE OF user_id, is_bot ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_bot_follows_horse()","handler":"fn_club_members_bot_follows_horse()"},{"relation":"club_members","name":"trg_club_members_emit_management_access","enabled":"O","definition":"CREATE TRIGGER trg_club_members_emit_management_access AFTER INSERT OR DELETE OR UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event()","handler":"fn_emit_management_access_event()"},{"relation":"club_members","name":"trg_club_members_guard_lifecycle_write","enabled":"O","definition":"CREATE TRIGGER trg_club_members_guard_lifecycle_write BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_guard_membership_lifecycle_write()","handler":"fn_guard_membership_lifecycle_write()"},{"relation":"club_members","name":"trg_club_members_human_user_club_only","enabled":"O","definition":"CREATE TRIGGER trg_club_members_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id, is_bot ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()","handler":"fn_ca_reject_automated_user_club_row()"},{"relation":"club_members","name":"trg_club_members_level_sync","enabled":"O","definition":"CREATE TRIGGER trg_club_members_level_sync AFTER INSERT OR DELETE OR UPDATE OF role, status ON public.club_members FOR EACH ROW EXECUTE FUNCTION trg_auto_recompute_club_level()","handler":"trg_auto_recompute_club_level()"},{"relation":"club_members","name":"trg_club_members_no_agent_cycle_ins","enabled":"O","definition":"CREATE TRIGGER trg_club_members_no_agent_cycle_ins BEFORE INSERT ON public.club_members FOR EACH ROW WHEN ((new.agent_id IS NOT NULL)) EXECUTE FUNCTION fn_club_members_no_agent_cycle()","handler":"fn_club_members_no_agent_cycle()"},{"relation":"club_members","name":"trg_club_members_no_agent_cycle_upd","enabled":"O","definition":"CREATE TRIGGER trg_club_members_no_agent_cycle_upd BEFORE UPDATE OF agent_id ON public.club_members FOR EACH ROW WHEN (((new.agent_id IS NOT NULL) AND (new.agent_id IS DISTINCT FROM old.agent_id))) EXECUTE FUNCTION fn_club_members_no_agent_cycle()","handler":"fn_club_members_no_agent_cycle()"},{"relation":"club_members","name":"trg_club_members_require_explicit_join","enabled":"O","definition":"CREATE TRIGGER trg_club_members_require_explicit_join BEFORE INSERT ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_require_explicit_club_membership_source()","handler":"fn_require_explicit_club_membership_source()"},{"relation":"club_members","name":"trg_club_members_role_guard","enabled":"O","definition":"CREATE TRIGGER trg_club_members_role_guard BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_role_guard()","handler":"fn_club_members_role_guard()"},{"relation":"club_members","name":"trg_club_members_staff_earn_no_rakeback","enabled":"O","definition":"CREATE TRIGGER trg_club_members_staff_earn_no_rakeback BEFORE INSERT OR UPDATE ON public.club_members FOR EACH ROW WHEN (((new.role = ANY (ARRAY['co_owner'::text, 'admin'::text])) AND ((COALESCE(new.player_rakeback_pct, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.rakeback_rate, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.commission_rate, (0)::numeric) <> (0)::numeric)))) EXECUTE FUNCTION fn_club_members_staff_earn_no_rakeback()","handler":"fn_club_members_staff_earn_no_rakeback()"},{"relation":"club_members","name":"trg_deep_stack_members_are_protected","enabled":"O","definition":"CREATE TRIGGER trg_deep_stack_members_are_protected BEFORE DELETE ON public.club_members FOR EACH ROW WHEN ((old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()","handler":"fn_deep_stack_society_cannot_be_deleted_by_accident()"},{"relation":"club_members","name":"trg_four_club_limit_ins","enabled":"O","definition":"CREATE TRIGGER trg_four_club_limit_ins BEFORE INSERT ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit()","handler":"fn_enforce_four_club_limit()"},{"relation":"club_members","name":"trg_four_club_limit_upd","enabled":"O","definition":"CREATE TRIGGER trg_four_club_limit_upd BEFORE UPDATE OF status ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit()","handler":"fn_enforce_four_club_limit()"},{"relation":"club_members","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","handler":"fn_guard_retired_club_mutation()"},{"relation":"club_members","name":"trg_membership_starts_with_zero_chips","enabled":"O","definition":"CREATE TRIGGER trg_membership_starts_with_zero_chips BEFORE INSERT ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_starts_with_zero_chips()","handler":"fn_membership_starts_with_zero_chips()"},{"relation":"club_members","name":"trg_recompute_club_level_on_member_change","enabled":"O","definition":"CREATE TRIGGER trg_recompute_club_level_on_member_change AFTER INSERT OR DELETE OR UPDATE OF role, status ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_recompute_club_level_on_member_change()","handler":"fn_recompute_club_level_on_member_change()"},{"relation":"club_members","name":"trg_sync_agent_player_counts","enabled":"O","definition":"CREATE TRIGGER trg_sync_agent_player_counts AFTER INSERT OR DELETE OR UPDATE OF agent_id, club_id, is_active ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_sync_agent_player_counts()","handler":"fn_sync_agent_player_counts()"},{"relation":"club_members","name":"trg_sync_club_member_count","enabled":"O","definition":"CREATE TRIGGER trg_sync_club_member_count AFTER INSERT OR DELETE OR UPDATE OF status, club_id, role ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_sync_club_member_count()","handler":"fn_sync_club_member_count()"},{"relation":"club_members","name":"trg_sync_mfa_required_on_club_role","enabled":"O","definition":"CREATE TRIGGER trg_sync_mfa_required_on_club_role AFTER INSERT OR UPDATE OF role, user_id ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_sync_mfa_required_on_club_role()","handler":"fn_sync_mfa_required_on_club_role()"},{"relation":"club_members","name":"zz_freeze_guard","enabled":"O","definition":"CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_balance')","handler":"fn_refuse_while_frozen()"},{"relation":"rake_records","name":"accounting_cash_source_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_cash_source_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_cash_source_immutable()","handler":"fn_accounting_cash_source_immutable()"},{"relation":"rake_records","name":"accounting_tournament_fee_commit_capture","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER accounting_tournament_fee_commit_capture AFTER INSERT ON public.rake_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.is_tournament IS TRUE) AND (new.rake_amount > (0)::numeric))) EXECUTE FUNCTION fn_accounting_tournament_fee_commit_capture()","handler":"fn_accounting_tournament_fee_commit_capture()"},{"relation":"rake_records","name":"accounting_tournament_fee_source_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_fee_source_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_source_immutable()","handler":"fn_accounting_tournament_fee_source_immutable()"},{"relation":"rake_records","name":"accounting_tournament_recognized_evidence_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_recognized_evidence_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable()","handler":"fn_accounting_tournament_recognized_evidence_immutable()"},{"relation":"rake_records","name":"ca_reporting_rake_change_del","enabled":"O","definition":"CREATE TRIGGER ca_reporting_rake_change_del AFTER DELETE ON public.rake_records REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days()","handler":"trg_ca_reporting_repair_changed_days()"},{"relation":"rake_records","name":"ca_reporting_rake_change_upd","enabled":"O","definition":"CREATE TRIGGER ca_reporting_rake_change_upd AFTER UPDATE ON public.rake_records REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_reporting_repair_changed_days()","handler":"trg_ca_reporting_repair_changed_days()"},{"relation":"rake_records","name":"ca_reporting_rake_insert","enabled":"O","definition":"CREATE TRIGGER ca_reporting_rake_insert AFTER INSERT ON public.rake_records FOR EACH ROW EXECUTE FUNCTION trg_ca_reporting_rake_insert()","handler":"trg_ca_reporting_rake_insert()"},{"relation":"rake_records","name":"cancelled_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER cancelled_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_evidence_is_immutable()","handler":"fn_cancelled_tournament_evidence_is_immutable()"},{"relation":"rake_records","name":"satellite_target_rake_is_immutable","enabled":"O","definition":"CREATE TRIGGER satellite_target_rake_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_satellite_target_rake_is_immutable()","handler":"fn_satellite_target_rake_is_immutable()"},{"relation":"rake_records","name":"terminal_tournament_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER terminal_tournament_evidence_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_terminal_tournament_evidence_is_immutable()","handler":"fn_terminal_tournament_evidence_is_immutable()"},{"relation":"rake_records","name":"tournament_unregistration_rake_evidence_is_immutable","enabled":"O","definition":"CREATE TRIGGER tournament_unregistration_rake_evidence_is_immutable BEFORE DELETE OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_ca_unregistration_rake_evidence_is_immutable()","handler":"fn_ca_unregistration_rake_evidence_is_immutable()"},{"relation":"rake_records","name":"trg_award_vip_points_from_rake","enabled":"O","definition":"CREATE TRIGGER trg_award_vip_points_from_rake AFTER INSERT ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_award_vip_points_from_rake()","handler":"fn_award_vip_points_from_rake()"},{"relation":"rake_records","name":"trg_ca_club_rake_daily_del","enabled":"O","definition":"CREATE TRIGGER trg_ca_club_rake_daily_del AFTER DELETE ON public.rake_records REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_change()","handler":"trg_ca_club_rake_daily_change()"},{"relation":"rake_records","name":"trg_ca_club_rake_daily_ins","enabled":"O","definition":"CREATE TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON public.rake_records REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_insert()","handler":"trg_ca_club_rake_daily_insert()"},{"relation":"rake_records","name":"trg_ca_club_rake_daily_upd","enabled":"O","definition":"CREATE TRIGGER trg_ca_club_rake_daily_upd AFTER UPDATE ON public.rake_records REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_change()","handler":"trg_ca_club_rake_daily_change()"},{"relation":"rake_records","name":"trg_guard_rake_belongs_to_club","enabled":"O","definition":"CREATE TRIGGER trg_guard_rake_belongs_to_club BEFORE INSERT OR UPDATE ON public.rake_records FOR EACH ROW EXECUTE FUNCTION fn_guard_rake_belongs_to_club()","handler":"fn_guard_rake_belongs_to_club()"},{"relation":"rake_records","name":"trg_tournament_fee_names_its_player","enabled":"O","definition":"CREATE TRIGGER trg_tournament_fee_names_its_player BEFORE INSERT ON public.rake_records FOR EACH ROW WHEN (((new.is_tournament IS TRUE) AND (new.player_contributions IS NULL) AND (new.rake_amount > (0)::numeric))) EXECUTE FUNCTION fn_tournament_fee_names_its_player()","handler":"fn_tournament_fee_names_its_player()"},{"relation":"rake_records","name":"zz_ca_escrow_rake_record","enabled":"O","definition":"CREATE TRIGGER zz_ca_escrow_rake_record AFTER INSERT ON public.rake_records FOR EACH ROW WHEN (((new.is_tournament IS TRUE) AND (new.tournament_id IS NOT NULL))) EXECUTE FUNCTION fn_ca_escrow_on_rake_record()","handler":"fn_ca_escrow_on_rake_record()"},{"relation":"table_seats","name":"union_pnl_original_inventory","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"table_seats","name":"union_pnl_original_inventory_no_truncate","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.table_seats FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"tables","name":"union_pnl_original_inventory","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"tables","name":"union_pnl_original_inventory_no_truncate","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tables FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"tournament_players","name":"union_pnl_original_inventory","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"tournament_players","name":"union_pnl_original_inventory_no_truncate","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"tournaments","name":"a0_tournaments_dual_entry_capacity","enabled":"O","definition":"CREATE TRIGGER a0_tournaments_dual_entry_capacity BEFORE INSERT OR UPDATE OF max_players, tournament_type, variant, satellite_target_id, satellite_target ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_normalize_new_mtt_capacity()","handler":"fn_ca_normalize_new_mtt_capacity()"},{"relation":"tournaments","name":"a1_tournaments_restart_source","enabled":"O","definition":"CREATE TRIGGER a1_tournaments_restart_source BEFORE INSERT OR DELETE OR UPDATE OF restart_source_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_restart_source()","handler":"fn_ca_guard_tournament_restart_source()"},{"relation":"tournaments","name":"a2_tournaments_new_satellite_target","enabled":"O","definition":"CREATE TRIGGER a2_tournaments_new_satellite_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type, club_id, union_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_new_satellite_target()","handler":"fn_ca_guard_new_satellite_target()"},{"relation":"tournaments","name":"aa_guard_tournament_completing_claim","enabled":"D","definition":"CREATE TRIGGER aa_guard_tournament_completing_claim BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_completing_claim()","handler":"fn_guard_tournament_completing_claim()"},{"relation":"tournaments","name":"aaa_guard_atomic_satellite_completion","enabled":"D","definition":"CREATE TRIGGER aaa_guard_atomic_satellite_completion BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_guard_atomic_satellite_completion()","handler":"trg_guard_atomic_satellite_completion()"},{"relation":"tournaments","name":"cancelled_tournament_parent_is_immutable","enabled":"O","definition":"CREATE TRIGGER cancelled_tournament_parent_is_immutable BEFORE DELETE OR UPDATE OF status, variant, tournament_type, satellite_target_id, satellite_target, satellite_seats, prize_pool, prize_pool_finalized, bounty_pool, bounty_pool_paid, is_bounty, is_pko, is_mystery_bounty, mystery_bounty_stage, mystery_bounty_pool_cents, club_id, ended_at, total_rake, current_players, on_break, break_started_at, break_ends_at ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_cancelled_tournament_parent_is_immutable()","handler":"fn_cancelled_tournament_parent_is_immutable()"},{"relation":"tournaments","name":"non_satellite_completed_requires_terminal_receipt","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER non_satellite_completed_requires_terminal_receipt AFTER INSERT OR UPDATE OF status ON tournaments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_non_satellite_completed_requires_terminal_receipt()","handler":"fn_non_satellite_completed_requires_terminal_receipt()"},{"relation":"tournaments","name":"poker_arena_tournament_guard","enabled":"O","definition":"CREATE TRIGGER poker_arena_tournament_guard BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure()","handler":"fn_poker_guard_arena_structure()"},{"relation":"tournaments","name":"receipted_tournament_is_immutable","enabled":"O","definition":"CREATE TRIGGER receipted_tournament_is_immutable BEFORE DELETE OR UPDATE OF status, variant, tournament_type, satellite_target_id, satellite_target, satellite_seats, prize_pool, prize_pool_finalized, bounty_pool, bounty_pool_paid, is_bounty, is_pko, is_mystery_bounty, mystery_bounty_stage, mystery_bounty_pool_cents, club_id, ended_at, current_players, on_break, break_started_at, break_ends_at ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_receipted_tournament_is_immutable()","handler":"fn_receipted_tournament_is_immutable()"},{"relation":"tournaments","name":"satellite_feeds_only_a_deliverable_target","enabled":"O","definition":"CREATE TRIGGER satellite_feeds_only_a_deliverable_target BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_satellite_feeds_only_a_deliverable_target()","handler":"fn_satellite_feeds_only_a_deliverable_target()"},{"relation":"tournaments","name":"satellite_target_contract_is_immutable","enabled":"O","definition":"CREATE TRIGGER satellite_target_contract_is_immutable BEFORE UPDATE OF buy_in_amount, buy_in_fee, bounty_amount, rebuy_cost, addon_cost, is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type, club_id, entry_contract_locked ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_satellite_target_contract_is_immutable()","handler":"fn_satellite_target_contract_is_immutable()"},{"relation":"tournaments","name":"spin_tournament_contract_is_draw","enabled":"O","definition":"CREATE TRIGGER spin_tournament_contract_is_draw BEFORE UPDATE OF spin_multiplier, prize_pool, spin_locked_tiers ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_spin_tournament_contract_is_draw()","handler":"fn_spin_tournament_contract_is_draw()"},{"relation":"tournaments","name":"stamp_tournament_terminal_evidence_markers","enabled":"O","definition":"CREATE TRIGGER stamp_tournament_terminal_evidence_markers AFTER INSERT OR UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_terminal_evidence_markers()","handler":"fn_stamp_tournament_terminal_evidence_markers()"},{"relation":"tournaments","name":"tournament_completed_stats","enabled":"O","definition":"CREATE TRIGGER tournament_completed_stats AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_completed_stats()","handler":"trg_tournament_completed_stats()"},{"relation":"tournaments","name":"tournament_prize_math_contract","enabled":"O","definition":"CREATE TRIGGER tournament_prize_math_contract BEFORE INSERT OR UPDATE OF payout_math_version, payout_unit_cents, club_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_prize_math_contract()","handler":"fn_guard_tournament_prize_math_contract()"},{"relation":"tournaments","name":"tournament_start_time_locked_during_launch","enabled":"O","definition":"CREATE TRIGGER tournament_start_time_locked_during_launch BEFORE UPDATE OF start_time ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_lock_tournament_start_time_during_launch()","handler":"trg_lock_tournament_start_time_during_launch()"},{"relation":"tournaments","name":"tournaments_cancel_must_refund","enabled":"O","definition":"CREATE CONSTRAINT TRIGGER tournaments_cancel_must_refund AFTER UPDATE ON tournaments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((upper(COALESCE(new.status, ''::text)) = ANY (ARRAY['CANCELLED'::text, 'CANCELED'::text])) AND upper(COALESCE(old.status, ''::text)) IS DISTINCT FROM upper(COALESCE(new.status, ''::text))) EXECUTE FUNCTION trg_tournaments_cancel_must_refund()","handler":"trg_tournaments_cancel_must_refund()"},{"relation":"tournaments","name":"tournaments_creation_guard","enabled":"O","definition":"CREATE TRIGGER tournaments_creation_guard BEFORE INSERT ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_creation_guard()","handler":"fn_tournaments_creation_guard()"},{"relation":"tournaments","name":"tournaments_guarantee_affordable_ins","enabled":"O","definition":"CREATE TRIGGER tournaments_guarantee_affordable_ins BEFORE INSERT ON tournaments FOR EACH ROW WHEN (COALESCE(new.guaranteed_prize, 0::numeric) > 0::numeric) EXECUTE FUNCTION trg_tournaments_guarantee_affordable()","handler":"trg_tournaments_guarantee_affordable()"},{"relation":"tournaments","name":"tournaments_guarantee_affordable_upd","enabled":"O","definition":"CREATE TRIGGER tournaments_guarantee_affordable_upd BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (COALESCE(new.guaranteed_prize, 0::numeric) > 0::numeric AND new.guaranteed_prize IS DISTINCT FROM old.guaranteed_prize) EXECUTE FUNCTION trg_tournaments_guarantee_affordable()","handler":"trg_tournaments_guarantee_affordable()"},{"relation":"tournaments","name":"tournaments_mystery_creation_contract","enabled":"O","definition":"CREATE TRIGGER tournaments_mystery_creation_contract BEFORE INSERT OR UPDATE OF is_mystery_bounty, mystery_bounty_profile, mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent, mystery_bounty_top_percent ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_mystery_creation_contract()","handler":"fn_guard_tournament_mystery_creation_contract()"},{"relation":"tournaments","name":"tournaments_new_mtt_blind_contract","enabled":"O","definition":"CREATE TRIGGER tournaments_new_mtt_blind_contract BEFORE INSERT OR UPDATE OF blind_structure, starting_chips, tournament_type, variant, max_players ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_new_mtt_blind_contract()","handler":"fn_guard_new_mtt_blind_contract()"},{"relation":"tournaments","name":"tournaments_rank_before_complete","enabled":"O","definition":"CREATE TRIGGER tournaments_rank_before_complete BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_tournaments_rank_before_complete()","handler":"trg_tournaments_rank_before_complete()"},{"relation":"tournaments","name":"tournaments_short_formats_never_break","enabled":"O","definition":"CREATE TRIGGER tournaments_short_formats_never_break BEFORE INSERT OR UPDATE OF tournament_type, variant, synchronized_breaks ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_short_formats_never_break()","handler":"fn_short_formats_never_break()"},{"relation":"tournaments","name":"tournaments_spin_completed_guard","enabled":"O","definition":"CREATE TRIGGER tournaments_spin_completed_guard BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_spin_completed_guard()","handler":"trg_spin_completed_guard()"},{"relation":"tournaments","name":"trg_clear_seats_on_game_end","enabled":"O","definition":"CREATE TRIGGER trg_clear_seats_on_game_end AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_clear_seats_on_game_end()","handler":"fn_clear_seats_on_game_end()"},{"relation":"tournaments","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","handler":"fn_guard_retired_club_mutation()"},{"relation":"tournaments","name":"trg_receipt_mystery_activation","enabled":"O","definition":"CREATE TRIGGER trg_receipt_mystery_activation AFTER UPDATE OF mystery_bounty_stage ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_receipt_mystery_activation()","handler":"fn_receipt_mystery_activation()"},{"relation":"tournaments","name":"trg_refuse_completed_with_pending_bounties","enabled":"O","definition":"CREATE TRIGGER trg_refuse_completed_with_pending_bounties BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_refuse_completed_with_pending_bounties()","handler":"fn_refuse_completed_with_pending_bounties()"},{"relation":"tournaments","name":"trg_refuse_mystery_activation_with_pending_heads","enabled":"O","definition":"CREATE TRIGGER trg_refuse_mystery_activation_with_pending_heads BEFORE UPDATE OF mystery_bounty_stage, mystery_bounty_activation_generation ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_refuse_mystery_activation_with_pending_heads()","handler":"fn_refuse_mystery_activation_with_pending_heads()"},{"relation":"tournaments","name":"trg_release_seats_on_tournament_finish","enabled":"O","definition":"CREATE TRIGGER trg_release_seats_on_tournament_finish AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_release_seats_on_tournament_finish()","handler":"fn_release_seats_on_tournament_finish()"},{"relation":"tournaments","name":"trg_retire_manager_wakes_after_terminal_status","enabled":"O","definition":"CREATE TRIGGER trg_retire_manager_wakes_after_terminal_status AFTER UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_retire_manager_wakes_after_terminal_status()","handler":"fn_retire_manager_wakes_after_terminal_status()"},{"relation":"tournaments","name":"trg_tournaments_capture_management_contract","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_capture_management_contract AFTER INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_capture_managed_game_contract()","handler":"fn_capture_managed_game_contract()"},{"relation":"tournaments","name":"trg_tournaments_emit_game_management_event","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_emit_game_management_event AFTER INSERT OR DELETE OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_emit_managed_game_row_event()","handler":"fn_emit_managed_game_row_event()"},{"relation":"tournaments","name":"trg_tournaments_managed_delete_guard","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_managed_delete_guard BEFORE DELETE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_delete()","handler":"fn_guard_managed_game_delete()"},{"relation":"tournaments","name":"trg_tournaments_managed_lifecycle_guard","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_managed_lifecycle_guard BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_managed_game_lifecycle()","handler":"fn_guard_managed_game_lifecycle()"},{"relation":"tournaments","name":"trg_tournaments_publish_readiness","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_publish_readiness AFTER INSERT OR UPDATE OF guaranteed_prize, club_id, union_id, is_private, variant, tournament_type, satellite_target_id, satellite_target, satellite_seats ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_publish_readiness()","handler":"fn_guard_tournament_publish_readiness()"},{"relation":"tournaments","name":"trg_tournaments_refuse_unbuilt_multi_day","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_refuse_unbuilt_multi_day BEFORE INSERT OR UPDATE OF is_multi_day, total_days, day_number, parent_tournament_id, survivors_advance_to, flight_number, flight_end_chips_snapshot ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_tournaments_refuse_unbuilt_multi_day()","handler":"fn_tournaments_refuse_unbuilt_multi_day()"},{"relation":"tournaments","name":"trg_tournaments_registered_contract_lock","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_registered_contract_lock BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_registered_tournament_contract()","handler":"fn_guard_registered_tournament_contract()"},{"relation":"tournaments","name":"trg_tournaments_start_readiness","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_start_readiness BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_start_readiness()","handler":"fn_guard_tournament_start_readiness()"},{"relation":"tournaments","name":"trg_tournaments_union_ownership","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_union_ownership BEFORE INSERT ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_stamp_tournament_union_ownership()","handler":"fn_stamp_tournament_union_ownership()"},{"relation":"tournaments","name":"trg_tournaments_union_ownership_upd","enabled":"O","definition":"CREATE TRIGGER trg_tournaments_union_ownership_upd BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_enforce_tournament_union_ownership_update()","handler":"fn_enforce_tournament_union_ownership_update()"},{"relation":"tournaments","name":"trg_whole_dollar_buyin","enabled":"O","definition":"CREATE TRIGGER trg_whole_dollar_buyin BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_enforce_whole_dollar_buyin()","handler":"fn_enforce_whole_dollar_buyin()"},{"relation":"tournaments","name":"union_pnl_original_inventory","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"tournaments","name":"union_pnl_original_inventory_no_truncate","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON tournaments FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"tournaments","name":"zz_ca_fund_overlay_on_lock","enabled":"O","definition":"CREATE TRIGGER zz_ca_fund_overlay_on_lock BEFORE UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_fund_overlay_on_lock()","handler":"fn_ca_fund_overlay_on_lock()"},{"relation":"tournaments","name":"zz_freerolls_are_free_buy","enabled":"O","definition":"CREATE TRIGGER zz_freerolls_are_free_buy BEFORE INSERT OR UPDATE OF buy_in_amount, buy_in_fee, tournament_type, variant, is_rebuy, add_on_available, rebuy_cost, addon_cost, rebuy_chips, addon_chips, rebuy_levels, addon_levels, max_rebuys ON tournaments FOR EACH ROW WHEN (COALESCE(new.buy_in_amount, 0::numeric) = 0::numeric) EXECUTE FUNCTION fn_freerolls_are_free_buy()","handler":"fn_freerolls_are_free_buy()"},{"relation":"tournaments","name":"zz_freeze_launch_guard","enabled":"O","definition":"CREATE TRIGGER zz_freeze_launch_guard BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status = 'RUNNING'::text AND old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION fn_refuse_new_entries_while_frozen()","handler":"fn_refuse_new_entries_while_frozen()"},{"relation":"tournaments","name":"zzz_spin_ladder_is_the_drawn_one","enabled":"O","definition":"CREATE TRIGGER zzz_spin_ladder_is_the_drawn_one BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_spin_ladder_is_the_drawn_one()","handler":"fn_spin_ladder_is_the_drawn_one()"},{"relation":"tournaments","name":"zzzy_lock_atomic_place_tournament_status","enabled":"O","definition":"CREATE TRIGGER zzzy_lock_atomic_place_tournament_status BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status IS DISTINCT FROM old.status) EXECUTE FUNCTION trg_lock_atomic_place_tournament_status()","handler":"trg_lock_atomic_place_tournament_status()"},{"relation":"tournaments","name":"zzzz_capture_satellite_economics_on_start","enabled":"O","definition":"CREATE TRIGGER zzzz_capture_satellite_economics_on_start BEFORE INSERT OR UPDATE OF status ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_capture_satellite_economics_on_start()","handler":"trg_capture_satellite_economics_on_start()"},{"relation":"tournaments","name":"zzzz_freeze_finalized_tournament_prize_pool","enabled":"D","definition":"CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized, payout_structure, spin_multiplier ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_finalized_tournament_prize_pool()","handler":"trg_freeze_finalized_tournament_prize_pool()"},{"relation":"tournaments","name":"zzzz_freeze_registered_tournament_settlement_contract","enabled":"O","definition":"CREATE TRIGGER zzzz_freeze_registered_tournament_settlement_contract BEFORE UPDATE OF variant, tournament_type, satellite_target_id, bubble_protection, buy_in_amount, guaranteed_prize ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_registered_tournament_settlement_contract()","handler":"trg_freeze_registered_tournament_settlement_contract()"},{"relation":"tournaments","name":"zzzz_refuse_normal_tournament_completed_insert","enabled":"O","definition":"CREATE TRIGGER zzzz_refuse_normal_tournament_completed_insert BEFORE INSERT ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text) EXECUTE FUNCTION trg_refuse_normal_tournament_completed_insert()","handler":"trg_refuse_normal_tournament_completed_insert()"},{"relation":"tournaments","name":"zzzz_tournament_pool_finalization_window_guard","enabled":"D","definition":"CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard BEFORE UPDATE OF prize_pool_finalized ON tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_pool_finalization_window_guard()","handler":"trg_tournament_pool_finalization_window_guard()"},{"relation":"tournaments","name":"zzzz_tournaments_atomic_place_completion_guard","enabled":"D","definition":"CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard BEFORE UPDATE ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_tournament_atomic_place_completion_guard()","handler":"trg_tournament_atomic_place_completion_guard()"},{"relation":"tournaments","name":"zzzzy_lock_atomic_final_table_deal_status","enabled":"O","definition":"CREATE TRIGGER zzzzy_lock_atomic_final_table_deal_status BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status IS DISTINCT FROM old.status) EXECUTE FUNCTION trg_lock_atomic_final_table_deal_status()","handler":"trg_lock_atomic_final_table_deal_status()"},{"relation":"tournaments","name":"zzzzz_tournaments_atomic_final_table_deal_completion_guard","enabled":"D","definition":"CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION trg_atomic_final_table_deal_completion_guard()","handler":"trg_atomic_final_table_deal_completion_guard()"},{"relation":"tournaments","name":"zzzzzz_tournaments_financial_certificate","enabled":"D","definition":"CREATE TRIGGER zzzzzz_tournaments_financial_certificate BEFORE UPDATE OF status ON tournaments FOR EACH ROW WHEN (new.status = 'COMPLETED'::text AND old.status IS DISTINCT FROM 'COMPLETED'::text) EXECUTE FUNCTION fn_guard_tournament_completed_certificate()","handler":"fn_guard_tournament_completed_certificate()"},{"relation":"tournaments","name":"zzzzzzz_tournaments_record_format","enabled":"O","definition":"CREATE TRIGGER zzzzzzz_tournaments_record_format BEFORE INSERT OR UPDATE OF format_contract, tournament_type, variant, max_players, min_players, table_size, satellite_target_id, satellite_target, club_id, union_id ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_format()","handler":"fn_ca_guard_tournament_format()"},{"relation":"union_clubs","name":"accounting_agreement_history","enabled":"O","definition":"CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, union_id, club_commission_rate, rate_cash, rate_mtt, rate_sng, rate_spin, rate_satellite ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()","handler":"fn_accounting_agreement_capture()"},{"relation":"union_clubs","name":"poker_arena_union_guard","enabled":"O","definition":"CREATE TRIGGER poker_arena_union_guard BEFORE INSERT OR UPDATE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure()","handler":"fn_poker_guard_arena_structure()"},{"relation":"union_clubs","name":"trg_club_enters_a_union_empty","enabled":"O","definition":"CREATE TRIGGER trg_club_enters_a_union_empty BEFORE INSERT ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_enforce_club_enters_union_empty()","handler":"fn_enforce_club_enters_union_empty()"},{"relation":"union_clubs","name":"trg_guard_retired_club_mutation","enabled":"O","definition":"CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()","handler":"fn_guard_retired_club_mutation()"},{"relation":"union_clubs","name":"trg_recompute_union_level_on_club_change","enabled":"O","definition":"CREATE TRIGGER trg_recompute_union_level_on_club_change AFTER INSERT OR DELETE OR UPDATE OF union_id, club_id ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_recompute_union_level_on_club_change()","handler":"fn_recompute_union_level_on_club_change()"},{"relation":"union_clubs","name":"trg_union_clubs_emit_management_access","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_emit_management_access AFTER INSERT OR DELETE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event()","handler":"fn_emit_management_access_event()"},{"relation":"union_clubs","name":"trg_union_clubs_reassignment_management_access","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_reassignment_management_access AFTER UPDATE OF union_id, club_id ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event()","handler":"fn_emit_management_access_event()"},{"relation":"union_clubs","name":"trg_union_clubs_sync_mirror","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_sync_mirror AFTER INSERT OR DELETE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_sync_club_union_mirror()","handler":"fn_sync_club_union_mirror()"},{"relation":"union_clubs","name":"trg_union_clubs_sync_table_counts","enabled":"O","definition":"CREATE TRIGGER trg_union_clubs_sync_table_counts AFTER INSERT OR DELETE OR UPDATE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_sync_union_membership_table_counts()","handler":"fn_sync_union_membership_table_counts()"},{"relation":"union_clubs","name":"union_pnl_original_inventory","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.union_clubs FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"union_clubs","name":"union_pnl_original_inventory_no_truncate","enabled":"O","definition":"CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.union_clubs FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe()","handler":"fn_union_pnl_inventory_observe()"},{"relation":"union_pnl_inventory_events","name":"original_pnl_inventory_events_immutable","enabled":"O","definition":"CREATE TRIGGER original_pnl_inventory_events_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_inventory_events FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable()","handler":"fn_union_pnl_inventory_immutable()"},{"relation":"union_pnl_original_flows","name":"original_pnl_immutable","enabled":"O","definition":"CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_original_flows FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable()","handler":"fn_union_pnl_inventory_immutable()"},{"relation":"union_pnl_transaction_frames","name":"original_pnl_immutable","enabled":"O","definition":"CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_transaction_frames FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_immutable()","handler":"fn_union_pnl_inventory_immutable()"},{"relation":"union_wallet_transactions","name":"accounting_tournament_recognized_bank_immutable","enabled":"O","definition":"CREATE TRIGGER accounting_tournament_recognized_bank_immutable BEFORE DELETE OR UPDATE ON public.union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_recognized_evidence_immutable()","handler":"fn_accounting_tournament_recognized_evidence_immutable()"},{"relation":"union_wallet_transactions","name":"trg_ca_append_only","enabled":"O","definition":"CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public.union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only()","handler":"fn_ca_journal_append_only()"},{"relation":"union_wallet_transactions","name":"union_rake_weekly_maintain","enabled":"O","definition":"CREATE TRIGGER union_rake_weekly_maintain AFTER INSERT ON public.union_wallet_transactions FOR EACH ROW EXECUTE FUNCTION trg_union_rake_weekly()","handler":"trg_union_rake_weekly()"}]$capture$::jsonb THEN RAISE EXCEPTION 'positive-fee trigger cohort readback differs' USING ERRCODE='55000'; END IF;
SELECT jsonb_agg(to_jsonb(c) ORDER BY singleton) INTO actual FROM public.ca_mtt_admission_contract c; IF actual IS DISTINCT FROM $capture$[{"abi":"legacy-capacity-v1","singleton":true}]$capture$::jsonb THEN RAISE EXCEPTION 'positive-fee admission ABI row differs'; END IF;
IF pg_temp.positive_fee_tournament_target(true) IS DISTINCT FROM $capture${"columns":[{"acl":null,"name":"format_contract","type":"text","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"max_players","type":"integer","default":null,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"restart_source_id","type":"uuid","default":null,"identity":"","not_null":false,"generated":""}],"constraints":[{"name":"tournament_prize_math_contract_valid","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (payout_math_version = 1 AND payout_unit_cents = 1 OR payout_math_version = 2 AND (payout_unit_cents = ANY (ARRAY[1, 100])) AND upper(COALESCE(tournament_type, ''::text)) = 'MTT'::text AND (COALESCE(max_players, 0) > 2 OR NOT format_contract IS DISTINCT FROM 'mtt-v2'::text) AND (lower(COALESCE(variant, ''::text)) <> ALL (ARRAY['spin'::text, 'sng'::text, 'satellite'::text])) AND NOT COALESCE(is_premium_spin, false) AND satellite_target_id IS NULL AND satellite_target IS NULL)"},{"name":"tournaments_format_contract_known","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (format_contract IS NULL OR (format_contract = ANY (ARRAY['mtt-v1'::text, 'mtt-v2'::text, 'seat-first-satellite-v1'::text, 'sng-v1'::text, 'spin-v1'::text])))"},{"name":"tournaments_heads_up_rake_within_5_pct","type":"c","deferred":false,"validated":false,"deferrable":false,"definition":"CHECK (max_players IS NULL OR max_players > 2 OR COALESCE(buy_in_fee, 0::numeric) <= (round((COALESCE(buy_in_amount, 0::numeric) + COALESCE(buy_in_fee, 0::numeric)) * 0.05, 2) + 0.005)) NOT VALID"},{"name":"tournaments_recorded_entry_capacity","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK (NOT format_contract IS DISTINCT FROM 'mtt-v2'::text AND max_players IS NULL AND COALESCE(min_players, 0) >= 3 OR format_contract IS DISTINCT FROM 'mtt-v2'::text AND COALESCE(max_players > 0, false))"},{"name":"tournaments_restart_source_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (restart_source_id) REFERENCES tournaments(id) ON UPDATE RESTRICT ON DELETE RESTRICT"}],"indexes":[{"name":"tournaments_one_restart_per_source","unique":true,"primary":false,"definition":"CREATE UNIQUE INDEX tournaments_one_restart_per_source ON public.tournaments USING btree (restart_source_id) WHERE (restart_source_id IS NOT NULL)","nulls_not_distinct":false}]}$capture$::jsonb THEN RAISE EXCEPTION 'positive-fee tournament targeted readback differs' USING ERRCODE='55000'; END IF;
FOR name IN SELECT jsonb_array_elements_text($capture$["accounting_agreement_history","accounting_cash_accrual_batches","accounting_cash_accrual_cutover","accounting_cash_rake_sources","accounting_period_recompute_requests","accounting_routed_settlement_runs","accounting_tournament_fee_batches","accounting_tournament_fee_cutover","accounting_tournament_fee_recognitions","accounting_tournament_fee_sources","accounting_tournament_recognized_sources","agent_commissions","agents","chip_ledger","club_members","clubs","hand_history","rake_records","table_seats","tables","tournament_players","tournament_terminal_settlements","tournaments","union_clubs","union_pnl_inventory_events","union_pnl_original_flows","union_pnl_transaction_frames","union_wallet_transactions"]$capture$::jsonb) LOOP EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I LIMIT 1)',name) INTO has_rows; IF has_rows THEN RAISE EXCEPTION 'positive-fee provider requires empty estate: %',name USING ERRCODE='55000'; END IF; END LOOP;
END $verify$;
DO $preserve$ BEGIN IF pg_temp.positive_fee_untouched() IS DISTINCT FROM (SELECT value FROM pg_temp.positive_fee_untouched_before) THEN RAISE EXCEPTION 'positive-fee untouched catalog changed' USING ERRCODE='55000'; END IF; END $preserve$;
SELECT jsonb_build_object('stage','positive_fee_catalog_readback','execution_uuid',current_setting('qualification.execution_uuid'),'database',current_database(),'relations',11,'function_authorities',167,'trigger_bindings',192,'logical_catalog_exact',true,'deployment_local_attnum_identity_compared',false,'empty_business_estate',true,'mtt_abi','legacy-capacity-v1','mtt_activation_qualified',false,'native_financial_qualification',false,'historical_qualification',false,'production_qualification',false,'full_qualification',false) AS positive_fee_catalog_receipt;
COMMIT;
