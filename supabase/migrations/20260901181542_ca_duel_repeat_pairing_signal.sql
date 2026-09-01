-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901181542; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_ca_duel_pairing_scan(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(p_days, 1));
  -- Calibrated on the live board 2026-09-01: of 10,134 duels in 7 days the
  -- most any pair met is 5 (6,454 met once, 1,106 twice, 222 three times,
  -- 40 four times, 7 five times). Eight is 60% above that maximum, and the
  -- win share must hold too - win share alone is worthless down there,
  -- because every pair that met once has a "100% win rate".
  v_min_meetings   constant int     := 8;
  v_min_win_share  constant numeric := 0.8;
  r RECORD; v_flagged int := 0;
BEGIN
  FOR r IN
    WITH duels AS (
      SELECT t.id, COALESCE(t.buy_in_amount, 0) AS buy_in
        FROM public.tournaments t
       WHERE t.max_players = 2
         AND t.status = 'COMPLETED'
         AND t.started_at > v_since
    ),
    met AS (
      SELECT LEAST(a.user_id, b.user_id)    AS ua,
             GREATEST(a.user_id, b.user_id) AS ub,
             CASE WHEN a.position = 1 THEN a.user_id ELSE b.user_id END AS winner,
             d.buy_in
        FROM duels d
        JOIN public.tournament_players a ON a.tournament_id = d.id
        JOIN public.tournament_players b ON b.tournament_id = d.id
                                        AND b.user_id > a.user_id
    ),
    pairflow AS (
      SELECT ua, ub,
             count(*)                            AS meetings,
             count(*) FILTER (WHERE winner = ua) AS wins_a,
             sum(buy_in)                         AS gross_flow,
             sum(CASE WHEN winner = ua THEN buy_in ELSE -buy_in END) AS net_to_ua
        FROM met
       GROUP BY 1, 2
    )
    SELECT CASE WHEN wins_a * 2 >= meetings THEN ua ELSE ub END AS receiver,
           CASE WHEN wins_a * 2 >= meetings THEN ub ELSE ua END AS sender,
           meetings,
           gross_flow,
           abs(net_to_ua) AS net_flow,
           round(GREATEST(wins_a, meetings - wins_a)::numeric / meetings, 3) AS win_share
      FROM pairflow
     WHERE meetings >= v_min_meetings
       AND GREATEST(wins_a, meetings - wins_a)::numeric / meetings >= v_min_win_share
  LOOP
    v_flagged := v_flagged + 1;

    INSERT INTO public.ca_collusion_signals
      (window_days, user_a, user_b, hands_together, gross_flow, net_flow,
       direction_ratio, both_cert, detail)
    VALUES
      (p_days, r.receiver, r.sender, r.meetings, r.gross_flow, r.net_flow,
       r.win_share,
       public.fn_ca_is_cert_account(r.receiver) AND public.fn_ca_is_cert_account(r.sender),
       jsonb_build_object(
         'signal', 'duel_repeat_pairing',
         'since', v_since,
         'note', 'hands_together is DUELS together for this detector, not hands; '
                 || 'direction_ratio is the winner share of those duels',
         'min_meetings', v_min_meetings,
         'min_win_share', v_min_win_share));

    PERFORM public.fn_ca_raise_drift_incident(
      p_source          => 'fn_ca_duel_pairing_scan',
      p_classification  => 'unknown',
      p_severity        => CASE
                             WHEN r.win_share >= 0.9
                              AND NOT (public.fn_ca_is_cert_account(r.receiver)
                                   AND public.fn_ca_is_cert_account(r.sender))
                             THEN 'warning' ELSE 'info' END,
      p_dedupe_key      => 'duelpair:' || r.receiver::text || ':' || r.sender::text
                           || ':' || to_char(now(), 'IYYY-IW'),
      p_discrepancy     => r.net_flow,
      p_expected        => NULL,
      p_actual          => NULL,
      p_layer           => 'reporting',
      p_entity_type     => 'user',
      p_entity_id       => r.receiver,
      p_club_id         => NULL,
      p_union_id        => NULL,
      p_table_id        => NULL,
      p_tournament_id   => NULL,
      p_hand_id         => NULL,
      p_settlement_id   => NULL,
      p_wallet_ids      => NULL,
      p_transaction_ids => NULL,
      p_suspected_cause => 'the same two accounts met heads-up ' || r.meetings
                           || ' times in ' || p_days || 'd and one side won '
                           || round(r.win_share * 100) || '% of them ('
                           || r.net_flow || ' chips net) - review the pair; '
                           || 'no automatic action taken',
      p_ledger_balanced => true,
      p_metadata        => jsonb_build_object(
                             'receiver', r.receiver, 'sender', r.sender,
                             'meetings', r.meetings, 'gross_flow', r.gross_flow,
                             'net_flow', r.net_flow, 'win_share', r.win_share));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'window_days', p_days,
                            'min_meetings', v_min_meetings,
                            'min_win_share', v_min_win_share,
                            'pairs_flagged', v_flagged);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_duel_pairing_scan(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-duel-pairing-daily', '35 4 * * *',
  $$SELECT public.fn_ca_duel_pairing_scan(7)$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT v.kind, v.a, v.b, v.note, true FROM (VALUES
 ('cron', 'ca-duel-pairing-daily', NULL,
  'daily heads-up repeat-pairing signal (>=8 meetings and >=0.8 win share; signals only, no action)')
) AS v(kind, a, b, note)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory g WHERE g.object_a = v.a);
