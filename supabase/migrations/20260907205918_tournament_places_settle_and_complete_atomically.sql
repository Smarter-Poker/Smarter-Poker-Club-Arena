-- A TOURNAMENT PAYS EVERY STRUCTURE PLACE OR IT COMPLETES NOBODY.
--
-- Production evidence, 2026-09-07: 342 `source = 'reconcile'` payout rows
-- moved 32,849.99 chips to 191 events during the preceding seven days. The
-- engine paid places through separate HTTP transactions, flipped the event to
-- COMPLETED, then called a deliberately non-fatal repair. Both zero-paid and
-- partly-paid COMPLETED events are therefore possible by construction.
--
-- The repair is not the root transaction. One reconciler invocation is a
-- PostgreSQL transaction, but it treats a refused leg as data and continues.
-- The current single-obligation function can also return ok:true after paying
-- only the balance held by a short escrow. This migration therefore checks the
-- stored paid total after every child call; `ok` by itself is not success.
--
-- The permanent path has two commits:
--
--   1. fn_prepare_tournament_place_obligations freezes the published structure
--      into an exact-cent batch header and the complete place obligation set,
--      plus the exact Bubble Protection obligation derived from the finalized,
--      normalized field when one applies. It
--      moves no chips. The committed obligations plus their fingerprint are
--      the restart record.
--   2. fn_settle_tournament_places_atomic pays every row and changes
--      COMPLETING -> COMPLETED inside one exception subtransaction. Any
--      refusal, partial leg, error or deadlock rolls every new credit and the
--      terminal state back, while the prepared restart record remains.
--
-- A final BEFORE-COMPLETED trigger independently enforces that normal events
-- cannot bypass this door. Satellites and final-table deals retain their own
-- contracts. Bubble Protection is derived only after registration is closed,
-- funding and the payout ladder are final, and the complete field has canonical
-- standings. Its frozen buy-in promise is then included in the same funding
-- preflight and all-or-none transfer as the place plan.

BEGIN;

SET LOCAL lock_timeout = '4s';

CREATE TABLE IF NOT EXISTS public.tournament_place_settlement_batches (
  tournament_id    uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  mode             text NOT NULL DEFAULT 'structure' CHECK (mode = 'structure'),
  plan_fingerprint text NOT NULL CHECK (plan_fingerprint ~ '^[0-9a-f]{32}$'),
  place_count      integer NOT NULL CHECK (place_count >= 0),
  amount_owed      numeric(15,2) NOT NULL CHECK (amount_owed >= 0),
  escrow_required  numeric(15,2) NOT NULL CHECK (escrow_required >= 0),
  escrow_available numeric(15,2) NOT NULL CHECK (escrow_available >= 0),
  bubble_contract_required boolean NOT NULL DEFAULT false,
  bubble_obligation_id uuid,
  bubble_user_id      uuid,
  bubble_source       text,
  bubble_amount_owed  numeric(15,2) NOT NULL DEFAULT 0 CHECK (bubble_amount_owed >= 0),
  bubble_amount_paid_before numeric(15,2) NOT NULL DEFAULT 0
    CHECK (bubble_amount_paid_before >= 0
           AND bubble_amount_paid_before <= bubble_amount_owed),
  source           text NOT NULL,
  prepared_at      timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  CHECK (
    (NOT bubble_contract_required
      AND bubble_obligation_id IS NULL AND bubble_user_id IS NULL
      AND bubble_source IS NULL AND bubble_amount_owed = 0
      AND bubble_amount_paid_before = 0)
    OR
    (bubble_contract_required
      AND bubble_obligation_id IS NOT NULL AND bubble_user_id IS NOT NULL
      AND NULLIF(btrim(bubble_source), '') IS NOT NULL
      AND bubble_amount_owed > 0)
  )
);

ALTER TABLE public.tournament_place_settlement_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_place_settlement_batches FROM PUBLIC, anon, authenticated;
/* The SECURITY DEFINER prepare/settle functions own every write. BYPASSRLS does
   not imply a table privilege, so SELECT-only keeps service_role from forging
   a header or its settled marker through PostgREST or a direct session. */
REVOKE ALL ON public.tournament_place_settlement_batches FROM service_role;
GRANT SELECT ON public.tournament_place_settlement_batches TO service_role;

/* `set_config` is not an authorization boundary: a direct service-role session
   can set any custom GUC. Keep the obligation ledger SELECT-only to that role;
   every legitimate write runs as the owner inside an audited SECURITY DEFINER
   settlement function. */
REVOKE ALL ON public.tournament_obligations FROM service_role;
GRANT SELECT ON public.tournament_obligations TO service_role;

COMMENT ON TABLE public.tournament_place_settlement_batches IS
  'Immutable completeness header for one normal tournament place plan and its exact finalized-field Bubble Protection obligation when applicable. The fingerprint covers the ordered place, player and exact-cent entitlement stored in tournament_obligations.';

/* The historical single-obligation RPC is still needed for refunds, bounties
   and satellite awards, but it must no longer be a normal-tournament place
   payer. Keep its audited implementation private and put a classification
   gate on the public signature. The two atomic batch functions below call the
   private core only after they have frozen and proved their complete plans;
   service_role cannot invoke that core directly. This is stronger than a
   custom-GUC-only gate, because any database client can set a custom GUC. */
DO $wrap_single_obligation_payer$
BEGIN
  IF to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'
     ) IS NULL THEN
    IF to_regprocedure(
         'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'
       ) IS NULL THEN
      RAISE EXCEPTION 'fn_settle_tournament_obligation core missing';
    END IF;
    ALTER FUNCTION public.fn_settle_tournament_obligation(
      uuid, text, integer, uuid, numeric, text, text, uuid
    ) RENAME TO fn_settle_tournament_obligation_before_atomic_batch_gate;
  END IF;
END;
$wrap_single_obligation_payer$;

REVOKE ALL ON FUNCTION
  public.fn_settle_tournament_obligation_before_atomic_batch_gate(
    uuid, text, integer, uuid, numeric, text, text, uuid
  ) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_description text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_is_satellite boolean := false;
BEGIN
  /* Preserve the private core's canonical validation responses, and avoid a
     second tournament read for money classes that are not part of a structure
     batch. None of these branches can move normal structure money. */
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR round(COALESCE(p_amount, 0), 2) < 0
     OR v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty',
                       'refund','seat','satellite_remainder',
                       'bubble_protection','final_table_deal',
                       'late_reg_adjustment')
     OR (v_kind IN ('place', 'late_reg_adjustment') AND p_place IS NULL)
     OR v_kind NOT IN ('place', 'late_reg_adjustment',
                       'bubble_protection', 'final_table_deal') THEN
    RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
      p_tournament_id, p_kind, p_place, p_user_id, p_amount, p_source,
      p_description, p_adjustment_id);
  END IF;

  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'tournament_not_found', 'obligation_id', NULL,
      'idempotency_key', NULL);
  END IF;

  v_is_satellite := lower(COALESCE(v_t.variant, '')) = 'satellite'
                    OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
                    OR v_t.satellite_target_id IS NOT NULL;

  IF NOT v_is_satellite THEN
    RETURN jsonb_build_object(
      'ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'atomic_batch_required', 'obligation_id', NULL,
      'idempotency_key', NULL,
      'detail', 'normal place, Bubble Protection and final-table-deal money move only inside their complete atomic batch');
  END IF;

  RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
    p_tournament_id, p_kind, p_place, p_user_id, p_amount, p_source,
    p_description, p_adjustment_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) TO service_role;

COMMENT ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) IS
  'Single-obligation payer for non-structure money and satellites. Normal place, late-registration, Bubble Protection and final-table-deal settlement is refused; only the private cores inside the complete atomic batch functions may move that money.';

/* Once a complete place batch exists, no legacy caller may increase, replace
   or delete one of its obligations. The atomic settler opens this gate only
   for its own transaction-local call into fn_settle_tournament_obligation.
   This closes the post-COMPLETED top-up escape hatch as well as mutations in
   the prepare/settle gap. */
CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
  v_gate text := COALESCE(current_setting('app.atomic_tournament_place_batch', true), '');
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.kind IN ('place', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.kind IN ('place', 'bubble_protection') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;

  IF NOT v_old_batched AND NOT v_new_batched THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  /* The FK's parent cascade is the only legal delete after preparation. */
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
    RETURN OLD;
  END IF;

  /* Settlement only updates the already-frozen payment progress. It never
     creates, deletes, rekeys, changes a recipient or changes an entitlement. */
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'tournament obligations frozen by an atomic place batch cannot be %', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW.id, NEW.tournament_id, NEW.kind, NEW.place, NEW.user_id,
         NEW.amount_owed, NEW.created_at, NEW.adjustment_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tournament_id, OLD.kind, OLD.place, OLD.user_id,
         OLD.amount_owed, OLD.created_at, OLD.adjustment_id) THEN
    RAISE EXCEPTION
      'a frozen place obligation identity, recipient or entitlement cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'bubble_protection'
     AND NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION
      'a frozen Bubble Protection obligation source cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN
    RAISE EXCEPTION
      'tournament obligations for tournament % are frozen by their atomic place batch',
      OLD.tournament_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_paid + 0.005 < OLD.amount_paid
     OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION
      'a frozen place obligation payment record cannot move backwards'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_freeze_batched_tournament_place()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zzzz_freeze_batched_tournament_place
  ON public.tournament_obligations;
CREATE TRIGGER zzzz_freeze_batched_tournament_place
BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_obligations
FOR EACH ROW
EXECUTE FUNCTION public.trg_freeze_batched_tournament_place();

/* Earlier development snapshots recorded Bubble Protection during elimination.
   That result could only be provisional while registration was still open and
   inverted the tournament -> player lock order used by registration/rebuy.
   Remove any such preview object. The finalized prepare transaction below is
   the sole prospective materialization point. */
DROP TRIGGER IF EXISTS zzzz_record_bubble_obligation_with_elimination
  ON public.tournament_players;
DROP FUNCTION IF EXISTS public.trg_record_bubble_obligation_with_elimination();

/* Older payout rows occasionally carry a generic source but retain the exact
   obligation key. The key prefix alone is not enough: bubble, deal, satellite
   and place obligations all use `tourney:<id>:obl:<obligation>:<attempt>`.
   Resolve the embedded obligation against its durable row before treating the
   payout as normal-place evidence. */
