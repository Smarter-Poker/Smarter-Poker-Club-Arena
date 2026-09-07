-- A FINAL-TABLE DEAL PAYS EVERY PRIOR PLACE AND EVERY CHOP SHARE, OR NONE.
--
-- The old deal crossed three incompatible sources of truth:
--
--   * tournament_players.prize (an award cache),
--   * tournament_payouts (evidence that money moved), and
--   * tournament_obligations (what is still owed).
--
-- fn_final_table_deal added BOTH the prize cache and payout evidence when it
-- computed the undistributed pool. The same prize was therefore counted twice.
-- It also counted unrelated payout classes. It then paid one live player at a
-- time through independent child calls and returned ok:true even when one of
-- those calls refused. The engine completed the tournament anyway.
--
-- This migration gives the deal one immutable, exact-cent plan. Published
-- structure entitlements already earned by eliminated players and the live
-- chip-proportional chop together allocate exactly the finalized prize pool.
-- Every obligation, wallet credit, payout row, prize cache, final standing and
-- the COMPLETED transition lives in one exception subtransaction. A refusal,
-- partial child result, constraint failure or deadlock rolls all of it back.
-- Payout evidence -- never tournament_players.prize by itself -- is the only
-- prior payment recognized. Replays verify the frozen plan and return success
-- without moving another chip.
--
-- The physical final table is part of that proof. Headcount alone is not a
-- final table: before allocating anything, the settler locks the tournament's
-- table/seat tree and requires every live roster member, exactly once, on one
-- running/waiting table, with no stale, anonymous, eliminated or closed-table
-- live seat. The proven table id is bound into the immutable batch fingerprint.
--
-- Bubble Protection uses the already-published, entrant-frozen buy-in contract.
-- Under the same final-field locks, the deal adopts an exact existing row or
-- materializes the one missing zero-paid promise for the canonical final rank.
-- Its remaining amount joins the same escrow preflight, child-settlement proof
-- and rollback boundary as every place/share. Existing ambiguous evidence is
-- never repriced or guessed, and clearing the feature flag cannot hide it.

BEGIN;

SET LOCAL lock_timeout = '4s';

CREATE TABLE IF NOT EXISTS public.tournament_final_table_deal_batches (
  tournament_id        uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  plan_fingerprint     text NOT NULL CHECK (plan_fingerprint ~ '^[0-9a-f]{32}$'),
  plan                 jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'array'),
  prior_standings_fingerprint text NOT NULL CHECK (
                         prior_standings_fingerprint ~ '^[0-9a-f]{32}$'),
  live_input_snapshot  jsonb NOT NULL CHECK (jsonb_typeof(live_input_snapshot) = 'array'),
  live_input_fingerprint text NOT NULL CHECK (
                         live_input_fingerprint ~ '^[0-9a-f]{32}$'),
  field_count          integer NOT NULL CHECK (field_count >= 2),
  live_count           integer NOT NULL CHECK (live_count >= 2),
  structure_place_count integer NOT NULL CHECK (structure_place_count >= 1),
  place_line_count     integer NOT NULL CHECK (place_line_count >= 0),
  deal_line_count      integer NOT NULL CHECK (deal_line_count >= 2),
  place_amount         numeric(15,2) NOT NULL CHECK (place_amount >= 0),
  deal_amount          numeric(15,2) NOT NULL CHECK (deal_amount >= 0),
  amount_owed          numeric(15,2) NOT NULL CHECK (amount_owed >= 0),
  bubble_contract_required boolean NOT NULL,
  bubble_obligation_id uuid,
  bubble_user_id       uuid,
  bubble_source        text,
  bubble_amount_owed   numeric(15,2) NOT NULL CHECK (bubble_amount_owed >= 0),
  bubble_amount_paid_before numeric(15,2) NOT NULL CHECK (
                         bubble_amount_paid_before >= 0
                         AND bubble_amount_paid_before <= bubble_amount_owed),
  amount_moved         numeric(15,2) NOT NULL CHECK (
                         amount_moved >= 0
                         AND amount_moved <= amount_owed + bubble_amount_owed),
  escrow_prize_before  numeric(15,2) NOT NULL CHECK (escrow_prize_before >= 0),
  escrow_prize_after   numeric(15,2) CHECK (
                         escrow_prize_after IS NULL OR escrow_prize_after >= 0),
  deal_table_id        uuid NOT NULL,
  chip_leader          uuid NOT NULL,
  source               text NOT NULL,
  prepared_at          timestamptz NOT NULL DEFAULT now(),
  settled_at           timestamptz,
  CONSTRAINT tournament_final_table_deal_bubble_shape CHECK (
    (bubble_contract_required
      AND bubble_obligation_id IS NOT NULL
      AND bubble_user_id IS NOT NULL
      AND bubble_source IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
      AND bubble_amount_owed > 0)
    OR
    (NOT bubble_contract_required
      AND bubble_obligation_id IS NULL
      AND bubble_user_id IS NULL
      AND bubble_source IS NULL
      AND bubble_amount_owed = 0
      AND bubble_amount_paid_before = 0)
  )
);

ALTER TABLE public.tournament_final_table_deal_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_final_table_deal_batches FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.tournament_final_table_deal_batches FROM service_role;
GRANT SELECT ON public.tournament_final_table_deal_batches TO service_role;

COMMENT ON TABLE public.tournament_final_table_deal_batches IS
  'Immutable exact-cent final-table-deal plan: prior eliminated structure places plus every live chop share. Only the atomic SECURITY DEFINER settler may write it.';

/* The normal-place migration owns this trigger name. Extend its definition to
   both terminal contracts after the final-table-deal batch table exists. The
   deal settler stamps every legitimate result first and inserts its batch
   second in the same locked transaction; from that insert onward, neither a
   privileged request nor a replay can rewrite the frozen chronology. */
CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = OLD.tournament_id
      UNION ALL
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = NEW.tournament_id
      UNION ALL
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;
  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a result frozen by an atomic settlement batch cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.user_id, NEW.club_id, NEW.status,
         NEW.position, NEW.prize, NEW.eliminated_at, NEW.chips,
         NEW.registered_at, NEW.rebuys, NEW.add_on)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.user_id, OLD.club_id, OLD.status,
         OLD.position, OLD.prize, OLD.eliminated_at, OLD.chips,
         OLD.registered_at, OLD.rebuys, OLD.add_on) THEN
    RAISE EXCEPTION
      'a result frozen by an atomic settlement batch cannot change identity, payout club, status, position, prize, bust time or deal input'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_freeze_batched_tournament_result()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zzzz_freeze_batched_tournament_result
  ON public.tournament_players;
CREATE TRIGGER zzzz_freeze_batched_tournament_result
BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_players
FOR EACH ROW
EXECUTE FUNCTION public.trg_freeze_batched_tournament_result();

/* Once the batch exists, neither a legacy caller nor a privileged PostgREST
   request may replace, increase, rekey or delete one of its place/deal
   obligations. The atomic settler opens the transaction-local gate only for
   amount_paid/settled_at progress made by its child settle calls. */
