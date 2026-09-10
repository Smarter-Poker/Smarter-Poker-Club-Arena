-- 20260910042020_stage_b_exact_precondition_repairs
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-10 03:52:25 UTC.
--
-- The final Stage-B authority cannot be installed over ambiguous historical
-- state. Production inspection found two exact split-writer seat generations
-- and one completed atomic satellite whose settlement committed without its
-- immutable finish claim. This boundary runs only while the serialized entry
-- freeze is active, takes the canonical authority lock order, classifies every
-- affected generation from dual accepted-hand journals plus immutable payment
-- evidence, changes no wallet balance, and records every seat/roster mutation.
--
-- It also captures and clears every terminal tournament break residue before
-- the permanent invariant is installed by the next boundary. The one missing
-- finish claim is derived from its immutable settlement batch and canonical
-- winner; no generated identifier is embedded in this migration. Any unknown,
-- partial, duplicate, or changed evidence aborts the whole transaction.

BEGIN;

-- A deployment must fail closed instead of occupying tournament money/seat
-- locks past the short maintenance trough. PostgreSQL 17's transaction budget
-- bounds the complete lock-holding transaction; the other two budgets bound
-- each blocked lock acquisition and statement. A retry is safe because the
-- whole cutover, including its proof row and cron retirement, is atomic.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL transaction_timeout = '180s';

-- Terminal settlement is the root of every tournament identity mutation.
-- Take that root before the historical reconciler lock or any relation lock:
-- cancellation, a paid rebuy seat, and this one-time cutover can then never
-- wait on each other in opposite order. The maintenance lock closes new entry
-- purchases while the evidence below is classified.
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);

-- The freeze predicate is executable cutover authority, not a name to trust.
-- Authenticate its exact body and the statement trigger that serializes every
-- maintenance-row writer before using either the live or pristine branch.
DO $authenticate_entry_freeze_authority$
DECLARE
  v_break_relation oid := to_regclass('public.engine_maintenance_break');
  v_predicate oid := to_regprocedure('public.fn_entry_purchases_frozen()');
  v_writer oid :=
    to_regprocedure('public.fn_serialize_engine_maintenance_break_write()');
  v_relation_owner oid;
BEGIN
  IF v_break_relation IS NULL OR v_predicate IS NULL OR v_writer IS NULL THEN
    RAISE EXCEPTION 'canonical maintenance entry-freeze authority is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relowner INTO STRICT v_relation_owner
    FROM pg_class c WHERE c.oid = v_break_relation;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_predicate
       AND md5(p.prosrc) = 'a29498531e4b7d3889532e80fafc8d57'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'boolean'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'sql'
  ) THEN
    RAISE EXCEPTION 'maintenance entry-freeze predicate is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_writer
       AND md5(p.prosrc) = '084ed24f99e9d08765bd86ff8b920284'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'trigger'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'maintenance-row serialization function is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid = v_break_relation
       AND tg.tgname = 'aa_serialize_maintenance_break_write'
       AND tg.tgfoid = v_writer
       AND NOT tg.tgisinternal
       AND tg.tgenabled = 'O'
       AND tg.tgtype = 62
       AND tg.tgattr::text = ''
       AND tg.tgqual IS NULL
       AND tg.tgnargs = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'maintenance-row serialization trigger is not canonical and enabled'
      USING ERRCODE = '55000';
  END IF;
END;
$authenticate_entry_freeze_authority$;

-- A clean source-controlled replay has no engine that can publish a freeze.
-- Exempt only the exact pristine database. Any account, club, tournament,
-- table, journal leg or ticket is live shape and requires the time-bounded
-- maintenance entry predicate before the historical reconciler can be joined.
DO $require_live_seat_exit_cutover_freeze$
DECLARE
  v_database_is_pristine boolean;
BEGIN
  IF to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL THEN
    RAISE EXCEPTION
      'tournament seat-exit cutover requires the serialized maintenance predicate first';
  END IF;

  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) INTO v_database_is_pristine;

  IF NOT v_database_is_pristine
     AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'tournament seat-exit live cutover requires the maintenance entry freeze'
      USING ERRCODE = '55006';
  END IF;
END;
$require_live_seat_exit_cutover_freeze$;

-- The historical minute reconciler used this exact session advisory lock.
-- Acquire it before any relation lock so a running job can finish before the
-- cutover and no new job can enter: every scheduled invocation uses
-- pg_try_advisory_lock on this same key and therefore skips while this
-- transaction owns it. Managed Supabase deliberately grants postgres SELECT
-- only on cron.job, so relation locking is neither available nor necessary;
-- cron.unschedule removes the postgres-owned row below and the same
-- transaction proves it absent before retiring the callable function.
SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'));

-- Seat assignment enters Daily Missions before tournament rows. Pre-acquire
-- those exact player locks in UUID order so the private 20260909014433 seating
-- core can be reused below without introducing a cutover-only inversion.
DO $cutover_player_lock_prefix$
DECLARE
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT affected.user_id
      FROM (
        SELECT c.eliminated_user_id AS user_id
          FROM public.tournament_knockout_candidates c
          JOIN public.tournaments t ON t.id=c.tournament_id
         WHERE upper(COALESCE(t.status::text,''))='RUNNING'
           AND c.state='pending'
        UNION
        SELECT tp.user_id
          FROM public.tournament_players tp
          JOIN public.tournaments t ON t.id=tp.tournament_id
         WHERE upper(COALESCE(t.status::text,''))='RUNNING'
           AND tp.status='playing' AND COALESCE(tp.chips,0)>0
      ) affected
     ORDER BY affected.user_id
  LOOP
    PERFORM public.fn_lock_daily_mission_user(v_user_id);
  END LOOP;
END;
$cutover_player_lock_prefix$;

-- Seat exits are part of tournament settlement. They are not a generic table
-- cleanup operation and they are not a wallet cash-out. Drain concurrent seat
-- writers while the trigger and every existing atomic owner are cut over.
LOCK TABLE public.tournament_launch_receipts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE;
-- The rolling elimination owner locks the roster and then its candidate, but
-- can update the candidate before its later roster write. Freeze that child
-- before taking the roster relation barrier so an old in-flight invocation
-- can finish or wait; it can never hold a candidate update while waiting on
-- our roster relation lock.
LOCK TABLE public.tournament_knockout_candidates
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_players IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.table_seats IN SHARE ROW EXCLUSIVE MODE;


-- The Stage-B expansion immediately preceding this migration owns these
-- private receipt relations. Lock them with the same transaction that freezes
-- the mutable source rows so no preimage can be changed without its receipt.
LOCK TABLE public.tournament_terminal_break_normalization_receipts
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_finish_receipts
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.tournament_place_settlement_batches IN SHARE MODE;
LOCK TABLE public.tournament_final_table_deal_batches IN SHARE MODE;
LOCK TABLE public.tournament_satellite_settlement_batches IN SHARE MODE;
LOCK TABLE public.tournament_obligations IN SHARE MODE;

-- Freeze one evidence-derived candidate ledger for the cutover transaction.
-- `lead` is calculated across every state, then pending generations plus the
-- one latest already-rebought-but-still-seatless generation are considered:
-- a settled row between two pending rows is still a real generation boundary.
-- Nothing here treats "a newer candidate exists" as proof of payment.
CREATE TEMP TABLE ca_cutover_candidate_windows ON COMMIT DROP AS
WITH ordered AS MATERIALIZED (
  SELECT c.*,
         lead(c.id) OVER generation_order AS next_candidate_id,
         lead(c.created_at) OVER generation_order AS next_candidate_at
    FROM public.tournament_knockout_candidates c
    JOIN public.tournaments t ON t.id=c.tournament_id
   WHERE upper(COALESCE(t.status::text,''))='RUNNING'
  WINDOW generation_order AS (
    PARTITION BY c.tournament_id,c.eliminated_user_id
    ORDER BY c.hand_number,c.id)
)
SELECT c.id AS candidate_id,c.tournament_id,
       c.eliminated_user_id AS user_id,c.table_id AS zero_table_id,
       c.seat_id AS zero_seat_id,c.seat_joined_at AS zero_seat_joined_at,
       c.hand_id AS zero_hac_hand_id,c.hand_number AS zero_hand_number,
       c.state AS candidate_state_before,
       c.resolved_at AS candidate_resolved_at_before,
       k.hand_id AS zero_settlement_hand_id,
       CASE WHEN h.table_id IS NOT NULL AND k.table_id IS NOT NULL
             AND h.stack_result->>'table_id'=c.table_id::text
             AND COALESCE(h.stack_result->>'hand_number','')~'^[0-9]+$'
             AND (h.stack_result->>'hand_number')::bigint=c.hand_number
             AND COALESCE(h.stack_result->'written'->>c.eliminated_user_id::text,'')
                   ~'^-?[0-9]+([.][0-9]+)?$'
             AND (h.stack_result->'written'->>c.eliminated_user_id::text)::numeric=0
             AND h.stack_result->>'success'='true'
             AND k.status='succeeded' AND k.completed_at IS NOT NULL
             AND k.result IS NOT DISTINCT FROM h.stack_result
             AND COALESCE(k.result->'written'->>c.eliminated_user_id::text,'')
                   ~'^-?[0-9]+([.][0-9]+)?$'
             AND (k.result->'written'->>c.eliminated_user_id::text)::numeric=0
            THEN GREATEST(c.created_at,h.committed_at,k.completed_at)
            ELSE NULL END AS zero_committed_at,
       c.next_candidate_id,c.next_candidate_at
  FROM ordered c
  LEFT JOIN public.hand_atomic_commits h
    ON h.table_id=c.table_id AND h.hand_number=c.hand_number
   AND h.hand_id=c.hand_id
  LEFT JOIN public.settlement_idempotency_keys k
    ON k.table_id=c.table_id
   AND k.hand_id::text=h.stack_result->>'hand_id'
   AND COALESCE(k.result->>'hand_number','')~'^[0-9]+$'
   AND (k.result->>'hand_number')::bigint=c.hand_number
 WHERE c.stack_after=0
   AND (c.state='pending' OR (
     c.state='rebought' AND c.next_candidate_id IS NULL
     AND c.resolved_at IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.tournament_players tp
        WHERE tp.tournament_id=c.tournament_id
          AND tp.user_id=c.eliminated_user_id
          AND tp.status='playing' AND tp.chips>0
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats live
            JOIN public.tables live_table ON live_table.id=live.table_id
             WHERE live_table.tournament_id=tp.tournament_id
               AND live.user_id=tp.user_id AND live.left_at IS NULL))));

-- The retired writer's idempotency amount is not a funded amount: it wrote
-- zero while the same transaction wrote the exact positive wallet debit,
-- refund entitlement and immutable ledger leg. Bind that legacy metadata to
-- its canonical per-player purchase ordinal instead of guessing that every
-- valid row is `:#0`. The ordinal is global across this entrant's immutable
-- rebuy inventory, so a second paid generation must prove `:#1`, and so on.
CREATE TEMP TABLE ca_cutover_rebuy_entitlement_ordinals ON COMMIT DROP AS
WITH scoped_players AS MATERIALIZED (
  SELECT DISTINCT w.tournament_id,w.user_id
    FROM ca_cutover_candidate_windows w
)
SELECT e.id AS entitlement_id,e.tournament_id,e.user_id,
       (row_number() OVER (
          PARTITION BY e.tournament_id,e.user_id
          ORDER BY l.chain_seq,e.id)-1)::integer AS purchase_ordinal
  FROM scoped_players scope
  JOIN public.tournament_refund_entitlements e
    ON e.tournament_id=scope.tournament_id AND e.user_id=scope.user_id
   AND e.entitlement_kind='wallet_charge' AND e.charge_category='rebuy'
  JOIN public.chip_ledger l ON l.id=e.source_ledger_id;

-- Keep every refund entitlement in its one non-overlapping knockout interval,
-- including a row whose corroborating journals are malformed. The preflight
-- below compares raw and exact counts, so a weak row aborts rather than being
-- silently omitted from the restored stack.
CREATE TEMP TABLE ca_cutover_candidate_rebuy_payments ON COMMIT DROP AS
SELECT w.candidate_id,w.tournament_id,w.user_id,e.id AS entitlement_id,
       e.source_ledger_id,l.chain_seq AS source_ledger_chain_seq,
       l.row_hash AS source_ledger_row_hash,l.created_at AS paid_at,
       wallet.wallet_transaction_id,idem.purchase_idempotency_key,
       ordinal.purchase_ordinal,idem.purchase_type,
       (w.zero_committed_at IS NOT NULL
        AND e.evidence_kind IN (
          'atomic_wallet_charge','cutover_wallet_charge')
        AND l.tournament_id=w.tournament_id
        AND l.from_type='player_wallet' AND l.from_entity_id=w.user_id
        AND l.to_type='prize_liability' AND l.to_entity_id=w.tournament_id
        AND lower(COALESCE(l.category,''))='rebuy' AND l.status='posted'
        AND l.club_id=e.refund_wallet_club_id
        AND l.amount IS NOT DISTINCT FROM e.gross
        AND l.created_at IS NOT DISTINCT FROM e.created_at
        AND l.amount>0 AND l.amount=round(l.amount,2)
        AND l.chain_seq IS NOT NULL AND l.row_hash IS NOT NULL
        -- The retired rebuy writer stored 0 in wallet_credit_idempotency even
        -- though the same transaction wrote an exact positive wallet debit
        -- and immutable ledger leg. That zero is correlation metadata, never
        -- the funded amount. Admit only its globally ordered canonical key;
        -- every atomic receipt and every differently named key must still
        -- carry the exact gross amount.
        AND (
          idem.purchase_amount IS NOT DISTINCT FROM e.gross
          OR (
            e.evidence_kind='cutover_wallet_charge'
            AND idem.purchase_type='rebuy'
            AND idem.purchase_amount=0
            AND idem.purchase_idempotency_key=
              'tourney:'||w.tournament_id::text||':rebuy:'||
              w.user_id::text||':#'||ordinal.purchase_ordinal::text
          )
        ) IS TRUE
        AND wallet.match_count=1 AND idem.match_count=1) AS exact_rebuy
  FROM ca_cutover_candidate_windows w
  JOIN public.tournament_refund_entitlements e
    ON e.tournament_id=w.tournament_id AND e.user_id=w.user_id
   AND e.entitlement_kind='wallet_charge' AND e.charge_category='rebuy'
   AND e.created_at>w.zero_committed_at
   AND (w.next_candidate_at IS NULL OR e.created_at<w.next_candidate_at)
  JOIN public.chip_ledger l ON l.id=e.source_ledger_id
  JOIN ca_cutover_rebuy_entitlement_ordinals ordinal
    ON ordinal.entitlement_id=e.id
   AND ordinal.tournament_id=w.tournament_id
   AND ordinal.user_id=w.user_id
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS match_count,
           (array_agg(i.key ORDER BY i.key))[1] AS purchase_idempotency_key,
           (array_agg(kind.purchase_type ORDER BY i.key))[1] AS purchase_type,
           (array_agg(i.amount ORDER BY i.key))[1] AS purchase_amount
      FROM public.wallet_credit_idempotency i
      CROSS JOIN (VALUES ('rebuy'::text),('reentry'::text))
        kind(purchase_type)
     WHERE i.user_id=w.user_id AND i.created_at=l.created_at
       AND i.key LIKE 'tourney:'||w.tournament_id::text||':'||
                      kind.purchase_type||':'||w.user_id::text||':%'
  ) idem ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS match_count,
           (array_agg(tx.id ORDER BY tx.id))[1] AS wallet_transaction_id
      FROM public.wallet_transactions tx
     WHERE tx.user_id=w.user_id AND tx.related_entity_id=w.tournament_id
       AND tx.wallet_type='PLAYER' AND tx.type='debit'
       AND lower(COALESCE(tx.category,''))='rebuy'
       AND tx.amount=e.gross AND tx.created_at=l.created_at
       AND tx.description LIKE 'Tournament '||idem.purchase_type||':%'
  ) wallet ON true;