CREATE OR REPLACE FUNCTION public.fn_tournament_payout_key_is_place_evidence(
  p_tournament_id uuid,
  p_idempotency_key text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND p_idempotency_key LIKE
           'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
  );
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_key_is_place_evidence(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_key_is_place_evidence(uuid, text)
  TO service_role;

/* Final result renumbering used to be one PostgREST UPDATE per player. A
   process exit halfway through could leave duplicate or gapped positions that
   the settlement door correctly refused but no recovery path could repair.
   This result-only RPC computes the complete assignment first and publishes it
   with one UPDATE in one database transaction. It never moves money. */
CREATE OR REPLACE FUNCTION public.fn_normalize_tournament_final_standings(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_status              text;
  v_player_count        integer := 0;
  v_ranked_count        integer := 0;
  v_distinct_positions integer := 0;
  v_min_position        integer := 0;
  v_max_position        integer := 0;
  v_winner_count        integer := 0;
  v_winner_place_one    integer := 0;
  v_nonterminal_count   integer := 0;
  v_missing_bust_time   integer := 0;
  v_negative_prizes     integer := 0;
  v_evidence_invalid    integer := 0;
  v_orphan_payout_keys  integer := 0;
  v_canonical_mismatches integer := 0;
  v_updated             integer := 0;
  v_batch_exists        boolean := false;
  v_failure             text;
  v_failure_state       text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.status INTO v_status
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'retryable', false);
  END IF;
  IF v_status NOT IN ('COMPLETING', 'COMPLETED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_completing',
                              'status', v_status, 'retryable', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'final_table_deal_has_its_own_standings',
                              'retryable', false);
  END IF;

  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  SELECT count(*), count(tp.position), count(DISTINCT tp.position),
         COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL),
         count(*) FILTER (WHERE round(COALESCE(tp.prize, 0) * 100)::bigint < 0)
    INTO v_player_count, v_ranked_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time,
         v_negative_prizes
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  IF v_player_count = 0 OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0
     OR v_negative_prizes <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'final_result_is_not_proven',
      'players', v_player_count, 'winners', v_winner_count,
      'winner_at_place_one', v_winner_place_one,
      'nonterminal_players', v_nonterminal_count,
      'eliminated_without_time', v_missing_bust_time,
      'negative_prizes', v_negative_prizes, 'retryable', false);
  END IF;

  /* A generic obligation-key payout is classifiable only while its exact
     durable obligation still exists. Silently ignoring an orphan would let a
     deleted place obligation look unpaid and allocate the same chips again;
     guessing that every generic key is a place would instead misclassify
     Bubble Protection and final-table deals. Refuse both ambiguities before
     this result-only function can renumber a single row. */
  SELECT count(*) INTO v_orphan_payout_keys
    FROM (
      SELECT p.idempotency_key
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.idempotency_key LIKE
             'tourney:' || p_tournament_id::text || ':obl:%'
         AND NOT EXISTS (
           SELECT 1
             FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND p.idempotency_key LIKE
                  'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
         )
       GROUP BY p.idempotency_key
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) orphaned;
  IF v_orphan_payout_keys > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'unattributed_obligation_key_evidence',
      'keys', v_orphan_payout_keys, 'retryable', false);
  END IF;

  /* Chronology is the result authority: the champion is first and eliminated
     rows run from latest bust in second through earliest bust in last. A
     provisional place/prize is only an estimate. Historical payout evidence
     may prove that a canonical result was already paid; it may never redefine
     that result. Any paid player/place that disagrees requires manual review
     because this function neither claws money back nor moves it to a different
     recipient. */
  WITH eliminated AS (
    SELECT tp.id, tp.user_id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  ),
  canonical AS (
    SELECT tp.id, tp.user_id, 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'winner'
    UNION ALL
    SELECT e.id, e.user_id, e.canonical_position FROM eliminated e
  ),
  evidence AS (
    SELECT p.position, p.user_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                         'late_reg_adjustment', 'clawback', 'spin_backpay',
                         'overlay_backpay')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 p.tournament_id, p.idempotency_key))
     GROUP BY p.position, p.user_id
    HAVING abs(round(sum(p.amount), 2)) > 0.005
  )
  SELECT count(*) INTO v_evidence_invalid
    FROM evidence e
   WHERE e.position IS NULL OR NOT EXISTS (
     SELECT 1 FROM canonical c
      WHERE c.canonical_position = e.position AND c.user_id = e.user_id);
  IF v_evidence_invalid > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'paid_positions_do_not_match_final_results',
      'invalid_payout_groups', v_evidence_invalid, 'retryable', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id = p_tournament_id
  ) INTO v_batch_exists;

  WITH eliminated AS (
    SELECT tp.id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated'
  ),
  canonical AS (
    SELECT tp.id, 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'winner'
    UNION ALL
    SELECT e.id, e.canonical_position FROM eliminated e
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM canonical c
    JOIN public.tournament_players tp ON tp.id = c.id
   WHERE tp.position IS DISTINCT FROM c.canonical_position;

  /* A prepared or completed result is immutable. It may be observed when it
     is already exact, but this repair door never rewrites it. */
  IF v_batch_exists OR v_status = 'COMPLETED' THEN
    IF v_ranked_count = v_player_count
       AND v_distinct_positions = v_player_count
       AND v_min_position = 1 AND v_max_position = v_player_count
       AND v_canonical_mismatches = 0 THEN
      RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                                'players', v_player_count, 'updated', 0,
                                'already_normalized', true, 'retryable', false);
    END IF;
    RETURN jsonb_build_object('ok', false,
                              'reason', 'frozen_final_standings_are_invalid',
                              'retryable', false);
  END IF;

  IF v_canonical_mismatches = 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'players', v_player_count, 'updated', 0,
                              'already_normalized', true, 'retryable', false);
  END IF;

  BEGIN
    /* Clear every eliminated position first. Besides making the assignment
       deterministic even when the old ladder happened to be contiguous-but-
       wrong, this prevents the collision watcher from logging transient swaps.
       Both statements live in this exception subtransaction and therefore
       publish together or roll back together. */
    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status = 'eliminated';

    WITH assignments AS (
      SELECT tp.id,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    UPDATE public.tournament_players tp
       SET position = a.position
      FROM assignments a
     WHERE tp.id = a.id AND tp.position IS DISTINCT FROM a.position;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    SELECT count(*), count(tp.position), count(DISTINCT tp.position),
           COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
           count(*) FILTER (WHERE tp.status = 'winner'),
           count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
           count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated'))
      INTO v_player_count, v_ranked_count, v_distinct_positions,
           v_min_position, v_max_position, v_winner_count,
           v_winner_place_one, v_nonterminal_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id;

    WITH eliminated AS (
      SELECT tp.id,
             v_player_count - (row_number() OVER (
               ORDER BY tp.eliminated_at ASC, tp.id ASC
             ))::integer + 1 AS canonical_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status = 'eliminated'
    )
    SELECT count(*) INTO v_canonical_mismatches
      FROM eliminated e
      JOIN public.tournament_players tp ON tp.id = e.id
     WHERE tp.position IS DISTINCT FROM e.canonical_position;
    IF v_player_count = 0 OR v_ranked_count <> v_player_count
       OR v_distinct_positions <> v_player_count
       OR v_min_position <> 1 OR v_max_position <> v_player_count
       OR v_winner_count <> 1 OR v_winner_place_one <> 1
       OR v_nonterminal_count <> 0 OR v_canonical_mismatches <> 0 THEN
      RAISE EXCEPTION USING
        MESSAGE = 'the complete final-standings assignment did not validate',
        ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  IF v_failure IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'standings_write_aborted',
                              'detail', v_failure, 'sqlstate', v_failure_state,
                              'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                            'players', v_player_count, 'updated', v_updated,
                            'retryable', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_normalize_tournament_final_standings(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_normalize_tournament_final_standings(uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_normalize_tournament_final_standings(uuid) IS
  'Atomically re-ranks every unpaid eliminated result by bust time over the final field, preserving only the unique champion and exact recognized payout evidence. Moves no money.';

CREATE OR REPLACE FUNCTION public.fn_prepare_tournament_place_obligations(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.atomicPlaceSettlement'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_t                    record;
  v_batch                public.tournament_place_settlement_batches%ROWTYPE;
  v_existing             public.tournament_obligations%ROWTYPE;
  v_source               text := COALESCE(NULLIF(btrim(p_source), ''), 'engine.atomicPlaceSettlement');
  v_struct               jsonb := '[]'::jsonb;
  v_trimmed              jsonb := '[]'::jsonb;
  v_plan                 jsonb := '[]'::jsonb;
  v_plan_fingerprint     text;
  v_field_count          integer := 0;
  v_position_count       integer := 0;
  v_distinct_positions   integer := 0;
  v_min_position         integer := 0;
  v_max_position         integer := 0;
  v_winner_count         integer := 0;
  v_winner_place_one     integer := 0;
  v_nonterminal_count    integer := 0;
  v_missing_bust_time    integer := 0;
  v_canonical_mismatches integer := 0;
  v_expected_count       integer := 0;
  v_actual_count         integer := 0;
  v_open_count           integer := 0;
  v_conflicts            integer := 0;
  v_holders              integer := 0;
  v_last_place           integer := 0;
  v_total_bp             bigint := 0;
  v_pool_cents           bigint := 0;
  v_remaining_cents      bigint := 0;
  v_expected_cents       bigint := 0;
  v_expected_total_cents bigint := 0;
  v_player_prize_cents   bigint := 0;
  v_seeded_paid          numeric := 0;
  v_seeded_total_cents   bigint := 0;
  v_required_unpaid_cents bigint := 0;
  v_total_required_unpaid_cents bigint := 0;
  v_escrow_balance       numeric := 0;
  v_escrow_enforced      boolean := false;
  v_escrow_found         boolean := false;
  v_wrong_recipients     integer := 0;
  v_bubble_user          uuid;
  v_bubble_holders       integer := 0;
  v_bubble_obligations   integer := 0;
  v_bubble_matching      integer := 0;
  v_bubble_owed          numeric := 0;
  v_bubble_paid          numeric := 0;
  v_bubble_evidence      numeric := 0;
  v_bubble_evidence_exists boolean := false;
  v_bubble_required      boolean := false;
  v_bubble_contract_required boolean := false;
  v_bubble_obligation_id uuid;
  v_bubble_source        text;
  v_bubble_settled_at    timestamptz;
  v_bubble_unpaid_cents  bigint := 0;
  v_bubble_needs_insert  boolean := false;
  v_actual_total         numeric := 0;
  v_actual_fingerprint   text;
  v_holder               uuid;
  v_holder_club          uuid;
  v_normalized           jsonb;
  v_write_failure        text;
  v_write_state          text;
  r                      record;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.id, t.name, t.status, round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         t.payout_structure, t.variant, t.tournament_type, t.satellite_target_id,
         t.spin_multiplier, COALESCE(t.bubble_protection, false) AS bubble_protection,
         round(COALESCE(t.buy_in_amount, 0), 2) AS buy_in_amount
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'retryable', false);
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'satellite_has_its_own_settlement',
                              'retryable', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'final_table_deal_has_its_own_settlement',
                              'retryable', false);
  END IF;
  IF COALESCE(v_t.status, '') NOT IN ('COMPLETING', 'COMPLETED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_completing',
                              'status', v_t.status, 'retryable', false);
  END IF;
  IF NOT v_t.prize_pool_finalized
     OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prize_pool_is_not_funded_and_finalized',
                              'prize_pool', v_t.prize_pool,
                              'guaranteed_prize', v_t.guaranteed_prize,
                              'prize_pool_finalized', v_t.prize_pool_finalized,
                              'retryable', false);
  END IF;

  /* Normalization is part of the database money door, not merely an engine
     convention. A caller cannot skip the result RPC, publish a contiguous but
     chronologically false ladder, and have the batch freeze/pay it. The nested
     call takes the same tournament/player locks and moves no money. */
  v_normalized := public.fn_normalize_tournament_final_standings(p_tournament_id);
  IF NOT COALESCE((v_normalized->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'final_standings_normalization_failed',
      'normalization_reason', v_normalized->>'reason',
      'detail', v_normalized->>'detail',
      'retryable', COALESCE((v_normalized->>'retryable')::boolean, false));
  END IF;

  /* Serialize result edits already in flight. New registrations are rejected
     by the tournament lifecycle once status is COMPLETING. */
  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  SELECT count(*), count(tp.position), count(DISTINCT tp.position),
         COALESCE(min(tp.position), 0), COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL)
    INTO v_field_count, v_position_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  IF v_field_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_has_no_players',
                              'retryable', false);
  END IF;
  IF v_position_count <> v_field_count OR v_distinct_positions <> v_field_count
     OR v_min_position <> 1 OR v_max_position <> v_field_count
     OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'standings_are_not_final_unique_and_terminal',
                              'players', v_field_count, 'ranked', v_position_count,
                              'distinct_positions', v_distinct_positions,
                              'min_position', v_min_position,
                              'max_position', v_max_position,
                              'winners', v_winner_count,
                              'winner_at_place_one', v_winner_place_one,
                              'nonterminal_players', v_nonterminal_count,
                              'eliminated_without_time', v_missing_bust_time,
                              'retryable', false);
  END IF;

  WITH eliminated AS (
    SELECT tp.id,
           v_field_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'eliminated'
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM eliminated e
    JOIN public.tournament_players tp ON tp.id = e.id
   WHERE tp.position IS DISTINCT FROM e.canonical_position;
  IF v_canonical_mismatches <> 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'standings_are_not_in_canonical_bust_order',
                              'mismatches', v_canonical_mismatches,
                              'retryable', false);
  END IF;

  v_pool_cents := round(v_t.prize_pool * 100)::bigint;

  IF v_pool_cents > 0 THEN
    BEGIN
      /* A Spin's drawn tier outranks its creation-time placeholder. This is
         the same source used by resolvePayoutStructure in the engine. */
      IF lower(COALESCE(v_t.variant, '')) = 'spin'
         OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN' THEN
        IF v_t.spin_multiplier IS NULL OR v_t.spin_multiplier <= 0 THEN
          RETURN jsonb_build_object('ok', false,
                                    'reason', 'spin_multiplier_is_not_persisted',
                                    'retryable', false);
        END IF;
        SELECT l.structure INTO v_struct
          FROM public.spin_payout_ladder l
         WHERE l.multiplier = v_t.spin_multiplier;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('ok', false,
                                    'reason', 'spin_multiplier_has_no_canonical_ladder',
                                    'spin_multiplier', v_t.spin_multiplier,
                                    'retryable', false);
        END IF;
      ELSE
        v_struct := public.fn_safe_jsonb_array(v_t.payout_structure);
      END IF;
      IF jsonb_array_length(v_struct) = 0 OR EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_struct) e
         WHERE jsonb_typeof(e) <> 'object'
            OR COALESCE(e->>'place', '') !~ '^[1-9][0-9]*$'
            OR COALESCE(e->>'percentage', '') !~ '^[0-9]+([.][0-9]+)?$'
            OR (e->>'percentage')::numeric < 0
      ) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                                  'retryable', false);
      END IF;

      SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer), '[]'::jsonb)
        INTO v_trimmed
        FROM jsonb_array_elements(v_struct) e
       WHERE (e->>'place')::integer <= v_field_count;

      SELECT count(*), count(DISTINCT (e->>'place')::integer),
             COALESCE(min((e->>'place')::integer), 0),
             COALESCE(max((e->>'place')::integer), 0),
             COALESCE(sum(round((e->>'percentage')::numeric * 100)::bigint), 0)
        INTO v_expected_count, v_conflicts, v_position_count, v_last_place, v_total_bp
        FROM jsonb_array_elements(v_trimmed) e;

      IF v_expected_count = 0 OR v_conflicts <> v_expected_count
         OR v_position_count <> 1 OR v_last_place <> v_expected_count
         OR v_total_bp <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'payout_places_are_not_contiguous',
                                  'places', v_expected_count, 'last_place', v_last_place,
                                  'retryable', false);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'payout_structure_is_invalid',
                                'detail', SQLERRM, 'retryable', false);
    END;

    v_remaining_cents := v_pool_cents;
    FOR r IN
      SELECT (e->>'place')::integer AS place,
             round((e->>'percentage')::numeric * 100)::bigint AS bp
        FROM jsonb_array_elements(v_trimmed) e
       ORDER BY (e->>'place')::integer
    LOOP
      IF r.place = v_last_place THEN
        v_expected_cents := GREATEST(v_remaining_cents, 0);
      ELSE
        v_expected_cents := GREATEST(
          LEAST(v_remaining_cents, round(v_pool_cents * r.bp::numeric / v_total_bp)::bigint), 0);
      END IF;
      v_remaining_cents := v_remaining_cents - v_expected_cents;

      SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1],
             (array_agg(tp.club_id ORDER BY tp.id))[1],
             COALESCE(max(round(COALESCE(tp.prize, 0) * 100)::bigint), 0)
        INTO v_holders, v_holder, v_holder_club, v_player_prize_cents
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;

      IF v_holders <> 1 OR v_holder IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'payout_place_has_no_unique_holder',
                                  'place', r.place, 'holders', v_holders,
                                  'retryable', false);
      END IF;
      IF v_player_prize_cents <> v_expected_cents THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'recorded_prize_disagrees_with_structure',
                                  'place', r.place,
                                  'recorded', v_player_prize_cents / 100.0,
                                  'expected', v_expected_cents / 100.0,
                                  'retryable', false);
      END IF;

      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', r.place, 'user_id', v_holder, 'club_id', v_holder_club,
        'cents', v_expected_cents));
      v_expected_total_cents := v_expected_total_cents + v_expected_cents;
    END LOOP;
  ELSE
    /* A zero-pool event has no place money. It still gets a durable empty
       header so the universal completion gate can distinguish proof from an
       omitted plan. */
    v_expected_count := 0;
    IF EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND round(COALESCE(tp.prize, 0) * 100)::bigint <> 0
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'zero_pool_has_recorded_prizes',
                                'retryable', false);
    END IF;
  END IF;

  IF v_expected_total_cents <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'structure_does_not_allocate_the_pool',
                              'allocated', v_expected_total_cents / 100.0,
                              'prize_pool', v_pool_cents / 100.0,
                              'retryable', false);
  END IF;

  SELECT count(*) INTO v_conflicts
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_plan) p
        WHERE (p->>'place')::integer = tp.position
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'recorded_prize_is_outside_structure',
                              'rows', v_conflicts, 'retryable', false);
  END IF;

  v_plan_fingerprint := md5(v_plan::text);

  SELECT * INTO v_batch
    FROM public.tournament_place_settlement_batches b
   WHERE b.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND AND (
       v_batch.mode <> 'structure'
       OR v_batch.plan_fingerprint <> v_plan_fingerprint
       OR v_batch.place_count <> v_expected_count
       OR round(v_batch.amount_owed * 100)::bigint <> v_expected_total_cents
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'prepared_plan_is_immutable',
                              'existing_fingerprint', v_batch.plan_fingerprint,
                              'proposed_fingerprint', v_plan_fingerprint,
                              'retryable', false);
  END IF;

  FOR r IN
    SELECT (p->>'place')::integer AS place,
           (p->>'user_id')::uuid AS user_id,
           (p->>'cents')::bigint AS cents
      FROM jsonb_array_elements(v_plan) p
     ORDER BY (p->>'place')::integer
  LOOP
    SELECT round(COALESCE(sum(tpo.amount), 0), 2)
      INTO v_seeded_paid
      FROM public.tournament_payouts tpo
     WHERE tpo.tournament_id = p_tournament_id
       AND tpo.position = r.place
       AND tpo.user_id = r.user_id
       AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 tpo.tournament_id, tpo.idempotency_key));

    v_seeded_total_cents := v_seeded_total_cents
                            + round(v_seeded_paid * 100)::bigint;

    SELECT count(*) INTO v_wrong_recipients
      FROM (
        SELECT tpo.user_id
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.position = r.place
           AND tpo.user_id IS DISTINCT FROM r.user_id
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback', 'spin_backpay',
                               'overlay_backpay')
                OR public.fn_tournament_payout_key_is_place_evidence(
                     tpo.tournament_id, tpo.idempotency_key))
         GROUP BY tpo.user_id
        HAVING abs(round(sum(tpo.amount), 2)) > 0.005
      ) wrong;

    SELECT * INTO v_existing
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = r.place
     FOR UPDATE;

    IF v_wrong_recipients > 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'legacy_place_paid_to_wrong_player',
                                'place', r.place, 'expected_user_id', r.user_id,
                                'wrong_recipients', v_wrong_recipients,
                                'retryable', false);
    END IF;

    IF v_seeded_paid < -0.005
       OR v_seeded_paid > r.cents / 100.0 + 0.005
       OR (FOUND AND abs(round(v_existing.amount_paid, 2) - v_seeded_paid) > 0.005)
       OR (FOUND AND v_existing.amount_paid > r.cents / 100.0 + 0.005)
       OR (FOUND AND v_existing.amount_owed > r.cents / 100.0 + 0.005)
       OR (FOUND AND v_existing.amount_paid > 0
                    AND v_existing.user_id IS DISTINCT FROM r.user_id) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'legacy_place_conflicts_with_plan',
                                'place', r.place, 'user_id', r.user_id,
                                'expected', r.cents / 100.0,
                                'payout_rows_paid', v_seeded_paid,
                                'retryable', false);
    END IF;
  END LOOP;

  v_required_unpaid_cents := v_expected_total_cents - v_seeded_total_cents;
  IF v_required_unpaid_cents < 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'legacy_place_payments_exceed_plan',
                              'paid', v_seeded_total_cents / 100.0,
                              'plan', v_expected_total_cents / 100.0,
                              'retryable', false);
  END IF;

  /* Evidence for a paid place that the frozen ladder does not contain is not
     ignorable history: allocating the entire pool again would overpay the
     event. Net a historical positive row against any matching clawback, then
     refuse every non-zero position/user group outside the plan (including a
     NULL position). */
  SELECT count(*) INTO v_conflicts
    FROM (
      SELECT tpo.position, tpo.user_id
        FROM public.tournament_payouts tpo
       WHERE tpo.tournament_id = p_tournament_id
         AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   tpo.tournament_id, tpo.idempotency_key))
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_plan) p
            WHERE (p->>'place')::integer = tpo.position
         )
       GROUP BY tpo.position, tpo.user_id
      HAVING abs(round(sum(tpo.amount), 2)) > 0.005
    ) unexpected_paid_place;
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'legacy_paid_place_is_outside_plan',
                              'rows', v_conflicts, 'retryable', false);
  END IF;

  SELECT count(*) INTO v_conflicts
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_plan) p
        WHERE (p->>'place')::integer = o.place
     );
  IF v_conflicts > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unexpected_legacy_place_obligation',
                              'rows', v_conflicts, 'retryable', false);
  END IF;

  /* Bubble Protection spends the same enforced prize bank. Derive its exact
     holder only after the entry window is closed, the pool/ladder is finalized
     and the full standings have been normalized. The eliminated result is the
     durable event: creating the zero-paid obligation in this same prepare
     transaction closes the old result-write -> HTTP-obligation gap without
     guessing from a provisional open-registration position. */
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND o.kind = 'bubble_protection'
         ) OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'bubble_protection'
         )
    INTO v_bubble_evidence_exists;
  v_bubble_required := v_t.bubble_protection OR v_bubble_evidence_exists;
  v_bubble_contract_required := v_bubble_required
    AND v_expected_count > 0 AND v_field_count > v_expected_count;

  /* A mutable display flag is not allowed to erase durable money evidence.
     Conversely, a flagged short field in which every entrant is already paid
     has no stone bubble and owes no refund. Evidence with no coherent contract
     is corruption and must be repaired explicitly, never silently ignored. */
  IF (v_bubble_evidence_exists OR v_bubble_contract_required)
     AND v_t.buy_in_amount <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_evidence_has_no_valid_contract',
      'buy_in_amount', v_t.buy_in_amount, 'paid_places', v_expected_count,
      'field_size', v_field_count, 'retryable', false);
  END IF;
  IF v_bubble_evidence_exists AND NOT v_bubble_contract_required THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_evidence_has_no_valid_contract',
      'buy_in_amount', v_t.buy_in_amount, 'paid_places', v_expected_count,
      'field_size', v_field_count, 'retryable', false);
  END IF;

  IF v_bubble_contract_required THEN
    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
      INTO v_bubble_holders, v_bubble_user
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_expected_count + 1;
    IF v_bubble_holders <> 1 OR v_bubble_user IS NULL THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_holder_is_not_proven',
                                'bubble_place', v_expected_count + 1,
                                'holders', v_bubble_holders,
                                'retryable', false);
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

    IF v_bubble_obligations = 0 AND NOT v_bubble_evidence_exists THEN
      v_bubble_obligation_id := gen_random_uuid();
      v_bubble_source := 'engine.atomicPlaceSettlement';
      v_bubble_owed := v_t.buy_in_amount;
      v_bubble_paid := 0;
      v_bubble_settled_at := NULL;
      v_bubble_needs_insert := true;
    ELSIF v_bubble_obligations <> 1 OR v_bubble_matching <> 1 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_obligation_is_not_exact',
                                'bubble_place', v_expected_count + 1,
                                'user_id', v_bubble_user,
                                'expected', v_t.buy_in_amount,
                                'amount_owed', v_bubble_owed,
                                'amount_paid', v_bubble_paid,
                                'payout_evidence', v_bubble_evidence,
                                'retryable', false);
    END IF;

    IF NOT v_bubble_needs_insert THEN
      SELECT o.id, o.source, o.amount_owed, o.amount_paid, o.settled_at
        INTO v_bubble_obligation_id, v_bubble_source,
             v_bubble_owed, v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user
       FOR UPDATE;
    END IF;

    IF COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicPlaceSettlement')
       OR abs(v_bubble_owed - v_t.buy_in_amount) > 0.005
       OR v_bubble_paid < -0.005 OR v_bubble_paid > v_bubble_owed + 0.005
       OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
       OR (v_bubble_paid + 0.005 >= v_bubble_owed
           AND v_bubble_settled_at IS NULL)
       OR (v_bubble_paid + 0.005 < v_bubble_owed
           AND v_bubble_settled_at IS NOT NULL) THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_obligation_is_not_exact',
                                'bubble_place', v_expected_count + 1,
                                'user_id', v_bubble_user,
                                'expected', v_t.buy_in_amount,
                                'amount_owed', v_bubble_owed,
                                'amount_paid', v_bubble_paid,
                                'payout_evidence', v_bubble_evidence,
                                'source', v_bubble_source,
                                'retryable', false);
    END IF;

    SELECT count(*) INTO v_conflicts
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p.source = 'bubble_protection'
           AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user)
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) unexpected_bubble;
    IF v_conflicts > 0 THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'bubble_protection_evidence_conflicts',
                                'rows', v_conflicts, 'retryable', false);
    END IF;
    v_bubble_unpaid_cents := round((v_bubble_owed - v_bubble_paid) * 100)::bigint;
  END IF;

  v_total_required_unpaid_cents := v_required_unpaid_cents + v_bubble_unpaid_cents;

  /* The finalized flag is not money. Before freezing any obligation that will
     move chips, lock the enforced tournament escrow and prove that its live
     prize balance covers the complete place + Bubble amount still unpaid. */
  IF v_total_required_unpaid_cents > 0 THEN
    SELECT e.enforced, round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_balance
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    v_escrow_found := FOUND;
    IF NOT v_escrow_found OR NOT v_escrow_enforced
       OR round(v_escrow_balance * 100)::bigint < v_total_required_unpaid_cents THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'prize_escrow_is_not_funded',
        'required_unpaid', v_total_required_unpaid_cents / 100.0,
        'place_unpaid', v_required_unpaid_cents / 100.0,
        'bubble_unpaid', v_bubble_unpaid_cents / 100.0,
        'escrow_available', CASE WHEN v_escrow_found THEN v_escrow_balance ELSE NULL END,
        'escrow_enforced', CASE WHEN v_escrow_found THEN v_escrow_enforced ELSE NULL END,
        'retryable', false);
    END IF;
  END IF;

  IF v_batch.tournament_id IS NOT NULL AND (
       v_batch.bubble_contract_required IS DISTINCT FROM v_bubble_contract_required
       OR v_batch.bubble_obligation_id IS DISTINCT FROM v_bubble_obligation_id
       OR v_batch.bubble_user_id IS DISTINCT FROM v_bubble_user
       OR v_batch.bubble_source IS DISTINCT FROM v_bubble_source
       OR abs(v_batch.bubble_amount_owed - v_bubble_owed) > 0.005
       OR v_batch.bubble_amount_paid_before > v_bubble_paid + 0.005
       OR (v_t.status <> 'COMPLETED'
           AND abs(v_batch.bubble_amount_paid_before - v_bubble_paid) > 0.005)
       OR (v_t.status <> 'COMPLETED'
           AND round(v_batch.escrow_required * 100)::bigint
               <> v_total_required_unpaid_cents)
  ) THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prepared_bubble_contract_is_immutable',
                              'retryable', false);
  END IF;

  /* A prepare replay reads the frozen restart record; it never rewrites place
     rows after the header exists. */
  IF v_batch.tournament_id IS NOT NULL THEN
    SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2),
           count(*) FILTER (WHERE o.amount_paid + 0.005 < o.amount_owed),
           md5(COALESCE(jsonb_agg(jsonb_build_object(
             'place', o.place, 'user_id', o.user_id,
             'club_id', tp.club_id,
             'cents', round(o.amount_owed * 100)::bigint)
             ORDER BY o.place), '[]'::jsonb)::text)
      INTO v_actual_count, v_actual_total, v_open_count, v_actual_fingerprint
      FROM public.tournament_obligations o
      JOIN public.tournament_players tp
        ON tp.tournament_id = o.tournament_id
       AND tp.position = o.place AND tp.user_id = o.user_id
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';

    IF v_actual_count <> v_expected_count
       OR abs(v_actual_total - v_expected_total_cents / 100.0) > 0.005
       OR v_actual_fingerprint <> v_plan_fingerprint THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'prepared_batch_no_longer_matches_plan',
                                'paid', 0, 'retryable', false);
    END IF;
    IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN
      RETURN jsonb_build_object('ok', false,
                                'reason', 'prepared_batch_has_no_funding_proof',
                                'retryable', false);
    END IF;
    IF v_t.status = 'COMPLETED' THEN
      IF v_batch.settled_at IS NULL OR v_open_count <> 0
         OR (v_batch.bubble_contract_required
             AND v_bubble_paid + 0.005 < v_bubble_owed) THEN
        RETURN jsonb_build_object('ok', false,
                                  'reason', 'completed_event_has_no_exact_atomic_batch',
                                  'paid', 0, 'retryable', false);
      END IF;
      RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                                'places', v_expected_count, 'amount_owed', v_actual_total,
                                'bubble_obligation_id', v_bubble_obligation_id,
                                'paid', 0, 'already_completed', true,
                                'retryable', false);
    END IF;
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'places', v_expected_count,
                              'amount_owed', v_expected_total_cents / 100.0,
                              'plan_fingerprint', v_plan_fingerprint,
                              'bubble_obligation_id', v_bubble_obligation_id,
                              'record', 'tournament_obligations',
                              'already_prepared', true, 'retryable', false);
  ELSIF v_t.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'completed_event_has_no_exact_atomic_batch',
                              'paid', 0, 'retryable', false);
  END IF;

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
        FROM jsonb_array_elements(v_plan) p
       ORDER BY (p->>'place')::integer
    LOOP
      SELECT round(COALESCE(sum(tpo.amount), 0), 2)
        INTO v_seeded_paid
        FROM public.tournament_payouts tpo
       WHERE tpo.tournament_id = p_tournament_id
         AND tpo.position = r.place
         AND tpo.user_id = r.user_id
         AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   tpo.tournament_id, tpo.idempotency_key));

      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'place', r.place, r.user_id, r.cents / 100.0,
         v_seeded_paid, v_source,
         CASE WHEN v_seeded_paid + 0.005 >= r.cents / 100.0 THEN now() ELSE NULL END)
      ON CONFLICT (tournament_id, kind, place) WHERE place IS NOT NULL
      DO UPDATE SET
        user_id = CASE
                    WHEN public.tournament_obligations.amount_paid = 0
                      THEN EXCLUDED.user_id
                    ELSE public.tournament_obligations.user_id
                  END,
        amount_owed = EXCLUDED.amount_owed,
        amount_paid = EXCLUDED.amount_paid,
        source = v_source,
        updated_at = now(),
        settled_at = CASE
          WHEN EXCLUDED.amount_paid + 0.005 >= EXCLUDED.amount_owed
            THEN COALESCE(public.tournament_obligations.settled_at, now())
          ELSE NULL
        END;
    END LOOP;

    SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2),
           count(*) FILTER (WHERE o.amount_paid + 0.005 < o.amount_owed),
           md5(COALESCE(jsonb_agg(jsonb_build_object(
             'place', o.place, 'user_id', o.user_id,
             'club_id', tp.club_id,
             'cents', round(o.amount_owed * 100)::bigint)
             ORDER BY o.place), '[]'::jsonb)::text)
      INTO v_actual_count, v_actual_total, v_open_count, v_actual_fingerprint
      FROM public.tournament_obligations o
      JOIN public.tournament_players tp
        ON tp.tournament_id = o.tournament_id
       AND tp.position = o.place AND tp.user_id = o.user_id
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';

    IF v_actual_count <> v_expected_count
       OR abs(v_actual_total - v_expected_total_cents / 100.0) > 0.005
       OR v_actual_fingerprint <> v_plan_fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'the written obligation set does not match its frozen plan',
                            ERRCODE = '23514';
    END IF;

    INSERT INTO public.tournament_place_settlement_batches
      (tournament_id, mode, plan_fingerprint, place_count, amount_owed,
       escrow_required, escrow_available,
       bubble_contract_required, bubble_obligation_id, bubble_user_id,
       bubble_source, bubble_amount_owed, bubble_amount_paid_before, source)
    VALUES
      (p_tournament_id, 'structure', v_plan_fingerprint, v_expected_count,
       v_expected_total_cents / 100.0, v_total_required_unpaid_cents / 100.0,
       CASE WHEN v_total_required_unpaid_cents > 0 THEN v_escrow_balance ELSE 0 END,
       v_bubble_contract_required, v_bubble_obligation_id, v_bubble_user,
       v_bubble_source, v_bubble_owed, v_bubble_paid,
       v_source);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_write_failure = MESSAGE_TEXT,
                            v_write_state = RETURNED_SQLSTATE;
  END;

  IF v_write_failure IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'prepare_write_aborted',
                              'detail', v_write_failure, 'sqlstate', v_write_state,
                              'retryable', v_write_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                            'places', v_expected_count,
                            'amount_owed', v_expected_total_cents / 100.0,
                            'plan_fingerprint', v_plan_fingerprint,
                            'bubble_obligation_id', v_bubble_obligation_id,
                            'record', 'tournament_obligations',
                            'retryable', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.fn_prepare_tournament_place_obligations(uuid, text) IS
  'Freezes the complete published place structure into exact, committed obligations plus a completeness fingerprint. Moves no chips.';

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places_atomic(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine.atomicPlaceSettlement'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_t                   record;
  v_batch               public.tournament_place_settlement_batches%ROWTYPE;
  v_source              text := COALESCE(NULLIF(btrim(p_source), ''), 'engine.atomicPlaceSettlement');
  v_obligation_count    integer := 0;
  v_open_count          integer := 0;
  v_result_mismatches   integer := 0;
  v_extra_prize_count   integer := 0;
  v_unranked_count      integer := 0;
  v_distinct_positions integer := 0;
  v_player_count        integer := 0;
  v_min_position        integer := 0;
  v_max_position        integer := 0;
  v_winner_count        integer := 0;
  v_winner_place_one    integer := 0;
  v_nonterminal_count   integer := 0;
  v_missing_bust_time   integer := 0;
  v_canonical_mismatches integer := 0;
  v_payout_evidence_mismatches integer := 0;
  v_unexpected_payout_evidence integer := 0;
  v_bubble_user         uuid;
  v_bubble_holders      integer := 0;
  v_bubble_obligations  integer := 0;
  v_bubble_matching     integer := 0;
  v_bubble_owed         numeric := 0;
  v_bubble_paid         numeric := 0;
  v_bubble_evidence     numeric := 0;
  v_bubble_conflicts    integer := 0;
  v_bubble_evidence_exists boolean := false;
  v_bubble_required     boolean := false;
  v_bubble_contract_required boolean := false;
  v_bubble_invalid      boolean := false;
  v_bubble_obligation_id uuid;
  v_bubble_source       text;
  v_bubble_settled_at   timestamptz;
  v_obligation_total    numeric := 0;
  v_required_unpaid     numeric := 0;
  v_bubble_required_unpaid numeric := 0;
  v_total_required_unpaid numeric := 0;
  v_escrow_balance      numeric := 0;
  v_escrow_before       numeric := 0;
  v_escrow_after        numeric := 0;
  v_escrow_enforced     boolean := false;
  v_escrow_found        boolean := false;
  v_paid_this_call      numeric := 0;
  v_actual_fingerprint text;
  v_result              jsonb;
  v_after_paid          numeric;
  v_after_bubble_paid   numeric;
  v_failure             text;
  v_failure_state       text;
  r                     record;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'paid', 0, 'retryable', false);
  END IF;

  SELECT t.id, t.name, t.status, round(COALESCE(t.prize_pool, 0), 2) AS prize_pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guaranteed_prize,
         COALESCE(t.prize_pool_finalized, false) AS prize_pool_finalized,
         t.variant, t.tournament_type, t.satellite_target_id,
         COALESCE(t.bubble_protection, false) AS bubble_protection,
         round(COALESCE(t.buy_in_amount, 0), 2) AS buy_in_amount
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found',
                              'paid', 0, 'retryable', false);
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'satellite_has_its_own_settlement',
                              'paid', 0, 'retryable', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'final_table_deal_has_its_own_settlement',
                              'paid', 0, 'retryable', false);
  END IF;
  IF NOT v_t.prize_pool_finalized
     OR v_t.prize_pool + 0.005 < v_t.guaranteed_prize THEN
    RETURN jsonb_build_object('ok', false,
                              'reason', 'prize_pool_is_not_funded_and_finalized',
                              'prize_pool', v_t.prize_pool,
                              'guaranteed_prize', v_t.guaranteed_prize,
                              'prize_pool_finalized', v_t.prize_pool_finalized,
                              'paid', 0, 'retryable', false);
  END IF;

  SELECT * INTO v_batch
    FROM public.tournament_place_settlement_batches b
   WHERE b.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'place_plan_not_prepared',
                              'paid', 0, 'retryable', false);
  END IF;

  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2),
         count(*) FILTER (WHERE o.amount_paid + 0.005 < o.amount_owed),
         round(COALESCE(sum(GREATEST(o.amount_owed - o.amount_paid, 0)), 0), 2),
         md5(COALESCE(jsonb_agg(jsonb_build_object(
           'place', o.place, 'user_id', o.user_id,
           'club_id', tp.club_id,
           'cents', round(o.amount_owed * 100)::bigint)
           ORDER BY o.place), '[]'::jsonb)::text)
    INTO v_obligation_count, v_obligation_total, v_open_count,
         v_required_unpaid, v_actual_fingerprint
    FROM public.tournament_obligations o
    JOIN public.tournament_players tp
      ON tp.tournament_id = o.tournament_id
     AND tp.position = o.place AND tp.user_id = o.user_id
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place';

  SELECT count(*), count(*) FILTER (WHERE tp.position IS NULL),
         count(DISTINCT tp.position), COALESCE(min(tp.position), 0),
         COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL)
    INTO v_player_count, v_unranked_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  WITH eliminated AS (
    SELECT tp.id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.status = 'eliminated'
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM eliminated e
    JOIN public.tournament_players tp ON tp.id = e.id
   WHERE tp.position IS DISTINCT FROM e.canonical_position;

  SELECT count(*) INTO v_result_mismatches
    FROM public.tournament_obligations o
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id = o.tournament_id AND tp.position = o.place
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
     AND (tp.user_id IS NULL
          OR tp.user_id IS DISTINCT FROM o.user_id
          OR round(COALESCE(tp.prize, 0) * 100)::bigint
             <> round(o.amount_owed * 100)::bigint);

  SELECT count(*) INTO v_extra_prize_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
          AND o.place = tp.position AND o.user_id = tp.user_id
     );

  /* An obligation's paid marker is never authoritative by itself. It must
     equal the net, attributable payout ledger evidence for that exact
     tournament, place and player, and it may not exceed the entitlement. */
  SELECT count(*) INTO v_payout_evidence_mismatches
    FROM public.tournament_obligations o
    CROSS JOIN LATERAL (
      SELECT round(COALESCE(sum(p.amount), 0), 2) AS paid
        FROM public.tournament_payouts p
       WHERE p.tournament_id = o.tournament_id
         AND p.position = o.place
         AND p.user_id = o.user_id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   p.tournament_id, p.idempotency_key))
    ) evidence
   WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
     AND (o.amount_paid < -0.005
          OR o.amount_paid > o.amount_owed + 0.005
          OR abs(round(o.amount_paid, 2) - evidence.paid) > 0.005);

  /* Every non-zero place payout group must map back to the frozen obligation
     with the same recipient. This catches extra places and wrong recipients. */
  SELECT count(*) INTO v_unexpected_payout_evidence
    FROM (
      SELECT p.position, p.user_id
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   p.tournament_id, p.idempotency_key))
       GROUP BY p.position, p.user_id
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) evidence
   WHERE NOT EXISTS (
     SELECT 1 FROM public.tournament_obligations o
      WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
        AND o.place = evidence.position AND o.user_id = evidence.user_id
   );

  /* The batch names the only Bubble obligation this transaction may advance.
     Re-prove its current identity, frozen amount, recipient, source and exact
     ledger evidence before any money moves. */
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = p_tournament_id
              AND o.kind = 'bubble_protection'
         ) OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'bubble_protection'
            GROUP BY p.tournament_id
           HAVING abs(round(sum(p.amount), 2)) > 0.005
         )
    INTO v_bubble_evidence_exists;
  v_bubble_required := v_t.bubble_protection OR v_bubble_evidence_exists;
  v_bubble_contract_required := v_bubble_required
    AND v_batch.place_count > 0 AND v_player_count > v_batch.place_count;

  IF (v_bubble_evidence_exists OR v_bubble_contract_required)
     AND v_t.buy_in_amount <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_evidence_has_no_valid_contract',
      'paid', 0, 'buy_in_amount', v_t.buy_in_amount,
      'paid_places', v_batch.place_count, 'field_size', v_player_count,
      'retryable', false);
  END IF;
  IF v_bubble_evidence_exists AND NOT v_bubble_contract_required THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'bubble_protection_evidence_has_no_valid_contract',
      'paid', 0, 'buy_in_amount', v_t.buy_in_amount,
      'paid_places', v_batch.place_count, 'field_size', v_player_count,
      'retryable', false);
  END IF;

  IF v_batch.bubble_contract_required IS DISTINCT FROM v_bubble_contract_required THEN
    v_bubble_invalid := true;
  END IF;

  IF v_bubble_contract_required THEN
    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
      INTO v_bubble_holders, v_bubble_user
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_batch.place_count + 1;

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
        INTO v_bubble_obligation_id, v_bubble_source,
             v_bubble_owed, v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user
       FOR UPDATE;
    END IF;

    v_bubble_invalid := v_bubble_invalid
      OR v_bubble_holders <> 1 OR v_bubble_user IS NULL
      OR v_bubble_obligations <> 1 OR v_bubble_matching <> 1
      OR v_bubble_obligation_id IS DISTINCT FROM v_batch.bubble_obligation_id
      OR v_bubble_user IS DISTINCT FROM v_batch.bubble_user_id
      OR v_bubble_source IS DISTINCT FROM v_batch.bubble_source
      OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicPlaceSettlement')
      OR abs(v_bubble_owed - v_t.buy_in_amount) > 0.005
      OR abs(v_bubble_owed - v_batch.bubble_amount_owed) > 0.005
      OR v_bubble_paid < -0.005 OR v_bubble_paid > v_bubble_owed + 0.005
      OR v_bubble_paid + 0.005 < v_batch.bubble_amount_paid_before
      OR (v_t.status <> 'COMPLETED'
          AND abs(v_bubble_paid - v_batch.bubble_amount_paid_before) > 0.005)
      OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
      OR (v_bubble_paid + 0.005 >= v_bubble_owed
          AND v_bubble_settled_at IS NULL)
      OR (v_bubble_paid + 0.005 < v_bubble_owed
          AND v_bubble_settled_at IS NOT NULL)
      OR v_bubble_conflicts > 0;

    v_bubble_required_unpaid := round(GREATEST(v_bubble_owed - v_bubble_paid, 0), 2);
  ELSE
    v_bubble_invalid := v_bubble_invalid
      OR v_batch.bubble_obligation_id IS NOT NULL
      OR v_batch.bubble_user_id IS NOT NULL
      OR v_batch.bubble_source IS NOT NULL
      OR abs(v_batch.bubble_amount_owed) > 0.005
      OR abs(v_batch.bubble_amount_paid_before) > 0.005;
  END IF;

  v_total_required_unpaid := round(v_required_unpaid + v_bubble_required_unpaid, 2);

  IF v_batch.mode <> 'structure'
     OR v_obligation_count <> v_batch.place_count
     OR abs(v_obligation_total - v_batch.amount_owed) > 0.005
     OR abs(v_batch.amount_owed - v_t.prize_pool) > 0.005
     OR v_batch.escrow_available + 0.005 < v_batch.escrow_required
     OR v_actual_fingerprint <> v_batch.plan_fingerprint
     OR v_result_mismatches > 0
     OR v_extra_prize_count > 0
     OR v_payout_evidence_mismatches > 0
     OR v_unexpected_payout_evidence > 0
     OR v_player_count = 0 OR v_unranked_count > 0
     OR v_distinct_positions <> v_player_count
     OR v_min_position <> 1 OR v_max_position <> v_player_count
     OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0
     OR v_canonical_mismatches <> 0
     OR v_bubble_invalid
     OR (v_t.status <> 'COMPLETED'
         AND abs(v_batch.escrow_required - v_total_required_unpaid) > 0.005) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'prepared_place_plan_failed_validation', 'paid', 0,
      'places', v_obligation_count, 'expected_places', v_batch.place_count,
      'amount_owed', v_obligation_total, 'expected_amount', v_batch.amount_owed,
      'prize_pool', v_t.prize_pool, 'result_mismatches', v_result_mismatches,
      'extra_prize_rows', v_extra_prize_count,
      'payout_evidence_mismatches', v_payout_evidence_mismatches,
      'unexpected_payout_evidence', v_unexpected_payout_evidence,
      'unranked', v_unranked_count, 'min_position', v_min_position,
      'max_position', v_max_position, 'winners', v_winner_count,
      'winner_at_place_one', v_winner_place_one,
      'nonterminal_players', v_nonterminal_count,
      'eliminated_without_time', v_missing_bust_time,
      'canonical_position_mismatches', v_canonical_mismatches,
      'bubble_holders', v_bubble_holders,
      'bubble_obligations', v_bubble_obligations,
      'bubble_evidence_conflicts', v_bubble_conflicts, 'retryable', false);
  END IF;

  IF v_total_required_unpaid > 0.005 THEN
    SELECT e.enforced, round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_balance
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    v_escrow_found := FOUND;
    IF NOT v_escrow_found OR NOT v_escrow_enforced
       OR v_escrow_balance + 0.005 < v_total_required_unpaid THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'prize_escrow_is_not_funded', 'paid', 0,
        'required_unpaid', v_total_required_unpaid,
        'place_unpaid', v_required_unpaid,
        'bubble_unpaid', v_bubble_required_unpaid,
        'escrow_available', CASE WHEN v_escrow_found THEN v_escrow_balance ELSE NULL END,
        'escrow_enforced', CASE WHEN v_escrow_found THEN v_escrow_enforced ELSE NULL END,
        'retryable', false);
    END IF;
    v_escrow_before := v_escrow_balance;
  END IF;

  IF v_t.status = 'COMPLETED' THEN
    IF v_batch.settled_at IS NOT NULL AND v_open_count = 0
       AND (NOT v_batch.bubble_contract_required
            OR v_bubble_paid + 0.005 >= v_bubble_owed) THEN
      RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                                'paid', 0, 'places', v_obligation_count,
                                'bubble_obligation_id', v_bubble_obligation_id,
                                'already_completed', true, 'retryable', false);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'completed_batch_is_not_fully_settled',
                              'paid', 0, 'open_places', v_open_count,
                              'bubble_paid', v_bubble_paid,
                              'retryable', false);
  END IF;
  IF COALESCE(v_t.status, '') <> 'COMPLETING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_completing',
                              'status', v_t.status, 'paid', 0, 'retryable', false);
  END IF;

  BEGIN
    PERFORM set_config('app.atomic_tournament_place_batch', p_tournament_id::text, true);

    IF v_batch.bubble_contract_required AND v_bubble_required_unpaid > 0.005 THEN
      v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate(
        p_tournament_id, 'bubble_protection', NULL, v_batch.bubble_user_id,
        v_batch.bubble_amount_owed, v_batch.bubble_source,
        'Bubble protection: buy-in returned to the stone bubble', NULL
      );
      IF NOT COALESCE((v_result->>'ok')::boolean, false)
         OR NULLIF(v_result->>'obligation_id', '')::uuid
            IS DISTINCT FROM v_batch.bubble_obligation_id THEN
        RAISE EXCEPTION USING
          MESSAGE = format('Bubble Protection refused: %s',
                           COALESCE(v_result->>'refused_reason', 'wrong obligation')),
          ERRCODE = 'P0001';
      END IF;

      SELECT o.amount_paid, o.source, o.amount_owed, o.settled_at
        INTO v_after_bubble_paid, v_bubble_source, v_bubble_owed, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.id = v_batch.bubble_obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_batch.bubble_user_id;
      IF NOT FOUND
         OR v_bubble_source IS DISTINCT FROM v_batch.bubble_source
         OR abs(v_bubble_owed - v_batch.bubble_amount_owed) > 0.005
         OR v_after_bubble_paid + 0.005 < v_batch.bubble_amount_owed
         OR v_bubble_settled_at IS NULL THEN
        RAISE EXCEPTION USING
          MESSAGE = format('Bubble Protection only reached %s of %s',
                           COALESCE(v_after_bubble_paid, 0),
                           v_batch.bubble_amount_owed),
          ERRCODE = 'P0001';
      END IF;
      v_paid_this_call := v_paid_this_call
        + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
    END IF;

    FOR r IN
      SELECT o.id, o.place, o.user_id, o.amount_owed
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       ORDER BY o.place DESC
       FOR UPDATE
    LOOP
      v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate(
        p_tournament_id, 'place', r.place, r.user_id, r.amount_owed,
        v_source, 'Tournament prize: position ' || r.place::text, NULL
      );
      IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
        RAISE EXCEPTION USING
          MESSAGE = format('place %s refused: %s', r.place,
                           COALESCE(v_result->>'refused_reason', 'unknown')),
          ERRCODE = 'P0001';
      END IF;

      SELECT o.amount_paid INTO v_after_paid
        FROM public.tournament_obligations o WHERE o.id = r.id;
      IF v_after_paid + 0.005 < r.amount_owed THEN
        RAISE EXCEPTION USING
          MESSAGE = format('place %s only reached %s of %s', r.place,
                           v_after_paid, r.amount_owed),
          ERRCODE = 'P0001';
      END IF;
      v_paid_this_call := v_paid_this_call
        + round(COALESCE((v_result->>'paid')::numeric, 0), 2);
    END LOOP;

    SELECT count(*) INTO v_open_count
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND o.amount_paid + 0.005 < o.amount_owed;
    IF v_open_count > 0 THEN
      RAISE EXCEPTION USING
        MESSAGE = format('%s place obligation(s) remain open', v_open_count),
        ERRCODE = 'P0001';
    END IF;

    IF v_batch.bubble_contract_required THEN
      SELECT o.amount_paid, o.source, o.amount_owed, o.settled_at
        INTO v_bubble_paid, v_bubble_source, v_bubble_owed, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.id = v_batch.bubble_obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_batch.bubble_user_id;
      IF NOT FOUND
         OR v_bubble_source IS DISTINCT FROM v_batch.bubble_source
         OR abs(v_bubble_owed - v_batch.bubble_amount_owed) > 0.005
         OR v_bubble_paid + 0.005 < v_bubble_owed
         OR v_bubble_settled_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'Bubble Protection remains open after settlement',
                              ERRCODE = 'P0001';
      END IF;

      SELECT round(COALESCE(sum(p.amount), 0), 2)
        INTO v_bubble_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.user_id = v_batch.bubble_user_id
         AND p.position IS NULL AND p.source = 'bubble_protection';
      IF abs(v_bubble_paid - v_bubble_evidence) > 0.005 THEN
        RAISE EXCEPTION USING
          MESSAGE = 'Bubble Protection payout evidence does not equal its paid obligation',
          ERRCODE = '23514';
      END IF;
    END IF;

    /* A wallet credit is not a complete transfer unless the same transaction
       also consumes the prize liability. Prove the exact escrow delta rather
       than trusting the child response or merely checking for non-negativity;
       a missing/disabled escrow trigger would otherwise leave reusable phantom
       funds behind after paying every wallet. */
    IF v_total_required_unpaid > 0.005 THEN
      SELECT round(COALESCE(e.prize_balance, 0), 2)
        INTO v_escrow_after
        FROM public.tournament_escrow e
       WHERE e.tournament_id = p_tournament_id AND e.enforced
       FOR UPDATE;
      IF NOT FOUND
         OR round((v_escrow_before - v_escrow_after) * 100)::bigint
            <> round(v_total_required_unpaid * 100)::bigint
         OR round(v_paid_this_call * 100)::bigint
            <> round(v_total_required_unpaid * 100)::bigint THEN
        RAISE EXCEPTION USING
          MESSAGE = format(
            'prize escrow moved %s and child calls reported %s; exact required payout was %s',
            round(v_escrow_before - v_escrow_after, 2), v_paid_this_call,
            v_total_required_unpaid),
          ERRCODE = '23514';
      END IF;
    END IF;

    /* Re-prove the ledger after the final child call. This rejects an RPC
       response that claims success without writing the exact payout evidence,
       or one that writes evidence for a different place or recipient. */
    SELECT count(*) INTO v_payout_evidence_mismatches
      FROM public.tournament_obligations o
      CROSS JOIN LATERAL (
        SELECT round(COALESCE(sum(p.amount), 0), 2) AS paid
          FROM public.tournament_payouts p
         WHERE p.tournament_id = o.tournament_id
           AND p.position = o.place
           AND p.user_id = o.user_id
           AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
                OR public.fn_tournament_payout_key_is_place_evidence(
                     p.tournament_id, p.idempotency_key))
      ) evidence
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.amount_paid < -0.005
            OR o.amount_paid > o.amount_owed + 0.005
            OR abs(round(o.amount_paid, 2) - evidence.paid) > 0.005);

    SELECT count(*) INTO v_unexpected_payout_evidence
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                             'late_reg_adjustment', 'clawback', 'spin_backpay',
                             'overlay_backpay')
                OR public.fn_tournament_payout_key_is_place_evidence(
                     p.tournament_id, p.idempotency_key))
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) evidence
     WHERE NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
          AND o.place = evidence.position AND o.user_id = evidence.user_id
     );
    IF v_payout_evidence_mismatches > 0 OR v_unexpected_payout_evidence > 0 THEN
      RAISE EXCEPTION USING
        MESSAGE = format(
          'post-settlement payout evidence mismatch: obligations %s, unexpected groups %s',
          v_payout_evidence_mismatches, v_unexpected_payout_evidence),
        ERRCODE = '23514';
    END IF;

    /* The trigger gate is needed only while the child RPC advances frozen
       place rows. Clear it before touching the batch header or tournament and
       again after the subtransaction so the caller can never inherit it. */
    PERFORM set_config('app.atomic_tournament_place_batch', '', true);

    UPDATE public.tournament_place_settlement_batches
       SET settled_at = COALESCE(settled_at, now()), source = v_source
     WHERE tournament_id = p_tournament_id
       AND plan_fingerprint = v_actual_fingerprint
       AND bubble_contract_required = v_bubble_contract_required
       AND bubble_obligation_id IS NOT DISTINCT FROM v_bubble_obligation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'the prepared batch changed before settlement',
                            ERRCODE = '40001';
    END IF;

    UPDATE public.tournaments
       SET status = 'COMPLETED',
           ended_at = COALESCE(ended_at, clock_timestamp()),
           on_break = false,
           break_ends_at = NULL
     WHERE id = p_tournament_id AND status = 'COMPLETING';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'COMPLETING claim was lost before completion',
                            ERRCODE = '40001';
    END IF;

    /* Durable completion includes the physical tables. The tournament status
       transition above releases live seats through its database triggers; the
       close below is kept in this same exception subtransaction so a table
       trigger or constraint failure rolls every prize and COMPLETED back. */
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
        MESSAGE = 'completed tournament retained a nonterminal table or live seat',
        ERRCODE = '23514';
    END IF;

    SELECT count(*) INTO v_result_mismatches
      FROM public.tournament_obligations o
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = o.tournament_id AND tp.position = o.place
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (tp.user_id IS NULL
            OR tp.user_id IS DISTINCT FROM o.user_id
            OR round(COALESCE(tp.prize, 0) * 100)::bigint
               <> round(o.amount_owed * 100)::bigint);

    SELECT count(*) INTO v_extra_prize_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_obligations o
          WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
            AND o.place = tp.position AND o.user_id = tp.user_id
       );
    IF v_result_mismatches > 0 OR v_extra_prize_count > 0 THEN
      RAISE EXCEPTION USING MESSAGE = 'completion trigger changed the frozen place plan',
                            ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  PERFORM set_config('app.atomic_tournament_place_batch', '', true);

  IF v_failure IS NOT NULL THEN
    BEGIN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_settle_tournament_places_atomic',
        format('Atomic place settlement aborted for %s: %s',
               COALESCE(v_t.name, p_tournament_id::text), v_failure),
        jsonb_build_object('tournament_id', p_tournament_id,
                           'sqlstate', v_failure_state, 'reason', v_failure,
                           'places', v_obligation_count,
                           'amount_owed', v_obligation_total,
                           'open_obligations', v_open_count,
                           'bubble_obligation_id', v_bubble_obligation_id,
                           'source', v_source),
        'atomic-place-settle:' || p_tournament_id::text
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'atomic_settlement_aborted',
      'detail', v_failure, 'sqlstate', v_failure_state, 'paid', 0,
      'places', v_obligation_count,
      'bubble_obligation_id', v_bubble_obligation_id,
      'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                            'paid', round(v_paid_this_call, 2),
                            'places', v_obligation_count,
                            'bubble_obligation_id', v_bubble_obligation_id,
                            'completed', true, 'retryable', false,
                            'record', 'tournament_obligations');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_places_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places_atomic(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.fn_settle_tournament_places_atomic(uuid, text) IS
  'Pays the fingerprinted tournament place batch plus its exact frozen Bubble Protection obligation and flips COMPLETING to COMPLETED in one transaction. A refused, partial or failed leg rolls every payment back.';

/* Completion is not merely a gate into one terminal value. Once the atomic
   restart record exists, no independent writer may move the tournament out of
   the state from which that record can be resumed. Once a normal tournament is
   COMPLETED, its paid result is terminal even if a legacy row predates the new
   batch table. The only status change permitted with a prepared batch is the
   settler's fully-paid COMPLETING -> COMPLETED transition; the separate
   completion guard below re-proves that batch before accepting it. */
CREATE OR REPLACE FUNCTION public.trg_lock_atomic_place_tournament_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_settled_at timestamptz;
  v_has_batch boolean := false;
BEGIN
  IF lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION
      'completed normal tournament % is terminal and cannot return to %',
      OLD.id, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  SELECT b.settled_at INTO v_settled_at
    FROM public.tournament_place_settlement_batches b
   WHERE b.tournament_id = OLD.id;
  v_has_batch := FOUND;

  IF v_has_batch
     AND (v_settled_at IS NULL
          OR OLD.status IS DISTINCT FROM 'COMPLETING'
          OR NEW.status IS DISTINCT FROM 'COMPLETED') THEN
    RAISE EXCEPTION
      'tournament % has an atomic place batch; status may only advance from COMPLETING to COMPLETED after full settlement',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_lock_atomic_place_tournament_status()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zzzy_lock_atomic_place_tournament_status
  ON public.tournaments;
CREATE TRIGGER zzzy_lock_atomic_place_tournament_status
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM OLD.status)
EXECUTE FUNCTION public.trg_lock_atomic_place_tournament_status();

