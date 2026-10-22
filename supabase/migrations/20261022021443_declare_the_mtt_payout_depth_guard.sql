-- Declares ca_mtt_payout_depth_guard on public.tournaments (created by 20261022014607).
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.tournaments'::regclass
                  AND tgname = 'ca_mtt_payout_depth_guard' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'ca_mtt_payout_depth_guard is not installed as expected';
  END IF;
  IF pg_get_functiondef('public.fn_ca_mtt_payout_depth_guard()'::regprocedure)
       ~* '(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)' THEN
    RAISE EXCEPTION 'fn_ca_mtt_payout_depth_guard writes rows; review before declaring';
  END IF;
END $pre$;
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('tournaments', 'ca_mtt_payout_depth_guard',
  'Dan 2026-10-21: every MTT pays the top 12.5% of the field. BEFORE INSERT OR UPDATE OF payout_depth_percent, payout_percent: sets NEW.payout_depth_percent only (12.5 for Midway, union and Diamond Arena MTTs; a standalone club''s choice, default 12.5; NULL for Spins, Sit & Gos and satellites; frozen once the prize pool is finalized). Writes no other row and moves no chips.')
ON CONFLICT DO NOTHING;
COMMIT;