CREATE TEMP TABLE ca_cutover_paid_candidates ON COMMIT DROP AS
SELECT w.candidate_id,w.tournament_id,w.user_id,w.zero_table_id,
       w.zero_seat_id,w.zero_seat_joined_at,w.zero_hand_number,
       w.candidate_state_before,w.candidate_resolved_at_before,
       w.zero_hac_hand_id,w.zero_settlement_hand_id,
       w.zero_committed_at,w.next_candidate_id,w.next_candidate_at,
       count(*)::integer AS payment_count,
       min(p.paid_at) AS first_paid_at,max(p.paid_at) AS last_paid_at,
       array_agg(p.entitlement_id
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS entitlement_ids,
       array_agg(p.source_ledger_id
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS source_ledger_ids,
       array_agg(p.source_ledger_chain_seq
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS source_ledger_chain_seqs,
       array_agg(p.source_ledger_row_hash
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS source_ledger_row_hashes,
       array_agg(p.wallet_transaction_id
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS wallet_transaction_ids,
       array_agg(p.purchase_idempotency_key
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS purchase_idempotency_keys,
       array_agg(p.purchase_ordinal
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS purchase_ordinals,
       array_agg(p.purchase_type
                 ORDER BY p.source_ledger_chain_seq,p.entitlement_id)
         AS purchase_types
  FROM ca_cutover_candidate_windows w
  JOIN ca_cutover_candidate_rebuy_payments p
    ON p.candidate_id=w.candidate_id AND p.exact_rebuy
 GROUP BY w.candidate_id,w.tournament_id,w.user_id,w.zero_table_id,
          w.zero_seat_id,w.zero_seat_joined_at,w.zero_hand_number,
          w.candidate_state_before,w.candidate_resolved_at_before,
          w.zero_hac_hand_id,w.zero_settlement_hand_id,
          w.zero_committed_at,w.next_candidate_id,w.next_candidate_at;

-- A paid generation that subsequently completed another accepted hand is a
-- survivor whose current stack comes only from that hand, never from adding
-- its rebuy grant again. Freeze the exact twelve-row production shape as a
-- separate class: payment follows the zero settlement, the globally later
-- hand follows payment, both hand journals agree, and the departed roster
-- chair carries that same positive stack.
CREATE TEMP TABLE ca_cutover_paid_hand_continuations ON COMMIT DROP AS
SELECT p.candidate_id,p.tournament_id,p.user_id,
       h.hand_number AS last_hand_number,h.hand_id AS last_hac_hand_id,
       k.hand_id AS last_settlement_hand_id
  FROM ca_cutover_paid_candidates p
  JOIN public.tournament_players tp
    ON tp.tournament_id=p.tournament_id AND tp.user_id=p.user_id
   AND tp.status='playing' AND tp.chips>0 AND tp.chips=trunc(tp.chips)
  JOIN LATERAL (
    SELECT committed.*
      FROM public.hand_atomic_commits committed
      JOIN public.tables hand_table ON hand_table.id=committed.table_id
     WHERE hand_table.tournament_id=p.tournament_id
       AND committed.stack_result->'written' ? p.user_id::text
     ORDER BY committed.hand_number DESC,committed.table_id,
              committed.hand_id
     LIMIT 1
  ) h ON h.hand_number>p.zero_hand_number
   AND h.committed_at>p.last_paid_at
   AND h.stack_result->>'table_id'=h.table_id::text
   AND COALESCE(h.stack_result->>'hand_number','')~'^[0-9]+$'
   AND (h.stack_result->>'hand_number')::bigint=h.hand_number
   AND COALESCE(h.stack_result->'written'->>p.user_id::text,'')
         ~'^-?[0-9]+([.][0-9]+)?$'
   AND (h.stack_result->'written'->>p.user_id::text)::numeric=tp.chips
   AND h.stack_result->>'success'='true'
   AND h.post_commit_completed_at IS NOT NULL
   AND h.post_commit_result->>'ok'='true'
  JOIN public.settlement_idempotency_keys k
    ON k.table_id=h.table_id
   AND k.hand_id::text=h.stack_result->>'hand_id'
   AND k.status='succeeded' AND k.completed_at IS NOT NULL
   AND k.result IS NOT DISTINCT FROM h.stack_result
  JOIN public.table_seats s
    ON s.table_id=tp.table_id AND s.seat_number=tp.seat_number
   AND s.user_id=tp.user_id AND s.stack=tp.chips
   AND s.joined_at IS NOT NULL AND s.left_at IS NOT NULL
   AND s.status='active' AND NOT COALESCE(s.leave_pending,false)
   AND h.table_id=s.table_id AND h.committed_at>=s.joined_at
   AND s.left_at>GREATEST(
         h.committed_at,h.post_commit_completed_at,k.completed_at)
 WHERE p.next_candidate_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.table_seats live
     JOIN public.tables live_table ON live_table.id=live.table_id
      WHERE live_table.tournament_id=p.tournament_id
        AND live.user_id=p.user_id AND live.left_at IS NULL)
   AND (SELECT count(*) FROM public.settlement_idempotency_keys exact_key
         WHERE exact_key.table_id=h.table_id
           AND exact_key.hand_id::text=h.stack_result->>'hand_id'
           AND exact_key.status='succeeded'
           AND exact_key.result IS NOT DISTINCT FROM h.stack_result)=1
   AND NOT EXISTS (
     SELECT 1 FROM public.table_seats occupied
      WHERE occupied.table_id=s.table_id
        AND occupied.seat_number=s.seat_number
        AND occupied.left_at IS NULL);

-- Freeze the only zero-roster/live-chair shape that may be changed. The
-- candidate must be the latest exact accepted zero and remain unresolved. The
-- retired reconciler could then reseat that player into a later chair
-- generation without a payment. Bind the current chair through the roster's
-- exact coordinates, require that it began no earlier than the dual-journal
-- zero commit, and keep the immutable candidate generation separate in the
-- receipt. Any newer candidate, later accepted hand or post-zero funding proof
-- makes this shape ineligible and forces the preflight below to fail closed.
CREATE TEMP TABLE ca_cutover_pending_zero_seats ON COMMIT DROP AS
SELECT w.candidate_id,w.tournament_id,w.user_id,
       tp.id AS roster_id,tp.chips::integer AS roster_chips_before,
       w.zero_table_id,w.zero_seat_id,w.zero_seat_joined_at,
       w.zero_hand_number,w.zero_hac_hand_id,w.zero_settlement_hand_id,
       w.zero_committed_at,tb.id AS vacated_table_id,
       s.id AS vacated_seat_id,s.seat_number AS vacated_seat_number,
       s.joined_at AS vacated_joined_at,
       s.stack AS seat_stack_before,
       funding.post_zero_entitlement_count,
       funding.post_zero_chip_ledger_count,
       funding.post_zero_wallet_transaction_count,
       funding.post_zero_wallet_idempotency_count,
       later.later_accepted_hand_count
  FROM ca_cutover_candidate_windows w
  JOIN public.tournament_knockout_candidates c ON c.id=w.candidate_id
  JOIN public.tournament_players tp
    ON tp.tournament_id=w.tournament_id AND tp.user_id=w.user_id
  JOIN public.tables tb
    ON tb.id=tp.table_id AND tb.tournament_id=w.tournament_id
  JOIN public.table_seats s
    ON s.table_id=tp.table_id AND s.seat_number=tp.seat_number
   AND s.user_id=w.user_id AND s.left_at IS NULL
  JOIN LATERAL (
    SELECT count(*)::integer AS player_live_seat_count
      FROM public.table_seats live
      JOIN public.tables live_table ON live_table.id=live.table_id
     WHERE live_table.tournament_id=w.tournament_id
       AND live.user_id=w.user_id AND live.left_at IS NULL
  ) live ON live.player_live_seat_count=1
  JOIN LATERAL (
    SELECT
      (SELECT count(*)::integer
         FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=w.tournament_id AND e.user_id=w.user_id
          AND e.created_at>=w.zero_committed_at)
        AS post_zero_entitlement_count,
      (SELECT count(*)::integer FROM public.chip_ledger l
        WHERE l.tournament_id=w.tournament_id AND l.from_entity_id=w.user_id
          AND lower(COALESCE(l.category,'')) IN ('rebuy','reentry','addon')
          AND l.created_at>=w.zero_committed_at)
        AS post_zero_chip_ledger_count,
      (SELECT count(*)::integer FROM public.wallet_transactions tx
        WHERE tx.related_entity_id=w.tournament_id AND tx.user_id=w.user_id
          AND tx.type='debit'
          AND lower(COALESCE(tx.category,'')) IN ('rebuy','reentry','addon')
          AND tx.created_at>=w.zero_committed_at)
        AS post_zero_wallet_transaction_count,
      (SELECT count(*)::integer FROM public.wallet_credit_idempotency i
        WHERE i.user_id=w.user_id AND i.created_at>=w.zero_committed_at
          AND i.key~('^tourney:'||w.tournament_id::text||
                     ':(rebuy|reentry|addon):'||w.user_id::text||
                     '(:.*)?$'))
        AS post_zero_wallet_idempotency_count
  ) funding ON funding.post_zero_entitlement_count=0
           AND funding.post_zero_chip_ledger_count=0
           AND funding.post_zero_wallet_transaction_count=0
           AND funding.post_zero_wallet_idempotency_count=0
  JOIN LATERAL (
    SELECT count(*)::integer AS later_accepted_hand_count
     FROM public.hand_atomic_commits accepted
      JOIN public.tables accepted_table ON accepted_table.id=accepted.table_id
     WHERE accepted_table.tournament_id=w.tournament_id
       AND accepted.committed_at>w.zero_committed_at
       AND accepted.stack_result->'written' ? w.user_id::text
  ) later ON later.later_accepted_hand_count=0
 WHERE w.next_candidate_id IS NULL
   AND w.candidate_state_before='pending'
   AND w.candidate_resolved_at_before IS NULL
   AND w.zero_committed_at IS NOT NULL
   AND c.tournament_id=w.tournament_id
   AND c.eliminated_user_id=w.user_id
   AND c.table_id=w.zero_table_id AND c.seat_id=w.zero_seat_id
   AND c.seat_joined_at=w.zero_seat_joined_at
   AND c.hand_id=w.zero_hac_hand_id AND c.hand_number=w.zero_hand_number
   AND c.stack_after=0 AND c.state='pending' AND c.resolved_at IS NULL
   AND tp.status='playing' AND tp.chips=0
   AND s.joined_at IS NOT NULL AND s.joined_at>=w.zero_committed_at
   AND s.left_at IS NULL AND s.status='active'
   AND s.stack IS NOT NULL AND s.stack>=0 AND s.stack=trunc(s.stack)
   AND NOT public.fn_ca_has_committed_tournament_receipt(w.tournament_id)
   AND NOT EXISTS (
     SELECT 1 FROM ca_cutover_candidate_rebuy_payments payment
      WHERE payment.candidate_id=w.candidate_id);

-- The old process-start sweep wrote seat and table rows in separate requests.
-- Close its exact historical backlog once while every writer is drained, then
-- record the complete affected identity set before installing the permanent
-- source guard. A receipted terminal event is already immutable proof and may
-- never be repaired here: disagreement with that proof aborts the migration.
DO $terminal_orphan_cutover$
DECLARE
  v_seat_ids uuid[]:=ARRAY[]::uuid[];
  v_table_ids uuid[]:=ARRAY[]::uuid[];
  v_seats_updated integer:=0;
  v_tables_updated integer:=0;
  v_roster_ids uuid[]:=ARRAY[]::uuid[];
  v_chip_roster_ids uuid[]:=ARRAY[]::uuid[];
  v_stakes_table_ids uuid[]:=ARRAY[]::uuid[];
  v_duplicate_table_ids uuid[]:=ARRAY[]::uuid[];
  v_player_count_tournament_ids uuid[]:=ARRAY[]::uuid[];
  v_paid_candidate_ids uuid[]:=ARRAY[]::uuid[];
  v_positive_orphan_seat_ids uuid[]:=ARRAY[]::uuid[];
  v_pending_zero_candidate_ids uuid[]:=ARRAY[]::uuid[];
  v_pending_zero_seat_ids uuid[]:=ARRAY[]::uuid[];
  v_item record;
  v_live record;
  v_destination public.table_seats%ROWTYPE;
  v_seat_after public.table_seats%ROWTYPE;
  v_choice jsonb;
  v_assignment jsonb;
  v_action text;
  v_live_count integer;
  v_stack_before integer;
  v_stack_after integer;
  v_expected_stack bigint;
  v_seat_id uuid;
  v_target_table_id uuid;
  v_target_seat_number integer;
  v_joined_before timestamptz;
  v_joined_after timestamptz;
  v_seat_row_reused boolean;
  v_expected_horse_id uuid;
  v_expected_club_id uuid;
  v_vacated_at timestamptz;
  v_table_current_players_before integer;
  v_table_current_players_after integer;
  v_table_live_seats_before integer;
  v_table_live_seats_after integer;
  v_rows integer;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      LEFT JOIN public.tables tb ON tb.tournament_id=t.id
      LEFT JOIN public.table_seats s
        ON s.table_id=tb.id AND s.left_at IS NULL
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('COMPLETED','CANCELLED','CANCELED')
       AND public.fn_ca_has_committed_tournament_receipt(t.id)
       AND (s.id IS NOT NULL
         OR (tb.id IS NOT NULL AND (
           lower(COALESCE(tb.status,''))<>'closed'
           OR tb.current_players IS DISTINCT FROM 0)))
  ) THEN
    RAISE EXCEPTION
      'a committed terminal receipt disagrees with durable table or seat state'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_seat_ids
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
    JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE s.left_at IS NULL
     AND upper(COALESCE(t.status::text,'')) IN
           ('COMPLETED','CANCELLED','CANCELED')
     AND NOT public.fn_ca_has_committed_tournament_receipt(t.id);

  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_table_ids
    FROM public.tables tb
    JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE upper(COALESCE(t.status::text,'')) IN
           ('COMPLETED','CANCELLED','CANCELED')
     AND NOT public.fn_ca_has_committed_tournament_receipt(t.id)
     AND (lower(COALESCE(tb.status,''))<>'closed'
       OR tb.current_players IS DISTINCT FROM 0);

  UPDATE public.table_seats s
     SET left_at=COALESCE(t.ended_at,transaction_timestamp()),
         status='left',leave_pending=false,is_sitting_out=false,is_away=false,
         sit_out_at=NULL,scheduled_leave_hands=NULL
    FROM public.tables tb,public.tournaments t
   WHERE s.id=ANY(v_seat_ids)
     AND tb.id=s.table_id AND t.id=tb.tournament_id
     AND s.left_at IS NULL;
  GET DIAGNOSTICS v_seats_updated=ROW_COUNT;

  UPDATE public.tables tb
     SET current_players=0,updated_at=now()
   WHERE tb.id=ANY(v_table_ids);
  GET DIAGNOSTICS v_tables_updated=ROW_COUNT;

  IF v_seats_updated<>cardinality(v_seat_ids)
     OR v_tables_updated<>cardinality(v_table_ids) THEN
    RAISE EXCEPTION
      'terminal backlog changed while the cutover owned its write barrier'
      USING ERRCODE='40001';
  END IF;

  -- A later knockout generation is proof that play continued, not proof that
  -- the preceding generation was paid. Every older pending generation must
  -- bind to both zero journals and at least one exact rebuy charge in its own
  -- half-open interval. This replaces the legacy "all but max(joined_at)"
  -- inference with source rows that survive forever.
  IF EXISTS (
    SELECT 1 FROM ca_cutover_candidate_windows w
     WHERE w.next_candidate_id IS NOT NULL
       AND (w.zero_committed_at IS NULL OR NOT EXISTS (
         SELECT 1 FROM ca_cutover_paid_candidates p
          WHERE p.candidate_id=w.candidate_id))
  ) THEN
    RAISE EXCEPTION
      'a later knockout generation has no exact paid rebuy for its predecessor'
      USING ERRCODE='P0404';
  END IF;

  -- A later generation and every positive seatless latest generation are
  -- mandatory classifications. A malformed payment can never be skipped just
  -- because it is the latest row: this cutover will consume that payment to
  -- restore either its exact paid stack or a later accepted-hand continuation.
  IF EXISTS (
    SELECT 1
      FROM ca_cutover_candidate_rebuy_payments p
      JOIN ca_cutover_candidate_windows w
        ON w.candidate_id=p.candidate_id
     WHERE (w.next_candidate_id IS NOT NULL OR EXISTS (
       SELECT 1
         FROM public.tournament_players tp
        WHERE tp.tournament_id=w.tournament_id AND tp.user_id=w.user_id
          AND tp.status='playing' AND tp.chips>0
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats live
            JOIN public.tables live_table ON live_table.id=live.table_id
             WHERE live_table.tournament_id=tp.tournament_id
               AND live.user_id=tp.user_id AND live.left_at IS NULL)))
       AND NOT p.exact_rebuy
  ) THEN
    RAISE EXCEPTION
      'a knockout interval contains a refund entitlement without exact rebuy journals'
      USING ERRCODE='P0404';
  END IF;

  -- A positive seatless roster with knockout history can be repaired only
  -- from the exact latest zero generation and its complete paid journal. A
  -- missing candidate/payment classification is ambiguous and therefore
  -- remains a hard cutover failure.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      JOIN LATERAL (
        SELECT c.id
          FROM public.tournament_knockout_candidates c
         WHERE c.tournament_id=tp.tournament_id
           AND c.eliminated_user_id=tp.user_id
         ORDER BY c.hand_number DESC,c.id DESC
         LIMIT 1
      ) latest_candidate ON true
     WHERE upper(COALESCE(t.status::text,''))='RUNNING'
       AND tp.status='playing' AND tp.chips>0
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats live
         JOIN public.tables live_table ON live_table.id=live.table_id
          WHERE live_table.tournament_id=tp.tournament_id
            AND live.user_id=tp.user_id AND live.left_at IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM ca_cutover_paid_candidates paid
          WHERE paid.candidate_id=latest_candidate.id)
  ) THEN
    RAISE EXCEPTION
      'a positive seatless knockout generation has no exact paid journal'
      USING ERRCODE='P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ca_cutover_paid_candidates p
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id=p.tournament_id AND tp.user_id=p.user_id
      LEFT JOIN public.tournaments t ON t.id=p.tournament_id
     WHERE tp.id IS NULL
        OR (p.next_candidate_id IS NULL AND tp.status<>'playing')
        OR COALESCE(tp.chips,-1)<0 OR COALESCE(tp.chips,-1)<>trunc(tp.chips)
        OR tp.club_id IS NULL
        OR COALESCE(t.rebuy_chips,0)<=0
        OR t.rebuy_chips<>trunc(t.rebuy_chips)
        OR COALESCE(tp.rebuys,0)<>(
          SELECT count(*) FROM public.tournament_refund_entitlements all_paid
           WHERE all_paid.tournament_id=p.tournament_id
             AND all_paid.user_id=p.user_id
             AND all_paid.entitlement_kind='wallet_charge'
             AND all_paid.charge_category='rebuy')
  ) THEN
    RAISE EXCEPTION
      'a paid knockout candidate disagrees with its roster or rebuy inventory'
      USING ERRCODE='P0404';
  END IF;

  -- A latest paid candidate with no live chair is additive only when no later
  -- accepted hand exists. If play followed payment, require the exact frozen
  -- continuation class; current chips then come from that hand and never from
  -- replaying the paid grant.
  IF EXISTS (
    SELECT 1
      FROM ca_cutover_paid_candidates p
     WHERE p.next_candidate_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats live
         JOIN public.tables live_table ON live_table.id=live.table_id
          WHERE live_table.tournament_id=p.tournament_id
            AND live.user_id=p.user_id AND live.left_at IS NULL)
       AND EXISTS (
         SELECT 1 FROM public.hand_atomic_commits later
         JOIN public.tables later_table ON later_table.id=later.table_id
          WHERE later_table.tournament_id=p.tournament_id
            AND later.stack_result->'written' ? p.user_id::text
            -- committed_at is transaction time: a delayed settlement for an
            -- older hand can commit after the rebuy without being later play.
            -- hand_number comes from the global sequence and is the immutable
            -- cross-table chronology for accepted tournament hands.
            AND later.hand_number>p.zero_hand_number)
       AND NOT EXISTS (
         SELECT 1 FROM ca_cutover_paid_hand_continuations continuation
          WHERE continuation.candidate_id=p.candidate_id)
  ) THEN
    RAISE EXCEPTION
      'a paid seatless generation has later play without exact continuation proof'
      USING ERRCODE='P0404';
  END IF;

  FOR v_item IN
    SELECT p.*,tp.id AS roster_id,tp.chips AS current_chips,
           tp.table_id AS roster_table_id,tp.seat_number AS roster_seat_number,
           tp.club_id AS roster_club_id,
           t.rebuy_chips
      FROM ca_cutover_paid_candidates p
      JOIN public.tournament_players tp
        ON tp.tournament_id=p.tournament_id AND tp.user_id=p.user_id
      JOIN public.tournaments t ON t.id=p.tournament_id
     ORDER BY p.zero_committed_at,p.candidate_id
  LOOP
    v_action:='candidate_closed';
    v_stack_before:=v_item.current_chips;
    v_stack_after:=v_item.current_chips;
    v_seat_id:=NULL;
    v_target_table_id:=NULL;
    v_target_seat_number:=NULL;
    v_joined_before:=NULL;
    v_joined_after:=NULL;
    v_seat_row_reused:=NULL;
    v_expected_horse_id:=NULL;
    v_expected_club_id:=NULL;
    v_destination:=NULL;
    v_seat_after:=NULL;

    PERFORM launch.tournament_id
      FROM public.tournament_launch_receipts launch
     WHERE launch.tournament_id=v_item.tournament_id
     FOR UPDATE;
    PERFORM t.id FROM public.tournaments t
     WHERE t.id=v_item.tournament_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'paid candidate tournament vanished during cutover'
        USING ERRCODE='40001';
    END IF;

    SELECT count(*)::integer INTO v_live_count
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=v_item.tournament_id
       AND s.user_id=v_item.user_id AND s.left_at IS NULL;
    IF v_live_count>1 THEN
      RAISE EXCEPTION 'paid candidate player owns multiple live seats'
        USING ERRCODE='P0404';
    END IF;

    IF v_item.candidate_state_before='pending' THEN
      UPDATE public.tournament_knockout_candidates c
         SET state='rebought',resolved_at=v_item.first_paid_at
       WHERE c.id=v_item.candidate_id AND c.state='pending'
         AND c.resolved_at IS NULL
         AND c.tournament_id=v_item.tournament_id
         AND c.eliminated_user_id=v_item.user_id
         AND c.table_id=v_item.zero_table_id
         AND c.seat_id=v_item.zero_seat_id
         AND c.seat_joined_at=v_item.zero_seat_joined_at
         AND c.hand_id=v_item.zero_hac_hand_id
         AND c.hand_number=v_item.zero_hand_number AND c.stack_after=0;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'paid knockout candidate changed during cutover'
          USING ERRCODE='40001';
      END IF;
    ELSIF v_item.candidate_state_before='rebought' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.tournament_knockout_candidates c
         WHERE c.id=v_item.candidate_id AND c.state='rebought'
           AND c.resolved_at IS NOT DISTINCT FROM
                 v_item.candidate_resolved_at_before
           AND c.tournament_id=v_item.tournament_id
           AND c.eliminated_user_id=v_item.user_id
           AND c.table_id=v_item.zero_table_id
           AND c.seat_id=v_item.zero_seat_id
           AND c.seat_joined_at=v_item.zero_seat_joined_at
           AND c.hand_id=v_item.zero_hac_hand_id
           AND c.hand_number=v_item.zero_hand_number AND c.stack_after=0
      ) THEN
        RAISE EXCEPTION 'already-rebought candidate changed during cutover'
          USING ERRCODE='40001';
      END IF;
    ELSE
      RAISE EXCEPTION 'paid candidate entered from an unsupported state'
        USING ERRCODE='P0404';
    END IF;

    IF v_item.next_candidate_id IS NULL AND v_live_count=1 THEN
      SELECT s.* INTO STRICT v_live
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=v_item.tournament_id
         AND s.user_id=v_item.user_id AND s.left_at IS NULL;
      IF v_live.stack IS NULL OR v_live.stack<=0
         OR v_live.stack<>trunc(v_live.stack)
         OR v_live.stack::integer IS DISTINCT FROM v_item.current_chips THEN
        RAISE EXCEPTION 'paid live candidate has no exact positive stack mirror'
          USING ERRCODE='P0404';
      END IF;
      v_seat_id:=v_live.id;
      v_target_table_id:=v_live.table_id;
      v_target_seat_number:=v_live.seat_number;
      v_joined_before:=v_live.joined_at;
      v_joined_after:=v_live.joined_at;

      -- The skipped rebuy hook left some players in the same physical seat
      -- generation as the zero candidate. Rotate that mutable generation at
      -- the first exact payment; the candidate preserves the old joined_at,
      -- and this receipt preserves both sides of the transition.
      IF v_live.id=v_item.zero_seat_id
         AND v_live.joined_at=v_item.zero_seat_joined_at THEN
        IF v_item.first_paid_at<=v_live.joined_at THEN
          RAISE EXCEPTION 'paid live generation does not advance its zero seat'
            USING ERRCODE='P0404';
        END IF;
        UPDATE public.table_seats s
           SET joined_at=v_item.first_paid_at
         WHERE s.id=v_live.id AND s.left_at IS NULL
           AND s.user_id=v_item.user_id
           AND s.joined_at=v_item.zero_seat_joined_at
           AND s.stack=v_item.current_chips;
        GET DIAGNOSTICS v_rows=ROW_COUNT;
        IF v_rows<>1 THEN
          RAISE EXCEPTION 'paid live seat generation changed during rotation'
            USING ERRCODE='40001';
        END IF;
        v_action:='live_generation_rotated';
        v_joined_after:=v_item.first_paid_at;
      ELSIF v_live.joined_at<v_item.first_paid_at THEN
        RAISE EXCEPTION 'paid live seat is neither the zero generation nor a later one'
          USING ERRCODE='P0404';
      END IF;

      SELECT s.* INTO STRICT v_seat_after
        FROM public.table_seats s
       WHERE s.id=v_live.id AND s.left_at IS NULL
         AND s.user_id=v_item.user_id;

      UPDATE public.tournament_players tp
         SET rebuy_prompt_until=NULL
       WHERE tp.id=v_item.roster_id AND tp.status='playing';
    ELSIF v_item.next_candidate_id IS NULL AND EXISTS (
      SELECT 1
        FROM ca_cutover_paid_hand_continuations continuation
       WHERE continuation.candidate_id=v_item.candidate_id
    ) THEN
      -- This generation already consumed its paid grant and then completed a
      -- later accepted hand. Its positive roster stack is therefore an
      -- immutable hand result, not an amount to which the rebuy may be added
      -- again. Close only the historical prompt/candidate state here; the
      -- accepted-hand continuation is reseated by the positive-orphan class
      -- below from that exact non-minted stack.
      UPDATE public.tournament_players tp
         SET rebuy_prompt_until=NULL
       WHERE tp.id=v_item.roster_id AND tp.status='playing'
         AND tp.chips=v_item.current_chips;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'paid accepted-hand continuation changed during closure'
          USING ERRCODE='40001';
      END IF;
      v_action:='candidate_closed';
    ELSIF v_item.next_candidate_id IS NULL THEN
      -- A rebuy adds one stack; a re-entry resets the stack. Replay the exact
      -- immutable purchase order from the global ledger sequence, counting
      -- only the final re-entry and purchases after it. This also handles all
      -- paid generations containing more than one accepted charge.
      SELECT count(*)::bigint*v_item.rebuy_chips::bigint
        INTO v_expected_stack
        FROM unnest(v_item.purchase_types) WITH ORDINALITY
          kind(purchase_type,position)
       WHERE kind.position>=COALESCE((
         SELECT max(reentry.position)
           FROM unnest(v_item.purchase_types) WITH ORDINALITY
             reentry(purchase_type,position)
          WHERE reentry.purchase_type='reentry'),1);
      IF v_expected_stack<=0 OR v_expected_stack>2147483647
         OR v_item.current_chips>v_expected_stack THEN
        RAISE EXCEPTION 'stranded rebuy stack cannot be reconstructed exactly'
          USING ERRCODE='P0404';
      END IF;

      UPDATE public.tournament_players tp
         SET chips=v_expected_stack::integer,rebuy_prompt_until=NULL
       WHERE tp.id=v_item.roster_id AND tp.status='playing'
         AND tp.chips=v_item.current_chips;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'stranded rebuy roster changed during restoration'
          USING ERRCODE='40001';
      END IF;

      v_choice:=public.fn_ca_choose_tournament_seat_locked(
        v_item.tournament_id,v_item.user_id,
        v_item.roster_table_id,v_item.roster_seat_number);
      IF COALESCE((v_choice->>'ok')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'stranded rebuy has no atomic seat: %',v_choice
          USING ERRCODE='P0404';
      END IF;
      v_target_table_id:=(v_choice->>'table_id')::uuid;
      v_target_seat_number:=(v_choice->>'seat_number')::integer;

      -- Snapshot a physical destination before the private 20260909014433
      -- assignment core normalizes it. That core writes an identical complete
      -- occupant shape for INSERT and reuse; this cutover independently proves
      -- the result and freezes both sides in its owner-only detail receipt.
      SELECT CASE WHEN COALESCE(p.is_horse,false) THEN p.id ELSE NULL END
        INTO v_expected_horse_id
        FROM public.profiles p
       WHERE p.id=v_item.user_id;
      v_expected_club_id:=public.fn_seat_club_for_user(
        v_item.user_id,v_target_table_id,v_item.roster_club_id);
      IF v_expected_club_id IS NULL THEN
        RAISE EXCEPTION 'stranded rebuy target has no canonical seat club'
          USING ERRCODE='P0404';
      END IF;

      SELECT s.* INTO v_destination
        FROM public.table_seats s
       WHERE s.table_id=v_target_table_id
         AND s.seat_number=v_target_seat_number
       FOR UPDATE;
      IF FOUND THEN
        IF v_destination.left_at IS NULL THEN
          RAISE EXCEPTION 'stranded rebuy destination changed before assignment'
            USING ERRCODE='40001';
        END IF;
        v_seat_row_reused:=true;
      ELSE
        v_seat_row_reused:=false;
      END IF;

      v_assignment:=public.fn_ca_assign_tournament_player_seat_locked(
        v_item.tournament_id,v_item.user_id,
        v_target_table_id,v_target_seat_number);
      IF COALESCE((v_assignment->>'ok')::boolean,false) IS NOT TRUE
         OR COALESCE((v_assignment->>'replayed')::boolean,true)
         OR (v_assignment->>'stack')::numeric<>v_expected_stack
         OR (v_assignment->>'table_id')::uuid<>v_target_table_id
         OR (v_assignment->>'seat_number')::integer<>v_target_seat_number THEN
        RAISE EXCEPTION 'stranded rebuy atomic seat did not return an exact receipt: %',
          v_assignment USING ERRCODE='P0404';
      END IF;
      v_action:='stranded_stack_seated';
      v_stack_after:=v_expected_stack::integer;
      v_seat_id:=(v_assignment->>'seat_id')::uuid;
      v_joined_after:=(v_assignment->>'assigned_at')::timestamptz;
      SELECT s.* INTO STRICT v_seat_after
        FROM public.table_seats s
       WHERE s.id=v_seat_id AND s.left_at IS NULL
         AND s.user_id=v_item.user_id;
      IF v_seat_after.player_id IS NOT NULL
         OR v_seat_after.member_id IS NOT NULL
         OR v_seat_after.horse_id IS DISTINCT FROM v_expected_horse_id
         OR v_seat_after.club_id IS DISTINCT FROM v_expected_club_id
         OR v_seat_after.is_sitting_out IS DISTINCT FROM false
         OR v_seat_after.is_away IS DISTINCT FROM false
         OR v_seat_after.sit_out_at IS NOT NULL
         OR v_seat_after.scheduled_leave_hands IS NOT NULL
         OR v_seat_after.left_at IS NOT NULL
         OR v_seat_after.status IS DISTINCT FROM 'active'
         OR v_seat_after.leave_pending IS DISTINCT FROM false
         OR v_seat_after.auto_rebuy IS DISTINCT FROM false
         OR v_seat_after.time_bank_remaining IS DISTINCT FROM 30
         OR v_seat_after.time_bank_uses_remaining IS DISTINCT FROM 4
         OR v_seat_after.entry_hold IS NOT NULL
         OR v_seat_after.entry_post_agreed IS DISTINCT FROM false THEN
        RAISE EXCEPTION
          'stranded rebuy chair retained state from a departed occupant'
          USING ERRCODE='P0404';
      END IF;
    END IF;

    INSERT INTO public.tournament_paid_candidate_cutover_receipts(
      candidate_id,migration_version,tournament_id,user_id,roster_id,
      candidate_state_before,candidate_resolved_at_before,
      zero_table_id,zero_seat_id,zero_seat_joined_at,zero_hand_number,
      zero_hac_hand_id,zero_settlement_hand_id,entitlement_ids,
      source_ledger_ids,source_ledger_chain_seqs,source_ledger_row_hashes,
      wallet_transaction_ids,purchase_idempotency_keys,purchase_ordinals,
      purchase_types,
      payment_count,
      first_paid_at,last_paid_at,rebuy_chips,stack_before,stack_after,
      seat_id,table_id,seat_number,seat_joined_at_before,
      seat_joined_at_after,seat_row_reused,
      destination_seat_id_before,destination_user_id_before,
      destination_player_id_before,destination_member_id_before,
      destination_stack_before,destination_is_sitting_out_before,
      destination_is_away_before,destination_joined_at_before,
      destination_horse_id_before,destination_scheduled_leave_hands_before,
      destination_left_at_before,destination_status_before,
      destination_leave_pending_before,destination_auto_rebuy_before,
      destination_time_bank_remaining_before,
      destination_time_bank_uses_remaining_before,
      destination_club_id_before,destination_sit_out_at_before,
      destination_entry_hold_before,destination_entry_post_agreed_before,
      seat_player_id,seat_member_id,
      seat_horse_id,seat_club_id,seat_is_sitting_out,seat_is_away,
      seat_sit_out_at,seat_scheduled_leave_hands,seat_left_at,seat_status,
      seat_leave_pending,seat_auto_rebuy,
      seat_time_bank_remaining,seat_time_bank_uses_remaining,
      seat_entry_hold,seat_entry_post_agreed,repair_action,repaired_at)
    VALUES(
      v_item.candidate_id,'20260910042020_stage_b_exact_precondition_repairs',v_item.tournament_id,
      v_item.user_id,v_item.roster_id,v_item.candidate_state_before,
      v_item.candidate_resolved_at_before,v_item.zero_table_id,
      v_item.zero_seat_id,v_item.zero_seat_joined_at,v_item.zero_hand_number,
      v_item.zero_hac_hand_id,v_item.zero_settlement_hand_id,
      v_item.entitlement_ids,v_item.source_ledger_ids,
      v_item.source_ledger_chain_seqs,v_item.source_ledger_row_hashes,
      v_item.wallet_transaction_ids,v_item.purchase_idempotency_keys,
      v_item.purchase_ordinals,v_item.purchase_types,v_item.payment_count,
      v_item.first_paid_at,v_item.last_paid_at,
      v_item.rebuy_chips,v_stack_before,v_stack_after,v_seat_id,
      v_target_table_id,v_target_seat_number,v_joined_before,
      v_joined_after,v_seat_row_reused,v_destination.id,
      v_destination.user_id,v_destination.player_id,v_destination.member_id,
      v_destination.stack,v_destination.is_sitting_out,v_destination.is_away,
      v_destination.joined_at,v_destination.horse_id,
      v_destination.scheduled_leave_hands,v_destination.left_at,
      v_destination.status,v_destination.leave_pending,
      v_destination.auto_rebuy,v_destination.time_bank_remaining,
      v_destination.time_bank_uses_remaining,v_destination.club_id,
      v_destination.sit_out_at,v_destination.entry_hold,
      v_destination.entry_post_agreed,v_seat_after.player_id,
      v_seat_after.member_id,v_seat_after.horse_id,v_seat_after.club_id,
      v_seat_after.is_sitting_out,v_seat_after.is_away,
      v_seat_after.sit_out_at,v_seat_after.scheduled_leave_hands,
      v_seat_after.left_at,v_seat_after.status,v_seat_after.leave_pending,
      v_seat_after.auto_rebuy,v_seat_after.time_bank_remaining,
      v_seat_after.time_bank_uses_remaining,v_seat_after.entry_hold,
      v_seat_after.entry_post_agreed,v_action,transaction_timestamp());
  END LOOP;

  SELECT COALESCE(array_agg(r.candidate_id ORDER BY r.candidate_id),
                          ARRAY[]::uuid[])
    INTO v_paid_candidate_ids
    FROM public.tournament_paid_candidate_cutover_receipts r;

  -- Every remaining positive seatless roster is an accepted-hand survivor,
  -- never a stack to synthesize. Two non-overlapping immutable evidence
  -- classes are allowed: no knockout generation exists, or the latest zero
  -- generation has the exact paid-rebuy receipt above and its next accepted
  -- hand wrote the current stack. The source chair may belong to a table that
  -- the retired clear already closed, so select a fresh legal destination
  -- through the database chooser instead of assuming that historical chair
  -- remains assignable.
  FOR v_item IN
    WITH positive_seatless AS MATERIALIZED (
      SELECT tp.id AS roster_id,tp.tournament_id,tp.user_id,tp.table_id,
             tp.seat_number,tp.chips,tp.club_id AS roster_club_id
        FROM public.tournament_players tp
        JOIN public.tournaments t ON t.id=tp.tournament_id
       WHERE upper(COALESCE(t.status::text,''))='RUNNING'
         AND tp.status='playing' AND tp.chips>0
         AND tp.chips=trunc(tp.chips)
         AND NOT public.fn_ca_has_committed_tournament_receipt(t.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.table_seats live
           JOIN public.tables live_table ON live_table.id=live.table_id
            WHERE live_table.tournament_id=tp.tournament_id
              AND live.user_id=tp.user_id AND live.left_at IS NULL)
    )
    SELECT p.*,s.id AS source_seat_id,s.stack AS source_stack,
           s.joined_at AS source_joined_at,s.left_at AS source_left_at,
           s.status AS source_status,s.player_id AS source_player_id,
           s.member_id AS source_member_id,s.horse_id AS source_horse_id,
           s.club_id AS source_club_id,
           s.is_sitting_out AS source_is_sitting_out,
           s.is_away AS source_is_away,s.sit_out_at AS source_sit_out_at,
           s.scheduled_leave_hands AS source_scheduled_leave_hands,
           s.auto_rebuy AS source_auto_rebuy,
           s.time_bank_remaining AS source_time_bank_remaining,
           s.time_bank_uses_remaining AS source_time_bank_uses_remaining,
           s.entry_hold AS source_entry_hold,
           s.entry_post_agreed AS source_entry_post_agreed,
           h.hand_number AS last_hand_number,
           h.hand_id AS last_hac_hand_id,k.hand_id AS last_settlement_hand_id,
           CASE WHEN continuation.candidate_id IS NULL
                  THEN 'accepted_hand_no_ko'
                ELSE 'accepted_hand_after_paid_rebuy'
             END AS evidence_class,
           continuation.candidate_id AS paid_candidate_id
      FROM positive_seatless p
      JOIN public.tables tb ON tb.id=p.table_id
       AND tb.tournament_id=p.tournament_id
       AND NOT COALESCE(tb.is_deleted,false)
      JOIN public.table_seats s ON s.table_id=p.table_id
       AND s.seat_number=p.seat_number AND s.user_id=p.user_id
       AND s.joined_at IS NOT NULL AND s.left_at IS NOT NULL
       AND s.status='active'
       AND NOT COALESCE(s.leave_pending,false)
       AND s.stack=p.chips
      JOIN public.profiles profile ON profile.id=p.user_id
      JOIN LATERAL (
        SELECT committed.*
          FROM public.hand_atomic_commits committed
          JOIN public.tables hand_table ON hand_table.id=committed.table_id
         WHERE hand_table.tournament_id=p.tournament_id
           AND committed.stack_result->'written' ? p.user_id::text
         ORDER BY committed.hand_number DESC,committed.table_id,
                  committed.hand_id
         LIMIT 1
      ) h ON h.table_id=s.table_id
       AND h.stack_result->>'table_id'=s.table_id::text
       AND COALESCE(h.stack_result->>'hand_number','')~'^[0-9]+$'
       AND (h.stack_result->>'hand_number')::bigint=h.hand_number
       AND COALESCE(h.stack_result->'written'->>p.user_id::text,'')
             ~'^-?[0-9]+([.][0-9]+)?$'
       AND (h.stack_result->'written'->>p.user_id::text)::numeric=p.chips
       AND h.stack_result->>'success'='true'
       AND h.post_commit_completed_at IS NOT NULL
       AND h.post_commit_result->>'ok'='true'
      JOIN public.settlement_idempotency_keys k
        ON k.table_id=h.table_id
       AND k.hand_id::text=h.stack_result->>'hand_id'
       AND k.status='succeeded' AND k.result IS NOT DISTINCT FROM h.stack_result
      LEFT JOIN ca_cutover_paid_hand_continuations continuation
        ON continuation.tournament_id=p.tournament_id
       AND continuation.user_id=p.user_id
       AND continuation.last_hand_number=h.hand_number
       AND continuation.last_hac_hand_id=h.hand_id
       AND continuation.last_settlement_hand_id=k.hand_id
     WHERE p.table_id IS NOT NULL AND p.seat_number BETWEEN 1 AND 10
       AND p.roster_club_id IS NOT NULL
       AND s.player_id IS NULL AND s.member_id IS NULL
       AND s.horse_id IS NOT DISTINCT FROM
             CASE WHEN COALESCE(profile.is_horse,false)
                    THEN profile.id ELSE NULL END
       AND s.club_id IS NOT NULL
       AND (continuation.candidate_id IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c
          WHERE c.tournament_id=p.tournament_id
            AND c.eliminated_user_id=p.user_id))
       AND (SELECT count(*) FROM public.settlement_idempotency_keys exact_key
            WHERE exact_key.table_id=h.table_id
              AND exact_key.hand_id::text=h.stack_result->>'hand_id'
              AND exact_key.status='succeeded'
              AND exact_key.result IS NOT DISTINCT FROM h.stack_result)=1
       AND h.committed_at>=s.joined_at
       AND s.left_at>GREATEST(h.committed_at,h.post_commit_completed_at,k.completed_at)
       AND NOT EXISTS (
         SELECT 1 FROM public.hand_atomic_commits later_global
         JOIN public.tables later_global_table
           ON later_global_table.id=later_global.table_id
          WHERE later_global_table.tournament_id=p.tournament_id
            AND later_global.stack_result->'written' ? p.user_id::text
            AND later_global.hand_number>h.hand_number)
     ORDER BY p.tournament_id,p.user_id
  LOOP
    PERFORM launch.tournament_id
      FROM public.tournament_launch_receipts launch
     WHERE launch.tournament_id=v_item.tournament_id
     FOR UPDATE;
    PERFORM t.id FROM public.tournaments t
     WHERE t.id=v_item.tournament_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'positive orphan tournament vanished during cutover'
        USING ERRCODE='40001';
    END IF;
    v_destination:=NULL;
    v_seat_after:=NULL;
    v_expected_horse_id:=v_item.source_horse_id;
    v_choice:=public.fn_ca_choose_tournament_seat_locked(
      v_item.tournament_id,v_item.user_id,
      v_item.table_id,v_item.seat_number);
    IF COALESCE((v_choice->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'positive accepted-hand survivor has no atomic seat: %',
        v_choice USING ERRCODE='P0404';
    END IF;
    v_target_table_id:=(v_choice->>'table_id')::uuid;
    v_target_seat_number:=(v_choice->>'seat_number')::integer;
    v_expected_club_id:=public.fn_seat_club_for_user(
      v_item.user_id,v_target_table_id,v_item.roster_club_id);
    IF v_expected_club_id IS NULL THEN
      RAISE EXCEPTION 'positive accepted-hand target has no canonical seat club'
        USING ERRCODE='P0404';
    END IF;

    SELECT s.* INTO v_destination
      FROM public.table_seats s
     WHERE s.table_id=v_target_table_id
       AND s.seat_number=v_target_seat_number
     FOR UPDATE;
    IF FOUND THEN
      IF v_destination.left_at IS NULL THEN
        RAISE EXCEPTION 'positive accepted-hand destination changed before assignment'
          USING ERRCODE='40001';
      END IF;
      v_seat_row_reused:=true;
    ELSE
      v_seat_row_reused:=false;
    END IF;

    v_assignment:=public.fn_ca_assign_tournament_player_seat_locked(
      v_item.tournament_id,v_item.user_id,
      v_target_table_id,v_target_seat_number);
    IF COALESCE((v_assignment->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_assignment->>'replayed')::boolean,true)
       OR (v_assignment->>'stack')::numeric<>v_item.chips
       OR (v_assignment->>'table_id')::uuid<>v_target_table_id
       OR (v_assignment->>'seat_number')::integer<>v_target_seat_number THEN
      RAISE EXCEPTION 'positive accepted-hand survivor did not reseat exactly: %',
        v_assignment USING ERRCODE='P0404';
    END IF;
    v_seat_id:=(v_assignment->>'seat_id')::uuid;
    v_joined_after:=(v_assignment->>'assigned_at')::timestamptz;

    -- This is a reseat of the same accepted-hand continuation, not a paid new
    -- entry generation. The common assignment core correctly starts a new
    -- occupant at 30/4; restore only this same user's cached time bank so the
    -- historical generic clear cannot mint extra decision time.
    UPDATE public.table_seats s
       SET time_bank_remaining=v_item.source_time_bank_remaining,
           time_bank_uses_remaining=v_item.source_time_bank_uses_remaining
     WHERE s.id=v_seat_id AND s.left_at IS NULL
       AND s.user_id=v_item.user_id
       AND s.table_id=v_target_table_id
       AND s.seat_number=v_target_seat_number
       AND s.joined_at=v_joined_after;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'positive orphan time bank changed during revival'
        USING ERRCODE='40001';
    END IF;
    SELECT s.* INTO STRICT v_seat_after
      FROM public.table_seats s
     WHERE s.id=v_seat_id AND s.left_at IS NULL
       AND s.user_id=v_item.user_id AND s.table_id=v_target_table_id
       AND s.seat_number=v_target_seat_number AND s.stack=v_item.chips;
    IF v_seat_after.joined_at IS DISTINCT FROM
         (v_assignment->>'assigned_at')::timestamptz
       OR v_seat_after.player_id IS NOT NULL
       OR v_seat_after.member_id IS NOT NULL
       OR v_seat_after.horse_id IS DISTINCT FROM v_expected_horse_id
       OR v_seat_after.club_id IS DISTINCT FROM v_expected_club_id
       OR v_seat_after.is_sitting_out IS DISTINCT FROM false
       OR v_seat_after.is_away IS DISTINCT FROM false
       OR v_seat_after.sit_out_at IS NOT NULL
       OR v_seat_after.scheduled_leave_hands IS NOT NULL
       OR v_seat_after.left_at IS NOT NULL
       OR v_seat_after.status IS DISTINCT FROM 'active'
       OR v_seat_after.leave_pending IS DISTINCT FROM false
       OR v_seat_after.auto_rebuy IS DISTINCT FROM false
       OR v_seat_after.time_bank_remaining IS DISTINCT FROM
            v_item.source_time_bank_remaining
       OR v_seat_after.time_bank_uses_remaining IS DISTINCT FROM
            v_item.source_time_bank_uses_remaining
       OR v_seat_after.entry_hold IS NOT NULL
      OR v_seat_after.entry_post_agreed IS DISTINCT FROM false THEN
      RAISE EXCEPTION
        'positive accepted-hand reseat did not preserve its own state exactly'
        USING ERRCODE='P0404';
    END IF;
    INSERT INTO public.tournament_positive_orphan_cutover_receipts(
      source_seat_id,migration_version,tournament_id,user_id,roster_id,
      table_id,seat_number,stack,source_joined_at,source_left_at,source_status,
      source_player_id,source_member_id,source_horse_id,source_club_id,
      source_is_sitting_out,source_is_away,source_sit_out_at,
      source_scheduled_leave_hands,source_auto_rebuy,
      source_time_bank_remaining,source_time_bank_uses_remaining,
      source_entry_hold,source_entry_post_agreed,
      last_hand_number,last_hac_hand_id,last_settlement_hand_id,
      evidence_class,paid_candidate_id,
      revived_seat_id,revived_table_id,revived_seat_number,
      revived_joined_at,seat_row_reused,
      destination_seat_id_before,destination_user_id_before,
      destination_player_id_before,destination_member_id_before,
      destination_stack_before,destination_is_sitting_out_before,
      destination_is_away_before,destination_joined_at_before,
      destination_horse_id_before,destination_scheduled_leave_hands_before,
      destination_left_at_before,destination_status_before,
      destination_leave_pending_before,destination_auto_rebuy_before,
      destination_time_bank_remaining_before,
      destination_time_bank_uses_remaining_before,
      destination_club_id_before,destination_sit_out_at_before,
      destination_entry_hold_before,destination_entry_post_agreed_before,
      revived_player_id,
      revived_member_id,revived_horse_id,revived_club_id,
      revived_is_sitting_out,revived_is_away,revived_sit_out_at,
      revived_scheduled_leave_hands,revived_left_at,revived_status,
      revived_leave_pending,revived_auto_rebuy,
      revived_time_bank_remaining,revived_time_bank_uses_remaining,
      revived_entry_hold,revived_entry_post_agreed,repaired_at)
    VALUES(
      v_item.source_seat_id,'20260910042020_stage_b_exact_precondition_repairs',v_item.tournament_id,
      v_item.user_id,v_item.roster_id,v_item.table_id,v_item.seat_number,
      v_item.chips,v_item.source_joined_at,v_item.source_left_at,
      v_item.source_status,v_item.source_player_id,v_item.source_member_id,
      v_item.source_horse_id,v_item.source_club_id,
      v_item.source_is_sitting_out,v_item.source_is_away,
      v_item.source_sit_out_at,v_item.source_scheduled_leave_hands,
      v_item.source_auto_rebuy,v_item.source_time_bank_remaining,
      v_item.source_time_bank_uses_remaining,v_item.source_entry_hold,
      v_item.source_entry_post_agreed,v_item.last_hand_number,
      v_item.last_hac_hand_id,v_item.last_settlement_hand_id,
      v_item.evidence_class,v_item.paid_candidate_id,
      v_seat_id,v_target_table_id,v_target_seat_number,v_joined_after,
      v_seat_row_reused,v_destination.id,v_destination.user_id,
      v_destination.player_id,v_destination.member_id,v_destination.stack,
      v_destination.is_sitting_out,v_destination.is_away,
      v_destination.joined_at,v_destination.horse_id,
      v_destination.scheduled_leave_hands,v_destination.left_at,
      v_destination.status,v_destination.leave_pending,
      v_destination.auto_rebuy,v_destination.time_bank_remaining,
      v_destination.time_bank_uses_remaining,v_destination.club_id,
      v_destination.sit_out_at,v_destination.entry_hold,
      v_destination.entry_post_agreed,
      v_seat_after.player_id,v_seat_after.member_id,v_seat_after.horse_id,
      v_seat_after.club_id,v_seat_after.is_sitting_out,v_seat_after.is_away,
      v_seat_after.sit_out_at,v_seat_after.scheduled_leave_hands,
      v_seat_after.left_at,v_seat_after.status,v_seat_after.leave_pending,
      v_seat_after.auto_rebuy,v_seat_after.time_bank_remaining,
      v_seat_after.time_bank_uses_remaining,v_seat_after.entry_hold,
      v_seat_after.entry_post_agreed,transaction_timestamp());
  END LOOP;

  SELECT COALESCE(array_agg(r.source_seat_id ORDER BY r.source_seat_id),
                          ARRAY[]::uuid[])
    INTO v_positive_orphan_seat_ids
    FROM public.tournament_positive_orphan_cutover_receipts r;

  -- A playing zero roster is already committed by the accepted hand. Its later
  -- unpaid chair is not another chip authority. Vacate only the frozen exact
  -- latest pending generation above; any other zero/live shape is ambiguous
  -- and must abort before the generic positive mirror can run.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
     WHERE upper(COALESCE(t.status::text,''))='RUNNING'
       AND tp.status='playing' AND tp.chips=0
       AND EXISTS (
         SELECT 1 FROM public.table_seats live
         JOIN public.tables live_table ON live_table.id=live.table_id
          WHERE live_table.tournament_id=tp.tournament_id
            AND live.user_id=tp.user_id AND live.left_at IS NULL)
       AND (SELECT count(*) FROM ca_cutover_pending_zero_seats exact_zero
             WHERE exact_zero.roster_id=tp.id)<>1
  ) THEN
    RAISE EXCEPTION
      'a zero-chip playing roster has a live seat without one exact unpaid pending-zero candidate'
      USING ERRCODE='P0404';
  END IF;

  FOR v_item IN
    SELECT exact_zero.*
      FROM ca_cutover_pending_zero_seats exact_zero
     ORDER BY exact_zero.zero_committed_at,exact_zero.candidate_id
  LOOP
    SELECT tb.current_players
      INTO v_table_current_players_before
      FROM public.tables tb
     WHERE tb.id=v_item.vacated_table_id
       AND tb.tournament_id=v_item.tournament_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending-zero table changed before exact vacancy'
        USING ERRCODE='40001';
    END IF;

    SELECT count(*)::integer INTO v_table_live_seats_before
      FROM public.table_seats live
     WHERE live.table_id=v_item.vacated_table_id AND live.left_at IS NULL;
    IF v_table_live_seats_before<=0 OR (
      SELECT count(*) FROM public.table_seats live
      JOIN public.tables live_table ON live_table.id=live.table_id
       WHERE live_table.tournament_id=v_item.tournament_id
         AND live.user_id=v_item.user_id AND live.left_at IS NULL)<>1 THEN
      RAISE EXCEPTION 'pending-zero live-seat count changed before exact vacancy'
        USING ERRCODE='40001';
    END IF;

    v_vacated_at:=GREATEST(
      clock_timestamp(),v_item.vacated_joined_at+interval '1 microsecond');
    UPDATE public.table_seats s
       SET stack=0,left_at=v_vacated_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
     WHERE s.id=v_item.vacated_seat_id
       AND s.table_id=v_item.vacated_table_id
       AND s.seat_number=v_item.vacated_seat_number
       AND s.user_id=v_item.user_id
       AND s.joined_at=v_item.vacated_joined_at
       AND s.stack IS NOT DISTINCT FROM v_item.seat_stack_before
       AND s.left_at IS NULL
       AND s.status='active'
       AND EXISTS (
         SELECT 1 FROM public.tournament_players tp
         JOIN public.tournament_knockout_candidates c
           ON c.id=v_item.candidate_id AND c.tournament_id=tp.tournament_id
          AND c.eliminated_user_id=tp.user_id
          AND c.state='pending' AND c.resolved_at IS NULL AND c.stack_after=0
          WHERE tp.id=v_item.roster_id AND tp.status='playing' AND tp.chips=0
            AND tp.table_id=s.table_id AND tp.seat_number=s.seat_number);
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'pending-zero chair changed before exact vacancy'
        USING ERRCODE='40001';
    END IF;

    SELECT count(*)::integer INTO v_table_live_seats_after
      FROM public.table_seats live
     WHERE live.table_id=v_item.vacated_table_id AND live.left_at IS NULL;
    IF v_table_live_seats_after<>v_table_live_seats_before-1 THEN
      RAISE EXCEPTION 'pending-zero vacancy changed the live-seat count unexpectedly'
        USING ERRCODE='P0404';
    END IF;

    UPDATE public.tables tb
       SET current_players=v_table_live_seats_after,updated_at=now()
     WHERE tb.id=v_item.vacated_table_id
       AND tb.tournament_id=v_item.tournament_id
    RETURNING tb.current_players INTO v_table_current_players_after;
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    IF v_rows<>1 THEN
      RAISE EXCEPTION 'pending-zero table count changed during exact vacancy'
        USING ERRCODE='40001';
    END IF;

    IF v_table_current_players_after IS DISTINCT FROM
         v_table_live_seats_after
       OR EXISTS (
         SELECT 1 FROM public.table_seats live
         JOIN public.tables live_table ON live_table.id=live.table_id
          WHERE live_table.tournament_id=v_item.tournament_id
            AND live.user_id=v_item.user_id AND live.left_at IS NULL)
       OR NOT EXISTS (
         SELECT 1
           FROM public.table_seats vacated
           JOIN public.tournament_players tp
             ON tp.id=v_item.roster_id
            AND tp.tournament_id=v_item.tournament_id
            AND tp.user_id=v_item.user_id
            AND tp.status='playing' AND tp.chips=0
           JOIN public.tournament_knockout_candidates c
             ON c.id=v_item.candidate_id AND c.state='pending'
            AND c.resolved_at IS NULL AND c.stack_after=0
            AND c.tournament_id=v_item.tournament_id
            AND c.eliminated_user_id=v_item.user_id
          WHERE vacated.id=v_item.vacated_seat_id
            AND vacated.table_id=v_item.vacated_table_id
            AND vacated.seat_number=v_item.vacated_seat_number
            AND vacated.user_id=v_item.user_id
            AND vacated.joined_at=v_item.vacated_joined_at
            AND vacated.stack=0 AND vacated.left_at=v_vacated_at
            AND vacated.status='left' AND vacated.leave_pending IS FALSE
            AND vacated.is_sitting_out IS FALSE
            AND vacated.is_away IS FALSE
            AND vacated.sit_out_at IS NULL
            AND vacated.scheduled_leave_hands IS NULL) THEN
      RAISE EXCEPTION 'pending-zero vacancy did not preserve exact zero state'
        USING ERRCODE='P0404';
    END IF;

    INSERT INTO public.tournament_pending_zero_seat_cutover_receipts(
      candidate_id,migration_version,tournament_id,user_id,roster_id,
      zero_table_id,zero_seat_id,zero_seat_joined_at,zero_hand_number,
      zero_hac_hand_id,zero_settlement_hand_id,zero_committed_at,
      roster_chips_before,
      vacated_table_id,vacated_seat_id,vacated_seat_number,vacated_joined_at,
      seat_stack_before,post_zero_entitlement_count,
      post_zero_chip_ledger_count,post_zero_wallet_transaction_count,
      post_zero_wallet_idempotency_count,later_accepted_hand_count,
      table_current_players_before,
      table_live_seats_before,table_current_players_after,
      table_live_seats_after,vacated_at)
    VALUES(
      v_item.candidate_id,'20260910042020_stage_b_exact_precondition_repairs',v_item.tournament_id,
      v_item.user_id,v_item.roster_id,v_item.zero_table_id,
      v_item.zero_seat_id,v_item.zero_seat_joined_at,v_item.zero_hand_number,
      v_item.zero_hac_hand_id,v_item.zero_settlement_hand_id,
      v_item.zero_committed_at,v_item.roster_chips_before,
      v_item.vacated_table_id,
      v_item.vacated_seat_id,v_item.vacated_seat_number,
      v_item.vacated_joined_at,v_item.seat_stack_before,
      v_item.post_zero_entitlement_count,v_item.post_zero_chip_ledger_count,
      v_item.post_zero_wallet_transaction_count,
      v_item.post_zero_wallet_idempotency_count,
      v_item.later_accepted_hand_count,
      v_table_current_players_before,v_table_live_seats_before,
      v_table_current_players_after,v_table_live_seats_after,
      v_vacated_at);
  END LOOP;

  SELECT COALESCE(array_agg(r.candidate_id ORDER BY r.candidate_id),
                          ARRAY[]::uuid[]),
         COALESCE(array_agg(r.vacated_seat_id ORDER BY r.candidate_id),
                          ARRAY[]::uuid[])
    INTO v_pending_zero_candidate_ids,v_pending_zero_seat_ids
    FROM public.tournament_pending_zero_seat_cutover_receipts r;

  IF (SELECT count(*)
        FROM public.tournament_pending_zero_seat_cutover_receipts)
       <>(SELECT count(*) FROM ca_cutover_pending_zero_seats)
     OR EXISTS (
       SELECT 1
         FROM public.tournament_players tp
         JOIN public.tournaments t ON t.id=tp.tournament_id
        WHERE upper(COALESCE(t.status::text,''))='RUNNING'
          AND tp.status='playing' AND tp.chips=0
          AND EXISTS (
            SELECT 1 FROM public.table_seats live
            JOIN public.tables live_table ON live_table.id=live.table_id
             WHERE live_table.tournament_id=tp.tournament_id
               AND live.user_id=tp.user_id AND live.left_at IS NULL)) THEN
    RAISE EXCEPTION 'pending-zero live-seat cutover did not converge exactly'
      USING ERRCODE='P0404';
  END IF;

  -- Retire the minute reconciler only after closing its exact historical
  -- backlog under this write barrier. Every future writer is re-emitted below
  -- with its denormalised fields in the same transaction.
  --
  -- The hand path also used a separate two-statement chip reconciler. Drain
  -- and repair its exact backlog once here, while both source and mirror are
  -- write-frozen. A positive playing row without one live seat, or two live
  -- seats claiming one player, has no non-arbitrary chip source and therefore
  -- aborts the cutover instead of being guessed. A seatless zero remains a
  -- legitimate rebuy/elimination candidate.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      LEFT JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      LEFT JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
       AND EXISTS (
         SELECT 1 FROM public.tables any_table
          WHERE any_table.tournament_id=tp.tournament_id)
     GROUP BY tp.id,tp.chips
    HAVING count(s.id)>1 OR (COALESCE(tp.chips,0)>0 AND count(s.id)<>1)
  ) THEN
    RAISE EXCEPTION
      'live tournament chip cutover found an ambiguous or missing positive seat'
      USING ERRCODE='P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
       AND (s.stack IS NULL OR s.stack<0 OR s.stack<>trunc(s.stack))
  ) THEN
    RAISE EXCEPTION
      'live tournament chip cutover found a negative or fractional seat stack'
      USING ERRCODE='P0404';
  END IF;

  WITH exact_live AS (
    SELECT tp.id AS roster_id,s.stack::integer AS chips
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
       AND tp.chips>0 AND s.stack>0
  ), repaired AS (
    UPDATE public.tournament_players tp
       SET chips=live.chips
      FROM exact_live live
     WHERE tp.id=live.roster_id
       AND tp.chips IS DISTINCT FROM live.chips
    RETURNING tp.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_chip_roster_ids FROM repaired;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id=tp.tournament_id
      JOIN public.tables tb ON tb.tournament_id=tp.tournament_id
      JOIN public.table_seats s
        ON s.table_id=tb.id AND s.user_id=tp.user_id AND s.left_at IS NULL
     WHERE tp.status='playing'
       AND upper(COALESCE(t.status::text,''))='RUNNING'
       AND tp.chips IS DISTINCT FROM s.stack::integer
  ) THEN
    RAISE EXCEPTION 'live tournament chip cutover did not converge exactly'
      USING ERRCODE='P0404';
  END IF;

  WITH live_seat AS (
    SELECT s.user_id,tb.tournament_id,s.table_id,s.seat_number,
           row_number() OVER (
             PARTITION BY tb.tournament_id,s.user_id
             ORDER BY s.joined_at DESC NULLS LAST,s.id) AS rn
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL
  ), repaired AS (
    UPDATE public.tournament_players tp
       SET table_id=ls.table_id,seat_number=ls.seat_number
      FROM live_seat ls
     WHERE ls.rn=1
       AND tp.tournament_id=ls.tournament_id
       AND tp.user_id=ls.user_id
       AND tp.status IN ('registered','playing')
       AND (tp.table_id IS DISTINCT FROM ls.table_id
         OR tp.seat_number IS DISTINCT FROM ls.seat_number)
    RETURNING tp.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_roster_ids FROM repaired;

  WITH repaired AS (
    UPDATE public.tables tb
       SET stakes=trim_scale(tb.small_blind)::text||'/'||
                  trim_scale(tb.big_blind)::text,
           updated_at=now()
      FROM public.tournaments t
     WHERE t.id=tb.tournament_id
       AND upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
       AND tb.small_blind IS NOT NULL AND tb.big_blind IS NOT NULL
       AND tb.stakes IS DISTINCT FROM
           trim_scale(tb.small_blind)::text||'/'||
           trim_scale(tb.big_blind)::text
    RETURNING tb.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_stakes_table_ids FROM repaired;

  WITH seat_first AS (
    SELECT t.id
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
       AND (lower(COALESCE(t.variant,'')) IN ('spin','sng')
         OR COALESCE(t.max_players,0)<=2)
  ), ranked AS (
    SELECT tb.id,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id=tb.id AND s.left_at IS NULL) AS seats,
           public.fn_tournament_primary_table(tb.tournament_id) AS keep_id
      FROM public.tables tb
      JOIN seat_first sf ON sf.id=tb.tournament_id
     WHERE lower(COALESCE(tb.status,''))<>'closed'
  ), repaired AS (
    UPDATE public.tables tb
       SET status='closed',current_players=0,updated_at=now()
      FROM ranked r
     WHERE tb.id=r.id AND r.seats=0
       AND r.keep_id IS NOT NULL AND r.keep_id<>r.id
    RETURNING tb.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_duplicate_table_ids FROM repaired;

  WITH truth AS (
    SELECT t.id,
           (lower(COALESCE(t.variant,'')) IN ('spin','sng')
             OR COALESCE(t.max_players,0)<=2) AS is_seat_first,
           public.fn_tournament_primary_table(t.id) AS primary_table,
           CASE
             WHEN lower(COALESCE(t.variant,'')) IN ('spin','sng')
                  OR COALESCE(t.max_players,0)<=2 THEN (
               SELECT count(*) FROM public.table_seats s
                WHERE s.table_id=public.fn_tournament_primary_table(t.id)
                  AND s.left_at IS NULL)
             ELSE (
               SELECT count(*) FROM public.tournament_players tp
                WHERE tp.tournament_id=t.id
                  AND tp.status IN ('registered','playing'))
           END AS real_count
      FROM public.tournaments t
     WHERE upper(COALESCE(t.status::text,'')) IN
             ('RUNNING','REGISTERING','ANNOUNCED')
  ), repaired AS (
    UPDATE public.tournaments t
       SET current_players=truth.real_count,updated_at=now()
      FROM truth
     WHERE t.id=truth.id
       AND NOT (truth.is_seat_first AND truth.primary_table IS NULL)
       AND COALESCE(t.current_players,-1) IS DISTINCT FROM truth.real_count
    RETURNING t.id
  )
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_player_count_tournament_ids FROM repaired;

  IF EXISTS (
    SELECT 1 FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
    JOIN public.tournaments t ON t.id=tb.tournament_id
    WHERE s.left_at IS NULL
      AND upper(COALESCE(t.status::text,'')) IN
            ('COMPLETED','CANCELLED','CANCELED'))
     OR EXISTS (
    SELECT 1 FROM public.tables tb
    JOIN public.tournaments t ON t.id=tb.tournament_id
    WHERE upper(COALESCE(t.status::text,'')) IN
            ('COMPLETED','CANCELLED','CANCELED')
      AND (lower(COALESCE(tb.status,''))<>'closed'
        OR tb.current_players IS DISTINCT FROM 0)) THEN
    RAISE EXCEPTION 'terminal table and seat backlog did not close exactly'
      USING ERRCODE='P0404';
  END IF;

  IF (SELECT count(*) FROM public.tournament_paid_candidate_cutover_receipts)
       <>(SELECT count(*) FROM ca_cutover_paid_candidates)
     OR EXISTS (
       SELECT 1 FROM ca_cutover_paid_candidates p
       LEFT JOIN public.tournament_paid_candidate_cutover_receipts r
         ON r.candidate_id=p.candidate_id
       LEFT JOIN public.tournament_knockout_candidates c
         ON c.id=p.candidate_id
        WHERE r.candidate_id IS NULL OR c.id IS NULL OR c.state<>'rebought'
           OR (p.candidate_state_before='pending'
                AND c.resolved_at IS DISTINCT FROM p.first_paid_at)
           OR (p.candidate_state_before='rebought'
                AND c.resolved_at IS DISTINCT FROM
                      p.candidate_resolved_at_before)
           OR r.tournament_id IS DISTINCT FROM p.tournament_id
           OR r.user_id IS DISTINCT FROM p.user_id
           OR r.candidate_state_before IS DISTINCT FROM
                p.candidate_state_before
           OR r.candidate_resolved_at_before IS DISTINCT FROM
                p.candidate_resolved_at_before
           OR r.zero_table_id IS DISTINCT FROM p.zero_table_id
           OR r.zero_seat_id IS DISTINCT FROM p.zero_seat_id
           OR r.zero_seat_joined_at IS DISTINCT FROM p.zero_seat_joined_at
           OR r.zero_hand_number IS DISTINCT FROM p.zero_hand_number
           OR r.zero_hac_hand_id IS DISTINCT FROM p.zero_hac_hand_id
           OR r.zero_settlement_hand_id IS DISTINCT FROM
                p.zero_settlement_hand_id
           OR r.entitlement_ids IS DISTINCT FROM p.entitlement_ids
           OR r.source_ledger_ids IS DISTINCT FROM p.source_ledger_ids
           OR r.source_ledger_chain_seqs IS DISTINCT FROM
                p.source_ledger_chain_seqs
           OR r.source_ledger_row_hashes IS DISTINCT FROM
                p.source_ledger_row_hashes
           OR r.wallet_transaction_ids IS DISTINCT FROM
                p.wallet_transaction_ids
           OR r.purchase_idempotency_keys IS DISTINCT FROM
                p.purchase_idempotency_keys
           OR r.purchase_ordinals IS DISTINCT FROM p.purchase_ordinals
           OR r.purchase_types IS DISTINCT FROM p.purchase_types
           OR r.payment_count IS DISTINCT FROM p.payment_count
           OR r.first_paid_at IS DISTINCT FROM p.first_paid_at
           OR r.last_paid_at IS DISTINCT FROM p.last_paid_at)
     OR EXISTS (
       SELECT 1 FROM ca_cutover_candidate_windows w
        WHERE w.next_candidate_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.tournament_knockout_candidates c
             WHERE c.id=w.candidate_id AND c.state='pending')) THEN
    RAISE EXCEPTION 'paid knockout candidate cutover did not close exactly'
      USING ERRCODE='P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_paid_candidate_cutover_receipts r
      LEFT JOIN public.hand_atomic_commits h
        ON h.table_id=r.zero_table_id AND h.hand_number=r.zero_hand_number
       AND h.hand_id=r.zero_hac_hand_id
      LEFT JOIN public.settlement_idempotency_keys k
        ON k.table_id=r.zero_table_id
       AND k.hand_id=r.zero_settlement_hand_id
      LEFT JOIN public.tournament_players tp ON tp.id=r.roster_id
      LEFT JOIN public.tournaments t ON t.id=r.tournament_id
     WHERE h.table_id IS NULL OR k.table_id IS NULL OR tp.id IS NULL
        OR t.id IS NULL
        OR tp.tournament_id IS DISTINCT FROM r.tournament_id
        OR tp.user_id IS DISTINCT FROM r.user_id
        OR r.rebuy_chips IS DISTINCT FROM t.rebuy_chips
        OR h.stack_result->>'success' IS DISTINCT FROM 'true'
        OR k.completed_at IS NULL
        OR k.status IS DISTINCT FROM 'succeeded'
        OR k.hand_id::text IS DISTINCT FROM h.stack_result->>'hand_id'
        OR k.result IS DISTINCT FROM h.stack_result
        OR COALESCE(h.stack_result->'written'->>r.user_id::text,'')
             !~'^-?[0-9]+([.][0-9]+)?$'
        OR (h.stack_result->'written'->>r.user_id::text)::numeric
             IS DISTINCT FROM 0
        OR (r.repair_action='stranded_stack_seated'
            AND r.stack_after::bigint IS DISTINCT FROM (
              SELECT count(*)::bigint*r.rebuy_chips::bigint
                FROM unnest(r.purchase_types) WITH ORDINALITY
                  kind(purchase_type,position)
               WHERE kind.position>=COALESCE((
                 SELECT max(reentry.position)
                   FROM unnest(r.purchase_types) WITH ORDINALITY
                     reentry(purchase_type,position)
                  WHERE reentry.purchase_type='reentry'),1)))
  ) OR EXISTS (
    SELECT 1
      FROM public.tournament_paid_candidate_cutover_receipts r
      CROSS JOIN LATERAL unnest(
        r.entitlement_ids,r.source_ledger_ids,r.source_ledger_chain_seqs,
        r.source_ledger_row_hashes,r.wallet_transaction_ids,
        r.purchase_idempotency_keys,r.purchase_ordinals,r.purchase_types)
        AS evidence(entitlement_id,ledger_id,chain_seq,row_hash,
                    wallet_transaction_id,purchase_key,purchase_ordinal,
                    purchase_type)
      LEFT JOIN public.tournament_refund_entitlements e
        ON e.id=evidence.entitlement_id
      LEFT JOIN ca_cutover_rebuy_entitlement_ordinals ordinal
        ON ordinal.entitlement_id=evidence.entitlement_id
       AND ordinal.tournament_id=r.tournament_id
       AND ordinal.user_id=r.user_id
      LEFT JOIN public.chip_ledger l ON l.id=evidence.ledger_id
      LEFT JOIN public.wallet_transactions w
        ON w.id=evidence.wallet_transaction_id
      LEFT JOIN public.wallet_credit_idempotency i
        ON i.key=evidence.purchase_key
     WHERE e.id IS NULL OR ordinal.entitlement_id IS NULL
        OR l.id IS NULL OR w.id IS NULL OR i.key IS NULL
        OR e.source_ledger_id IS DISTINCT FROM l.id
        OR e.tournament_id IS DISTINCT FROM r.tournament_id
        OR e.user_id IS DISTINCT FROM r.user_id
        OR e.entitlement_kind IS DISTINCT FROM 'wallet_charge'
        OR e.charge_category IS DISTINCT FROM 'rebuy'
        OR e.evidence_kind NOT IN (
             'atomic_wallet_charge','cutover_wallet_charge')
        OR e.created_at IS DISTINCT FROM l.created_at
        OR ordinal.purchase_ordinal IS DISTINCT FROM
             evidence.purchase_ordinal
        OR l.chain_seq IS DISTINCT FROM evidence.chain_seq
        OR l.row_hash IS DISTINCT FROM evidence.row_hash
        OR l.from_type IS DISTINCT FROM 'player_wallet'
        OR l.from_entity_id IS DISTINCT FROM r.user_id
        OR l.to_type IS DISTINCT FROM 'prize_liability'
        OR l.to_entity_id IS DISTINCT FROM r.tournament_id
        OR l.tournament_id IS DISTINCT FROM r.tournament_id
        OR l.status IS DISTINCT FROM 'posted'
        OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
        OR l.amount IS DISTINCT FROM e.gross
        OR l.amount<=0 OR l.amount<>round(l.amount,2)
        OR w.user_id IS DISTINCT FROM r.user_id
        OR w.related_entity_id IS DISTINCT FROM r.tournament_id
        OR w.wallet_type IS DISTINCT FROM 'PLAYER'
        OR w.type IS DISTINCT FROM 'debit'
        OR lower(COALESCE(w.category,''))<>'rebuy'
        OR w.amount IS DISTINCT FROM e.gross
        OR w.created_at IS DISTINCT FROM l.created_at
        OR evidence.purchase_type NOT IN ('rebuy','reentry')
        OR COALESCE(w.description,'') NOT LIKE
             'Tournament '||evidence.purchase_type||':%'
        OR i.user_id IS DISTINCT FROM r.user_id
        OR (
          i.amount IS NOT DISTINCT FROM e.gross
          OR (
            e.evidence_kind='cutover_wallet_charge'
            AND evidence.purchase_type='rebuy'
            AND i.amount=0
            AND i.key='tourney:'||r.tournament_id::text||':rebuy:'||
                      r.user_id::text||':#'||
                      evidence.purchase_ordinal::text
          )
        ) IS NOT TRUE
        OR i.created_at IS DISTINCT FROM l.created_at
        OR i.key NOT LIKE 'tourney:'||r.tournament_id::text||':'||
             evidence.purchase_type||':'||r.user_id::text||':%'
  ) THEN
    RAISE EXCEPTION 'paid candidate detail receipt lost immutable evidence'
      USING ERRCODE='P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_paid_candidate_cutover_receipts r
      LEFT JOIN public.tournament_players tp ON tp.id=r.roster_id
      LEFT JOIN public.table_seats s ON s.id=r.seat_id
     WHERE (r.seat_id IS NOT NULL AND (
              s.id IS NULL OR s.left_at IS NOT NULL
              OR s.user_id IS DISTINCT FROM r.user_id
              OR s.table_id IS DISTINCT FROM r.table_id
              OR s.seat_number IS DISTINCT FROM r.seat_number
              OR s.stack IS DISTINCT FROM r.stack_after
              OR s.joined_at IS DISTINCT FROM r.seat_joined_at_after
              OR s.player_id IS DISTINCT FROM r.seat_player_id
              OR s.member_id IS DISTINCT FROM r.seat_member_id
              OR s.horse_id IS DISTINCT FROM r.seat_horse_id
              OR s.club_id IS DISTINCT FROM r.seat_club_id
              OR s.is_sitting_out IS DISTINCT FROM r.seat_is_sitting_out
              OR s.is_away IS DISTINCT FROM r.seat_is_away
              OR s.sit_out_at IS DISTINCT FROM r.seat_sit_out_at
              OR s.scheduled_leave_hands IS DISTINCT FROM
                   r.seat_scheduled_leave_hands
              OR s.left_at IS DISTINCT FROM r.seat_left_at
              OR s.status IS DISTINCT FROM r.seat_status
              OR s.leave_pending IS DISTINCT FROM r.seat_leave_pending
              OR s.auto_rebuy IS DISTINCT FROM r.seat_auto_rebuy
              OR s.time_bank_remaining IS DISTINCT FROM
                   r.seat_time_bank_remaining
              OR s.time_bank_uses_remaining IS DISTINCT FROM
                   r.seat_time_bank_uses_remaining
              OR s.entry_hold IS DISTINCT FROM r.seat_entry_hold
              OR s.entry_post_agreed IS DISTINCT FROM
                   r.seat_entry_post_agreed))
        OR (r.repair_action='stranded_stack_seated' AND (
              s.id IS NULL OR tp.id IS NULL OR s.left_at IS NOT NULL
              OR s.user_id IS DISTINCT FROM r.user_id
              OR s.table_id IS DISTINCT FROM r.table_id
              OR s.seat_number IS DISTINCT FROM r.seat_number
              OR s.stack IS DISTINCT FROM r.stack_after
              OR tp.chips IS DISTINCT FROM r.stack_after
              OR tp.table_id IS DISTINCT FROM r.table_id
              OR tp.seat_number IS DISTINCT FROM r.seat_number))
        OR (r.repair_action='live_generation_rotated' AND (
              s.id IS NULL OR tp.id IS NULL OR s.left_at IS NOT NULL
              OR s.id IS DISTINCT FROM r.zero_seat_id
              OR s.user_id IS DISTINCT FROM r.user_id
              OR r.seat_joined_at_before IS DISTINCT FROM
                   r.zero_seat_joined_at
              OR s.joined_at IS DISTINCT FROM r.seat_joined_at_after
              OR r.seat_joined_at_after IS DISTINCT FROM r.first_paid_at
              OR r.seat_joined_at_before IS NOT DISTINCT FROM
                   r.seat_joined_at_after))
  ) OR EXISTS (
    SELECT 1
      FROM public.tournament_positive_orphan_cutover_receipts r
      LEFT JOIN public.tournament_players tp ON tp.id=r.roster_id
      LEFT JOIN public.table_seats s ON s.id=r.revived_seat_id
     WHERE s.id IS NULL OR tp.id IS NULL
        OR s.left_at IS NOT NULL OR s.user_id IS DISTINCT FROM r.user_id
        OR s.table_id IS DISTINCT FROM r.revived_table_id
        OR s.seat_number IS DISTINCT FROM r.revived_seat_number
        OR s.stack IS DISTINCT FROM r.stack
        OR tp.chips IS DISTINCT FROM r.stack
        OR tp.table_id IS DISTINCT FROM r.revived_table_id
        OR tp.seat_number IS DISTINCT FROM r.revived_seat_number
        OR s.joined_at IS DISTINCT FROM r.revived_joined_at
        OR s.player_id IS DISTINCT FROM r.revived_player_id
        OR s.member_id IS DISTINCT FROM r.revived_member_id
        OR s.horse_id IS DISTINCT FROM r.revived_horse_id
        OR s.club_id IS DISTINCT FROM r.revived_club_id
        OR s.is_sitting_out IS DISTINCT FROM r.revived_is_sitting_out
        OR s.is_away IS DISTINCT FROM r.revived_is_away
        OR s.sit_out_at IS DISTINCT FROM r.revived_sit_out_at
        OR s.scheduled_leave_hands IS DISTINCT FROM
             r.revived_scheduled_leave_hands
        OR s.left_at IS DISTINCT FROM r.revived_left_at
        OR s.status IS DISTINCT FROM r.revived_status
        OR s.leave_pending IS DISTINCT FROM r.revived_leave_pending
        OR s.auto_rebuy IS DISTINCT FROM r.revived_auto_rebuy
        OR s.time_bank_remaining IS DISTINCT FROM
             r.revived_time_bank_remaining
        OR s.time_bank_uses_remaining IS DISTINCT FROM
             r.revived_time_bank_uses_remaining
        OR s.entry_hold IS DISTINCT FROM r.revived_entry_hold
        OR s.entry_post_agreed IS DISTINCT FROM
             r.revived_entry_post_agreed
        OR (r.seat_row_reused AND (
             r.destination_seat_id_before IS DISTINCT FROM r.revived_seat_id
             OR r.destination_left_at_before IS NULL))
        OR (NOT r.seat_row_reused AND (
             r.destination_seat_id_before IS NOT NULL
             OR r.destination_user_id_before IS NOT NULL
             OR r.destination_player_id_before IS NOT NULL
             OR r.destination_member_id_before IS NOT NULL
             OR r.destination_stack_before IS NOT NULL
             OR r.destination_is_sitting_out_before IS NOT NULL
             OR r.destination_is_away_before IS NOT NULL
             OR r.destination_joined_at_before IS NOT NULL
             OR r.destination_horse_id_before IS NOT NULL
             OR r.destination_scheduled_leave_hands_before IS NOT NULL
             OR r.destination_left_at_before IS NOT NULL
             OR r.destination_status_before IS NOT NULL
             OR r.destination_leave_pending_before IS NOT NULL
             OR r.destination_auto_rebuy_before IS NOT NULL
             OR r.destination_time_bank_remaining_before IS NOT NULL
             OR r.destination_time_bank_uses_remaining_before IS NOT NULL
             OR r.destination_club_id_before IS NOT NULL
             OR r.destination_sit_out_at_before IS NOT NULL
             OR r.destination_entry_hold_before IS NOT NULL
             OR r.destination_entry_post_agreed_before IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'seat-exit cutover detail receipt does not match live state'
      USING ERRCODE='P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_positive_orphan_cutover_receipts r
      LEFT JOIN public.hand_atomic_commits h
        ON h.table_id=r.table_id AND h.hand_number=r.last_hand_number
       AND h.hand_id=r.last_hac_hand_id
      LEFT JOIN public.settlement_idempotency_keys k
        ON k.table_id=r.table_id AND k.hand_id=r.last_settlement_hand_id
      LEFT JOIN public.tournament_players tp ON tp.id=r.roster_id
      LEFT JOIN public.profiles profile ON profile.id=r.user_id
      LEFT JOIN public.tournament_paid_candidate_cutover_receipts paid
        ON paid.candidate_id=r.paid_candidate_id
     WHERE h.table_id IS NULL OR k.table_id IS NULL OR tp.id IS NULL
        OR profile.id IS NULL
        OR tp.tournament_id IS DISTINCT FROM r.tournament_id
        OR tp.user_id IS DISTINCT FROM r.user_id
        OR r.source_player_id IS NOT NULL OR r.source_member_id IS NOT NULL
        OR r.source_horse_id IS DISTINCT FROM
             CASE WHEN COALESCE(profile.is_horse,false)
                    THEN profile.id ELSE NULL END
        OR r.source_club_id IS NULL
        OR r.revived_horse_id IS DISTINCT FROM r.source_horse_id
        OR r.revived_club_id IS NULL
        OR r.revived_time_bank_remaining IS DISTINCT FROM
             r.source_time_bank_remaining
        OR r.revived_time_bank_uses_remaining IS DISTINCT FROM
             r.source_time_bank_uses_remaining
        OR (r.evidence_class='accepted_hand_no_ko' AND (
             r.paid_candidate_id IS NOT NULL OR EXISTS (
               SELECT 1 FROM public.tournament_knockout_candidates c
                WHERE c.tournament_id=r.tournament_id
                  AND c.eliminated_user_id=r.user_id)))
        OR (r.evidence_class='accepted_hand_after_paid_rebuy' AND (
             paid.candidate_id IS NULL
             OR paid.tournament_id IS DISTINCT FROM r.tournament_id
             OR paid.user_id IS DISTINCT FROM r.user_id
             OR paid.repair_action IS DISTINCT FROM 'candidate_closed'
             OR r.last_hand_number<=paid.zero_hand_number
             OR h.committed_at<=paid.last_paid_at))
        OR h.committed_at<r.source_joined_at
        OR r.source_left_at<=GREATEST(
             h.committed_at,h.post_commit_completed_at,k.completed_at)
        OR EXISTS (
             SELECT 1 FROM public.hand_atomic_commits later_global
             JOIN public.tables later_global_table
               ON later_global_table.id=later_global.table_id
              WHERE later_global_table.tournament_id=r.tournament_id
                AND later_global.stack_result->'written' ? r.user_id::text
                AND later_global.hand_number>r.last_hand_number)
        OR h.stack_result->>'table_id' IS DISTINCT FROM r.table_id::text
        OR COALESCE(h.stack_result->>'hand_number','')!~'^[0-9]+$'
        OR (h.stack_result->>'hand_number')::bigint
             IS DISTINCT FROM r.last_hand_number
        OR COALESCE(h.stack_result->'written'->>r.user_id::text,'')
             !~'^-?[0-9]+([.][0-9]+)?$'
        OR (h.stack_result->'written'->>r.user_id::text)::numeric
             IS DISTINCT FROM r.stack
        OR h.stack_result->>'success' IS DISTINCT FROM 'true'
        OR h.post_commit_completed_at IS NULL
        OR h.post_commit_result->>'ok' IS DISTINCT FROM 'true'
        OR k.status IS DISTINCT FROM 'succeeded'
        OR k.hand_id::text IS DISTINCT FROM h.stack_result->>'hand_id'
        OR k.result IS DISTINCT FROM h.stack_result
  ) THEN
    RAISE EXCEPTION 'positive-orphan detail receipt lost accepted-hand evidence'
      USING ERRCODE='P0404';
  END IF;

  INSERT INTO public.tournament_seat_exit_authority_cutover(
    authority,migration_version,installed_at,
    repaired_seat_count,repaired_seat_ids,
    repaired_table_count,repaired_table_ids,
    repaired_roster_count,repaired_roster_ids,
    repaired_chip_count,repaired_chip_roster_ids,
    repaired_stakes_count,repaired_stakes_table_ids,
    closed_duplicate_table_count,closed_duplicate_table_ids,
    repaired_player_count_count,repaired_player_count_tournament_ids,
    paid_candidate_count,paid_candidate_ids,
    positive_orphan_count,positive_orphan_seat_ids,
    pending_zero_candidate_count,pending_zero_candidate_ids,
    pending_zero_seat_ids)
  VALUES(
    'tournament_seat_exit_authority:v1','20260910042020_stage_b_exact_precondition_repairs',
    transaction_timestamp(),cardinality(v_seat_ids),v_seat_ids,
    cardinality(v_table_ids),v_table_ids,
    cardinality(v_roster_ids),v_roster_ids,
    cardinality(v_chip_roster_ids),v_chip_roster_ids,
    cardinality(v_stakes_table_ids),v_stakes_table_ids,
    cardinality(v_duplicate_table_ids),v_duplicate_table_ids,
    cardinality(v_player_count_tournament_ids),
    v_player_count_tournament_ids,
    cardinality(v_paid_candidate_ids),v_paid_candidate_ids,
    cardinality(v_positive_orphan_seat_ids),v_positive_orphan_seat_ids,
    cardinality(v_pending_zero_candidate_ids),
    v_pending_zero_candidate_ids,v_pending_zero_seat_ids);
END;
$terminal_orphan_cutover$;

-- Capture the exact terminal-break preimage before canonicalizing it. The
-- following invariant migration can then be pure guard installation.
CREATE TEMP TABLE ca_terminal_break_residue ON COMMIT DROP AS
SELECT t.id AS tournament_id,
       upper(t.status::text) AS terminal_status,
       COALESCE(t.on_break,false) AS on_break_before,
       t.break_started_at AS break_started_at_before,
       t.break_ends_at AS break_ends_at_before
  FROM public.tournaments t
 WHERE upper(COALESCE(t.status::text,'')) IN ('COMPLETED','CANCELLED')
   AND (
     COALESCE(t.on_break,false)
     OR t.break_started_at IS NOT NULL
     OR t.break_ends_at IS NOT NULL
   )
 ORDER BY t.id;

-- Terminal tournaments are deliberately immutable after their closure receipt
-- exists. Authenticate that production guard before replacing it inside this
-- still-uncommitted cutover transaction. The tournaments relation lock above
-- excludes concurrent writers, and PostgreSQL's transactional catalog keeps
-- this temporary implementation invisible outside this transaction.
DO $authenticate_receipted_tournament_immutability_guard$
DECLARE
  v_guard oid :=
    to_regprocedure('public.fn_receipted_tournament_is_immutable()');
BEGIN
  IF v_guard IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=v_guard
       AND md5(p.prosrc)='8861ea6a0b6af900b806c20cf09db699'
       AND p.proowner='postgres'::regrole
       AND p.prokind='f' AND p.provolatile='v'
       AND p.proparallel='u' AND p.prosecdef
       AND NOT p.proisstrict AND NOT p.proleakproof
       AND NOT p.proretset AND p.prorettype='trigger'::regtype
       AND p.pronargs=0 AND p.pronargdefaults=0
       AND p.proconfig=ARRAY['search_path=public']::text[]
       AND p.proacl::text='{postgres=X/postgres}'
       AND l.lanname='plpgsql'
  ) THEN
    RAISE EXCEPTION
      'receipted tournament immutability function is not the inspected production guard'
      USING ERRCODE='55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid='public.tournaments'::regclass
       AND tg.tgname='receipted_tournament_is_immutable'
       AND tg.tgfoid=v_guard
       AND NOT tg.tgisinternal
       AND tg.tgenabled='O'
       AND tg.tgtype=27
       AND tg.tgqual IS NULL
       AND tg.tgnargs=0
       AND octet_length(tg.tgargs)=0
       AND ARRAY(
         SELECT a.attname::text
           FROM unnest(tg.tgattr::smallint[])
                  WITH ORDINALITY AS columns(attnum,ordinality)
           JOIN pg_attribute a
             ON a.attrelid=tg.tgrelid AND a.attnum=columns.attnum
          ORDER BY columns.ordinality
       )=ARRAY[
         'status','variant','tournament_type','satellite_target_id',
         'satellite_target','satellite_seats','prize_pool',
         'prize_pool_finalized','bounty_pool','bounty_pool_paid',
         'is_bounty','is_pko','is_mystery_bounty','mystery_bounty_stage',
         'mystery_bounty_pool_cents','club_id','ended_at','current_players',
         'on_break','break_started_at','break_ends_at'
       ]::text[]
  )<>1 THEN
    RAISE EXCEPTION
      'receipted tournament immutability trigger is not canonical and enabled'
      USING ERRCODE='55000';
  END IF;
