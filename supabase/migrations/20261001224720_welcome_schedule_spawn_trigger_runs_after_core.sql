-- 20261001224720_welcome_schedule_spawn_trigger_runs_after_core
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-01 22:47:20 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- The core migration intentionally leaves all DDL on existing hot tables
-- detached. Install the tournament fence first, the owner-transfer history
-- trigger second, and the first-club offer last in this atomic transaction,
-- after the core has released every earlier schema/auth lock. This prevents
-- the auth -> tournaments cycle proven by production installer run
-- 36936895662, avoids the clubs lock timeout proven by run 36940073834, and
-- keeps provisioning fail-closed until every required fence is present.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE TRIGGER trg_fence_welcome_package_schedule_spawn
BEFORE INSERT ON public.tournaments FOR EACH ROW
EXECUTE FUNCTION public.fn_fence_welcome_package_schedule_spawn();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES (
  'tournaments',
  'trg_fence_welcome_package_schedule_spawn',
  'Reviewed October 1: this owner-package fence moves no chips and changes no tournament value. It serializes a scheduled tournament insert with the package item and schedule rows, then refuses only when the exact preloaded schedule has been retired or disabled so reset cannot resurrect it.'
)
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;

CREATE TRIGGER trg_remember_club_owner_transfer
AFTER UPDATE OF owner_id ON public.clubs FOR EACH ROW
EXECUTE FUNCTION public.fn_remember_club_owner_transfer();

CREATE TRIGGER trg_offer_lifetime_first_club_welcome
AFTER INSERT ON public.club_creation_requests FOR EACH ROW
EXECUTE FUNCTION public.fn_offer_lifetime_first_club_welcome();

COMMIT;
