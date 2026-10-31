-- A real PostgreSQL listener and the paid-provider capture both remain quiet.
LISTEN ca_private_record_changes;
TRUNCATE signals;
BEGIN;
UPDATE club_members SET chip_balance=chip_balance,promo_balance=promo_balance,notes=notes
 WHERE user_id='75000000-0000-0000-0000-000000000003';
UPDATE profiles SET alias=alias,status=status WHERE id='75000000-0000-0000-0000-000000000002';
UPDATE table_seats SET left_at=left_at WHERE user_id='75000000-0000-0000-0000-000000000003';
UPDATE agents SET agent_wallet_balance=agent_wallet_balance WHERE user_id='75000000-0000-0000-0000-000000000003';
UPDATE ca_club_rake_daily_user SET rake_cents=rake_cents WHERE user_id='75000000-0000-0000-0000-000000000003';
UPDATE ca_club_member_tournament_fee_daily SET fees=fees WHERE user_id='75000000-0000-0000-0000-000000000003';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Identical private source UPDATE emitted a signal'; END IF;
 IF coalesce(nullif(current_setting('ca.member_record_signaled_topics',true),''),'[]')::jsonb<>'[]'::jsonb
  OR coalesce(nullif(current_setting('ca.roster_signaled_clubs',true),''),'[]')::jsonb<>'[]'::jsonb
 THEN RAISE EXCEPTION 'No-op update consumed a transaction topic'; END IF;
END $$;
COMMIT;
UNLISTEN ca_private_record_changes;
\echo PRIVATE_RECORD_NOOP_QUIET PASS: all six row trigger owners, NULLs and balances, paid capture empty, transaction topics untouched
