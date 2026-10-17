-- The previous accounting book is still certifying. The weekly business
-- payout must commit without calling its potentially long continuation.
INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result)
 VALUES('fade0000-0000-0000-0000-000000000001','2026-10-05 07:00Z','2026-10-12 07:00Z','2026-10-12 09:00Z','running',1,'{"success":false,"stage":"certifying","chunk_committed":true}');
-- The harness supplies the future Monday through the due function default;
-- all function bodies and money guards remain exact production source.
BEGIN;
SELECT set_config('app.ledger_settlement','native-previous-weekly-round',true);
DO $$ DECLARE r jsonb;BEGIN
 r:=public.fn_union_settlement_cascade_due();
 IF r->>'advanced' IS DISTINCT FROM 'true' OR r->>'owns_tick' IS DISTINCT FROM 'true'
  OR (r->'weekly_horse_promo'->>'paid')::numeric<>50.01
  OR (r->'weekly_horse_promo'->>'eligible_wallets')::int<>4 THEN RAISE EXCEPTION 'weekly tick did not own payout %',r;END IF;
 IF current_setting('app.ledger_settlement',true)<>'native-previous-weekly-round' THEN RAISE EXCEPTION 'tick leaked previous ledger declaration';END IF;
 IF NOT EXISTS(SELECT FROM union_accounting_runs WHERE period_end='2026-10-12 07:00Z' AND status='running' AND result->>'stage'='certifying') THEN RAISE EXCEPTION 'payout modified unfinished book';END IF;
 IF EXISTS(SELECT FROM union_accounting_runs WHERE period_end='2026-10-19 07:00Z') THEN RAISE EXCEPTION 'payout depends on completed book';END IF;
 RAISE NOTICE 'PASS real owning weekly tick pays while old book certifies, before any close continuation';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
DO $$ DECLARE r jsonb;BEGIN
 r:=public.fn_midway_weekly_horse_promo_due('2026-10-19 07:00Z');
 IF r->>'advanced' IS DISTINCT FROM 'false' OR r->>'reason' IS DISTINCT FROM 'already_paid' THEN RAISE EXCEPTION 'scheduled replay moved money %',r;END IF;
 RAISE NOTICE 'PASS scheduled replay and later completed book share one immutable weekly payment';
END $$;
-- Remove only the native historical certifying fixture before the boundary
-- cases; no money receipt is removed and the next tests close the paid week.
DELETE FROM union_accounting_runs WHERE period_end='2026-10-12 07:00Z';
