-- ═══════════════════════════════════════════════════════════════════════════
-- THE LEDGER GOING SILENT MUST BE LOUD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FOUND 2026-08-26. `public.chip_ledger` — the audit trail every chip in the
-- system is reconciled against — last recorded a row on 2026-05-03. That is
-- 115 days. In the 24 hours before this migration was written the platform
-- played 461,278 hands and changed 611 member balances.
--
-- Not one of the 59 money-moving functions in this database writes to it.
-- Checked by inspecting prosrc for every function matching buyin / cashout /
-- transfer / add_chips / leave_seat / atomic_*: `writes_ledger` was false on
-- every single one.
--
-- WHY NOBODY NOTICED, which is the part this migration actually fixes:
--
--   `reconcile_ledger_nightly()` has reported 575 CRITICAL rows every night
--   for at least ten consecutive nights. Every one of them is a
--   `player_wallet` row comparing `public.wallets` — frozen since
--   2026-08-21 00:59:34, zero writes in the five days before this migration,
--   732,591,994.33 chips stranded in it — against a ledger that stopped a
--   month earlier. Two dead things, compared nightly, disagreeing by exactly
--   46,316,237.17 on 2026-08-25 and again on 2026-08-26. Identical to the
--   cent, because neither side can move.
--
--   A check that fires 575 times every night is not a check. It is noise
--   with a severity column. The real signal — that the audit trail had
--   flatlined — had nowhere to appear that anyone would look.
--
-- WHAT THIS MIGRATION DOES, AND DELIBERATELY DOES NOT DO:
--
--   It does NOT move a chip, repair the ledger, or touch
--   `club_members.chip_balance`, `table_seats.stack`, `public.wallets` or
--   `clubs.chip_pool`. Re-instrumenting the money paths and deciding what to
--   do about the 115-day gap are Dan's calls — the same source-of-truth
--   judgment that `docs/audit/phase4-1-2-ledger-drift-finding.md` flagged as
--   needing a human, and the reason that document's remediation was staged.
--
--   It adds the DETECTOR that should have existed: a check that asks whether
--   the ledger is recording at all, given that the tables are busy. Once the
--   money paths are instrumented, this is what stops the same silence from
--   lasting 115 days a second time.
--
-- Tier 2 (additive: one new function, no DDL on existing objects, no data
-- change). No rollback section required — `DROP FUNCTION IF EXISTS
-- public.fn_ledger_liveness();` reverses it completely.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ledger_liveness()
RETURNS TABLE (
  severity           text,
  hands_last_24h     bigint,
  balance_moves_24h  bigint,
  ledger_rows_24h    bigint,
  ledger_last_row_at timestamptz,
  silent_for_days    integer,
  finding            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hands   bigint;
  v_moves   bigint;
  v_ledger  bigint;
  v_last    timestamptz;
  v_days    integer;
  v_sev     text;
  v_finding text;
BEGIN
  SELECT count(*) INTO v_hands
    FROM public.hand_history WHERE created_at > now() - interval '24 hours';

  SELECT count(*) INTO v_moves
    FROM public.club_members WHERE updated_at > now() - interval '24 hours';

  SELECT count(*), max(created_at) INTO v_ledger, v_last
    FROM public.chip_ledger WHERE created_at > now() - interval '24 hours';

  IF v_last IS NULL THEN
    SELECT max(created_at) INTO v_last FROM public.chip_ledger;
  END IF;

  v_days := GREATEST(0, EXTRACT(DAY FROM (now() - COALESCE(v_last, now())))::integer);

  /* The invariant, stated plainly: if chips moved, the ledger must have
     recorded something. Activity is measured on BOTH the felt (hands) and
     the live pool (club_members balance changes), because a table can be
     busy without a buy-in and a buy-in can happen with no hand dealt. Either
     one alone is enough to expect ledger rows. */
  IF (v_hands > 0 OR v_moves > 0) AND v_ledger = 0 THEN
    v_sev := 'critical';
    v_finding := format(
      'THE AUDIT TRAIL IS NOT RECORDING. %s hands and %s balance changes in 24h, '
      || '0 chip_ledger rows. Last ledger entry: %s (%s days ago). Every chip '
      || 'that moved since then moved unaudited.',
      v_hands, v_moves, COALESCE(v_last::text, 'NEVER'), v_days);
  ELSIF (v_hands > 0 OR v_moves > 0) AND v_ledger < GREATEST(1, (v_moves / 10)) THEN
    /* Partially instrumented: some paths write, most do not. Worth seeing
       early rather than after another quarter. */
    v_sev := 'warn';
    v_finding := format(
      'The ledger is recording, but thinly: %s rows against %s balance changes in 24h. '
      || 'Some money paths are probably still bypassing chip_ledger.',
      v_ledger, v_moves);
  ELSIF v_hands = 0 AND v_moves = 0 THEN
    v_sev := 'ok';
    v_finding := 'Quiet period: nothing moved, so nothing was expected in the ledger.';
  ELSE
    v_sev := 'ok';
    v_finding := format('Ledger recording normally: %s rows in 24h.', v_ledger);
  END IF;

  severity           := v_sev;
  hands_last_24h     := v_hands;
  balance_moves_24h  := v_moves;
  ledger_rows_24h    := v_ledger;
  ledger_last_row_at := v_last;
  silent_for_days    := v_days;
  finding            := v_finding;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.fn_ledger_liveness() IS
  'Is the chip audit trail recording at all? Added 2026-08-26 after chip_ledger '
  'was found silent since 2026-05-03 (115 days) while the platform played '
  '461,278 hands in 24h, with nothing anywhere noticing. Reads only; moves no '
  'chips. Call it from the nightly reconcile handler and treat critical as a '
  'page, not a log line.';

REVOKE ALL ON FUNCTION public.fn_ledger_liveness() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_ledger_liveness() TO service_role, authenticated;

-- ── Assertions. The migration aborts if its own premises are wrong. ────────
DO $$
DECLARE
  v_sev  text;
  v_days integer;
BEGIN
  SELECT severity, silent_for_days INTO v_sev, v_days FROM public.fn_ledger_liveness();

  IF v_sev IS NULL THEN
    RAISE EXCEPTION 'fn_ledger_liveness returned no row';
  END IF;

  /* This is the assertion that matters. At the moment of writing, the correct
     answer is CRITICAL — the ledger really is silent. If this migration is
     ever replayed against a database where the ledger is healthy, the
     function should say so and this block must not fail; hence the notice
     rather than an exception on the ok path. */
  IF v_sev = 'critical' THEN
    RAISE NOTICE 'fn_ledger_liveness: CRITICAL as expected — ledger silent for % days.', v_days;
  ELSE
    RAISE NOTICE 'fn_ledger_liveness: severity=% (ledger appears healthy here).', v_sev;
  END IF;
END $$;
