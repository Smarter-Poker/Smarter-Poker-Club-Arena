-- 20260908230001_legacy_played_seat_first_games_are_adopted_as_running
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 15:12:42 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- WHAT WAS WRONG
-- ----------------
-- The pre-atomic seat-first manager could create and fill a Spin or heads-up
-- Sit & Go, deal real hands and advance its blind clock, then lose the final
-- parent status write.  Stage A correctly made future creation/launch atomic,
-- but it also means those already-played parents are no longer eligible for a
-- new launch: they have no tournament_launch_receipt because their hands
-- predate that protocol.  Leaving the parent REGISTERING hides a live game
-- from manager resume and prevents the terminal 1-player cases from reaching
-- the normal atomic finish path.
--
-- WHAT WAS MEASURED (2026-09-08, immediately before this migration)
-- -----------------------------------------------------------------
-- Exactly 39 parents now make up the surviving immutable incident cohort: 22
-- three-seat Spins and 17 two-seat Sit & Go heads-up games, with 870 accepted
-- hands.  The first measurement contained 23 additional Spins and 588 hands;
-- all 23 were subsequently cancelled together at 2026-09-08 16:00 UTC through
-- the canonical all-entrant refund boundary, so a historical adoption must not
-- revive them.  The locked predicate below independently excludes them.
-- Every one has its full original roster, only playing/eliminated statuses,
-- one running table, an exact active-seat pointer for every playing row, a
-- persisted level clock and finalized prize pool.  None has a launch, place,
-- satellite, final-table-deal, bounty-completion or finish receipt, and none
-- has a fresh tournament/table lease.  28 already have one player left; 11
-- have two.  The ordered tournament-id cohort hashes to
-- 3d7f10f5150526e93c8e302837da8f9f6a8265f4fcb6d0d83870b0c44de77aec.
--
-- WHAT THIS DOES
-- --------------
-- This is one bounded, forward-only adoption of that exact cohort.  It takes
-- the tournament table's ACCESS EXCLUSIVE lock before selecting candidates,
-- locks every parent/roster/table row NOWAIT, re-proves the complete incident
-- fingerprint, then changes only tournaments.status and started_at.  The
-- start instant is the first immutable accepted hand; current_level and
-- level_started_at are deliberately preserved.  The ordinary launch guard is
-- disabled only while this locked transaction performs the historical
-- adoption and is re-enabled before commit.  No launch receipt is invented,
-- no roster/seat/wallet/payout row is changed, and the postcondition compares
-- every other tournament field byte-for-byte with its captured value.
--
-- Stage A prevents a new member of this cohort from being created.  This is a
-- one-time data correction, not a repair function, retry, sweep or cron.

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '45s';

/* Lock in the estate's catalog -> authority -> game order. SHARE ROW
   EXCLUSIVE prevents a stale manager heartbeat/takeover from becoming fresh
   after the no-owner proof; NOWAIT refuses the cutover instead of waiting
   across a live manager request. */
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases,
           public.engine_table_leases
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

/*
 * The trigger deliberately requires a real atomic-launch receipt for every
 * ordinary REGISTERING -> RUNNING transition.  These games were already
 * played before that receipt type existed, so satisfying it with a fabricated
 * row would corrupt the audit trail.  ACCESS EXCLUSIVE is already required by
 * this exact trigger toggle; it also prevents a manager/hand writer crossing
 * the cohort proof.  The catalog change and data change are one transaction,
 * so another session never observes the guard disabled.
 */
ALTER TABLE public.tournaments
  DISABLE TRIGGER zz_freeze_launch_guard;

