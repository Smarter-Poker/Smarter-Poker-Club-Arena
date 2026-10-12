-- 20261001232445_welcome_club_owner_history_runs_after_core
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-01 23:24:45 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- Production run 36940073834 proved that even after tournament DDL was split,
-- the core still timed out while acquiring a referenced hot-table lock. Keep
-- the transfer trigger, historical-owner snapshot, and entitlement club FK in
-- one clubs-only transaction: the trigger lock blocks transfers while the
-- snapshot is taken, so no owner can escape lifetime-first history.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE TRIGGER trg_remember_club_owner_transfer
AFTER UPDATE OF owner_id ON public.clubs FOR EACH ROW
EXECUTE FUNCTION public.fn_remember_club_owner_transfer();

INSERT INTO public.club_owner_creation_history
  (owner_id,first_club_id,welcome_eligible,provenance,recorded_at)
SELECT owner_id,(array_agg(id ORDER BY created_at NULLS LAST,id))[1],false,'historical',
       COALESCE(min(created_at),transaction_timestamp())
  FROM public.clubs WHERE owner_id IS NOT NULL GROUP BY owner_id
ON CONFLICT(owner_id) DO NOTHING;

ALTER TABLE public.club_welcome_entitlements
  ADD CONSTRAINT club_welcome_entitlements_club_fkey
  FOREIGN KEY(club_id) REFERENCES public.clubs(id) ON DELETE RESTRICT;

COMMIT;
