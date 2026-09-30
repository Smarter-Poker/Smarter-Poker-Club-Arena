-- Reserve: scripts/new-migration.mjs, 2026-09-30. Forward-only blocker repair.
-- The installed owner operation requests G/B exclusively against live hands and
-- scans all suspense twice. Use the installed non-satellite member lane and the
-- existing indexed journal provenance. No common financial writer is replaced.
BEGIN;
DO $guard$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)','ca906b422c26f10d1288a4fcc165c0f1'),
  ('public.fn_ca_lock_settlement_lane_for_sweep_member(uuid)','d2dc0d0ec19b490b52d25b319942e4a0'),
  ('public.fn_ca_chip_ledger_enrich()','5931f47d922eea26ab1ea2b12f3f7c8c'),
  ('public.fn_ca_autoledger()','53f9d85b88cc86b807f7ea5b80d7bd4e')
 ) x(identity,expected_md5) LOOP
  IF md5(pg_get_functiondef(to_regprocedure(r.identity))) IS DISTINCT FROM r.expected_md5 THEN
   RAISE EXCEPTION 'held fee member lane predecessor changed: %',r.identity USING ERRCODE='55000'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.ix_chip_ledger_settlement')
  AND i.indisvalid AND i.indisready
  AND pg_get_indexdef(i.indexrelid)='CREATE INDEX ix_chip_ledger_settlement ON public.chip_ledger USING btree (settlement_id) WHERE (settlement_id IS NOT NULL)')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.chip_ledger'::regclass
   AND tgname='trg_ca_chip_ledger_enrich' AND tgenabled='O'
   AND tgfoid='public.fn_ca_chip_ledger_enrich()'::regprocedure AND tgtype=7) THEN
  RAISE EXCEPTION 'held fee member lane journal provenance changed' USING ERRCODE='55000'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(p_operation_id uuid,p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='120s' SET lock_timeout='5s' AS $$
DECLARE
 c_reason CONSTANT text:='Owner-authorized recognition basis: a tournament entry fee is the house fee of the club that hosted the event. '
  ||'It flows onward exactly as that club''s cash rake does, through the union/club agreement and agent hierarchy recorded at the event''s completion '
  ||'(fn_accounting_earning_contract at completed_at), because no agreement was recorded at the original charge instant. '
  ||'Players were final and paid before this operation; only the held house fee moves. No code-default rate is used as an agreement.';
 c_instruction CONSTANT text:='Agent decision, 2026-09-30, under the owner''s delegated financial repair authority in CLAUDE.md 10.9 and instruction to finish this MTT delivery. '
  ||'Resolve only the recorded held house fees through the host-club route and agreements observed at each recorded completion. '
  ||'The owner delegated the correction; the completion-time basis is the agent''s decision, not an owner-selected rate or reconstructed charge-time agreement.';
 c_date CONSTANT date:='2026-09-30';
 prior public.accounting_tournament_fee_owner_operations%ROWTYPE;
 ev record;t record;h record;o record;e record;res jsonb;receipt jsonb;
 total numeric:=0;n integer:=0;results jsonb:='[]';
 prizes_before jsonb;prizes_after jsonb;
 journal_count integer;journal_events integer;journal_amount numeric;journal_invalid integer;
 journal_tag text:='owner-basis:'||p_operation_id::text;
 ledger_context jsonb;context_item record;
 escrow_out numeric;escrow_out_before numeric:=0;bank_in numeric;credited numeric;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_operation_id IS NULL OR p_events IS NULL OR jsonb_typeof(p_events)<>'array' OR jsonb_array_length(p_events)=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_events) x WHERE jsonb_typeof(x)<>'object'
   OR NOT (x ? 'tournament_id') OR NOT (x ? 'amount'))
  OR (SELECT count(*)<>count(DISTINCT x->>'tournament_id') FROM jsonb_array_elements(p_events) x)
 THEN RAISE EXCEPTION 'owner_fee_operation_invalid' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ca:owner-fee-operation:'||p_operation_id::text,0));
 SELECT * INTO prior FROM public.accounting_tournament_fee_owner_operations WHERE operation_id=p_operation_id;
 IF FOUND THEN
  IF prior.events IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('tournament_id',(x->>'tournament_id')::uuid,'amount',(x->>'amount')::numeric)
     ORDER BY (x->>'tournament_id')::uuid) FROM jsonb_array_elements(p_events) x) THEN
   RAISE EXCEPTION 'owner_fee_operation_replayed_with_different_events' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'replayed',true,'operation_id',p_operation_id,'executed_at',prior.executed_at,
   'event_count',prior.event_count,'amount',prior.amount,
   'events',(SELECT jsonb_agg(jsonb_build_object('tournament_id',b.tournament_id,'amount',b.amount,
     'receipt',public.fn_ca_tournament_fee_custody_receipt(b.tournament_id)) ORDER BY b.tournament_id)
     FROM public.accounting_tournament_fee_owner_bases b WHERE b.operation_id=p_operation_id));
 END IF;
 -- Acquire the existing G-shared/F/T-member lane in one deterministic order.
 -- Re-enter per member below so nested settlement uses the genuine held lane.
 FOR ev IN SELECT (x->>'tournament_id')::uuid tournament_id
  FROM jsonb_array_elements(p_events) x ORDER BY (x->>'tournament_id')::uuid LOOP
  PERFORM public.fn_ca_lock_settlement_lane_for_sweep_member(ev.tournament_id);
 END LOOP;
 -- An existing operation-tagged leg without its durable operation is not ours.
 IF EXISTS(SELECT 1 FROM public.chip_ledger WHERE settlement_id=journal_tag) THEN
  RAISE EXCEPTION 'owner_fee_operation_journal_already_exists' USING ERRCODE='P0404'; END IF;
 SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO ledger_context
 FROM unnest(ARRAY['app.ledger_settlement','app.ledger_correlation','app.ledger_tournament_id',
  'app.ledger_hand_id','app.ledger_idempotency_key','app.ledger_category',
  'app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_autoledger_club_id']) k;
 PERFORM set_config('app.ledger_settlement',journal_tag,true);
 PERFORM set_config('app.ledger_correlation',p_operation_id::text,true);
 PERFORM set_config('app.ledger_hand_id','',true);
 PERFORM set_config('app.ledger_idempotency_key','',true);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('t',p.tournament_id,'payouts',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.tournament_payouts x WHERE x.tournament_id=p.tournament_id),
   'players',(SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.id),'[]') FROM public.tournament_players y WHERE y.tournament_id=p.tournament_id),
   'header',(SELECT to_jsonb(z) FROM public.tournament_terminal_settlements z WHERE z.tournament_id=p.tournament_id),
   'escrow',(SELECT to_jsonb(w)-ARRAY['fee_out','fee_balance','updated_at'] FROM public.tournament_escrow w WHERE w.tournament_id=p.tournament_id))
   ORDER BY p.tournament_id),'[]') INTO prizes_before
  FROM (SELECT DISTINCT (x->>'tournament_id')::uuid tournament_id FROM jsonb_array_elements(p_events) x) p;
 INSERT INTO public.accounting_tournament_fee_owner_operations(operation_id,basis_kind,reason,owner_instruction,authorized_on,events,event_count,amount)
 SELECT p_operation_id,'owner_authorized_host_club_fee',c_reason,c_instruction,c_date,
  jsonb_agg(jsonb_build_object('tournament_id',(x->>'tournament_id')::uuid,'amount',(x->>'amount')::numeric) ORDER BY (x->>'tournament_id')::uuid),
  count(*),sum((x->>'amount')::numeric) FROM jsonb_array_elements(p_events) x;
 FOR ev IN SELECT (x->>'tournament_id')::uuid tournament_id,(x->>'amount')::numeric amount
   FROM jsonb_array_elements(p_events) x ORDER BY (x->>'tournament_id')::uuid LOOP
  PERFORM public.fn_ca_lock_settlement_lane_for_sweep_member(ev.tournament_id);
  PERFORM set_config('app.ledger_tournament_id',ev.tournament_id::text,true);
  SELECT id,club_id,union_id,is_private,status INTO t FROM public.tournaments WHERE id=ev.tournament_id;
  SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=ev.tournament_id;
  SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=ev.tournament_id;
  SELECT * INTO e FROM public.tournament_escrow WHERE tournament_id=ev.tournament_id;
  IF t.id IS NULL OR t.club_id IS NULL OR h.tournament_id IS NULL OR o.id IS NULL OR e.tournament_id IS NULL
   OR h.accounting_state IS DISTINCT FROM 'fee_custody_unresolved' OR h.receipt_version IS DISTINCT FROM 3
   OR h.escrow_closed_at IS NOT NULL OR h.rake_amount IS DISTINCT FROM ev.amount OR o.amount IS DISTINCT FROM ev.amount
   OR e.fee_balance IS DISTINCT FROM ev.amount OR e.prize_balance IS DISTINCT FROM 0::numeric OR e.bounty_balance IS DISTINCT FROM 0::numeric
   OR e.closed_at IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions x WHERE x.tournament_id=ev.tournament_id)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions x WHERE x.tournament_id=ev.tournament_id)
   OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements x WHERE x.tournament_id=ev.tournament_id)
  THEN RAISE EXCEPTION 'owner_fee_event_is_not_exactly_held: %',ev.tournament_id USING ERRCODE='P0404'; END IF;
  INSERT INTO public.accounting_tournament_fee_owner_bases(tournament_id,operation_id,basis_kind,hosting_club_id,union_id,completed_at,
   amount,obligation_id,source_fingerprint,reason,owner_instruction,authorized_on)
  VALUES(ev.tournament_id,p_operation_id,'owner_authorized_host_club_fee',t.club_id,CASE WHEN t.is_private THEN NULL ELSE t.union_id END,
   h.completed_at,ev.amount,o.id,o.source_fingerprint,c_reason,c_instruction,c_date);
  res:=public.fn_settle_tournament_rake(ev.tournament_id,'owner-basis:'||p_operation_id::text);
  receipt:=public.fn_ca_tournament_fee_custody_receipt(ev.tournament_id);
  IF res->>'ok' IS DISTINCT FROM 'true' OR (res->>'amount')::numeric IS DISTINCT FROM ev.amount
   OR receipt->>'accounting_complete' IS DISTINCT FROM 'true' OR (receipt->>'current_held_amount')::numeric IS DISTINCT FROM 0::numeric
   OR receipt->'resolution'->>'status' IS DISTINCT FROM 'recognized'
   OR (receipt->'resolution'->>'bank_amount')::numeric IS DISTINCT FROM ev.amount
   OR (SELECT fee_balance FROM public.tournament_escrow WHERE tournament_id=ev.tournament_id) IS DISTINCT FROM 0::numeric
   OR (SELECT fee_out FROM public.tournament_escrow WHERE tournament_id=ev.tournament_id) IS DISTINCT FROM e.fee_out+ev.amount
  THEN RAISE EXCEPTION 'owner_fee_event_not_resolved: %',ev.tournament_id USING ERRCODE='P0404'; END IF;
  total:=total+ev.amount;n:=n+1;escrow_out_before:=escrow_out_before+e.fee_out;
  results:=results||jsonb_build_array(jsonb_build_object('tournament_id',ev.tournament_id,'amount',ev.amount,
   'hosting_club_id',t.club_id,'union_id',CASE WHEN t.is_private THEN NULL ELSE t.union_id END,'completed_at',h.completed_at,
   'destination',res->>'destination','attributed_users',res->'attributed_users',
   'bank_receipt_kind',receipt->'resolution'->>'bank_receipt_kind','bank_receipt_id',receipt->'resolution'->>'bank_receipt_id'));
 END LOOP;
 -- Conservation to the cent: escrow out = bank in = recognized credit.
 SELECT COALESCE(sum(w.fee_out),0)-escrow_out_before INTO escrow_out FROM public.tournament_escrow w
  WHERE w.tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id);
 SELECT COALESCE(sum(amount),0) INTO bank_in FROM (
  SELECT u.amount FROM public.accounting_tournament_fee_recognitions q JOIN public.union_wallet_transactions u ON u.id=q.union_wallet_transaction_id
   WHERE q.tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id)
  UNION ALL
  SELECT l.amount FROM public.accounting_tournament_fee_recognitions q JOIN public.chip_ledger l ON l.id=q.bank_journal_id
   WHERE q.tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id)) z;
 SELECT COALESCE(sum(rake_credit),0) INTO credited FROM public.accounting_tournament_recognized_sources
  WHERE disposition='earned' AND tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id);
 -- The existing settlement index bounds this proof to our operation. There
 -- must be exactly one canonical bank leg for each event and no other leg,
 -- including no zero-net pair through suspense. No global ledger scan/lock.
 SELECT count(*),count(DISTINCT l.tournament_id),COALESCE(sum(l.amount),0),
  count(*) FILTER(WHERE NOT COALESCE(
   b.tournament_id IS NOT NULL AND q.status='recognized'
   AND l.correlation_id=p_operation_id AND l.from_type='prize_liability'
   AND l.from_entity_id=b.tournament_id AND l.club_id=b.hosting_club_id
   AND l.amount=b.amount AND l.created_at=q.recognized_at AND l.status='posted'
   AND l.table_id IS NULL AND l.hand_id IS NULL AND l.idempotency_key IS NULL AND l.metadata IS NULL
   AND ((b.union_id IS NOT NULL AND l.to_type='union_wallet' AND wallet.union_id=b.union_id
    AND l.union_id=b.union_id AND l.to_label='union_wallets.rake_wallet' AND l.category='rake'
    AND u.id IS NOT NULL AND u.union_id=b.union_id AND u.club_id=b.hosting_club_id
    AND u.wallet='rake_wallet' AND u.direction='credit' AND u.tx_type='rake'
    AND u.amount=b.amount AND u.created_at=q.recognized_at
    AND l.pre_to_balance+l.amount=l.post_to_balance AND l.post_to_balance=u.balance_after)
   OR(b.union_id IS NULL AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL
    AND l.category='burn' AND l.id=q.bank_journal_id AND q.union_wallet_transaction_id IS NULL)),false))
 INTO journal_count,journal_events,journal_amount,journal_invalid
 FROM public.chip_ledger l
 LEFT JOIN public.accounting_tournament_fee_owner_bases b
  ON b.tournament_id=l.tournament_id AND b.operation_id=p_operation_id
 LEFT JOIN public.accounting_tournament_fee_recognitions q ON q.tournament_id=b.tournament_id
 LEFT JOIN public.union_wallet_transactions u ON u.id=q.union_wallet_transaction_id
 LEFT JOIN public.union_wallets wallet ON wallet.id=l.to_entity_id
 WHERE l.settlement_id=journal_tag;
 IF journal_count<>n OR journal_events<>n OR journal_amount IS DISTINCT FROM total OR journal_invalid<>0 THEN
  RAISE EXCEPTION 'owner_fee_operation_journal_not_exact: rows=% events=% amount=% invalid=%',
   journal_count,journal_events,journal_amount,journal_invalid USING ERRCODE='P0404'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('t',p.tournament_id,'payouts',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.tournament_payouts x WHERE x.tournament_id=p.tournament_id),
   'players',(SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.id),'[]') FROM public.tournament_players y WHERE y.tournament_id=p.tournament_id),
   'header',(SELECT to_jsonb(z) FROM public.tournament_terminal_settlements z WHERE z.tournament_id=p.tournament_id),
   'escrow',(SELECT to_jsonb(w)-ARRAY['fee_out','fee_balance','updated_at'] FROM public.tournament_escrow w WHERE w.tournament_id=p.tournament_id))
   ORDER BY p.tournament_id),'[]') INTO prizes_after
  FROM (SELECT DISTINCT (x->>'tournament_id')::uuid tournament_id FROM jsonb_array_elements(p_events) x) p;
 IF n<>jsonb_array_length(p_events) OR total IS DISTINCT FROM (SELECT amount FROM public.accounting_tournament_fee_owner_operations WHERE operation_id=p_operation_id)
  OR escrow_out IS DISTINCT FROM total OR bank_in IS DISTINCT FROM total OR credited IS DISTINCT FROM total
  OR prizes_after IS DISTINCT FROM prizes_before THEN
  RAISE EXCEPTION 'owner_fee_operation_not_conserved: total=% escrow_out=% bank_in=% credited=% prizes_unchanged=%',
   total,escrow_out,bank_in,credited,prizes_after IS NOT DISTINCT FROM prizes_before USING ERRCODE='P0404';
 END IF;
 FOR context_item IN SELECT key,value FROM jsonb_each_text(ledger_context) LOOP
  PERFORM set_config(context_item.key,context_item.value,true);
 END LOOP;
 RETURN jsonb_build_object('ok',true,'replayed',false,'operation_id',p_operation_id,'executed_at',transaction_timestamp(),
  'basis_kind','owner_authorized_host_club_fee','event_count',n,'amount',total,'escrow_out',escrow_out,'bank_in',bank_in,
  'recognized_credit',credited,'settlement_suspense_net',0,'journal_rows',journal_count,'journal_settlement_id',journal_tag,'prizes_unchanged',true,'events',results);
END $$;
-- Reassert the installed service-only ACL so the migration declares its own
-- browser boundary and preserves the qualified owner/comment.
REVOKE ALL ON FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) TO service_role;
COMMIT;