CREATE OR REPLACE FUNCTION public.trg_freeze_atomic_final_table_deal_obligation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
  v_gate text := COALESCE(current_setting('app.atomic_final_table_deal_batch', true), '');
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.kind IN ('place', 'final_table_deal', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.kind IN ('place', 'final_table_deal', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;

  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'obligations frozen by an atomic final-table deal cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.kind, NEW.place, NEW.user_id,
         NEW.amount_owed, NEW.source, NEW.created_at, NEW.adjustment_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.kind, OLD.place, OLD.user_id,
         OLD.amount_owed, OLD.source, OLD.created_at, OLD.adjustment_id) THEN
    RAISE EXCEPTION
      'a frozen final-table-deal obligation identity, recipient or entitlement cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN
    RAISE EXCEPTION
      'final-table-deal obligations for tournament % are frozen by their atomic batch',
      OLD.tournament_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_paid + 0.005 < OLD.amount_paid
     OR NEW.amount_paid > NEW.amount_owed + 0.005
     OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION
      'a frozen final-table-deal payment record cannot move backwards or above its entitlement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_freeze_atomic_final_table_deal_obligation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zzzzz_freeze_atomic_final_table_deal_obligation
  ON public.tournament_obligations;
CREATE TRIGGER zzzzz_freeze_atomic_final_table_deal_obligation
BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_obligations
FOR EACH ROW
EXECUTE FUNCTION public.trg_freeze_atomic_final_table_deal_obligation();

/* One verifier is used by the atomic function before the terminal write, by
   the BEFORE COMPLETED trigger, and by replay. That prevents three subtly
   different definitions of "the deal finished". It deliberately recognizes
   only the closed set of place evidence classes and final_table_deal itself;
   an unrelated payout source can never satisfy a place obligation. */
CREATE OR REPLACE FUNCTION public.fn_check_atomic_final_table_deal(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_t                         record;
  v_batch                     public.tournament_final_table_deal_batches%ROWTYPE;
  v_line_count                integer := 0;
  v_place_lines               integer := 0;
  v_deal_lines                integer := 0;
  v_distinct_places           integer := 0;
  v_distinct_deal_users       integer := 0;
  v_distinct_deal_ranks       integer := 0;
  v_min_deal_rank             integer := 0;
  v_max_deal_rank             integer := 0;
  v_place_cents               bigint := 0;
  v_deal_cents                bigint := 0;
  v_obligation_mismatches     integer := 0;
  v_extra_obligations         integer := 0;
  v_evidence_mismatches       integer := 0;
  v_unexpected_place_evidence integer := 0;
  v_unexpected_deal_evidence  integer := 0;
  v_prize_mismatches          integer := 0;
  v_standing_mismatches       integer := 0;
  v_prior_count               integer := 0;
  v_prior_missing_bust_time   integer := 0;
  v_prior_canonical_mismatches integer := 0;
  v_prior_standings_fingerprint text;
  v_player_count              integer := 0;
  v_unranked                  integer := 0;
  v_distinct_positions        integer := 0;
  v_min_position              integer := 0;
  v_max_position              integer := 0;
  v_winners                   integer := 0;
  v_winner_at_one             integer := 0;
  v_nonterminal               integer := 0;
  v_missing_bust_time         integer := 0;
  v_snapshot_count            integer := 0;
  v_snapshot_distinct_players integer := 0;
  v_snapshot_distinct_users   integer := 0;
  v_snapshot_distinct_seats   integer := 0;
  v_snapshot_wrong_tables     integer := 0;
  v_snapshot_input_mismatches integer := 0;
  v_snapshot_share_mismatches integer := 0;
  v_bubble_user               uuid;
  v_bubble_holders            integer := 0;
  v_bubble_obligations        integer := 0;
  v_bubble_matching           integer := 0;
  v_bubble_owed               numeric := 0;
  v_bubble_paid               numeric := 0;
  v_bubble_evidence           numeric := 0;
  v_bubble_conflicts          integer := 0;
  v_bubble_obligation_id      uuid;
  v_bubble_source             text;
  v_bubble_settled_at         timestamptz;
  v_bubble_obligation_present boolean := false;
  v_bubble_payout_present     boolean := false;
  v_bubble_required           boolean := false;
  v_bubble_shape_valid        boolean := false;
  v_escrow                    public.tournament_escrow%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required');
  END IF;

  SELECT t.id, t.status, round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         COALESCE(t.bubble_protection, false) AS bubble_protection,
         round(COALESCE(t.buy_in_amount, 0), 2) AS buy_in_amount
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  SELECT * INTO v_batch
    FROM public.tournament_final_table_deal_batches b
   WHERE b.tournament_id = p_tournament_id;
  IF NOT FOUND OR v_batch.settled_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'atomic_deal_batch_is_not_settled');
  END IF;
  IF md5(v_batch.live_input_snapshot::text)
       <> v_batch.live_input_fingerprint THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'atomic_deal_live_input_fingerprint_changed');
  END IF;
  IF md5(jsonb_build_object(
                            'bubble_contract_required', v_batch.bubble_contract_required,
                            'bubble_obligation_id', v_batch.bubble_obligation_id,
                            'bubble_user_id', v_batch.bubble_user_id,
                            'bubble_source', v_batch.bubble_source,
                            'bubble_amount_owed',
                              round(COALESCE(v_batch.bubble_amount_owed, 0) * 100)::bigint,
                            'bubble_amount_paid_before',
                              round(COALESCE(v_batch.bubble_amount_paid_before, 0) * 100)::bigint,
                            'deal_table_id', v_batch.deal_table_id,
                            'live_input_fingerprint', v_batch.live_input_fingerprint,
                            'prior_standings_fingerprint',
                              v_batch.prior_standings_fingerprint,
                            'plan', v_batch.plan)::text)
       <> v_batch.plan_fingerprint THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'atomic_deal_plan_fingerprint_changed');
  END IF;
  IF NOT v_t.prize_pool_finalized
     OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prize_pool_is_not_funded_and_finalized');
  END IF;

  SELECT * INTO v_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF NOT FOUND OR NOT v_escrow.enforced
     OR v_batch.escrow_prize_after IS NULL
     OR abs(v_batch.escrow_prize_before - v_batch.amount_moved
            - v_batch.escrow_prize_after) > 0.005
     OR abs(round(v_escrow.prize_balance, 2)
            - v_batch.escrow_prize_after) > 0.005 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'atomic_deal_escrow_proof_is_invalid');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_batch.plan) e
     WHERE jsonb_typeof(e) <> 'object'
        OR COALESCE(e->>'kind', '') NOT IN ('place', 'final_table_deal')
        OR COALESCE(e->>'user_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR COALESCE(e->>'cents', '') !~ '^[0-9]+$'
        OR ((e->>'kind') = 'place'
            AND (COALESCE(e->>'place', '') !~ '^[1-9][0-9]*$'
                 OR e->>'rank' IS NOT NULL))
        OR ((e->>'kind') = 'final_table_deal'
            AND (e->>'place' IS NOT NULL
                 OR COALESCE(e->>'rank', '') !~ '^[1-9][0-9]*$'))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'atomic_deal_plan_is_malformed');
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE x.kind = 'place'),
         count(*) FILTER (WHERE x.kind = 'final_table_deal'),
         count(DISTINCT x.place) FILTER (WHERE x.kind = 'place'),
         count(DISTINCT x.user_id) FILTER (WHERE x.kind = 'final_table_deal'),
         count(DISTINCT x.rank) FILTER (WHERE x.kind = 'final_table_deal'),
         COALESCE(min(x.rank) FILTER (WHERE x.kind = 'final_table_deal'), 0),
         COALESCE(max(x.rank) FILTER (WHERE x.kind = 'final_table_deal'), 0),
         COALESCE(sum(x.cents) FILTER (WHERE x.kind = 'place'), 0),
         COALESCE(sum(x.cents) FILTER (WHERE x.kind = 'final_table_deal'), 0)
    INTO v_line_count, v_place_lines, v_deal_lines, v_distinct_places,
         v_distinct_deal_users, v_distinct_deal_ranks,
         v_min_deal_rank, v_max_deal_rank, v_place_cents, v_deal_cents
    FROM jsonb_to_recordset(v_batch.plan)
      AS x(kind text, place integer, user_id uuid, cents bigint, rank integer);

  IF v_line_count <> v_batch.place_line_count + v_batch.deal_line_count
     OR v_place_lines <> v_batch.place_line_count
     OR v_deal_lines <> v_batch.deal_line_count
     OR v_distinct_places <> v_place_lines
     OR v_distinct_deal_users <> v_deal_lines
     OR v_distinct_deal_ranks <> v_deal_lines
     OR v_min_deal_rank <> 1 OR v_max_deal_rank <> v_deal_lines
     OR v_deal_lines <> v_batch.live_count
     OR v_place_cents <> round(v_batch.place_amount * 100)::bigint
     OR v_deal_cents <> round(v_batch.deal_amount * 100)::bigint
     OR v_place_cents + v_deal_cents <> round(v_batch.amount_owed * 100)::bigint
     OR round(v_batch.amount_owed * 100)::bigint <> round(v_t.prize_pool * 100)::bigint
     OR NOT EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_batch.plan)
           AS leader(kind text, place integer, user_id uuid, cents bigint, rank integer)
        WHERE leader.kind = 'final_table_deal' AND leader.rank = 1
          AND leader.user_id = v_batch.chip_leader
     ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'atomic_deal_header_disagrees_with_plan');
  END IF;

  /* Re-derive every deal share from the frozen pre-deal inputs. The live
     players are terminal by the time this verifier runs, and their physical
     seats may be torn down after completion, so the immutable snapshot is the
     allocation source while the frozen player columns prove that the snapshot
     still names the same chips and tie-break inputs. */
  IF jsonb_array_length(v_batch.live_input_snapshot) <> v_batch.live_count
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(v_batch.live_input_snapshot) e
        WHERE jsonb_typeof(e) <> 'object'
           OR COALESCE(e->>'player_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR COALESCE(e->>'user_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR COALESCE(e->>'seat_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR COALESCE(e->>'table_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR COALESCE(e->>'chips', '') !~ '^[0-9]+([.][0-9]+)?$'
           OR (e->>'chips')::numeric <= 0
           OR COALESCE(e->>'seat_stack', '') !~ '^[0-9]+([.][0-9]+)?$'
           OR (e->>'seat_stack')::numeric IS DISTINCT FROM (e->>'chips')::numeric
           OR COALESCE(e->>'registered_at_utc', '') !~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}$'
           OR COALESCE(e->>'rebuys', '') !~ '^[0-9]+$'
           OR jsonb_typeof(e->'add_on') IS DISTINCT FROM 'boolean'
     ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'atomic_deal_live_input_is_malformed');
  END IF;

  SELECT count(*), count(DISTINCT s.player_id), count(DISTINCT s.user_id),
         count(DISTINCT s.seat_id),
         count(*) FILTER (WHERE s.table_id IS DISTINCT FROM v_batch.deal_table_id)
    INTO v_snapshot_count, v_snapshot_distinct_players,
         v_snapshot_distinct_users, v_snapshot_distinct_seats,
         v_snapshot_wrong_tables
    FROM jsonb_to_recordset(v_batch.live_input_snapshot)
      AS s(player_id uuid, user_id uuid, chips numeric,
           registered_at_utc text, rebuys integer, add_on boolean,
           seat_id uuid, table_id uuid, seat_stack numeric);

  SELECT count(*) INTO v_snapshot_input_mismatches
    FROM jsonb_to_recordset(v_batch.live_input_snapshot)
      AS s(player_id uuid, user_id uuid, chips numeric,
           registered_at_utc text, rebuys integer, add_on boolean,
           seat_id uuid, table_id uuid, seat_stack numeric)
    LEFT JOIN public.tournament_players tp
      ON tp.id = s.player_id AND tp.tournament_id = p_tournament_id
     AND tp.user_id = s.user_id
   WHERE tp.id IS NULL
      OR tp.chips IS DISTINCT FROM s.chips
      OR to_char(tp.registered_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US') IS DISTINCT FROM s.registered_at_utc
      OR COALESCE(tp.rebuys, 0) IS DISTINCT FROM s.rebuys
      OR COALESCE(tp.add_on, false) IS DISTINCT FROM s.add_on;

  WITH input AS (
    SELECT s.user_id, s.chips, s.registered_at_utc,
           row_number() OVER (
             ORDER BY s.chips DESC, s.registered_at_utc ASC, s.user_id ASC
           )::integer AS rank,
           floor(s.chips / sum(s.chips) OVER ()
                 * round(v_batch.deal_amount * 100)::bigint)::bigint AS floor_cents
      FROM jsonb_to_recordset(v_batch.live_input_snapshot)
        AS s(player_id uuid, user_id uuid, chips numeric,
             registered_at_utc text, rebuys integer, add_on boolean,
             seat_id uuid, table_id uuid, seat_stack numeric)
  ), expected AS (
    SELECT i.user_id, i.rank,
           i.floor_cents + CASE WHEN i.rank = 1 THEN
             round(v_batch.deal_amount * 100)::bigint
               - sum(i.floor_cents) OVER ()
             ELSE 0 END AS cents
      FROM input i
  ), actual AS (
    SELECT x.user_id, x.rank, x.cents
      FROM jsonb_to_recordset(v_batch.plan)
        AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
     WHERE x.kind = 'final_table_deal'
  )
  SELECT count(*) INTO v_snapshot_share_mismatches
    FROM expected e
    FULL JOIN actual a USING (user_id)
   WHERE e.user_id IS NULL OR a.user_id IS NULL
      OR e.rank IS DISTINCT FROM a.rank
      OR e.cents IS DISTINCT FROM a.cents;

  SELECT count(*) INTO v_obligation_mismatches
    FROM jsonb_to_recordset(v_batch.plan)
      AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
    LEFT JOIN public.tournament_obligations o
      ON o.tournament_id = p_tournament_id
     AND o.kind = x.kind
     AND o.user_id = x.user_id
     AND ((x.kind = 'place' AND o.place = x.place)
          OR (x.kind = 'final_table_deal' AND o.place IS NULL))
   WHERE o.id IS NULL
      OR round(o.amount_owed * 100)::bigint <> x.cents
      OR round(o.amount_paid * 100)::bigint <> x.cents
      OR o.settled_at IS NULL;

  SELECT count(*) INTO v_extra_obligations
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('place', 'final_table_deal')
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_batch.plan)
           AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
        WHERE x.kind = o.kind AND x.user_id = o.user_id
          AND ((x.kind = 'place' AND x.place = o.place)
               OR (x.kind = 'final_table_deal' AND o.place IS NULL))
     );

  SELECT count(*) INTO v_evidence_mismatches
    FROM jsonb_to_recordset(v_batch.plan)
      AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
    CROSS JOIN LATERAL (
      SELECT round(COALESCE(sum(p.amount), 0) * 100)::bigint AS cents
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.user_id = x.user_id
         AND ((x.kind = 'place'
               AND p.position = x.place
               AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                                 'late_reg_adjustment', 'clawback', 'spin_backpay',
                                 'overlay_backpay')
                    OR EXISTS (
                      SELECT 1 FROM public.tournament_obligations eo
                       WHERE eo.tournament_id = p_tournament_id
                         AND eo.kind = 'place' AND eo.place = x.place
                         AND eo.user_id = x.user_id
                         AND p.idempotency_key LIKE
                           'tourney:' || p_tournament_id::text || ':obl:' ||
                           eo.id::text || ':%'
                    )))
              OR (x.kind = 'final_table_deal'
                  AND p.position IS NULL
                  AND p.source = 'final_table_deal'))
    ) evidence
   WHERE evidence.cents <> x.cents;

  SELECT count(*) INTO v_unexpected_place_evidence
    FROM (
      SELECT p.position, p.user_id
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.position IS NOT NULL
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR EXISTS (
                SELECT 1 FROM public.tournament_obligations eo
                 WHERE eo.tournament_id = p_tournament_id
                   AND eo.kind = 'place' AND eo.place = p.position
                   AND eo.user_id = p.user_id
                   AND p.idempotency_key LIKE
                     'tourney:' || p_tournament_id::text || ':obl:' ||
                     eo.id::text || ':%'
              ))
       GROUP BY p.position, p.user_id
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) evidence
   WHERE NOT EXISTS (
     SELECT 1
       FROM jsonb_to_recordset(v_batch.plan)
         AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
      WHERE x.kind = 'place' AND x.place = evidence.position
        AND x.user_id = evidence.user_id
   );

  SELECT count(*) INTO v_unexpected_deal_evidence
    FROM (
      SELECT p.position, p.user_id
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
       GROUP BY p.position, p.user_id
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) evidence
   WHERE evidence.position IS NOT NULL
      OR NOT EXISTS (
        SELECT 1
          FROM jsonb_to_recordset(v_batch.plan)
            AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
         WHERE x.kind = 'final_table_deal' AND x.user_id = evidence.user_id
      );

  SELECT count(*) INTO v_prize_mismatches
    FROM public.tournament_players tp
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(x.cents), 0) AS cents
        FROM jsonb_to_recordset(v_batch.plan)
          AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
       WHERE x.user_id = tp.user_id
    ) expected
   WHERE tp.tournament_id = p_tournament_id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint <> expected.cents;

  SELECT count(*) INTO v_standing_mismatches
    FROM jsonb_to_recordset(v_batch.plan)
      AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = x.user_id
   WHERE tp.id IS NULL
      OR (x.kind = 'place'
          AND (tp.position IS DISTINCT FROM x.place OR tp.status <> 'eliminated'
               OR tp.eliminated_at IS NULL))
      OR (x.kind = 'final_table_deal'
          AND (tp.position IS DISTINCT FROM x.rank
               OR tp.status <> CASE WHEN x.rank = 1 THEN 'winner' ELSE 'eliminated' END
               OR (x.rank = 1 AND tp.eliminated_at IS NOT NULL)
               OR (x.rank > 1 AND tp.eliminated_at IS NULL)));

  SELECT count(*), count(*) FILTER (WHERE tp.position IS NULL),
         count(DISTINCT tp.position), COALESCE(min(tp.position), 0),
         COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL)
    INTO v_player_count, v_unranked, v_distinct_positions,
         v_min_position, v_max_position, v_winners, v_winner_at_one,
         v_nonterminal, v_missing_bust_time
   FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  /* Ranks below the live chop belong to players who busted before the deal.
     Their exact suffix is determined by bust time, then immutable row id for
     equal timestamps: earliest bust finishes last. Recompute both the mapping
     and the stable UTC fingerprint on every verifier call. */
  WITH prior AS (
    SELECT tp.id, tp.user_id, tp.position, tp.eliminated_at,
           v_batch.field_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position > v_batch.live_count
  )
  SELECT count(*),
         count(*) FILTER (WHERE p.eliminated_at IS NULL),
         count(*) FILTER (WHERE p.position IS DISTINCT FROM p.canonical_position),
         md5(COALESCE(jsonb_agg(jsonb_build_object(
           'id', p.id, 'user_id', p.user_id, 'position', p.position,
           'eliminated_at_utc', to_char(
             p.eliminated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'))
           ORDER BY p.position, p.id), '[]'::jsonb)::text)
    INTO v_prior_count, v_prior_missing_bust_time,
         v_prior_canonical_mismatches, v_prior_standings_fingerprint
    FROM prior p;

  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND o.kind = 'bubble_protection'
         ), EXISTS (
           SELECT 1 FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'bubble_protection'
         )
    INTO v_bubble_obligation_present, v_bubble_payout_present;
  v_bubble_shape_valid := v_t.buy_in_amount > 0
    AND v_batch.structure_place_count > 0
    AND v_player_count > v_batch.structure_place_count;
  v_bubble_required := (v_t.bubble_protection AND v_bubble_shape_valid)
    OR v_bubble_obligation_present OR v_bubble_payout_present;

  IF v_bubble_required AND v_bubble_shape_valid THEN
    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
      INTO v_bubble_holders, v_bubble_user
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_batch.structure_place_count + 1;

    SELECT count(*),
           count(*) FILTER (WHERE o.user_id = v_bubble_user AND o.place IS NULL),
           COALESCE(max(o.amount_owed) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0),
           COALESCE(max(o.amount_paid) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0)
      INTO v_bubble_obligations, v_bubble_matching, v_bubble_owed, v_bubble_paid
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'bubble_protection';

    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_bubble_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user AND p.position IS NULL
       AND p.source = 'bubble_protection';

    SELECT count(*) INTO v_bubble_conflicts
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p.source = 'bubble_protection'
           AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user)
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) unexpected_bubble;

    IF v_bubble_obligations = 1 AND v_bubble_matching = 1 THEN
      SELECT o.id, o.source, o.amount_owed, o.amount_paid, o.settled_at
        INTO v_bubble_obligation_id, v_bubble_source, v_bubble_owed,
             v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user;
    END IF;
  END IF;

  IF v_obligation_mismatches > 0 OR v_extra_obligations > 0
     OR v_evidence_mismatches > 0 OR v_unexpected_place_evidence > 0
     OR v_unexpected_deal_evidence > 0 OR v_prize_mismatches > 0
     OR v_standing_mismatches > 0
     OR v_prior_count <> v_batch.field_count - v_batch.live_count
     OR v_prior_missing_bust_time > 0
     OR v_prior_canonical_mismatches > 0
     OR v_prior_standings_fingerprint IS DISTINCT FROM
          v_batch.prior_standings_fingerprint
     OR v_player_count <> v_batch.field_count OR v_unranked > 0
     OR v_distinct_positions <> v_player_count
     OR v_min_position <> 1 OR v_max_position <> v_player_count
     OR v_winners <> 1 OR v_winner_at_one <> 1 OR v_nonterminal > 0
     OR v_missing_bust_time > 0
     OR v_snapshot_count <> v_batch.live_count
     OR v_snapshot_distinct_players <> v_batch.live_count
     OR v_snapshot_distinct_users <> v_batch.live_count
     OR v_snapshot_distinct_seats <> v_batch.live_count
     OR v_snapshot_wrong_tables > 0
     OR v_snapshot_input_mismatches > 0
     OR v_snapshot_share_mismatches > 0
     OR v_batch.bubble_contract_required IS DISTINCT FROM v_bubble_required
     OR (v_bubble_required
         AND (NOT v_bubble_shape_valid
              OR v_bubble_holders <> 1 OR v_bubble_user IS NULL
              OR v_bubble_obligations <> 1 OR v_bubble_matching <> 1
              OR v_bubble_obligation_id IS DISTINCT FROM v_batch.bubble_obligation_id
              OR v_bubble_user IS DISTINCT FROM v_batch.bubble_user_id
              OR v_bubble_source IS DISTINCT FROM v_batch.bubble_source
              OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
              OR abs(v_bubble_owed - v_t.buy_in_amount) > 0.005
              OR abs(v_bubble_owed - v_batch.bubble_amount_owed) > 0.005
              OR v_bubble_paid + 0.005 < v_batch.bubble_amount_paid_before
              OR v_bubble_paid + 0.005 < v_bubble_owed
              OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
              OR v_bubble_settled_at IS NULL
              OR v_bubble_conflicts > 0))
     OR (NOT v_bubble_required
         AND (v_batch.bubble_obligation_id IS NOT NULL
              OR v_batch.bubble_user_id IS NOT NULL
              OR v_batch.bubble_source IS NOT NULL
              OR abs(v_batch.bubble_amount_owed) > 0.005
              OR abs(v_batch.bubble_amount_paid_before) > 0.005)) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'atomic_deal_evidence_is_incomplete',
      'obligation_mismatches', v_obligation_mismatches,
      'extra_obligations', v_extra_obligations,
      'evidence_mismatches', v_evidence_mismatches,
      'unexpected_place_evidence', v_unexpected_place_evidence,
      'unexpected_deal_evidence', v_unexpected_deal_evidence,
      'prize_mismatches', v_prize_mismatches,
      'standing_mismatches', v_standing_mismatches,
      'prior_players', v_prior_count,
      'prior_eliminated_without_time', v_prior_missing_bust_time,
      'prior_canonical_mismatches', v_prior_canonical_mismatches,
      'prior_standings_fingerprint_matches',
        v_prior_standings_fingerprint IS NOT DISTINCT FROM
          v_batch.prior_standings_fingerprint,
      'players', v_player_count, 'unranked', v_unranked,
      'distinct_positions', v_distinct_positions,
      'rank_range', jsonb_build_array(v_min_position, v_max_position),
      'winners', v_winners, 'winner_at_one', v_winner_at_one,
      'nonterminal', v_nonterminal,
      'eliminated_without_time', v_missing_bust_time,
      'live_input_rows', v_snapshot_count,
      'live_input_mismatches', v_snapshot_input_mismatches,
      'share_rederivation_mismatches', v_snapshot_share_mismatches,
      'bubble_obligations', v_bubble_obligations,
      'bubble_required', v_bubble_required,
      'bubble_shape_valid', v_bubble_shape_valid,
      'bubble_obligation_present', v_bubble_obligation_present,
      'bubble_payout_present', v_bubble_payout_present,
      'bubble_conflicts', v_bubble_conflicts);
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', NULL,
                            'tournament_id', p_tournament_id,
                            'deal_table_id', v_batch.deal_table_id,
                            'bubble_contract_required', v_batch.bubble_contract_required,
                            'chip_leader', v_batch.chip_leader,
                            'players', v_batch.live_count,
                            'amount_owed', v_batch.amount_owed,
                            'completed', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'atomic_deal_verification_failed',
                            'detail', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_check_atomic_final_table_deal(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_check_atomic_final_table_deal(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_atomic_final_table_deal_completion_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_check jsonb;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.tournament_final_table_deal_batches b
        WHERE b.tournament_id = NEW.id
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = NEW.id AND o.kind = 'final_table_deal'
     ) AND NOT EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = NEW.id AND p.source = 'final_table_deal'
     ) THEN
    RETURN NEW;
  END IF;

  v_check := public.fn_check_atomic_final_table_deal(NEW.id);
  IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN
    RAISE EXCEPTION
      'final-table-deal tournament % cannot complete: %', NEW.id, v_check::text
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_atomic_final_table_deal_completion_guard()
  FROM PUBLIC, anon, authenticated;