COMMENT ON FUNCTION public.trg_lock_atomic_place_tournament_status() IS
  'Makes normal COMPLETED terminal and prevents a prepared atomic place batch from being stranded by an out-of-band status transition.';

CREATE OR REPLACE FUNCTION public.trg_tournament_atomic_place_completion_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_batch                       public.tournament_place_settlement_batches%ROWTYPE;
  v_count                       integer := 0;
  v_open                        integer := 0;
  v_mismatches                  integer := 0;
  v_extra_prizes                integer := 0;
  v_player_count                integer := 0;
  v_unranked_count              integer := 0;
  v_distinct_positions          integer := 0;
  v_min_position                integer := 0;
  v_max_position                integer := 0;
  v_winner_count                integer := 0;
  v_winner_place_one            integer := 0;
  v_nonterminal_count           integer := 0;
  v_missing_bust_time           integer := 0;
  v_canonical_mismatches        integer := 0;
  v_payout_evidence_mismatches  integer := 0;
  v_unexpected_payout_evidence  integer := 0;
  v_bubble_user                 uuid;
  v_bubble_holders              integer := 0;
  v_bubble_obligations          integer := 0;
  v_bubble_matching             integer := 0;
  v_bubble_owed                 numeric := 0;
  v_bubble_paid                 numeric := 0;
  v_bubble_evidence             numeric := 0;
  v_bubble_conflicts            integer := 0;
  v_bubble_evidence_exists      boolean := false;
  v_bubble_required             boolean := false;
  v_bubble_contract_required    boolean := false;
  v_bubble_invalid              boolean := false;
  v_bubble_obligation_id        uuid;
  v_bubble_source               text;
  v_bubble_settled_at           timestamptz;
  v_total                       numeric := 0;
  v_escrow_balance              numeric := 0;
  v_escrow_enforced             boolean := false;
  v_escrow_found                boolean := false;
  v_fingerprint                 text;
  v_ftd_check                   jsonb;