CREATE TEMP TABLE ca_legacy_played_seat_first_adoption (
  tournament_id uuid PRIMARY KEY,
  first_hand_at timestamptz NOT NULL,
  hand_count integer NOT NULL,
  prior_row jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO ca_legacy_played_seat_first_adoption (
  tournament_id,
  first_hand_at,
  hand_count,
  prior_row
)
SELECT
  t.id,
  hand.first_hand_at,
  hand.hand_count,
  to_jsonb(t)
FROM public.tournaments t
CROSS JOIN LATERAL (
  SELECT min(h.created_at) AS first_hand_at,
         count(*)::integer AS hand_count
    FROM public.hand_history h
   WHERE h.tournament_id = t.id
) hand
WHERE t.status = 'REGISTERING'
  AND (
    COALESCE(t.variant, '') = 'spin'
    OR (COALESCE(t.variant, '') = 'sng' AND t.max_players = 2)
  )
  AND t.started_at IS NULL
  AND t.current_level IS NOT NULL
  AND t.level_started_at IS NOT NULL
  AND hand.first_hand_at IS NOT NULL
  AND (
    SELECT count(*)
      FROM public.tournament_players p
     WHERE p.tournament_id = t.id
  ) = t.max_players
  AND NOT EXISTS (
    SELECT 1
      FROM public.tournament_players p
     WHERE p.tournament_id = t.id
       AND p.status NOT IN ('playing', 'eliminated')
  )
  AND (
    SELECT count(*)
      FROM public.tournament_players p
     WHERE p.tournament_id = t.id
       AND p.status = 'playing'
  ) BETWEEN 1 AND t.max_players
  AND (
    SELECT count(*)
      FROM public.tables tb
     WHERE tb.tournament_id = t.id
       AND COALESCE(tb.is_deleted, false) = false
       AND tb.status = 'running'
  ) = 1
  AND (
    SELECT count(*)
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE tb.tournament_id = t.id
       AND s.left_at IS NULL
  ) = (
    SELECT count(*)
      FROM public.tournament_players p
     WHERE p.tournament_id = t.id
       AND p.status = 'playing'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.tournament_players p
     WHERE p.tournament_id = t.id
       AND p.status = 'playing'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tables pointed
           JOIN public.table_seats s ON s.table_id = pointed.id
          WHERE pointed.id = p.table_id
            AND pointed.tournament_id = p.tournament_id
            AND COALESCE(pointed.is_deleted, false) = false
            AND pointed.status = 'running'
            AND s.seat_number = p.seat_number
            AND s.user_id = p.user_id
            AND s.left_at IS NULL
       )
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_finish_receipts r
     WHERE r.tournament_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_place_settlement_batches r
     WHERE r.tournament_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_satellite_settlement_batches r
     WHERE r.tournament_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_final_table_deal_receipts r
     WHERE r.tournament_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_completion_receipts r
     WHERE r.tournament_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = t.id
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.tables tb
      JOIN public.engine_table_leases l ON l.table_id = tb.id
     WHERE tb.tournament_id = t.id
       AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
  );

DO $prove_exact_incident_cohort$
DECLARE
  v_count integer;
  v_hand_count integer;
  v_spin_count integer;
  v_heads_up_count integer;
  v_hash text;
BEGIN
  SELECT count(*),
         COALESCE(sum(a.hand_count), 0),
         count(*) FILTER (WHERE t.variant = 'spin'),
         count(*) FILTER (WHERE t.variant = 'sng' AND t.max_players = 2),
         encode(
           extensions.digest(
             convert_to(string_agg(a.tournament_id::text, ',' ORDER BY a.tournament_id), 'UTF8'),
             'sha256'
           ),
           'hex'
         )
    INTO v_count, v_hand_count, v_spin_count, v_heads_up_count, v_hash
    FROM ca_legacy_played_seat_first_adoption a
    JOIN public.tournaments t ON t.id = a.tournament_id;

  IF v_count IS DISTINCT FROM 39
     OR v_hand_count IS DISTINCT FROM 870
     OR v_spin_count IS DISTINCT FROM 22
     OR v_heads_up_count IS DISTINCT FROM 17
     OR v_hash IS DISTINCT FROM
          '3d7f10f5150526e93c8e302837da8f9f6a8265f4fcb6d0d83870b0c44de77aec' THEN
    RAISE EXCEPTION
      'legacy seat-first adoption refused: cohort moved (count %, hands %, Spins %, heads-up %, hash %)',
      v_count, v_hand_count, v_spin_count, v_heads_up_count, v_hash;
  END IF;
END;
$prove_exact_incident_cohort$;

/* Parent -> roster -> table -> seat matches tournament lifecycle order. */
DO $lock_and_reprove_exact_cohort$
DECLARE
  v_count integer;