/* A deal batch is also its restart/rollback boundary. Although the tournament
   row lock serializes the canonical settler, a privileged direct writer must
   not be able to strand a prepared batch by changing RUNNING to another
   status. Once the batch has been marked settled, only the same transaction's
   RUNNING -> COMPLETED transition is legal; the completion guard below then
   independently verifies every paid share and result. */
CREATE OR REPLACE FUNCTION public.trg_lock_atomic_final_table_deal_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_settled_at timestamptz;
  v_has_batch boolean := false;
BEGIN
  SELECT b.settled_at INTO v_settled_at
    FROM public.tournament_final_table_deal_batches b
   WHERE b.tournament_id = OLD.id;
  v_has_batch := FOUND;

  IF v_has_batch
     AND (v_settled_at IS NULL
          OR OLD.status IS DISTINCT FROM 'RUNNING'
          OR NEW.status IS DISTINCT FROM 'COMPLETED') THEN
    RAISE EXCEPTION
      'tournament % has an atomic final-table-deal batch; status may only advance from RUNNING to COMPLETED after full settlement',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_lock_atomic_final_table_deal_status()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zzzzy_lock_atomic_final_table_deal_status
  ON public.tournaments;
CREATE TRIGGER zzzzy_lock_atomic_final_table_deal_status
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM OLD.status)
EXECUTE FUNCTION public.trg_lock_atomic_final_table_deal_status();

