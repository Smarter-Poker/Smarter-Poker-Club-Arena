CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE inv jsonb; holdings jsonb:='[]'; issues jsonb:='[]'; s jsonb; t jsonb; f record; tr record;
 lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;
 nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric; v_proj boolean;
BEGIN
 inv:=public.fn_union_pnl_inventory_as_of(p_at);
 IF inv->>'status' IS DISTINCT FROM 'observed' THEN RETURN jsonb_build_object('status','blocked','inventory',inv,'holdings',holdings); END IF;
 FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,table_seats}','[]')) x
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
   WHERE y#>>'{row,id}'=x#>>'{row,table_id}' AND y#>>'{row,union_id}'=p_union_id::text) LOOP
  lineage:=public.fn_cash_original_funding_lineage((s->>'user_id')::uuid,(s->>'table_id')::uuid,
   (s->>'id')::uuid,(s->>'occupancy_id')::uuid,(s->>'joined_at')::timestamptz,p_at,true);
  SELECT count(*) FILTER(WHERE r.operation_kind='buyin'),count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)),min(r.funding_club_id::text)::uuid
   INTO initial,owners,owned FROM jsonb_array_elements(lineage->'funding_receipts') ref
   JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid;
  value:=public.fn_pnl_evidence_cents(s->'stack');
  IF lineage->'issues'<>'[]'::jsonb OR initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','cash_boundary_original_funding_missing_or_ambiguous','seat_id',s->'id'));
  ELSE
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','cash_stack','source_id',s->'id'));
  END IF;
 END LOOP;
 -- Money awaiting the original add-on application is still held for its
 -- original funding account. It must not appear as a poker loss at midnight.
 FOR f IN
  SELECT r.*,r.amount-CASE WHEN COALESCE(af.observed_at,a.applied_at)<p_at THEN a.applied+a.refunded ELSE 0 END AS held
  FROM public.cash_participant_funding_receipts r
  LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=r.id
  LEFT JOIN public.union_pnl_transaction_frames rf ON rf.transaction_id=r.transaction_id
  LEFT JOIN public.union_pnl_transaction_frames af ON af.transaction_id=a.transaction_id
  WHERE r.pending_addon_id IS NOT NULL AND COALESCE(rf.observed_at,r.recorded_at)<p_at
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
    WHERE y#>>'{row,id}'=r.table_id::text AND y#>>'{row,union_id}'=p_union_id::text)
 LOOP
  IF f.held<0 OR f.funding_club_id IS NULL THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_boundary_invalid','source_id',f.id));
  ELSIF f.held>0 THEN
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',f.funding_club_id,'user_id',f.user_id,'amount',f.held,'kind','pending_cash_funding','source_id',f.id));
  END IF;
 END LOOP;
 -- Preserve the established realized-settlement rule: original gross entry
 -- less money already returned is deferred while a tournament remains open.
 -- This is not market value, ICM, or a new allocation of the prize pool.
 -- First inventory operations come from union_pnl_inventory_touches once its
 -- backfill is complete (20260929044303), else from the wide events.
 v_proj:=public.fn_union_pnl_projection_ready('inventory_touches');
 FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x
  WHERE x#>>'{row,union_id}'=p_union_id::text LOOP
  first_op:=public.fn_union_pnl_first_inventory_operation('tournaments',(t->>'id')::uuid,v_proj);
  -- A tournament captured as the baseline (it existed before the original
  -- inventory capture) is read only when every registration of its original
  -- population carries a valid opening resolution for this boundary
  -- (union_pnl_opening_registration_resolutions: its entry re-proved from the
  -- posted chip ledger, bound to these exact population rows). Otherwise it is
  -- refused exactly as before.
  IF first_op IS DISTINCT FROM 'INSERT' AND (first_op IS DISTINCT FROM 'baseline' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) y(x)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
     AND public.fn_union_pnl_first_inventory_operation('tournament_players',(y.x#>>'{row,id}')::uuid,v_proj) IS DISTINCT FROM 'INSERT'
     AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,y.x->'row')))) THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
  -- One set-based read per open tournament (it was four queries per seat,
  -- two of them full scans of every tournament credit): the same original
  -- entry, instrument, owner-change and returned-credit facts, per
  -- registration, in the population's order.
  FOR s,entries,owners,owned,value,nonchips,changed,returned,res_club,res_amount IN
   WITH players AS MATERIALIZED (
    SELECT y.x->'row' s,y.o ord,(y.x#>>'{row,id}')::uuid registration_id,(y.x#>>'{row,user_id}')::uuid user_id
    FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) WITH ORDINALITY y(x,o)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
   ), credits AS MATERIALIZED (
    -- fn_union_pnl_tournament_returns(t,NULL,NULL,p_at): every credit of this
    -- tournament observed before the boundary; the registration filter that
    -- function applied per call is applied per player below.
    SELECT c.user_id,c.credited_club_id,c.amount,c.entry_receipt_ids,true same_tournament
    FROM public.tournament_accounting_credit_receipts c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
    UNION ALL
    SELECT r2.user_id,r2.source_wallet_club_id,r2.amount_paid_now,ARRAY[r.id],false
    FROM public.tournament_refund_tranches r2
    JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=r2.entitlement_id
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
    WHERE r2.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
     AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=r2.credit_ledger_id)
   ) SELECT p.s,e.entries,e.owners,e.owned,e.value,
    EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND r.asset<>'chips'),
    k.changed,k.returned,rr.owning_club_id,rr.deferred_amount
   FROM players p
   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)) owners,
     min(public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)::text)::uuid owned,sum(r.amount) value
    FROM public.tournament_participant_funding_receipts r
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
    WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND b.observed_at<p_at AND r.asset='chips') e
   CROSS JOIN LATERAL (SELECT COALESCE(bool_or(c.credited_club_id<>e.owned),false) changed,sum(c.amount) returned
    FROM credits c WHERE c.user_id=p.user_id
     AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
      WHERE r.registration_id=p.registration_id AND r.id=ANY(c.entry_receipt_ids)
       AND (NOT c.same_tournament OR r.tournament_id=(t->>'id')::uuid))) k
   LEFT JOIN LATERAL (SELECT q.owning_club_id,q.deferred_amount
    FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,p.s) q WHERE first_op='baseline') rr ON true
   ORDER BY p.ord
  LOOP
   -- In a baseline tournament a resolved registration is carried at its
   -- re-proved original entry less its returns before the boundary.
   IF res_club IS NOT NULL THEN
    holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',res_club,'user_id',s->'user_id','amount',res_amount,
     'kind','deferred_tournament_result','source_id',s->'id','basis','opening_registration_resolution'));
    CONTINUE;
   END IF;
   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_original_instrument_or_earning_club_missing','registration_id',s->'id')); CONTINUE;
   END IF;
   IF changed THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_credit_owner_changed','registration_id',s->'id')); CONTINUE;
   END IF;
   value:=value-COALESCE(returned,0);
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','deferred_tournament_result','source_id',s->'id'));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('status',CASE WHEN issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,'boundary',p_at,
  'inventory',inv,'holdings',holdings,'issues',issues,'tournament_basis','original_realized_settlement_deferred_while_open');
END $function$
