-- 20260905230154_the_switch_confirms_before_it_pages_and_never_freezes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard, 2026-09-05 23:0x UTC):
--
-- THE RULING (mine, handed back by Dan tonight: "THAT DECISION IS YOURS").
-- The kill switch NEVER freezes a payout. It escalates, and the escalation
-- now carries its own second opinion so a person can decide in one read.
--
-- WHY NOT AUTOMATIC FREEZING, decided on the evidence rather than the
-- instinct. The asymmetry is not close:
--
--   A false freeze refuses a legitimate payout the moment it fires. Dan's
--   rule for this lane is that nothing may refuse or block a legitimate
--   payout, and a player who won is not paid until a person notices and
--   clears it. Cost: immediate, visible, and to the player.
--
--   A real leak that runs for the minutes it takes a person to read the page
--   costs, at the threshold, some hundreds of chips of HOUSE money, and every
--   chip of it is recoverable: the journal names every leg, the meters name
--   the hour, and CLAUDE.md 10.9 lets an agent settle it.
--
-- And the false alarms are not hypothetical. The supply meter read -3,305.68
-- in one hour at 03:05 today and +659.08 at 08:05; both were meter
-- REDEFINITIONS (Phase 5.1 and 5.2), not movements. An armed automatic switch
-- would have frozen every tournament payout on the platform twice in one day,
-- for nothing, while the fourteen hours since the meter became exact have all
-- been inside +/- 7. tests/law/PayoutFreezeIsHumanOnly.law.test.ts was
-- written on exactly this reasoning on 2026-09-02 and it was right.
--
-- WHAT MAKES ESCALATION GOOD ENOUGH TO BE THE ANSWER. The reason a person
-- hesitates at a page is that one reading cannot tell a leak from a
-- re-definition, and the second reading is an hour away. So the switch now
-- takes the second opinion itself, in the same second:
--
--   * a definition change or a re-base is looked for in the window: any
--     ca_mint_ledger row keyed register-opening-baseline-correction:%, and
--     any migration applied since the previous reading that re-creates the
--     meter itself (and the guard watch as a backstop). If one is there, the finding says EXPLAINED and
--     names it, and the incident is a warning rather than a critical page;
--   * the previous reading of the same meter is read and compared: same sign
--     twice is a leak that persists, opposite signs are an oscillation;
--   * the trial balance is asked whether the journal itself is short.
--
-- So the page now says, in its first line, either "CONFIRMED, nothing
-- explains it, and here is the second reading" or "EXPLAINED by <the
-- migration or correction that changed the meter>". A person opens the freeze
-- with fn_ca_open_payout_freeze on the first, and closes the tab on the
-- second. That is the control: not slower than an automatic switch by any
-- amount that matters at these sums, and it cannot refuse a payout on its own.
--
-- If the platform ever wants an automatic freeze, the honest gate for it is
-- written here rather than in a threshold: a week of hourly readings inside
-- +/- 50 with zero EXPLAINED-class findings, then arm one meter, then the
-- next. Nothing in the machinery has to change to do it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_kill_switch_trip(p_detector text, p_amount numeric, p_detail text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  pol public.ca_kill_switch_policy%ROWTYPE;
  v_inc uuid;
  v_hour text := to_char(now(), 'YYYY-MM-DD-HH24');
  v_prev numeric;
  v_prev_at timestamptz;
  v_corr text;
  v_redef text;
  v_explained text;
  v_persists boolean := false;
  v_head text;
BEGIN
  SELECT * INTO pol FROM public.ca_kill_switch_policy WHERE detector = p_detector;
  IF NOT FOUND OR NOT pol.armed OR p_amount IS NULL OR abs(p_amount) < pol.threshold_chips THEN
    RETURN false;
  END IF;

  /* THE SWITCH ESCALATES; A PERSON FREEZES (ruling 2026-09-05, on the
     evidence in this migration's header). This function must never write
     ca_payout_freeze: tests/law/PayoutFreezeIsHumanOnly.law.test.ts pins that
     the only insert into that table is inside the human opener. */

  -- The second opinion, taken now rather than an hour from now.
  IF p_detector = 'fn_ca_supply_snapshot' THEN
    SELECT s.unexplained, s.taken_at INTO v_prev, v_prev_at
      FROM public.ca_supply_snapshots s
     WHERE s.unexplained IS NOT NULL
     ORDER BY s.taken_at DESC OFFSET 1 LIMIT 1;
    v_persists := v_prev IS NOT NULL AND abs(v_prev) > pol.threshold_chips / 4 AND sign(v_prev) = sign(p_amount);
  END IF;

  SELECT string_agg(m.op_id, ', ') INTO v_corr
    FROM public.ca_mint_ledger m
   WHERE m.op_id LIKE 'register-opening-baseline-correction:%'
     AND m.created_at > COALESCE(v_prev_at, now() - interval '2 hours');

  /* A migration that re-created the meter itself, named exactly. The guard
     watch is the backstop for a change no migration explains: it captures a
     new hash within the hour, so it errs toward "explained" for at most one
     hour after a real redefinition - which is exactly the hour the false
     alarms live in. Neither suppresses the incident; both name it. */
  SELECT string_agg(m.version || ' ' || m.name, ', ') INTO v_redef
    FROM supabase_migrations.schema_migrations m
   WHERE m.version >= to_char(COALESCE(v_prev_at, now() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS')
     AND m.statements[1] LIKE '%' || p_detector || '%';
  IF v_redef IS NULL THEN
    SELECT string_agg(DISTINCT 'the guard watch saw ' || h.proname || ' change', ', ') INTO v_redef
      FROM public.ca_guard_def_history h
     WHERE h.captured_at > COALESCE(v_prev_at, now() - interval '2 hours')
       AND h.proname = p_detector;
  END IF;

  v_explained := NULLIF(concat_ws('; ',
    CASE WHEN v_corr IS NOT NULL THEN 'a labelled register correction in the window (' || v_corr || ')' END,
    CASE WHEN v_redef IS NOT NULL THEN 'the meter''s own definition changed in the window (' || v_redef || ')' END), '');

  v_head := CASE
    WHEN v_explained IS NOT NULL THEN 'EXPLAINED: ' || v_explained || '. Read it before you freeze anything: a meter that has just changed definition reads like a leak and is not one.'
    WHEN v_persists THEN 'CONFIRMED: the previous reading agreed in sign (' || round(COALESCE(v_prev, 0), 2) || ' at ' || COALESCE(v_prev_at::text, 'n/a') || ') and nothing in the window explains it. A leak persists; an oscillation flips.'
    ELSE 'UNCONFIRMED: one reading over the threshold, nothing in the window explains it, and the previous reading did not agree. Take the next reading before you freeze.'
  END;

  v_inc := public.fn_ca_raise_drift_incident(
    'fn_ca_kill_switch_trip', 'ledger_imbalance',
    CASE WHEN v_explained IS NOT NULL THEN 'warning' ELSE 'critical' END,
    'kill-switch:' || p_detector || ':' || v_hour,
    round(p_amount, 2), NULL, NULL, 'ledger', 'ca_kill_switch_policy', NULL,
    'fade0000-0000-0000-0000-000000000001', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    format('KILL SWITCH THRESHOLD CROSSED by %s: %s (threshold %s). %s Payouts are NOT frozen: open the freeze yourself with fn_ca_open_payout_freeze if this is real.',
           p_detector, p_detail, pol.threshold_chips, v_head),
    false,
    jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips,
                       'freeze', 'human only', 'verdict', split_part(v_head, ':', 1),
                       'previous_reading', v_prev, 'previous_at', v_prev_at,
                       'explained_by', v_explained, 'persists', v_persists));

  IF v_inc IS NOT NULL AND v_explained IS NULL THEN
    PERFORM public.fn_ca_incident_notify(v_inc, 'escalated',
      format('KILL SWITCH: %s read %s. %s', p_detector, round(p_amount, 2), split_part(v_head, '.', 1)), true);
  END IF;

  PERFORM public.fn_raise_server_financial_alert(
    CASE WHEN v_explained IS NOT NULL THEN 'warning' ELSE 'critical' END, 'ca_kill_switch',
    format('KILL SWITCH THRESHOLD CROSSED by %s: %s. %s', p_detector, p_detail, v_head),
    jsonb_build_object('detector', p_detector, 'amount', round(p_amount, 2), 'threshold', pol.threshold_chips,
                       'verdict', split_part(v_head, ':', 1), 'explained_by', v_explained),
    'kill-switch:' || p_detector || ':' || v_hour);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM public.fn_raise_server_financial_alert('critical', 'ca_kill_switch',
      format('KILL SWITCH by %s could not complete its paging: %s', p_detector, SQLERRM),
      jsonb_build_object('detector', p_detector), 'kill-switch-error:' || v_hour);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_kill_switch_trip(text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_kill_switch_trip(text, numeric, text) TO service_role;

COMMENT ON TABLE public.ca_kill_switch_policy IS
  'Chip standard: the threshold at which each meter ESCALATES with its own second opinion (was it explained by a register correction or a definition change; did the previous reading agree in sign). It never opens the payout freeze - a person does that, after reading the page (ruling 2026-09-05, tests/law/PayoutFreezeIsHumanOnly.law.test.ts).';

DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_kill_switch_trip') ~* 'INSERT\s+INTO\s+(public\.)?ca_payout_freeze' THEN
    RAISE EXCEPTION 'the kill switch writes the payout freeze; it must only escalate';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_kill_switch_trip') NOT LIKE '%EXPLAINED: %' THEN
    RAISE EXCEPTION 'the switch does not carry its second opinion';
  END IF;
  IF (SELECT count(*) FROM public.ca_kill_switch_policy WHERE armed) <> 3 THEN
    RAISE EXCEPTION 'the escalation is not armed on three meters';
  END IF;
END $$;

COMMIT;
