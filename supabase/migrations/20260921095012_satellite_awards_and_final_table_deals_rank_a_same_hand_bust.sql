-- 20260921095012_satellite_awards_and_final_table_deals_rank_a_same_hand_bust
--
-- Reserved by scripts/new-migration.mjs on 2026-09-21 09:50:12 UTC.
-- Written and proved against bodies read from production 2026-09-21 (read-only).
-- Amended (second pass, 2026-09-21 11:15 UTC, NOT yet applied) after the first
-- pass was refused by its own post-image assertion in production: this database
-- grants service_role EXECUTE on every new function by default privilege, so
-- revoking only PUBLIC, anon and authenticated left the helper holding a grant
-- the assertion did not expect. The grant is now restated explicitly and
-- asserted, so the helper's authority is the same on a database with that
-- default and on one without. Nothing was applied by the refused pass.
--
-- DO NOT APPLY INSIDE MINUTE :50-:03 UTC. That is the hourly break window: the
-- database refuses DDL in it (ca_break_window_refuses_ddl). Apply once, after
-- :03, never in a retry loop.
--
-- THE DEFECT. `elimination_sequence` is stamped by a trigger when a knockout
-- door RECORDS a bust. It is the recording order, not the finishing order. The
-- two agree only while players bust one at a time. When two or more players
-- bust in the SAME hand, the order their rows happened to be written in decides
-- nothing about who finished higher: TDA ranks them by the stack each player
-- STARTED that hand with - the smaller stack busts first and finishes lower.
--
-- Satellite awards are the sharpest case. A satellite seat is a fixed award and
-- the bubble is exactly this boundary, so a wrong order hands a seat to the
-- wrong player. Final-table deals that pay by position have the same exposure.
--
-- THE RULE THIS ADOPTS is not new. It is the rule the cash ladder has paid by
-- since 20260911062048 (a_bust_is_ranked_by_when_it_happened), authored in
-- docs/laws.d/a-bust-is-ranked-by-when-it-happened.md and
-- server/src/tournament/bustOrder.ts, which said of the two authorities changed
-- here: "Satellites and final-table deals settle through their own
-- authorities ... which still number places by elimination_sequence - the
-- recording order. The rule above is not yet theirs." This migration makes it
-- theirs, with the SAME expression fn_settle_tournament_places already uses:
--
--   a bust is timed by the commit time of the accepted hand that took the
--   stack (hand_atomic_commits.committed_at), or, where the hand-history prune
--   has deleted that commit row, by the hand's first generation capture; busts
--   in one hand are separated by one microsecond each in
--   (stack_before, eliminated_user_id) order, so the smaller hand-start stack
--   sorts earlier and finishes lower and an equal-stack tie falls to user id;
--   a row with no such witness keeps its eliminated_at; equal times still fall
--   back to elimination_sequence, then id.
--
-- That expression is lifted verbatim into one new STABLE helper,
-- public.fn_ca_tournament_bust_at(uuid, uuid), so the two ladders read one
-- authority instead of two copies, and the six bodies below change by exactly
-- one ORDER BY each (three in the deal authority, which repeats one ladder in
-- its write and in its two verifications).
--
-- BLAST RADIUS (read from production 2026-09-21, read-only; this migration
-- writes NO data). 3,634 hands in 2,193 tournaments ever busted more than one
-- player at once. Of the COMPLETED events settled by the authorities below, 57
-- satellites and 2 deal-enabled events contain such a hand. Re-deriving their
-- ladders under the rule above moves 118 eliminated rows in 25 satellites.
-- NONE of those rows is at or above a place that was paid: all 86 satellite
-- award rows across the 52 affected events that have them, all 33 place
-- obligations across the 7 that have them, and every recorded satellite
-- bubble_user_id already name the player the corrected order names. No deal
-- has ever been struck in production (0 proposals, 0 executions, 0 receipts),
-- so the deal authority's exposure is entirely prospective. No money went to
-- the wrong player, and nothing here repairs or repays anything.
--
-- WHAT THIS CHANGES. One new function; six existing functions replaced with
-- the same signatures, owner, SECURITY DEFINER, settings and grants, and
-- nothing else in them touched. Total MTT/satellite entries remain uncapped:
-- no field-size maximum is introduced, read or relied on anywhere below.

BEGIN;

-- ---------------------------------------------------------------------------
-- PRE-IMAGE GUARD. Refuse to run against a tree this change did not inspect.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_assert_satellite_cohort_standings'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid'
       AND md5(p.prosrc) IN ('c287f3251a700cbc05e9bafbd9fb3430', '5c883464a5d0c61e32259a8764f08db0')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settle_satellite_cohort'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_observed_qualifier_ids uuid[]'
       AND md5(p.prosrc) IN ('b63df892075c02b00e1bc52463dbe396', '86709c353867d59865ba23c5bdbcd7a8')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_ca_settle_satellite_cohort(p_tournament_id uuid, p_observed_qualifier_ids uuid[])'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_verify_terminal_final_deal_batch'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_require_terminal boolean'
       AND md5(p.prosrc) IN ('260c94b41d7f2bb021a88a546a1714ac', '840142310ec87ae666781e4ede4ad910')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=public, pg_temp"}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_satellite_tournament_pre_money_path_gate'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_observed_winner_id uuid'
       AND md5(p.prosrc) IN ('8b52e3e2b46dd1d7d4d51a0de74e4086', '7609e96c95470e808c8de1731bd9b531')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_settle_satellite_tournament_pre_money_path_gate(p_tournament_id uuid, p_observed_winner_id uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_bubble_protection'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_observed_bubble_user_id uuid'
       AND md5(p.prosrc) IN ('63acaadc85a0a98c9a9737bd4b740eab', 'eed2be3c09c220dc849712857befc07f')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_settle_tournament_bubble_protection(p_tournament_id uuid, p_observed_bubble_user_id uuid)'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_final_table_deal'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid'
       AND md5(p.prosrc) IN ('3428fdb9d162a8118dcadce145590dd5', 'e9af126962604791e1fa95a8ca27e836')
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
       AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'Source function body or authority changed; review before applying: public.fn_settle_tournament_final_table_deal(p_tournament_id uuid)'
      USING ERRCODE = '55000';
  END IF;
  -- The rule below is copied from this function. If it was redefined, the
  -- copy is no longer a copy and must be re-read before it is spread.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_places'
       AND md5(p.prosrc) = '5ab3977d33d618504cd9b1e79f2b4957'
  ) THEN
    RAISE EXCEPTION 'The cash-ladder rule this change copies was redefined; review before applying: public.fn_settle_tournament_places(uuid,uuid)'
      USING ERRCODE = '55000';
  END IF;
  -- The helper introduced here must not already exist under another meaning.
  -- On a replay it is already ours, and then it must still be byte-exact.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_tournament_bust_at'
       AND md5(p.prosrc) <> 'c5b7ee34f9105658870eaa3c874c314d'
  ) THEN
    RAISE EXCEPTION 'public.fn_ca_tournament_bust_at already exists under another meaning; review before applying'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- THE SHARED RULE. When a bust happened, by the witness the knockout door
-- proved, with same-hand busts one microsecond apart in
-- (stack_before, eliminated_user_id) order: the smaller hand-start stack
-- sorts earlier, so it busts first and finishes lower (TDA), and an equal-stack
-- tie falls to user id. NULL when the player has no eliminated generation; the
-- callers COALESCE that to the row's own eliminated_at.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_bust_at(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS timestamptz
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO public
AS $f08_bust_at$
  SELECT COALESCE(a.committed_at,
                  (SELECT min(g.created_at)
                     FROM public.tournament_knockout_candidates g
                    WHERE g.tournament_id = c.tournament_id
                      AND g.table_id = c.table_id
                      AND g.hand_number = c.hand_number
                      AND g.hand_id = c.hand_id))
         + (SELECT count(*)
              FROM public.tournament_knockout_candidates s
             WHERE s.tournament_id = c.tournament_id
               AND s.table_id = c.table_id
               AND s.hand_number = c.hand_number
               AND s.hand_id = c.hand_id
               AND (s.stack_before, s.eliminated_user_id)
                   < (c.stack_before, c.eliminated_user_id))::integer
           * interval '1 microsecond'
    FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                 k.hand_id, k.stack_before, k.eliminated_user_id
            FROM public.tournament_knockout_candidates k
           WHERE k.tournament_id = p_tournament_id
             AND k.eliminated_user_id = p_user_id
             AND k.state = 'eliminated'
           ORDER BY k.hand_number DESC, k.id DESC
           LIMIT 1) c
    LEFT JOIN public.hand_atomic_commits a
      ON a.table_id = c.table_id
     AND a.hand_number = c.hand_number
     AND a.hand_id = c.hand_id
$f08_bust_at$;

