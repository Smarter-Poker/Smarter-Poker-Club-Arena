BEGIN;
-- Populate native-only enabled horses on the existing native house boards.
ALTER TABLE profiles DISABLE TRIGGER trg_auto_connect_dan;
INSERT INTO auth.users(id) SELECT md5('midway-scale-'||i)::uuid FROM generate_series(1,1000)i;
INSERT INTO profiles(id,is_horse,horse_status) SELECT md5('midway-scale-'||i)::uuid,true,'available' FROM generate_series(1,1000)i ON CONFLICT(id) DO UPDATE SET is_horse=true,horse_status='available';
ALTER TABLE profiles ENABLE TRIGGER trg_auto_connect_dan;
SELECT set_config('app.club_membership_source','join_club',true);
INSERT INTO club_members(club_id,user_id,is_active,status,membership_lifecycle_status,chip_balance)
 SELECT c.club_id,md5('midway-scale-'||i)::uuid,true,'active','active',0 FROM generate_series(1,1000)i
 CROSS JOIN(VALUES('a0000000-0000-0000-0000-000000000001'::uuid),('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid))c(club_id);
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','complete',1,'{"success":true}');
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z' AND eligible_wallets=2003 AND paid_wallets=2003 AND budget=25.01 AND paid=25.01) THEN RAISE EXCEPTION 'scale split failed';END IF;
 IF EXISTS(SELECT FROM union_weekly_horse_promo_recipients WHERE run_id=(SELECT id FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z') AND amount NOT IN(.01,.02)) THEN RAISE EXCEPTION 'unequal scale shares';END IF;
 RAISE NOTICE 'PASS 2003 real disbursements with all deferred financial journal guards';
END $$;
ROLLBACK;
