-- 20261001232452_welcome_request_activation_runs_last
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-01 23:24:52 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- First-club activation must be the final hot-table step. This transaction
-- touches only club_creation_requests: it installs the entitlement receipt FK
-- and then the offer trigger atomically, after the club-history and tournament
-- fences are already durable. Until this commits, provisioning stays inert.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.club_welcome_entitlements
  ADD CONSTRAINT club_welcome_entitlements_owner_request_fkey
  FOREIGN KEY(owner_id,creation_request_id)
  REFERENCES public.club_creation_requests(user_id,request_id) ON DELETE RESTRICT;

CREATE TRIGGER trg_offer_lifetime_first_club_welcome
AFTER INSERT ON public.club_creation_requests FOR EACH ROW
EXECUTE FUNCTION public.fn_offer_lifetime_first_club_welcome();

COMMIT;
