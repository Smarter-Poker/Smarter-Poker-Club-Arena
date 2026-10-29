-- Every source mutation remains authoritative and immediately signals its
-- existing topics. Same-row no-ops never consume a later valid change.
LISTEN ca_private_record_changes;
TRUNCATE signals;
BEGIN;
UPDATE club_members SET chip_balance=chip_balance WHERE user_id='75000000-0000-0000-0000-000000000003';
UPDATE club_members SET chip_balance=1 WHERE user_id='75000000-0000-0000-0000-000000000003';
UPDATE club_members SET promo_balance=1 WHERE user_id='75000000-0000-0000-0000-000000000003';
DO $$ BEGIN
 IF (SELECT count(*) FROM signals)<>3
  OR (SELECT count(*) FROM signals WHERE topic LIKE 'member-record:%')<>2
  OR (SELECT count(*) FROM signals WHERE topic LIKE 'club-roster:%')<>1
  OR EXISTS(SELECT 1 FROM signals GROUP BY topic HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM signals WHERE event<>'record_changed' OR private IS NOT TRUE)
 THEN RAISE EXCEPTION 'Real wallet changes lost their original topic delivery'; END IF;
END $$;
COMMIT;
-- Existing profile-to-child identity propagation remains intact.
TRUNCATE signals;
BEGIN;
UPDATE profiles SET alias='Changed upline' WHERE id='75000000-0000-0000-0000-000000000002';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM signals WHERE topic='member-record:75000000-0000-0000-0000-000000000001:75000000-0000-0000-0000-000000000003')
 THEN RAISE EXCEPTION 'Upline identity no longer refreshes its child'; END IF;
END $$;
COMMIT;
-- Real seat and both fee-source changes still reach their original owners.
TRUNCATE signals;
BEGIN;
UPDATE table_seats SET left_at=clock_timestamp() WHERE user_id='75000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>3 THEN RAISE EXCEPTION 'Real seat change lost'; END IF; END $$;
COMMIT;
TRUNCATE signals;
BEGIN;
UPDATE ca_club_rake_daily_user SET rake_cents=1 WHERE user_id='75000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>3 THEN RAISE EXCEPTION 'Real cash fee change lost'; END IF; END $$;
COMMIT;
TRUNCATE signals;
BEGIN;
UPDATE ca_club_member_tournament_fee_daily SET fees=1 WHERE user_id='75000000-0000-0000-0000-000000000003';
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>3 THEN RAISE EXCEPTION 'Real tournament fee change lost'; END IF; END $$;
COMMIT;
-- A savepoint rollback still makes a later committed change deliver.
TRUNCATE signals;
BEGIN;
SAVEPOINT aborted_change;
UPDATE agents SET promo_wallet_balance=2 WHERE user_id='75000000-0000-0000-0000-000000000003';
ROLLBACK TO SAVEPOINT aborted_change;
UPDATE agents SET promo_wallet_balance=3 WHERE user_id='75000000-0000-0000-0000-000000000003';
DO $$ BEGIN
 IF (SELECT count(*) FROM signals)<>3 THEN RAISE EXCEPTION 'Savepoint rollback poisoned real change'; END IF;
END $$;
COMMIT;
TRUNCATE signals;
BEGIN;
UPDATE profiles SET status='inactive' WHERE id='75000000-0000-0000-0000-000000000003';
ROLLBACK;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Aborted real source change leaked'; END IF; END $$;
-- A membership INSERT and DELETE still invalidate the old authoritative topic.
TRUNCATE signals;
BEGIN;
INSERT INTO club_members(user_id,club_id,status) VALUES
 ('75000000-0000-0000-0000-000000000005','75000000-0000-0000-0000-000000000001','active');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM signals WHERE topic='member-record:75000000-0000-0000-0000-000000000001:75000000-0000-0000-0000-000000000005')
 THEN RAISE EXCEPTION 'Membership INSERT lost'; END IF;
END $$;
COMMIT;
TRUNCATE signals;
BEGIN;
DELETE FROM club_members WHERE user_id='75000000-0000-0000-0000-000000000005';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM signals WHERE topic='member-record:75000000-0000-0000-0000-000000000001:75000000-0000-0000-0000-000000000005')
 THEN RAISE EXCEPTION 'Membership DELETE old scope lost'; END IF;
END $$;
COMMIT;
-- Moving a membership still invalidates both its old and new club scope.
INSERT INTO clubs(id,name) VALUES('76000000-0000-0000-0000-000000000001','Other no-op native fixture');
TRUNCATE signals;
BEGIN;
UPDATE club_members SET club_id='76000000-0000-0000-0000-000000000001'
 WHERE user_id='75000000-0000-0000-0000-000000000003';
DO $$ BEGIN
 IF (SELECT count(*) FROM signals)<>5
  OR NOT EXISTS(SELECT 1 FROM signals WHERE topic='member-record:75000000-0000-0000-0000-000000000001:75000000-0000-0000-0000-000000000003')
  OR NOT EXISTS(SELECT 1 FROM signals WHERE topic='member-record:76000000-0000-0000-0000-000000000001:75000000-0000-0000-0000-000000000003')
  OR NOT EXISTS(SELECT 1 FROM signals WHERE topic='member-record:75000000-0000-0000-0000-000000000001:75000000-0000-0000-0000-000000000002')
  OR EXISTS(SELECT 1 FROM signals GROUP BY topic HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'Membership UPDATE lost old or new scope'; END IF;
END $$;
COMMIT;
DO $$ DECLARE original jsonb; current_state jsonb; BEGIN
 SELECT state INTO original FROM fixture_noop_original_state;
 SELECT to_jsonb(s) INTO current_state FROM ca_private_record_transport_state s;
 IF NOT fn_private_record_transport_ready() OR current_state->'supabase_enabled' IS DISTINCT FROM original->'supabase_enabled'
  OR ((current_state->'source_fingerprints')-'public.fn_publish_member_record_row()') IS DISTINCT FROM ((original->'source_fingerprints')-'public.fn_publish_member_record_row()')
  OR current_state#>>'{source_fingerprints,public.fn_publish_member_record_row()}'<>md5(pg_get_functiondef('public.fn_publish_member_record_row()'::regprocedure))
 THEN RAISE EXCEPTION 'Source readiness or unrelated transport configuration changed'; END IF;
 IF has_function_privilege('authenticated','fn_publish_member_record_row()','EXECUTE')
  OR has_function_privilege('service_role','fn_publish_member_record_row()','EXECUTE')
 THEN RAISE EXCEPTION 'Source publisher authority widened'; END IF;
END $$;
SELECT 'PRIVATE_RECORD_NOOP_IDENTITY '||jsonb_build_object(
 'function_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),
 'acl',p.proacl::text,'security_definer',p.prosecdef,'settings',p.proconfig,
 'ready',public.fn_private_record_transport_ready(),
 'paid_enabled',(SELECT supabase_enabled FROM public.ca_private_record_transport_state WHERE singleton))::text
 FROM pg_proc p WHERE p.oid='public.fn_publish_member_record_row()'::regprocedure;
UNLISTEN ca_private_record_changes;
\echo PRIVATE_RECORD_NOOP_CHANGED PASS: real balances, existing topic dedup, upline identity, INSERT/DELETE, commit and savepoint rollback, exact transport binding and private authority