ALTER FUNCTION public.fn_ca_tournament_bust_at(uuid, uuid) OWNER TO postgres;
-- anon inherits whatever PUBLIC holds, so PUBLIC is named alongside the
-- pre-login roles. Nothing is granted back: every caller is a SECURITY
-- DEFINER ladder owned by postgres, which executes it as the owner.
REVOKE ALL ON FUNCTION public.fn_ca_tournament_bust_at(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
-- This database grants service_role EXECUTE on every new function by default
-- privilege. The grant is restated here so the helper's authority is written
-- down and identical on a database that has no such default, rather than
-- inherited silently from one that does.
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_bust_at(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.fn_ca_tournament_bust_at(uuid, uuid) IS
  'When a bust happened: the commit time of the accepted hand that took the '
  'stack, or that hand''s first generation capture once the hand-history prune '
  'has deleted the commit row, plus one microsecond per same-hand bust that '
  'ranks below it in (stack_before, eliminated_user_id) order - so the smaller '
  'hand-start stack busts first and finishes lower (TDA) and an equal-stack tie '
  'falls to user id. The rule fn_settle_tournament_places has paid the cash '
  'ladder by since 20260911062048, shared here so the satellite and final-table '
  'deal ladders read one authority. NULL when no eliminated generation exists.';

-- ---------------------------------------------------------------------------
-- public.fn_ca_assert_satellite_cohort_standings
-- Unchanged but for the finishing ladder's ORDER BY, which now reads the bust
-- witness first and keeps elimination_sequence only as the equal-time tiebreak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_assert_satellite_cohort_standings(p_tournament_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO public
AS $f08_fn_ca_assert_satellite_cohort_standings$
DECLARE h public.tournament_satellite_settlements%ROWTYPE; n integer;
BEGIN
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=p_tournament_id;
 n:=cardinality(h.qualifier_ids);
 IF h.receipt_version<>3 OR h.winner_id IS NOT NULL OR n IS NULL OR n<1
    OR n>h.ticket_award_count OR h.qualifier_ids IS DISTINCT FROM
       (SELECT array_agg(DISTINCT u ORDER BY u) FROM unnest(h.qualifier_ids) u)
    OR (SELECT to_jsonb(t)->>'format_contract' FROM public.tournaments t WHERE id=p_tournament_id)
       IS DISTINCT FROM 'mtt-v2'
    OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>h.field_size
    OR EXISTS(SELECT 1 FROM unnest(h.qualifier_ids) u WHERE NOT EXISTS(
       SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
        AND tp.user_id=u AND tp.status='winner' AND tp.position IS NULL
        AND tp.elimination_sequence IS NULL AND tp.eliminated_at IS NULL AND tp.chips>0))
    OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND NOT(tp.user_id=ANY(h.qualifier_ids))
      AND (tp.status IS DISTINCT FROM 'eliminated' OR tp.elimination_sequence IS NULL
           OR tp.position IS NULL OR tp.position<=n OR tp.position>h.field_size))
    OR (SELECT count(DISTINCT position) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>h.field_size-n
    OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players WHERE tournament_id=p_tournament_id)<>h.field_size-n
    OR EXISTS(SELECT 1 FROM (SELECT position,n+row_number() OVER(ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tournament_id, user_id), eliminated_at) DESC NULLS LAST, elimination_sequence DESC) expected
        FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated') r
       WHERE r.position<>r.expected) THEN
  RAISE EXCEPTION 'satellite cohort has no exact unranked survivors and causal eliminated standings' USING ERRCODE='P0404';
 END IF;
END $f08_fn_ca_assert_satellite_cohort_standings$;

REVOKE ALL ON FUNCTION public.fn_ca_assert_satellite_cohort_standings(uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.fn_ca_settle_satellite_cohort
-- Unchanged but for the finishing ladder's ORDER BY, which now reads the bust
-- witness first and keeps elimination_sequence only as the equal-time tiebreak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_cohort(p_tournament_id uuid, p_observed_qualifier_ids uuid[])
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO public
    SET statement_timeout TO '30s'
AS $f08_fn_ca_settle_satellite_cohort$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_source record;
  v_target record;
  v_target_after record;
  v_qualifier_ids uuid[];
  v_award_users uuid[];
  v_entitlements jsonb;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_admitted public.tournament_players%ROWTYPE;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
  IF public.fn_ca_lock_mtt_admission_contract() IS DISTINCT FROM 'unlimited-mtt-v2' THEN
    RAISE EXCEPTION 'satellite cohort admission is not activated' USING ERRCODE='55000';
  END IF;
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  -- THAT LOCK IS F, THE FINISH LANE (2026-09-17): exclusive among finishes,
  -- shared with every hand and rolling authority of other tournaments. A
  -- satellite writes its target's rows too, so it holds T(satellite) and
  -- T(target) exclusively, in uuid order, with G shared; the global lane
  -- calls inside re-enter it. No target resolvable: the global lane as before.
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);

  IF p_tournament_id IS NULL OR p_observed_qualifier_ids IS NULL OR cardinality(p_observed_qualifier_ids)<1
     OR p_observed_qualifier_ids IS DISTINCT FROM (SELECT array_agg(DISTINCT u ORDER BY u) FROM unnest(p_observed_qualifier_ids) u)
     OR array_position(p_observed_qualifier_ids,NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_cohort_receipt(
      p_tournament_id, p_observed_qualifier_ids);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '40001';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_cohort_receipt(
      p_tournament_id, p_observed_qualifier_ids);
  END IF;

  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT to_jsonb(t)->>'format_contract' FROM public.tournaments t WHERE id=p_tournament_id)
       IS DISTINCT FROM 'mtt-v2'
     OR NOT public.fn_ca_tournament_is_unlimited(v_target_id)
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=v_target_id
       AND (t.satellite_target_id IS NOT NULL OR t.satellite_target IS NOT NULL
         OR upper(coalesce(t.tournament_type,''))='SATELLITE'
         OR lower(coalesce(t.variant,''))='satellite')) THEN
    RAISE EXCEPTION 'satellite cohort requires recorded new MTT source and ordinary unlimited MTT target' USING ERRCODE='55000';
  END IF;
  v_entitlements:=public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
  IF (v_entitlements->>'ok')::boolean IS DISTINCT FROM true
     OR (v_entitlements->>'ready')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'satellite cohort final funded entitlements unproven: %',v_entitlements USING ERRCODE='P0404';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A bounty or Spin target needs a different, fully receipted split across
  -- prize, fee and bounty rails. This authority deliberately refuses that
  -- contract instead of silently classifying the bounty slice as prize.
  IF (
       v_target.is_bounty IS DISTINCT FROM false
       OR v_target.is_pko IS DISTINCT FROM false
       OR v_target.is_mystery_bounty IS DISTINCT FROM false
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported bounty or Spin entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT array_agg(tp.user_id ORDER BY tp.user_id),count(*) INTO v_qualifier_ids,v_live_count
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND tp.status::text='playing' AND tp.chips>0;
  IF v_qualifier_ids IS DISTINCT FROM p_observed_qualifier_ids
     OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
          AND tp.status::text IN ('playing','winner') AND (tp.chips IS NULL OR tp.chips<=0 OR tp.status::text='winner'))
     OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates c WHERE c.tournament_id=p_tournament_id AND c.state='pending')
     OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c JOIN public.tables t ON t.id=c.table_id
          WHERE t.tournament_id=p_tournament_id AND c.post_commit_completed_at IS NULL) THEN
    RAISE EXCEPTION 'satellite cohort differs or accepted hand/elimination remains unresolved' USING ERRCODE='55000';
  END IF;
  v_ticket_award_count:=floor(v_pool/v_ticket_cost)::integer;
  IF v_ticket_award_count<2 OR v_live_count>v_ticket_award_count
     OR (v_entitlements->>'ticket_value')::numeric IS DISTINCT FROM v_ticket_cost
     OR (v_entitlements->>'source_pool')::numeric IS DISTINCT FROM v_pool
     OR (SELECT count(*) FROM public.tournament_satellite_entitlements e
          WHERE e.tournament_id=p_tournament_id AND e.award_kind='seat_or_cash'
            AND e.ticket_value=v_ticket_cost AND e.remainder_value=0)<>v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite has not reached its frozen full-ticket depth' USING ERRCODE='55000';
  END IF;
  SELECT count(*),count(elimination_sequence),count(DISTINCT elimination_sequence)
    INTO v_eliminated_count,v_sequenced_count,v_distinct_sequence_count
    FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated';
  IF v_eliminated_count<>v_field_size-v_live_count
     OR v_sequenced_count<>v_eliminated_count OR v_distinct_sequence_count<>v_eliminated_count THEN
    RAISE EXCEPTION 'satellite cohort lacks exact causal eliminated standings' USING ERRCODE='P0404';
  END IF;
  -- No ranked place is assigned to a survivor. Same-hand overflow awardees
  -- retain the already accepted elimination sequence, including the bubble.
  UPDATE public.tournament_players SET status='winner',position=NULL,eliminated_at=NULL,
    elimination_sequence=NULL WHERE tournament_id=p_tournament_id AND user_id=ANY(v_qualifier_ids);
  UPDATE public.tournament_players SET position=NULL WHERE tournament_id=p_tournament_id AND status='eliminated';
  WITH ranked AS (SELECT id,row_number() OVER(ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tournament_id, user_id), eliminated_at) DESC NULLS LAST, elimination_sequence DESC)::integer+v_live_count final_position
       FROM public.tournament_players WHERE tournament_id=p_tournament_id AND status='eliminated')
  UPDATE public.tournament_players tp SET position=r.final_position FROM ranked r WHERE tp.id=r.id;
  SELECT v_qualifier_ids||coalesce(array_agg(tp.user_id ORDER BY tp.position),ARRAY[]::uuid[])
    INTO v_award_users FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
      AND tp.position BETWEEN v_live_count+1 AND v_ticket_award_count;
  IF cardinality(v_award_users)<>v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite cohort has missing full-ticket recipients' USING ERRCODE='P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF NOT public.fn_ca_tournament_is_unlimited(v_target_id) AND v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN public.fn_ca_tournament_is_unlimited(v_target_id) OR v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.user_id=ANY(v_award_users)
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id = v_award_users[v_place];
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);
        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, qualifier_ids, receipt_version, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     NULL, v_qualifier_ids, 3, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING * INTO v_admitted;
      v_registration_id := v_admitted.id;
      -- The admission trigger selects the member club for a union entrant.
      -- It is the funding/refund identity used by ordinary ticket admission.
      IF v_admitted.club_id IS NULL
         OR v_admitted.tournament_id IS DISTINCT FROM v_target_id
         OR v_admitted.user_id IS DISTINCT FROM v_finisher.user_id
         OR v_admitted.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR v_admitted.is_satellite_qualifier IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'satellite seat returned inconsistent registration identity'
          USING ERRCODE='P0404';
      END IF;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_admitted.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket award slot %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'award_slot', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'award_slot', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id));
      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_finisher.position, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM
      -- (2026-09-10): a union-hosted target accepts a ticket at any member
      -- club of its union, exactly as redemption already does. Demanding the
      -- house club refused every capped winner of a union satellite.
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_finisher.position, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_target_buy_in, 0, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket award slot %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'award_slot', v_place,
           'entry_prize', v_target_buy_in,
           'entry_bounty', 0,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_finisher.position,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" IS NOT DISTINCT FROM v_finisher.position
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_target_buy_in, 2),
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_target_buy_in, 2)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM v_target_escrow.gross_in
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM v_target_escrow.bounty_in
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM v_target_escrow.bounty_balance
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND user_id=ANY(v_award_users);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  RETURN public.fn_ca_satellite_cohort_receipt(
    p_tournament_id, p_observed_qualifier_ids);