END;
$authenticate_receipted_tournament_immutability_guard$;

-- The original guard correctly forbids every later mutation of a receipted
-- terminal tournament. Its sole missing case was this historical repair: the
-- row is already terminal, yet legacy break residue must be normalized before
-- the permanent invariant can be installed. This transaction-local body
-- admits only an UPDATE carrying this exact boundary's immutable preimage
-- receipt, changing only the three break fields plus the deterministic
-- updated_at value. Every DELETE and every other terminal mutation still
-- raises the original 55000 error.
CREATE OR REPLACE FUNCTION public.fn_receipted_tournament_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $stage_b_terminal_break_normalization_guard$
BEGIN
  IF upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    IF TG_OP='UPDATE'
       AND current_setting(
             'app.stage_b_terminal_break_normalization',true
           )='20260910042020_stage_b_exact_precondition_repairs'
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND (
         to_jsonb(NEW)-ARRAY[
           'on_break','break_started_at','break_ends_at','updated_at'
         ]::text[]
       ) IS NOT DISTINCT FROM (
         to_jsonb(OLD)-ARRAY[
           'on_break','break_started_at','break_ends_at','updated_at'
         ]::text[]
       )
       AND NEW.on_break=false
       AND NEW.break_started_at IS NULL
       AND NEW.break_ends_at IS NULL
       AND NEW.updated_at IS NOT DISTINCT FROM
             GREATEST(OLD.updated_at,transaction_timestamp())
       AND EXISTS (
         SELECT 1
           FROM public.tournament_terminal_break_normalization_receipts r
          WHERE r.tournament_id=OLD.id
            AND r.normalization_version=
                  '20260910042020_stage_b_exact_precondition_repairs'
            AND r.terminal_status=upper(COALESCE(OLD.status::text,''))
            AND r.on_break_before IS NOT DISTINCT FROM
                  COALESCE(OLD.on_break,false)
            AND r.break_started_at_before IS NOT DISTINCT FROM
                  OLD.break_started_at
            AND r.break_ends_at_before IS NOT DISTINCT FROM OLD.break_ends_at
       ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'terminal tournament % is immutable after closure',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$stage_b_terminal_break_normalization_guard$;

DO $normalize_terminal_break_residue$
DECLARE
  v_expected bigint;
  v_inserted bigint;
  v_updated bigint;
BEGIN
  SELECT count(*) INTO v_expected FROM ca_terminal_break_residue;

  INSERT INTO public.tournament_terminal_break_normalization_receipts(
    tournament_id,terminal_status,on_break_before,
    break_started_at_before,break_ends_at_before,normalization_version)
  SELECT r.tournament_id,r.terminal_status,r.on_break_before,
         r.break_started_at_before,r.break_ends_at_before,
         '20260910042020_stage_b_exact_precondition_repairs'
    FROM ca_terminal_break_residue r
   ORDER BY r.tournament_id;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;

  PERFORM set_config(
    'app.stage_b_terminal_break_normalization',
    '20260910042020_stage_b_exact_precondition_repairs',true);

  UPDATE public.tournaments t
     SET on_break=false,
         break_started_at=NULL,
         break_ends_at=NULL,
         updated_at=GREATEST(t.updated_at,transaction_timestamp())
    FROM ca_terminal_break_residue r
   WHERE t.id=r.tournament_id
     AND upper(t.status::text)=r.terminal_status
     AND COALESCE(t.on_break,false) IS NOT DISTINCT FROM r.on_break_before
     AND t.break_started_at IS NOT DISTINCT FROM r.break_started_at_before
     AND t.break_ends_at IS NOT DISTINCT FROM r.break_ends_at_before;
  GET DIAGNOSTICS v_updated=ROW_COUNT;

  PERFORM set_config('app.stage_b_terminal_break_normalization','',true);

  IF v_inserted<>v_expected OR v_updated<>v_expected THEN
    RAISE EXCEPTION
      'terminal break repair expected %, receipted %, normalized %',
      v_expected,v_inserted,v_updated
      USING ERRCODE='40001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE upper(COALESCE(t.status::text,'')) IN ('COMPLETED','CANCELLED')
       AND (
         COALESCE(t.on_break,false)
         OR t.break_started_at IS NOT NULL
         OR t.break_ends_at IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'terminal break repair left residue'
      USING ERRCODE='check_violation';
  END IF;
END;
$normalize_terminal_break_residue$;

-- Restore the exact inspected production implementation before any later
-- repair runs and prove that CREATE OR REPLACE preserved its owner, ACL,
-- security and trigger topology. A failure anywhere before COMMIT rolls the
-- catalog change and every data mutation back together.
CREATE OR REPLACE FUNCTION public.fn_receipted_tournament_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF upper(COALESCE(OLD.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED') THEN
    RAISE EXCEPTION 'terminal tournament % is immutable after closure',OLD.id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DO $verify_receipted_tournament_immutability_guard_restored$
DECLARE
  v_guard oid :=
    to_regprocedure('public.fn_receipted_tournament_is_immutable()');
BEGIN
  IF v_guard IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=v_guard
       AND md5(p.prosrc)='8861ea6a0b6af900b806c20cf09db699'
       AND p.proowner='postgres'::regrole
       AND p.prokind='f' AND p.provolatile='v'
       AND p.proparallel='u' AND p.prosecdef
       AND NOT p.proisstrict AND NOT p.proleakproof
       AND NOT p.proretset AND p.prorettype='trigger'::regtype
       AND p.pronargs=0 AND p.pronargdefaults=0
       AND p.proconfig=ARRAY['search_path=public']::text[]
       AND p.proacl::text='{postgres=X/postgres}'
       AND l.lanname='plpgsql'
  ) THEN
    RAISE EXCEPTION
      'receipted tournament immutability function was not restored exactly'
      USING ERRCODE='55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid='public.tournaments'::regclass
       AND tg.tgname='receipted_tournament_is_immutable'
       AND tg.tgfoid=v_guard
       AND NOT tg.tgisinternal
       AND tg.tgenabled='O'
       AND tg.tgtype=27
       AND tg.tgqual IS NULL
       AND tg.tgnargs=0
       AND octet_length(tg.tgargs)=0
       AND ARRAY(
         SELECT a.attname::text
           FROM unnest(tg.tgattr::smallint[])
                  WITH ORDINALITY AS columns(attnum,ordinality)
           JOIN pg_attribute a
             ON a.attrelid=tg.tgrelid AND a.attnum=columns.attnum
          ORDER BY columns.ordinality
       )=ARRAY[
         'status','variant','tournament_type','satellite_target_id',
         'satellite_target','satellite_seats','prize_pool',
         'prize_pool_finalized','bounty_pool','bounty_pool_paid',
         'is_bounty','is_pko','is_mystery_bounty','mystery_bounty_stage',
         'mystery_bounty_pool_cents','club_id','ended_at','current_players',
         'on_break','break_started_at','break_ends_at'
       ]::text[]
  )<>1 THEN
    RAISE EXCEPTION
      'receipted tournament immutability trigger changed during normalization'
      USING ERRCODE='55000';
  END IF;
END;
$verify_receipted_tournament_immutability_guard_restored$;

-- One 2026-09-10 satellite settlement committed all obligations and the
-- terminal tournament row, but the older recovery writer omitted the finish
-- claim. Derive the row exclusively from the unique immutable batch. This is
-- a claim repair only: no chip, wallet, entitlement, obligation, or payout
-- relation is mutated here.
DO $repair_unique_missing_atomic_finish_claim$
DECLARE
  v_missing_count bigint;
  v_candidate_count bigint;
  v_rows integer;
  v_tournament_id uuid;
  v_winner_user_id uuid;
  v_claimed_at timestamptz;
  v_readiness jsonb;
BEGIN
  SELECT count(*)
    INTO v_missing_count
    FROM public.tournaments t
   WHERE upper(t.status::text)='COMPLETED'
     AND (
       EXISTS (
         SELECT 1 FROM public.tournament_place_settlement_batches b
          WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
       OR EXISTS (
         SELECT 1 FROM public.tournament_final_table_deal_batches b
          WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
       OR EXISTS (
         SELECT 1 FROM public.tournament_satellite_settlement_batches b
          WHERE b.tournament_id=t.id AND b.settled_at IS NOT NULL)
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_finish_receipts f
        WHERE f.tournament_id=t.id
     );

  -- A clean replay or a current postimage with no omitted claim needs no DML.
  -- Any missing claim at all, however, must be the one exact measured batch
  -- below; a second or different omission is unknown evidence and aborts.
  IF v_missing_count=0 THEN
    RETURN;
  END IF;

  SELECT count(*)
    INTO v_candidate_count
    FROM public.tournament_satellite_settlement_batches b
    JOIN public.tournaments t ON t.id=b.tournament_id
   WHERE b.plan_fingerprint='6f62035f58476d2b7b40ae8407ce0c61'
     AND b.settled_at='2026-09-10 02:43:03.442124+00'::timestamptz
     AND b.amount_owed=38
     AND b.award_depth=2
     AND b.entitlement_count=2
     AND b.target_tournament_id=t.satellite_target_id
     AND upper(t.status::text)='COMPLETED'
     AND t.ended_at='2026-09-10 02:43:03.45013+00'::timestamptz
     AND public.fn_tournament_finish_kind(t.id)='satellite'
     AND (
       SELECT count(*) FROM public.tournament_players tp
        WHERE tp.tournament_id=t.id
          AND tp.status='winner' AND tp.position=1
          AND tp.user_id=b.winner_user_id
     )=1
     AND jsonb_array_length(b.outcomes)=2
     AND (
       SELECT count(*) FROM jsonb_array_elements(b.outcomes) outcome
        WHERE (outcome->>'position')::integer=1
          AND (outcome->>'ticket_value')::numeric=30
          AND (outcome->>'remainder_value')::numeric=0
          AND outcome->>'ticket_delivery'='cash'
          AND (outcome->>'user_id')::uuid=b.winner_user_id
     )=1
     AND (
       SELECT count(*) FROM jsonb_array_elements(b.outcomes) outcome
        WHERE (outcome->>'position')::integer=2
          AND (outcome->>'ticket_value')::numeric=0
          AND (outcome->>'remainder_value')::numeric=8
          AND outcome->>'ticket_delivery'='cash'
     )=1
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_finish_receipts f
        WHERE f.tournament_id=t.id
     );

  IF v_missing_count<>1 OR v_candidate_count<>1 THEN
    RAISE EXCEPTION
      'expected one exact missing atomic finish claim, found % total / % exact',
      v_missing_count,v_candidate_count USING ERRCODE='check_violation';
  END IF;

  SELECT b.tournament_id,b.winner_user_id,b.settled_at
    INTO STRICT v_tournament_id,v_winner_user_id,v_claimed_at
    FROM public.tournament_satellite_settlement_batches b
    JOIN public.tournaments t ON t.id=b.tournament_id
   WHERE b.plan_fingerprint='6f62035f58476d2b7b40ae8407ce0c61'
     AND b.settled_at='2026-09-10 02:43:03.442124+00'::timestamptz
     AND b.amount_owed=38
     AND b.award_depth=2
     AND b.entitlement_count=2
     AND b.target_tournament_id=t.satellite_target_id
     AND upper(t.status::text)='COMPLETED'
     AND t.ended_at='2026-09-10 02:43:03.45013+00'::timestamptz
     AND public.fn_tournament_finish_kind(t.id)='satellite'
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_finish_receipts f
        WHERE f.tournament_id=t.id
     );

  v_readiness:=public.fn_tournament_finish_readiness(
    v_tournament_id,v_winner_user_id);
  IF v_readiness->>'reason' IS DISTINCT FROM 'finish_claim_missing'
     OR jsonb_array_length(COALESCE(v_readiness->'failures','[]'::jsonb))<>1
     OR v_readiness->'failures'->0->>'code'
          IS DISTINCT FROM 'finish_claim_missing'
     OR COALESCE((v_readiness->'financials'->>'unsettled_obligations')::numeric,-1)<>0
     OR COALESCE((v_readiness->'financials'->>'place_obligations')::numeric,-1)<>0
     OR COALESCE((v_readiness->'financials'->>'prize_balance')::numeric,-1)<>0
     OR COALESCE((v_readiness->'financials'->>'bounty_balance')::numeric,-1)<>0
     OR COALESCE((v_readiness->'financials'->>'fee_balance')::numeric,-1)<>0
  THEN
    RAISE EXCEPTION
      'missing finish claim evidence changed for tournament %: %',
      v_tournament_id,v_readiness USING ERRCODE='check_violation';
  END IF;

  INSERT INTO public.tournament_finish_receipts(
    tournament_id,winner_user_id,finish_kind,claimed_at,claim_source)
  VALUES(
    v_tournament_id,v_winner_user_id,'satellite',v_claimed_at,
    'stage_b_exact_precondition_repair')
  ON CONFLICT (tournament_id) DO NOTHING;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'missing finish claim CAS changed % rows',v_rows
      USING ERRCODE='40001';
  END IF;

  v_readiness:=public.fn_tournament_finish_readiness(
    v_tournament_id,v_winner_user_id);
  IF COALESCE((v_readiness->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'repaired finish claim is not ready for certification: %',v_readiness
      USING ERRCODE='check_violation';
  END IF;
END;
$repair_unique_missing_atomic_finish_claim$;

COMMIT;
