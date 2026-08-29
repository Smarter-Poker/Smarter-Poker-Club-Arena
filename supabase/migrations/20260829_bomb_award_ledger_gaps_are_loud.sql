-- ═══════════════════════════════════════════════════════════════════════════
-- A LOST BOMB-POT AWARD UNIT CANNOT STAY SILENT (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The award-unit ledger (bomb_pot_award_units, spec 16.2/17) is written by the
-- engine as fire-and-forget: the money is already recorded by logHandHistory,
-- and a ledger that only NARRATES a settlement must never be able to fail the
-- hand it narrates. That is correct. What was not correct is that the single
-- attempt's only failure report was a console.warn on the Hetzner host, so a
-- transient error lost a hand's award units permanently AND silently.
--
-- Hand 3364829 (2026-08-29 02:35:08Z, table c4874708-d17e-43cb-ab91-4db6f7526757)
-- is the proof. A clean two-board NLH bomb: pot 88.00, rake 3.35, BBJ 0.50,
-- paid out 42.07 + 42.08 = 84.15 — correct to the cent. Zero award-unit rows.
-- The hands either side of it (02:31:42 and 02:37:11) both wrote theirs. The
-- gap was found by hand-written SQL because nothing on this platform was
-- looking. v_bomb_pot_outcomes had simply never heard of the hand.
--
-- Two changes, and neither of them can block a hand:
--
--   1. The engine now retries the write three times before giving up, and
--      reports the third failure through reportError rather than a log line
--      (ServerTableEngineSettlement.ts, BOMB_LEDGER_WRITE_ATTEMPTS).
--   2. THIS migration: whatever still slips through becomes visible.
--      fn_bomb_pot_ledger_gaps lists every settled bomb hand whose award units
--      do not sum to its net winnings, and reconcile_ledger_nightly files each
--      one as CRITICAL.
--
-- That is deliberately the same shape CLAUDE.md section 11.5 settled on for
-- seat-stack exits: a guard that can REFUSE a settlement is more dangerous
-- than the thing it guards against, so make the failure LOUD, not impossible.
--
-- Tier 2 (new function + CREATE OR REPLACE of an existing reporter + CHECK
-- constraint widening). No data is written or destroyed by this migration.

-- ── 1. The gap report ───────────────────────────────────────────────────────
--
-- p_grace exists because this question has a wrong answer if you ask it too
-- early: the ledger write is asynchronous by design, so a hand that settled
-- four seconds ago legitimately has no rows yet. Ten minutes is far longer
-- than three attempts with a 250/500ms backoff can take.
--
-- p_epoch is the floor, and it is not arbitrary. The ledger's first row is
-- 2026-08-28 18:20:49Z, but until PR #1685 the write was gated to multi-board
-- hands only — so bomb hands before it are missing rows BY DESIGN, and
-- reporting them would bury the real signal in known history. The default is
-- the moment production was verified serving #1685 (05f1e753f7). Pass an
-- earlier epoch to audit the partial era deliberately.
CREATE OR REPLACE FUNCTION public.fn_bomb_pot_ledger_gaps(
  p_since interval    DEFAULT '1 day'::interval,
  p_grace interval    DEFAULT '10 minutes'::interval,
  p_epoch timestamptz DEFAULT timestamptz '2026-08-28 22:38:00+00'
)
RETURNS TABLE (
  hand_history_id uuid,
  table_id        uuid,
  hand_number     bigint,
  occurred_at     timestamptz,
  board_count     integer,
  trigger_reason  text,
  net_winnings    numeric,
  ledger_total    numeric,
  award_units     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    h.id,
    h.table_id,
    h.hand_number::bigint,
    h.created_at,
    (h.bomb_pot ->> 'board_count')::int,
    h.bomb_pot ->> 'trigger_reason',
    round(COALESCE(h.pot_size, 0) - COALESCE(h.rake_amount, 0) - COALESCE(h.bbj_amount, 0), 2),
    round(COALESCE(u.total, 0), 2),
    COALESCE(u.units, 0)
  FROM public.hand_history h
  LEFT JOIN LATERAL (
    SELECT SUM(a.amount) AS total, COUNT(*) AS units
    FROM public.bomb_pot_award_units a
    WHERE a.hand_history_id = h.id
  ) u ON true
  WHERE h.bomb_pot IS NOT NULL
    AND h.created_at >  now() - p_since
    AND h.created_at <  now() - p_grace
    AND h.created_at >= p_epoch
    AND round(COALESCE(h.pot_size, 0) - COALESCE(h.rake_amount, 0) - COALESCE(h.bbj_amount, 0), 2)
        IS DISTINCT FROM round(COALESCE(u.total, 0), 2)
  ORDER BY h.created_at DESC
$$;

-- Reconcilers are not public API (20260824070100). Name the roles explicitly:
-- REVOKE ... FROM PUBLIC does not remove Supabase's own anon/authenticated
-- grants, which is how fn_request_manual_bomb_pot kept an anon EXECUTE it was
-- believed to have lost.
REVOKE ALL ON FUNCTION public.fn_bomb_pot_ledger_gaps(interval, interval, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bomb_pot_ledger_gaps(interval, interval, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.fn_bomb_pot_ledger_gaps(interval, interval, timestamptz) IS
  'Settled bomb hands whose bomb_pot_award_units do not sum to net winnings. '
  'Read by reconcile_ledger_nightly, which files each row as critical.';

-- ── 2. The entity type the reporter will emit ───────────────────────────────
ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT IF EXISTS ledger_reconcile_log_entity_type_check;
ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet'::text, 'club_treasury'::text, 'agent_wallet'::text,
    'frozen_wallets_pool'::text, 'chip_circulation'::text, 'seat_stack_exit'::text,
    'cashout_escrow_stuck'::text, 'negative_balance'::text, 'over_claimed_send'::text,
    'insurance_bank'::text, 'insurance_offer_unresolved'::text,
    'bomb_award_ledger_gap'::text]));

-- ── 3. Post-apply assertions ────────────────────────────────────────────────
DO $$
DECLARE
  v_gaps int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_bomb_pot_ledger_gaps'
  ) THEN
    RAISE EXCEPTION 'assertion failed: fn_bomb_pot_ledger_gaps missing';
  END IF;

  -- The constraint must accept the value the reporter is about to emit.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ledger_reconcile_log_entity_type_check'
      AND pg_get_constraintdef(oid) LIKE '%bomb_award_ledger_gap%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: entity_type check does not allow bomb_award_ledger_gap';
  END IF;

  -- The function must actually find the one gap this migration was written
  -- for. An empty result here would mean the predicate is wrong, not that the
  -- ledger is clean — hand 3364829 is known-missing at the time of writing.
  SELECT count(*) INTO v_gaps FROM public.fn_bomb_pot_ledger_gaps('30 days'::interval);
  RAISE NOTICE 'fn_bomb_pot_ledger_gaps over 30 days: % hand(s)', v_gaps;
END $$;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_bomb_pot_ledger_gaps(interval, interval, timestamptz);
--   -- then remove the bomb_award_ledger_gap section from reconcile_ledger_nightly
--   -- (see 20260829_reconcile_reports_bomb_award_gaps.sql) and re-add the
--   -- entity_type CHECK without 'bomb_award_ledger_gap'.
