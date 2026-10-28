DO $native_only$BEGIN IF current_database()<>'original_source_refs' OR inet_server_addr()IS NOT NULL OR current_setting('port')<>'55931' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'original_occupancy_fixture_requires_isolated_native_PG17';END IF;END$native_only$;
SAVEPOINT original_occupancy_cases;
CREATE TEMP TABLE occupancy_real_initials AS SELECT row_number()OVER(ORDER BY id)n,r.* FROM public.cash_participant_funding_receipts r WHERE operation_kind='buyin';
DO $original_receipts$BEGIN IF(SELECT count(*)FROM occupancy_real_initials)<5 THEN RAISE EXCEPTION 'native_genuine_initial_receipts_missing';END IF;END$original_receipts$;
CREATE TEMP TABLE occupancy_cases(label text,ledger_id uuid,tx xid8,r public.cash_participant_funding_receipts,expected_valid boolean);
INSERT INTO occupancy_cases SELECT v.label,('cccccccc-aaaa-0000-0000-'||lpad(v.n::text,12,'0'))::uuid,('40000000'||v.n::text)::xid8,jsonb_populate_record(NULL::public.cash_participant_funding_receipts,to_jsonb(r)-'n'),v.valid FROM(VALUES
 (1,'event',1,true),(2,'duplicate_event',1,true),(3,'null_event',1,false),(4,'foreign_event',1,false),(5,'refund',2,true),(6,'both_keys',3,true),(7,'wrong_refund_tx',4,false))v(n,label,receipt,valid)JOIN occupancy_real_initials r ON r.n=v.receipt;
INSERT INTO public.chip_ledger(id,club_id,table_id,from_type,from_entity_id,to_type,to_entity_id,amount,category,idempotency_key,status,created_at)
 SELECT ledger_id,(r).funding_club_id,(r).table_id,'table_stack',(r).table_id,'player_wallet',(r).user_id,50,'cashout','native-occupancy:'||label,'posted','2026-10-25 01:00Z'FROM occupancy_cases;
INSERT INTO public.union_pnl_original_flows(ledger_id,transaction_id,recognized_at,game_scope,ledger_snapshot)
 SELECT c.ledger_id,c.tx,'2026-10-25 01:00Z',jsonb_build_object('asset','chips','unit_scale',2,'game_union_id','fade0000-0000-0000-0000-000000000001','tournament_id',NULL),to_jsonb(l)
 FROM occupancy_cases c JOIN public.chip_ledger l ON l.id=c.ledger_id;
INSERT INTO public.union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 SELECT(SELECT coalesce(max(event_id),0)FROM public.union_pnl_inventory_events)+row_number()OVER(), 'table_seats',(r).seat_id,'2026-10-25 01:00Z',tx,'INSERT',NULL,
 jsonb_build_object('table_id',(r).table_id,'occupancy_id',CASE WHEN label='null_event'THEN NULL WHEN label='foreign_event'THEN'ffffffff-ffff-ffff-ffff-ffffffffffff'ELSE(r).occupancy_id::text END)
 FROM occupancy_cases WHERE label IN('event','duplicate_event','null_event','foreign_event','both_keys');
INSERT INTO public.union_pnl_inventory_events(event_id,source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)SELECT(SELECT max(event_id)+100 FROM public.union_pnl_inventory_events),source_name,row_id,observed_at,transaction_id,operation,before_row,after_row FROM public.union_pnl_inventory_events WHERE transaction_id=(SELECT tx FROM occupancy_cases WHERE label='duplicate_event');
INSERT INTO public.cash_funding_application_receipts(funding_receipt_id,transaction_id,original_occupancy_id,pending_addon_id,applied_occupancy_id,applied_at,applied,refunded)
 SELECT(r).id,tx,(r).occupancy_id,(r).pending_addon_id,(r).occupancy_id,'2026-10-25 01:00Z',0,50 FROM occupancy_cases WHERE label IN('refund','both_keys');
CREATE TEMP TABLE occupancy_old_full AS SELECT * FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z');
CREATE TEMP TABLE occupancy_old_window AS SELECT * FROM smarter_private.union_pnl_original_flow_evidence_window('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-26 07:00Z');
DO $old$BEGIN
 IF EXISTS(SELECT FROM occupancy_cases c LEFT JOIN occupancy_old_full f USING(ledger_id)WHERE f.valid IS DISTINCT FROM c.expected_valid)THEN RAISE EXCEPTION 'native_original_witness_branch_expectation_failed';END IF;
END$old$;
