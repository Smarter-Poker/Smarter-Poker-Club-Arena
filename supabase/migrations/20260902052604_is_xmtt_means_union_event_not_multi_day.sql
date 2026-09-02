-- I READ is_xmtt AS "MULTI-DAY" AND IT MEANS "UNION EVENT".
--
-- fn_uncollected_entry_check (Phase 2) exempts a seat from the
-- was-this-entry-paid-for question when the event is a day past the first.
-- The predicate I wrote was:
--
--     multiday := <the union flag> OR is_multi_day
--     ... AND NOT (multiday AND (day_number > 1 OR parent_tournament_id IS NOT NULL))
--
-- That flag is set as `!!schedule.union_id`. It means the event belongs to a
-- UNION. 815 events carry it. It has nothing to do with days or flights, and
-- putting it in a predicate named `multiday` states something false about 815
-- live rows to every future reader of this function.
--
-- IT WAS NOT WRONG IN EFFECT, and this migration says so plainly rather than
-- dressing a tidy-up as a bug fix. The exemption is an AND: it also required
-- `day_number > 1 OR parent_tournament_id IS NOT NULL`, and both of those are
-- zero across every tournament ever created here. So the exemption has never
-- fired, on a union event or anything else, and no seat has ever been excused
-- by it. What was wrong is what the code SAYS.
--
-- THE CORRECTED PREDICATE drops the badge columns entirely and keeps the two
-- that actually identify a later day. is_multi_day and total_days paint the
-- lobby; day_number and parent_tournament_id are what a Day 2 would BE.
--
-- UNREACHABLE BY CONSTRUCTION, AS OF THE MIGRATION BEFORE THIS ONE.
-- trg_tournaments_refuse_unbuilt_multi_day now refuses all seven multi-day
-- columns, so nothing can set day_number or parent_tournament_id at all. The
-- exemption is kept rather than deleted because it is the CORRECT rule for the
-- day this is built, and deleting it would leave whoever implements Day 2
-- needing to remember it. Delete this note when that happens.
--
-- A NOTE ON THE ASSERTION AT THE BOTTOM, because I got it wrong twice in one
-- session. Asserting that a name is ABSENT from a function body has to match
-- the CODE form of the name, not the bare word: the bare word also appears in
-- the prose explaining why it was removed, so the first draft of this
-- migration refused itself. The assertion matches the column reference.
--
-- ROLLBACK
--   Re-apply 20260902050552, which holds the previous body.

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
           /* A LATER DAY IS day_number OR parent_tournament_id, AND NOTHING
              ELSE. This used to also read the union flag, which is set from
              schedule.union_id and means UNION event, not multi-day - 815 live
              rows carry it. is_multi_day and total_days paint the lobby badge;
              these two are what a Day 2 would actually BE. */
           (COALESCE(t.day_number, 1) > 1 OR t.parent_tournament_id IS NOT NULL) AS later_day
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
       /* EXEMPTION 3: a day past the first is bought by surviving day one.
          UNREACHABLE BY CONSTRUCTION as of 20260902052302, which made
          trg_tournaments_refuse_unbuilt_multi_day refuse day_number and
          parent_tournament_id along with the five other multi-day columns. It
          is kept because it is the CORRECT rule for the day Day 2 is built,
          and deleting it would leave whoever builds it needing to remember.
          Delete this note in that commit; the exemption becomes live. */
       AND NOT s.later_day
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
  'The day-2 exemption reads day_number and parent_tournament_id only: the union '
  'flag means UNION event, not multi-day.';

REVOKE ALL ON FUNCTION public.fn_uncollected_entry_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_uncollected_entry_check(integer) TO service_role;

DO $$
DECLARE v jsonb; v_ctrl bigint; v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_uncollected_entry_check';

  /* THE COLUMN REFERENCE, not the bare word - the bare word appears in the
     prose that explains why the column was removed, and the first draft of
     this migration refused itself on its own explanation. */
  IF v_src LIKE '%t.is_xmtt%' OR v_src LIKE '%COALESCE(t.is_multi_day%' THEN
    RAISE EXCEPTION 'a badge column is still being read as a later-day test';
  END IF;
  IF v_src NOT LIKE '%COALESCE(t.day_number, 1) > 1 OR t.parent_tournament_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'the corrected later-day predicate is not present';
  END IF;
  /* The earlier corrections must survive this one. */
  IF v_src LIKE '%interval ''30 days''%' THEN
    RAISE EXCEPTION 'the month-long awards lookback came back';
  END IF;
  IF (length(v_src) - length(replace(v_src, 'v_since - c_evidence_buffer', ''))) / length('v_since - c_evidence_buffer') <> 2 THEN
    RAISE EXCEPTION 'both evidence CTEs must still use the shared buffer';
  END IF;

  SELECT public.fn_uncollected_entry_check(24) INTO v;
  IF NOT COALESCE((v->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'fn_uncollected_entry_check did not return ok: %', v;
  END IF;
  RAISE NOTICE 'fn_uncollected_entry_check(24) = %', v;

  /* POSITIVE CONTROL, unchanged: the known-bad window must still return 464. */
  WITH seats AS (
    SELECT tp.tournament_id, tp.user_id,
           COALESCE(tp.is_satellite_qualifier,false) AS sat_flag, tp.source_satellite_id,
           (COALESCE(t.day_number,1) > 1 OR t.parent_tournament_id IS NOT NULL) AS later_day
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
     AND NOT s.sat_flag AND s.source_satellite_id IS NULL AND NOT s.later_day;

  IF v_ctrl <> 464 THEN
    RAISE EXCEPTION
      'positive control returned % unfunded seats in the known-bad window, expected 464', v_ctrl;
  END IF;
  RAISE NOTICE 'positive control: % seats, as expected', v_ctrl;
END $$;
