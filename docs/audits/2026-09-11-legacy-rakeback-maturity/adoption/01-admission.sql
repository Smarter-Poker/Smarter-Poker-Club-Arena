SET LOCAL statement_timeout='2000ms';
WITH expected(signature,body_md5,secdef,acl) AS (VALUES
 ('public.fn_claim_rakeback(uuid)','930e4b70fa3580c010abe99e23181598',true,ARRAY['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']),
 ('public.fn_close_settlement_period(uuid)','5f1b3b29c972620ca06143a2f58444c9',true,ARRAY['postgres=X/postgres','service_role=X/postgres']),
 ('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)','5234e460b1ea1f666fbc6bac7a9a1b17',true,ARRAY['postgres=X/postgres','service_role=X/postgres'])
), owners AS (
 SELECT e.signature,md5(p.prosrc) actual_md5,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proacl::text acl,p.proconfig,
 COALESCE(md5(p.prosrc)=e.body_md5 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=e.secdef
 AND ARRAY(SELECT a FROM unnest(p.proacl::text[]) a ORDER BY a)=e.acl,false) pass
 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
), state AS (
 SELECT to_regprocedure('public.fn_ca_legacy_period_maturity()') IS NULL
 AND to_regprocedure('public.fn_ca_legacy_round3_wallet_receipt()') IS NULL
 AND to_regprocedure('public.fn_lock_rakeback_payer_clubs(uuid[])') IS NULL AS new_function_names_clear,
 NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN(to_regclass('public.rakeback_periods'),to_regclass('public.wallet_transactions')) AND tgname IN('ca_legacy_period_maturity','ca_legacy_round3_wallet_receipt')) AS new_trigger_names_clear,
 NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.hand_atomic_commits') AND attname='commission_capture_version' AND NOT attisdropped)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['ca_cash_bank_receipts','ca_cash_commission_facts','ca_source_funding_lots','ca_source_player_funding_admissions','ca_source_club_cash_releases','ca_source_agent_cash_payments','ca_source_player_cash_payments']) n WHERE to_regclass('public.'||n) IS NOT NULL) AS capture_state_absent,
 EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.rakeback_period_payouts') AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (rakeback_period_id, user_id)') AS receipt_unique_present,
 (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_journal_append_only()')) AS append_only_md5
)
SELECT statement_timestamp() checked_at,public.fn_ca_break_window_refuses_migrations(now()) AS break_window_refusal,
 (SELECT jsonb_agg(to_jsonb(o)) FROM owners o) owners,(SELECT to_jsonb(s) FROM state s) state,
 (SELECT count(*) FROM pg_locks WHERE relation IN(to_regclass('public.rakeback_periods'),to_regclass('public.wallet_transactions')) AND pid<>pg_backend_pid() AND mode IN('RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) potentially_conflicting_relation_locks;