DROP TRIGGER IF EXISTS zzzzz_tournaments_atomic_final_table_deal_completion_guard
  ON public.tournaments;
CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.trg_atomic_final_table_deal_completion_guard();

CREATE OR REPLACE FUNCTION public.fn_settle_final_table_deal_atomic(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_t                       record;
  v_batch                   public.tournament_final_table_deal_batches%ROWTYPE;
  v_check                   jsonb;
  v_struct                  jsonb := '[]'::jsonb;
  v_trimmed                 jsonb := '[]'::jsonb;
  v_place_plan              jsonb := '[]'::jsonb;
  v_deal_shares             jsonb := '[]'::jsonb;
  v_deal_plan               jsonb := '[]'::jsonb;
  v_plan                    jsonb := '[]'::jsonb;
  v_payouts                 jsonb := '[]'::jsonb;
  v_plan_fingerprint        text;
  v_prior_standings_fingerprint text;
  v_live_input_snapshot     jsonb := '[]'::jsonb;
  v_live_input_fingerprint  text;
  v_field_count             integer := 0;
  v_live_count              integer := 0;
  v_deal_table_id           uuid;
  v_seated_active_tables    integer := 0;
  v_all_live_seats          integer := 0;
  v_active_live_seats       integer := 0;
  v_distinct_seat_users     integer := 0;
  v_matching_live_users     integer := 0;
  v_seat_stack_mismatches   integer := 0;
  v_live_missing_registration integer := 0;
  v_other_count             integer := 0;
  v_live_positioned         integer := 0;
  v_eliminated_count        integer := 0;
  v_eliminated_ranked       integer := 0;
  v_eliminated_distinct     integer := 0;
  v_eliminated_min          integer := 0;
  v_eliminated_max          integer := 0;
  v_eliminated_missing_time integer := 0;
  v_eliminated_canonical_mismatches integer := 0;
  v_structure_places        integer := 0;
  v_structure_distinct      integer := 0;
  v_structure_min           integer := 0;
  v_structure_max           integer := 0;
  v_total_bp                bigint := 0;
  v_pool_cents              bigint := 0;
  v_remaining_cents         bigint := 0;
  v_expected_cents          bigint := 0;
  v_place_total_cents       bigint := 0;
  v_prior_place_paid_cents  bigint := 0;
  v_deal_total_cents        bigint := 0;
  v_available_cents         bigint := 0;
  v_unpaid_cents            bigint := 0;
  v_total_unpaid_cents      bigint := 0;
  v_floor_paid_cents        bigint := 0;
  v_remainder_cents         bigint := 0;
  v_total_chips             numeric := 0;
  v_rank                    integer := 0;
  v_share_cents             bigint := 0;
  v_leader                  uuid;
  v_holder                  uuid;
  v_holders                 integer := 0;
  v_seeded_paid             numeric := 0;
  v_wrong_recipients        integer := 0;
  v_conflicts               integer := 0;
  v_existing                public.tournament_obligations%ROWTYPE;
  v_result                  jsonb;
  v_after_paid              numeric := 0;
  v_paid_this_call          numeric := 0;
  v_place_paid_this_call    numeric := 0;
  v_deal_paid_this_call     numeric := 0;
  v_bubble_paid_this_call   numeric := 0;
  v_bubble_user             uuid;
  v_bubble_holders          integer := 0;
  v_bubble_obligations      integer := 0;
  v_bubble_matching         integer := 0;
  v_bubble_owed             numeric := 0;
  v_bubble_paid             numeric := 0;
  v_bubble_evidence         numeric := 0;
  v_bubble_conflicts        integer := 0;
  v_bubble_obligation_id    uuid;
  v_bubble_source           text;
  v_bubble_settled_at       timestamptz;
  v_bubble_row_found        boolean := false;
  v_bubble_needs_insert     boolean := false;
  v_bubble_unpaid_cents     bigint := 0;
  v_after_bubble_paid       numeric := 0;
  v_bubble_obligation_present boolean := false;
  v_bubble_payout_present   boolean := false;
  v_bubble_required         boolean := false;
  v_bubble_shape_valid      boolean := false;
  v_escrow                  public.tournament_escrow%ROWTYPE;
  v_escrow_after            numeric := 0;
  v_failure                 text;
  v_failure_state           text;
  r                         record;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  SELECT t.id, t.name, t.status, round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         COALESCE(t.final_table_deal_enabled, false) AS final_table_deal_enabled,
         COALESCE(t.table_size, 9) AS table_size, t.payout_structure,
         t.variant, t.tournament_type, t.satellite_target_id, t.spin_multiplier,
         COALESCE(t.bubble_protection, false) AS bubble_protection,
         round(COALESCE(t.buy_in_amount, 0), 2) AS buy_in_amount
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  SELECT * INTO v_batch
    FROM public.tournament_final_table_deal_batches b
   WHERE b.tournament_id = p_tournament_id
   FOR UPDATE;

  IF v_t.status = 'COMPLETED' THEN
    v_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
    IF COALESCE((v_check->>'ok')::boolean, false) THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', x.user_id, 'amount', x.cents / 100.0, 'rank', x.rank)
               ORDER BY x.rank), '[]'::jsonb)
        INTO v_payouts
        FROM jsonb_to_recordset(v_batch.plan)
          AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
       WHERE x.kind = 'final_table_deal';
      RETURN jsonb_build_object(
        'ok', true, 'paid', 0, 'place_paid', 0, 'deal_paid', 0, 'bubble_paid', 0,
        'completed', true, 'already_completed', true,
        'players', v_batch.live_count, 'chip_leader', v_batch.chip_leader,
        'deal_table_id', v_batch.deal_table_id,
        'bubble_contract_required', v_batch.bubble_contract_required,
        'bubble_obligation_id', v_batch.bubble_obligation_id,
        'payouts', v_payouts, 'retryable', false);
    END IF;
    RETURN v_check || jsonb_build_object('paid', 0, 'completed', false,
                                         'retryable', false);
  END IF;

  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running',
                              'status', v_t.status, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;
  IF NOT v_t.final_table_deal_enabled THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_not_enabled',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'satellite_has_its_own_settlement',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF NOT v_t.prize_pool_finalized
     OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prize_pool_is_not_funded_and_finalized',
                              'prize_pool', v_t.prize_pool,
                              'guaranteed_prize', v_t.guaranteed_prize,
                              'prize_pool_finalized', v_t.prize_pool_finalized,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_batch.tournament_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id = p_tournament_id
                   AND p.source = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'legacy_or_incomplete_deal_has_no_atomic_replay',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  /* Parent-to-child locks make the physical-table predicate stable through
     COMMIT. A new tournament table needs a foreign-key key-share lock on the
     tournament row; a new seat needs one on its table row. Both parents are
     already FOR UPDATE, while every existing live seat is locked directly. */
  PERFORM 1
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id
   FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NULL
   ORDER BY ts.id
   FOR UPDATE OF ts;
  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;
  PERFORM 1
    FROM public.tournament_deal_votes v
   WHERE v.tournament_id = p_tournament_id
   ORDER BY v.user_id
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status = 'playing' AND tp.eliminated_at IS NULL),
         count(*) FILTER (WHERE tp.status NOT IN ('playing', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'playing' AND tp.position IS NOT NULL),
         count(*) FILTER (WHERE tp.status = 'eliminated'),
         count(tp.position) FILTER (WHERE tp.status = 'eliminated'),
         count(DISTINCT tp.position) FILTER (WHERE tp.status = 'eliminated'),
         COALESCE(min(tp.position) FILTER (WHERE tp.status = 'eliminated'), 0),
         COALESCE(max(tp.position) FILTER (WHERE tp.status = 'eliminated'), 0),
         count(*) FILTER (
           WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL),
         COALESCE(sum(tp.chips) FILTER (
           WHERE tp.status = 'playing' AND tp.eliminated_at IS NULL), 0)
    INTO v_field_count, v_live_count, v_other_count, v_live_positioned,
         v_eliminated_count, v_eliminated_ranked, v_eliminated_distinct,
         v_eliminated_min, v_eliminated_max, v_eliminated_missing_time,
         v_total_chips
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  WITH prior AS (
    SELECT tp.id, tp.user_id, tp.position, tp.eliminated_at,
           v_field_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  )
  SELECT count(*) FILTER (
           WHERE p.position IS DISTINCT FROM p.canonical_position),
         md5(COALESCE(jsonb_agg(jsonb_build_object(
           'id', p.id, 'user_id', p.user_id, 'position', p.position,
           'eliminated_at_utc', to_char(
             p.eliminated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'))
           ORDER BY p.position, p.id), '[]'::jsonb)::text)
    INTO v_eliminated_canonical_mismatches,
         v_prior_standings_fingerprint
    FROM prior p;

  IF v_live_count < 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_enough_players',
                              'players', v_live_count, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;
  IF v_live_count > v_t.table_size THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_at_final_table',
                              'players', v_live_count, 'table_size', v_t.table_size,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_other_count > 0 OR v_live_positioned > 0
     OR v_live_count + v_eliminated_count <> v_field_count
     OR v_eliminated_ranked <> v_eliminated_count
     OR v_eliminated_distinct <> v_eliminated_count
     OR (v_eliminated_count > 0
         AND (v_eliminated_min <> v_live_count + 1
              OR v_eliminated_max <> v_field_count
              OR v_eliminated_max - v_eliminated_min + 1
                 <> v_eliminated_count)) THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'standings_before_deal_are_not_contiguous',
                              'field', v_field_count, 'live', v_live_count,
                              'other_statuses', v_other_count,
                              'live_with_position', v_live_positioned,
                              'classified_players',
                                v_live_count + v_eliminated_count,
                              'eliminated', v_eliminated_count,
                              'eliminated_ranked', v_eliminated_ranked,
                              'eliminated_distinct', v_eliminated_distinct,
                              'eliminated_range', jsonb_build_array(v_eliminated_min,
                                                                    v_eliminated_max),
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_eliminated_missing_time > 0
     OR v_eliminated_canonical_mismatches > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'prior_eliminated_standings_are_not_canonical',
      'eliminated_without_time', v_eliminated_missing_time,
      'canonical_mismatches', v_eliminated_canonical_mismatches,
      'rule', 'earliest eliminated_at then id receives the largest position',
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF v_total_chips <= 0 OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'playing' AND tp.eliminated_at IS NULL
       AND COALESCE(tp.chips, 0) <= 0
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'live_chip_totals_are_invalid',
                              'total_chips', v_total_chips, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  /* "Final table" means one physical occupied table and an exact seat set,
     not merely a live headcount below table_size. Include live-seat residue
     on paused/closed tables in the all-seat count so stale merge residue also
     fails closed. Null-user seats, duplicate seats, eliminated seats, missing
     live players and split tables each make at least one equality fail. */
  SELECT count(DISTINCT tb.id) FILTER (
           WHERE tb.status::text IN ('running', 'waiting') AND ts.id IS NOT NULL),
         count(ts.id),
         count(ts.id) FILTER (
           WHERE tb.status::text IN ('running', 'waiting')),
         count(DISTINCT ts.user_id),
         count(DISTINCT ts.user_id) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM public.tournament_players live
              WHERE live.tournament_id = p_tournament_id
                AND live.user_id = ts.user_id
                AND live.status = 'playing'
                AND live.eliminated_at IS NULL
           ))
    INTO v_seated_active_tables, v_all_live_seats, v_active_live_seats,
         v_distinct_seat_users, v_matching_live_users
    FROM public.tables tb
    LEFT JOIN public.table_seats ts
      ON ts.table_id = tb.id AND ts.left_at IS NULL
   WHERE tb.tournament_id = p_tournament_id;

  SELECT tb.id INTO v_deal_table_id
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND tb.status::text IN ('running', 'waiting')
     AND EXISTS (
       SELECT 1 FROM public.table_seats ts
        WHERE ts.table_id = tb.id AND ts.left_at IS NULL
     )
   ORDER BY tb.id
   LIMIT 1;

  IF v_seated_active_tables <> 1 OR v_deal_table_id IS NULL
     OR v_all_live_seats <> v_live_count
     OR v_active_live_seats <> v_live_count
     OR v_distinct_seat_users <> v_live_count
     OR v_matching_live_users <> v_live_count THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'physical_final_table_seat_set_is_not_exact',
      'players', v_live_count, 'deal_table_id', v_deal_table_id,
      'seated_active_tables', v_seated_active_tables,
      'all_live_seats', v_all_live_seats,
      'active_live_seats', v_active_live_seats,
      'distinct_seat_users', v_distinct_seat_users,
      'matching_live_users', v_matching_live_users,
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  SELECT count(*) FILTER (WHERE tp.registered_at IS NULL),
         count(*) FILTER (WHERE ts.stack IS DISTINCT FROM tp.chips),
         COALESCE(jsonb_agg(jsonb_build_object(
           'player_id', tp.id,
           'user_id', tp.user_id,
           'chips', tp.chips,
           'registered_at_utc', to_char(
             tp.registered_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US'),
           'rebuys', COALESCE(tp.rebuys, 0),
           'add_on', COALESCE(tp.add_on, false),
           'seat_id', ts.id,
           'table_id', tb.id,
           'seat_stack', ts.stack)
           ORDER BY tp.chips DESC, tp.registered_at ASC, tp.user_id ASC),
           '[]'::jsonb)
    INTO v_live_missing_registration, v_seat_stack_mismatches,
         v_live_input_snapshot
    FROM public.tournament_players tp
    JOIN public.table_seats ts
      ON ts.user_id = tp.user_id AND ts.left_at IS NULL
    JOIN public.tables tb
      ON tb.id = ts.table_id AND tb.id = v_deal_table_id
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'playing' AND tp.eliminated_at IS NULL;

  IF jsonb_array_length(v_live_input_snapshot) <> v_live_count
     OR v_live_missing_registration > 0
     OR v_seat_stack_mismatches > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'live_deal_inputs_do_not_match_seat_stacks',
      'players', v_live_count,
      'snapshot_rows', jsonb_array_length(v_live_input_snapshot),
      'missing_registered_at', v_live_missing_registration,
      'seat_stack_mismatches', v_seat_stack_mismatches,
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  v_live_input_fingerprint := md5(v_live_input_snapshot::text);

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'playing' AND tp.eliminated_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_deal_votes v
          WHERE v.tournament_id = p_tournament_id AND v.user_id = tp.user_id
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_vote_is_not_unanimous',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  v_pool_cents := round(v_t.prize_pool * 100)::bigint;
  IF v_pool_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_prize_pool_to_deal',
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  BEGIN
    IF lower(COALESCE(v_t.variant, '')) = 'spin'
       OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN' THEN
      IF v_t.spin_multiplier IS NULL OR v_t.spin_multiplier <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'spin_multiplier_is_not_persisted',
                                  'paid', 0, 'completed', false, 'retryable', false);
      END IF;
      SELECT l.structure INTO v_struct
        FROM public.spin_payout_ladder l
       WHERE l.multiplier = v_t.spin_multiplier;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'spin_multiplier_has_no_canonical_ladder',
                                  'spin_multiplier', v_t.spin_multiplier,
                                  'paid', 0, 'completed', false, 'retryable', false);
      END IF;
    ELSE
      v_struct := public.fn_safe_jsonb_array(v_t.payout_structure);
    END IF;

    IF jsonb_array_length(v_struct) = 0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_struct) e
       WHERE jsonb_typeof(e) <> 'object'
          OR COALESCE(e->>'place', '') !~ '^[1-9][0-9]*$'
          OR COALESCE(e->>'percentage', '') !~ '^[0-9]+([.][0-9]+)?$'
          OR (e->>'percentage')::numeric < 0
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;

    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(v_struct) e
     WHERE (e->>'place')::integer <= v_field_count;

    SELECT count(*), count(DISTINCT (e->>'place')::integer),
           COALESCE(min((e->>'place')::integer), 0),
           COALESCE(max((e->>'place')::integer), 0),
           COALESCE(sum(round((e->>'percentage')::numeric * 100)::bigint), 0)
      INTO v_structure_places, v_structure_distinct,
           v_structure_min, v_structure_max, v_total_bp
      FROM jsonb_array_elements(v_trimmed) e;

    IF v_structure_places = 0 OR v_structure_distinct <> v_structure_places
       OR v_structure_min <> 1 OR v_structure_max <> v_structure_places
       OR v_total_bp <= 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'payout_places_are_not_contiguous',
                                'places', v_structure_places,
                                'last_place', v_structure_max,
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                              'detail', SQLERRM, 'paid', 0,
                              'completed', false, 'retryable', false);
  END;

  v_remaining_cents := v_pool_cents;
  FOR r IN
    SELECT (e->>'place')::integer AS place,
           round((e->>'percentage')::numeric * 100)::bigint AS bp
      FROM jsonb_array_elements(v_trimmed) e
     ORDER BY (e->>'place')::integer
  LOOP
    IF r.place = v_structure_max THEN
      v_expected_cents := GREATEST(v_remaining_cents, 0);
    ELSE
      v_expected_cents := GREATEST(
        LEAST(v_remaining_cents,
              round(v_pool_cents * r.bp::numeric / v_total_bp)::bigint), 0);
    END IF;
    v_remaining_cents := v_remaining_cents - v_expected_cents;

    IF r.place > v_live_count THEN
      SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
        INTO v_holders, v_holder
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;
      IF v_holders <> 1 OR v_holder IS NULL THEN
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'earned_place_has_no_unique_holder',
                                  'place', r.place, 'holders', v_holders,
                                  'paid', 0, 'completed', false, 'retryable', false);
      END IF;
      v_place_plan := v_place_plan || jsonb_build_array(jsonb_build_object(
        'kind', 'place', 'place', r.place, 'user_id', v_holder,
        'cents', v_expected_cents, 'rank', NULL));
      v_place_total_cents := v_place_total_cents + v_expected_cents;
    END IF;
  END LOOP;

  IF v_remaining_cents <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'structure_does_not_allocate_pool',
                              'unallocated_cents', v_remaining_cents,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  /* A positive result cache is an entitlement signal, never evidence that it
     was paid. A stale lower cache is safely promoted to the finalized
     structure below; a cache above or outside that structure would require a
     pricing decision or clawback, so the deal must leave it untouched and
     refuse for review. Live players cannot already hold a place prize. */
  SELECT count(*) INTO v_conflicts
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_place_plan)
           AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
        WHERE x.place = tp.position AND x.user_id = tp.user_id
          AND round(COALESCE(tp.prize, 0) * 100)::bigint <= x.cents
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'recorded_positive_prize_conflicts_with_deal_plan',
                              'rows', v_conflicts, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND o.kind = 'bubble_protection'
         ), EXISTS (
           SELECT 1 FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'bubble_protection'
         )
    INTO v_bubble_obligation_present, v_bubble_payout_present;
  v_bubble_shape_valid := v_t.buy_in_amount > 0
    AND v_structure_places > 0 AND v_field_count > v_structure_places;
  v_bubble_required := (v_t.bubble_protection AND v_bubble_shape_valid)
    OR v_bubble_obligation_present OR v_bubble_payout_present;

  IF v_bubble_required AND NOT v_bubble_shape_valid THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_contract_shape_is_invalid',
      'buy_in_amount', v_t.buy_in_amount,
      'structure_places', v_structure_places, 'field_count', v_field_count,
      'bubble_obligation_present', v_bubble_obligation_present,
      'bubble_payout_present', v_bubble_payout_present,
      'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  IF v_bubble_required THEN
    /* A deal may be accepted before the natural bubble. In that case the final
       stone-bubble rank belongs to a still-live player and no persisted
       position exists yet. Derive that holder from the exact locked snapshot
       using the same ordering that builds and stamps the deal plan below. If
       the natural bubble already occurred, its durable eliminated position is
       the source of truth. */
    IF v_structure_places + 1 <= v_live_count THEN
      SELECT count(*), (array_agg(ranked.user_id ORDER BY ranked.rank))[1]
        INTO v_bubble_holders, v_bubble_user
        FROM (
          SELECT s.user_id,
                 row_number() OVER (
                   ORDER BY s.chips DESC, s.registered_at_utc ASC, s.user_id ASC
                 )::integer AS rank
            FROM jsonb_to_recordset(v_live_input_snapshot)
              AS s(player_id uuid, user_id uuid, chips numeric,
                   registered_at_utc text, rebuys integer, add_on boolean,
                   seat_id uuid, table_id uuid, seat_stack numeric)
        ) ranked
       WHERE ranked.rank = v_structure_places + 1;
    ELSE
      SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
        INTO v_bubble_holders, v_bubble_user
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.position = v_structure_places + 1;
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE o.user_id = v_bubble_user AND o.place IS NULL),
           COALESCE(max(o.amount_owed) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0),
           COALESCE(max(o.amount_paid) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0)
      INTO v_bubble_obligations, v_bubble_matching, v_bubble_owed, v_bubble_paid
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'bubble_protection';

    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_bubble_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user AND p.position IS NULL
       AND p.source = 'bubble_protection';

    SELECT count(*) INTO v_bubble_conflicts
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p.source = 'bubble_protection'
           AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user)
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) unexpected_bubble;

    IF v_bubble_obligations = 0 AND NOT v_bubble_payout_present THEN
      v_bubble_obligation_id := gen_random_uuid();
      v_bubble_source := 'engine.atomicFinalTableDeal';
      v_bubble_owed := v_t.buy_in_amount;
      v_bubble_paid := 0;
      v_bubble_settled_at := NULL;
      v_bubble_needs_insert := true;
    ELSIF v_bubble_obligations = 1 AND v_bubble_matching = 1 THEN
      SELECT o.id, o.source, o.amount_owed, o.amount_paid, o.settled_at
        INTO v_bubble_obligation_id, v_bubble_source, v_bubble_owed,
             v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user
       FOR UPDATE;
    END IF;

    IF v_bubble_holders <> 1 OR v_bubble_user IS NULL
       OR (NOT v_bubble_needs_insert
           AND (v_bubble_obligations <> 1 OR v_bubble_matching <> 1))
       OR (v_bubble_needs_insert
           AND (v_bubble_obligations <> 0 OR v_bubble_payout_present))
       OR v_bubble_obligation_id IS NULL
       OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
       OR abs(v_bubble_owed - v_t.buy_in_amount) > 0.005
       OR v_bubble_paid < -0.005 OR v_bubble_paid > v_bubble_owed + 0.005
       OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
       OR (v_bubble_paid + 0.005 >= v_bubble_owed
           AND v_bubble_settled_at IS NULL)
       OR (v_bubble_paid + 0.005 < v_bubble_owed
           AND v_bubble_settled_at IS NOT NULL)
       OR v_bubble_conflicts > 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_obligation_is_not_exact',
                                'bubble_place', v_structure_places + 1,
                                'user_id', v_bubble_user,
                                'expected', v_t.buy_in_amount,
                                'amount_owed', v_bubble_owed,
                                'amount_paid', v_bubble_paid,
                                'payout_evidence', v_bubble_evidence,
                                'conflicts', v_bubble_conflicts,
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;
    v_bubble_unpaid_cents := round(
      GREATEST(v_bubble_owed - v_bubble_paid, 0) * 100)::bigint;
  END IF;

  FOR r IN
    SELECT (p->>'place')::integer AS place,
           (p->>'user_id')::uuid AS user_id,
           (p->>'cents')::bigint AS cents
      FROM jsonb_array_elements(v_place_plan) p
     ORDER BY (p->>'place')::integer
  LOOP
    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_seeded_paid
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.position = r.place AND p.user_id = r.user_id
       AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                         'late_reg_adjustment', 'clawback', 'spin_backpay',
                         'overlay_backpay')
            OR EXISTS (
              SELECT 1 FROM public.tournament_obligations eo
               WHERE eo.tournament_id = p_tournament_id
                 AND eo.kind = 'place' AND eo.place = r.place
                 AND eo.user_id = r.user_id
                 AND p.idempotency_key LIKE
                   'tourney:' || p_tournament_id::text || ':obl:' ||
                   eo.id::text || ':%'
            ));

    SELECT count(*) INTO v_wrong_recipients
      FROM (
        SELECT p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id AND p.position = r.place
           AND p.user_id IS DISTINCT FROM r.user_id
           AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
                OR EXISTS (
                  SELECT 1 FROM public.tournament_obligations eo
                   WHERE eo.tournament_id = p_tournament_id
                     AND eo.kind = 'place' AND eo.place = p.position
                     AND eo.user_id = p.user_id
                     AND p.idempotency_key LIKE
                       'tourney:' || p_tournament_id::text || ':obl:' ||
                       eo.id::text || ':%'
                ))
         GROUP BY p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) wrong;

    SELECT * INTO v_existing
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = r.place
     FOR UPDATE;

    IF v_wrong_recipients > 0 OR v_seeded_paid < -0.005
       OR v_seeded_paid > r.cents / 100.0 + 0.005
       OR (FOUND AND abs(round(v_existing.amount_paid, 2) - v_seeded_paid) > 0.005)
       OR (FOUND AND v_existing.amount_owed > r.cents / 100.0 + 0.005)
       OR (FOUND AND v_existing.amount_paid > 0
                    AND v_existing.user_id IS DISTINCT FROM r.user_id) THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'earned_place_evidence_conflicts_with_plan',
                                'place', r.place, 'user_id', r.user_id,
                                'expected', r.cents / 100.0,
                                'payout_evidence', v_seeded_paid,
                                'wrong_recipients', v_wrong_recipients,
                                'paid', 0, 'completed', false, 'retryable', false);
    END IF;
    v_prior_place_paid_cents := v_prior_place_paid_cents
      + round(v_seeded_paid * 100)::bigint;
  END LOOP;

  SELECT count(*) INTO v_conflicts
    FROM (
      SELECT p.position, p.user_id
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.position IS NOT NULL
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR EXISTS (
                SELECT 1 FROM public.tournament_obligations eo
                 WHERE eo.tournament_id = p_tournament_id
                   AND eo.kind = 'place' AND eo.place = p.position
                   AND eo.user_id = p.user_id
                   AND p.idempotency_key LIKE
                     'tourney:' || p_tournament_id::text || ':obl:' ||
                     eo.id::text || ':%'
              ))
       GROUP BY p.position, p.user_id
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) evidence
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_to_recordset(v_place_plan)
       AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
      WHERE x.place = evidence.position AND x.user_id = evidence.user_id
   );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'paid_place_evidence_is_outside_deal_plan',
                              'rows', v_conflicts, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  SELECT count(*) INTO v_conflicts
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_to_recordset(v_place_plan)
         AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
        WHERE x.place = o.place AND x.user_id = o.user_id
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'place_obligation_is_outside_deal_plan',
                              'rows', v_conflicts, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  v_available_cents := v_pool_cents - v_place_total_cents;
  IF v_available_cents < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'earned_places_exceed_prize_pool',
                              'earned_place_cents', v_place_total_cents,
                              'pool_cents', v_pool_cents, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  SELECT sum(s.chips) INTO v_total_chips
    FROM jsonb_to_recordset(v_live_input_snapshot)
      AS s(player_id uuid, user_id uuid, chips numeric,
           registered_at_utc text, rebuys integer, add_on boolean,
           seat_id uuid, table_id uuid, seat_stack numeric);

  SELECT s.user_id INTO v_leader
    FROM jsonb_to_recordset(v_live_input_snapshot)
      AS s(player_id uuid, user_id uuid, chips numeric,
           registered_at_utc text, rebuys integer, add_on boolean,
           seat_id uuid, table_id uuid, seat_stack numeric)
   ORDER BY s.chips DESC, s.registered_at_utc ASC, s.user_id ASC
   LIMIT 1;

  FOR r IN
    SELECT s.user_id, s.chips
      FROM jsonb_to_recordset(v_live_input_snapshot)
        AS s(player_id uuid, user_id uuid, chips numeric,
             registered_at_utc text, rebuys integer, add_on boolean,
             seat_id uuid, table_id uuid, seat_stack numeric)
     ORDER BY s.chips DESC, s.registered_at_utc ASC, s.user_id ASC
  LOOP
    v_rank := v_rank + 1;
    v_share_cents := floor(r.chips / v_total_chips * v_available_cents)::bigint;
    v_floor_paid_cents := v_floor_paid_cents + v_share_cents;
    v_deal_shares := v_deal_shares || jsonb_build_array(jsonb_build_object(
      'user_id', r.user_id, 'cents', v_share_cents, 'rank', v_rank));
  END LOOP;
  v_remainder_cents := v_available_cents - v_floor_paid_cents;

  FOR r IN
    SELECT (p->>'user_id')::uuid AS user_id,
           (p->>'cents')::bigint AS cents,
           (p->>'rank')::integer AS rank
      FROM jsonb_array_elements(v_deal_shares) p
     ORDER BY (p->>'rank')::integer
  LOOP
    v_share_cents := r.cents
      + CASE WHEN r.user_id = v_leader THEN v_remainder_cents ELSE 0 END;
    v_deal_plan := v_deal_plan || jsonb_build_array(jsonb_build_object(
      'kind', 'final_table_deal', 'place', NULL, 'user_id', r.user_id,
      'cents', v_share_cents, 'rank', r.rank));
    v_deal_total_cents := v_deal_total_cents + v_share_cents;
    v_payouts := v_payouts || jsonb_build_array(jsonb_build_object(
      'user_id', r.user_id, 'amount', v_share_cents / 100.0, 'rank', r.rank));
  END LOOP;

  IF v_place_total_cents + v_deal_total_cents <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_plan_does_not_allocate_pool',
                              'places', v_place_total_cents / 100.0,
                              'deal', v_deal_total_cents / 100.0,
                              'pool', v_pool_cents / 100.0, 'paid', 0,
                              'completed', false, 'retryable', false);
  END IF;

  /* A finalized number is not money. Lock the enforced escrow row and prove
     it holds every cent this transaction still needs to move. A manually
     inflated prize_pool/prize_pool_finalized pair therefore cannot authorize
     a deal. Prior place payments backed by exact payout evidence are the only
  subtraction from the required cash. */
  v_unpaid_cents := v_pool_cents - v_prior_place_paid_cents;
  v_total_unpaid_cents := v_unpaid_cents + v_bubble_unpaid_cents;
  SELECT * INTO v_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR NOT v_escrow.enforced THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'enforced_escrow_is_required',
                              'required', v_total_unpaid_cents / 100.0,
                              'place_and_deal_required', v_unpaid_cents / 100.0,
                              'bubble_required', v_bubble_unpaid_cents / 100.0,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;
  IF round(v_escrow.prize_balance * 100)::bigint < v_total_unpaid_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'escrow_cannot_fund_atomic_deal',
                              'required', v_total_unpaid_cents / 100.0,
                              'place_and_deal_required', v_unpaid_cents / 100.0,
                              'bubble_required', v_bubble_unpaid_cents / 100.0,
                              'escrow_prize_balance', v_escrow.prize_balance,
                              'paid', 0, 'completed', false, 'retryable', false);
  END IF;

  v_plan := v_place_plan || v_deal_plan;
  v_plan_fingerprint := md5(jsonb_build_object(
    'bubble_contract_required', v_bubble_required,
    'bubble_obligation_id', v_bubble_obligation_id,
    'bubble_user_id', v_bubble_user,
    'bubble_source', v_bubble_source,
    'bubble_amount_owed', round(COALESCE(v_bubble_owed, 0) * 100)::bigint,
    'bubble_amount_paid_before', round(COALESCE(v_bubble_paid, 0) * 100)::bigint,
    'deal_table_id', v_deal_table_id,
    'live_input_fingerprint', v_live_input_fingerprint,
    'prior_standings_fingerprint', v_prior_standings_fingerprint,
    'plan', v_plan)::text);

  BEGIN
    IF v_bubble_needs_insert THEN
      INSERT INTO public.tournament_obligations
        (id, tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (v_bubble_obligation_id, p_tournament_id, 'bubble_protection', NULL,
         v_bubble_user, v_bubble_owed, 0, v_bubble_source, NULL);
    END IF;

    FOR r IN
      SELECT (p->>'place')::integer AS place,
             (p->>'user_id')::uuid AS user_id,
             (p->>'cents')::bigint AS cents
        FROM jsonb_array_elements(v_place_plan) p
       ORDER BY (p->>'place')::integer
    LOOP
      SELECT round(COALESCE(sum(p.amount), 0), 2)
        INTO v_seeded_paid
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.position = r.place AND p.user_id = r.user_id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR EXISTS (
                SELECT 1 FROM public.tournament_obligations eo
                 WHERE eo.tournament_id = p_tournament_id
                   AND eo.kind = 'place' AND eo.place = r.place
                   AND eo.user_id = r.user_id
                   AND p.idempotency_key LIKE
                     'tourney:' || p_tournament_id::text || ':obl:' ||
                     eo.id::text || ':%'
              ));

      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'place', r.place, r.user_id, r.cents / 100.0,
         v_seeded_paid, 'engine.atomicFinalTableDeal',
         CASE WHEN v_seeded_paid + 0.005 >= r.cents / 100.0 THEN now() ELSE NULL END)
      ON CONFLICT (tournament_id, kind, place) WHERE place IS NOT NULL
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        amount_owed = EXCLUDED.amount_owed,
        amount_paid = EXCLUDED.amount_paid,
        source = EXCLUDED.source,
        updated_at = now(),
        settled_at = EXCLUDED.settled_at;
    END LOOP;

    FOR r IN
      SELECT (p->>'user_id')::uuid AS user_id,
             (p->>'cents')::bigint AS cents,
             (p->>'rank')::integer AS rank
        FROM jsonb_array_elements(v_deal_plan) p
       ORDER BY (p->>'rank')::integer
    LOOP
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'final_table_deal', NULL, r.user_id,
         r.cents / 100.0, 0, 'engine.atomicFinalTableDeal',
         CASE WHEN r.cents = 0 THEN now() ELSE NULL END);
    END LOOP;

    UPDATE public.tournament_players tp
       SET prize = COALESCE((
             SELECT sum(x.cents) / 100.0
               FROM jsonb_to_recordset(v_plan)
                 AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
              WHERE x.user_id = tp.user_id
           ), 0)
     WHERE tp.tournament_id = p_tournament_id;

    FOR r IN
      SELECT (p->>'user_id')::uuid AS user_id,
             (p->>'rank')::integer AS rank
        FROM jsonb_array_elements(v_deal_plan) p
       ORDER BY (p->>'rank')::integer
    LOOP
      UPDATE public.tournament_players
         SET position = r.rank,
             status = CASE WHEN r.rank = 1 THEN 'winner' ELSE 'eliminated' END,
             eliminated_at = CASE
               WHEN r.rank = 1 THEN NULL
               ELSE COALESCE(eliminated_at, clock_timestamp())
             END
       WHERE tournament_id = p_tournament_id AND user_id = r.user_id
         AND status = 'playing' AND eliminated_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'live deal player %s changed before standings were stamped', r.user_id),
          ERRCODE = '40001';
      END IF;
    END LOOP;

    /* Stamping precedes the immutable batch inside this same subtransaction.
       The result-freeze trigger recognizes the batch immediately after this
       insert, without blocking the settler's own legitimate stamps above. */
    INSERT INTO public.tournament_final_table_deal_batches
      (tournament_id, plan_fingerprint, plan, prior_standings_fingerprint,
       live_input_snapshot, live_input_fingerprint,
       field_count, live_count, structure_place_count, place_line_count,
       deal_line_count, place_amount, deal_amount, amount_owed, amount_moved,
       escrow_prize_before, escrow_prize_after, deal_table_id,
       bubble_contract_required, bubble_obligation_id, bubble_user_id,
       bubble_source, bubble_amount_owed, bubble_amount_paid_before,
       chip_leader, source)
    VALUES
      (p_tournament_id, v_plan_fingerprint, v_plan,
       v_prior_standings_fingerprint, v_live_input_snapshot,
       v_live_input_fingerprint, v_field_count, v_live_count,
       v_structure_places, jsonb_array_length(v_place_plan),
       jsonb_array_length(v_deal_plan), v_place_total_cents / 100.0,
       v_deal_total_cents / 100.0, v_pool_cents / 100.0,
       v_total_unpaid_cents / 100.0, v_escrow.prize_balance, NULL, v_deal_table_id,
       v_bubble_required, v_bubble_obligation_id, v_bubble_user,
       v_bubble_source, v_bubble_owed, v_bubble_paid,
       v_leader, 'engine.atomicFinalTableDeal');

    PERFORM set_config('app.atomic_final_table_deal_batch', p_tournament_id::text, true);

    IF v_bubble_required AND v_bubble_unpaid_cents > 0 THEN
      v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate(
        p_tournament_id, 'bubble_protection', NULL, v_bubble_user,
        v_bubble_owed, v_bubble_source,
        'Bubble protection: buy-in returned to the stone bubble', NULL);
      IF NOT COALESCE((v_result->>'ok')::boolean, false)
         OR NULLIF(v_result->>'obligation_id', '')::uuid
            IS DISTINCT FROM v_bubble_obligation_id THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal Bubble leg refused: %s',
          COALESCE(v_result->>'refused_reason', 'wrong obligation')),
          ERRCODE = '23514';
      END IF;

      SELECT o.amount_paid, o.source, o.amount_owed, o.settled_at
        INTO v_after_bubble_paid, v_bubble_source, v_bubble_owed,
             v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.id = v_bubble_obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user;
      IF NOT FOUND
         OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
         OR v_after_bubble_paid + 0.005 < v_bubble_owed
         OR v_bubble_settled_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal Bubble leg only reached %s of %s',
          COALESCE(v_after_bubble_paid, 0), v_bubble_owed),
          ERRCODE = '23514';
      END IF;
      v_bubble_paid_this_call := round(
        COALESCE((v_result->>'paid')::numeric, 0), 2);
      v_paid_this_call := v_paid_this_call + v_bubble_paid_this_call;
    END IF;

    FOR r IN
      SELECT x.kind, x.place, x.user_id, x.cents, x.rank
        FROM jsonb_to_recordset(v_plan)
          AS x(kind text, place integer, user_id uuid, cents bigint, rank integer)
       ORDER BY CASE WHEN x.kind = 'place' THEN 0 ELSE 1 END,
                x.place NULLS LAST, x.rank NULLS LAST
    LOOP
      v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate(
        p_tournament_id, r.kind, r.place, r.user_id, r.cents / 100.0,
        'engine.atomicFinalTableDeal',
        CASE WHEN r.kind = 'place'
             THEN format('Tournament prize: position %s', r.place)
             ELSE 'Final table deal (chip-proportional chop)' END);
      IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal leg refused for %s/%s/%s: %s',
          r.kind, COALESCE(r.place::text, '-'), r.user_id,
          COALESCE(v_result->>'refused_reason', 'unknown')),
          ERRCODE = '23514';
      END IF;

      SELECT o.amount_paid INTO v_after_paid
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = r.kind
         AND o.user_id = r.user_id
         AND ((r.kind = 'place' AND o.place = r.place)
              OR (r.kind = 'final_table_deal' AND o.place IS NULL));
      IF NOT FOUND OR abs(round(v_after_paid, 2) - r.cents / 100.0) > 0.005 THEN
        RAISE EXCEPTION USING MESSAGE = format(
          'atomic final-table-deal leg partially settled for %s/%s/%s: expected %s, stored %s',
          r.kind, COALESCE(r.place::text, '-'), r.user_id,
          r.cents / 100.0, COALESCE(v_after_paid, 0)),
          ERRCODE = '23514';
      END IF;

      v_paid_this_call := v_paid_this_call
        + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
      IF r.kind = 'place' THEN
        v_place_paid_this_call := v_place_paid_this_call
          + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
      ELSE
        v_deal_paid_this_call := v_deal_paid_this_call
          + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
      END IF;
    END LOOP;

    IF v_bubble_required THEN
      SELECT o.amount_paid, o.source, o.amount_owed, o.settled_at
        INTO v_after_bubble_paid, v_bubble_source, v_bubble_owed,
             v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.id = v_bubble_obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user;
      v_bubble_row_found := FOUND;
      SELECT round(COALESCE(sum(p.amount), 0), 2)
        INTO v_bubble_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.user_id = v_bubble_user
         AND p.position IS NULL AND p.source = 'bubble_protection';
      IF NOT v_bubble_row_found
         OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicFinalTableDeal')
         OR v_after_bubble_paid + 0.005 < v_bubble_owed
         OR v_bubble_settled_at IS NULL
         OR abs(v_after_bubble_paid - v_bubble_evidence) > 0.005 THEN
        RAISE EXCEPTION USING MESSAGE =
          'Bubble Protection is not fully settled with exact payout evidence',
          ERRCODE = '23514';
      END IF;
    END IF;

    PERFORM set_config('app.atomic_final_table_deal_batch', '', true);

    IF abs(v_paid_this_call - v_total_unpaid_cents / 100.0) > 0.005 THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'atomic final-table-deal payment total was incomplete: expected %s, moved %s',
        v_total_unpaid_cents / 100.0, v_paid_this_call),
        ERRCODE = '23514';
    END IF;

    SELECT round(e.prize_balance, 2) INTO v_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND
       OR abs(v_escrow.prize_balance - v_paid_this_call - v_escrow_after) > 0.005 THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'escrow did not debit with the atomic deal: before %s, moved %s, after %s',
        v_escrow.prize_balance, v_paid_this_call, COALESCE(v_escrow_after, 0)),
        ERRCODE = '23514';
    END IF;

    UPDATE public.tournament_final_table_deal_batches
       SET settled_at = COALESCE(settled_at, now()),
           escrow_prize_after = v_escrow_after
     WHERE tournament_id = p_tournament_id
       AND plan_fingerprint = v_plan_fingerprint;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'the final-table-deal batch changed before completion',
                            ERRCODE = '40001';
    END IF;

    v_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
    IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN
      RAISE EXCEPTION USING MESSAGE = format(
        'atomic final-table-deal verification refused completion: %s', v_check::text),
        ERRCODE = '23514';
    END IF;

    UPDATE public.tournaments
       SET status = 'COMPLETED', ended_at = COALESCE(ended_at, clock_timestamp()),
           on_break = false, break_ends_at = NULL, updated_at = now()
     WHERE id = p_tournament_id AND status = 'RUNNING';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'RUNNING claim was lost before deal completion',
                            ERRCODE = '40001';
    END IF;

    /* A committed deal includes its physical table shutdown. The status
       transition releases seats through the database triggers; any failure to
       close or prove the terminal table state aborts every deal payment too. */
    UPDATE public.tables
       SET status = 'closed', current_players = 0
     WHERE tournament_id = p_tournament_id
       AND (status IS DISTINCT FROM 'closed' OR current_players IS DISTINCT FROM 0);
    IF EXISTS (
         SELECT 1 FROM public.tables
          WHERE tournament_id = p_tournament_id
            AND (status IS DISTINCT FROM 'closed' OR current_players IS DISTINCT FROM 0)
       ) OR EXISTS (
         SELECT 1
           FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = p_tournament_id AND s.left_at IS NULL
       ) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'completed final-table deal retained a nonterminal table or live seat',
        ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  PERFORM set_config('app.atomic_final_table_deal_batch', '', true);

  IF v_failure IS NOT NULL THEN
    BEGIN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_settle_final_table_deal_atomic',
        format('Atomic final-table deal aborted for %s: %s',
               COALESCE(v_t.name, p_tournament_id::text), v_failure),
        jsonb_build_object('tournament_id', p_tournament_id,
                           'sqlstate', v_failure_state,
                           'reason', v_failure,
                           'field_count', v_field_count,
                           'live_count', v_live_count,
                           'place_amount', v_place_total_cents / 100.0,
                           'deal_amount', v_deal_total_cents / 100.0),
        'atomic-final-table-deal:' || p_tournament_id::text
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'atomic_deal_aborted', 'detail', v_failure,
      'sqlstate', v_failure_state, 'paid', 0, 'completed', false,
      'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'paid', round(v_paid_this_call, 2),
    'place_paid', round(v_place_paid_this_call, 2),
    'deal_paid', round(v_deal_paid_this_call, 2),
    'bubble_paid', round(v_bubble_paid_this_call, 2),
    'completed', true, 'already_completed', false,
    'players', v_live_count, 'chip_leader', v_leader,
    'deal_table_id', v_deal_table_id,
    'bubble_contract_required', v_bubble_required,
    'bubble_obligation_id', v_bubble_obligation_id,
    'place_amount', v_place_total_cents / 100.0,
    'deal_amount', v_deal_total_cents / 100.0,
    'payouts', v_payouts, 'retryable', false,
    'record', 'tournament_final_table_deal_batches');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_settle_final_table_deal_atomic(uuid) IS
  'Atomically pays exact ledger-backed eliminated place entitlements and every live chip-proportional deal share, stamps standings, and completes the tournament. Any refused or partial leg rolls the whole deal back.';