END;
$f08_fn_ca_settle_satellite_cohort$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_satellite_cohort(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.fn_ca_verify_terminal_final_deal_batch
-- Unchanged but for the finishing ladder's ORDER BY, which now reads the bust
-- witness first and keeps elimination_sequence only as the equal-time tiebreak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id uuid, p_require_terminal boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO public, pg_temp
AS $f08_fn_ca_verify_terminal_final_deal_batch$
DECLARE
 v_t public.tournaments%ROWTYPE;
 v_b public.tournament_final_table_deal_batches%ROWTYPE;
 v_e public.tournament_escrow%ROWTYPE;
 v_ob public.tournament_obligations%ROWTYPE;
 v_input jsonb; v_tail jsonb; v_ladder jsonb; v_expected jsonb;
 v_field integer; v_ladder_count integer; v_max_place integer;
 v_place_total numeric; v_deal_cents bigint; v_chips numeric;
 v_bubble numeric:=0; v_bubble_user uuid;
 v_line record; v_amount numeric; v_paid numeric; v_count integer;
 v_not_pool text[]:=ARRAY['satellite_seat','bounty','mystery_bounty',
  'bounty_residual','own_bounty','mystery_bounty_residual'];
BEGIN
 SELECT * INTO STRICT v_t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO STRICT v_b FROM public.tournament_final_table_deal_batches
  WHERE tournament_id=p_tournament_id;
 IF v_b.contract_version<>2 OR v_b.settled_at IS NULL
  OR v_b.source IS DISTINCT FROM 'engine.fn_settle_tournament_final_table_deal'
  OR v_t.prize_pool_finalized IS DISTINCT FROM true
  OR v_t.prize_pool IS NULL OR v_t.prize_pool<=0
  OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
  OR v_t.prize_pool<>round(v_t.prize_pool,2)
  OR v_t.prize_pool<COALESCE(v_t.guaranteed_prize,0)
  OR lower(COALESCE(v_t.variant,''))='satellite'
  OR upper(COALESCE(v_t.tournament_type,''))='SATELLITE'
  OR v_t.satellite_target_id IS NOT NULL OR v_t.satellite_target IS NOT NULL
 THEN RAISE EXCEPTION 'canonical final deal is not a settled funded cash batch'; END IF;
 SELECT count(*) INTO v_field FROM public.tournament_players WHERE tournament_id=p_tournament_id;
 IF v_field<>v_b.field_count OR v_b.live_count>v_field
  OR v_b.live_count>v_t.table_size OR v_b.live_count<2
  OR (SELECT count(DISTINCT position) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id)<>v_field
  OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND status='winner' AND position=1 AND user_id=v_b.chip_leader
   AND eliminated_at IS NULL AND elimination_sequence IS NULL)<>1
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND (position IS NULL OR position<1 OR position>v_field
    OR status NOT IN ('winner','eliminated')
    OR (position>1 AND (status<>'eliminated' OR eliminated_at IS NULL
     OR elimination_sequence IS NULL OR elimination_sequence<=0))
    OR (status='winner' AND position<>1)))
  OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND status='eliminated')<>v_field-1
  OR EXISTS(SELECT 1 FROM (SELECT position,
   row_number() OVER(ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tournament_id, user_id), eliminated_at) DESC NULLS LAST, elimination_sequence DESC,id)+1 expected
   FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND status='eliminated') q WHERE position<>expected)
 THEN RAISE EXCEPTION 'canonical final deal durable standings differ'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,
  'chips',tp.chips,'registered_at',extract(epoch FROM tp.registered_at))
  ORDER BY tp.chips DESC,tp.registered_at ASC NULLS LAST,tp.user_id),'[]'::jsonb),
  sum(tp.chips)
 INTO v_input,v_chips FROM public.tournament_players tp
 WHERE tp.tournament_id=p_tournament_id AND tp.position<=v_b.live_count;
 IF v_input IS DISTINCT FROM v_b.live_input_snapshot
  OR md5(v_input::text) IS DISTINCT FROM v_b.live_input_fingerprint
  OR jsonb_array_length(v_input)<>v_b.live_count OR v_chips IS NULL OR v_chips<=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_input) x
   WHERE x->>'chips' IS NULL OR (x->>'chips')::numeric<0
    OR x->>'chips' IN ('NaN','Infinity','-Infinity'))
  OR (v_input->0->>'user_id')::uuid IS DISTINCT FROM v_b.chip_leader
  OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=v_b.deal_table_id
    AND tournament_id=p_tournament_id)
 THEN RAISE EXCEPTION 'canonical final deal immutable input differs'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',tp.id,'user_id',tp.user_id,
  'club_id',tp.club_id,'position',tp.position,'eliminated_at',extract(epoch FROM tp.eliminated_at),
  'elimination_sequence',tp.elimination_sequence) ORDER BY tp.position),'[]'::jsonb)
 INTO v_tail FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
  AND tp.position>v_b.live_count;
 IF md5(v_tail::text) IS DISTINCT FROM v_b.prior_standings_fingerprint
 THEN RAISE EXCEPTION 'canonical final deal prior standings differ'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'amount',a.amount)
  ORDER BY a.place),'[]'::jsonb),count(*),max(a.place),
  COALESCE(sum(a.amount) FILTER(WHERE a.place>v_b.live_count),0)
 INTO v_ladder,v_ladder_count,v_max_place,v_place_total
 FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
 IF v_ladder_count=0 OR v_ladder_count<>v_b.structure_place_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ladder) x
    WHERE (x->>'amount')::numeric<0
     OR (x->>'amount')::numeric<>round((x->>'amount')::numeric,2))
 THEN RAISE EXCEPTION 'canonical final deal structure differs'; END IF;
 IF v_t.bubble_protection AND v_max_place+1<=v_field AND v_max_place+1>v_b.live_count THEN
  v_bubble:=v_t.buy_in_amount;
  IF v_bubble IS NULL OR v_bubble<=0 OR v_bubble::text IN ('NaN','Infinity','-Infinity')
   OR v_bubble<>round(v_bubble,2) THEN RAISE EXCEPTION 'canonical final deal Bubble amount invalid'; END IF;
  SELECT user_id INTO STRICT v_bubble_user FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND position=v_max_place+1 AND status='eliminated';
 END IF;
 v_deal_cents:=round((v_t.prize_pool-v_place_total-v_bubble)*100)::bigint;
 IF v_deal_cents<=0 THEN RAISE EXCEPTION 'canonical final deal residual invalid'; END IF;
 WITH live AS (
  SELECT (x->>'user_id')::uuid user_id,(x->>'club_id')::uuid club_id,ord::integer place,
   floor((x->>'chips')::numeric*v_deal_cents/v_chips)::bigint cents
  FROM jsonb_array_elements(v_input) WITH ORDINALITY z(x,ord)
 ), all_lines AS (
  SELECT 'final_table_deal' kind,place,user_id,club_id,
   cents+CASE WHEN place=1 THEN v_deal_cents-(SELECT sum(cents) FROM live) ELSE 0 END cents
   FROM live
  UNION ALL
  SELECT 'place',(x->>'place')::integer,tp.user_id,tp.club_id,
   round((x->>'amount')::numeric*100)::bigint
  FROM jsonb_array_elements(v_ladder) x JOIN public.tournament_players tp
   ON tp.tournament_id=p_tournament_id AND tp.position=(x->>'place')::integer
  WHERE (x->>'place')::integer>v_b.live_count AND (x->>'amount')::numeric>0
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'place',place,
  'user_id',user_id,'club_id',club_id,'cents',cents) ORDER BY place),'[]'::jsonb)
 INTO v_expected FROM all_lines;
 IF v_b.plan IS DISTINCT FROM v_expected OR v_b.plan_fingerprint IS DISTINCT FROM md5(v_expected::text)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x WHERE (x->>'cents')::bigint<=0)
  OR v_b.place_amount IS DISTINCT FROM v_place_total
  OR v_b.deal_amount IS DISTINCT FROM v_deal_cents::numeric/100
  OR v_b.amount_owed IS DISTINCT FROM v_t.prize_pool-v_bubble
  OR v_b.deal_line_count<>v_b.live_count
  OR v_b.place_line_count<>jsonb_array_length(v_expected)-v_b.live_count
  OR v_b.escrow_prize_after IS DISTINCT FROM 0::numeric
  OR v_b.escrow_prize_before IS DISTINCT FROM v_b.amount_moved
  OR v_b.amount_moved<0 OR v_b.amount_moved>v_t.prize_pool
 THEN RAISE EXCEPTION 'canonical final deal plan or escrow proof differs'; END IF;
 FOR v_line IN SELECT (x->>'kind') kind,(x->>'place')::integer place,
  (x->>'user_id')::uuid user_id,(x->>'cents')::numeric/100 amount
  FROM jsonb_array_elements(v_expected) x
 LOOP
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations o WHERE
   o.tournament_id=p_tournament_id AND o.kind=v_line.kind
   AND (CASE WHEN v_line.kind='place' THEN o.place=v_line.place
    ELSE o.place IS NULL AND o.user_id=v_line.user_id END);
  IF v_ob.user_id IS DISTINCT FROM v_line.user_id OR v_ob.amount_owed IS DISTINCT FROM v_line.amount
   OR v_ob.amount_paid IS DISTINCT FROM v_line.amount OR v_ob.settled_at IS NULL
   OR (v_line.kind='final_table_deal' AND (v_ob.source IS DISTINCT FROM 'final_table_deal'
    OR v_ob.adjustment_id IS NOT NULL))
  THEN RAISE EXCEPTION 'canonical final deal obligation differs at place %',v_line.place; END IF;
  SELECT COALESCE(sum(p.amount),0),count(*) INTO v_paid,v_count FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.user_id=v_line.user_id
    AND (CASE WHEN v_line.kind='place' THEN p.position=v_line.place
      AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)) AND p.source<>'final_table_deal'
     ELSE p.position IS NULL AND p.source='final_table_deal' END);
  IF v_paid IS DISTINCT FROM v_line.amount OR v_count<1
   OR (v_line.kind='final_table_deal' AND v_count<>1)
  THEN RAISE EXCEPTION 'canonical final deal payout differs at place %',v_line.place; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.tournament_obligations o
  WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','final_table_deal')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x
    WHERE o.kind=x->>'kind' AND o.user_id=(x->>'user_id')::uuid
     AND (CASE WHEN o.kind='place' THEN o.place=(x->>'place')::integer ELSE o.place IS NULL END)))
 THEN RAISE EXCEPTION 'canonical final deal has uncontracted debt'; END IF;
 SELECT count(*) INTO v_count FROM public.tournament_obligations
  WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
 IF v_bubble>0 THEN
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  IF v_count<>1 OR v_ob.place IS NOT NULL OR v_ob.user_id IS DISTINCT FROM v_bubble_user
   OR v_ob.amount_owed IS DISTINCT FROM v_bubble OR v_ob.amount_paid IS DISTINCT FROM v_bubble
   OR v_ob.settled_at IS NULL OR v_ob.source IS NULL
   OR v_ob.source NOT IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement',
    'engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   OR v_b.bubble_contract_required IS DISTINCT FROM true
   OR v_b.bubble_obligation_id IS DISTINCT FROM v_ob.id
   OR v_b.bubble_user_id IS DISTINCT FROM v_bubble_user
   OR v_b.bubble_source IS DISTINCT FROM v_ob.source
   OR v_b.bubble_amount_owed IS DISTINCT FROM v_bubble
   OR v_b.bubble_amount_paid_before<0 OR v_b.bubble_amount_paid_before>v_bubble
   OR (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts
    WHERE tournament_id=p_tournament_id AND source='bubble_protection') IS DISTINCT FROM v_bubble
  THEN RAISE EXCEPTION 'canonical final deal Bubble proof differs'; END IF;
 ELSIF v_count<>0 OR v_b.bubble_contract_required IS DISTINCT FROM false
  OR v_b.bubble_obligation_id IS NOT NULL OR v_b.bubble_user_id IS NOT NULL
  OR v_b.bubble_source IS NOT NULL OR v_b.bubble_amount_owed<>0 OR v_b.bubble_amount_paid_before<>0
 THEN RAISE EXCEPTION 'canonical final deal has uncontracted Bubble'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=p_tournament_id
  AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)) AND
   (p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity')
    OR p.amount<>round(p.amount,2) OR p.idempotency_key IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency k WHERE
     k.key=p.idempotency_key AND k.user_id=p.user_id AND k.amount=p.amount)
    OR NOT(
     (p.source='bubble_protection' AND p.position IS NULL AND p.user_id=v_bubble_user AND v_bubble>0)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x WHERE p.user_id=(x->>'user_id')::uuid
      AND CASE WHEN x->>'kind'='place' THEN p.position=(x->>'place')::integer
        AND p.source<>'final_table_deal' AND p.source<>'bubble_protection'
       ELSE p.position IS NULL AND p.source='final_table_deal' END))))
  OR (SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)))
    IS DISTINCT FROM v_t.prize_pool
  OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
   AND tp.prize IS DISTINCT FROM COALESCE((SELECT sum(p.amount) FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.user_id=tp.user_id
     AND NOT(COALESCE(p.source,'')=ANY(v_not_pool))),0))
 THEN RAISE EXCEPTION 'canonical final deal wallet proof or cache differs'; END IF;
 -- Every obligation-scoped wallet credit must retain its exact payout witness.
 -- This also rejects an extra spent key hidden behind otherwise-correct totals.
 IF EXISTS(SELECT 1 FROM public.tournament_obligations o
  JOIN public.wallet_credit_idempotency k
   ON k.key LIKE 'tourney:'||p_tournament_id::text||':obl:'||o.id::text||':%'
  WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','final_table_deal','bubble_protection')
   AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.idempotency_key=k.key
     AND p.user_id=k.user_id AND p.user_id=o.user_id AND p.amount=k.amount
     AND CASE WHEN o.kind='place' THEN p.position=o.place
       AND NOT(COALESCE(p.source,'')=ANY(v_not_pool))
       AND p.source NOT IN ('final_table_deal','bubble_protection')
      ELSE p.position IS NULL AND p.source=o.kind END))
 THEN RAISE EXCEPTION 'canonical final deal has an orphaned wallet credit'; END IF;
 SELECT * INTO STRICT v_e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 IF v_e.enforced IS DISTINCT FROM true OR v_e.prize_balance IS DISTINCT FROM 0::numeric
  OR (p_require_terminal AND (v_e.bounty_balance IS DISTINCT FROM 0::numeric
   OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.closed_at IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
    WHERE f.tournament_id=p_tournament_id AND f.finish_kind='final_table_deal'
     AND f.winner_user_id=v_b.chip_leader)
   OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=p_tournament_id AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'))))
 THEN RAISE EXCEPTION 'canonical final deal has open custody, seats or missing finish claim'; END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'plan_fingerprint',v_b.plan_fingerprint,
  'place_amount',v_place_total,'deal_amount',v_deal_cents::numeric/100,'bubble_amount',v_bubble,
  'chip_leader',v_b.chip_leader);
END;
$f08_fn_ca_verify_terminal_final_deal_batch$;

REVOKE ALL ON FUNCTION public.fn_ca_verify_terminal_final_deal_batch(uuid, boolean)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public.fn_settle_satellite_tournament_pre_money_path_gate
-- Unchanged but for the finishing ladder's ORDER BY, which now reads the bust
-- witness first and keeps elimination_sequence only as the equal-time tiebreak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(p_tournament_id uuid, p_observed_winner_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO public
    SET statement_timeout TO '30s'
AS $f08_fn_settle_satellite_tournament_pre_money_path_gate$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_source record;
  v_target record;
  v_target_after record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_admitted public.tournament_players%ROWTYPE;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  -- THAT LOCK IS F, THE FINISH LANE (2026-09-17): exclusive among finishes,
  -- shared with every hand and rolling authority of other tournaments. A
  -- satellite writes its target's rows too, so it holds T(satellite) and
  -- T(target) exclusively, in uuid order, with G shared; the global lane
  -- calls inside re-enter it. No target resolvable: the global lane as before.
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);

  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '40001';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A bounty or Spin target needs a different, fully receipted split across
  -- prize, fee and bounty rails. This authority deliberately refuses that
  -- contract instead of silently classifying the bounty slice as prize.
  IF (
       v_target.is_bounty IS DISTINCT FROM false
       OR v_target.is_pko IS DISTINCT FROM false
       OR v_target.is_mystery_bounty IS DISTINCT FROM false
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported bounty or Spin entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'satellite % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'satellite % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
           OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL
     OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'observed winner % does not match the locked last survivor in satellite %',
      p_observed_winner_id, p_tournament_id USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = 1 AND tp.user_id IS DISTINCT FROM v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1,
         eliminated_at = NULL, elimination_sequence = NULL
   WHERE id = v_winner.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not promote exactly one winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tp.tournament_id, tp.user_id), tp.eliminated_at) DESC NULLS LAST, tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;

  SELECT count(*), count(DISTINCT tp.position)
    INTO v_rows, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position BETWEEN 1 AND v_field_size;
  IF v_rows <> v_field_size OR v_distinct_sequence_count <> v_field_size THEN
    RAISE EXCEPTION 'satellite % could not prove contiguous final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF (NOT public.fn_ca_tournament_is_unlimited(v_target_id)
      AND COALESCE(v_target.max_players, 0) < 0)
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF NOT public.fn_ca_tournament_is_unlimited(v_target_id)
     AND v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN public.fn_ca_tournament_is_unlimited(v_target_id)
        OR v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.position BETWEEN 1 AND v_ticket_award_count
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = v_place;
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);
        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     p_observed_winner_id, v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_place
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING * INTO v_admitted;
      v_registration_id := v_admitted.id;
      -- The admission trigger selects the member club for a union entrant.
      -- It is the funding/refund identity used by ordinary ticket admission.
      IF v_admitted.club_id IS NULL
         OR v_admitted.tournament_id IS DISTINCT FROM v_target_id
         OR v_admitted.user_id IS DISTINCT FROM v_finisher.user_id
         OR v_admitted.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR v_admitted.is_satellite_qualifier IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'satellite seat returned inconsistent registration identity'
          USING ERRCODE='P0404';
      END IF;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_admitted.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'position', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id));
      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM
      -- (2026-09-10): a union-hosted target accepts a ticket at any member
      -- club of its union, exactly as redemption already does. Demanding the
      -- house club refused every capped winner of a union satellite.
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_target_buy_in, 0, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'entry_prize', v_target_buy_in,
           'entry_bounty', 0,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_place,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" = v_place
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_target_buy_in, 2),
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_target_buy_in, 2)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM v_target_escrow.gross_in
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM v_target_escrow.bounty_in
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM v_target_escrow.bounty_balance
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND position BETWEEN 1 AND v_ticket_award_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE AND NOT v_deferred) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  RETURN public.fn_ca_satellite_settlement_receipt(
    p_tournament_id, p_observed_winner_id);