BEGIN
  IF lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  /* During rollout the atomic deal migration lands after this normal-place
     migration. A single forged deal marker must not become a completion bypass
     in that interval. Only the later deal verifier can exempt the event, and
     its full batch/ledger/result proof must pass. Dynamic SQL keeps this
     migration installable before that function exists. */
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = NEW.id AND p.source = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = NEW.id AND o.kind = 'final_table_deal') THEN
    IF to_regprocedure('public.fn_check_atomic_final_table_deal(uuid)') IS NULL THEN
      RAISE EXCEPTION
        'final-table deal tournament % cannot complete before its atomic verifier is installed', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    EXECUTE 'SELECT public.fn_check_atomic_final_table_deal($1)'
       INTO v_ftd_check USING NEW.id;
    IF NOT COALESCE((v_ftd_check->>'ok')::boolean, false) THEN
      RAISE EXCEPTION
        'final-table deal tournament % failed atomic verification: %',
        NEW.id, COALESCE(v_ftd_check->>'reason', 'unknown')
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT COALESCE(NEW.prize_pool_finalized, false)
     OR round(COALESCE(NEW.prize_pool, 0), 2) + 0.005
        < round(COALESCE(NEW.guaranteed_prize, 0), 2) THEN
    RAISE EXCEPTION
      'normal tournament % cannot complete before its prize pool is funded and finalized', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_batch
    FROM public.tournament_place_settlement_batches b
   WHERE b.tournament_id = NEW.id;
  IF NOT FOUND OR v_batch.mode <> 'structure' OR v_batch.settled_at IS NULL THEN
    RAISE EXCEPTION 'normal tournament % cannot complete without a settled atomic place batch', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_batch.escrow_available + 0.005 < v_batch.escrow_required THEN
    RAISE EXCEPTION 'normal tournament % cannot complete without immutable escrow funding proof', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_batch.escrow_required > 0.005 THEN
    SELECT e.enforced, round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_balance
      FROM public.tournament_escrow e
     WHERE e.tournament_id = NEW.id
     FOR UPDATE;
    v_escrow_found := FOUND;
    IF NOT v_escrow_found OR NOT v_escrow_enforced OR v_escrow_balance < -0.005 THEN
      RAISE EXCEPTION
        'normal tournament % cannot complete without a live non-negative enforced prize escrow', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(o.amount_owed), 0), 2),
         count(*) FILTER (WHERE o.amount_paid + 0.005 < o.amount_owed),
         md5(COALESCE(jsonb_agg(jsonb_build_object(
           'place', o.place, 'user_id', o.user_id,
           'club_id', tp.club_id,
           'cents', round(o.amount_owed * 100)::bigint)
           ORDER BY o.place), '[]'::jsonb)::text)
    INTO v_count, v_total, v_open, v_fingerprint
    FROM public.tournament_obligations o
    JOIN public.tournament_players tp
      ON tp.tournament_id = o.tournament_id
     AND tp.position = o.place AND tp.user_id = o.user_id
   WHERE o.tournament_id = NEW.id AND o.kind = 'place';

  SELECT count(*) INTO v_mismatches
    FROM public.tournament_obligations o
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id = o.tournament_id AND tp.position = o.place
   WHERE o.tournament_id = NEW.id AND o.kind = 'place'
     AND (tp.user_id IS NULL
          OR tp.user_id IS DISTINCT FROM o.user_id
          OR round(COALESCE(tp.prize, 0) * 100)::bigint
             <> round(o.amount_owed * 100)::bigint);

  SELECT count(*) INTO v_extra_prizes
    FROM public.tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND round(COALESCE(tp.prize, 0) * 100)::bigint > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = tp.tournament_id AND o.kind = 'place'
          AND o.place = tp.position AND o.user_id = tp.user_id
     );

  SELECT count(*), count(*) FILTER (WHERE tp.position IS NULL),
         count(DISTINCT tp.position), COALESCE(min(tp.position), 0),
         COALESCE(max(tp.position), 0),
         count(*) FILTER (WHERE tp.status = 'winner'),
         count(*) FILTER (WHERE tp.status = 'winner' AND tp.position = 1),
         count(*) FILTER (WHERE tp.status NOT IN ('winner', 'eliminated')),
         count(*) FILTER (WHERE tp.status = 'eliminated' AND tp.eliminated_at IS NULL)
    INTO v_player_count, v_unranked_count, v_distinct_positions,
         v_min_position, v_max_position, v_winner_count,
         v_winner_place_one, v_nonterminal_count, v_missing_bust_time
    FROM public.tournament_players tp
   WHERE tp.tournament_id = NEW.id;

  WITH eliminated AS (
    SELECT tp.id,
           v_player_count - (row_number() OVER (
             ORDER BY tp.eliminated_at ASC, tp.id ASC
           ))::integer + 1 AS canonical_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.id AND tp.status = 'eliminated'
  )
  SELECT count(*) INTO v_canonical_mismatches
    FROM eliminated e
    JOIN public.tournament_players tp ON tp.id = e.id
   WHERE tp.position IS DISTINCT FROM e.canonical_position;

  SELECT count(*) INTO v_payout_evidence_mismatches
    FROM public.tournament_obligations o
    CROSS JOIN LATERAL (
      SELECT round(COALESCE(sum(p.amount), 0), 2) AS paid
        FROM public.tournament_payouts p
       WHERE p.tournament_id = o.tournament_id
         AND p.position = o.place
         AND p.user_id = o.user_id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   p.tournament_id, p.idempotency_key))
    ) evidence
   WHERE o.tournament_id = NEW.id AND o.kind = 'place'
     AND (o.amount_paid < -0.005
          OR o.amount_paid > o.amount_owed + 0.005
          OR abs(round(o.amount_paid, 2) - evidence.paid) > 0.005);

  SELECT count(*) INTO v_unexpected_payout_evidence
    FROM (
      SELECT p.position, p.user_id
        FROM public.tournament_payouts p
       WHERE p.tournament_id = NEW.id
         AND (p.source IN ('structure', 'reconcile', 'hu_shortfall',
                           'late_reg_adjustment', 'clawback', 'spin_backpay',
                           'overlay_backpay')
              OR public.fn_tournament_payout_key_is_place_evidence(
                   p.tournament_id, p.idempotency_key))
       GROUP BY p.position, p.user_id
      HAVING abs(round(sum(p.amount), 2)) > 0.005
    ) evidence
   WHERE NOT EXISTS (
     SELECT 1 FROM public.tournament_obligations o
      WHERE o.tournament_id = NEW.id AND o.kind = 'place'
        AND o.place = evidence.position AND o.user_id = evidence.user_id
   );

  SELECT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.tournament_id = NEW.id
              AND o.kind = 'bubble_protection'
         ) OR EXISTS (
           SELECT 1
             FROM public.tournament_payouts p
            WHERE p.tournament_id = NEW.id
              AND p.source = 'bubble_protection'
            GROUP BY p.tournament_id
           HAVING abs(round(sum(p.amount), 2)) > 0.005
         )
    INTO v_bubble_evidence_exists;
  v_bubble_required := COALESCE(NEW.bubble_protection, false)
                       OR v_bubble_evidence_exists;
  v_bubble_contract_required := v_bubble_required
    AND v_batch.place_count > 0 AND v_player_count > v_batch.place_count;

  IF (v_bubble_evidence_exists OR v_bubble_contract_required)
     AND round(COALESCE(NEW.buy_in_amount, 0), 2) <= 0 THEN
    RAISE EXCEPTION
      'normal tournament % has Bubble Protection evidence with no valid published contract', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_bubble_evidence_exists AND NOT v_bubble_contract_required THEN
    RAISE EXCEPTION
      'normal tournament % has Bubble Protection evidence with no valid published contract', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_batch.bubble_contract_required IS DISTINCT FROM v_bubble_contract_required THEN
    v_bubble_invalid := true;
  END IF;

  IF v_bubble_contract_required THEN
    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.id))[1]
      INTO v_bubble_holders, v_bubble_user
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.id
       AND tp.position = v_batch.place_count + 1;

    SELECT count(*),
           count(*) FILTER (WHERE o.user_id = v_bubble_user AND o.place IS NULL),
           COALESCE(max(o.amount_owed) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0),
           COALESCE(max(o.amount_paid) FILTER (
             WHERE o.user_id = v_bubble_user AND o.place IS NULL), 0)
      INTO v_bubble_obligations, v_bubble_matching, v_bubble_owed, v_bubble_paid
      FROM public.tournament_obligations o
     WHERE o.tournament_id = NEW.id AND o.kind = 'bubble_protection';

    SELECT round(COALESCE(sum(p.amount), 0), 2)
      INTO v_bubble_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = NEW.id
       AND p.user_id = v_bubble_user AND p.position IS NULL
       AND p.source = 'bubble_protection';

    SELECT count(*) INTO v_bubble_conflicts
      FROM (
        SELECT p.position, p.user_id
          FROM public.tournament_payouts p
         WHERE p.tournament_id = NEW.id
           AND p.source = 'bubble_protection'
           AND (p.position IS NOT NULL OR p.user_id IS DISTINCT FROM v_bubble_user)
         GROUP BY p.position, p.user_id
        HAVING abs(round(sum(p.amount), 2)) > 0.005
      ) unexpected_bubble;

    IF v_bubble_obligations = 1 AND v_bubble_matching = 1 THEN
      SELECT o.id, o.source, o.amount_owed, o.amount_paid, o.settled_at
        INTO v_bubble_obligation_id, v_bubble_source,
             v_bubble_owed, v_bubble_paid, v_bubble_settled_at
        FROM public.tournament_obligations o
       WHERE o.tournament_id = NEW.id AND o.kind = 'bubble_protection'
         AND o.place IS NULL AND o.user_id = v_bubble_user
       FOR UPDATE;
    END IF;

    v_bubble_invalid := v_bubble_invalid
      OR v_bubble_holders <> 1 OR v_bubble_user IS NULL
      OR v_bubble_obligations <> 1 OR v_bubble_matching <> 1
      OR v_bubble_obligation_id IS DISTINCT FROM v_batch.bubble_obligation_id
      OR v_bubble_user IS DISTINCT FROM v_batch.bubble_user_id
      OR v_bubble_source IS DISTINCT FROM v_batch.bubble_source
      OR COALESCE(v_bubble_source, '') NOT IN ('engine.eliminatePlayer', 'engine.atomicPlaceSettlement')
      OR abs(v_bubble_owed - round(COALESCE(NEW.buy_in_amount, 0), 2)) > 0.005
      OR abs(v_bubble_owed - v_batch.bubble_amount_owed) > 0.005
      OR v_bubble_paid + 0.005 < v_bubble_owed
      OR v_bubble_paid + 0.005 < v_batch.bubble_amount_paid_before
      OR abs(v_bubble_paid - v_bubble_evidence) > 0.005
      OR v_bubble_settled_at IS NULL
      OR v_bubble_conflicts > 0;
  ELSE
    v_bubble_invalid := v_bubble_invalid
      OR v_batch.bubble_obligation_id IS NOT NULL
      OR v_batch.bubble_user_id IS NOT NULL
      OR v_batch.bubble_source IS NOT NULL
      OR abs(v_batch.bubble_amount_owed) > 0.005
      OR abs(v_batch.bubble_amount_paid_before) > 0.005;
  END IF;

  IF v_count <> v_batch.place_count OR v_open <> 0
     OR abs(v_total - v_batch.amount_owed) > 0.005
     OR abs(v_batch.amount_owed - round(COALESCE(NEW.prize_pool, 0), 2)) > 0.005
     OR v_fingerprint <> v_batch.plan_fingerprint OR v_mismatches > 0
     OR v_extra_prizes > 0
     OR v_player_count = 0 OR v_unranked_count > 0
     OR v_distinct_positions <> v_player_count
     OR v_min_position <> 1 OR v_max_position <> v_player_count
     OR v_winner_count <> 1 OR v_winner_place_one <> 1
     OR v_nonterminal_count <> 0 OR v_missing_bust_time <> 0
     OR v_canonical_mismatches <> 0
     OR v_payout_evidence_mismatches > 0
     OR v_unexpected_payout_evidence > 0
     OR v_bubble_invalid THEN
    RAISE EXCEPTION
      'normal tournament % cannot complete: batch count %, open %, total %, result mismatches %, extra prize rows %, players %, unranked %, rank range %..%, winners %, winner at place one %, nonterminal %, payout mismatches %, unexpected payout groups %, bubble obligations %, bubble conflicts %',
      NEW.id, v_count, v_open, v_total, v_mismatches, v_extra_prizes,
      v_player_count, v_unranked_count, v_min_position, v_max_position,
      v_winner_count, v_winner_place_one, v_nonterminal_count,
      v_payout_evidence_mismatches, v_unexpected_payout_evidence,
      v_bubble_obligations, v_bubble_conflicts
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_tournament_atomic_place_completion_guard()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zzzz_tournaments_atomic_place_completion_guard
  ON public.tournaments;
CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard
BEFORE UPDATE ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.trg_tournament_atomic_place_completion_guard();

COMMENT ON FUNCTION public.trg_tournament_atomic_place_completion_guard() IS
  'Final database gate: a normal tournament reaches COMPLETED only with the exact fingerprinted place batch and its frozen Bubble Protection obligation fully paid.';

/* An UPDATE-only completion guard still permits a caller to manufacture a new
   normal tournament already marked COMPLETED. Its batch cannot legitimately
   pre-exist because the batch has a foreign key to this parent row, so reject
   that shape outright. Satellites retain their separate settlement law until
   the satellite-conservation work item lands. */
CREATE OR REPLACE FUNCTION public.trg_refuse_normal_tournament_completed_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR upper(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'normal tournament % cannot be inserted already completed; use the atomic settlement transition',
    NEW.id USING ERRCODE = 'check_violation';
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_refuse_normal_tournament_completed_insert()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zzzz_refuse_normal_tournament_completed_insert
  ON public.tournaments;
CREATE TRIGGER zzzz_refuse_normal_tournament_completed_insert
BEFORE INSERT ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED')
EXECUTE FUNCTION public.trg_refuse_normal_tournament_completed_insert();

COMMENT ON FUNCTION public.trg_refuse_normal_tournament_completed_insert() IS
  'Rejects a newly forged normal COMPLETED tournament. Normal completion is an UPDATE performed inside the fully paid atomic place or final-table-deal transaction.';

/* The historical guarantee RPC inferred success from two weak signals: a
   boolean finalized flag, or an ON CONFLICT against an overlay row. Neither
   proves the advertised floor, the bank debit, the explicit journal leg, or
   the live escrow credit. Preserve its audited bank-selection/debit core under
   a private name and make the public door prove the whole transaction. */
DO $wrap_guarantee$
BEGIN
  IF to_regprocedure('public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)')
     IS NULL THEN
    IF to_regprocedure('public.fn_apply_prize_guarantee(uuid,text)') IS NULL THEN
      RAISE EXCEPTION 'fn_apply_prize_guarantee missing';
    END IF;
    ALTER FUNCTION public.fn_apply_prize_guarantee(uuid, text)
      RENAME TO fn_apply_prize_guarantee_before_atomic_proof;
  END IF;
END;
$wrap_guarantee$;

REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee_before_atomic_proof(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t                    record;
  v_after                record;
  v_overlay_row          public.tournament_guarantee_overlays%ROWTYPE;
  v_result               jsonb;
  v_pool_before          numeric := 0;
  v_guarantee            numeric := 0;
  v_final                numeric := 0;
  v_overlay              numeric := 0;
  v_escrow_before        numeric := 0;
  v_escrow_after         numeric := 0;
  v_escrow_before_found  boolean := false;
  v_escrow_after_found   boolean := false;
  v_escrow_enforced      boolean := false;
  v_union                uuid;
  v_expected_bank_type   text;
  v_expected_bank_entity uuid;
  v_club_bank_before     numeric := 0;
  v_bank_before          numeric := 0;
  v_bank_after           numeric := 0;
  v_bank_row_found       boolean := false;
  v_ledger_inserted      integer := 0;
  v_old_category         text;
  v_old_counterparty     text;
  v_old_entity           text;
  v_old_tournament       text;
  v_failure              text;
  v_failure_state        text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.id, t.club_id, t.name, t.status,
         round(COALESCE(t.prize_pool, 0), 2) AS pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guarantee,
         COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
                              'retryable', false);
  END IF;

  v_pool_before := v_t.pool;
  v_guarantee := v_t.guarantee;
  v_final := GREATEST(v_pool_before, v_guarantee);
  v_overlay := round(v_final - v_pool_before, 2);

  /* Finalized is irreversible. A published pool that was finalized below its
     guarantee is evidence requiring an explicit, reviewed correction; the
     runtime must never reopen and silently reprice it. */
  IF v_t.finalized AND v_pool_before + 0.005 < v_guarantee THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'finalized_guarantee_is_below_published_floor',
      'prize_pool', v_pool_before, 'guaranteed_prize', v_guarantee,
      'retryable', false);
  END IF;

  SELECT round(COALESCE(e.prize_balance, 0), 2)
    INTO v_escrow_before
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  v_escrow_before_found := FOUND;

  BEGIN
    IF v_overlay > 0 THEN
      /* Lock and snapshot the real bank before calling the legacy debit core.
         Its overlay row describes the movement; only the live before/after
         balance proves that movement happened exactly once. */
      SELECT c.union_id, round(COALESCE(c.chip_treasury, 0), 2)
        INTO v_union, v_club_bank_before
        FROM public.clubs c
       WHERE c.id = v_t.club_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee host club does not exist',
                              ERRCODE = '23503';
      END IF;

      IF v_union IS NOT NULL THEN
        SELECT round(COALESCE(uw.chip_balance, 0), 2)
          INTO v_bank_before
          FROM public.union_wallets uw
         WHERE uw.union_id = v_union
         FOR UPDATE;
        v_bank_row_found := FOUND;
      END IF;
      IF v_bank_row_found THEN
        v_expected_bank_type := 'union';
        v_expected_bank_entity := v_union;
      ELSE
        v_expected_bank_type := 'club';
        v_expected_bank_entity := v_t.club_id;
        v_bank_before := v_club_bank_before;
      END IF;
      IF v_bank_before + 0.005 < v_overlay THEN
        RAISE EXCEPTION USING
          MESSAGE = format(
            'guarantee bank holds %s but the advertised overlay requires %s',
            v_bank_before, v_overlay),
          ERRCODE = '23514';
      END IF;
    END IF;

    v_old_category := current_setting('app.ledger_category', true);
    v_old_counterparty := current_setting('app.ledger_counterparty', true);
    v_old_entity := current_setting('app.ledger_counterparty_entity', true);
    v_old_tournament := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);

    v_result := public.fn_apply_prize_guarantee_before_atomic_proof(
      p_tournament_id, COALESCE(NULLIF(btrim(p_source), ''), 'engine'));
    IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
      RAISE EXCEPTION USING MESSAGE = COALESCE(v_result->>'reason', 'guarantee core refused'),
                            ERRCODE = '23514';
    END IF;
    IF v_overlay > 0 AND COALESCE((v_result->>'already_funded')::boolean, false) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'an existing overlay claim did not prove this short pool was funded',
        ERRCODE = '23514';
    END IF;

    IF v_overlay > 0 THEN
      SELECT * INTO v_overlay_row
        FROM public.tournament_guarantee_overlays o
       WHERE o.tournament_id = p_tournament_id
       FOR UPDATE;
      IF NOT FOUND
         OR v_overlay_row.club_id IS DISTINCT FROM v_t.club_id
         OR abs(round(v_overlay_row.amount, 2) - v_overlay) > 0.005
         OR abs(round(v_overlay_row.pool_before, 2) - v_pool_before) > 0.005
         OR abs(round(v_overlay_row.pool_after, 2) - v_final) > 0.005
         OR v_overlay_row.bank_type IS DISTINCT FROM v_expected_bank_type
         OR v_overlay_row.bank_entity_id IS DISTINCT FROM v_expected_bank_entity
         OR v_overlay_row.treasury_after IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee overlay claim does not match its bank debit and pool',
                              ERRCODE = '23514';
      END IF;

      IF v_expected_bank_type = 'union' THEN
        SELECT round(COALESCE(uw.chip_balance, 0), 2)
          INTO v_bank_after
          FROM public.union_wallets uw
         WHERE uw.union_id = v_expected_bank_entity
         FOR UPDATE;
      ELSE
        SELECT round(COALESCE(c.chip_treasury, 0), 2)
          INTO v_bank_after
          FROM public.clubs c
         WHERE c.id = v_expected_bank_entity
         FOR UPDATE;
      END IF;
      IF NOT FOUND
         OR abs(v_bank_after - (v_bank_before - v_overlay)) > 0.005
         OR abs(round(v_overlay_row.treasury_after, 2) - v_bank_after) > 0.005 THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee bank did not debit the exact overlay',
                              ERRCODE = '23514';
      END IF;

      /* The legacy core's balance UPDATE produces an auto-ledger twin. Live
         escrow deliberately ignores auto-ledger overlay rows, so publish the
         one explicit, deterministic bank -> prize-liability leg it requires.
         This insert is in the same subtransaction as the bank debit. */
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, idempotency_key, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        CASE WHEN v_expected_bank_type = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
        v_expected_bank_entity, 'prize_liability', p_tournament_id,
        v_overlay, 'overlay', v_t.club_id, p_tournament_id,
        'tourney:' || p_tournament_id::text || ':guarantee_overlay',
        'Guarantee Overlay Funded For ' || COALESCE(v_t.name, p_tournament_id::text))
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
      GET DIAGNOSTICS v_ledger_inserted = ROW_COUNT;
      IF v_ledger_inserted <> 1 THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee overlay journal key already exists unexpectedly',
                              ERRCODE = '23505';
      END IF;
    END IF;

    SELECT t.status, round(COALESCE(t.prize_pool, 0), 2) AS pool,
           round(COALESCE(t.guaranteed_prize, 0), 2) AS guarantee,
           COALESCE(t.prize_pool_finalized, false) AS finalized
      INTO v_after
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND OR NOT v_after.finalized
       OR abs(v_after.pool - v_final) > 0.005
       OR v_after.pool + 0.005 < v_after.guarantee THEN
      RAISE EXCEPTION USING MESSAGE = 'guarantee core did not publish the exact funded final pool',
                            ERRCODE = '23514';
    END IF;

    SELECT COALESCE(e.enforced, false), round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    v_escrow_after_found := FOUND;
    IF v_overlay > 0 AND (
         NOT v_escrow_after_found OR NOT v_escrow_enforced
         OR abs((v_escrow_after - CASE WHEN v_escrow_before_found
                                      THEN v_escrow_before ELSE 0 END) - v_overlay) > 0.005
       ) THEN
      RAISE EXCEPTION USING MESSAGE = 'guarantee bank debit did not credit live escrow exactly',
                            ERRCODE = '23514';
    END IF;

    PERFORM set_config('app.ledger_category', COALESCE(v_old_category, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_old_counterparty, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_old_entity, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_old_tournament, ''), true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  IF v_failure IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'atomic_guarantee_funding_aborted',
      'detail', v_failure, 'sqlstate', v_failure_state,
      'prize_pool', v_pool_before, 'guaranteed_prize', v_guarantee,
      'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'prize_pool', v_after.pool,
    'overlay', v_overlay, 'bank_type', v_expected_bank_type,
    'bank_entity_id', v_expected_bank_entity,
    'bank_before', CASE WHEN v_overlay > 0 THEN v_bank_before ELSE NULL END,
    'bank_after', CASE WHEN v_overlay > 0 THEN v_bank_after ELSE NULL END,
    'escrow_before', CASE WHEN v_escrow_before_found THEN v_escrow_before ELSE NULL END,
    'escrow_after', CASE WHEN v_escrow_after_found THEN v_escrow_after ELSE NULL END,
    'already_finalized', v_t.finalized AND v_overlay = 0,
    'retryable', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(uuid, text)
  TO service_role;
REVOKE ALL ON public.tournament_guarantee_overlays
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.tournament_guarantee_overlays TO service_role;

COMMENT ON FUNCTION public.fn_apply_prize_guarantee(uuid, text) IS
  'Atomic guarantee proof gate: the bank debit, exact overlay claim, explicit journal leg, live escrow credit and finalized published pool all commit together or none do.';

/* A pool cannot be called final while a persisted entry/add-on clock can still
   add money to it. This is a database invariant so an old server, a final-table
   deal, or a direct service-role caller cannot reintroduce the race. A genuine
   finish has already claimed COMPLETING, where all purchase doors are closed. */
CREATE OR REPLACE FUNCTION public.trg_tournament_pool_finalization_window_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_late_level_cap integer := COALESCE(NULLIF(NEW.late_reg_levels, 0),
                                       NULLIF(NEW.rebuy_levels, 0), 0);
  v_rebuy_level_cap integer := COALESCE(NULLIF(NEW.rebuy_levels, 0),
                                        NULLIF(NEW.late_reg_levels, 0), 0);
  v_current_level integer := COALESCE(NEW.current_level, 0);
  /* An unexpired future window is just as binding as one whose start clock has
     arrived. Finalizing it early would publish an add-on promise that the
     finalized-pool trigger later has to refuse. */
  v_addon_open boolean := COALESCE(NEW.add_on_available, false)
                          AND NEW.addon_period_ends_at IS NOT NULL
                          AND clock_timestamp() < NEW.addon_period_ends_at;
BEGIN
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false) THEN
    RAISE EXCEPTION
      'finalized tournament % prize pool cannot be reopened', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(NEW.prize_pool_finalized, false)
     OR COALESCE(OLD.prize_pool_finalized, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('ANNOUNCED', 'REGISTERING')
     AND (v_late_level_cap > 0 OR COALESCE(NEW.late_reg_mins, 0) > 0
          OR COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false)
          OR COALESCE(NEW.add_on_available, false)) THEN
    RAISE EXCEPTION
      'tournament % cannot finalize its prize pool before its post-start entry windows open', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'RUNNING' THEN
    IF v_late_level_cap > 0 AND v_current_level < v_late_level_cap THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before late registration level % closes',
        NEW.id, v_late_level_cap USING ERRCODE = 'check_violation';
    END IF;
    IF v_late_level_cap <= 0 AND COALESCE(NEW.late_reg_mins, 0) > 0
       AND (NEW.started_at IS NULL OR clock_timestamp()
            < NEW.started_at + make_interval(mins => NEW.late_reg_mins)) THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool while timed late registration is open', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false))
       AND v_rebuy_level_cap <= 0 AND COALESCE(NEW.late_reg_mins, 0) <= 0 THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool while an uncapped rebuy or re-entry offer is open', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (COALESCE(NEW.is_rebuy, false) OR COALESCE(NEW.is_reentry, false))
       AND v_rebuy_level_cap > 0 AND v_current_level < v_rebuy_level_cap THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before rebuy level % closes',
        NEW.id, v_rebuy_level_cap USING ERRCODE = 'check_violation';
    END IF;
    IF v_addon_open THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before its promised add-on window closes', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(NEW.add_on_available, false)
       AND (NEW.addon_period_started_at IS NULL OR NEW.addon_period_ends_at IS NULL) THEN
      RAISE EXCEPTION
        'tournament % cannot finalize its prize pool before its add-on window is durably bounded', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_tournament_pool_finalization_window_guard()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zzzz_tournament_pool_finalization_window_guard
  ON public.tournaments;
CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard
BEFORE UPDATE OF prize_pool_finalized ON public.tournaments
FOR EACH ROW
EXECUTE FUNCTION public.trg_tournament_pool_finalization_window_guard();

/* Finalized means closed to every contribution, including a registration that
   began while the guarantee transaction was waiting. Parent-before-child FOR
   UPDATE serialization gives the race two safe outcomes: the entry commits
   first and is included in finalization, or finalization commits first and the
   entry is refused before any debit/roster/pool write can commit. */
