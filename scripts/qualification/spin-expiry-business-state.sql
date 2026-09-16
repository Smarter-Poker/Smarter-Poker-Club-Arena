-- SOURCE ONLY / UNRUN. Read-only observations in an admitted disposable fixture.
-- Temporary helpers are observations, never replacement financial authorities.
CREATE FUNCTION pg_temp.spin_expiry_business_state() RETURNS jsonb
LANGUAGE plpgsql AS $capture$
DECLARE n text; rows jsonb; answer jsonb := '{}'::jsonb;
BEGIN
  FOREACH n IN ARRAY ARRAY[
    'tournaments','tables','table_seats','tournament_players',
    'tournament_escrow','club_members','wallet_transactions','chip_ledger',
    'tournament_refund_entitlements','tournament_refund_tranches',
    'tournament_obligations','tournament_cancellation_receipts',
    'tournament_tickets','tournament_spin_cancellation_unwinds',
    'spin_bonus_pools','spin_reserve_ledger','spin_draw_receipts',
    'tournament_launch_receipts','hand_history'
  ] LOOP
    -- A large or absent provider relation is insufficient setup, never empty.
    EXECUTE format('SELECT COALESCE(jsonb_agg(r ORDER BY r::text),''[]''::jsonb)
      FROM (SELECT to_jsonb(x) r FROM public.%I x LIMIT 1001) bounded',n) INTO rows;
    IF jsonb_array_length(rows)>1000 THEN
      RAISE EXCEPTION 'spin expiry business: relation bound exceeded: %',n;
    END IF;
    answer:=answer||jsonb_build_object(n,rows);
    IF octet_length(answer::text)>2097152 THEN
      RAISE EXCEPTION 'spin expiry business: selected state exceeds 2 MiB';
    END IF;
  END LOOP;
  RETURN answer;
END;
$capture$;

CREATE FUNCTION pg_temp.spin_expiry_fixture(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $fixture$
DECLARE v_minutes integer; ids uuid[]; t public.tournaments%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM public.spin_fill_policy)<>1 THEN
    RAISE EXCEPTION 'spin expiry business: require one actual policy row';
  END IF;
  SELECT unfilled_timeout_minutes INTO v_minutes FROM public.spin_fill_policy;
  IF v_minutes IS NULL OR v_minutes<=0 THEN
    RAISE EXCEPTION 'spin expiry business: no actual positive age policy';
  END IF;
  -- Exact candidate predicate, at this observation's clock. Requiring exactly
  -- one candidate removes created_at ties and excludes unrelated cancellation.
  SELECT array_agg(q.id ORDER BY q.created_at) INTO ids FROM (
    SELECT x.id,x.created_at FROM public.tournaments x
    WHERE x.variant='spin' AND x.status IN ('REGISTERING','ANNOUNCED')
      AND x.started_at IS NULL
      AND EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id
        WHERE b.tournament_id=x.id AND s.left_at IS NULL
          AND s.joined_at<now()-make_interval(mins=>v_minutes))
      AND (SELECT count(*) FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id
        WHERE b.tournament_id=x.id AND s.left_at IS NULL)<COALESCE(x.max_players,3)
  ) q;
  IF ids IS DISTINCT FROM ARRAY[p_id] THEN
    RAISE EXCEPTION 'spin expiry business: require the one exact eligible owned fixture';
  END IF;
  SELECT * INTO STRICT t FROM public.tournaments WHERE id=p_id;
  IF (SELECT count(*) FROM public.tournaments WHERE variant='spin')<>1
     OR t.max_players IS DISTINCT FROM 3 OR t.buy_in_amount IS NULL OR t.buy_in_amount<=0
     OR COALESCE(t.spin_multiplier,0)>0
     OR (SELECT count(*) FROM public.tables WHERE tournament_id=p_id)<>1
     OR (SELECT count(*) FROM public.table_seats s JOIN public.tables b ON b.id=s.table_id
         WHERE b.tournament_id=p_id AND s.left_at IS NULL)<>2
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_id)<>2
     OR EXISTS(SELECT 1 FROM public.spin_reserve_ledger WHERE tournament_id=p_id)
     OR EXISTS(SELECT 1 FROM public.spin_draw_receipts WHERE tournament_id=p_id)
     OR EXISTS(SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id=p_id)
     OR EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts WHERE tournament_id=p_id)
     OR EXISTS(SELECT 1 FROM public.hand_history h LEFT JOIN public.tables b ON b.id=h.table_id
         WHERE h.tournament_id=p_id OR b.tournament_id=p_id) THEN
    RAISE EXCEPTION 'spin expiry business: require undrawn two-seat paid-fixture topology';
  END IF;
  -- These observations are NOT a funding receipt validator. The actual refund
  -- authority proves its rails on cancellation; independent provider custody
  -- must additionally bind original creator/authenticated purchases and capital.
  RETURN jsonb_build_object('observed_at',clock_timestamp(),'policy_minutes',v_minutes,
    'candidate_ids',ids,'parent',to_jsonb(t),
    'seats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.table_seats s
      JOIN public.tables b ON b.id=s.table_id WHERE b.tournament_id=p_id),
    'entries',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.tournament_players p
      WHERE p.tournament_id=p_id),
    'entitlements',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
      FROM public.tournament_refund_entitlements e WHERE e.tournament_id=p_id));
END;
$fixture$;