BEGIN
  PERFORM 1
    FROM public.tournaments t
    JOIN ca_legacy_played_seat_first_adoption a ON a.tournament_id = t.id
   ORDER BY t.id
   FOR UPDATE OF t NOWAIT;

  PERFORM 1
    FROM public.tournament_players p
    JOIN ca_legacy_played_seat_first_adoption a ON a.tournament_id = p.tournament_id
   ORDER BY p.tournament_id, p.user_id
   FOR UPDATE OF p NOWAIT;

  PERFORM 1
    FROM public.tables tb
    JOIN ca_legacy_played_seat_first_adoption a ON a.tournament_id = tb.tournament_id
   ORDER BY tb.tournament_id, tb.id
   FOR UPDATE OF tb NOWAIT;

  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
    JOIN ca_legacy_played_seat_first_adoption a ON a.tournament_id = tb.tournament_id
   ORDER BY tb.tournament_id, s.seat_number
   FOR UPDATE OF s NOWAIT;

  /* Re-prove mutable prerequisites after every relevant row is owned. */
  SELECT count(*) INTO v_count
    FROM ca_legacy_played_seat_first_adoption a
    JOIN public.tournaments t ON t.id = a.tournament_id
   WHERE t.status = 'REGISTERING'
     AND t.started_at IS NULL
     AND (
       COALESCE(t.variant, '') = 'spin'
       OR (COALESCE(t.variant, '') = 'sng' AND t.max_players = 2)
     )
     AND t.current_level IS NOT NULL
     AND t.level_started_at IS NOT NULL
     AND (
       SELECT min(h.created_at)
         FROM public.hand_history h
        WHERE h.tournament_id = t.id
     ) = a.first_hand_at
     AND (
       SELECT count(*)
         FROM public.hand_history h
        WHERE h.tournament_id = t.id
     ) = a.hand_count
     AND (
       SELECT count(*)
         FROM public.tournament_players p
        WHERE p.tournament_id = t.id
     ) = t.max_players
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = t.id
          AND p.status NOT IN ('playing', 'eliminated')
     )
     AND (
       SELECT count(*)
         FROM public.tournament_players p
        WHERE p.tournament_id = t.id
          AND p.status = 'playing'
     ) BETWEEN 1 AND t.max_players
     AND (
       SELECT count(*)
         FROM public.tables tb
        WHERE tb.tournament_id = t.id
          AND COALESCE(tb.is_deleted, false) = false
          AND tb.status = 'running'
     ) = 1
     AND (
       SELECT count(*)
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = t.id
          AND s.left_at IS NULL
     ) = (
       SELECT count(*)
         FROM public.tournament_players p
        WHERE p.tournament_id = t.id
          AND p.status = 'playing'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = t.id
          AND p.status = 'playing'
          AND NOT EXISTS (
            SELECT 1
              FROM public.tables pointed
              JOIN public.table_seats s ON s.table_id = pointed.id
             WHERE pointed.id = p.table_id
               AND pointed.tournament_id = p.tournament_id
               AND COALESCE(pointed.is_deleted, false) = false
               AND pointed.status = 'running'
               AND s.seat_number = p.seat_number
               AND s.user_id = p.user_id
               AND s.left_at IS NULL
          )
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_finish_receipts r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_place_settlement_batches r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlement_batches r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_final_table_deal_receipts r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_completion_receipts r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.engine_tournament_leases l
        WHERE l.tournament_id = t.id
          AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.tables tb
         JOIN public.engine_table_leases l ON l.table_id = tb.id
        WHERE tb.tournament_id = t.id
          AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     );

  IF v_count IS DISTINCT FROM 39 THEN
    RAISE EXCEPTION
      'legacy seat-first adoption refused: only % of 39 rows still satisfy the locked boundary',
      v_count;
  END IF;
END;
$lock_and_reprove_exact_cohort$;

DO $adopt_exact_cohort$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.tournaments t
     SET status = 'RUNNING',
         started_at = a.first_hand_at,
         updated_at = clock_timestamp()
    FROM ca_legacy_played_seat_first_adoption a
   WHERE t.id = a.tournament_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated IS DISTINCT FROM 39 THEN
    RAISE EXCEPTION
      'legacy seat-first adoption updated % rows instead of 39', v_updated;
  END IF;
END;
$adopt_exact_cohort$;

ALTER TABLE public.tournaments
  ENABLE TRIGGER zz_freeze_launch_guard;

DO $assert_adoption_postconditions$
DECLARE
  v_good integer;
BEGIN
  SELECT count(*) INTO v_good
    FROM ca_legacy_played_seat_first_adoption a
    JOIN public.tournaments t ON t.id = a.tournament_id
   WHERE t.status = 'RUNNING'
     AND t.started_at = a.first_hand_at
     AND (to_jsonb(t) - ARRAY['status', 'started_at', 'updated_at']::text[])
           = (a.prior_row - ARRAY['status', 'started_at', 'updated_at']::text[])
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_finish_receipts r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_place_settlement_batches r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_satellite_settlement_batches r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_final_table_deal_receipts r
        WHERE r.tournament_id = t.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_completion_receipts r
        WHERE r.tournament_id = t.id
     );

  IF v_good IS DISTINCT FROM 39 THEN
    RAISE EXCEPTION
      'legacy seat-first adoption postcondition failed for % of 39 rows',
      39 - v_good;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_trigger tg
     WHERE tg.tgrelid = 'public.tournaments'::regclass
       AND tg.tgname = 'zz_freeze_launch_guard'
       AND NOT tg.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'the ordinary tournament launch guard was not restored';
  END IF;
END;
$assert_adoption_postconditions$;

COMMIT;

-- ROLLBACK
-- Do not move an adopted game back to REGISTERING: that recreates the outage.
-- A pre-commit failure rolls this whole migration, including the trigger state,
-- back automatically.  After commit, the normal manager/finish path owns each
-- game and its immutable status/settlement receipts.
