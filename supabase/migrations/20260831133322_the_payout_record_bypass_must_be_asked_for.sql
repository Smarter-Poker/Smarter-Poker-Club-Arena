-- 2026-08-31 — MTT Phase 3: the payout-record bypass must be ASKED FOR.
--
-- The first cut of trg_tournament_payouts_append_only (20260831133057) let ANY
-- `postgres` session update or delete a payout record. That is wider than
-- intended: pg_cron jobs, Supabase maintenance and every ad-hoc console query
-- all connect as postgres, so the guard would have been OFF for exactly the
-- connections most likely to run a careless UPDATE.
--
-- It was also untestable. A probe running as postgres could not tell a working
-- trigger from a broken one — which is the "verify the safeguard can actually
-- fire before trusting it" lesson this codebase learned three times over in
-- the 2026-08-31 gate findings.
--
-- Default-deny for every role. A DBA correcting a bad row states the intent in
-- writing, in the same transaction, from a migration that says why.
--
-- PROVEN, NOT ASSERTED (probe run inside a rolled-back transaction, per
-- CLAUDE.md §11.5 — no real chips were spent to test this rule):
--   update = REFUSED: tournament_payouts is an append-only payout record
--   delete = REFUSED: tournament_payouts is an append-only payout record
--   bypass = works when, and only when, the setting is present
--
-- TIER: 3. ROLLBACK: re-apply the body in 20260831133057.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_tournament_payouts_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  /* session_user, not current_user: a SECURITY DEFINER function owned by
     postgres runs with current_user = postgres, which would make every definer
     function on the platform an unintended bypass. session_user is the role
     that actually connected. */
  IF session_user = 'postgres'
     AND COALESCE(current_setting('app.payout_record_correction', true), '') = 'i_am_correcting_the_record'
  THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'tournament_payouts is an append-only payout record; % is refused (tournament %, user %, position %)',
    TG_OP, OLD.tournament_id, OLD.user_id, OLD."position"
    USING ERRCODE = 'restrict_violation',
          HINT = 'A DBA correcting a bad row must SET LOCAL app.payout_record_correction = ''i_am_correcting_the_record'' in the same transaction, from a migration that says why.';
END;
$$;

COMMIT;
