-- ===========================================================================
--  PHASE 5.3 - A PAIR THAT KEEPS MEETING HEADS-UP IS WORTH LOOKING AT
-- ===========================================================================
--
-- The heads-up audit recorded: "No re-entry or cooldown limits on duels. Lose,
-- re-enter the same board immediately, repeat. No cooldown, no daily cap, no
-- same-opponent limit. Combined with a dead chip-dump detector that is
-- precisely the shape a dumping pair would use."
--
-- The chip-dump detector is NOT dead - fn_ca_collusion_scan shipped on
-- 2026-08-31 and its cron ca-collusion-daily is active and running. But it
-- groups by SHARED HANDS from ca_hand_transfers, and it needs 20 of them
-- before it looks. Two accounts that meet in eight separate duels, each a
-- handful of hands long, never reach that floor - the repetition itself is
-- the signal, and nothing was measuring it.
--
-- WHAT THIS IS NOT. It does not block, cap, cool down, or refuse anything. A
-- re-entry limit is a product decision about how people are allowed to play,
-- and that is Dan's to set, not an agent's. This only measures and reports.
--
-- CALIBRATION, from the live board rather than from a guess. Duels completed
-- in the seven days to 2026-09-01 18:00 UTC, 10,134 of them:
--
--     met 1x   6,454 pairs
--     met 2x   1,106
--     met 3x     222
--     met 4x      40
--     met 5x       7      <- the most any pair has ever met
--     met 6x+      0
--
-- The floor is EIGHT, sixty percent above the observed maximum, and it must
-- coincide with a win share of 0.8 or better. Win share alone is worthless
-- down there: 6,454 pairs met once and every one of them has a "100% win
-- rate". Both conditions together produce zero rows against the whole live
-- board today, which is the point - 5.2's lesson is that a flag which fires
-- on everything says nothing (169,523 legacy rows cleared at an average
-- suspicion of 96.8).
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). There is no is_horse predicate here
-- and there must not be one. A horse pair meeting eight times with an eighty
-- percent win share is a fleet problem worth the same look, and the board the
-- calibration above was measured on is horse-heavy already.
--
-- Signals land in ca_collusion_signals beside the chip-flow ones so there is
-- one review surface, with detail->>'signal' saying which detector wrote the
-- row and what hands_together means for it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_ca_duel_pairing_scan(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(p_days, 1));
  -- See the calibration block above before touching either number.
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
             count(*)                                   AS meetings,
             count(*) FILTER (WHERE winner = ua)        AS wins_a,
             sum(buy_in)                                AS gross_flow,
             -- Winner-take-all: the winner receives the loser's buy-in.
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

    -- Reported, never actioned, and on the same incident path the chip-flow
    -- scan uses. Warning only for a lopsided real-account pairing; everything
    -- else is information a human can look at when they choose to.
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

-- Fifteen minutes after the chip-flow scan, so the two land in the same
-- review window without contending for the same read.
SELECT cron.schedule('ca-duel-pairing-daily', '35 4 * * *',
  $$SELECT public.fn_ca_duel_pairing_scan(7)$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT v.kind, v.a, v.b, v.note, true FROM (VALUES
 ('cron', 'ca-duel-pairing-daily', NULL,
  'daily heads-up repeat-pairing signal (>=8 meetings and >=0.8 win share; signals only, no action)')
) AS v(kind, a, b, note)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory g WHERE g.object_a = v.a);
