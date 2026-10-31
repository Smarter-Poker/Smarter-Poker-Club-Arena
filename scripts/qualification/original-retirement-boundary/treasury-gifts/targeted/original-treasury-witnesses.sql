-- Draft only. Original financial witnesses, never a replacement funding debit.
CREATE TABLE smarter_private.original_treasury_funding_witnesses(
 ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),
 source jsonb NOT NULL,source_fingerprint text NOT NULL,historical_late boolean NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(source)='object'),CHECK(length(source_fingerprint)=32));
CREATE UNIQUE INDEX original_treasury_gift_occupancy_once ON smarter_private.original_treasury_funding_witnesses((source#>>'{seat_event,after_row,occupancy_id}')) WHERE kind='gift';
CREATE UNIQUE INDEX original_treasury_return_occupancy_once ON smarter_private.original_treasury_funding_witnesses((source#>>'{seat_event,before_row,occupancy_id}')) WHERE kind='return';
REVOKE ALL ON smarter_private.original_treasury_funding_witnesses FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.original_treasury_witness_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'original_treasury_witness_is_immutable' USING ERRCODE='55000';END$$;
-- Installation time is current, immutable, and independent of an old gift's
-- transaction timestamp. Future atomic gifts never change closed-book bases.
CREATE TABLE smarter_private.original_treasury_funding_cutover(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),installed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(installed_at)));
INSERT INTO smarter_private.original_treasury_funding_cutover DEFAULT VALUES;
REVOKE ALL ON smarter_private.original_treasury_funding_cutover FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_treasury_cutover_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_funding_cutover FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_cutover_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_funding_cutover FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
-- Finite pre-cutover admission journal, separate from future live witnesses.
-- Global closed-book generation reads this bounded table, never all live gifts.
CREATE TABLE smarter_private.original_treasury_historical_admissions(ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),source_fingerprint text NOT NULL CHECK(length(source_fingerprint)=32),admitted_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON smarter_private.original_treasury_historical_admissions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_treasury_historical_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_historical_admissions FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_historical_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_historical_admissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_funding_witnesses FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_funding_witnesses FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();

CREATE FUNCTION smarter_private.original_treasury_gift_evidence(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $gift$
DECLARE w smarter_private.original_treasury_funding_witnesses%ROWTYPE;src jsonb;l jsonb;e jsonb;r jsonb;j jsonb;f jsonb;
 uid uuid;bank uuid;club uuid;tid uuid;sid uuid;occ uuid;joined timestamptz;amt numeric;n bigint;cutover_at timestamptz;
BEGIN
 SELECT * INTO w FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger AND kind='gift';
 IF NOT FOUND OR w.source_fingerprint IS DISTINCT FROM md5(w.source::text) THEN RETURN NULL;END IF;
 src:=w.source;l:=src->'ledger';e:=src->'seat_event';r:=src->'entry';j:=src->'journal';f:=src->'flow';
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 IF w.historical_late IS DISTINCT FROM ((f->>'recognized_at')::timestamptz<cutover_at)
  OR (w.historical_late AND NOT EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id AND h.kind=w.kind AND h.source_fingerprint=w.source_fingerprint))
  OR (NOT w.historical_late AND EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id)) THEN RETURN NULL;END IF;
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
REVOKE ALL ON FUNCTION smarter_private.original_treasury_gift_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.admit_original_treasury_gift(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $admit$
DECLARE l public.chip_ledger%ROWTYPE;f public.union_pnl_original_flows%ROWTYPE;e public.union_pnl_inventory_events%ROWTYPE;
 fr public.union_pnl_transaction_frames%ROWTYPE;r public.entry_purchase_idempotency_receipts%ROWTYPE;j public.chip_transactions%ROWTYPE;
 src jsonb;proof jsonb;n bigint;cutover_at timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('original_treasury_gift:'||p_ledger::text,0));
 IF EXISTS(SELECT FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger) THEN
  proof:=smarter_private.original_treasury_gift_evidence(p_ledger);
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
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 INSERT INTO smarter_private.original_treasury_funding_witnesses(ledger_id,kind,source,source_fingerprint,historical_late) VALUES(p_ledger,'gift',src,md5(src::text),f.recognized_at<cutover_at);
 IF f.recognized_at<cutover_at THEN INSERT INTO smarter_private.original_treasury_historical_admissions(ledger_id,kind,source_fingerprint)VALUES(p_ledger,'gift',md5(src::text));END IF;
 proof:=smarter_private.original_treasury_gift_evidence(p_ledger);
 IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_gift_proof_refused' USING ERRCODE='23514';END IF;
 RETURN proof;
END $admit$;
REVOKE ALL ON FUNCTION smarter_private.admit_original_treasury_gift(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.original_treasury_return_evidence(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $return$
DECLARE w smarter_private.original_treasury_funding_witnesses%ROWTYPE;src jsonb;l jsonb;e jsonb;b jsonb;a jsonb;f jsonb;j jsonb;g jsonb;lineage jsonb;
 uid uuid;tid uuid;club uuid;amt numeric;at_time timestamptz;n bigint;cutover_at timestamptz;
BEGIN
 SELECT * INTO w FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger AND kind='return';
 IF NOT FOUND OR w.source_fingerprint IS DISTINCT FROM md5(w.source::text) THEN RETURN NULL;END IF;
 src:=w.source;l:=src->'ledger';e:=src->'seat_event';b:=e->'before_row';a:=e->'after_row';f:=src->'flow';j:=src->'journal';
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 IF w.historical_late IS DISTINCT FROM ((f->>'recognized_at')::timestamptz<cutover_at)
  OR (w.historical_late AND NOT EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id AND h.kind=w.kind AND h.source_fingerprint=w.source_fingerprint))
  OR (NOT w.historical_late AND EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id)) THEN RETURN NULL;END IF;
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
 g:=smarter_private.original_treasury_gift_evidence((src->>'gift_ledger_id')::uuid);
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
REVOKE ALL ON FUNCTION smarter_private.original_treasury_return_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.admit_original_treasury_return(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $admitreturn$
DECLARE l public.chip_ledger%ROWTYPE;f public.union_pnl_original_flows%ROWTYPE;e public.union_pnl_inventory_events%ROWTYPE;
 fr public.union_pnl_transaction_frames%ROWTYPE;j public.wallet_transactions%ROWTYPE;gid uuid;src jsonb;proof jsonb;n bigint;cutover_at timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('original_treasury_return:'||p_ledger::text,0));
 IF EXISTS(SELECT FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger) THEN
  proof:=smarter_private.original_treasury_return_evidence(p_ledger);
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
 SELECT count(*),min(w.ledger_id::text)::uuid INTO n,gid FROM smarter_private.original_treasury_funding_witnesses w
  CROSS JOIN LATERAL smarter_private.original_treasury_gift_evidence(w.ledger_id) g
  WHERE w.kind='gift' AND g->>'status'='proven' AND g->>'occupancy_id'=e.before_row->>'occupancy_id'
   AND g->>'seat_id'=e.before_row->>'id' AND g->>'user_id'=l.to_entity_id::text AND g->>'table_id'=l.table_id::text;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_unique_initial_gift_required' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM public.wallet_transactions q WHERE user_id=l.to_entity_id AND table_id=l.table_id AND amount=l.amount
  AND type='credit' AND wallet_type='PLAYER' AND category='cashout' AND created_at=l.created_at;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_unique_wallet_journal_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT j FROM public.wallet_transactions q WHERE user_id=l.to_entity_id AND table_id=l.table_id AND amount=l.amount
  AND type='credit' AND wallet_type='PLAYER' AND category='cashout' AND created_at=l.created_at;
 src:=jsonb_build_object('ledger',to_jsonb(l),'flow',to_jsonb(f),'seat_event',to_jsonb(e),'frame',to_jsonb(fr),'journal',to_jsonb(j),'gift_ledger_id',gid);
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 INSERT INTO smarter_private.original_treasury_funding_witnesses(ledger_id,kind,source,source_fingerprint,historical_late) VALUES(p_ledger,'return',src,md5(src::text),f.recognized_at<cutover_at);
 IF f.recognized_at<cutover_at THEN INSERT INTO smarter_private.original_treasury_historical_admissions(ledger_id,kind,source_fingerprint)VALUES(p_ledger,'return',md5(src::text));END IF;
 proof:=smarter_private.original_treasury_return_evidence(p_ledger);
 IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_return_proof_refused' USING ERRCODE='23514';END IF;RETURN proof;
END $admitreturn$;
REVOKE ALL ON FUNCTION smarter_private.admit_original_treasury_return(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Existing buy-ins keep their original classification. Treasury top-ups are
-- not initial admissions: only the original seat-INSERT gift can be initial.
CREATE FUNCTION smarter_private.cash_initial_funding_receipt(p_receipt uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $initial$
DECLARE f public.cash_participant_funding_receipts%ROWTYPE;g jsonb;
BEGIN
 SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=p_receipt;
 IF NOT FOUND THEN RETURN false;END IF;
 IF f.operation_kind='buyin' THEN RETURN true;END IF;
 IF f.operation_kind IS DISTINCT FROM 'horse_funding' OR f.pending_addon_id IS NOT NULL THEN RETURN false;END IF;
 g:=smarter_private.original_treasury_gift_evidence(f.source_ledger_id);
 RETURN g->>'status'='proven' AND f.user_id::text=g->>'user_id' AND f.table_id::text=g->>'table_id'
  AND f.seat_id::text=g->>'seat_id' AND f.occupancy_id::text=g->>'occupancy_id'
  AND f.seat_joined_at=(g->>'seat_joined_at')::timestamptz AND f.recorded_at=f.seat_joined_at
  AND f.funding_club_id::text=g->>'earning_club' AND f.account_type='club_treasury'
  AND f.account_entity_id::text=g->>'sponsor_bank_club' AND f.asset='chips' AND f.unit_scale=2
  AND f.amount=(g->>'amount')::numeric AND f.balance_before-f.balance_after=f.amount
  AND f.operation_key=g->>'operation_key';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN false;
END $initial$;
REVOKE ALL ON FUNCTION smarter_private.cash_initial_funding_receipt(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.original_treasury_participant_gift(p_participant jsonb,p_table uuid,p_captured timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $participant$
DECLARE g jsonb;n bigint;
BEGIN
 SELECT count(*),jsonb_agg(v)->0 INTO n,g FROM smarter_private.original_treasury_funding_witnesses w
 CROSS JOIN LATERAL smarter_private.original_treasury_gift_evidence(w.ledger_id) v
 WHERE w.kind='gift' AND v->>'status'='proven' AND v->>'table_id'=p_table::text
  AND v->>'user_id'=p_participant->>'user_id' AND v->>'seat_id'=p_participant->>'seat_id'
  AND v->>'occupancy_id'=p_participant->>'occupancy_id'
  AND (v->>'seat_joined_at')::timestamptz=(p_participant->>'seat_joined_at')::timestamptz
  AND (v->>'seat_joined_at')::timestamptz<=p_captured;
 IF n<>1 THEN RETURN NULL;END IF;RETURN g;
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $participant$;
REVOKE ALL ON FUNCTION smarter_private.original_treasury_participant_gift(jsonb,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