/* Preserve the public server-side API name for any older engine instance, but
   make it impossible for that instance to reach the retired partial payer. */
CREATE OR REPLACE FUNCTION public.fn_final_table_deal(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT public.fn_settle_final_table_deal_atomic(p_tournament_id);
$function$;

REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid) TO service_role;

DO $assert$
DECLARE
  v_src text;
BEGIN
  IF to_regclass('public.tables') IS NULL
     OR to_regclass('public.table_seats') IS NULL THEN
    RAISE EXCEPTION 'physical tournament tables/seats are missing';
  END IF;
  IF to_regprocedure('public.fn_settle_final_table_deal_atomic(uuid)') IS NULL
     OR to_regprocedure('public.fn_check_atomic_final_table_deal(uuid)') IS NULL THEN
    RAISE EXCEPTION 'atomic final-table-deal functions are missing';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.tournaments'::regclass
          AND tgname = 'trg_release_seats_on_tournament_finish'
          AND NOT tgisinternal AND tgenabled <> 'D'
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.tournaments'::regclass
          AND tgname = 'trg_clear_seats_on_game_end'
          AND NOT tgisinternal AND tgenabled <> 'D'
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.table_seats'::regclass
          AND tgname = 'trg_no_live_seat_on_finished_game'
          AND NOT tgisinternal AND tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION 'terminal tournament seat lifecycle triggers are not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_obligations'::regclass
       AND tgname = 'zzzzz_freeze_atomic_final_table_deal_obligation'
       AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'atomic final-table-deal obligation freeze is not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_players'::regclass
       AND tgname = 'zzzz_freeze_batched_tournament_result'
       AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'atomic final-table-deal result freeze is not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzzz_tournaments_atomic_final_table_deal_completion_guard'
       AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'atomic final-table-deal completion guard is not enabled';
  END IF;
  IF to_regprocedure('public.trg_lock_atomic_final_table_deal_status()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.tournaments'::regclass
          AND tgname = 'zzzzy_lock_atomic_final_table_deal_status'
          AND NOT tgisinternal AND tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION 'atomic final-table-deal status lock is not enabled';
  END IF;
  IF has_table_privilege('service_role',
       'public.tournament_final_table_deal_batches', 'INSERT')
     OR has_table_privilege('service_role',
       'public.tournament_final_table_deal_batches', 'UPDATE')
     OR has_table_privilege('service_role',
       'public.tournament_final_table_deal_batches', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can forge an atomic final-table-deal batch';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid = 'public.tournament_final_table_deal_batches'::regclass
       AND a.attname = 'deal_table_id' AND a.attnotnull AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'atomic final-table-deal batch lost its physical table proof';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid = 'public.tournament_final_table_deal_batches'::regclass
       AND a.attname = 'prior_standings_fingerprint'
       AND a.attnotnull AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'atomic final-table-deal batch lost its chronology proof';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid = 'public.tournament_final_table_deal_batches'::regclass
       AND a.attname = 'bubble_contract_required'
       AND a.attnotnull AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'atomic final-table-deal batch lost its Bubble contract proof';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_settle_final_table_deal_atomic(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_final_table_deal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute the final-table-deal money path';
  END IF;
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_settle_final_table_deal_atomic';
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN COALESCE(v_src, '')) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN COALESCE(v_src, '')) > 0
     OR position('tournament_final_table_deal_batches' IN COALESCE(v_src, '')) = 0
     OR position('table_seats' IN COALESCE(v_src, '')) = 0
     OR position('physical_final_table_seat_set_is_not_exact'
                 IN COALESCE(v_src, '')) = 0 THEN
    RAISE EXCEPTION 'atomic final-table-deal body lost its obligation/batch/seat-proof path';
  END IF;
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'trg_freeze_batched_tournament_result';
  IF position('tournament_place_settlement_batches' IN COALESCE(v_src, '')) = 0
     OR position('tournament_final_table_deal_batches' IN COALESCE(v_src, '')) = 0
     OR position('NEW.chips' IN COALESCE(v_src, '')) = 0
     OR position('NEW.registered_at' IN COALESCE(v_src, '')) = 0
     OR position('NEW.rebuys' IN COALESCE(v_src, '')) = 0
     OR position('NEW.add_on' IN COALESCE(v_src, '')) = 0 THEN
    RAISE EXCEPTION
      'atomic result freeze does not cover both terminal contracts and their deal inputs';
  END IF;
END;
$assert$;

COMMIT;
