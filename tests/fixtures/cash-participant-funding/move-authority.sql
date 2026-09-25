-- The original movement journal carries custody, never a second buy-in.
-- Legacy movement rows retain NULL transaction identity; no backfill is implied.
ALTER TABLE public.cash_seat_move_receipts ADD COLUMN transaction_id xid8;
ALTER TABLE public.cash_seat_move_receipts ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();
CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.cash_seat_move_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_receipt_frame();
CREATE TRIGGER cash_move_receipt_immutable BEFORE UPDATE OR DELETE ON public.cash_seat_move_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_move_receipt_no_truncate BEFORE TRUNCATE ON public.cash_seat_move_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE INDEX cash_move_receipt_original_occupancy ON public.cash_seat_move_receipts(source_occupancy_id);

CREATE FUNCTION public.fn_cash_original_funding_lineage(
 p_user uuid,p_table uuid,p_seat uuid,p_occupancy uuid,p_join timestamptz,p_at timestamptz,p_boundary boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE m public.cash_seat_move_receipts%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; a public.cash_funding_application_receipts%ROWTYPE;
 current_table uuid:=p_table; current_occupancy uuid:=p_occupancy;
 seen uuid[]:=ARRAY[]::uuid[]; ids uuid[]:=ARRAY[]::uuid[]; refs jsonb:='[]'; moves jsonb:='[]'; issues jsonb:='[]';
 cutoff timestamptz:=p_at; cutoff_transaction xid8; move_at timestamptz;
 move_club uuid; n integer; depth integer:=0;
BEGIN
 IF p_user IS NULL OR p_table IS NULL OR p_seat IS NULL OR p_occupancy IS NULL
  OR p_join IS NULL OR NOT isfinite(p_join) OR p_at IS NULL OR NOT isfinite(p_at) THEN
  RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts',refs,'moves',moves,'issues',jsonb_build_array('cash_lineage_identity_missing'));
 END IF;
 LOOP
  IF current_occupancy=ANY(seen) OR depth>64 THEN
   issues:=issues||'"cash_move_cycle_or_depth_unproven"'::jsonb; EXIT;
  END IF;
  seen:=array_append(seen,current_occupancy);
  FOR f IN SELECT r.* FROM public.cash_participant_funding_receipts r
   LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.recorded_at) ELSE r.recorded_at END)<p_at
    AND ((CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.recorded_at) ELSE r.recorded_at END)<=cutoff OR r.transaction_id=cutoff_transaction)
   ORDER BY r.recorded_at,r.id LOOP
   IF f.id=ANY(ids) OR f.user_id IS DISTINCT FROM p_user OR f.table_id IS DISTINCT FROM current_table
    OR (depth=0 AND (f.seat_id IS DISTINCT FROM p_seat OR f.seat_joined_at IS DISTINCT FROM p_join))
    OR (move_club IS NOT NULL AND f.funding_club_id IS DISTINCT FROM move_club)
    OR (f.account_type='player_wallet' AND f.account_entity_id IS DISTINCT FROM f.user_id)
    OR (f.account_type='club_treasury' AND f.account_entity_id IS DISTINCT FROM f.funding_club_id)
    OR f.asset IS DISTINCT FROM 'chips' OR f.unit_scale<>2 OR NOT isfinite(f.recorded_at)
    OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN ('NaN','Infinity','-Infinity')
    OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN
    issues:=issues||'"cash_lineage_funding_identity_invalid"'::jsonb;
   END IF;
   SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
   IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR l.club_id IS DISTINCT FROM f.funding_club_id
    OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
    OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id
    OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN
    issues:=issues||'"cash_lineage_original_debit_invalid"'::jsonb;
   END IF;
   IF f.pending_addon_id IS NOT NULL AND NOT p_boundary THEN
    SELECT * INTO a FROM public.cash_funding_application_receipts WHERE funding_receipt_id=f.id;
    IF NOT FOUND OR a.original_occupancy_id IS DISTINCT FROM f.occupancy_id
     OR a.applied_at>p_at OR NOT isfinite(a.applied_at) OR a.applied+a.refunded IS DISTINCT FROM f.amount
     OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN
     issues:=issues||'"pending_funding_application_unproven"'::jsonb;
    END IF;
   END IF;
   ids:=array_append(ids,f.id);
   refs:=refs||jsonb_build_array(jsonb_build_object('id',f.id,'account_type',f.account_type,
    'account_entity_id',f.account_entity_id,'funding_club_id',f.funding_club_id,'funding_union_id',f.funding_union_id,
    'pending_addon_id',f.pending_addon_id));
  END LOOP;
  SELECT count(*) INTO n FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  IF n=0 THEN EXIT; END IF;
  IF n<>1 THEN issues:=issues||'"cash_move_destination_fork"'::jsonb; EXIT; END IF;
  SELECT r.* INTO m FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  SELECT observed_at INTO move_at FROM public.union_pnl_transaction_frames WHERE transaction_id=m.transaction_id;
  IF p_boundary AND (m.transaction_id IS NULL OR move_at IS NULL) THEN
   issues:=issues||'"cash_move_original_transaction_frame_missing"'::jsonb;
  END IF;
  IF m.player_id IS DISTINCT FROM p_user OR m.to_table_id IS DISTINCT FROM current_table
   OR m.source_occupancy_id=ANY(seen) OR m.from_table_id=m.to_table_id
   OR m.club_id IS NULL OR (move_club IS NOT NULL AND m.club_id IS DISTINCT FROM move_club)
   OR m.amount<=0 OR m.amount<>round(m.amount,2) OR m.amount::text IN ('NaN','Infinity','-Infinity')
   OR NOT isfinite(m.created_at) OR (CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END)>cutoff
   OR (move_at IS NOT NULL AND (NOT isfinite(move_at) OR move_at>=p_at))
   OR jsonb_typeof(m.receipt) IS DISTINCT FROM 'object' OR m.receipt->>'ok' IS DISTINCT FROM 'true'
   OR m.receipt->>'move_id' IS DISTINCT FROM m.move_id::text OR m.receipt->>'player_id' IS DISTINCT FROM p_user::text
   OR m.receipt->>'from_table_id' IS DISTINCT FROM m.from_table_id::text
   OR m.receipt->>'to_table_id' IS DISTINCT FROM m.to_table_id::text
   OR m.receipt->>'source_seat_number' IS DISTINCT FROM m.from_seat_number::text
   OR m.receipt->>'to_seat_number' IS DISTINCT FROM m.to_seat_number::text
   OR m.receipt->>'source_occupancy_id' IS DISTINCT FROM m.source_occupancy_id::text
   OR m.receipt->>'destination_occupancy_id' IS DISTINCT FROM m.destination_occupancy_id::text
   OR public.fn_pnl_evidence_cents(m.receipt->'stack') IS DISTINCT FROM m.amount
   OR m.receipt->>'idempotency_key' IS DISTINCT FROM 'seatmove:'||m.move_id::text
   OR (SELECT count(*) FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id WHERE r.source_occupancy_id=m.source_occupancy_id AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at)<>1 THEN
   issues:=issues||'"cash_move_original_receipt_invalid"'::jsonb; EXIT;
  END IF;
  moves:=moves||jsonb_build_array(to_jsonb(m));
  move_club:=m.club_id; current_table:=m.from_table_id; current_occupancy:=m.source_occupancy_id;
  cutoff:=CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END; cutoff_transaction:=m.transaction_id; depth:=depth+1;
 END LOOP;
 -- Every retained source must agree with the exact custody club through all moves.
 IF move_club IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(refs) r WHERE r->>'funding_club_id' IS DISTINCT FROM move_club::text) THEN
  issues:=issues||'"cash_move_original_funding_club_mismatch"'::jsonb;
 END IF;
 RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts',refs,'moves',moves,'issues',issues);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts','[]'::jsonb,'moves',moves,'issues',jsonb_build_array('cash_move_malformed_original_evidence'));
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;