CREATE OR REPLACE FUNCTION public.trg_refuse_finalized_tournament_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_finalized boolean;
BEGIN
  SELECT COALESCE(t.prize_pool_finalized, false)
    INTO v_finalized
    FROM public.tournaments t
   WHERE t.id = NEW.tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', NEW.tournament_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_finalized THEN
    RAISE EXCEPTION 'registration is closed because tournament % prize pool is finalized',
      NEW.tournament_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_refuse_finalized_tournament_entry()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zzzz_refuse_finalized_tournament_entry
  ON public.tournament_players;
CREATE TRIGGER zzzz_refuse_finalized_tournament_entry
BEFORE INSERT ON public.tournament_players
FOR EACH ROW
EXECUTE FUNCTION public.trg_refuse_finalized_tournament_entry();

CREATE OR REPLACE FUNCTION public.trg_freeze_finalized_tournament_prize_pool()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false) THEN
    RAISE EXCEPTION
      'finalized tournament % prize pool cannot be reopened', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND (NEW.payout_structure IS DISTINCT FROM OLD.payout_structure
          OR NEW.spin_multiplier IS DISTINCT FROM OLD.spin_multiplier) THEN
    RAISE EXCEPTION
      'finalized tournament % payout structure and Spin draw cannot change', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD.prize_pool_finalized, false)
     AND (round(COALESCE(NEW.prize_pool, 0), 2)
          IS DISTINCT FROM round(COALESCE(OLD.prize_pool, 0), 2)
          OR round(COALESCE(NEW.guaranteed_prize, 0), 2)
             IS DISTINCT FROM round(COALESCE(OLD.guaranteed_prize, 0), 2)) THEN
    RAISE EXCEPTION 'finalized tournament % prize pool cannot change from % to %',
      NEW.id, OLD.prize_pool, NEW.prize_pool USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_freeze_finalized_tournament_prize_pool()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zzzz_freeze_finalized_tournament_prize_pool
  ON public.tournaments;
CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool
BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized,
                 payout_structure, spin_multiplier ON public.tournaments
FOR EACH ROW
EXECUTE FUNCTION public.trg_freeze_finalized_tournament_prize_pool();

/* Result rows are server-owned. The original bootstrap policies allowed a
   browser to insert itself for free or rewrite any player's chips/result on a
   clean replay; production happened to be safer only because an untracked
   policy change removed those grants. Make the tracked schema and production
   agree, and freeze the result identity once its atomic batch exists. */
DROP POLICY IF EXISTS "Users can register themselves" ON public.tournament_players;
DROP POLICY IF EXISTS "System can update tournament players" ON public.tournament_players;
REVOKE INSERT, UPDATE, DELETE ON public.tournament_players
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_old_batched boolean := false;
  v_new_batched boolean := false;
  v_old_final_table_deal_batched boolean := false;
  v_new_final_table_deal_batched boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = OLD.tournament_id
    ) INTO v_old_batched;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.tournament_place_settlement_batches b
       WHERE b.tournament_id = NEW.tournament_id
    ) INTO v_new_batched;
  END IF;

  /* This migration is installed before the final-table-deal migration, but it
     must also be safe to replay after that migration. Resolve the later table
     dynamically so a first install does not require it and a replay cannot
     silently remove final-table-deal result immutability. */
  IF to_regclass('public.tournament_final_table_deal_batches') IS NOT NULL THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      EXECUTE
        'SELECT EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_batches b
            WHERE b.tournament_id = $1
         )'
        INTO v_old_final_table_deal_batched
        USING OLD.tournament_id;
      v_old_batched := v_old_batched OR v_old_final_table_deal_batched;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      EXECUTE
        'SELECT EXISTS (
           SELECT 1
             FROM public.tournament_final_table_deal_batches b
            WHERE b.tournament_id = $1
         )'
        INTO v_new_final_table_deal_batched
        USING NEW.tournament_id;
      v_new_batched := v_new_batched OR v_new_final_table_deal_batched;
    END IF;
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

/* The general managed-game guard intentionally trusts service_role, but these
   fields decide which settlement law applies and how much Bubble Protection is
   owed. Once an entrant exists, even the engine may not turn a normal event
   into a satellite, erase a satellite identity, hide Bubble evidence, or
   rewrite the published buy-in used by that promise. */
CREATE OR REPLACE FUNCTION public.trg_freeze_registered_tournament_settlement_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF ROW(NEW.variant, NEW.tournament_type, NEW.satellite_target_id,
         NEW.bubble_protection, round(COALESCE(NEW.buy_in_amount, 0), 2),
         round(COALESCE(NEW.guaranteed_prize, 0), 2))
     IS NOT DISTINCT FROM
     ROW(OLD.variant, OLD.tournament_type, OLD.satellite_target_id,
         OLD.bubble_protection, round(COALESCE(OLD.buy_in_amount, 0), 2),
         round(COALESCE(OLD.guaranteed_prize, 0), 2)) THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(OLD.status, '')) IN ('COMPLETING', 'COMPLETED')
     OR upper(COALESCE(NEW.status, '')) IN ('COMPLETING', 'COMPLETED') THEN
    RAISE EXCEPTION
      'tournament % settlement class, guarantee, Bubble Protection and buy-in are frozen once settlement begins',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'tournament % settlement class, guarantee, Bubble Protection and buy-in are frozen after its first entrant',
      OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_freeze_registered_tournament_settlement_contract()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zzzz_freeze_registered_tournament_settlement_contract
  ON public.tournaments;
CREATE TRIGGER zzzz_freeze_registered_tournament_settlement_contract
BEFORE UPDATE OF variant, tournament_type, satellite_target_id,
                 bubble_protection, buy_in_amount, guaranteed_prize
ON public.tournaments
FOR EACH ROW
EXECUTE FUNCTION public.trg_freeze_registered_tournament_settlement_contract();

/* The canonical registration core accepted NULL current_level as level zero
   and exposed its p_seat_first_internal escape hatch to every authenticated
   caller through a defaulted boolean. Keep the audited debit/roster core, but
   put one exact lifecycle lock in front of it and make the internal overload
   service-only. */
DO $wrap_registration$
BEGIN
  IF to_regprocedure('public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)')
     IS NULL THEN
    IF to_regprocedure('public.fn_register_for_tournament(uuid,boolean)') IS NULL THEN
      RAISE EXCEPTION 'fn_register_for_tournament two-argument core missing';
    END IF;
    ALTER FUNCTION public.fn_register_for_tournament(uuid, boolean)
      RENAME TO fn_register_for_tournament_before_atomic_lifecycle_gate;
  END IF;
END;
$wrap_registration$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(
  p_tournament_id uuid,
  p_seat_first_internal boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t record;
  v_level_cap integer;
BEGIN
  SELECT t.status, t.late_reg_levels, t.late_reg_mins, t.current_level,
         t.started_at, COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_t.finalized THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  IF v_t.status = 'RUNNING' THEN
    v_level_cap := COALESCE(v_t.late_reg_levels, 0);
    IF v_level_cap > 0 THEN
      IF v_t.current_level IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'registration_state_unknown');
      END IF;
      IF v_t.current_level >= v_level_cap THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
      END IF;
    ELSIF COALESCE(v_t.late_reg_mins, 0) > 0 THEN
      IF v_t.started_at IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'registration_state_unknown');
      END IF;
      IF clock_timestamp()
         >= v_t.started_at + make_interval(mins => v_t.late_reg_mins) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
      END IF;
    ELSE
      RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
    END IF;
  ELSIF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  RETURN public.fn_register_for_tournament_before_atomic_lifecycle_gate(
    p_tournament_id, COALESCE(p_seat_first_internal, false));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(
  p_tournament_id uuid
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT public.fn_register_for_tournament(p_tournament_id, false)
$function$;

REVOKE ALL ON FUNCTION public.fn_register_for_tournament(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament(uuid, boolean)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_register_for_tournament(uuid)
  TO authenticated, service_role;

/* The pre-RPC registration function has no current caller and omits the
   canonical lifecycle/payment contract. It was explicitly retired, then a
   later ACL migration accidentally reopened it. Close it again. */
DO $retire_legacy_registration$
BEGIN
  IF to_regprocedure('public.atomic_tournament_register(uuid,uuid,text,numeric,numeric,numeric,boolean,uuid)')
     IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.atomic_tournament_register(uuid, uuid, text, numeric, numeric, numeric, boolean, uuid) FROM PUBLIC, anon, authenticated, service_role';
    INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
    VALUES ('atomic_tournament_register', 'closed',
            'Legacy registration door retired; fn_register_for_tournament is canonical.')
    ON CONFLICT (proname) DO UPDATE
      SET status = EXCLUDED.status, notes = EXCLUDED.notes;
  END IF;
END;
$retire_legacy_registration$;

/* The persisted rebuy core used to prove that an add-on seat existed without
   locking it, then find it again later and update by id alone. A concurrent
   leave could therefore pass the first read, close the seat, and still have
   its stack resurrected after the player's wallet was charged. Keep the old
   audited money implementation private, and put a parent -> player -> live
   seat lock and an exact post-write proof around it. */
DO $wrap_rebuy_live_seat$
BEGIN
  IF to_regprocedure('public.process_tournament_rebuy_before_atomic_live_seat_lock(uuid,uuid,text,numeric,numeric,integer,text)')
     IS NULL THEN
    IF to_regprocedure('public.process_tournament_rebuy_before_one_minute_addon(uuid,uuid,text,numeric,numeric,integer,text)')
       IS NULL THEN
      RAISE EXCEPTION 'audited process_tournament_rebuy money core missing';
    END IF;
    ALTER FUNCTION public.process_tournament_rebuy_before_one_minute_addon(
      uuid, uuid, text, numeric, numeric, integer, text
    ) RENAME TO process_tournament_rebuy_before_atomic_live_seat_lock;
  END IF;
END;
$wrap_rebuy_live_seat$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy_before_atomic_live_seat_lock(
  uuid, uuid, text, numeric, numeric, integer, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy_before_one_minute_addon(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer DEFAULT NULL,
  p_client_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_player public.tournament_players%ROWTYPE;
  v_player_after public.tournament_players%ROWTYPE;
  v_seat record;
  v_stack_after numeric;
  v_result jsonb;
BEGIN
  SELECT t.id INTO v_tournament_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found';
  END IF;

  SELECT * INTO v_player
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;

  IF p_rebuy_type = 'addon' THEN
    IF v_player.status IS DISTINCT FROM 'playing' THEN
      RAISE EXCEPTION 'Only a playing tournament player may buy an add-on';
    END IF;
    IF COALESCE(v_player.add_on, false) THEN
      RAISE EXCEPTION 'Tournament player has already purchased an add-on';
    END IF;

    SELECT s.id, s.stack INTO v_seat
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE s.user_id = p_user_id
       AND s.left_at IS NULL
       AND tb.tournament_id = p_tournament_id
     ORDER BY (tb.status IS DISTINCT FROM 'closed') DESC,
              s.joined_at DESC NULLS LAST, s.id DESC
     LIMIT 1
     FOR UPDATE OF s;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'No Live Seat For This addon - Refusing To Charge For Chips That Would Be Overwritten By The Seat Sync';
    END IF;
  END IF;

  v_result := public.process_tournament_rebuy_before_atomic_live_seat_lock(
    p_tournament_id, p_user_id, p_rebuy_type, p_cost, p_chips,
    p_current_level, p_client_token);

  IF p_rebuy_type = 'addon' THEN
    SELECT * INTO v_player_after
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_user_id;
    IF NOT FOUND OR NOT COALESCE(v_player_after.add_on, false) THEN
      RAISE EXCEPTION
        'Add-on money core returned without recording the player add-on; transaction aborted';
    END IF;

    /* This guarded final write is also the durable row-count proof. Because
       the exact seat has been locked since before the money core ran, a leave
       cannot interleave between eligibility, stack grant and this assertion. */
    UPDATE public.table_seats s
       SET stack = v_player_after.chips
     WHERE s.id = v_seat.id
       AND s.left_at IS NULL
       AND s.stack IS NOT DISTINCT FROM v_player_after.chips
    RETURNING s.stack INTO v_stack_after;
    IF NOT FOUND OR v_stack_after IS DISTINCT FROM v_player_after.chips THEN
      RAISE EXCEPTION
        'Live add-on seat changed before its exact stack could be committed; transaction aborted';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy_before_one_minute_addon(
  uuid, uuid, text, numeric, numeric, integer, text
) FROM PUBLIC, anon, authenticated, service_role;

/* Put a lifecycle/finalization gate around the persisted rebuy/add-on money
   implementation. The previous wrapper trusted only its clock and could grow
   a finalized pool. */
/* Two older overloads survive a clean replay even though production was
   manually reduced to the canonical seven-argument door. Both trust browser
   supplied identity, cost, chips and level, and can mutate terminal pools.
   They have no caller and no compatible contract to wrap; remove them. */
DROP FUNCTION IF EXISTS public.process_tournament_rebuy(
  uuid, uuid, text, numeric, integer, integer
);
DROP FUNCTION IF EXISTS public.process_tournament_rebuy(
  uuid, uuid, numeric, integer, text, integer
);

DO $wrap_rebuy$
BEGIN
  IF to_regprocedure('public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)')
     IS NULL THEN
    IF to_regprocedure('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)')
       IS NULL THEN
      RAISE EXCEPTION 'process_tournament_rebuy seven-argument function missing';
    END IF;
    ALTER FUNCTION public.process_tournament_rebuy(
      uuid, uuid, text, numeric, numeric, integer, text
    ) RENAME TO process_tournament_rebuy_before_atomic_pool_gate;
  END IF;
  IF to_regprocedure('public.process_tournament_rebuy_before_one_minute_addon(uuid,uuid,text,numeric,numeric,integer,text)')
     IS NULL THEN
    RAISE EXCEPTION 'audited process_tournament_rebuy money core missing';
  END IF;
END;
$wrap_rebuy$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy_before_atomic_pool_gate(
  uuid, uuid, text, numeric, numeric, integer, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.process_tournament_rebuy_before_one_minute_addon(
  uuid, uuid, text, numeric, numeric, integer, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer DEFAULT NULL,
  p_client_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_level_cap integer;
  v_addon_open boolean;
BEGIN
  SELECT * INTO v_t FROM public.tournaments
   WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RAISE EXCEPTION 'Tournament prize pool is finalized; chip purchases are closed';
  END IF;
  v_addon_open := COALESCE(v_t.add_on_available, false)
                  AND COALESCE(v_t.addon_period_triggered, false)
                  AND v_t.addon_period_started_at IS NOT NULL
                  AND v_t.addon_period_ends_at IS NOT NULL
                  AND clock_timestamp() >= v_t.addon_period_started_at
                  AND clock_timestamp() < v_t.addon_period_ends_at;
  IF p_rebuy_type = 'addon' THEN
    IF v_t.status NOT IN ('REGISTERING', 'RUNNING') THEN
      RAISE EXCEPTION 'Tournament is not accepting add-ons (status %)', v_t.status;
    END IF;
    IF NOT v_addon_open THEN
      RAISE EXCEPTION 'Add-on period is not open';
    END IF;
    /* Parent first, then the exact roster row: the money core must never sell
       an add-on to a spectator, a busted player, or a player who has already
       consumed the one add-on. Keep this lock through the delegated wallet,
       stack, ledger and pool transaction so elimination and duplicate-click
       races have only one durable winner. */
    SELECT * INTO v_player
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tournament player not found for add-on';
    END IF;
    IF v_player.status IS DISTINCT FROM 'playing' THEN
      RAISE EXCEPTION 'Only a playing tournament player may buy an add-on';
    END IF;
    IF COALESCE(v_player.add_on, false) THEN
      RAISE EXCEPTION 'Tournament player has already purchased an add-on';
    END IF;
  ELSIF p_rebuy_type IN ('rebuy', 'reentry') THEN
    IF v_t.status <> 'RUNNING' THEN
      RAISE EXCEPTION 'Tournament is not accepting rebuys or re-entries (status %)', v_t.status;
    END IF;
    v_level_cap := COALESCE(NULLIF(v_t.rebuy_levels, 0),
                            NULLIF(v_t.late_reg_levels, 0), 0);
    /* The caller's level is display data, not authority. A stale or forged low
       p_current_level must not hold a purchase window open after the persisted
       tournament level has closed it. */
    IF v_level_cap > 0 AND v_t.current_level IS NULL AND NOT v_addon_open THEN
      RAISE EXCEPTION 'Current tournament level is unknown; rebuy refused';
    END IF;
    IF v_level_cap > 0 AND v_t.current_level >= v_level_cap
       AND NOT v_addon_open THEN
      RAISE EXCEPTION 'Rebuy period has closed';
    END IF;
    IF v_level_cap <= 0 AND COALESCE(v_t.late_reg_mins, 0) > 0
       AND (v_t.started_at IS NULL OR clock_timestamp()
            >= v_t.started_at + make_interval(mins => v_t.late_reg_mins))
       AND NOT v_addon_open THEN
      RAISE EXCEPTION 'Timed rebuy period has closed';
    END IF;
    IF v_level_cap <= 0 AND COALESCE(v_t.late_reg_mins, 0) <= 0
       AND NOT v_addon_open THEN
      RAISE EXCEPTION 'Tournament has no bounded rebuy period';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid rebuy type: %', p_rebuy_type;
  END IF;

  /* Call the audited money core directly. The superseded one-minute wrapper
     is retained under its historical name but had closed rebuys at the base
     level even during the add-on clock. This wrapper owns the authoritative
     lifecycle/clock gate above, then delegates wallet, stack, ledger and pool
     mutations to the locked core. */
  RETURN public.process_tournament_rebuy_before_one_minute_addon(
    p_tournament_id, p_user_id, p_rebuy_type, p_cost, p_chips,
    v_t.current_level, p_client_token);
END;
$function$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy(
  uuid, uuid, text, numeric, numeric, integer, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(
  uuid, uuid, text, numeric, numeric, integer, text
) TO authenticated, service_role;

COMMENT ON TABLE public.tournament_obligations IS
  'What a tournament owes and has paid, one row per place or user. Normal place rows are materialized as a complete fingerprinted batch before fn_settle_tournament_places_atomic moves money.';

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES
  ('fn_prepare_tournament_place_obligations', 'approved',
   'Freezes the exact place plan and committed obligations; moves no money.'),
  ('fn_settle_tournament_places_atomic', 'approved',
   'The sole normal place payout and COMPLETED door: every prepared place or none.')
ON CONFLICT (proname) DO UPDATE
SET status = EXCLUDED.status, notes = EXCLUDED.notes;

/* Keep the existing detector only for its owner-run 30-day observation.
   Applying mode raises before every table read or write, and application
   credentials cannot call either this function or its sweep wrapper. */
CREATE OR REPLACE FUNCTION public.fn_tournament_payout_reconcile(p_tournament_id uuid, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t                record;
  v_struct         jsonb;
  v_trimmed        jsonb;
  v_field          int;
  v_pool           numeric;
  v_last_place     int;
  v_total_bp       numeric;
  v_pool_cents     numeric;
  v_remaining      numeric;
  v_cents          numeric;
  v_expected       numeric;
  v_paid           numeric;
  v_paid_place     numeric;
  v_paid_eff       numeric;
  v_place_others   uuid[];
  v_delta          numeric;
  v_holder         uuid;
  v_holders        int;
  v_actions        jsonb := '[]'::jsonb;
  v_issues         jsonb := '[]'::jsonb;
  v_total_expected numeric := 0;
  v_total_paid     numeric := 0;
  v_total_topup    numeric := 0;
  v_only_accepted  boolean;
  v_was_accepted   boolean;
  v_has_record     boolean;
  r                record;
BEGIN
  /* The applying repair path is retired. Keep this function only as the
     temporary non-paying observation named in the Band-Aids Register. Refuse
     before reading tournament state so a caller cannot mistake p_apply=true
     for a best-effort payment request. */
  IF p_apply THEN
    RAISE EXCEPTION USING
      MESSAGE = 'applying_reconcile_retired',
      DETAIL = 'Atomic tournament settlement replaced the applying reconciler',
      ERRCODE = '0A000';
  END IF;

  SELECT id, prize_pool, payout_structure, status, variant, tournament_type, name
    INTO t
    FROM tournaments WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF COALESCE(t.variant, '') = 'satellite'
     OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'satellite_awards_seats');
  END IF;

  IF COALESCE(t.status, '') <> 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'not_completed', 'status', t.status);
  END IF;

  v_pool := round(COALESCE(t.prize_pool, 0), 2);

  BEGIN
    v_struct := CASE WHEN jsonb_typeof(t.payout_structure::jsonb) = 'array'
                     THEN t.payout_structure::jsonb ELSE '[]'::jsonb END;
  EXCEPTION WHEN OTHERS THEN
    v_struct := '[]'::jsonb;
  END;

  IF v_pool <= 0 OR jsonb_array_length(v_struct) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'no_pool_or_structure',
                              'prize_pool', v_pool);
  END IF;

  /* Is there an authoritative record for this event at all? */
  SELECT EXISTS (SELECT 1 FROM public.tournament_payouts tpo
                  WHERE tpo.tournament_id = p_tournament_id)
    INTO v_has_record;

  SELECT count(*) INTO v_field
    FROM tournament_players tp WHERE tp.tournament_id = p_tournament_id;

  IF COALESCE(v_field, 0) >= 1 THEN
    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::int), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(v_struct) e
     WHERE (e->>'place')::int <= v_field;

    IF jsonb_array_length(v_trimmed) > 0
       AND jsonb_array_length(v_trimmed) < jsonb_array_length(v_struct) THEN
      v_struct := v_trimmed;
    END IF;
  END IF;

  SELECT max((e->>'place')::int) INTO v_last_place
    FROM jsonb_array_elements(v_struct) e;

  SELECT COALESCE(SUM(round((e->>'percentage')::numeric * 100)), 0)
    INTO v_total_bp
    FROM jsonb_array_elements(v_struct) e;

  IF v_total_bp <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'structure_has_no_percentages');
  END IF;

  v_pool_cents := round(v_pool * 100);
  v_remaining  := v_pool_cents;

  FOR r IN
    SELECT (e->>'place')::int                      AS place,
           round((e->>'percentage')::numeric * 100) AS bp
      FROM jsonb_array_elements(v_struct) e
     ORDER BY (e->>'place')::int
  LOOP
    IF r.place = v_last_place THEN
      v_cents := GREATEST(v_remaining, 0);
    ELSE
      v_cents := LEAST(v_remaining, round(v_pool_cents * r.bp / v_total_bp));
      v_cents := GREATEST(v_cents, 0);
    END IF;
    v_remaining := v_remaining - v_cents;

    v_expected := v_cents / 100.0;
    v_total_expected := v_total_expected + v_expected;

    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_holders, v_holder
      FROM tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;

    v_paid_place   := 0;
    v_place_others := ARRAY[]::uuid[];

    IF v_holders = 1 THEN
      IF v_has_record THEN
        /* THE AUTHORITATIVE ANSWER. One row per movement of money, keyed
           uniquely, written only after the credit returned true. Bounty and
           mystery-bounty money is excluded: it is funded from the bounty pool,
           not from prize_pool, and counting it here used to make a player look
           square when the structure still owed them.
           2026-09-02: 'overlay_backpay' added. A guarantee overlay top-up IS
           prize_pool money. While it was missing from this list the reconciler
           could not see 1,703.00 chips of back-payment and paid 1,007.80 of it
           a second time.
           2026-09-02 (Lane A3): a row written by fn_settle_tournament_obligation
           (idempotency_key 'obl:%') is prize-pool money whatever source label
           the caller passed - the engine settles under 'engine.*' names. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2) INTO v_paid
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.user_id = v_holder
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');

        /* A PLACE IS PAID ONCE, NO MATTER WHO HOLDS IT (2026-09-02).
           What this place has already cost, to ANYBODY. The obligation is per
           place; reading only the current holder let a place that changed hands
           after settlement be paid in full a second time -- 81 places, 49
           events, 21,206.93 chips. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2),
               COALESCE(array_agg(DISTINCT tpo.user_id)
                        FILTER (WHERE tpo.user_id <> v_holder), ARRAY[]::uuid[])
          INTO v_paid_place, v_place_others
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.position = r.place
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');
      ELSE
        /* No record for this event. Fall back to the ledger exactly as before
           rather than reading "no record" as "nothing was paid". */
        SELECT round(COALESCE(SUM(
                 CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                      ELSE wt.amount END
               ), 0), 2) INTO v_paid
          FROM wallet_transactions wt
         WHERE wt.related_entity_id = p_tournament_id
           AND wt.category = 'prize'
           AND wt.user_id = v_holder;
      END IF;
    ELSE
      v_paid := NULL;
    END IF;

    IF v_holders = 0 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'no_finisher_recorded',
        'expected', v_expected,
        'detail', 'prize is owed to nobody identifiable; needs a human decision');
      CONTINUE;
    END IF;

    IF v_holders > 1 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'duplicate_finishers',
        'holders', v_holders, 'expected', v_expected,
        'detail', 'more than one player recorded in this place (double-pay defect)');
      CONTINUE;
    END IF;

    /* The cap. A top-up settles what the PLACE still owes, not what this
       particular player has yet to receive from it. */
    v_paid_eff := GREATEST(COALESCE(v_paid, 0), COALESCE(v_paid_place, 0));

    IF COALESCE(v_paid_place, 0) > COALESCE(v_paid, 0) + 0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'place_paid_to_a_different_player',
        'user_id', v_holder,
        'paid_to_current_holder', COALESCE(v_paid, 0),
        'paid_at_this_place', v_paid_place,
        'other_recipients', to_jsonb(v_place_others),
        'expected', v_expected,
        'detail', 'this place was settled before the finishing order changed. '
               || 'No automatic top-up: the place is already paid. Paying the '
               || 'current holder as well is a deliberate decision (CLAUDE.md 10.9), '
               || 'made with the earlier payment in view.');
    END IF;

    v_total_paid := v_total_paid + v_paid_eff;
    v_delta := round(v_expected - v_paid_eff, 2);
    IF v_delta > 0.005 THEN
      v_total_topup := v_total_topup + v_delta;

      v_actions := v_actions || jsonb_build_object(
        'place', r.place, 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'top_up', v_delta,
        'applied', false,
        'settled', NULL,
        'obligation_id', NULL);

    ELSIF v_delta < -0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'overpaid', 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'excess', -v_delta,
        'detail', 'reported only; automatic clawback is deliberately not done');
    END IF;

  END LOOP;

  IF jsonb_array_length(v_issues) > 0 THEN
    v_only_accepted := NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_issues) i
       WHERE i->>'issue' NOT IN ('overpaid', 'no_finisher_recorded',
                                 'place_paid_to_a_different_player')
    );
    v_was_accepted := EXISTS (
      SELECT 1 FROM financial_alerts
       WHERE source = 'fn_tournament_payout_reconcile'
         AND resolved IS TRUE
         AND context->>'tournament_id' = p_tournament_id::text
         AND context ? 'resolution'
    );

    INSERT INTO financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_tournament_payout_reconcile',
           'Tournament payout could not be fully reconciled: '
             || COALESCE(t.name, p_tournament_id::text),
           jsonb_build_object('tournament_id', p_tournament_id,
                              'prize_pool', v_pool, 'issues', v_issues)
     WHERE NOT EXISTS (
       SELECT 1 FROM financial_alerts
        WHERE source = 'fn_tournament_payout_reconcile'
          AND resolved IS NOT TRUE
          AND context->>'tournament_id' = p_tournament_id::text)
       AND NOT (round(v_total_topup, 2) = 0 AND v_only_accepted AND v_was_accepted);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tournament_id', p_tournament_id,
    'name', t.name,
    'prize_pool', v_pool,
    'field_size', v_field,
    'paid_places', jsonb_array_length(v_struct),
    'total_expected', round(v_total_expected, 2),
    'total_paid_to_known_holders', round(v_total_paid, 2),
    'total_top_up', round(v_total_topup, 2),
    'total_settled', 0,
    'applied', false,
    'paid_from', CASE WHEN v_has_record THEN 'payout_record' ELSE 'ledger_fallback' END,
    'money_path', 'none',
    'actions', v_actions,
    'issues', v_issues,
    'clean', (jsonb_array_length(v_actions) = 0 AND jsonb_array_length(v_issues) = 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean) IS
  'Temporary non-paying observation debt. Applying mode is retired and always raises applying_reconcile_retired before any table read or write, rolling back every legacy caller. Delete after 30 consecutive production days with zero reconcile-source payouts.';