END;
$f08_fn_settle_satellite_tournament_pre_money_path_gate$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- public.fn_settle_tournament_bubble_protection
-- Unchanged but for the finishing ladder's ORDER BY, which now reads the bust
-- witness first and keeps elimination_sequence only as the equal-time tiebreak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_bubble_protection(p_tournament_id uuid, p_observed_bubble_user_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO public
    SET statement_timeout TO '30s'
AS $f08_fn_settle_tournament_bubble_protection$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric;
  v_candidate_count integer;
  v_ob public.tournament_obligations%ROWTYPE;
  v_ob_count integer;
  v_payout_count integer;
  v_paid numeric;
  v_result jsonb;
  v_rows integer;
BEGIN
  IF p_tournament_id IS NULL OR p_observed_bubble_user_id IS NULL THEN
    RAISE EXCEPTION 'bubble settlement requires tournament and observed user ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.bubble_protection,
         t.buy_in_amount,
         t.prize_pool, t.prize_pool_finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN
       ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle a bubble from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  -- Before the pool is finalized, late registration can still enlarge the
  -- roster. An entrant who is the bubble in that transient field may acquire a
  -- different final place. Never move money until the database-owned close
  -- proves the field and its stone-bubble identity are immutable. If guarantee
  -- funding prevented finalization, terminal settlement funds it and settles
  -- the bubble atomically instead.
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'tournament % cannot settle its bubble before the prize pool is finalized',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION
      'tournament % is a satellite; its bubble receives the seat-pool remainder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_t.bubble_protection, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % has no bubble-protection promise',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF v_t.buy_in_amount IS NULL
     OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
     OR v_t.buy_in_amount <= 0
     OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
      p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
  END IF;
  v_bubble_amount := round(v_t.buy_in_amount, 2);
  IF v_t.prize_pool IS NULL OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < v_bubble_amount
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % pool % cannot fund bubble amount %',
      p_tournament_id, v_t.prize_pool, v_bubble_amount USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text NOT IN ('playing','winner','eliminated')
  ) THEN
    RAISE EXCEPTION 'tournament % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF v_bubble_place IS NULL OR v_bubble_place > v_field_size THEN
    RAISE EXCEPTION 'tournament % final field has no stone bubble',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION 'tournament % has no complete durable elimination order',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  WITH ranked AS (
    SELECT tp.user_id, tp.position,
           (v_field_size - row_number() OVER (
             ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tp.tournament_id, tp.user_id), tp.eliminated_at) ASC NULLS FIRST, tp.elimination_sequence ASC, tp.id ASC
           ) + 1)::integer AS expected_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  SELECT count(*), min(r.user_id::text)::uuid
    INTO v_candidate_count, v_bubble_user_id
    FROM ranked r
   WHERE r.expected_position = v_bubble_place
     AND r.position = v_bubble_place;
  IF v_candidate_count <> 1
     OR v_bubble_user_id IS DISTINCT FROM p_observed_bubble_user_id THEN
    RAISE EXCEPTION
      'observed bubble user % does not match durable place % in tournament %',
      p_observed_bubble_user_id, v_bubble_place, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
   ORDER BY p.id FOR SHARE;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_paid > v_bubble_amount
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'bubble_protection'
          AND (p.user_id IS DISTINCT FROM v_bubble_user_id
            OR p."position" IS NOT NULL
            OR p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0
            OR p.amount IS DISTINCT FROM round(p.amount, 2)
            OR p.idempotency_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id
                 AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';
  SELECT * INTO v_ob
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection'
     AND o.user_id = v_bubble_user_id;
  IF v_ob_count = 0 THEN
    IF v_payout_count <> 0 OR v_paid <> 0 THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
    VALUES
      (p_tournament_id, 'bubble_protection', NULL, v_bubble_user_id,
       v_bubble_amount, 0, 'engine.fn_settle_tournament_bubble_protection')
    RETURNING * INTO v_ob;
  ELSIF v_ob_count <> 1 OR v_ob.id IS NULL
     OR v_ob.place IS NOT NULL
     OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
     OR v_ob.amount_paid IS DISTINCT FROM v_paid
     OR v_ob.amount_paid < 0 OR v_ob.amount_paid > v_ob.amount_owed
     OR (v_ob.amount_paid = v_ob.amount_owed) IS DISTINCT FROM
        (v_ob.settled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_result := public.fn_ca_settle_tournament_bubble_raw(
    p_tournament_id, v_bubble_user_id, v_bubble_amount);
  UPDATE public.tournament_players
     SET prize = v_bubble_amount
   WHERE tournament_id = p_tournament_id
     AND user_id = v_bubble_user_id
     AND position = v_bubble_place;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      'could not stamp one bubble prize cache for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'user_id', v_bubble_user_id,
    'position', v_bubble_place,
    'amount', v_bubble_amount,
    'settlement', v_result);
END;
$f08_fn_settle_tournament_bubble_protection$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_bubble_protection(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_bubble_protection(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- public.fn_settle_tournament_final_table_deal
-- Unchanged but for the finishing ladder's ORDER BY, which now reads the bust
-- witness first and keeps elimination_sequence only as the equal-time tiebreak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_final_table_deal(p_tournament_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO public
    SET statement_timeout TO '30s'
AS $f08_fn_settle_tournament_final_table_deal$
DECLARE
  v_t record;
  v_status text;
  v_table_size integer;
  v_field_size integer;
  v_live_count integer;
  v_live_table_count integer;
  v_live_seat_count integer;
  v_live_seated_users integer;
  v_vote_count integer;
  v_total_chips numeric;
  v_pool_cents bigint;
  v_prior_paid_cents bigint;
  v_fixed_entitlement_cents bigint := 0;
  v_fixed_paid_cents bigint := 0;
  v_fixed_shortfall_cents bigint := 0;
  v_fixed_count integer := 0;
  v_ladder_max_place integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric(15,2) := 0;
  v_bubble_entitlement_cents bigint := 0;
  v_bubble_paid_cents bigint := 0;
  v_bubble_shortfall_cents bigint := 0;
  v_bubble_obligation_count integer := 0;
  v_bubble_candidate_count integer := 0;
  v_has_bubble boolean := false;
  v_bubble_obligation_source text :=
    'engine.fn_settle_tournament_bubble_protection';
  v_undistributed_cents bigint;
  v_distributed_cents bigint := 0;
  v_remainder_cents bigint;
  v_share_cents bigint;
  v_amount numeric(15,2);
  v_rank integer := 0;
  v_rows integer;
  v_now timestamptz := now();
  v_leader uuid;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_ladder jsonb := '[]'::jsonb;
  v_fixed jsonb := '[]'::jsonb;
  v_shares jsonb := '[]'::jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_winner_amount numeric(15,2) := 0;
  v_row record;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_modern_batch public.tournament_final_table_deal_batches%ROWTYPE;
  v_modern_input jsonb;
  v_modern_tail jsonb;
  v_modern_plan jsonb;
  v_modern_table uuid;
  v_modern_escrow_before numeric;
  v_modern_required numeric;
  v_modern_claim jsonb;
  v_not_pool text[] := ARRAY[
    'satellite_seat','bounty','mystery_bounty','bounty_residual',
    'own_bounty','mystery_bounty_residual'
  ];
BEGIN
  -- Share the same first lock as the whole-event terminal authority. Re-entry
  -- from that authority is transaction-local and immediate.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'final-table deal requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical money lock order: tournament, authoritative guarantee-funding
  -- bank, complete roster, complete obligation set. Every validation and every
  -- amount derivation follows it.
  SELECT t.id, t.status, t.prize_pool, t.final_table_deal_enabled,
         t.table_size, t.variant, t.tournament_type, t.satellite_target_id,
         t.satellite_target, t.bubble_protection, t.buy_in_amount,
         t.guaranteed_prize, t.prize_pool_finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  v_status := upper(COALESCE(v_t.status::text, ''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot execute or replay a deal from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not a cash final-table deal',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  -- Replay a certified v2 batch without changing even transient money/cache state.
  SELECT * INTO v_modern_batch FROM public.tournament_final_table_deal_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND AND v_modern_batch.contract_version=2 THEN
    IF v_status NOT IN ('COMPLETING','COMPLETED') THEN
      RAISE EXCEPTION 'canonical final deal batch has no claimed lifecycle';
    END IF;
    PERFORM public.fn_ca_verify_terminal_final_deal_batch(
      p_tournament_id,v_status='COMPLETED');
    IF NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
      WHERE f.tournament_id=p_tournament_id AND f.finish_kind='final_table_deal'
       AND f.winner_user_id=v_modern_batch.chip_leader
       AND (v_status<>'COMPLETED' OR f.certified_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'canonical final deal replay has no matching finish receipt';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('place',(x->>'place')::integer,
      'user_id',(x->>'user_id')::uuid,'amount',(x->>'cents')::numeric/100)
      ORDER BY (x->>'place')::integer),
      max((x->>'cents')::numeric/100) FILTER(WHERE (x->>'place')::integer=1)
      INTO v_payouts,v_winner_amount FROM jsonb_array_elements(v_modern_batch.plan) x
      WHERE x->>'kind'='final_table_deal';
    RETURN jsonb_build_object('ok',true,'fully_settled',true,'status',v_status,
      'payouts',v_payouts,'winner_amount',v_winner_amount,
      'money_path','fn_settle_tournament_final_table_deal');
  ELSIF FOUND AND v_status='RUNNING' THEN
    RAISE EXCEPTION 'prepared historical deal requires its original authority';
  END IF;

  -- The chop and any guarantee overlay are one commit. A process-side funding
  -- request can improve the live preview, but it is never settlement evidence:
  -- this locked authority funds again idempotently and proves the refreshed
  -- pool before it derives fixed places or a single deal share.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_final_table_deal');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused before deal: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.prize_pool, t.final_table_deal_enabled,
         t.table_size, t.variant, t.tournament_type, t.satellite_target_id,
         t.satellite_target, t.bubble_protection, t.buy_in_amount,
         t.guaranteed_prize, t.prize_pool_finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked deal pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  PERFORM 1
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id
   FOR UPDATE;

  -- Evidence rows are append-only. Canonical payers hold the tournament lock;
  -- row locks additionally keep an existing receipt stable while it is proved.
  PERFORM 1
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
   ORDER BY p.id
   FOR SHARE;

  IF v_t.table_size IS NULL OR v_t.table_size < 2 OR v_t.table_size > 10 THEN
    RAISE EXCEPTION 'tournament % has invalid final-table size %',
      p_tournament_id, v_t.table_size USING ERRCODE = '23514';
  END IF;
  v_table_size := v_t.table_size;

  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size < 2 THEN
    RAISE EXCEPTION 'tournament % has fewer than two roster rows', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- Every payout row that consumes the prize pool must be finite, nonnegative,
  -- whole-cent evidence tied to the exact wallet-credit identity. The player
  -- prize column is deliberately absent from this calculation: it is a cache,
  -- never evidence that money moved.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND (
         p.amount IS NULL
         OR p.amount::text IN ('NaN','Infinity','-Infinity')
         OR p.amount <= 0
         OR p.amount IS DISTINCT FROM round(p.amount, 2)
         OR NOT EXISTS (
           SELECT 1
             FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = p.user_id
              AND (p."position" IS NULL OR tp.position = p."position")
         )
         OR (p.amount > 0 AND (
           p.idempotency_key IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key
                AND k.user_id = p.user_id
                AND k.amount = p.amount
           )
         ))
       )
  ) THEN
    RAISE EXCEPTION 'tournament % has malformed or unbacked prize payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool <= 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  v_pool_cents := round(v_t.prize_pool * 100)::bigint;

  -- The locked structure fixes every already-eliminated cash entitlement.
  -- Live places are superseded by the unanimous chip chop; places below the
  -- live field remain exact structure debts and reduce the chop residual at
  -- their full entitlement, whether previously unpaid, partly paid or paid.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place', a.place,
           'amount', a.amount,
           'cents', round(a.amount * 100)::bigint
         ) ORDER BY a.place), '[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty cash structure',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  SELECT max((e->>'place')::integer)
    INTO v_ladder_max_place
    FROM jsonb_array_elements(v_ladder) e;
  IF v_ladder_max_place IS NULL OR v_ladder_max_place < 1 THEN
    RAISE EXCEPTION 'tournament % derived an invalid cash structure tail',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_bubble_place := v_ladder_max_place + 1;

  IF v_status = 'RUNNING' THEN
    SELECT count(*), COALESCE(sum(tp.chips), 0)
      INTO v_live_count, v_total_chips
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'playing'
       AND tp.eliminated_at IS NULL;
  ELSIF v_status IN ('COMPLETING','COMPLETED') THEN
    SELECT count(DISTINCT p.user_id) INTO v_live_count
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal';
  ELSE
    RAISE EXCEPTION 'tournament % cannot execute or replay a deal from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;

  IF v_live_count < 2 OR v_live_count > v_table_size THEN
    RAISE EXCEPTION 'tournament % has % dealt/live players outside final-table size %',
      p_tournament_id, v_live_count, v_table_size USING ERRCODE = '55000';
  END IF;

  -- Late registration can grow the final field after an early bust already
  -- received a then-correct position. Normalize the locked eliminated tail
  -- before pricing its fixed places. The DB-owned elimination_sequence is the
  -- durable chronology witness: the latest elimination gets live_count+1 and
  -- the earliest gets field_size. Mutable wall clocks and stale place numbers
  -- are never used to reconstruct history. The consolidated predecessor owns
  -- the sequence column, allocator, unique index and transition trigger.
  IF v_status = 'RUNNING' THEN
    IF EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND (
           (tp.status::text = 'playing' AND tp.eliminated_at IS NULL
             AND (tp.position IS NOT NULL OR tp.elimination_sequence IS NOT NULL))
           OR
           (NOT (tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
             AND (tp.status::text <> 'eliminated'
               OR tp.eliminated_at IS NULL
               OR tp.position IS NULL
               OR tp.position < 2
               OR tp.position > v_field_size
               OR tp.elimination_sequence IS NULL
               OR tp.elimination_sequence <= 0))
         )
    ) OR (SELECT count(DISTINCT tp.elimination_sequence)
            FROM public.tournament_players tp
           WHERE tp.tournament_id = p_tournament_id
             AND tp.status::text = 'eliminated'
             AND tp.eliminated_at IS NOT NULL)
          <> v_field_size - v_live_count
    THEN
      RAISE EXCEPTION
        'tournament % roster lacks complete unique elimination-sequence evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
       AND tp.eliminated_at IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_field_size - v_live_count THEN
      RAISE EXCEPTION 'tournament % normalized % of % eliminated standings',
        p_tournament_id, v_rows, v_field_size - v_live_count
        USING ERRCODE = 'P0404';
    END IF;

    WITH ranked AS (
      SELECT tp.id,
             (v_live_count + row_number() OVER (
               ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tp.tournament_id, tp.user_id), tp.eliminated_at) DESC NULLS LAST, tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
               AS normalized_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
    )
    UPDATE public.tournament_players tp
       SET position = ranked.normalized_position
      FROM ranked
     WHERE tp.id = ranked.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_field_size - v_live_count THEN
      RAISE EXCEPTION 'tournament % could not finish tail normalization',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
       AND (tp.eliminated_at IS NULL OR tp.elimination_sequence IS NULL
         OR tp.elimination_sequence <= 0)
  ) OR (SELECT count(DISTINCT tp.elimination_sequence)
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated')
        <> (SELECT count(*)
              FROM public.tournament_players tp
             WHERE tp.tournament_id = p_tournament_id
               AND tp.status::text = 'eliminated') THEN
    RAISE EXCEPTION
      'tournament % replay lacks complete unique elimination-sequence evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Bubble protection is part of the locked tournament prize pool. It exists
  -- only when the durable eliminated tail already contains the one player at
  -- max(cash place)+1. If that place is still among the players making this
  -- deal, nobody bubbled and the full remaining pool is chopped. A completed
  -- bubble is exact prior pool evidence; partial or differently-owned state is
  -- never resumed.
  IF COALESCE(v_t.bubble_protection, false)
     AND v_field_size > v_ladder_max_place THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has an invalid bubble-protection buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;

    IF v_bubble_place > v_live_count THEN
      SELECT count(*)
        INTO v_bubble_candidate_count
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.position = v_bubble_place
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
         AND tp.elimination_sequence IS NOT NULL
         AND tp.elimination_sequence > 0;
      SELECT tp.user_id
        INTO v_bubble_user_id
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.position = v_bubble_place
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
         AND tp.elimination_sequence IS NOT NULL
         AND tp.elimination_sequence > 0
       ORDER BY tp.id
       LIMIT 1;
      IF v_bubble_candidate_count <> 1 OR v_bubble_user_id IS NULL THEN
        RAISE EXCEPTION
          'tournament % lacks one durable stone-bubble finisher at place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
      v_has_bubble := true;
      v_bubble_amount := v_t.buy_in_amount::numeric(15,2);
      v_bubble_entitlement_cents := round(v_bubble_amount * 100)::bigint;
    END IF;
  END IF;

  SELECT count(*)
    INTO v_bubble_obligation_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';
  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_evidence_count, v_evidence
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';

  IF NOT v_has_bubble THEN
    IF v_bubble_obligation_count <> 0 OR v_evidence_count <> 0 THEN
      RAISE EXCEPTION
        'tournament % has bubble state without an eligible eliminated bubble',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_bubble_obligation_count = 0 AND v_evidence_count = 0 THEN
    v_bubble_paid_cents := 0;
  ELSIF v_bubble_obligation_count = 1 AND v_evidence_count = 0 THEN
    -- A prior atomic attempt may have shaped the canonical debt before any
    -- wallet movement. That state is safe to resume, but only while it is
    -- exactly unpaid and has no orphaned obligation-key credit witness.
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection';
    SELECT count(*) INTO v_rows
      FROM public.wallet_credit_idempotency k
     WHERE k.key LIKE
       'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%';
    IF v_ob.id IS NULL
       OR v_ob.place IS NOT NULL
       OR v_ob.user_id IS DISTINCT FROM v_bubble_user_id
       OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
       OR v_ob.amount_paid IS DISTINCT FROM 0::numeric
       OR v_ob.source IS DISTINCT FROM v_bubble_obligation_source
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NOT NULL
       OR v_rows <> 0 THEN
      RAISE EXCEPTION
        'tournament % has partial or mismatched unpaid bubble-protection state',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_bubble_paid_cents := 0;
  ELSIF v_bubble_obligation_count = 1 AND v_evidence_count = 1 THEN
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection';
    SELECT count(*) INTO v_rows
      FROM public.wallet_credit_idempotency k
     WHERE k.key =
       'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0';
    IF v_ob.id IS NULL
       OR v_ob.place IS NOT NULL
       OR v_ob.user_id IS DISTINCT FROM v_bubble_user_id
       OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
       OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
       OR v_ob.source IS DISTINCT FROM v_bubble_obligation_source
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NULL
       OR v_evidence IS DISTINCT FROM v_bubble_amount
       OR v_rows <> 1
       OR (SELECT count(*)
             FROM public.wallet_credit_idempotency k
            WHERE k.key LIKE
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%')
          <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
           JOIN public.wallet_credit_idempotency k
             ON k.key = p.idempotency_key
            AND k.user_id = p.user_id
            AND k.amount = p.amount
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND p."position" IS NULL
            AND p.user_id = v_bubble_user_id
            AND p.amount = v_bubble_amount
            AND p.idempotency_key =
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0'
       ) THEN
      RAISE EXCEPTION
        'tournament % has partial or mismatched bubble-protection evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_bubble_paid_cents := v_bubble_entitlement_cents;
  ELSE
    RAISE EXCEPTION
      'tournament % has incomplete bubble-protection evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_bubble_shortfall_cents :=
    v_bubble_entitlement_cents - v_bubble_paid_cents;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_ladder) e
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (e->>'place')::integer
     WHERE (e->>'place')::integer > v_live_count
       AND (e->>'cents')::bigint > 0
       AND (tp.id IS NULL OR tp.status::text <> 'eliminated'
         OR tp.eliminated_at IS NULL)
  ) THEN
    RAISE EXCEPTION
      'tournament % has a positive eliminated-place entitlement without its exact finisher',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place', q.place,
           'user_id', q.user_id,
           'amount', q.amount,
           'cents', q.cents,
           'evidence_cents', q.evidence_cents
         ) ORDER BY q.place), '[]'::jsonb)
    INTO v_fixed
    FROM (
      SELECT (e->>'place')::integer AS place,
             tp.user_id,
             (e->>'amount')::numeric(15,2) AS amount,
             (e->>'cents')::bigint AS cents,
             COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
               AS evidence_cents
        FROM jsonb_array_elements(v_ladder) e
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (e->>'place')::integer
        LEFT JOIN public.tournament_payouts p
          ON p.tournament_id = p_tournament_id
         AND p."position" = (e->>'place')::integer
         AND p.user_id = tp.user_id
         AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
         AND p.source <> 'final_table_deal'
         AND p.source <> 'bubble_protection'
       WHERE (e->>'place')::integer > v_live_count
         AND (e->>'cents')::bigint > 0
       GROUP BY (e->>'place')::integer, tp.user_id,
                (e->>'amount')::numeric(15,2), (e->>'cents')::bigint
    ) q;

  SELECT jsonb_array_length(v_fixed),
         COALESCE(sum((e->>'cents')::bigint), 0)::bigint,
         COALESCE(sum((e->>'evidence_cents')::bigint), 0)::bigint
    INTO v_fixed_count, v_fixed_entitlement_cents, v_fixed_paid_cents
    FROM jsonb_array_elements(v_fixed) e;

  -- Pool evidence before the deal must be exact evidence for one of those
  -- fixed eliminated places. Unpositioned, live-place, non-ITM and wrong-user
  -- rows cannot silently shrink the amount being chopped.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND p.source <> 'final_table_deal'
       AND NOT (
         (p.source = 'bubble_protection'
          AND v_has_bubble
          AND p."position" IS NULL
          AND p.user_id = v_bubble_user_id
          AND p.amount = v_bubble_amount)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_fixed) e
            WHERE (e->>'place')::integer = p."position"
              AND (e->>'user_id')::uuid = p.user_id
         )
       )
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_fixed) e
     WHERE (e->>'evidence_cents')::bigint < 0
        OR (e->>'evidence_cents')::bigint > (e->>'cents')::bigint
  ) THEN
    RAISE EXCEPTION
      'tournament % has payout evidence outside an exact fixed-place entitlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
    INTO v_prior_paid_cents
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
     AND COALESCE(p.source, '') <> 'final_table_deal';

  IF v_prior_paid_cents < 0 OR v_prior_paid_cents > v_pool_cents
     OR v_prior_paid_cents <>
          v_fixed_paid_cents + v_bubble_paid_cents THEN
    RAISE EXCEPTION 'tournament % records % prior prize cents against a % cent pool',
      p_tournament_id, v_prior_paid_cents, v_pool_cents
      USING ERRCODE = '23514';
  END IF;
  v_fixed_shortfall_cents := v_fixed_entitlement_cents - v_fixed_paid_cents;
  IF v_fixed_shortfall_cents < 0 OR v_bubble_shortfall_cents < 0
     OR v_prior_paid_cents + v_fixed_shortfall_cents
          + v_bubble_shortfall_cents > v_pool_cents THEN
    RAISE EXCEPTION 'tournament % has invalid fixed-place or bubble reserve',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_undistributed_cents :=
    v_pool_cents - v_prior_paid_cents - v_fixed_shortfall_cents
      - v_bubble_shortfall_cents;

  -- COMPLETING/COMPLETED is an evidence-only replay. It cannot infer a deal
  -- from mutable chip counts or silently convert a normal finish into a deal.
  IF v_status IN ('COMPLETING','COMPLETED') THEN
    IF v_has_bubble
       AND v_bubble_paid_cents <> v_bubble_entitlement_cents THEN
      RAISE EXCEPTION
        'tournament % replay lacks its exact pool-funded bubble receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal'
    ) THEN
      RAISE EXCEPTION 'tournament % is % without a durable final-table-deal receipt',
        p_tournament_id, v_status USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
         AND (p."position" IS NOT NULL OR p.amount <= 0)
    ) THEN
      RAISE EXCEPTION 'tournament % has malformed final-table-deal payout rows',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM (
          SELECT p.user_id, count(*) AS n, sum(p.amount) AS amount,
                 min(p.idempotency_key) AS idempotency_key
            FROM public.tournament_payouts p
           WHERE p.tournament_id = p_tournament_id
             AND p.source = 'final_table_deal'
           GROUP BY p.user_id
        ) e
        LEFT JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = e.user_id
        LEFT JOIN public.tournament_obligations o
          ON o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal'
         AND o.place IS NULL
         AND o.user_id = e.user_id
       WHERE e.n <> 1
          OR tp.id IS NULL
          OR tp.position IS NULL
          OR tp.position < 1
          OR tp.position > v_live_count
          OR tp.prize IS DISTINCT FROM e.amount
          OR (tp.position = 1 AND tp.status::text <> 'winner')
          OR (tp.position > 1 AND tp.status::text <> 'eliminated')
          OR o.id IS NULL
          OR o.amount_owed IS DISTINCT FROM e.amount
          OR o.amount_paid IS DISTINCT FROM e.amount
          OR o.source IS DISTINCT FROM 'final_table_deal'
          OR o.adjustment_id IS NOT NULL
          OR o.settled_at IS NULL
          OR e.idempotency_key IS DISTINCT FROM
             'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':0'
          OR (SELECT count(*)
                FROM public.wallet_credit_idempotency k
               WHERE k.key LIKE
                 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%')
             <> 1
          OR NOT EXISTS (
            SELECT 1
              FROM public.wallet_credit_idempotency k
             WHERE k.key = e.idempotency_key
               AND k.user_id = e.user_id
               AND k.amount = e.amount
          )
    ) OR EXISTS (
      SELECT 1
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal'
         AND (o.place IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'final_table_deal'
              AND p.user_id = o.user_id
         ))
    ) THEN
      RAISE EXCEPTION 'tournament % final-table-deal obligations, evidence and standings disagree',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    IF (SELECT count(*) FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id AND o.kind = 'place')
         <> v_fixed_count
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_fixed) e
           LEFT JOIN public.tournament_obligations o
             ON o.tournament_id = p_tournament_id
            AND o.kind = 'place'
            AND o.place = (e->>'place')::integer
          WHERE o.id IS NULL
             OR o.user_id IS DISTINCT FROM (e->>'user_id')::uuid
             OR o.amount_owed IS DISTINCT FROM (e->>'amount')::numeric
             OR o.amount_paid IS DISTINCT FROM (e->>'amount')::numeric
             OR o.settled_at IS NULL
             OR (e->>'evidence_cents')::bigint <> (e->>'cents')::bigint
       ) THEN
      RAISE EXCEPTION
        'tournament % fixed-place obligations or evidence are not fully settled',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    IF (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.position BETWEEN 1 AND v_field_size) <> v_field_size
       OR EXISTS (
         SELECT 1 FROM generate_series(1, v_field_size) g(place)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id = p_tournament_id
               AND tp.position = g.place
          )
       )
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND (tp.position IS NULL OR tp.position < 1
              OR tp.position > v_field_size)
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.position = 1
            AND tp.status::text = 'winner'
            AND tp.eliminated_at IS NULL
            AND tp.elimination_sequence IS NULL
       )
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.position > 1
            AND (tp.status::text <> 'eliminated'
              OR tp.eliminated_at IS NULL
              OR tp.elimination_sequence IS NULL
              OR tp.elimination_sequence <= 0)
       )
       OR EXISTS (
         SELECT 1
           FROM (
             SELECT tp.position,
                    (1 + row_number() OVER (
                      ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tp.tournament_id, tp.user_id), tp.eliminated_at) DESC NULLS LAST, tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
                      AS expected_position
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'eliminated'
           ) ranked
          WHERE ranked.position IS DISTINCT FROM ranked.expected_position
       )
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.prize IS DISTINCT FROM COALESCE((
              SELECT sum(p.amount)
                FROM public.tournament_payouts p
               WHERE p.tournament_id = p_tournament_id
                 AND p.user_id = tp.user_id
                 AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
            ), 0)
       ) THEN
      RAISE EXCEPTION 'tournament % replay has incomplete final standings',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT count(*) INTO v_vote_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position BETWEEN 1 AND v_live_count
       AND EXISTS (
         SELECT 1 FROM public.tournament_deal_votes v
          WHERE v.tournament_id = p_tournament_id
            AND v.user_id = tp.user_id
       );
    IF v_vote_count <> v_live_count THEN
      RAISE EXCEPTION 'tournament % replay has only % of % durable deal votes',
        p_tournament_id, v_vote_count, v_live_count USING ERRCODE = 'P0404';
    END IF;

    SELECT COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
      INTO v_distributed_cents
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal';
    IF v_prior_paid_cents + v_distributed_cents <> v_pool_cents THEN
      RAISE EXCEPTION 'tournament % replay accounts for % of % prize cents',
        p_tournament_id, v_prior_paid_cents + v_distributed_cents, v_pool_cents
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'place', tp.position,
             'user_id', tp.user_id,
             'amount', p.amount
           ) ORDER BY tp.position), '[]'::jsonb)
      INTO v_payouts
      FROM public.tournament_payouts p
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal';

    SELECT p.amount INTO v_winner_amount
      FROM public.tournament_payouts p
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal'
       AND tp.position = 1;

    RETURN jsonb_build_object(
      'ok', true,
      'fully_settled', true,
      'status', v_status,
      'payouts', v_payouts,
      'winner_amount', v_winner_amount,
      'money_path', 'fn_settle_tournament_final_table_deal');
  END IF;

  IF v_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'tournament % cannot execute a deal from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_t.final_table_deal_enabled, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % does not have final-table deals enabled',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF v_undistributed_cents <= 0 THEN
    RAISE EXCEPTION 'tournament % has no undistributed prize money',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RAISE EXCEPTION 'RUNNING tournament % already has final-table-deal state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_total_chips IS NULL
     OR v_total_chips::text IN ('NaN','Infinity','-Infinity')
     OR v_total_chips <= 0
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text = 'playing'
          AND tp.eliminated_at IS NULL
          AND (tp.chips IS NULL OR tp.chips < 0)
     ) THEN
    RAISE EXCEPTION 'tournament % has invalid live chip evidence',
      p_tournament_id USING ERRCODE = '22003';
  END IF;

  -- A fresh deal may not omit an unresolved roster row or overwrite an
  -- existing standing. Prior eliminated positions must already occupy exactly
  -- the contiguous tail after the players who are about to chop.
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND NOT (tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
       AND (tp.status::text <> 'eliminated' OR tp.position IS NULL
         OR tp.eliminated_at IS NULL
         OR tp.position <= v_live_count OR tp.position > v_field_size)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
       AND tp.position IS NOT NULL
  ) OR (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.position BETWEEN v_live_count + 1 AND v_field_size)
       <> v_field_size - v_live_count
  THEN
    RAISE EXCEPTION 'tournament % roster does not carry a complete pre-deal standing tail',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A pre-existing place debt is accepted only when its owner, amount paid
  -- and payout evidence describe one exact fixed entitlement. A historical
  -- smaller amount_owed may be raised to the canonical structure amount below;
  -- paid evidence may never be rewritten or inferred from the prize cache.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_fixed) e
          WHERE (e->>'place')::integer = o.place
            AND (e->>'user_id')::uuid = o.user_id
            AND o.amount_owed IS NOT NULL
            AND o.amount_paid IS NOT NULL
            AND o.amount_owed::text NOT IN ('NaN','Infinity','-Infinity')
            AND o.amount_paid::text NOT IN ('NaN','Infinity','-Infinity')
            AND o.amount_owed = round(o.amount_owed, 2)
            AND o.amount_paid = round(o.amount_paid, 2)
            AND o.amount_paid >= 0
            AND o.amount_owed >= o.amount_paid
            AND o.amount_owed <= (e->>'amount')::numeric
            AND round(o.amount_paid * 100)::bigint =
                (e->>'evidence_cents')::bigint
       )
  ) THEN
    RAISE EXCEPTION 'tournament % has an incompatible fixed-place obligation',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE
           'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id
            AND p.amount = k.amount
            AND p."position" = o.place
       )
  ) THEN
    RAISE EXCEPTION
      'tournament % has a fixed-place wallet key without exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- An alive player cannot already own prize-bank payout evidence. That would
  -- make the remaining pool valid in aggregate but the recipient debt wrong.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_payouts p
      JOIN public.tournament_players tp
        ON tp.tournament_id = p.tournament_id AND tp.user_id = p.user_id
     WHERE p.tournament_id = p_tournament_id
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
       AND p.amount > 0
  ) THEN
    RAISE EXCEPTION 'tournament % has prior prize evidence for a live deal player',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Lock the current table layout after the three canonical money sets. The
  -- active seats must be exactly the live roster and must all be on one live
  -- tournament table.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY s.id
   FOR UPDATE OF s;

  SELECT count(DISTINCT s.table_id), count(*), count(DISTINCT s.user_id)
    INTO v_live_table_count, v_live_seat_count, v_live_seated_users
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND lower(tb.status::text) IN ('running','waiting')
     AND s.left_at IS NULL
     AND s.user_id IS NOT NULL;
  IF v_live_table_count <> 1
     OR v_live_seat_count <> v_live_count
     OR v_live_seated_users <> v_live_count
     OR EXISTS (
       (SELECT tp.user_id
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
       EXCEPT
       (SELECT s.user_id
          FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = p_tournament_id
           AND lower(tb.status::text) IN ('running','waiting')
           AND s.left_at IS NULL AND s.user_id IS NOT NULL)
     ) OR EXISTS (
       (SELECT s.user_id
          FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = p_tournament_id
           AND lower(tb.status::text) IN ('running','waiting')
           AND s.left_at IS NULL AND s.user_id IS NOT NULL)
       EXCEPT
       (SELECT tp.user_id
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
     ) THEN
    RAISE EXCEPTION 'tournament % live roster is not seated together at one final table',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.tournament_deal_votes v
   WHERE v.tournament_id = p_tournament_id
   ORDER BY v.user_id FOR SHARE;
  SELECT count(*) INTO v_vote_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.tournament_deal_votes v
        WHERE v.tournament_id = p_tournament_id AND v.user_id = tp.user_id
     );
  IF v_vote_count <> v_live_count THEN
    RAISE EXCEPTION 'tournament % has only % of % required live-player votes',
      p_tournament_id, v_vote_count, v_live_count USING ERRCODE = '55000';
  END IF;

  -- Snapshot only real locked roster input, after canonical tail normalization.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,
    'chips',tp.chips,'registered_at',extract(epoch FROM tp.registered_at))
    ORDER BY tp.chips DESC,tp.registered_at ASC NULLS LAST,tp.user_id),'[]'::jsonb)
    INTO v_modern_input FROM public.tournament_players tp
    WHERE tp.tournament_id=p_tournament_id AND tp.status='playing' AND tp.eliminated_at IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',tp.id,'user_id',tp.user_id,
    'club_id',tp.club_id,'position',tp.position,'eliminated_at',extract(epoch FROM tp.eliminated_at),
    'elimination_sequence',tp.elimination_sequence) ORDER BY tp.position),'[]'::jsonb)
    INTO v_modern_tail FROM public.tournament_players tp
    WHERE tp.tournament_id=p_tournament_id AND tp.position>v_live_count;
  SELECT DISTINCT s.table_id INTO STRICT v_modern_table
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
    WHERE tb.tournament_id=p_tournament_id AND lower(tb.status::text) IN ('running','waiting')
      AND s.left_at IS NULL AND s.user_id IS NOT NULL;

  -- Price in integer cents. Each proportional share is floored; the exact
  -- residual goes to the deterministic chip leader (rank 1).
  FOR v_row IN
    SELECT tp.user_id, tp.chips, tp.registered_at
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
     ORDER BY tp.chips DESC, tp.registered_at ASC NULLS LAST, tp.user_id ASC
  LOOP
    v_rank := v_rank + 1;
    v_share_cents := public.fn_ca_unit_floor_cents(
      floor(
        (v_row.chips::numeric * v_undistributed_cents::numeric) / v_total_chips
      )::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id));
    IF v_share_cents <= 0 THEN
      RAISE EXCEPTION 'tournament % chip chop gives rank % a nonpositive share',
        p_tournament_id, v_rank USING ERRCODE = '23514';
    END IF;
    v_distributed_cents := v_distributed_cents + v_share_cents;
    v_shares := v_shares || jsonb_build_object(
      'place', v_rank,
      'user_id', v_row.user_id,
      'cents', v_share_cents);
    IF v_rank = 1 THEN v_leader := v_row.user_id; END IF;
  END LOOP;

  v_remainder_cents := v_undistributed_cents - v_distributed_cents;
  IF v_remainder_cents < 0 OR v_leader IS NULL THEN
    RAISE EXCEPTION 'tournament % produced an invalid deal residual of % cents',
      p_tournament_id, v_remainder_cents USING ERRCODE = '23514';
  END IF;

  -- Add the residual before the first write. Every recipient has one final
  -- amount and one obligation settlement.
  SELECT COALESCE(jsonb_agg(
           CASE WHEN e->>'user_id' = v_leader::text
                THEN jsonb_set(e, '{cents}',
                     to_jsonb((e->>'cents')::bigint + v_remainder_cents))
                ELSE e END
           ORDER BY (e->>'place')::integer
         ), '[]'::jsonb)
    INTO v_shares
    FROM jsonb_array_elements(v_shares) e;

  -- A stone-bubble debt, when one already exists, is part of the same complete
  -- transaction shape. It is pool-funded and user-keyed (position NULL).
  -- Complete historical evidence was proved above; only a genuinely absent
  -- row may be created here.
  IF v_has_bubble AND v_bubble_obligation_count = 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'bubble_protection', NULL, v_bubble_user_id,
       v_bubble_amount, 0, v_bubble_obligation_source, NULL);
  END IF;

  -- Shape every positive fixed-place debt first. Existing evidence seeds
  -- amount_paid exactly; amount_owed becomes the canonical locked entitlement.
  -- No wallet can move until the bubble, this set and every deal share below
  -- all exist.
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount,
           ((e->>'evidence_cents')::numeric / 100)::numeric(15,2)
             AS evidence
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    UPDATE public.tournament_obligations o
       SET amount_owed = v_row.amount,
           user_id = v_row.user_id,
           source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
           updated_at = v_now,
           settled_at = CASE WHEN v_row.evidence = v_row.amount
                             THEN COALESCE(o.settled_at, v_now)
                             ELSE NULL END
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND o.place = v_row.place;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'place', v_row.place, v_row.user_id, v_row.amount,
         v_row.evidence, 'engine.fn_settle_tournament_places',
         CASE WHEN v_row.evidence = v_row.amount THEN v_now ELSE NULL END);
    ELSIF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament %, place % matched % fixed obligations',
        p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
    END IF;
  END LOOP;

  -- Shape every positive deal share. The full positive fixed-place plus
  -- deal-share debt set is durable in this transaction before the first payer.
  INSERT INTO public.tournament_obligations
    (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
  SELECT p_tournament_id,
         'final_table_deal',
         NULL,
         (e->>'user_id')::uuid,
         ((e->>'cents')::numeric / 100)::numeric(15,2),
         0,
         'final_table_deal'
    FROM jsonb_array_elements(v_shares) e
   ORDER BY (e->>'place')::integer;

  PERFORM 1
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('bubble_protection','place','final_table_deal')
   ORDER BY o.kind, o.place NULLS LAST, o.user_id, o.id
   FOR UPDATE;

  IF (v_has_bubble AND (
        (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'bubble_protection') <> 1
        OR NOT EXISTS (
          SELECT 1 FROM public.tournament_obligations o
           WHERE o.tournament_id = p_tournament_id
             AND o.kind = 'bubble_protection'
             AND o.place IS NULL
             AND o.user_id = v_bubble_user_id
             AND o.amount_owed = v_bubble_amount
             AND o.amount_paid =
                 (v_bubble_paid_cents::numeric / 100)::numeric(15,2)
             AND o.source = v_bubble_obligation_source
             AND o.adjustment_id IS NULL
             AND ((v_bubble_paid_cents = v_bubble_entitlement_cents
                    AND o.settled_at IS NOT NULL)
               OR (v_bubble_paid_cents = 0 AND o.settled_at IS NULL))
        )
      ))
     OR (NOT v_has_bubble AND EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'bubble_protection'
     ))
     OR (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place') <> v_fixed_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'place'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_fixed) e
             WHERE (e->>'place')::integer = o.place
               AND (e->>'user_id')::uuid = o.user_id
               AND (e->>'amount')::numeric IS NOT DISTINCT FROM o.amount_owed
               AND ((e->>'evidence_cents')::numeric / 100)::numeric(15,2)
                   IS NOT DISTINCT FROM o.amount_paid
               AND ((o.amount_paid = o.amount_owed AND o.settled_at IS NOT NULL)
                 OR (o.amount_paid < o.amount_owed AND o.settled_at IS NULL))
          )
     )
     OR (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal') <> v_live_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'final_table_deal'
          AND (
            o.place IS NOT NULL
            OR o.amount_paid <> 0
            OR o.source IS DISTINCT FROM 'final_table_deal'
            OR o.settled_at IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_shares) e
               WHERE (e->>'user_id')::uuid = o.user_id
                 AND ((e->>'cents')::numeric / 100)::numeric(15,2)
                     IS NOT DISTINCT FROM o.amount_owed
            )
          )
    ) THEN
    RAISE EXCEPTION
      'tournament % could not shape the complete bubble, fixed-place and deal debt set',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT e.prize_balance INTO STRICT v_modern_escrow_before
    FROM public.tournament_escrow e WHERE e.tournament_id=p_tournament_id AND e.enforced FOR UPDATE;
  v_modern_required:=(v_fixed_shortfall_cents+v_bubble_shortfall_cents+v_undistributed_cents)::numeric/100;
  IF v_modern_required<0 OR v_modern_escrow_before IS DISTINCT FROM v_modern_required THEN
    RAISE EXCEPTION 'canonical final deal lacks exact pre-credit custody';
  END IF;

  -- The complete positive obligation set now exists and is locked. Settle an
  -- eligible pool-funded bubble first, then each fixed place, still inside the
  -- same transaction as the chop. Any later refusal rolls every earlier wallet
  -- credit, payout, obligation and standing back together.
  IF v_has_bubble THEN
    v_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
    IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_result->>'amount_owed')::numeric IS DISTINCT FROM v_bubble_amount
       OR (v_result->>'amount_paid')::numeric IS DISTINCT FROM v_bubble_amount
       OR COALESCE((v_result->>'remaining')::numeric, v_bubble_amount) <> 0 THEN
      RAISE EXCEPTION 'tournament % bubble protection did not settle in full',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    v_result := public.fn_ca_settle_tournament_place_raw(
      p_tournament_id, v_row.place, v_row.user_id, v_row.amount);
    IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_result->>'amount_owed')::numeric IS DISTINCT FROM v_row.amount
       OR (v_result->>'amount_paid')::numeric IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'tournament %, fixed place % did not settle in full',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;

    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_row.user_id
       AND p."position" = v_row.place
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND p.source <> 'final_table_deal';
    IF v_evidence_count < 1 OR v_evidence IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'tournament %, fixed place % lacks exact full evidence',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  v_distributed_cents := 0;
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'cents')::bigint AS cents
      FROM jsonb_array_elements(v_shares) e
     ORDER BY (e->>'place')::integer
  LOOP
    v_amount := (v_row.cents::numeric / 100)::numeric(15,2);
    IF v_amount <= 0 OR v_amount IS DISTINCT FROM round(v_amount, 2) THEN
      RAISE EXCEPTION 'tournament % derived invalid deal amount % for rank %',
        p_tournament_id, v_amount, v_row.place USING ERRCODE = '22003';
    END IF;

    v_result := public.fn_ca_settle_final_table_deal_share_raw(
      p_tournament_id, v_row.user_id, v_amount);
    IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % rank % returned an incomplete deal share',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'final_table_deal'
       AND o.place IS NULL
       AND o.user_id = v_row.user_id;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_row.user_id
       AND p.source = 'final_table_deal'
       AND p."position" IS NULL;
    IF v_ob.id IS NULL
       OR v_ob.amount_owed IS DISTINCT FROM v_amount
       OR v_ob.amount_paid IS DISTINCT FROM v_amount
       OR v_ob.source IS DISTINCT FROM 'final_table_deal'
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NULL
       OR v_evidence_count <> 1
       OR v_evidence IS DISTINCT FROM v_amount
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
           JOIN public.wallet_credit_idempotency k
             ON k.key = p.idempotency_key
            AND k.user_id = p.user_id
            AND k.amount = p.amount
          WHERE p.tournament_id = p_tournament_id
            AND p.user_id = v_row.user_id
            AND p.source = 'final_table_deal'
            AND p."position" IS NULL
            AND p.amount = v_amount
            AND p.idempotency_key =
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0'
       )
       OR (SELECT count(*)
             FROM public.wallet_credit_idempotency k
            WHERE k.key LIKE
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%')
          <> 1 THEN
      RAISE EXCEPTION 'tournament % rank % did not write one exact payout row',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;

    v_distributed_cents := v_distributed_cents + v_row.cents;
    v_payouts := v_payouts || jsonb_build_object(
      'place', v_row.place,
      'user_id', v_row.user_id,
      'amount', v_amount);
    IF v_row.place = 1 THEN v_winner_amount := v_amount; END IF;
  END LOOP;

  IF v_distributed_cents <> v_undistributed_cents
     OR v_prior_paid_cents + v_fixed_shortfall_cents
        + v_bubble_shortfall_cents + v_distributed_cents <> v_pool_cents
     OR (SELECT COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
           FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND NOT (COALESCE(p.source, '') = ANY (v_not_pool)))
        <> v_pool_cents THEN
    RAISE EXCEPTION 'tournament % deal distributed % of % remaining cents',
      p_tournament_id, v_distributed_cents, v_undistributed_cents
      USING ERRCODE = '23514';
  END IF;

  -- The final standings and presentation cache commit with the money. Existing
  -- eliminated standings were proved above and are never rebuilt from clocks.
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           ((e->>'cents')::numeric / 100)::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_shares) e
     ORDER BY (e->>'place')::integer DESC
  LOOP
    UPDATE public.tournament_players
       SET position = v_row.place,
           prize = v_row.amount,
           status = CASE WHEN v_row.place = 1
                         THEN 'winner'
                         ELSE 'eliminated' END,
           eliminated_at = CASE WHEN v_row.place = 1 THEN NULL ELSE v_now END
     WHERE tournament_id = p_tournament_id
       AND user_id = v_row.user_id
       AND status::text = 'playing'
       AND eliminated_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament % could not stamp one standing for rank %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  -- Prize is presentation cache, never payment evidence. Every eliminated
  -- tail row starts at zero; positive fixed places then receive their full
  -- locked structure entitlement, not merely the amount that happened to be
  -- paid before this transaction.
  UPDATE public.tournament_players tp
     SET prize = 0
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position > v_live_count;
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    UPDATE public.tournament_players tp
       SET prize = v_row.amount
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_row.place
       AND tp.user_id = v_row.user_id
       AND tp.status::text = 'eliminated';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament % could not stamp fixed prize place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_has_bubble THEN
    UPDATE public.tournament_players tp
       SET prize = v_bubble_amount
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.user_id = v_bubble_user_id
       AND tp.status::text = 'eliminated'
       AND tp.eliminated_at IS NOT NULL
       AND tp.elimination_sequence IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament % could not stamp its stone-bubble prize cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Keep RUNNING until every canonical payment and standing is proved below.
  -- Only fn_claim_tournament_finish may claim the lifecycle transition.

  -- Prove the exact durable state after every write. Any discrepancy aborts
  -- the statement and therefore every share credited above.
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           ((e->>'cents')::numeric / 100)::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_shares) e
     ORDER BY (e->>'place')::integer
  LOOP
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'final_table_deal'
       AND o.place IS NULL
       AND o.user_id = v_row.user_id;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal'
       AND p."position" IS NULL
       AND p.user_id = v_row.user_id;
    IF v_ob.id IS NULL
       OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
       OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
       OR v_ob.source IS DISTINCT FROM 'final_table_deal'
       OR v_ob.settled_at IS NULL
       OR v_evidence_count <> 1
       OR v_evidence IS DISTINCT FROM v_row.amount
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.user_id = v_row.user_id
            AND tp.position = v_row.place
            AND tp.prize IS NOT DISTINCT FROM v_row.amount
            AND tp.status::text = CASE WHEN v_row.place = 1 THEN 'winner' ELSE 'eliminated' END
       ) THEN
      RAISE EXCEPTION 'tournament % failed post-deal proof at rank %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND o.place = v_row.place;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_row.user_id
       AND p."position" = v_row.place
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND p.source <> 'final_table_deal';
    IF v_ob.id IS NULL
       OR v_ob.user_id IS DISTINCT FROM v_row.user_id
       OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
       OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
       OR v_ob.settled_at IS NULL
       OR v_evidence_count < 1
       OR v_evidence IS DISTINCT FROM v_row.amount
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.user_id = v_row.user_id
            AND tp.position = v_row.place
            AND tp.prize IS NOT DISTINCT FROM v_row.amount
            AND tp.status::text = 'eliminated'
            AND tp.eliminated_at IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'tournament % failed fixed-place proof at place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_has_bubble THEN
    SELECT count(*) INTO v_bubble_obligation_count
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection';
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.place IS NULL
       AND o.user_id = v_bubble_user_id;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'bubble_protection';
    SELECT count(*) INTO v_rows
      FROM public.wallet_credit_idempotency k
     WHERE k.key =
       'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0';
    IF v_bubble_obligation_count <> 1
       OR v_ob.id IS NULL
       OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
       OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
       OR v_ob.source IS DISTINCT FROM v_bubble_obligation_source
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NULL
       OR v_evidence_count <> 1
       OR v_evidence IS DISTINCT FROM v_bubble_amount
       OR v_rows <> 1
       OR (SELECT count(*)
             FROM public.wallet_credit_idempotency k
            WHERE k.key LIKE
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%')
          <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
           JOIN public.wallet_credit_idempotency k
             ON k.key = p.idempotency_key
            AND k.user_id = p.user_id
            AND k.amount = p.amount
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND p."position" IS NULL
            AND p.user_id = v_bubble_user_id
            AND p.amount = v_bubble_amount
            AND p.idempotency_key =
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0'
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.user_id = v_bubble_user_id
            AND tp.position = v_bubble_place
            AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
            AND tp.status::text = 'eliminated'
            AND tp.eliminated_at IS NOT NULL
            AND tp.elimination_sequence IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'tournament % failed pool-funded bubble proof',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position IS NOT NULL)
       <> v_field_size
     OR EXISTS (
       SELECT 1 FROM generate_series(1, v_field_size) g(place)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id AND tp.position = g.place
        )
     )
     OR EXISTS (
       SELECT 1
         FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text = 'eliminated'
          AND (tp.eliminated_at IS NULL OR tp.elimination_sequence IS NULL
            OR tp.elimination_sequence <= 0)
     )
     OR EXISTS (
       SELECT 1
         FROM (
           SELECT tp.position,
                  (1 + row_number() OVER (
                    ORDER BY COALESCE(public.fn_ca_tournament_bust_at(tp.tournament_id, tp.user_id), tp.eliminated_at) DESC NULLS LAST, tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
                    AS expected_position
             FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.status::text = 'eliminated'
         ) ranked
        WHERE ranked.position IS DISTINCT FROM ranked.expected_position
     )
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.prize IS DISTINCT FROM COALESCE((
            SELECT sum(p.amount)
              FROM public.tournament_payouts p
             WHERE p.tournament_id = p_tournament_id
               AND p.user_id = tp.user_id
               AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
          ), 0)
     ) THEN
    RAISE EXCEPTION 'tournament % did not finish with one standing per roster row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Publish the immutable v2 header only after all original canonical proofs.
  SELECT jsonb_agg(jsonb_build_object('kind',q.kind,'place',q.place,
    'user_id',q.user_id,'club_id',tp.club_id,'cents',q.cents) ORDER BY q.place)
    INTO v_modern_plan FROM (
      SELECT 'place' kind,(x->>'place')::integer place,(x->>'user_id')::uuid user_id,
        round((x->>'amount')::numeric*100)::bigint cents FROM jsonb_array_elements(v_fixed) x
      UNION ALL
      SELECT 'final_table_deal',(x->>'place')::integer,(x->>'user_id')::uuid,
        (x->>'cents')::bigint FROM jsonb_array_elements(v_shares) x
    ) q JOIN public.tournament_players tp
      ON tp.tournament_id=p_tournament_id AND tp.user_id=q.user_id;
  IF v_has_bubble THEN
    SELECT * INTO STRICT v_ob FROM public.tournament_obligations
     WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  END IF;
  IF (SELECT prize_balance FROM public.tournament_escrow WHERE tournament_id=p_tournament_id)
      IS DISTINCT FROM v_modern_escrow_before-v_modern_required THEN
    RAISE EXCEPTION 'canonical final deal lost exact custody delta';
  END IF;
  INSERT INTO public.tournament_final_table_deal_batches(
    tournament_id,plan_fingerprint,plan,prior_standings_fingerprint,
    live_input_snapshot,live_input_fingerprint,field_count,live_count,
    structure_place_count,place_line_count,deal_line_count,place_amount,deal_amount,
    amount_owed,bubble_contract_required,bubble_obligation_id,bubble_user_id,bubble_source,
    bubble_amount_owed,bubble_amount_paid_before,amount_moved,
    escrow_prize_before,escrow_prize_after,deal_table_id,chip_leader,source,settled_at,contract_version)
  VALUES(p_tournament_id,md5(v_modern_plan::text),v_modern_plan,md5(v_modern_tail::text),
    v_modern_input,md5(v_modern_input::text),v_field_size,v_live_count,
    jsonb_array_length(v_ladder),v_fixed_count,v_live_count,v_fixed_entitlement_cents::numeric/100,
    v_undistributed_cents::numeric/100,
    (v_fixed_entitlement_cents+v_undistributed_cents)::numeric/100,v_has_bubble,
    CASE WHEN v_has_bubble THEN v_ob.id ELSE NULL END,
    CASE WHEN v_has_bubble THEN v_bubble_user_id ELSE NULL END,
    CASE WHEN v_has_bubble THEN v_ob.source ELSE NULL END,
    v_bubble_amount,v_bubble_paid_cents::numeric/100,v_modern_required,
    v_modern_escrow_before,0,v_modern_table,v_leader,
    'engine.fn_settle_tournament_final_table_deal',transaction_timestamp(),2);
  PERFORM public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,false);
  v_modern_claim:=public.fn_claim_tournament_finish(
    p_tournament_id,v_leader,'engine.fn_settle_tournament_final_table_deal');
  IF COALESCE((v_modern_claim->>'ok')::boolean,false) IS NOT TRUE
    OR v_modern_claim->>'finish_kind' IS DISTINCT FROM 'final_table_deal'
    OR (v_modern_claim->>'winner_user_id')::uuid IS DISTINCT FROM v_leader
    OR v_modern_claim->>'status' IS DISTINCT FROM 'COMPLETING'
    OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND status='COMPLETING')
    OR NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
      WHERE f.tournament_id=p_tournament_id AND f.finish_kind='final_table_deal'
       AND f.winner_user_id=v_leader) THEN
    RAISE EXCEPTION 'canonical final deal finish claim refused: %',v_modern_claim;
  END IF;
  v_status:='COMPLETING';
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', v_status,
    'payouts', v_payouts,
    'winner_amount', v_winner_amount,
    'money_path', 'fn_settle_tournament_final_table_deal');
