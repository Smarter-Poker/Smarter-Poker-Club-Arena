-- ONE CLAUSE CHANGED. The satellite-award CTE inside
-- fn_uncollected_entry_check looked back a MONTH; it needed the same six-hour
-- buffer the wallet-debit CTE beside it already used.
--
-- WHY IT WAS WRONG, not merely expensive. I wrote a month reasoning that "a
-- satellite seat could have been awarded long before the target event runs".
-- That confuses the target's START with the seat's CREATION.
-- fn_award_satellite_seat INSERTs the tournament_players row and the
-- rake_records row in the same statement of the same transaction, so the
-- award and the seat's registered_at are the same instant. Verified rather
-- than reasoned, across all 23 awards on the platform:
--
--     awards 23 | created_at equals registered_at 23 | worst gap 0.000000s
--
-- WHAT IT COST. rake_records carries no index on `source`, so the month-long
-- clause walked the created_at index discarding 644,620 rows to find 23.
-- Measured on the shared-buffer count, which does not move with load:
--
--     whole check, month-long awards lookback ... 231,267 buffers
--     whole check, six-hour awards lookback ...... 90,202 buffers
--
-- HOW I NEARLY GOT THIS WRONG, recorded because the mistake is more useful
-- than the fix. The first attempt at this migration also RESTRUCTURED the
-- query - cheap indexed exclusions first, anti-joins next, tournaments joined
-- by primary key last - on the strength of wall-clock timings that said 11.4s
-- before and 833ms after. Those timings were database load, not plan shape.
-- Run A/B in the same statement, seconds apart, the two forms gave 722ms and
-- 13,494ms, then 2,873ms and 1,968ms, then 691ms and 7,471ms: the variance
-- swamped the difference and it was interleaved, so neither ordering nor
-- caching explains it. On BUFFERS, which load does not move, the restructure
-- came out at 539,362 - six times WORSE than the shape it was replacing,
-- because the planner switches to a nested loop with 256,732 heap fetches.
--
-- So the restructure is discarded and only the clause that is demonstrably
-- wrong is changed. A rewrite justified by a number I could not reproduce is
-- exactly the kind of change this audit keeps finding in other people's code.
--
-- NO WALL-CLOCK ASSERTION IN THIS MIGRATION, for the same reason. A gate that
-- fails when the database is busy is a flaky gate, and a flaky gate teaches
-- everybody to re-run migrations until they pass.
--
-- ROLLBACK
--   Re-apply 20260902041336, which holds the previous body.