/* The backed-shortfall wrapper used to call the reconciler in applying mode
   after scanning completed tournaments. Keep its owner-run dry observation,
   but remove every payment branch and reject applying intent before the scan. */
CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_payable numeric := 0;
  v_payable_events integer := 0;
  v_withheld numeric := 0;
  v_withheld_events integer := 0;
  v_refused integer := 0;
  v_refused_chips numeric := 0;
  v_alerts integer := 0;
BEGIN
  IF p_apply THEN
    RAISE EXCEPTION USING
      MESSAGE = 'applying_backed_shortfall_retired',
      DETAIL = 'Atomic tournament settlement replaced the applying shortfall sweep',
      ERRCODE = '0A000';
  END IF;

  FOR r IN
    SELECT t.id, t.name, t.club_id, t.prize_pool,
           COALESCE((public.fn_tournament_payout_reconcile(t.id, false)
                     ->>'total_top_up')::numeric, 0) AS topup,
           public.fn_tournament_conservation_delta(t.id) AS delta,
           COALESCE((
             SELECT sum(w.amount)
               FROM public.wallet_transactions w
              WHERE w.related_entity_id = t.id
                AND w.type = 'credit' AND w.category = 'prize'
           ), 0) AS wallet_prizes
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND NOT (
         COALESCE(t.variant, '') = 'satellite'
         OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
         OR t.satellite_target_id IS NOT NULL
       )
       AND COALESCE(t.variant, '') <> 'spin'
       AND public.fn_tournament_conservation_delta(t.id) > 0.01
     ORDER BY t.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    IF r.wallet_prizes + 0.01 >= COALESCE(r.prize_pool, 0)
       AND COALESCE(r.prize_pool, 0) > 0 THEN
      v_refused := v_refused + 1;
      v_refused_chips := v_refused_chips + r.topup;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_pay_backed_payout_shortfalls',
             format('%s already paid %s of its %s pool to wallets, so the %s reported shortfall is evidence debt, not authorization to pay.',
                    COALESCE(r.name, r.id::text), round(r.wallet_prizes, 2),
                    round(COALESCE(r.prize_pool, 0), 2), round(r.topup, 2)),
             jsonb_build_object(
               'kind', 'refused_already_disbursed', 'tournament_id', r.id,
               'club_id', r.club_id, 'wallet_prizes', round(r.wallet_prizes, 2),
               'prize_pool', round(COALESCE(r.prize_pool, 0), 2),
               'reported_top_up', round(r.topup, 2))
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts fa
          WHERE fa.source = 'fn_pay_backed_payout_shortfalls'
            AND fa.resolved IS NOT TRUE
            AND fa.context->>'kind' = 'refused_already_disbursed'
            AND fa.context->>'tournament_id' = r.id::text
       );
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_pay_backed_payout_shortfalls',
             format('%s reports %s owed while its pool holds %s. The detector moved no money.',
                    COALESCE(r.name, r.id::text), round(r.topup, 2), round(r.delta, 2)),
             jsonb_build_object(
               'kind', 'withheld_unfunded_pool', 'tournament_id', r.id,
               'club_id', r.club_id, 'owed', round(r.topup, 2),
               'pool_holds', round(r.delta, 2),
               'funding_gap', round(r.topup - r.delta, 2),
               'detail', 'non-paying observation; funding remains a human decision')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts fa
          WHERE fa.source = 'fn_pay_backed_payout_shortfalls'
            AND fa.resolved IS NOT TRUE
            AND fa.context->>'kind' = 'withheld_unfunded_pool'
            AND fa.context->>'tournament_id' = r.id::text
       );
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    v_payable := v_payable + r.topup;
    v_payable_events := v_payable_events + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'applied', false,
    'events_paid', 0, 'chips_paid', 0,
    'events_payable', v_payable_events, 'chips_payable', round(v_payable, 2),
    'events_withheld_unfunded_pool', v_withheld_events,
    'chips_withheld_unfunded_pool', round(v_withheld, 2),
    'events_refused_already_disbursed', v_refused,
    'chips_refused_already_disbursed', round(v_refused_chips, 2),
    'alerts_raised', v_alerts, 'money_path', 'none');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) IS
  'Temporary owner-run non-paying shortfall detector. Applying mode is retired and raises before scanning. Delete with the payout-reconcile observation debt.';

/* The engine's five-minute Heads-Up backpay loop also paid one normal place
   independently. The public obligation gate now correctly refuses that
   shape, which would make the old loop rescan forever while reporting ok:true
   with a nested refusal count. Retain only an owner-run read of the historical
   candidate set. It cannot rank results, alter a pool, settle an obligation,
   credit a wallet, update an alert or claim that any chips were paid. */
CREATE OR REPLACE FUNCTION public.fn_backpay_hu_winner_shortfalls(
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_scanned integer := 0;
  v_chips numeric := 0;
  v_unranked integer := 0;
BEGIN
  SELECT count(*), round(COALESCE(sum(c.delta), 0), 2),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = c.tournament_id
              AND tp.position IS NULL
         ))
    INTO v_scanned, v_chips, v_unranked
    FROM public.fn_hu_shortfall_candidates(GREATEST(COALESCE(p_limit, 100), 1)) c;

  RETURN jsonb_build_object(
    'ok', true, 'applied', false,
    'scanned', v_scanned, 'observed_chips', v_chips,
    'unranked_events', v_unranked,
    'paid', 0, 'chips', 0, 'money_path', 'none',
    'reason', 'hu_backpay_retired_use_atomic_settlement');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer) IS
  'Legacy owner-run non-paying Heads-Up shortfall observation. The applying loop was retired when normal places moved behind complete atomic settlement.';

/* This one-off procedure was another applying reconciler entry: it iterated
   historical overlay backpays, swallowed each apply-retired exception and
   committed between events. Preserve only an owner-run observation report.
   Applying intent now aborts before its first read, and no application role
   can invoke the procedure. */
CREATE OR REPLACE PROCEDURE public.sp_ca_reconcile_backpaid_events(
  p_apply boolean DEFAULT false
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  r record;
  v jsonb;
  v_n integer := 0;
  v_chips numeric := 0;
BEGIN
  IF p_apply THEN
    RAISE EXCEPTION USING
      MESSAGE = 'applying_backpaid_reconcile_retired',
      DETAIL = 'Atomic tournament settlement replaced the applying backpay reconciler',
      ERRCODE = '0A000';
  END IF;

  FOR r IN
    SELECT DISTINCT p.tournament_id
      FROM public.tournament_payouts p
     WHERE p.source = 'overlay_backpay'
       AND p.recorded_by = 'fn_ca_backpay_guarantee_shortfalls'
  LOOP
    v := public.fn_tournament_payout_reconcile(r.tournament_id, false);
    IF COALESCE((v->>'total_top_up')::numeric, 0) > 0 THEN
      v_n := v_n + 1;
      v_chips := v_chips + (v->>'total_top_up')::numeric;
    END IF;
  END LOOP;

  RAISE NOTICE 'events needing review: %, chips observed: %',
               v_n, round(v_chips, 2);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean) IS
  'Legacy owner-run non-paying report for guarantee-backpay events. Applying mode is retired and raises before scanning.';

DO $retire_applying_rpc_authority$
BEGIN
  IF to_regprocedure('public.fn_tournament_payout_sweep(integer,boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.fn_ca_backpay_guarantee_shortfalls(boolean,integer)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.sp_ca_reconcile_backpaid_events(boolean)')
     IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'DELETE FROM public.ca_settle_sources WHERE lower(source) IN ($1, $2)'
      USING 'reconcile', 'fn_tournament_payout_reconcile';
  END IF;
END;
$retire_applying_rpc_authority$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  (
    'fn_tournament_payout_reconcile',
    'legacy',
    'Temporary non-paying detector. Applying mode retired 2026-09-07; delete after 30 consecutive production days with zero reconcile-source payouts.'
  ),
  (
    'fn_pay_backed_payout_shortfalls',
    'legacy',
    'Temporary non-paying wrapper around the payout detector. Applying mode retired 2026-09-07; delete with fn_tournament_payout_reconcile.'
  ),
  (
    'fn_ca_backpay_guarantee_shortfalls',
    'legacy',
    'Legacy guarantee repair entry. Application EXECUTE revoked 2026-09-07; any applying call is transaction-fatally refused by the retired reconciler.'
  ),
  (
    'sp_ca_reconcile_backpaid_events',
    'legacy',
    'Temporary owner-run non-paying report. Applying mode and application EXECUTE retired 2026-09-07.'
  ),
  (
    'fn_backpay_hu_winner_shortfalls',
    'legacy',
    'Legacy owner-run non-paying observation. Engine applying loop and application EXECUTE retired 2026-09-07; normal Heads-Up places now use complete atomic settlement.'
  )
ON CONFLICT (proname) DO UPDATE
  SET status = EXCLUDED.status,
      notes = EXCLUDED.notes;

DO $retire_applying_sweep$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid)
      FROM cron.job j
     WHERE j.jobname = 'ca-payout-sweep-hourly'
        OR j.command ~* 'fn_tournament_payout_sweep[[:space:]]*\([^,]+,[[:space:]]*true([[:space:]]*,|[[:space:]]*\))'
        OR j.command ~* 'fn_tournament_payout_sweep[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
        OR j.command ~* 'fn_tournament_payout_reconcile[[:space:]]*\([^,]+,[[:space:]]*true[[:space:]]*\)'
        OR j.command ~* 'fn_tournament_payout_reconcile[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
        OR j.command ~* 'fn_pay_backed_payout_shortfalls[[:space:]]*\([[:space:]]*true([[:space:]]*,|[[:space:]]*\))'
        OR j.command ~* 'fn_pay_backed_payout_shortfalls[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
        OR j.command ~* 'fn_ca_backpay_guarantee_shortfalls[[:space:]]*\([[:space:]]*true([[:space:]]*,|[[:space:]]*\))'
        OR j.command ~* 'fn_ca_backpay_guarantee_shortfalls[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
        OR j.command ~* 'sp_ca_reconcile_backpaid_events[[:space:]]*\([[:space:]]*true[[:space:]]*\)'
        OR j.command ~* 'sp_ca_reconcile_backpaid_events[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
        OR j.command ~* 'fn_backpay_hu_winner_shortfalls[[:space:]]*\(';
  END IF;
END;
$retire_applying_sweep$;

/* The roster existed when this work was reserved, but Work Item 10 retired
   that entire table before this migration reached production. Keep this
   migration valid on either schema age: when the old roster is present it
   loses the applying job in this transaction; when the table is already gone
   there is no stale expectation to remove. Dynamic SQL avoids resolving a
   relation that legitimately no longer exists. */
DO $retire_legacy_roster$
BEGIN
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.ca_expected_cron_jobs WHERE jobname = $1'
      USING 'ca-payout-sweep-hourly';
  END IF;
END;
$retire_legacy_roster$;

/* These two findings describe operational failures of the applying repair
   job itself: one pass hit a lock timeout and one older pass exhausted its
   scan limit. They are not evidence that a player's shortfall was repaired,
   and every obligation/reconciler/escrow alert remains open. Once the only
   scheduled applying job has been removed above, however, these two exact
   conditions cannot recur automatically and leaving them open would claim
   that an intentionally retired job still needs an operator response. */
UPDATE public.financial_alerts
   SET resolved = true,
       resolved_at = now(),
       resolution =
         'The applying payout repair cron was retired by the atomic tournament place settlement migration. Normal tournament completion now pays every place or none; this closes only the retired sweep operation and does not close any player-money finding.'
 WHERE resolved IS NOT TRUE
   AND source IN ('fn_tournament_payout_sweep',
                  'fn_tournament_payout_sweep_truncated');

DO $assert$
DECLARE
  v_legacy_roster_has_job boolean := false;
  v_legacy_observer_source text;
  v_backed_observer_source text;
  v_backpaid_observer_source text;
  v_hu_observer_source text;
  v_single_obligation_source text;
  v_pool_freeze_source text;
  v_result_freeze_source text;
  v_registered_contract_source text;
  v_guarantee_source text;
  v_atomic_settler_source text;
