-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827010125; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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

  IF (v_hands > 0 OR v_moves > 0) AND v_ledger = 0 THEN
    v_sev := 'critical';
    v_finding := format(
      'THE AUDIT TRAIL IS NOT RECORDING. %s hands and %s balance changes in 24h, '
      || '0 chip_ledger rows. Last ledger entry: %s (%s days ago). Every chip '
      || 'that moved since then moved unaudited.',
      v_hands, v_moves, COALESCE(v_last::text, 'NEVER'), v_days);
  ELSIF (v_hands > 0 OR v_moves > 0) AND v_ledger < GREATEST(1, (v_moves / 10)) THEN
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
  'Is the chip audit trail recording at all? Added 2026-08-26 after chip_ledger was found silent since 2026-05-03 (115 days) while the platform played 461,278 hands in 24h, with nothing anywhere noticing. Reads only; moves no chips. Call it from the nightly reconcile handler and treat critical as a page, not a log line.';

REVOKE ALL ON FUNCTION public.fn_ledger_liveness() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_ledger_liveness() TO service_role, authenticated;

DO $$
DECLARE
  v_sev  text;
  v_days integer;
BEGIN
  SELECT severity, silent_for_days INTO v_sev, v_days FROM public.fn_ledger_liveness();

  IF v_sev IS NULL THEN
    RAISE EXCEPTION 'fn_ledger_liveness returned no row';
  END IF;

  IF v_sev = 'critical' THEN
    RAISE NOTICE 'fn_ledger_liveness: CRITICAL as expected -- ledger silent for % days.', v_days;
  ELSE
    RAISE NOTICE 'fn_ledger_liveness: severity=% (ledger appears healthy here).', v_sev;
  END IF;
END $$;