CREATE OR REPLACE FUNCTION public.fn_uncollected_entry_check(
  p_since_hours integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  /* 48h ceiling: double what the engine asks for (hourly, 24h). */
  v_hours   integer := LEAST(GREATEST(COALESCE(p_since_hours, 24), 1), 48);
  v_since   timestamptz;

  /* THE DAY THE EVIDENCE STARTS. log_wallet_transaction was wired into the
     tournament register path on 2026-08-19; the first `tournament_buyin` row
     in wallet_transactions is 2026-08-19 and there are none before it. An
     absent debit dated earlier than this proves the LOGGER was absent, not
     the payment - 22,981 perfectly healthy seats sit behind that date. The
     48-hour cap already makes this unreachable. It is asserted rather than
     assumed because caps get raised by people who did not read the comment. */
  c_evidence_start constant timestamptz := timestamptz '2026-08-19 00:00:00+00';

  /* ONE BUFFER, USED BY BOTH EVIDENCE CTEs, so they cannot drift apart. It
     absorbs clock skew and the edge of the window and nothing else: the wallet
     debit and the satellite award are each written in the SAME TRANSACTION as
     the seat they pay for, so neither can legitimately fall outside it.

     The awards CTE looked back a MONTH when this function first shipped, on
     the mistaken reasoning that a seat might be awarded long before its target
     event runs - which confuses the target's START with the seat's CREATION.
     rake_records has no index on `source`, so that clause walked the created_at
     index discarding 644,620 rows to find 23: 231,267 shared buffers for the
     whole check against 90,202 with this. Measured and corrected 2026-09-02.
     Verified on all 23 awards: rake_records.created_at equals
     tournament_players.registered_at exactly, worst gap 0.000000 seconds. */
  c_evidence_buffer constant interval := interval '6 hours';

  v_seats   bigint  := 0;
  v_bad     bigint  := 0;
  v_events  bigint  := 0;
  v_chips   numeric := 0;
  v_alerts  integer := 0;
  v_worst   jsonb   := '[]'::jsonb;
BEGIN
  v_since := now() - make_interval(hours => v_hours);

  IF v_since < c_evidence_start THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'window_predates_the_evidence',
      'detail', 'wallet_transactions has only carried tournament_buyin since '
                || c_evidence_start::text || '; an absent debit before that date '
                || 'means the logger did not exist, not that nobody paid',
      'since_hours', v_hours);
  END IF;

  WITH seats AS (
    SELECT tp.tournament_id, tp.user_id,
           COALESCE(tp.is_satellite_qualifier, false) AS sat_flag,
           tp.source_satellite_id,
           t.name,
           round(COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0), 2) AS charge,
           (COALESCE(t.is_xmtt, false) OR COALESCE(t.is_multi_day, false)) AS multiday,
           t.parent_tournament_id,
           COALESCE(t.day_number, 1) AS day_number
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE tp.registered_at >= v_since
       -- EXEMPTION 4: a freeroll owes no entry.
       AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
  ),
  -- EXEMPTION 1: the ordinary door, human or horse. Written in the same
  -- transaction as the seat; the buffer only absorbs the edge of the window.
  funded AS (
    SELECT DISTINCT w.related_entity_id AS tournament_id, w.user_id
      FROM public.wallet_transactions w
     WHERE w.related_entity_id IS NOT NULL
       AND w.category = 'tournament_buyin'
       AND w.type = 'debit'
       AND w.created_at >= v_since - c_evidence_buffer
  ),
  -- EXEMPTION 2: the seat IS the prize. The rake row is the durable witness
  -- that fn_award_satellite_seat ran; the two roster columns are the witness
  -- on the seat itself, and either one alone is enough. All three are kept
  -- because each has a birthday: is_satellite_qualifier has only been written
  -- since 2026-08-27 and source_satellite_id since 2026-08-30, while a
  -- zero-fee target writes no rake row at all.
  --
  -- SAME BUFFER AS `funded`, AND FOR THE SAME REASON. The award cannot fall
  -- outside the seat's own window because it is the statement that creates
  -- the seat.
  awards AS (
    SELECT DISTINCT r.tournament_id, (r.metadata->>'user_id')::uuid AS user_id
      FROM public.rake_records r
     WHERE r.source = 'fn_award_satellite_seat'
       AND r.created_at >= v_since - c_evidence_buffer
       AND r.metadata ? 'user_id'
  ),
  bad AS (
    SELECT s.*
      FROM seats s
      LEFT JOIN funded f ON f.tournament_id = s.tournament_id AND f.user_id = s.user_id
      LEFT JOIN awards a ON a.tournament_id = s.tournament_id AND a.user_id = s.user_id
     WHERE f.user_id IS NULL
       AND a.user_id IS NULL
       AND NOT s.sat_flag
       AND s.source_satellite_id IS NULL
       -- EXEMPTION 3: a day past the first is bought by surviving day one.
       AND NOT (s.multiday AND (s.day_number > 1 OR s.parent_tournament_id IS NOT NULL))
  )
  SELECT (SELECT count(*) FROM seats),
         (SELECT count(*) FROM bad),
         (SELECT count(DISTINCT tournament_id) FROM bad),
         (SELECT COALESCE(round(sum(charge), 2), 0) FROM bad),
         (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
            SELECT jsonb_build_object('tournament_id', tournament_id, 'name', max(name),
                                      'seats', count(*), 'chips', round(sum(charge), 2)) AS x
              FROM bad GROUP BY tournament_id
             ORDER BY sum(charge) DESC LIMIT 10) y)
    INTO v_seats, v_bad, v_events, v_chips, v_worst;

  /* One OPEN alert for the condition, not one per seat. On the two days this
     actually happened a per-seat alert would have filed 464 rows and buried
     itself, which is the failure the dedupe key exists to stop. */
  IF v_bad > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'critical', 'fn_uncollected_entry_check',
      format('%s seat(s) across %s event(s) in the last %sh hold a place in a paid tournament with no auditable record that the entry was paid: %s chips of entry',
             v_bad, v_events, v_hours, v_chips),
      jsonb_build_object('kind', 'uncollected_entry', 'seats', v_bad,
        'events', v_events, 'chips', v_chips, 'since_hours', v_hours,
        'seats_checked', v_seats, 'worst', v_worst,
        'exempt', 'wallet debit, satellite seat award, day-2 advancement, freeroll',
        'detail', 'no money was moved by this check',
        'known_blind_spot', 'atomic_tournament_register debits club_members.chip_balance '
          || 'directly and writes no chip_transactions and no wallet_transactions row, so a '
          || 'seat it created would appear here despite the player having paid. It has had no '
          || 'caller since 2026-08-15 (fn_register_for_tournament replaced it) and it sits on '
          || 'the fn_union_law_check watch list, so retiring it belongs to that workstream.'),
      'uncollected_entry');
    v_alerts := v_alerts + 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'since_hours', v_hours,
    'seats_checked', v_seats,
    'uncollected_entries', v_bad,
    'events', v_events,
    'chips', v_chips,
    'worst', v_worst,
    -- NOT "alerts_raised": the dedupe path returns an existing row's id, so a
    -- standing condition reports itself every pass without a new row being
    -- written. This counts CONDITIONS.
    'conditions_alerted', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_uncollected_entry_check(integer) IS
  'Phase 2 of the MTT payout audit. Reports seats in paid events with no auditable '
  'record that the entry was paid. Exempts the four legitimate funding sources by '
  'name. Moves no money. Bounded at 48h and refuses any window predating 2026-08-19. '
  'Both evidence CTEs share one 6-hour buffer because both witnesses are written in '
  'the same transaction as the seat.';

