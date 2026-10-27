BEGIN;SET LOCAL statement_timeout='50s';SET LOCAL lock_timeout='2s';SET LOCAL timezone='UTC';
-- Draft only. Original financial witnesses, never a replacement funding debit.
CREATE TEMP TABLE pg_temp.original_treasury_funding_witnesses(
 ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),
 source jsonb NOT NULL,source_fingerprint text NOT NULL,historical_late boolean NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(source)='object'),CHECK(length(source_fingerprint)=32));
CREATE UNIQUE INDEX original_treasury_gift_occupancy_once ON pg_temp.original_treasury_funding_witnesses((source#>>'{seat_event,after_row,occupancy_id}')) WHERE kind='gift';
CREATE UNIQUE INDEX original_treasury_return_occupancy_once ON pg_temp.original_treasury_funding_witnesses((source#>>'{seat_event,before_row,occupancy_id}')) WHERE kind='return';
REVOKE ALL ON pg_temp.original_treasury_funding_witnesses FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION pg_temp.original_treasury_witness_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'original_treasury_witness_is_immutable' USING ERRCODE='55000';END$$;
-- Installation time is current, immutable, and independent of an old gift's
-- transaction timestamp. Future atomic gifts never change closed-book bases.
CREATE TEMP TABLE pg_temp.original_treasury_funding_cutover(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),installed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(installed_at)));
INSERT INTO pg_temp.original_treasury_funding_cutover DEFAULT VALUES;
REVOKE ALL ON pg_temp.original_treasury_funding_cutover FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_treasury_cutover_immutable BEFORE UPDATE OR DELETE ON pg_temp.original_treasury_funding_cutover FOR EACH ROW EXECUTE FUNCTION pg_temp.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_cutover_no_truncate BEFORE TRUNCATE ON pg_temp.original_treasury_funding_cutover FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.original_treasury_witness_immutable();
-- Finite pre-cutover admission journal, separate from future live witnesses.
-- Global closed-book generation reads this bounded table, never all live gifts.
CREATE TEMP TABLE pg_temp.original_treasury_historical_admissions(ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),source_fingerprint text NOT NULL CHECK(length(source_fingerprint)=32),admitted_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON pg_temp.original_treasury_historical_admissions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_treasury_historical_immutable BEFORE UPDATE OR DELETE ON pg_temp.original_treasury_historical_admissions FOR EACH ROW EXECUTE FUNCTION pg_temp.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_historical_no_truncate BEFORE TRUNCATE ON pg_temp.original_treasury_historical_admissions FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_immutable BEFORE UPDATE OR DELETE ON pg_temp.original_treasury_funding_witnesses FOR EACH ROW EXECUTE FUNCTION pg_temp.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_no_truncate BEFORE TRUNCATE ON pg_temp.original_treasury_funding_witnesses FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.original_treasury_witness_immutable();

CREATE FUNCTION pg_temp.original_treasury_gift_evidence(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $gift$
DECLARE w pg_temp.original_treasury_funding_witnesses%ROWTYPE;src jsonb;l jsonb;e jsonb;r jsonb;j jsonb;f jsonb;
 uid uuid;bank uuid;club uuid;tid uuid;sid uuid;occ uuid;joined timestamptz;amt numeric;n bigint;cutover_at timestamptz;
BEGIN
 SELECT * INTO w FROM pg_temp.original_treasury_funding_witnesses WHERE ledger_id=p_ledger AND kind='gift';
 IF NOT FOUND OR w.source_fingerprint IS DISTINCT FROM md5(w.source::text) THEN RETURN NULL;END IF;
 src:=w.source;l:=src->'ledger';e:=src->'seat_event';r:=src->'entry';j:=src->'journal';f:=src->'flow';
 SELECT installed_at INTO STRICT cutover_at FROM pg_temp.original_treasury_funding_cutover WHERE singleton;
 IF w.historical_late IS DISTINCT FROM ((f->>'recognized_at')::timestamptz<cutover_at)
  OR (w.historical_late AND NOT EXISTS(SELECT FROM pg_temp.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id AND h.kind=w.kind AND h.source_fingerprint=w.source_fingerprint))
  OR (NOT w.historical_late AND EXISTS(SELECT FROM pg_temp.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id)) THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.chip_ledger q WHERE q.id=p_ledger AND to_jsonb(q)=l;
 IF n<>1 THEN RETURN NULL;END IF;
 uid:=(l#>>'{metadata,user_id}')::uuid;bank:=(l->>'from_entity_id')::uuid;tid:=(l->>'table_id')::uuid;
 club:=(e#>>'{after_row,club_id}')::uuid;sid:=(e#>>'{after_row,id}')::uuid;occ:=(e#>>'{after_row,occupancy_id}')::uuid;
 joined:=(e#>>'{after_row,joined_at}')::timestamptz;amt:=(l->>'amount')::numeric;
 IF uid IS NULL OR bank IS NULL OR club IS NULL OR tid IS NULL OR sid IS NULL OR occ IS NULL OR joined IS NULL OR NOT isfinite(joined)
  OR l->>'status' IS DISTINCT FROM 'posted' OR l->>'category' IS DISTINCT FROM 'horse_funding'
  OR l->>'from_type' IS DISTINCT FROM 'club_treasury' OR l->>'club_id' IS DISTINCT FROM bank::text
  OR l->>'to_type' IS DISTINCT FROM 'table_stack' OR l->>'to_entity_id' IS DISTINCT FROM tid::text
  OR l#>>'{metadata,door}' IS DISTINCT FROM 'fn_horse_seat_from_treasury'
  OR l->>'idempotency_key' IS DISTINCT FROM 'horse_fund:'||(l#>>'{metadata,op_id}')
  OR NULLIF(l#>>'{metadata,op_id}','') IS NULL
  OR amt IS NULL OR amt<=0 OR amt<>round(amt,2) OR amt::text IN('NaN','Infinity','-Infinity')
  OR e->>'source_name' IS DISTINCT FROM 'table_seats' OR e->>'operation' IS DISTINCT FROM 'INSERT'
  OR e->'before_row' IS DISTINCT FROM 'null'::jsonb OR e#>>'{after_row,left_at}' IS NOT NULL
  OR e->>'row_id' IS DISTINCT FROM sid::text OR e#>>'{after_row,user_id}' IS DISTINCT FROM uid::text
  OR e#>>'{after_row,table_id}' IS DISTINCT FROM tid::text OR (e#>>'{after_row,stack}')::numeric IS DISTINCT FROM amt
  OR (l->>'created_at')::timestamptz IS DISTINCT FROM joined
  OR f->>'ledger_id' IS DISTINCT FROM p_ledger::text OR f->'ledger_snapshot' IS DISTINCT FROM l
  OR f->>'transaction_id' IS DISTINCT FROM e->>'transaction_id'
  OR f#>>'{game_scope,asset}' IS DISTINCT FROM 'chips' OR f#>'{game_scope,unit_scale}' IS DISTINCT FROM '2'::jsonb
  OR f#>'{game_scope,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR f#>>'{game_scope,host_club_id}' IS DISTINCT FROM bank::text
  OR src#>>'{frame,transaction_id}' IS DISTINCT FROM e->>'transaction_id'
  OR src#>'{frame,observed_at}' IS DISTINCT FROM f->'recognized_at'
 THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.entry_purchase_idempotency_receipts q
  WHERE q.key_domain='horse_funding' AND q.idempotency_key=l#>>'{metadata,op_id}' AND to_jsonb(q)=r;
 IF n<>1 OR r->'response' IS NULL OR r->'response'='null'::jsonb OR r#>>'{response,success}' IS DISTINCT FROM 'true'
  OR r->>'completed_at' IS NULL OR r->>'claimed_at' IS NULL
  OR (r->>'completed_at')::timestamptz IS DISTINCT FROM joined OR (r->>'claimed_at')::timestamptz IS DISTINCT FROM joined
  OR r#>>'{request,door}' IS DISTINCT FROM 'fn_horse_seat_from_treasury'
  OR r#>>'{request,user_id}' IS DISTINCT FROM uid::text OR r#>>'{request,table_id}' IS DISTINCT FROM tid::text
  OR (r#>>'{request,amount}')::numeric IS DISTINCT FROM amt
  OR NULLIF(r#>>'{request,seat_number}','') IS NULL OR (r#>>'{request,seat_number}')::integer NOT BETWEEN 1 AND 10 THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.chip_transactions q WHERE q.id=(j->>'id')::uuid AND to_jsonb(q)=j;
 IF n<>1 OR j->>'transaction_type' IS DISTINCT FROM 'horse_treasury_funding'
  OR j->>'club_id' IS DISTINCT FROM bank::text OR j->>'to_user_id' IS DISTINCT FROM uid::text OR j->>'from_user_id' IS NOT NULL
  OR (j->>'amount')::numeric IS DISTINCT FROM amt OR (j->>'balance_after')::numeric IS DISTINCT FROM (r#>>'{response,treasury_after}')::numeric
  OR (j->>'created_at')::timestamptz IS DISTINCT FROM joined THEN RETURN NULL;END IF;
 -- When original volatile inventory is still present it must be byte-exact;
 -- the admitted original event/frame survives its normal later retirement.
 IF EXISTS(SELECT FROM public.union_pnl_inventory_events q WHERE q.event_id=(e->>'event_id')::bigint AND to_jsonb(q) IS DISTINCT FROM e)
  OR EXISTS(SELECT FROM public.union_pnl_original_flows q WHERE q.ledger_id=p_ledger AND to_jsonb(q) IS DISTINCT FROM f)
  OR EXISTS(SELECT FROM public.union_pnl_transaction_frames q WHERE q.transaction_id=(e->>'transaction_id')::xid8 AND to_jsonb(q) IS DISTINCT FROM src->'frame') THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('status','proven','ledger_id',p_ledger,'earning_club',club,'sponsor_bank_club',bank,'user_id',uid,
  'table_id',tid,'seat_id',sid,'occupancy_id',occ,'seat_joined_at',joined,'operation_key',l#>>'{metadata,op_id}','amount',amt,'asset','chips','unit_scale',2,
  'bank_balance_after',j->'balance_after','original_event_id',e->'event_id','original_transaction_id',e->'transaction_id','source_fingerprint',w.source_fingerprint);
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $gift$;
REVOKE ALL ON FUNCTION pg_temp.original_treasury_gift_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pg_temp.admit_original_treasury_gift(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $admit$
DECLARE l public.chip_ledger%ROWTYPE;f public.union_pnl_original_flows%ROWTYPE;e public.union_pnl_inventory_events%ROWTYPE;
 fr public.union_pnl_transaction_frames%ROWTYPE;r public.entry_purchase_idempotency_receipts%ROWTYPE;j public.chip_transactions%ROWTYPE;
 src jsonb;proof jsonb;n bigint;cutover_at timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('original_treasury_gift:'||p_ledger::text,0));
 IF EXISTS(SELECT FROM pg_temp.original_treasury_funding_witnesses WHERE ledger_id=p_ledger) THEN
  proof:=pg_temp.original_treasury_gift_evidence(p_ledger);
  IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_gift_retained_witness_invalid' USING ERRCODE='23514';END IF;RETURN proof;
 END IF;
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT f FROM public.union_pnl_original_flows WHERE ledger_id=p_ledger;
 SELECT count(*) INTO n FROM public.union_pnl_inventory_events q WHERE q.transaction_id=f.transaction_id AND q.source_name='table_seats' AND q.operation='INSERT'
  AND q.before_row IS NULL AND q.after_row->>'user_id'=l.metadata->>'user_id' AND q.after_row->>'table_id'=l.table_id::text;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_gift_exact_seat_insert_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT e FROM public.union_pnl_inventory_events q WHERE q.transaction_id=f.transaction_id AND q.source_name='table_seats' AND q.operation='INSERT'
  AND q.before_row IS NULL AND q.after_row->>'user_id'=l.metadata->>'user_id' AND q.after_row->>'table_id'=l.table_id::text;
 SELECT * INTO STRICT fr FROM public.union_pnl_transaction_frames WHERE transaction_id=f.transaction_id;
 SELECT * INTO STRICT r FROM public.entry_purchase_idempotency_receipts WHERE key_domain='horse_funding' AND idempotency_key=l.metadata->>'op_id';
 SELECT count(*) INTO n FROM public.chip_transactions q WHERE q.club_id=l.from_entity_id AND q.to_user_id=(l.metadata->>'user_id')::uuid
  AND q.from_user_id IS NULL AND q.transaction_type='horse_treasury_funding' AND q.amount=l.amount AND q.created_at=l.created_at
  AND q.balance_after=(r.response->>'treasury_after')::numeric;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_gift_unique_bank_journal_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT j FROM public.chip_transactions q WHERE q.club_id=l.from_entity_id AND q.to_user_id=(l.metadata->>'user_id')::uuid
  AND q.from_user_id IS NULL AND q.transaction_type='horse_treasury_funding' AND q.amount=l.amount AND q.created_at=l.created_at
  AND q.balance_after=(r.response->>'treasury_after')::numeric;
 src:=jsonb_build_object('ledger',to_jsonb(l),'flow',to_jsonb(f),'seat_event',to_jsonb(e),'frame',to_jsonb(fr),'entry',to_jsonb(r),'journal',to_jsonb(j));
 SELECT installed_at INTO STRICT cutover_at FROM pg_temp.original_treasury_funding_cutover WHERE singleton;
 INSERT INTO pg_temp.original_treasury_funding_witnesses(ledger_id,kind,source,source_fingerprint,historical_late) VALUES(p_ledger,'gift',src,md5(src::text),f.recognized_at<cutover_at);
 IF f.recognized_at<cutover_at THEN INSERT INTO pg_temp.original_treasury_historical_admissions(ledger_id,kind,source_fingerprint)VALUES(p_ledger,'gift',md5(src::text));END IF;
 proof:=pg_temp.original_treasury_gift_evidence(p_ledger);
 IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_gift_proof_refused' USING ERRCODE='23514';END IF;
 RETURN proof;
END $admit$;
REVOKE ALL ON FUNCTION pg_temp.admit_original_treasury_gift(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pg_temp.original_treasury_return_evidence(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $return$
DECLARE w pg_temp.original_treasury_funding_witnesses%ROWTYPE;src jsonb;l jsonb;e jsonb;b jsonb;a jsonb;f jsonb;j jsonb;g jsonb;lineage jsonb;
 uid uuid;tid uuid;club uuid;amt numeric;at_time timestamptz;n bigint;cutover_at timestamptz;
BEGIN
 SELECT * INTO w FROM pg_temp.original_treasury_funding_witnesses WHERE ledger_id=p_ledger AND kind='return';
 IF NOT FOUND OR w.source_fingerprint IS DISTINCT FROM md5(w.source::text) THEN RETURN NULL;END IF;
 src:=w.source;l:=src->'ledger';e:=src->'seat_event';b:=e->'before_row';a:=e->'after_row';f:=src->'flow';j:=src->'journal';
 SELECT installed_at INTO STRICT cutover_at FROM pg_temp.original_treasury_funding_cutover WHERE singleton;
 IF w.historical_late IS DISTINCT FROM ((f->>'recognized_at')::timestamptz<cutover_at)
  OR (w.historical_late AND NOT EXISTS(SELECT FROM pg_temp.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id AND h.kind=w.kind AND h.source_fingerprint=w.source_fingerprint))
  OR (NOT w.historical_late AND EXISTS(SELECT FROM pg_temp.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id)) THEN RETURN NULL;END IF;
 uid:=(l->>'to_entity_id')::uuid;tid:=(l->>'table_id')::uuid;club:=(l->>'club_id')::uuid;amt:=(l->>'amount')::numeric;at_time:=(l->>'created_at')::timestamptz;
 SELECT count(*) INTO n FROM public.chip_ledger q WHERE id=p_ledger AND to_jsonb(q)=l;
 IF n<>1 OR uid IS NULL OR tid IS NULL OR club IS NULL OR at_time IS NULL OR NOT isfinite(at_time)
  OR l->>'status' IS DISTINCT FROM 'posted' OR l->>'category' NOT IN('cashout','table_cashout','refund')
  OR l->>'from_type' IS DISTINCT FROM 'table_stack' OR l->>'from_entity_id' IS DISTINCT FROM tid::text
  OR l->>'to_type' IS DISTINCT FROM 'player_wallet' OR amt IS NULL OR amt<=0 OR amt<>round(amt,2) OR amt::text IN('NaN','Infinity','-Infinity')
  OR e->>'source_name' IS DISTINCT FROM 'table_seats' OR e->>'operation' IS DISTINCT FROM 'UPDATE'
  OR b->>'id' IS NULL OR b->>'occupancy_id' IS NULL OR b->>'joined_at' IS NULL OR b->>'left_at' IS NOT NULL
  OR e->>'row_id' IS DISTINCT FROM b->>'id' OR b->>'user_id' IS DISTINCT FROM uid::text OR b->>'table_id' IS DISTINCT FROM tid::text
  OR b->>'club_id' IS DISTINCT FROM club::text OR (b->>'stack')::numeric IS DISTINCT FROM amt
  OR a-'left_at' IS DISTINCT FROM b-'left_at' OR (a->>'left_at')::timestamptz IS DISTINCT FROM at_time
  OR f->>'ledger_id' IS DISTINCT FROM p_ledger::text OR f->'ledger_snapshot' IS DISTINCT FROM l
  OR f->>'transaction_id' IS DISTINCT FROM e->>'transaction_id'
  OR f#>>'{game_scope,asset}' IS DISTINCT FROM 'chips' OR f#>'{game_scope,unit_scale}' IS DISTINCT FROM '2'::jsonb
  OR f#>'{game_scope,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR src#>>'{frame,transaction_id}' IS DISTINCT FROM e->>'transaction_id'
  OR src#>'{frame,observed_at}' IS DISTINCT FROM f->'recognized_at' THEN RETURN NULL;END IF;
 g:=pg_temp.original_treasury_gift_evidence((src->>'gift_ledger_id')::uuid);
 IF g->>'status' IS DISTINCT FROM 'proven' OR g->>'earning_club' IS DISTINCT FROM club::text OR g->>'user_id' IS DISTINCT FROM uid::text
  OR g->>'table_id' IS DISTINCT FROM tid::text OR g->>'seat_id' IS DISTINCT FROM b->>'id'
  OR g->>'occupancy_id' IS DISTINCT FROM b->>'occupancy_id' OR (g->>'seat_joined_at')::timestamptz IS DISTINCT FROM (b->>'joined_at')::timestamptz
  OR (g->>'seat_joined_at')::timestamptz>=at_time THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.wallet_transactions q WHERE id=(j->>'id')::uuid AND to_jsonb(q)=j;
 IF n<>1 OR j->>'type' IS DISTINCT FROM 'credit' OR j->>'wallet_type' IS DISTINCT FROM 'PLAYER' OR j->>'category' IS DISTINCT FROM 'cashout'
  OR j->>'user_id' IS DISTINCT FROM uid::text OR j->>'table_id' IS DISTINCT FROM tid::text
  OR (j->>'amount')::numeric IS DISTINCT FROM amt OR (j->>'created_at')::timestamptz IS DISTINCT FROM at_time
  OR j->>'balance_after' IS NULL THEN RETURN NULL;END IF;
 lineage:=public.fn_cash_original_funding_lineage(uid,tid,(b->>'id')::uuid,(b->>'occupancy_id')::uuid,(b->>'joined_at')::timestamptz,(f->>'recognized_at')::timestamptz,true);
 IF lineage->'issues' IS DISTINCT FROM '[]'::jsonb OR lineage->'moves' IS DISTINCT FROM '[]'::jsonb
  OR EXISTS(SELECT FROM jsonb_array_elements(lineage->'funding_receipts') r WHERE r->>'funding_club_id' IS DISTINCT FROM club::text) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT FROM public.union_pnl_inventory_events q WHERE event_id=(e->>'event_id')::bigint AND to_jsonb(q) IS DISTINCT FROM e)
  OR EXISTS(SELECT FROM public.union_pnl_original_flows q WHERE ledger_id=p_ledger AND to_jsonb(q) IS DISTINCT FROM f)
  OR EXISTS(SELECT FROM public.union_pnl_transaction_frames q WHERE transaction_id=(e->>'transaction_id')::xid8 AND to_jsonb(q) IS DISTINCT FROM src->'frame') THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('status','proven','ledger_id',p_ledger,'earning_club',club,'user_id',uid,'amount',amt,'table_id',tid,
  'seat_id',b->'id','occupancy_id',b->'occupancy_id','seat_joined_at',b->'joined_at','gift_ledger_id',g->'ledger_id',
  'asset','chips','unit_scale',2,'funding_lineage',lineage,'original_event_id',e->'event_id','original_transaction_id',e->'transaction_id','source_fingerprint',w.source_fingerprint);
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $return$;
REVOKE ALL ON FUNCTION pg_temp.original_treasury_return_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pg_temp.admit_original_treasury_return(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $admitreturn$
DECLARE l public.chip_ledger%ROWTYPE;f public.union_pnl_original_flows%ROWTYPE;e public.union_pnl_inventory_events%ROWTYPE;
 fr public.union_pnl_transaction_frames%ROWTYPE;j public.wallet_transactions%ROWTYPE;gid uuid;src jsonb;proof jsonb;n bigint;cutover_at timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('original_treasury_return:'||p_ledger::text,0));
 IF EXISTS(SELECT FROM pg_temp.original_treasury_funding_witnesses WHERE ledger_id=p_ledger) THEN
  proof:=pg_temp.original_treasury_return_evidence(p_ledger);
  IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_return_retained_witness_invalid' USING ERRCODE='23514';END IF;RETURN proof;
 END IF;
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT f FROM public.union_pnl_original_flows WHERE ledger_id=p_ledger;
 SELECT count(*) INTO n FROM public.union_pnl_inventory_events q WHERE transaction_id=f.transaction_id AND source_name='table_seats' AND operation='UPDATE'
  AND before_row->>'user_id'=l.to_entity_id::text AND before_row->>'table_id'=l.table_id::text AND before_row->>'left_at' IS NULL
  AND (after_row->>'left_at')::timestamptz=l.created_at;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_exact_seat_exit_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT e FROM public.union_pnl_inventory_events q WHERE transaction_id=f.transaction_id AND source_name='table_seats' AND operation='UPDATE'
  AND before_row->>'user_id'=l.to_entity_id::text AND before_row->>'table_id'=l.table_id::text AND before_row->>'left_at' IS NULL
  AND (after_row->>'left_at')::timestamptz=l.created_at;
 SELECT * INTO STRICT fr FROM public.union_pnl_transaction_frames WHERE transaction_id=f.transaction_id;
 SELECT count(*),min(w.ledger_id::text)::uuid INTO n,gid FROM pg_temp.original_treasury_funding_witnesses w
  CROSS JOIN LATERAL pg_temp.original_treasury_gift_evidence(w.ledger_id) g
  WHERE w.kind='gift' AND g->>'status'='proven' AND g->>'occupancy_id'=e.before_row->>'occupancy_id'
   AND g->>'seat_id'=e.before_row->>'id' AND g->>'user_id'=l.to_entity_id::text AND g->>'table_id'=l.table_id::text;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_unique_initial_gift_required' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM public.wallet_transactions q WHERE user_id=l.to_entity_id AND table_id=l.table_id AND amount=l.amount
  AND type='credit' AND wallet_type='PLAYER' AND category='cashout' AND created_at=l.created_at;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_unique_wallet_journal_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT j FROM public.wallet_transactions q WHERE user_id=l.to_entity_id AND table_id=l.table_id AND amount=l.amount
  AND type='credit' AND wallet_type='PLAYER' AND category='cashout' AND created_at=l.created_at;
 src:=jsonb_build_object('ledger',to_jsonb(l),'flow',to_jsonb(f),'seat_event',to_jsonb(e),'frame',to_jsonb(fr),'journal',to_jsonb(j),'gift_ledger_id',gid);
 SELECT installed_at INTO STRICT cutover_at FROM pg_temp.original_treasury_funding_cutover WHERE singleton;
 INSERT INTO pg_temp.original_treasury_funding_witnesses(ledger_id,kind,source,source_fingerprint,historical_late) VALUES(p_ledger,'return',src,md5(src::text),f.recognized_at<cutover_at);
 IF f.recognized_at<cutover_at THEN INSERT INTO pg_temp.original_treasury_historical_admissions(ledger_id,kind,source_fingerprint)VALUES(p_ledger,'return',md5(src::text));END IF;
 proof:=pg_temp.original_treasury_return_evidence(p_ledger);
 IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_return_proof_refused' USING ERRCODE='23514';END IF;RETURN proof;
END $admitreturn$;
REVOKE ALL ON FUNCTION pg_temp.admit_original_treasury_return(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Existing buy-ins keep their original classification. Treasury top-ups are
-- not initial admissions: only the original seat-INSERT gift can be initial.
CREATE FUNCTION pg_temp.cash_initial_funding_receipt(p_receipt uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $initial$
DECLARE f public.cash_participant_funding_receipts%ROWTYPE;g jsonb;
BEGIN
 SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=p_receipt;
 IF NOT FOUND THEN RETURN false;END IF;
 IF f.operation_kind='buyin' THEN RETURN true;END IF;
 IF f.operation_kind IS DISTINCT FROM 'horse_funding' OR f.pending_addon_id IS NOT NULL THEN RETURN false;END IF;
 g:=pg_temp.original_treasury_gift_evidence(f.source_ledger_id);
 RETURN g->>'status'='proven' AND f.user_id::text=g->>'user_id' AND f.table_id::text=g->>'table_id'
  AND f.seat_id::text=g->>'seat_id' AND f.occupancy_id::text=g->>'occupancy_id'
  AND f.seat_joined_at=(g->>'seat_joined_at')::timestamptz AND f.recorded_at=f.seat_joined_at
  AND f.funding_club_id::text=g->>'earning_club' AND f.account_type='club_treasury'
  AND f.account_entity_id::text=g->>'sponsor_bank_club' AND f.asset='chips' AND f.unit_scale=2
  AND f.amount=(g->>'amount')::numeric AND f.balance_before-f.balance_after=f.amount
  AND f.operation_key=g->>'operation_key';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN false;
END $initial$;
REVOKE ALL ON FUNCTION pg_temp.cash_initial_funding_receipt(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pg_temp.original_treasury_participant_gift(p_participant jsonb,p_table uuid,p_captured timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $participant$
DECLARE g jsonb;n bigint;
BEGIN
 SELECT count(*),jsonb_agg(v)->0 INTO n,g FROM pg_temp.original_treasury_funding_witnesses w
 CROSS JOIN LATERAL pg_temp.original_treasury_gift_evidence(w.ledger_id) v
 WHERE w.kind='gift' AND v->>'status'='proven' AND v->>'table_id'=p_table::text
  AND v->>'user_id'=p_participant->>'user_id' AND v->>'seat_id'=p_participant->>'seat_id'
  AND v->>'occupancy_id'=p_participant->>'occupancy_id'
  AND (v->>'seat_joined_at')::timestamptz=(p_participant->>'seat_joined_at')::timestamptz
  AND (v->>'seat_joined_at')::timestamptz<=p_captured;
 IF n<>1 THEN RETURN NULL;END IF;RETURN g;
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $participant$;
REVOKE ALL ON FUNCTION pg_temp.original_treasury_participant_gift(jsonb,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION pg_temp.candidate_treasury_hand_evidence(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_gift jsonb;v_gift_users uuid[]:=ARRAY[]::uuid[];v_gift_resolved boolean:=false;v_posthand_original jsonb; a public.hand_atomic_commits%ROWTYPE; v_live_atomic jsonb; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; app public.cash_funding_application_receipts%ROWTYPE;
 v_lineage jsonb; v_lineage_at timestamptz; x jsonb; y jsonb; submitted jsonb; original jsonb; ref jsonb; v_request jsonb; v_stack_hand uuid; v_people jsonb:='[]';
 v_issues jsonb:='[]'; v_seen uuid[]:=ARRAY[]::uuid[]; v_funding_seen uuid[];
 v_user uuid; v_club uuid; v_account jsonb; v_funding_account jsonb;
 v_before numeric; v_after numeric; v_delta numeric:=0; v_rake numeric; v_bbj numeric; v_inflow numeric;
 v_initial integer; v_owned boolean; v_population boolean:=false;
BEGIN
 v_posthand_original:=smarter_private.posthand_escrow_certified_evidence(p_table_id,p_hand_number);
 IF v_posthand_original IS NOT NULL THEN RETURN v_posthand_original;END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','basis_certified',false,
  'all_players_included',false,'reason','original_cash_provenance_missing'); END IF;
 IF jsonb_typeof(p.atomic_receipt) IS DISTINCT FROM 'object'
  OR p.atomic_receipt->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.atomic_receipt->>'hand_number' IS DISTINCT FROM p_hand_number::text THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','retained_atomic_receipt_missing'); END IF;
 SELECT * INTO a FROM jsonb_populate_record(NULL::public.hand_atomic_commits,p.atomic_receipt);
 SELECT to_jsonb(live) INTO v_live_atomic FROM public.hand_atomic_commits live
  WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND AND NOT smarter_private.horse_cash_retained_atomic_matches(p_table_id,p_hand_number,p.atomic_receipt,v_live_atomic,p.accepted_request) THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','live_atomic_receipt_conflicts_with_original'); END IF;
 v_request:=a.stack_result->'request';
 IF a.committed_at IS NULL OR NOT isfinite(a.committed_at)
  OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb
  OR a.stack_result->>'mode' IS DISTINCT FROM 'delta'
  OR jsonb_typeof(v_request->'stacks') IS DISTINCT FROM 'array'
  OR NOT a.stack_result ? 'tournament_id' OR a.stack_result->'tournament_id' IS DISTINCT FROM 'null'::jsonb THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_delta_request_missing');
 END IF;
 IF p.version<>1 OR p.hand_id IS DISTINCT FROM a.hand_id OR p.payload_hash IS DISTINCT FROM a.payload_hash
  OR p.accepted_at IS NULL OR NOT isfinite(p.accepted_at) OR p.accepted_at<a.committed_at
  OR jsonb_typeof(p.accepted_request) IS DISTINCT FROM 'object'
  OR p.accepted_request->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.accepted_request->>'hand_number' IS DISTINCT FROM p_hand_number::text
  OR NOT smarter_private.horse_cash_retained_request_matches(p_table_id,p_hand_number,a.payload_hash,p.accepted_request)
  OR jsonb_typeof(p.accepted_request->'stacks') IS DISTINCT FROM 'array'
  OR p.manifest_id IS NULL OR jsonb_typeof(p.participants) IS DISTINCT FROM 'array'
  OR jsonb_typeof(p.issues) IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_provenance_link_missing');
 END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF NOT FOUND OR m.table_id IS DISTINCT FROM p_table_id OR m.hand_number IS DISTINCT FROM p_hand_number
  OR m.captured_at IS NULL OR NOT isfinite(m.captured_at) OR m.captured_at>p.accepted_at
  OR m.game_scope IS DISTINCT FROM p.game_scope OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array'
  OR jsonb_array_length(m.participants)<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<>jsonb_array_length(v_request->'stacks')
  OR jsonb_array_length(p.participants)<>jsonb_array_length(p.accepted_request->'stacks')
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(v_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p.accepted_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(m.participants))<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<2 OR jsonb_array_length(p.participants)>10
  OR p.all_players_included IS DISTINCT FROM true THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','original_cash_population_link_missing');
 END IF;
 v_stack_hand:=(a.stack_result->>'hand_id')::uuid;
 IF p.stack_claim->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_claim->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_claim->>'status' IS DISTINCT FROM 'succeeded'
  OR (p.stack_claim->>'completed_at') IS NULL OR p.stack_claim->'result' IS DISTINCT FROM a.stack_result
  OR p.stack_settlement->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_settlement->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_settlement->>'settlement_type' IS DISTINCT FROM 'hand_stacks'
  OR p.stack_settlement->>'state' IS DISTINCT FROM 'final'
  OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=p_table_id AND k.hand_id=v_stack_hand
    AND (k.status IS DISTINCT FROM 'succeeded' OR smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result) IS DISTINCT FROM a.stack_result OR k.completed_at IS NULL))
  OR EXISTS(SELECT 1 FROM public.ca_settlements c WHERE c.table_id=p_table_id AND c.hand_id=v_stack_hand
    AND c.settlement_type='hand_stacks' AND c.state IS DISTINCT FROM 'final') THEN
  v_issues:=v_issues||'"accepted_stack_receipt_link_missing"'::jsonb;
 END IF;
 -- Only the exact missing original admission can be resolved by its retained
 -- original treasury gift. Every other captured defect remains a refusal.
 IF p.status='uncertified' AND p.funding_provenance_complete=false AND m.funding_provenance_complete=false
  AND p.issues=m.issues AND jsonb_array_length(p.issues)>0 THEN
  FOR x IN SELECT value FROM jsonb_array_elements(p.participants) LOOP
   v_gift:=pg_temp.original_treasury_participant_gift(x,p_table_id,m.captured_at);
   IF v_gift->>'status'='proven' THEN v_gift_users:=array_append(v_gift_users,(x->>'user_id')::uuid);END IF;
  END LOOP;
  v_gift_resolved:=NOT EXISTS(SELECT FROM jsonb_array_elements(p.issues) i
   WHERE NOT EXISTS(SELECT FROM unnest(v_gift_users) u WHERE i=jsonb_build_object('reason','original_admission_funding_missing','user_id',u)));
 END IF;
 IF (p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS DISTINCT FROM true
  OR m.funding_provenance_complete IS DISTINCT FROM true OR p.issues<>'[]'::jsonb OR m.issues<>'[]'::jsonb) AND NOT v_gift_resolved THEN
  v_issues:=v_issues||'"original_cash_funding_incomplete"'::jsonb||p.issues;
 END IF;
 IF jsonb_typeof(p.game_scope) IS DISTINCT FROM 'object'
  OR NOT p.game_scope ?& ARRAY['host_club_id','game_union_id','is_private','tournament_id','asset','unit_scale']
  OR p.game_scope->>'asset' IS DISTINCT FROM 'chips' OR p.game_scope->'unit_scale' IS DISTINCT FROM '2'::jsonb
  OR p.game_scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR jsonb_typeof(p.game_scope->'is_private') IS DISTINCT FROM 'boolean'
  OR (p.game_scope->'is_private'='true'::jsonb AND p.game_scope->'game_union_id' IS DISTINCT FROM 'null'::jsonb)
  OR (p.game_scope->'is_private'='false'::jsonb AND (p.game_scope->>'game_union_id') IS NULL) THEN
  v_issues:=v_issues||'"historical_game_asset_and_union_receipt_invalid"'::jsonb;
 END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.participants) LOOP
  v_user:=(x->>'user_id')::uuid;
  SELECT value INTO y FROM jsonb_array_elements(v_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO submitted FROM jsonb_array_elements(p.accepted_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO original FROM jsonb_array_elements(m.participants) WHERE value->>'user_id'=x->>'user_id';
  v_before:=public.fn_pnl_evidence_cents(x->'stack_before'); v_after:=public.fn_pnl_evidence_cents(x->'stack_after');
  IF v_user IS NULL OR v_user=ANY(v_seen) OR y IS NULL OR original IS NULL
   OR submitted IS NULL OR original IS DISTINCT FROM (x-'stack_after'-'poker_delta')
   OR v_before IS NULL OR v_after IS NULL OR v_before<0 OR v_after<0
   OR public.fn_pnl_evidence_cents(x->'poker_delta') IS DISTINCT FROM v_after-v_before
   OR public.fn_pnl_evidence_cents(y->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(y->'stack') IS DISTINCT FROM v_after
   OR y->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR public.fn_pnl_evidence_cents(submitted->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(submitted->'stack') IS DISTINCT FROM v_after
   OR submitted->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR submitted->>'occupancy_id' IS DISTINCT FROM x->>'occupancy_id'
   OR (submitted->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR (y->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR submitted->>'funding_manifest_id' IS DISTINCT FROM p.manifest_id::text THEN
   RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
    'reason','original_cash_participant_mismatch');
  END IF;
  v_seen:=array_append(v_seen,v_user); v_delta:=v_delta+v_after-v_before;
  v_gift:=pg_temp.original_treasury_participant_gift(x,p_table_id,m.captured_at);
  v_owned:=true; v_initial:=0; v_club:=NULL; v_account:=NULL; v_funding_seen:=ARRAY[]::uuid[];
  v_lineage:=NULL;
  IF x ? 'funding_lineage' THEN
   v_lineage_at:=(x#>>'{funding_lineage,observed_at}')::timestamptz;
   IF v_lineage_at IS NULL OR NOT isfinite(v_lineage_at) OR v_lineage_at>m.captured_at THEN v_owned:=false; END IF;
   v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,(x->>'seat_id')::uuid,
    (x->>'occupancy_id')::uuid,(x->>'seat_joined_at')::timestamptz,v_lineage_at,false);
   IF v_lineage IS DISTINCT FROM x->'funding_lineage' OR v_lineage->'issues'<>'[]'::jsonb
    OR v_lineage->'funding_receipts' IS DISTINCT FROM x->'funding_receipts' THEN v_owned:=false; END IF;
  END IF;
  IF v_gift->>'status'='proven' THEN
   v_club:=(v_gift->>'earning_club')::uuid;
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(x->'funding_receipts') r WHERE pg_temp.cash_initial_funding_receipt((r->>'id')::uuid) IS TRUE) THEN v_initial:=1;END IF;
  END IF;
  IF jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array'  OR x->'funding_receipts'='[]'::jsonb THEN
   IF v_gift->>'status' IS DISTINCT FROM 'proven' OR jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array' THEN v_owned:=false;END IF;
  ELSE
   FOR ref IN SELECT value FROM jsonb_array_elements(x->'funding_receipts') LOOP
    SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=(ref->>'id')::uuid;
    IF NOT FOUND THEN v_owned:=false; CONTINUE; END IF;
    IF f.id=ANY(v_funding_seen) THEN v_owned:=false; END IF;
    v_funding_seen:=array_append(v_funding_seen,f.id);
    v_funding_account:=jsonb_build_array(f.funding_club_id,f.funding_union_id,f.asset);
    IF v_gift->>'status'='proven' AND f.funding_club_id IS DISTINCT FROM (v_gift->>'earning_club')::uuid THEN v_owned:=false;END IF;
    IF v_account IS NULL THEN v_account:=v_funding_account; v_club:=f.funding_club_id;
    ELSIF v_account IS DISTINCT FROM v_funding_account THEN v_owned:=false; END IF;
    IF pg_temp.cash_initial_funding_receipt(f.id) IS TRUE THEN v_initial:=v_initial+1; END IF;
    IF f.user_id IS DISTINCT FROM v_user OR (v_lineage IS NULL AND (f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>'seat_id' OR f.occupancy_id::text IS DISTINCT FROM x->>'occupancy_id'
     OR f.seat_joined_at IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz))
     OR f.recorded_at>m.captured_at OR NOT isfinite(f.recorded_at) OR f.asset<>'chips' OR f.unit_scale<>2
     OR f.account_type IS DISTINCT FROM ref->>'account_type'
     OR f.account_entity_id::text IS DISTINCT FROM ref->>'account_entity_id'
     OR f.funding_club_id::text IS DISTINCT FROM ref->>'funding_club_id'
     OR f.funding_union_id::text IS DISTINCT FROM ref->>'funding_union_id'
     OR f.pending_addon_id::text IS DISTINCT FROM ref->>'pending_addon_id'
     OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN ('NaN','Infinity','-Infinity')
     OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
    IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR (l.club_id IS DISTINCT FROM f.funding_club_id AND NOT (f.operation_kind='horse_funding' AND pg_temp.cash_initial_funding_receipt(f.id) IS TRUE))
     OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
     OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id
     OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    IF f.pending_addon_id IS NOT NULL THEN
     SELECT * INTO app FROM public.cash_funding_application_receipts WHERE pending_addon_id=f.pending_addon_id;
     IF NOT FOUND OR app.funding_receipt_id IS DISTINCT FROM f.id OR app.original_occupancy_id IS DISTINCT FROM f.occupancy_id
      OR NOT isfinite(app.applied_at) OR app.applied+app.refunded IS DISTINCT FROM f.amount
      OR (app.applied>0 AND app.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN v_owned:=false; END IF;
    END IF;
   END LOOP;
  END IF;
  IF v_initial<>1 THEN v_owned:=false; END IF;
  IF NOT v_owned THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','participant_earning_ownership_receipt_invalid','user_id',v_user)); END IF;
  v_people:=v_people||jsonb_build_array(jsonb_build_object('user_id',v_user,'is_horse',x->'is_horse',
   'observed_stack_delta',v_after-v_before,'earning_club_id',CASE WHEN v_owned THEN v_club ELSE NULL END,
   'ownership_certified',v_owned,'ownership_scope','original_chip_funding_club','funding_receipt_ids',to_jsonb(v_funding_seen))||CASE WHEN v_gift->>'status'='proven' THEN jsonb_build_object('original_treasury_gift',v_gift) ELSE '{}'::jsonb END);
 END LOOP;
 v_population:=true;
 v_rake:=public.fn_pnl_evidence_cents(v_request->'rake'); v_bbj:=public.fn_pnl_evidence_cents(v_request->'bbj');
 v_inflow:=public.fn_pnl_evidence_cents(v_request->'inflow');
 IF v_request->'rake'='null'::jsonb THEN v_rake:=0; END IF;
 IF v_request->'bbj'='null'::jsonb THEN v_bbj:=0; END IF;
 IF v_request->'inflow'='null'::jsonb THEN v_inflow:=0; END IF;
 IF v_rake IS NULL OR v_bbj IS NULL OR v_inflow IS NULL OR v_rake<0 OR v_bbj<0
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'rake','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_rake
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'bbj','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_bbj
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'inflow','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_inflow
  OR v_rake IS DISTINCT FROM p.rake OR v_bbj IS DISTINCT FROM p.bbj OR v_inflow IS DISTINCT FROM p.signed_external_net THEN
  v_issues:=v_issues||'"hand_conservation_inputs_missing"'::jsonb;
 ELSIF v_delta+v_rake+v_bbj<>v_inflow THEN v_issues:=v_issues||'"hand_delta_conservation_mismatch"'::jsonb;
 END IF;
 -- Signed insurance/external movements conserve but need their own bank linkage.
 IF v_inflow<>0 THEN v_issues:=v_issues||'"external_bank_receipt_not_certified"'::jsonb; END IF;
 RETURN jsonb_build_object('status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'scope','single_accepted_cash_hand','payment_authorized',false,
  'hand_id',a.hand_id,'table_id',p_table_id,'hand_number',p_hand_number,'observed_commit_at',a.committed_at,
  'observed_delta_total',v_delta,'participants',v_people,'issues',v_issues,'game_scope',p.game_scope,
  'current_seats_used',false,'current_membership_used',false,'all_players_included',v_population);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,'reason','malformed_original_cash_evidence');
END $function$
;
CREATE TEMP TABLE treasury_probe_results(result jsonb);SET LOCAL transaction_read_only=on;
DO $profile$DECLARE g jsonb;id uuid;BEGIN IF md5(pg_get_functiondef('public.fn_pnl_cash_hand_evidence(uuid,bigint)'::regprocedure))<>'865391e842ed009b45ec7727efe7e85b' OR md5(pg_get_functiondef('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)'::regprocedure))<>'bb74ae7693dc40b812fce685cfc3c294' THEN RAISE EXCEPTION 'original_treasury_probe_source_changed';END IF;
FOREACH id IN ARRAY ARRAY['b439b3d5-2d1f-4859-aa48-34bea8a8101c'::uuid,'ab65ad78-6e50-4718-ba7e-86256d426a43'::uuid,'95445619-c021-4dd8-97b5-a593ce910145'::uuid,'1b4eab8b-d46d-4f54-a825-340d50d9e6e2'::uuid]LOOP g:=pg_temp.admit_original_treasury_gift(id);IF g->>'status' IS DISTINCT FROM 'proven' THEN RAISE EXCEPTION 'original_treasury_probe_admission_refused';END IF;END LOOP;
INSERT INTO pg_temp.treasury_probe_results(result) WITH cohort AS MATERIALIZED(SELECT table_id,hand_number FROM public.cash_hand_provenance_receipts WHERE table_id='8aea2cc5-e05a-4aa2-9404-ffa34a9fb33e' AND status='uncertified'),verdicts AS MATERIALIZED(SELECT table_id,hand_number,public.fn_pnl_cash_hand_evidence(table_id,hand_number) old,pg_temp.candidate_treasury_hand_evidence(table_id,hand_number) new FROM cohort)
SELECT jsonb_build_object('transaction_read_only',current_setting('transaction_read_only'),'observed_at',clock_timestamp(),'cohort_count',count(*),'old_blocked',count(*)FILTER(WHERE old->>'status'='blocked'),'new_ready',count(*)FILTER(WHERE new->>'status'='ready' AND new->'basis_certified'='true'::jsonb AND new->'all_players_included'='true'::jsonb),'still_blocked',coalesce(jsonb_agg(jsonb_build_object('table_id',table_id,'hand_number',hand_number,'issues',new->'issues','reason',new->'reason'))FILTER(WHERE new->>'status'IS DISTINCT FROM 'ready'),'[]'::jsonb),'changed_hands',jsonb_agg(jsonb_build_object('hand_id',new->'hand_id','hand_number',hand_number))FILTER(WHERE old->>'status'='blocked' AND new->>'status'='ready'),'original_gifts',(SELECT jsonb_build_object('count',count(*),'amount',sum((source#>>'{ledger,amount}')::numeric))FROM pg_temp.original_treasury_funding_witnesses WHERE kind='gift'))FROM verdicts;END$profile$;SELECT result FROM pg_temp.treasury_probe_results;
ROLLBACK;
