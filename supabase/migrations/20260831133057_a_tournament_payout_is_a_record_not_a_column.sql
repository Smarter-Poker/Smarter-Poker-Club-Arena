-- 2026-08-31 — MTT Phase 3: a tournament payout is a RECORD, not a column.
--
-- WHAT WAS WRONG
--
-- Across 44,091 COMPLETED tournaments (29,056 Spin, 13,481 SNG, 1,556 MTT) the
-- only evidence that a player finished 3rd and was paid 42.50 was two MUTABLE
-- columns on tournament_players: `position` and `prize`. No paid-at timestamp,
-- no idempotency key, no snapshot of the structure that priced the place, no
-- field size to say what that structure was trimmed to. 52,847 prize payments,
-- none of them evidenced. Any later write to tournament_players — a rebalance,
-- a rescue, a late-reg pool finalisation — silently rewrote history, and this
-- repo's own comment history is a list of exactly that class of bug.
--
-- tournament_payouts already existed but was NOT a general payout record: its
-- sole writer was fn_final_table_deal and its sole reader the stuck-COMPLETING
-- watchdog, which checks it to avoid paying structure prizes over an agreed
-- chop. It had 0 rows because 0 deals have ever been made, so that guard had
-- never once been exercised. This migration makes it the record every payout
-- path writes.
--
-- WHY APPEND-ONLY IS ENFORCED IN THE DATABASE AND NOT BY CONVENTION
--
-- A record the application can rewrite is not evidence, it is a cache. The
-- trigger refuses UPDATE and DELETE for every role INCLUDING postgres. The one
-- way through is for a DBA to declare the intent in the same transaction:
--     SET LOCAL app.payout_record_correction = 'i_am_correcting_the_record';
-- because an absolutely immutable table with a mistake in it is worse than a
-- correctable one, and a correction that must be written down leaves its own
-- trail. The engine (service_role) cannot rewrite a payout under any
-- circumstance, which is the property that matters.
--
-- (The bypass condition arrives in 20260831133322; this file's first cut let
-- any postgres session through on the strength of the role alone. See that
-- migration for why that was wrong and untestable.)
--
-- WHY THE RLS READ POLICY IS NARROWED IN THE SAME MIGRATION
--
-- The existing policy was `tpay_read FOR SELECT TO authenticated USING (true)`.
-- Harmless on an empty table; a privacy breach the instant the record is
-- populated, because every logged-in user could then read every prize every
-- player has ever been paid. It is narrowed HERE, before the first row lands,
-- to the three audiences with a reason to look: the player themself, somebody
-- who played the same event (the payout list of a tournament you were in is
-- ordinary poker information), and club administration.
--
-- The table also carried `anon=arwdxtm` and `authenticated=arwdxtm` grants —
-- INSERT, UPDATE and DELETE. Nothing was exploitable, because RLS is
-- fail-closed and neither role had a write policy. But that is one lock doing
-- all the work, which is the shape of the privilege bug found on 2026-08-31 in
-- fn_club_set_member_role. Both are revoked.
--
-- TIER: 3 (alters a money-adjacent table, changes an RLS policy, adds a
-- restricting trigger). ROLLBACK verbatim at the bottom.

BEGIN;

/* This ALTER needs an AccessExclusiveLock on a table the live engine reads on
   every stuck-COMPLETING sweep. The first attempt deadlocked against exactly
   that (40P01). A bounded lock_timeout makes the failure a clean retry rather
   than a deadlock kill. */
SET LOCAL lock_timeout = '8s';

ALTER TABLE public.tournament_payouts
  ADD COLUMN IF NOT EXISTS idempotency_key   text,
  ADD COLUMN IF NOT EXISTS paid_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS tournament_type   text,
  ADD COLUMN IF NOT EXISTS field_size        integer,
  ADD COLUMN IF NOT EXISTS prize_pool        numeric,
  ADD COLUMN IF NOT EXISTS payout_structure  jsonb,
  ADD COLUMN IF NOT EXISTS recorded_by       text;

COMMENT ON COLUMN public.tournament_payouts.idempotency_key IS
  'The wallet_credit_idempotency key the money moved under. Unique: this is what makes a retried credit, a recovery-watchdog payment and the main path converge on ONE record instead of three.';
COMMENT ON COLUMN public.tournament_payouts.paid_at IS
  'When the record was written. tournament_players has no payment timestamp at all, which is why "when was this paid" was previously unanswerable.';
COMMENT ON COLUMN public.tournament_payouts.field_size IS
  'Entrants the structure was trimmed to when this place was priced. Without it a payout cannot be re-derived, because the structure is trimmed to the field.';
COMMENT ON COLUMN public.tournament_payouts.payout_structure IS
  'Snapshot of the structure that produced this amount. A structure edited later must not be able to change what the evidence says was paid.';
COMMENT ON COLUMN public.tournament_payouts.recorded_by IS
  'Which path wrote the row: credit_and_log | final_table_deal | backfill_2026_08_31 | backfill_ledger_2026_08_31.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_payouts_idempotency_key
  ON public.tournament_payouts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tournament_payouts_tournament_position
  ON public.tournament_payouts (tournament_id, "position");

CREATE INDEX IF NOT EXISTS idx_tournament_payouts_user_paid_at
  ON public.tournament_payouts (user_id, paid_at DESC);

CREATE OR REPLACE FUNCTION public.fn_tournament_payouts_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF session_user = 'postgres' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'tournament_payouts is an append-only payout record; % is refused (tournament %, user %, position %)',
    TG_OP, OLD.tournament_id, OLD.user_id, OLD."position"
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_tournament_payouts_append_only ON public.tournament_payouts;
CREATE TRIGGER trg_tournament_payouts_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_payouts
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_payouts_are_append_only();

DROP POLICY IF EXISTS tpay_read ON public.tournament_payouts;

CREATE POLICY tpay_read_self_field_or_staff ON public.tournament_payouts
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = tournament_payouts.tournament_id
         AND tp.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.tournaments t
       WHERE t.id = tournament_payouts.tournament_id
         AND t.club_id IS NOT NULL
         AND public.fn_is_club_admin_uid(t.club_id)
    )
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.tournament_payouts FROM anon, authenticated;
REVOKE SELECT ON public.tournament_payouts FROM anon;

COMMIT;

-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_tournament_payouts_append_only ON public.tournament_payouts;
-- DROP FUNCTION IF EXISTS public.fn_tournament_payouts_are_append_only();
-- DROP POLICY IF EXISTS tpay_read_self_field_or_staff ON public.tournament_payouts;
-- CREATE POLICY tpay_read ON public.tournament_payouts
--   FOR SELECT TO authenticated USING (true);
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_payouts TO anon, authenticated;
-- DROP INDEX IF EXISTS public.uq_tournament_payouts_idempotency_key;
-- DROP INDEX IF EXISTS public.idx_tournament_payouts_tournament_position;
-- DROP INDEX IF EXISTS public.idx_tournament_payouts_user_paid_at;
-- ALTER TABLE public.tournament_payouts
--   DROP COLUMN IF EXISTS idempotency_key, DROP COLUMN IF EXISTS paid_at,
--   DROP COLUMN IF EXISTS tournament_type, DROP COLUMN IF EXISTS field_size,
--   DROP COLUMN IF EXISTS prize_pool, DROP COLUMN IF EXISTS payout_structure,
--   DROP COLUMN IF EXISTS recorded_by;
-- COMMIT;
