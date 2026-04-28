-- Phase X fix: The rakeback_periods table had a check constraint allowing only
-- ('open', 'closed', 'claiming', 'claimed') but fn_create_settlement_period
-- inserts status='pending' and fn_close_settlement_period updates to status='paid'.
-- This migration widens the constraint to include all needed lifecycle statuses.

ALTER TABLE public.rakeback_periods DROP CONSTRAINT IF EXISTS rakeback_periods_status_check;

ALTER TABLE public.rakeback_periods ADD CONSTRAINT rakeback_periods_status_check
  CHECK (status IN ('pending', 'open', 'closed', 'claiming', 'claimed', 'paid', 'expired'));

DO $$ BEGIN RAISE NOTICE '✅ rakeback_periods status check constraint fixed — now allows pending, open, closed, claiming, claimed, paid, expired'; END $$;