BEGIN
  IF to_regclass('public.tournament_place_settlement_batches') IS NULL THEN
    RAISE EXCEPTION 'tournament_place_settlement_batches missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tournament_place_settlement_batches'
       AND column_name = 'escrow_required'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tournament_place_settlement_batches'
       AND column_name = 'escrow_available'
  ) THEN
    RAISE EXCEPTION 'atomic place batch escrow proof columns missing';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tournament_place_settlement_batches'
       AND column_name = ANY (ARRAY[
         'bubble_contract_required', 'bubble_obligation_id', 'bubble_user_id',
         'bubble_source', 'bubble_amount_owed', 'bubble_amount_paid_before'
       ])
  ) <> 6 THEN
    RAISE EXCEPTION 'atomic place batch Bubble Protection proof columns missing';
  END IF;
  IF to_regprocedure('public.fn_tournament_payout_key_is_place_evidence(uuid,text)')
     IS NULL THEN
    RAISE EXCEPTION 'place payout evidence classifier missing';
  END IF;
  IF to_regprocedure('public.fn_prepare_tournament_place_obligations(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'fn_prepare_tournament_place_obligations missing';
  END IF;
  IF to_regprocedure('public.fn_normalize_tournament_final_standings(uuid)') IS NULL THEN
    RAISE EXCEPTION 'fn_normalize_tournament_final_standings missing';
  END IF;
  IF to_regprocedure('public.fn_settle_tournament_places_atomic(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'fn_settle_tournament_places_atomic missing';
  END IF;
  IF to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION 'private single-obligation settlement core missing';
  END IF;
  IF to_regprocedure('public.trg_tournament_atomic_place_completion_guard()') IS NULL THEN
    RAISE EXCEPTION 'atomic completion guard missing';
  END IF;
  IF to_regprocedure('public.trg_lock_atomic_place_tournament_status()') IS NULL THEN
    RAISE EXCEPTION 'atomic place status lock missing';
  END IF;
  IF to_regprocedure('public.trg_refuse_normal_tournament_completed_insert()') IS NULL THEN
    RAISE EXCEPTION 'normal COMPLETED insert guard missing';
  END IF;
  IF to_regprocedure('public.trg_freeze_batched_tournament_place()') IS NULL THEN
    RAISE EXCEPTION 'batched place freeze missing';
  END IF;
  IF to_regprocedure('public.trg_tournament_pool_finalization_window_guard()') IS NULL
     OR to_regprocedure('public.trg_refuse_finalized_tournament_entry()') IS NULL
     OR to_regprocedure('public.trg_freeze_finalized_tournament_prize_pool()') IS NULL
     OR to_regprocedure('public.trg_freeze_batched_tournament_result()') IS NULL
     OR to_regprocedure('public.trg_freeze_registered_tournament_settlement_contract()') IS NULL THEN
    RAISE EXCEPTION 'pool lifecycle or result-freeze invariant missing';
  END IF;
  SELECT p.prosrc INTO v_result_freeze_source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'trg_freeze_batched_tournament_result';
  IF position('tournament_place_settlement_batches'
              IN COALESCE(v_result_freeze_source, '')) = 0
     OR position('tournament_final_table_deal_batches'
                 IN COALESCE(v_result_freeze_source, '')) = 0
     OR position('NEW.chips' IN COALESCE(v_result_freeze_source, '')) = 0
     OR position('NEW.registered_at' IN COALESCE(v_result_freeze_source, '')) = 0
     OR position('NEW.rebuys' IN COALESCE(v_result_freeze_source, '')) = 0
     OR position('NEW.add_on' IN COALESCE(v_result_freeze_source, '')) = 0 THEN
    RAISE EXCEPTION
      'atomic result freeze is not replay-safe across place and final-table-deal batches';
  END IF;
  IF to_regprocedure('public.trg_record_bubble_obligation_with_elimination()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.tournament_players'::regclass
          AND tgname = 'zzzz_record_bubble_obligation_with_elimination'
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'provisional Bubble Protection elimination trigger was not retired';
  END IF;
  IF to_regprocedure('public.fn_apply_prize_guarantee(uuid,text)') IS NULL
     OR to_regprocedure('public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)')
        IS NULL THEN
    RAISE EXCEPTION 'atomic guarantee wrapper or private debit core missing';
  END IF;
  IF to_regprocedure('public.fn_register_for_tournament(uuid)') IS NULL
     OR to_regprocedure('public.fn_register_for_tournament(uuid,boolean)') IS NULL
     OR to_regprocedure('public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)')
        IS NULL THEN
    RAISE EXCEPTION 'canonical registration lifecycle wrapper missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzz_tournaments_atomic_place_completion_guard'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'atomic completion guard trigger is not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzy_lock_atomic_place_tournament_status'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'atomic place status lock trigger is not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzz_refuse_normal_tournament_completed_insert'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'normal COMPLETED insert guard trigger is not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_obligations'::regclass
       AND tgname = 'zzzz_freeze_batched_tournament_place'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'batched place obligation freeze trigger is not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzz_tournament_pool_finalization_window_guard'
       AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_players'::regclass
       AND tgname = 'zzzz_freeze_batched_tournament_result'
       AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_players'::regclass
       AND tgname = 'zzzz_refuse_finalized_tournament_entry'
       AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzz_freeze_finalized_tournament_prize_pool'
       AND tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zzzz_freeze_registered_tournament_settlement_contract'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'pool lifecycle or result-freeze trigger is not enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.wallet_transactions'::regclass
       AND tgname = 'zz_ca_escrow_wallet_tx'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'tournament payout escrow debit trigger is not enabled';
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
  IF has_table_privilege('service_role',
                         'public.tournament_place_settlement_batches', 'INSERT')
     OR has_table_privilege('service_role',
                            'public.tournament_place_settlement_batches', 'UPDATE')
     OR has_table_privilege('service_role',
                            'public.tournament_place_settlement_batches', 'DELETE')
     OR has_table_privilege('service_role',
                            'public.tournament_place_settlement_batches', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role can forge an atomic settlement batch';
  END IF;
  IF has_table_privilege('service_role',
                         'public.tournament_obligations', 'INSERT')
     OR has_table_privilege('service_role',
                            'public.tournament_obligations', 'UPDATE')
     OR has_table_privilege('service_role',
                            'public.tournament_obligations', 'DELETE')
     OR has_table_privilege('service_role',
                            'public.tournament_obligations', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role can forge a tournament obligation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
     WHERE specific_schema = 'public'
       AND routine_name IN ('fn_prepare_tournament_place_obligations',
                            'fn_settle_tournament_places_atomic',
                            'fn_normalize_tournament_final_standings')
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'atomic tournament settlement is browser reachable';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'private single-obligation settlement core is reachable';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'public single-obligation settlement ACL is not canonical';
  END IF;
  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure)
    INTO v_single_obligation_source;
  IF position('v_is_satellite' IN v_single_obligation_source) = 0
     OR position('FOR UPDATE' IN v_single_obligation_source) = 0
     OR position('late_reg_adjustment' IN v_single_obligation_source) = 0
     OR position('bubble_protection' IN v_single_obligation_source) = 0
     OR position('final_table_deal' IN v_single_obligation_source) = 0
     OR position('atomic_batch_required' IN v_single_obligation_source) = 0
     OR position('fn_settle_tournament_obligation_before_atomic_batch_gate('
                 IN v_single_obligation_source) = 0 THEN
    RAISE EXCEPTION 'public single-obligation settlement can bypass an atomic batch';
  END IF;
  SELECT pg_get_functiondef(
           'public.fn_settle_tournament_places_atomic(uuid,text)'::regprocedure)
    INTO v_atomic_settler_source;
  IF position('fn_settle_tournament_obligation_before_atomic_batch_gate('
              IN v_atomic_settler_source) = 0
     OR position('public.fn_settle_tournament_obligation('
                 IN v_atomic_settler_source) > 0 THEN
    RAISE EXCEPTION 'atomic place settler does not use the private obligation core';
  END IF;
  SELECT pg_get_functiondef(
           'public.trg_freeze_finalized_tournament_prize_pool()'::regprocedure)
    INTO v_pool_freeze_source;
  SELECT pg_get_functiondef(
           'public.trg_freeze_registered_tournament_settlement_contract()'::regprocedure)
    INTO v_registered_contract_source;
  SELECT pg_get_functiondef(
           'public.fn_apply_prize_guarantee(uuid,text)'::regprocedure)
    INTO v_guarantee_source;
  IF position('prize pool cannot be reopened' IN v_pool_freeze_source) = 0
     OR position('guaranteed_prize' IN v_pool_freeze_source) = 0
     OR position('guaranteed_prize' IN v_registered_contract_source) = 0
     OR position('finalized_guarantee_is_below_published_floor' IN v_guarantee_source) = 0
     OR position('SET prize_pool_finalized = false' IN v_guarantee_source) > 0
     OR position('atomic_guarantee_funding' IN v_pool_freeze_source) > 0 THEN
    RAISE EXCEPTION 'finalized pool, guarantee or settlement contract can be repriced';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_tournament_payout_reconcile(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_tournament_payout_reconcile(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_tournament_payout_reconcile(uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy payout observation ACL boundary is not canonical';
  END IF;
  SELECT pg_get_functiondef(
           'public.fn_tournament_payout_reconcile(uuid,boolean)'::regprocedure)
    INTO v_legacy_observer_source;
  IF position('IF p_apply THEN' IN v_legacy_observer_source) = 0
     OR position('applying_reconcile_retired' IN v_legacy_observer_source) = 0
     OR position('IF p_apply THEN' IN v_legacy_observer_source)
        > position('SELECT id, prize_pool' IN v_legacy_observer_source)
     OR position('fn_settle_tournament_obligation(' IN v_legacy_observer_source) > 0
     OR position('fn_credit_and_log(' IN v_legacy_observer_source) > 0
     OR position('UPDATE tournament_players' IN v_legacy_observer_source) > 0 THEN
    RAISE EXCEPTION 'legacy payout observation can still enter applying mode';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.ca_money_rpc_registry
     WHERE proname = 'fn_tournament_payout_reconcile'
       AND status = 'legacy'
  ) THEN
    RAISE EXCEPTION 'legacy payout observation registry status is not canonical';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_pay_backed_payout_shortfalls(boolean,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_pay_backed_payout_shortfalls(boolean,integer)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_pay_backed_payout_shortfalls(boolean,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy backed-shortfall observer is application reachable';
  END IF;
  SELECT pg_get_functiondef(
           'public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)
    INTO v_backed_observer_source;
  IF position('IF p_apply THEN' IN v_backed_observer_source) = 0
     OR position('applying_backed_shortfall_retired' IN v_backed_observer_source) = 0
     OR position('IF p_apply THEN' IN v_backed_observer_source)
        > position('FOR r IN' IN v_backed_observer_source)
     OR position('fn_tournament_payout_reconcile(t.id, true)' IN v_backed_observer_source) > 0
     OR position('fn_settle_tournament_obligation(' IN v_backed_observer_source) > 0
     OR position('fn_credit_and_log(' IN v_backed_observer_source) > 0
     OR position('UPDATE tournament_players' IN v_backed_observer_source) > 0
     OR position('''money_path'', ''none''' IN v_backed_observer_source) = 0 THEN
    RAISE EXCEPTION 'legacy backed-shortfall observer can still pay';
  END IF;
  IF has_function_privilege('service_role',
       'public.sp_ca_reconcile_backpaid_events(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy backpaid-event procedure is application reachable';
  END IF;
  SELECT pg_get_functiondef(
           'public.sp_ca_reconcile_backpaid_events(boolean)'::regprocedure)
    INTO v_backpaid_observer_source;
  IF position('IF p_apply THEN' IN v_backpaid_observer_source) = 0
     OR position('applying_backpaid_reconcile_retired' IN v_backpaid_observer_source) = 0
     OR position('IF p_apply THEN' IN v_backpaid_observer_source)
        > position('FOR r IN' IN v_backpaid_observer_source)
     OR position('fn_tournament_payout_reconcile(r.tournament_id, p_apply)'
                  IN v_backpaid_observer_source) > 0
     OR position('COMMIT' IN upper(v_backpaid_observer_source)) > 0 THEN
    RAISE EXCEPTION 'legacy backpaid-event procedure can still apply or commit';
  END IF;
  IF to_regprocedure('public.fn_ca_backpay_guarantee_shortfalls(boolean,integer)')
     IS NOT NULL AND has_function_privilege(
       'service_role',
       'public.fn_ca_backpay_guarantee_shortfalls(boolean,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy guarantee backpay remains application reachable';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_backpay_hu_winner_shortfalls(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_backpay_hu_winner_shortfalls(integer)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_backpay_hu_winner_shortfalls(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy Heads-Up backpay remains application reachable';
  END IF;
  SELECT pg_get_functiondef(
           'public.fn_backpay_hu_winner_shortfalls(integer)'::regprocedure)
    INTO v_hu_observer_source;
  IF position('fn_hu_shortfall_candidates(' IN v_hu_observer_source) = 0
     OR position('''money_path'', ''none''' IN v_hu_observer_source) = 0
     OR position('fn_rank_survivors(' IN v_hu_observer_source) > 0
     OR position('fn_settle_tournament_obligation(' IN v_hu_observer_source) > 0
     OR position('fn_credit_and_log(' IN v_hu_observer_source) > 0
     OR position('UPDATE ' IN upper(v_hu_observer_source)) > 0
     OR position('INSERT ' IN upper(v_hu_observer_source)) > 0
     OR position('DELETE ' IN upper(v_hu_observer_source)) > 0 THEN
    RAISE EXCEPTION 'legacy Heads-Up observer can still repair or pay';
  END IF;
  IF (
    SELECT count(*)
      FROM public.ca_money_rpc_registry
     WHERE proname IN ('fn_tournament_payout_reconcile',
                       'fn_pay_backed_payout_shortfalls',
                       'fn_ca_backpay_guarantee_shortfalls',
                       'sp_ca_reconcile_backpaid_events',
                       'fn_backpay_hu_winner_shortfalls')
       AND status = 'legacy'
  ) <> 5 THEN
    RAISE EXCEPTION 'retired payout-repair registry statuses are not canonical';
  END IF;
  IF has_table_privilege('anon', 'public.tournament_players', 'INSERT')
     OR has_table_privilege('anon', 'public.tournament_players', 'UPDATE')
     OR has_table_privilege('anon', 'public.tournament_players', 'DELETE')
     OR has_table_privilege('authenticated', 'public.tournament_players', 'INSERT')
     OR has_table_privilege('authenticated', 'public.tournament_players', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.tournament_players', 'DELETE') THEN
    RAISE EXCEPTION 'browser roles retain direct tournament player writes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'tournament_players'
       AND policyname IN ('Users can register themselves',
                          'System can update tournament players')
  ) THEN
    RAISE EXCEPTION 'unsafe tournament player write policy still exists';
  END IF;
  IF to_regprocedure('public.atomic_tournament_register(uuid,uuid,text,numeric,numeric,numeric,boolean,uuid)')
     IS NOT NULL AND (
       has_function_privilege('anon',
         'public.atomic_tournament_register(uuid,uuid,text,numeric,numeric,numeric,boolean,uuid)',
         'EXECUTE')
       OR has_function_privilege('authenticated',
         'public.atomic_tournament_register(uuid,uuid,text,numeric,numeric,numeric,boolean,uuid)',
         'EXECUTE')
       OR has_function_privilege('service_role',
         'public.atomic_tournament_register(uuid,uuid,text,numeric,numeric,numeric,boolean,uuid)',
         'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'legacy atomic_tournament_register is reachable';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_apply_prize_guarantee(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_apply_prize_guarantee(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_apply_prize_guarantee(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_apply_prize_guarantee_before_atomic_proof(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'atomic guarantee ACL boundary is not canonical';
  END IF;
  IF has_table_privilege('service_role',
       'public.tournament_guarantee_overlays', 'INSERT')
     OR has_table_privilege('service_role',
       'public.tournament_guarantee_overlays', 'UPDATE')
     OR has_table_privilege('service_role',
       'public.tournament_guarantee_overlays', 'DELETE')
     OR has_table_privilege('service_role',
       'public.tournament_guarantee_overlays', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role can forge a guarantee overlay claim';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_register_for_tournament(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.fn_register_for_tournament(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_register_for_tournament(uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_register_for_tournament(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_register_for_tournament(uuid,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_register_for_tournament(uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)',
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'registration lifecycle ACL boundary is not canonical';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_register_for_tournament'
      AND p.pronargs = 2 AND p.pronargdefaults <> 0
  ) THEN
    RAISE EXCEPTION 'the internal registration boolean remains defaulted';
  END IF;
  IF (SELECT count(*)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'process_tournament_rebuy') <> 1
     OR to_regprocedure('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)')
        IS NULL THEN
    RAISE EXCEPTION 'process_tournament_rebuy overload inventory is not canonical';
  END IF;
  IF has_function_privilege('anon',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege('anon',
       'public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.process_tournament_rebuy_before_atomic_pool_gate(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege('anon',
       'public.process_tournament_rebuy_before_one_minute_addon(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.process_tournament_rebuy_before_one_minute_addon(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.process_tournament_rebuy_before_one_minute_addon(uuid,uuid,text,numeric,numeric,integer,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'process_tournament_rebuy ACL boundary is not canonical';
  END IF;
  /* Keep cron.job in a statement that is reached only when pg_cron exists.
     PostgreSQL resolves relations while preparing a statement, so combining
     this with the namespace test in one boolean expression still breaks a
     pg_cron-free development database. */
  IF to_regnamespace('cron') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-payout-sweep-hourly') THEN
      RAISE EXCEPTION 'the applying payout repair cron is still scheduled';
    END IF;
    IF EXISTS (
      SELECT 1 FROM cron.job
       WHERE active
         AND (
           command ~* 'fn_tournament_payout_sweep[[:space:]]*\([^,]+,[[:space:]]*true([[:space:]]*,|[[:space:]]*\))'
           OR command ~* 'fn_tournament_payout_sweep[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
           OR command ~* 'fn_tournament_payout_reconcile[[:space:]]*\([^,]+,[[:space:]]*true[[:space:]]*\)'
           OR command ~* 'fn_tournament_payout_reconcile[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
           OR command ~* 'fn_pay_backed_payout_shortfalls[[:space:]]*\([[:space:]]*true([[:space:]]*,|[[:space:]]*\))'
           OR command ~* 'fn_pay_backed_payout_shortfalls[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
           OR command ~* 'fn_ca_backpay_guarantee_shortfalls[[:space:]]*\([[:space:]]*true([[:space:]]*,|[[:space:]]*\))'
           OR command ~* 'fn_ca_backpay_guarantee_shortfalls[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
           OR command ~* 'sp_ca_reconcile_backpaid_events[[:space:]]*\([[:space:]]*true[[:space:]]*\)'
           OR command ~* 'sp_ca_reconcile_backpaid_events[^;]*p_apply[[:space:]]*=>[[:space:]]*true'
           OR command ~* 'fn_backpay_hu_winner_shortfalls[[:space:]]*\('
         )
    ) THEN
      RAISE EXCEPTION 'an applying tournament payout command is still scheduled';
    END IF;
  END IF;
  IF to_regprocedure('public.fn_tournament_payout_sweep(integer,boolean,integer)')
     IS NOT NULL AND has_function_privilege(
       'service_role',
       'public.fn_tournament_payout_sweep(integer,boolean,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role can still invoke the payout sweep';
  END IF;
  IF to_regclass('public.ca_settle_sources') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_settle_sources WHERE lower(source) IN ($1, $2))'
      INTO v_legacy_roster_has_job
      USING 'reconcile', 'fn_tournament_payout_reconcile';
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'retired reconcile sources can still settle obligations directly';
    END IF;
  END IF;
  IF to_regclass('public.ca_expected_cron_jobs') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.ca_expected_cron_jobs WHERE jobname = $1)'
      INTO v_legacy_roster_has_job
      USING 'ca-payout-sweep-hourly';
    IF v_legacy_roster_has_job THEN
      RAISE EXCEPTION 'the retired payout repair cron is still in the expected roster';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_alerts
     WHERE resolved IS NOT TRUE
       AND source IN ('fn_tournament_payout_sweep',
                      'fn_tournament_payout_sweep_truncated')
  ) THEN
    RAISE EXCEPTION 'a retired applying payout sweep finding is still open';
  END IF;
END;
$assert$;

COMMIT;
