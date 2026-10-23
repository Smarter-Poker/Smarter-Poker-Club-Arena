CREATE OR REPLACE FUNCTION public.fn_ledger_liveness()
 RETURNS TABLE(severity text, hands_last_24h bigint, balance_moves_24h bigint, ledger_rows_24h bigint, ledger_last_row_at timestamp with time zone, silent_for_days integer, finding text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