END;
$f08_fn_settle_tournament_final_table_deal$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- POST-IMAGE ASSERTION. The new state is exactly what was intended.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_expected CONSTANT jsonb := jsonb_build_object(
    'fn_ca_assert_satellite_cohort_standings', '5c883464a5d0c61e32259a8764f08db0',
    'fn_ca_settle_satellite_cohort', '86709c353867d59865ba23c5bdbcd7a8',
    'fn_ca_verify_terminal_final_deal_batch', '840142310ec87ae666781e4ede4ad910',
    'fn_settle_satellite_tournament_pre_money_path_gate', '7609e96c95470e808c8de1731bd9b531',
    'fn_settle_tournament_bubble_protection', 'eed2be3c09c220dc849712857befc07f',
    'fn_settle_tournament_final_table_deal', 'e9af126962604791e1fa95a8ca27e836'
  );
  v_name text;
  v_md5 text;
  v_calls integer;
BEGIN
  -- The helper is installed, owned, restricted and byte-exact.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_tournament_bust_at'
       AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_user_id uuid'
       AND pg_get_function_result(p.oid) = 'timestamp with time zone'
       AND md5(p.prosrc) = 'c5b7ee34f9105658870eaa3c874c314d'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef AND p.provolatile = 's'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_ca_tournament_bust_at is not as intended'
      USING ERRCODE = '55000';
  END IF;

  -- Every replaced body is byte-exact, and its authority is untouched.
  FOR v_name, v_md5 IN SELECT * FROM jsonb_each_text(v_expected) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_name
         AND md5(p.prosrc) = v_md5
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.prosecdef AND NOT p.proisstrict AND p.provolatile = 'v'
    ) THEN
      RAISE EXCEPTION 'post-image: public.% is not as intended', v_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Owner, ACL and settings survived the replacement exactly as read.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_assert_satellite_cohort_standings'
       AND p.proacl::text = '{postgres=X/postgres}' AND p.proconfig::text = '{search_path=public}'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_ca_assert_satellite_cohort_standings lost its grants or settings'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settle_satellite_cohort'
       AND p.proacl::text = '{postgres=X/postgres}' AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_ca_settle_satellite_cohort lost its grants or settings'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_ca_verify_terminal_final_deal_batch'
       AND p.proacl::text = '{postgres=X/postgres}' AND p.proconfig::text = '{"search_path=public, pg_temp"}'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_ca_verify_terminal_final_deal_batch lost its grants or settings'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_satellite_tournament_pre_money_path_gate'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_settle_satellite_tournament_pre_money_path_gate lost its grants or settings'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_bubble_protection'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_settle_tournament_bubble_protection lost its grants or settings'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_final_table_deal'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig::text = '{search_path=public,statement_timeout=30s}'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_settle_tournament_final_table_deal lost its grants or settings'
      USING ERRCODE = '55000';
  END IF;

  -- No finishing ladder in these six still opens on the recording order, and
  -- each reads the shared witness exactly where it used to sort by it.
  SELECT count(*) INTO v_calls FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
     'fn_ca_assert_satellite_cohort_standings','fn_ca_settle_satellite_cohort',
     'fn_ca_verify_terminal_final_deal_batch',
     'fn_settle_satellite_tournament_pre_money_path_gate',
     'fn_settle_tournament_bubble_protection','fn_settle_tournament_final_table_deal'])
     AND (p.prosrc LIKE '%ORDER BY elimination_sequence DESC)%'
       OR p.prosrc LIKE '%ORDER BY elimination_sequence DESC,id)%'
       OR p.prosrc LIKE '%ORDER BY tp.elimination_sequence DESC, tp.id ASC%'
       OR p.prosrc LIKE '%ORDER BY tp.elimination_sequence ASC, tp.id ASC%'
       OR p.prosrc LIKE '%ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC%');
  IF v_calls <> 0 THEN
    RAISE EXCEPTION 'post-image: % of the six ladders still opens on the recording order', v_calls
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_calls FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
     'fn_ca_assert_satellite_cohort_standings','fn_ca_settle_satellite_cohort',
     'fn_ca_verify_terminal_final_deal_batch',
     'fn_settle_satellite_tournament_pre_money_path_gate',
     'fn_settle_tournament_bubble_protection','fn_settle_tournament_final_table_deal'])
     AND p.prosrc LIKE '%fn_ca_tournament_bust_at%';
  IF v_calls <> 6 THEN
    RAISE EXCEPTION 'post-image: only % of 6 ladders read the bust witness', v_calls
      USING ERRCODE = '55000';
  END IF;

  -- The cash ladder this rule was copied from is untouched by this migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_settle_tournament_places'
       AND md5(p.prosrc) = '5ab3977d33d618504cd9b1e79f2b4957'
  ) THEN
    RAISE EXCEPTION 'post-image: public.fn_settle_tournament_places was altered'
      USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
