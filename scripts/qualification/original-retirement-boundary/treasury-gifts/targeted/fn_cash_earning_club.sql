CREATE OR REPLACE FUNCTION public.fn_cash_earning_club(p_hand_id uuid, p_table_id uuid, p_player_id uuid, p_source_club uuid, p_union_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE started timestamptz;clubs uuid[];chair uuid[];paid uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL OR p_table_id IS NULL OR p_player_id IS NULL OR p_source_club IS NULL THEN
  RAISE EXCEPTION 'cash_earning_identity_missing' USING ERRCODE='23514'; END IF;
 SELECT h.started_at INTO started FROM public.hand_history h WHERE h.id=p_hand_id AND h.table_id=p_table_id;
 -- Original off-chair custody exists only in the accepted native hand's
 -- transaction. Never derive ownership from today's replacement chair.
 IF started IS NOT NULL AND isfinite(started) AND started<=transaction_timestamp() THEN
  SELECT array_agg(DISTINCT r.funding_club_id) INTO clubs
  FROM smarter_private.retired_cash_hand_custody r
  JOIN smarter_private.retired_cash_hand_qualification q USING(submission_id)
  JOIN smarter_private.hand_submissions s USING(submission_id)
  JOIN smarter_private.hand_submission_handoffs h USING(submission_id)
  JOIN public.hand_atomic_commits a ON a.hand_id=r.submission_id
   AND a.table_id=r.table_id AND a.hand_number=r.hand_number
  WHERE r.submission_id=p_hand_id AND r.table_id=p_table_id AND r.user_id=p_player_id
   AND r.state='consumed' AND r.transaction_id=txid_current()
   AND h.transaction_id=r.transaction_id AND h.request_hash=r.request_hash
   AND s.request_hash=r.request_hash AND q.request_hash=r.request_hash
   AND r.accepted_time_bank=r.original_time_bank AND r.settlement_id IS NOT NULL
   AND (q.table_id,q.hand_number)=(r.table_id,r.hand_number)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.expected->'participants') e
    WHERE (e#>>'{stack,user_id}')::uuid=r.user_id
     AND (e#>>'{stack,seat_id}')::uuid=r.seat_id
     AND (e#>>'{stack,occupancy_id}')::uuid=r.occupancy_id
     AND (e#>>'{stack,seat_joined_at}')::timestamptz=r.seat_joined_at
     AND (e#>>'{stack,stack_before}')::numeric=r.stack_before
     AND (e#>>'{stack,stack}')::numeric=r.stack_after
     AND (e->>'funding_club_id')::uuid=r.funding_club_id);
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
 END IF;
 -- Funding must exist by the persisted actual hand start. The logical formed_at
 -- supplied by the engine can precede the transaction that opens its slot.
 -- A pooled Lightning hand is funded by its original pool/cash session,
 -- not a physical chair at the synthetic host table. Anchor seats can be
 -- elsewhere or already gone by settlement; their session is retained.
 IF EXISTS(SELECT 1 FROM public.lightning_hand h
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id) THEN
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN
   RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
  -- The earning club is the club whose wallet funded the anchor chair, as
  -- for every Classic chair. cash_player_session.club_id is the TABLE's club,
  -- which on a union-hosted game is the union itself, not the funding club.
  SELECT array_agg(DISTINCT s.club_id) FILTER (WHERE s.club_id IS NOT NULL),
         array_agg(DISTINCT r.funding_club_id) FILTER (WHERE r.funding_club_id IS NOT NULL),
         array_agg(DISTINCT cs.club_id)
    INTO chair, paid, clubs
   FROM public.lightning_hand h
   JOIN public.lightning_hand_player hp ON hp.hand_id=h.hand_id
    AND hp.player_id=p_player_id AND hp.cluster_id=h.cluster_id AND hp.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_slot sl ON sl.id=hp.pool_slot_id AND sl.player_id=hp.player_id
    AND sl.cluster_id=h.cluster_id AND sl.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_session ps ON ps.id=sl.pool_session_id AND ps.player_id=hp.player_id
    AND ps.cluster_id=h.cluster_id AND ps.cluster_epoch=h.cluster_epoch
   JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
   LEFT JOIN public.table_seats s ON s.id=ps.anchor_seat_id AND s.user_id=hp.player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started)
   -- A chair row can be gone by settlement; its buy-in receipt is immutable.
   LEFT JOIN LATERAL (
    SELECT f.funding_club_id FROM public.cash_participant_funding_receipts f
     WHERE smarter_private.cash_initial_funding_receipt(f.id) IS TRUE AND f.table_id=cs.table_id
      AND (f.account_entity_id=hp.player_id OR (f.operation_kind='horse_funding' AND smarter_private.cash_initial_funding_receipt(f.id) IS TRUE))
      AND f.user_id=hp.player_id AND f.seat_id=ps.anchor_seat_id
      AND f.seat_joined_at<=ps.entered_at AND f.recorded_at<=started
     ORDER BY f.seat_joined_at DESC, f.recorded_at DESC, f.id DESC LIMIT 1) r ON true
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id
    AND h.formed_at<=started AND ps.entered_at<=started AND sl.opened_at<=started
    AND cs.opened_at<=started
    AND (ps.exited_at IS NULL OR ps.exited_at>started)
    AND (sl.closed_at IS NULL OR sl.closed_at>started)
    AND (cs.closed_at IS NULL OR cs.closed_at>started);
  IF cardinality(chair)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=chair[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN chair[1]; END IF;
  IF chair IS NULL AND cardinality(paid)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=paid[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN paid[1]; END IF;
  -- No unambiguous funding chair: the original session reader, unchanged.
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
  IF p_union_id IS NOT NULL THEN
   RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF p_union_id IS NULL THEN
  -- Private games may admit a seat funded by another club. Preserve the
  -- actual club at the hand's start; the host only identifies the bank route.
  -- This reader runs before banking an already accepted hand. Unknown seat
  -- evidence must therefore stay NULL, not abort its bank obligation or invent
  -- host ownership. The existing source worker durably refuses that NULL or
  -- an unsupported cross-club liability after the exact bank receipt exists.
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
  -- An overlapping unknown-club seat also makes the evidence ambiguous.
  IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1] AND c.is_union IS NOT TRUE)
  THEN RETURN NULL; END IF;
  RETURN clubs[1];
 END IF;
 -- Preserve the existing shared-union validation and failure contract.
 IF started IS NULL OR started>transaction_timestamp() THEN RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
  WHERE s.table_id=p_table_id AND s.user_id=p_player_id AND s.club_id IS NOT NULL
   AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
 IF cardinality(clubs) IS DISTINCT FROM 1
  OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
   AND (c.is_union IS NOT TRUE OR c.id=p_union_id OR c.union_id=p_union_id))
 THEN RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
 RETURN clubs[1];
END $function$