REVOKE ALL ON FUNCTION public.fn_uncollected_entry_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_uncollected_entry_check(integer) TO service_role;

DO $$
DECLARE v jsonb; v_ctrl bigint; v_src text;
BEGIN
  /* STRUCTURE, not stopwatch. Matched on the CODE literal - the first draft of
     this assertion matched the bare words and tripped on its own explanatory
     comment, which is the same class of mistake as a test that reads
     formatting. */
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_uncollected_entry_check';
  IF v_src LIKE '%interval ''30 days''%' THEN
    RAISE EXCEPTION 'the month-long awards lookback is still in the body';
  END IF;
  IF v_src NOT LIKE '%c_evidence_buffer constant interval := interval ''6 hours''%' THEN
    RAISE EXCEPTION 'the shared 6-hour evidence buffer is not declared';
  END IF;
  IF (length(v_src) - length(replace(v_src, 'v_since - c_evidence_buffer', ''))) / length('v_since - c_evidence_buffer') <> 2 THEN
    RAISE EXCEPTION 'both evidence CTEs must use the shared buffer, found a different count';
  END IF;

  SELECT public.fn_uncollected_entry_check(24) INTO v;
  IF NOT COALESCE((v->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'fn_uncollected_entry_check did not return ok: %', v;
  END IF;
  RAISE NOTICE 'fn_uncollected_entry_check(24) = %', v;

  /* POSITIVE CONTROL. A body made cheaper by being made blind must not land. */
  WITH seats AS (
    SELECT tp.tournament_id, tp.user_id,
           COALESCE(tp.is_satellite_qualifier,false) AS sat_flag, tp.source_satellite_id,
           (COALESCE(t.is_xmtt,false) OR COALESCE(t.is_multi_day,false)) AS multiday,
           t.parent_tournament_id, COALESCE(t.day_number,1) AS day_number
      FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
     WHERE tp.registered_at >= '2026-08-19' AND tp.registered_at < '2026-08-21'
       AND COALESCE(t.buy_in_amount,0)+COALESCE(t.buy_in_fee,0) > 0),
  funded AS (
    SELECT DISTINCT w.related_entity_id AS tournament_id, w.user_id
      FROM public.wallet_transactions w
     WHERE w.related_entity_id IS NOT NULL AND w.category='tournament_buyin'
       AND w.type='debit' AND w.created_at >= '2026-08-18' AND w.created_at < '2026-08-22'),
  awards AS (
    SELECT DISTINCT r.tournament_id, (r.metadata->>'user_id')::uuid AS user_id
      FROM public.rake_records r
     WHERE r.source='fn_award_satellite_seat' AND r.metadata ? 'user_id'
       AND r.created_at >= '2026-08-18' AND r.created_at < '2026-08-22')
  SELECT count(*) INTO v_ctrl
    FROM seats s
    LEFT JOIN funded f ON f.tournament_id=s.tournament_id AND f.user_id=s.user_id
    LEFT JOIN awards a ON a.tournament_id=s.tournament_id AND a.user_id=s.user_id
   WHERE f.user_id IS NULL AND a.user_id IS NULL
     AND NOT s.sat_flag AND s.source_satellite_id IS NULL
     AND NOT (s.multiday AND (s.day_number>1 OR s.parent_tournament_id IS NOT NULL));

  IF v_ctrl <> 464 THEN
    RAISE EXCEPTION
      'positive control returned % unfunded seats in the known-bad window, expected 464', v_ctrl;
  END IF;
  RAISE NOTICE 'positive control: % seats, as expected', v_ctrl;
END $$;
