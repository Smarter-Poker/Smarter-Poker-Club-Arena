-- Weekly P&L used current membership and current seats, and its evidence reader
-- correctly refused every period because the original population was absent.
-- Bind original writes to one transaction book, preserve every accepted cash
-- outcome once, and calculate closed weeks from that immutable evidence. This
-- preserves the existing Pacific books and Monday 04:00 Chicago invocation.
-- Historical rows are never stamped with invented transaction identities.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Exact live predecessors captured read-only after the installed ECO/inventory
-- successors. Refuse concurrent source, owner or ACL drift before any DDL.
DO $installed_preconditions$
DECLARE expected record; actual record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('fn_accounting_union_eco_capture()','9e1a4ddba6c70088805c09383da365b5','{postgres=X/postgres}','postgres'),
  ('fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])','e683367f367422c00539a38f9600858e','{postgres=X/postgres}','postgres'),
  ('fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)','26ba834fa272f040ab6edae0a4f8bf58','{postgres=X/postgres}','postgres'),
  ('fn_process_weekly_accounting_scope(uuid,uuid)','f3b8fcb98bd23b4eb767b5dada37852e','{postgres=X/postgres}','postgres'),
  ('fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)','7344f38c069f5d85332c09c33aa49c6a','{postgres=X/postgres}','postgres'),
  ('fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)','7626aff917e8fba3cb6f54af51905dc0','{postgres=X/postgres}','postgres'),
  ('fn_union_eco_adjustment(uuid,timestamp with time zone,timestamp with time zone)','a30873186aed162044712b5f80ef2f9b','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_eco_record(uuid,timestamp with time zone,timestamp with time zone,uuid)','a6c4fd4824525c73e360410d8ce5980c','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_eco_terms_evidence(uuid,timestamp with time zone,timestamp with time zone)','6715f9e156ae6296e02d060d3b6dfbf1','{postgres=X/postgres}','postgres'),
  ('fn_union_pnl_all_clubs(uuid,timestamp with time zone,timestamp with time zone,boolean)','f01c3c66265fddd7ce88962ad0bb13f9','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_baseline(uuid,timestamp with time zone)','45ad9f400f7ba63a1e788ccdab55cc81','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_cash_by_club(uuid,timestamp with time zone,timestamp with time zone,boolean)','e8d46ba1a3753c34818860ddfe57e242','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)','9f4dfe20444ddf1b89e459b669bdff7b','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_pnl_inventory_observe()','abc1eb57d79544e11589a348a499c426','{postgres=X/postgres}','postgres'),
  ('fn_union_reconciliation_report(uuid,timestamp with time zone,timestamp with time zone)','630e87c9842a423e6a5198551623dec0','{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_settle_player_pnl(uuid,timestamp with time zone,timestamp with time zone,boolean)','38a7efa81411b06b289adff5b144c643','{postgres=X/postgres,service_role=X/postgres}','postgres'),
  ('fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)','42d975cb30c4185dbf58b57f840296a7','{postgres=X/postgres}','postgres')
 ) AS v(signature,definition_md5,acl,owner_name)
 LOOP
  SELECT md5(pg_get_functiondef(p.oid)) AS definition_md5,p.proacl::text AS acl,
    pg_get_userbyid(p.proowner) AS owner_name INTO actual
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||expected.signature);
  IF NOT FOUND OR actual.definition_md5 IS DISTINCT FROM expected.definition_md5
    OR actual.acl IS DISTINCT FROM expected.acl OR actual.owner_name IS DISTINCT FROM expected.owner_name THEN
   RAISE EXCEPTION 'weekly_original_predecessor_drift:%',expected.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
END $installed_preconditions$;


-- Drain original tournament, table FOR SHARE and seat writers in their
-- proven owner order before any hot-source DDL.
-- The two original root locks may each wait for a bounded transaction; every
-- remaining owner must be available immediately or this migration rolls back.
SET LOCAL lock_timeout='10s';
LOCK TABLE public.tournaments IN EXCLUSIVE MODE;
LOCK TABLE public.tables IN EXCLUSIVE MODE;
SET LOCAL lock_timeout='3s';
LOCK TABLE public.table_seats,public.tournament_players,public.union_clubs,
 public.chip_ledger,public.hand_atomic_commits,
 public.tournament_participant_funding_receipts,public.tournament_accounting_credit_receipts,
 public.tournament_obligation_events,
 public.unions,public.accounting_agreement_history IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.cash_participant_funding_receipts,public.cash_funding_application_receipts,
 public.cash_hand_provenance_receipts,public.tournament_refund_tranches IN ACCESS EXCLUSIVE MODE NOWAIT;

CREATE TABLE public.union_pnl_transaction_frames (
 transaction_id xid8 PRIMARY KEY,
 observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
 book_start timestamptz NOT NULL
);
CREATE TABLE public.union_pnl_weekly_capture (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 captured_at timestamptz NOT NULL CHECK(isfinite(captured_at)),
 contract_version integer NOT NULL CHECK(contract_version=1)
);
CREATE TABLE public.union_pnl_cash_outcomes (
 table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid NOT NULL UNIQUE,
 transaction_id xid8 NOT NULL REFERENCES public.union_pnl_transaction_frames(transaction_id),
 recognized_at timestamptz NOT NULL, payload_hash text NOT NULL,
 game_scope jsonb NOT NULL, evidence jsonb NOT NULL,
 PRIMARY KEY(table_id,hand_number)
);
CREATE INDEX ON public.union_pnl_cash_outcomes((game_scope->>'game_union_id'),recognized_at);
CREATE TABLE public.union_pnl_original_flows (
 ledger_id uuid PRIMARY KEY,
 transaction_id xid8 NOT NULL REFERENCES public.union_pnl_transaction_frames(transaction_id),
 recognized_at timestamptz NOT NULL,
 game_scope jsonb NOT NULL, ledger_snapshot jsonb NOT NULL
);
CREATE INDEX ON public.union_pnl_original_flows((game_scope->>'game_union_id'),recognized_at);

CREATE FUNCTION public.fn_union_pnl_original_frame()
RETURNS public.union_pnl_transaction_frames LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE frame public.union_pnl_transaction_frames; observed timestamptz; book timestamptz;
BEGIN
 SELECT * INTO frame FROM public.union_pnl_transaction_frames WHERE transaction_id=pg_current_xact_id();
 IF FOUND THEN RETURN frame; END IF;
 observed:=clock_timestamp(); book:=public.fn_union_week_start(observed);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
 observed:=clock_timestamp();
 IF public.fn_union_week_start(observed)<>book THEN
  book:=public.fn_union_week_start(observed);
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  observed:=clock_timestamp();
  IF public.fn_union_week_start(observed)<>book THEN RAISE EXCEPTION 'pnl_frame_clock_crossed_twice' USING ERRCODE='40001'; END IF;
 END IF;
 INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),observed,book) RETURNING * INTO frame;
 RETURN frame;
END $$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_observe()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior jsonb; following jsonb; frame public.union_pnl_transaction_frames;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'pnl_inventory_source_truncate_refused' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN prior:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN following:=public.fn_union_pnl_inventory_project(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 IF prior IS NOT DISTINCT FROM following THEN RETURN NULL; END IF;
 frame:=public.fn_union_pnl_original_frame();
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
 VALUES(TG_TABLE_NAME,(COALESCE(following,prior)->>'id')::uuid,frame.observed_at,frame.transaction_id,TG_OP,prior,following);
 RETURN NULL;
END $$;

-- Adding nullable first deliberately leaves legacy receipts unbound. The
-- default affects only new original inserts; no legacy history is rewritten.
ALTER TABLE public.cash_participant_funding_receipts ADD COLUMN transaction_id xid8;
ALTER TABLE public.cash_participant_funding_receipts ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();
ALTER TABLE public.cash_funding_application_receipts ADD COLUMN transaction_id xid8;
ALTER TABLE public.cash_funding_application_receipts ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();
ALTER TABLE public.cash_hand_provenance_receipts ADD COLUMN transaction_id xid8;
ALTER TABLE public.cash_hand_provenance_receipts ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();
ALTER TABLE public.tournament_refund_tranches ADD COLUMN transaction_id xid8;
ALTER TABLE public.tournament_refund_tranches ALTER COLUMN transaction_id SET DEFAULT pg_current_xact_id();
CREATE FUNCTION public.fn_union_pnl_receipt_frame()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.fn_union_pnl_original_frame();
 NEW.transaction_id:=pg_current_xact_id();
 RETURN NEW;
END $$;
DO $frames$
DECLARE rel text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['cash_participant_funding_receipts','cash_funding_application_receipts','cash_hand_provenance_receipts',
  'tournament_participant_funding_receipts','tournament_accounting_credit_receipts','tournament_obligation_events','tournament_refund_tranches'] LOOP
  EXECUTE format('CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_receipt_frame()',rel);
 END LOOP;
END $frames$;

CREATE FUNCTION public.fn_union_pnl_capture_original_flow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE frame public.union_pnl_transaction_frames; scope jsonb;
BEGIN
 -- These are the original cash/table and tournament/liability journal legs.
 -- Other wallet transfers, rakeback and P&L payments are not poker winnings.
 IF NOT ((NEW.from_type IN ('player_wallet','club_treasury') AND NEW.to_type IN ('table_stack','prize_liability'))
  OR (NEW.to_type IN ('player_wallet','club_treasury') AND NEW.from_type IN ('table_stack','prize_liability'))) THEN RETURN NULL; END IF;
 frame:=public.fn_union_pnl_original_frame();
 IF NEW.tournament_id IS NOT NULL THEN
  SELECT jsonb_build_object('game_union_id',t.union_id,'host_club_id',t.club_id,'tournament_id',t.id,'is_private',t.is_private,'asset','chips','unit_scale',2)
  INTO scope FROM public.tournaments t WHERE t.id=NEW.tournament_id;
 ELSE
  SELECT jsonb_build_object('game_union_id',t.union_id,'host_club_id',t.club_id,'tournament_id',t.tournament_id,'is_private',t.is_private,'asset','chips','unit_scale',2)
  INTO scope FROM public.tables t WHERE t.id=NEW.table_id;
 END IF;
 INSERT INTO public.union_pnl_original_flows VALUES(NEW.id,frame.transaction_id,frame.observed_at,COALESCE(scope,'{}'),to_jsonb(NEW));
 RETURN NULL;
END $$;
CREATE TRIGGER original_union_pnl_flow AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_capture_original_flow();

CREATE FUNCTION public.fn_union_pnl_capture_accepted_cash()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE frame public.union_pnl_transaction_frames; p public.cash_hand_provenance_receipts; scope jsonb; proof jsonb;
BEGIN
 frame:=public.fn_union_pnl_original_frame();
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF p.table_id IS NOT NULL THEN
  scope:=p.game_scope;
  IF p.hand_id IS DISTINCT FROM NEW.hand_id OR p.payload_hash IS DISTINCT FROM NEW.payload_hash OR p.transaction_id IS DISTINCT FROM frame.transaction_id THEN
   proof:=jsonb_build_object('status','blocked','basis_certified',false,'reason','accepted_cash_original_identity_mismatch');
  ELSE
   proof:=public.fn_pnl_cash_hand_evidence(NEW.table_id,NEW.hand_number)||jsonb_build_object('accepted_rake',p.rake,'accepted_bbj',p.bbj,'accepted_external_net',p.signed_external_net);
  END IF;
 ELSE
  SELECT jsonb_build_object('host_club_id',club_id,'game_union_id',union_id,'is_private',is_private,'tournament_id',tournament_id,'asset','chips','unit_scale',2)
  INTO scope FROM public.tables WHERE id=NEW.table_id;
  IF scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb AND scope->>'tournament_id' IS NOT NULL THEN RETURN NULL; END IF;
  proof:=jsonb_build_object('status','blocked','basis_certified',false,'reason','accepted_cash_original_provenance_missing');
 END IF;
 INSERT INTO public.union_pnl_cash_outcomes VALUES(NEW.table_id,NEW.hand_number,NEW.hand_id,frame.transaction_id,
  frame.observed_at,NEW.payload_hash,COALESCE(scope,'{}'),proof);
 RETURN NULL;
END $$;
-- Exactly one outcome for every accepted cash hand, including zero rake,
-- unknown legacy occupants and unsupported insurance. It does not reject a
-- legacy gameplay transaction merely because its accounting is uncertified.
CREATE CONSTRAINT TRIGGER original_union_pnl_cash_acceptance AFTER INSERT ON public.hand_atomic_commits
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_capture_accepted_cash();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('chip_ledger','original_union_pnl_flow','Immutable original cash/tournament flow evidence; no monetary mutation.');

DO $private$
DECLARE rel text; fn text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['union_pnl_transaction_frames','union_pnl_weekly_capture','union_pnl_cash_outcomes','union_pnl_original_flows'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',rel);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',rel);
  EXECUTE format('CREATE TRIGGER original_pnl_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable()',rel);
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['fn_union_pnl_original_frame()','fn_union_pnl_receipt_frame()','fn_union_pnl_capture_original_flow()','fn_union_pnl_capture_accepted_cash()'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role',fn);
 END LOOP;
END $private$;
-- Trigger DDL holds the owner relations until this capture fence commits.
INSERT INTO public.union_pnl_weekly_capture VALUES(true,clock_timestamp(),1);

-- One exact-credit projection covers the original prize payer and the
-- existing entitlement/tranche refund owner. One ledger ID is counted once.
CREATE FUNCTION public.fn_union_pnl_tournament_returns(p_tournament uuid DEFAULT NULL,p_registration uuid DEFAULT NULL,p_start timestamptz DEFAULT NULL,p_end timestamptz DEFAULT NULL)
RETURNS TABLE(ledger_id uuid,tournament_id uuid,user_id uuid,credited_club_id uuid,amount numeric,transaction_id xid8,entry_receipt_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount,c.transaction_id,c.entry_receipt_ids
 FROM public.tournament_accounting_credit_receipts c
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 WHERE (p_tournament IS NULL OR c.tournament_id=p_tournament)
  AND (p_registration IS NULL OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
   WHERE r.tournament_id=c.tournament_id AND r.registration_id=p_registration AND r.id=ANY(c.entry_receipt_ids)))
  AND (p_start IS NULL OR b.observed_at>=p_start) AND (p_end IS NULL OR b.observed_at<p_end)
 UNION ALL
 SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now,t.transaction_id,ARRAY[r.id]
 FROM public.tournament_refund_tranches t
 JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
 WHERE (p_tournament IS NULL OR t.tournament_id=p_tournament) AND (p_registration IS NULL OR r.registration_id=p_registration)
  AND (p_start IS NULL OR b.observed_at>=p_start) AND (p_end IS NULL OR b.observed_at<p_end)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=t.credit_ledger_id);
$$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_tournament_returns(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Free chip admission has no debit to attribute. The original registration
-- already declares the earning club via fn_stamp_entry_club at INSERT, and
-- the original prize owner pays that same stamped club. Never use a later
-- membership lookup or extend this rule to satellite/ticket instruments.
CREATE FUNCTION public.fn_union_pnl_tournament_entry_club(r public.tournament_participant_funding_receipts)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN r.asset='chips' AND r.amount>0 THEN r.funding_club_id
  WHEN r.asset='chips' AND r.amount=0 AND r.ledger_id IS NULL AND r.entitlement_id IS NULL
   AND r.registration_snapshot->>'source_satellite_id' IS NULL
   AND r.registration_snapshot->'is_satellite_qualifier'='false'::jsonb
   THEN (r.registration_snapshot->>'club_id')::uuid END;
$$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_tournament_entry_club(public.tournament_participant_funding_receipts) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE inv jsonb; holdings jsonb:='[]'; issues jsonb:='[]'; s jsonb; t jsonb; f record; tr record;
 owned uuid; owners int; initial int; value numeric; entries int; first_op text;
BEGIN
 inv:=public.fn_union_pnl_inventory_as_of(p_at);
 IF inv->>'status' IS DISTINCT FROM 'observed' THEN RETURN jsonb_build_object('status','blocked','inventory',inv,'holdings',holdings); END IF;
 FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,table_seats}','[]')) x
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
   WHERE y#>>'{row,id}'=x#>>'{row,table_id}' AND y#>>'{row,union_id}'=p_union_id::text) LOOP
  SELECT count(*) FILTER(WHERE operation_kind='buyin'),count(DISTINCT (funding_club_id,account_type,account_entity_id)),min(funding_club_id::text)::uuid
   INTO initial,owners,owned FROM public.cash_participant_funding_receipts r
   LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE table_id=(s->>'table_id')::uuid AND user_id=(s->>'user_id')::uuid
    AND occupancy_id=(s->>'occupancy_id')::uuid AND seat_id=(s->>'id')::uuid
    AND seat_joined_at=(s->>'joined_at')::timestamptz AND COALESCE(b.observed_at,r.recorded_at)<p_at;
  value:=public.fn_pnl_evidence_cents(s->'stack');
  IF initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN
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
 FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x
  WHERE x#>>'{row,union_id}'=p_union_id::text LOOP
  SELECT operation INTO first_op FROM public.union_pnl_inventory_events WHERE source_name='tournaments' AND row_id=(t->>'id')::uuid ORDER BY event_id LIMIT 1;
  IF first_op IS DISTINCT FROM 'INSERT' THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
  FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) x
   WHERE x#>>'{row,tournament_id}'=t->>'id' LOOP
   SELECT count(*),count(DISTINCT public.fn_union_pnl_tournament_entry_club(r)),min(public.fn_union_pnl_tournament_entry_club(r)::text)::uuid,
    sum(amount) INTO entries,owners,owned,value
   FROM public.tournament_participant_funding_receipts r
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.tournament_id=(t->>'id')::uuid AND registration_id=(s->>'id')::uuid AND b.observed_at<p_at AND asset='chips';
   IF entries=0 OR owners<>1 OR owned IS NULL OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND registration_id=(s->>'id')::uuid AND asset<>'chips') THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_original_instrument_or_earning_club_missing','registration_id',s->'id')); CONTINUE;
   END IF;
   IF EXISTS(SELECT 1 FROM public.fn_union_pnl_tournament_returns((t->>'id')::uuid,(s->>'id')::uuid,NULL,p_at) c
     JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
     WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id=(s->>'user_id')::uuid AND b.observed_at<p_at
      AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
       WHERE r.registration_id=(s->>'id')::uuid AND r.id=ANY(c.entry_receipt_ids)) AND c.credited_club_id<>owned) THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_credit_owner_changed','registration_id',s->'id')); CONTINUE;
   END IF;
   SELECT value-COALESCE(sum(c.amount),0) INTO value FROM public.fn_union_pnl_tournament_returns((t->>'id')::uuid,(s->>'id')::uuid,NULL,p_at) c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id=(s->>'user_id')::uuid AND b.observed_at<p_at
      AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
       WHERE r.registration_id=(s->>'id')::uuid AND r.id=ANY(c.entry_receipt_ids));
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','deferred_tournament_result','source_id',s->'id'));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('status',CASE WHEN issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,'boundary',p_at,
  'inventory',inv,'holdings',holdings,'issues',issues,'tournament_basis','original_realized_settlement_deferred_while_open');
END $$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_boundary(uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE INDEX union_pnl_inventory_transaction ON public.union_pnl_inventory_events(transaction_id,source_name);
CREATE FUNCTION public.fn_union_pnl_original_flow_evidence(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS TABLE(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
 ), matched AS (
  SELECT q.*,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user
  FROM originals q
  LEFT JOIN public.cash_participant_funding_receipts f ON f.source_ledger_id=q.ledger_id AND q.tournament_id IS NULL
  LEFT JOIN public.tournament_participant_funding_receipts e ON e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id
  LEFT JOIN public.fn_union_pnl_tournament_returns(NULL,NULL,p_start,p_end) c ON c.ledger_id=q.ledger_id AND q.tournament_id=c.tournament_id
  LEFT JOIN LATERAL (
   SELECT count(DISTINCT (r.funding_club_id,r.user_id)) owners,min(r.funding_club_id::text)::uuid funding_club_id,min(r.user_id::text)::uuid user_id
   FROM public.cash_participant_funding_receipts r
   WHERE r.table_id=(q.l->>'table_id')::uuid AND r.operation_kind='buyin'
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid
    AND r.funding_club_id=(q.l->>'club_id')::uuid
    AND (EXISTS(SELECT 1 FROM public.union_pnl_inventory_events i WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'occupancy_id'=r.occupancy_id::text
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=r.table_id::text)
     OR EXISTS(SELECT 1 FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
       WHERE a.transaction_id=q.transaction_id AND original.occupancy_id=r.occupancy_id AND a.refunded=(q.l->>'amount')::numeric))
  ) ret ON true
 ), projected AS (
  SELECT *,CASE WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(cash_club,return_club,entry_club,credit_club) owner_club,
   COALESCE(cash_user,return_user,entry_user,credit_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND owner_club::text=l->>'club_id' AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_funding' THEN cash_amount=(l->>'amount')::numeric AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN owners=1 AND l->>'from_type'='table_stack' AND l->>'category' IN('cashout','refund')
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN credit_amount=(l->>'amount')::numeric AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected;
$$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb:='[]'; v_clubs jsonb; v_eco jsonb; v_terms jsonb;
 v_fence timestamptz; v_bad bigint; v_hands bigint; v_rows bigint; v_cash_reconciled boolean; v_terms_value jsonb; v_cash_rake numeric; v_accepted_rake numeric;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<>public.fn_union_week_start(p_start) OR p_end<>public.fn_union_week_start(p_start+interval '8 days')
  OR p_end>clock_timestamp() THEN RAISE EXCEPTION 'invalid_closed_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT captured_at INTO v_fence FROM public.union_pnl_weekly_capture WHERE singleton;
 IF v_fence IS NULL OR p_start<=v_fence THEN
  RETURN jsonb_build_object('report_version',1,'status','blocked','basis_certified',false,'payment_authorized',false,
   'issues',jsonb_build_array('week_precedes_complete_original_capture'),'capture_started_at',v_fence,'all_players_included',false);
 END IF;
 -- Both readers wait for the original book's in-flight transactions; this
 -- function is VOLATILE so every subsequent query sees their committed facts.
 v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
 v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
 IF v_open->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','opening_basis_incomplete','evidence',v_open)); END IF;
 IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;
 SELECT count(*),count(*) FILTER(WHERE evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR evidence->'game_scope' IS DISTINCT FROM game_scope)
 INTO v_hands,v_bad FROM public.union_pnl_cash_outcomes WHERE game_scope->>'game_union_id'=p_union_id::text AND recognized_at>=p_start AND recognized_at<p_end;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;
 -- A missing original game scope cannot silently disappear from every Union.
 SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_original_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.union_pnl_original_flows WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_participant_funding_receipts WHERE recorded_at>=v_fence AND recorded_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_funding_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_funding_application_receipts WHERE applied_at>=v_fence AND applied_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_application_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_hand_provenance_receipts WHERE accepted_at>=v_fence AND accepted_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_hand_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) WHERE NOT valid;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_basis_incomplete','count',v_bad)); END IF;
 -- Every touched tournament registration must have its original chip entry,
 -- including zero-rake players. Historical/current membership is never used.
 SELECT count(*) INTO v_bad FROM public.union_pnl_inventory_events i
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
 WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
  AND EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
    AND t.row_id::text=COALESCE(i.after_row,i.before_row)->>'tournament_id'
    AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text)
  AND (NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.registration_id=i.row_id AND r.asset='chips' AND public.fn_union_pnl_tournament_entry_club(r) IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.registration_id=i.row_id AND (r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS NULL)));
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_original_population_or_instrument_incomplete','count',v_bad)); END IF;
 -- An award must return to the original funding club; a changed credited
 -- wallet does not prove a new earning ownership agreement.
 SELECT count(*) INTO v_bad FROM public.tournament_accounting_credit_receipts c
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 WHERE c.tournament_snapshot->>'union_id'=p_union_id::text AND b.observed_at>=p_start AND b.observed_at<p_end
  AND (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id));
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_award_original_earning_owner_incomplete','count',v_bad)); END IF;
 v_eco:=public.fn_union_eco_terms_evidence(p_union_id,p_start,p_end);
 IF v_eco->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','eco_commercial_basis_incomplete','evidence',v_eco)); END IF;
 SELECT count(DISTINCT x->'terms') INTO v_bad FROM jsonb_array_elements(COALESCE(v_eco->'segments','[]')) x;
 IF v_bad<>1 THEN v_issues:=v_issues||jsonb_build_array('eco_intraweek_changed_terms_require_original_allocation'); END IF;
 v_terms_value:=v_eco#>'{segments,0,terms}';
 -- Validate every original bank/source leg even when the week has no rows.
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
 WITH flows AS MATERIALIZED (SELECT * FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end)),
 hand_players AS MATERIALIZED (
  SELECT (p->>'earning_club_id')::uuid club_id,(p->>'user_id')::uuid user_id,(p->>'observed_stack_delta')::numeric delta
  FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p
  WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
 ), opening AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x GROUP BY 1),
 closing AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x GROUP BY 1),
 -- The canonical payout basis excludes retained Union-house rake. Gross
 -- original rake still belongs in the all-player P&L and bank reconciliation.
 rake AS MATERIALIZED (
  SELECT s.club_id,sum(s.rake_credit) generated,COALESCE(k.earned,0) earned,
   sum(s.rake_credit) FILTER(WHERE s.source_type='cash_rake_accrual') cash_rake,
   sum(s.rake_credit) FILTER(WHERE s.source_type='tournament_fee_accrual') tournament_rake
  FROM public.accounting_payable_earning_sources s
  LEFT JOIN (SELECT club_id,sum(payout) earned FROM public.fn_union_club_rake_basis(p_union_id,p_start,p_end) GROUP BY club_id) k ON k.club_id=s.club_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end GROUP BY s.club_id,k.earned
 ),
 roster AS (
  SELECT DISTINCT (COALESCE(after_row,before_row)->>'club_id')::uuid club_id FROM public.union_pnl_inventory_events
   WHERE source_name='union_clubs' AND COALESCE(after_row,before_row)->>'union_id'=p_union_id::text AND observed_at<p_end
    AND (observed_at>=p_start OR row_id::text IN(SELECT x#>>'{row,id}' FROM jsonb_array_elements(COALESCE(v_open#>'{inventory,population,union_clubs}','[]')) x))
  UNION SELECT club_id FROM rake UNION SELECT club_id FROM flows UNION SELECT club_id FROM hand_players UNION SELECT club_id FROM opening UNION SELECT club_id FROM closing
 ), movement AS (SELECT club_id,sum(buyins) buyins,sum(cashouts) cashouts,
  sum(cashouts-buyins) FILTER(WHERE kind IN('cash_funding','cash_return')) cash_flow,
  sum(buyins) FILTER(WHERE kind='cash_funding') cash_buyins,sum(cashouts) FILTER(WHERE kind='cash_return') cash_cashouts FROM flows GROUP BY club_id),
 hands AS (SELECT club_id,sum(delta) delta FROM hand_players GROUP BY club_id),
 people AS (SELECT club_id,count(DISTINCT user_id)::int players FROM(SELECT club_id,user_id FROM flows UNION SELECT club_id,user_id FROM hand_players
  UNION SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')||COALESCE(v_close->'holdings','[]')) x) q GROUP BY club_id),
 club_rows AS (
  SELECT r.club_id,COALESCE(m.buyins,0) buyins,COALESCE(m.cashouts,0) cashouts,COALESCE(m.cash_buyins,0) cash_buyins,COALESCE(m.cash_cashouts,0) cash_cashouts,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0) realized_net,COALESCE(o.amount,0) seated_start,COALESCE(c.amount,0) seated_end,
   COALESCE(o.cash,0) seated_start_cash,COALESCE(c.cash,0) seated_end_cash,
   COALESCE(c.amount,0)-COALESCE(o.amount,0) stack_delta,COALESCE(h.delta,0) cash_player_pnl,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)-COALESCE(h.delta,0) tournament_player_pnl,
   COALESCE(m.cash_flow,0)+COALESCE(c.cash,0)-COALESCE(o.cash,0)=COALESCE(h.delta,0) cash_reconciled,
   COALESCE(p.players,0) players,COALESCE(k.generated,0) rake_paid,COALESCE(k.earned,0) rake_earned,COALESCE(k.cash_rake,0) cash_rake,COALESCE(k.tournament_rake,0) tournament_rake,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)+COALESCE(k.generated,0) net
  FROM roster r LEFT JOIN movement m USING(club_id) LEFT JOIN opening o USING(club_id) LEFT JOIN closing c USING(club_id)
  LEFT JOIN hands h USING(club_id) LEFT JOIN people p USING(club_id) LEFT JOIN rake k USING(club_id)
  WHERE r.club_id IS NOT NULL
 ), player_results AS (
  SELECT club_id,user_id,sum(delta) delta FROM (
   SELECT club_id,user_id,cashouts-buyins delta FROM flows
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,-(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  ) amounts GROUP BY club_id,user_id
 ), wins AS(SELECT club_id,sum(greatest(delta,0)) winnings,sum(greatest(-delta,0)) losses FROM player_results GROUP BY club_id), complete AS (
  SELECT q.*,COALESCE(w.winnings,0) winnings,COALESCE(w.losses,0) losses,
   CASE v_terms_value->>'eco_base_mode'
    WHEN 'club_cash_profit' THEN rake_earned-cash_player_pnl
    WHEN 'net_invoice_position' THEN realized_net+stack_delta+rake_paid+rake_earned
    WHEN 'winnings_plus_rake' THEN realized_net+stack_delta+rake_paid
    WHEN 'winnings_only' THEN realized_net+stack_delta END eco_base
  FROM club_rows q LEFT JOIN wins w USING(club_id)
 ) SELECT COALESCE(jsonb_agg(to_jsonb(q)||jsonb_build_object('eco_amount',CASE WHEN v_terms_value->'eco_enabled'='true'::jsonb
  THEN round(-(v_terms_value->>'eco_rate')::numeric*eco_base,2) ELSE 0 END) ORDER BY club_id),'[]'),
  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0) INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake FROM complete q;
 SELECT COALESCE(sum((evidence->>'accepted_rake')::numeric),0) INTO v_accepted_rake FROM public.union_pnl_cash_outcomes
  WHERE game_scope->>'game_union_id'=p_union_id::text AND recognized_at>=p_start AND recognized_at<p_end;
 IF v_accepted_rake IS DISTINCT FROM v_cash_rake THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_rake_does_not_match_original_earning_and_bank_basis'); END IF;
 IF NOT v_cash_reconciled THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'); END IF;
 RETURN jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'issues',v_issues,'clubs',v_clubs,'opening_basis',v_open,'closing_basis',v_close,'eco_commercial_terms_evidence',v_eco,
  'accepted_cash_hands',v_hands,'club_count',v_rows,'current_seats_used',false,'current_membership_used',false,
  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');
END $$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) TO service_role;

CREATE FUNCTION public.fn_union_pnl_qualified_clubs(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE proof jsonb;
BEGIN
 proof:=public.fn_union_pnl_evidence_report(p_union_id,p_start,p_end);
 IF proof->'report_version' IS DISTINCT FROM '1'::jsonb OR proof->>'status' IS DISTINCT FROM 'ready'
  OR proof->'basis_certified' IS DISTINCT FROM 'true'::jsonb OR proof->'issues' IS DISTINCT FROM '[]'::jsonb THEN
  RAISE EXCEPTION 'union_pnl_basis_uncertified' USING ERRCODE='55000',DETAIL=COALESCE((proof->'issues')::text,'missing proof');
 END IF;
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_qualified_clubs(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Existing read interfaces and the sole payer consume the same certified rows.
CREATE OR REPLACE FUNCTION public.fn_union_pnl_all_clubs(p_union_id uuid,p_start timestamptz,p_end timestamptz,p_include_horses boolean DEFAULT true)
RETURNS TABLE(club_id uuid,buyins numeric,cashouts numeric,realized_net numeric,winnings numeric,losses numeric,players integer,seated_stack numeric)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE proof jsonb;
BEGIN
 IF p_include_horses IS DISTINCT FROM true THEN RAISE EXCEPTION 'complete_pnl_population_required' USING ERRCODE='22023'; END IF;
 proof:=public.fn_union_pnl_qualified_clubs(p_union_id,p_start,p_end);
 RETURN QUERY SELECT (x->>'club_id')::uuid,(x->>'buyins')::numeric,(x->>'cashouts')::numeric,(x->>'realized_net')::numeric,
  (x->>'winnings')::numeric,(x->>'losses')::numeric,(x->>'players')::integer,(x->>'seated_end')::numeric
 FROM jsonb_array_elements(proof->'clubs') x;
END $$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_cash_by_club(p_union_id uuid,p_start timestamptz,p_end timestamptz,p_include_horses boolean DEFAULT true)
RETURNS TABLE(club_id uuid,buyins numeric,cashouts numeric,realized_net numeric,players integer,seated_stack numeric)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE proof jsonb;
BEGIN
 IF p_include_horses IS DISTINCT FROM true THEN RAISE EXCEPTION 'complete_pnl_population_required' USING ERRCODE='22023'; END IF;
 proof:=public.fn_union_pnl_qualified_clubs(p_union_id,p_start,p_end);
 RETURN QUERY SELECT (x->>'club_id')::uuid,(x->>'cash_buyins')::numeric,(x->>'cash_cashouts')::numeric,
  (x->>'cash_cashouts')::numeric-(x->>'cash_buyins')::numeric,(x->>'players')::integer,(x->>'seated_end_cash')::numeric
 FROM jsonb_array_elements(proof->'clubs') x;
END $$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_baseline(p_union_id uuid,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE b jsonb; answer jsonb;
BEGIN
 b:=public.fn_union_pnl_boundary(p_union_id,p_at);
 IF b->>'status' IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'exact_original_pnl_boundary_required' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY club_id),'[]') INTO answer FROM(
  SELECT x->>'club_id' club_id,sum((x->>'amount')::numeric) seated_end,
   COALESCE(sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result'),0) seated_end_cash
  FROM jsonb_array_elements(b->'holdings') x GROUP BY 1) q;
 RETURN answer;
END $$;

CREATE FUNCTION public.fn_union_pnl_closed_book_barrier(p_at timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE started timestamptz; book timestamptz;
BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp()
  OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'closed_original_book_barrier_required' USING ERRCODE='22023'; END IF;
 SELECT captured_at INTO started FROM public.union_pnl_inventory_capture WHERE singleton;
 IF started IS NULL THEN RAISE EXCEPTION 'original_inventory_capture_missing' USING ERRCODE='55000'; END IF;
 book:=public.fn_union_week_start(started);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_closed_book_barrier(timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Original money producers enter their inventory book before their Union rake
-- period. All close entries must acquire those locks in that same order.
DO $barriers$
DECLARE source text; needle text;
BEGIN
 source:=pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 needle:=$n$ PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN p_union_id IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'weekly_preparation_lock_location_changed'; END IF;
 EXECUTE replace(source,needle,' IF p_union_id IS NOT NULL THEN PERFORM public.fn_union_pnl_closed_book_barrier(p_to); END IF;'||chr(10)||needle);
 source:=pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);
 needle:=$n$      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id::text||':'||extract(epoch FROM v_from)::text||':'||extract(epoch FROM v_end)::text,0));$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'weekly_coordinator_lock_location_changed'; END IF;
 EXECUTE replace(source,needle,'      PERFORM public.fn_union_pnl_closed_book_barrier(v_end);'||chr(10)||needle);
 source:=pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
 needle:=$n$  -- Share the weekly scope lock, then serialize overlapping P&L callers for this union.$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'direct_pnl_lock_location_changed'; END IF;
 EXECUTE replace(source,needle,'  PERFORM public.fn_union_pnl_closed_book_barrier(p_end);'||chr(10)||needle);
 source:=pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure);
 needle:=$n$  -- Serialize every entry point for this union/period. A replay must read$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'union_cascade_lock_location_changed'; END IF;
 source:=replace(source,needle,$b$  IF v_from IS NULL OR NOT isfinite(v_from) OR v_from<>public.fn_union_week_start(v_from)
   OR v_to IS DISTINCT FROM public.fn_union_week_start(v_from+interval '8 days') THEN
   RAISE EXCEPTION 'accounting_preparation_requires_closed_week' USING ERRCODE='22023';
  END IF;
  PERFORM public.fn_union_pnl_closed_book_barrier(v_to);
$b$||needle);
 needle:='  IF public.fn_union_eco_enabled(p_union_id) THEN';
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'union_cascade_eco_gate_changed'; END IF;
 EXECUTE replace(source,needle,$b$  IF public.fn_union_pnl_qualified_clubs(p_union_id,v_from,v_to)#>>'{eco_commercial_terms_evidence,segments,0,terms,eco_enabled}'='true' THEN$b$);
END $barriers$;
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
-- The coordinator remains private to the existing authorized weekly entry.
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- The actual membership relation is keyed by (club_id,user_id), with no id
-- column. Keep the same locking rows and order in both original payer stages.
DO $membership_lock$
DECLARE signature text; source text; needle text:='PERFORM cm.id FROM public.club_members cm';
BEGIN
 FOREACH signature IN ARRAY ARRAY['fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)',
   'fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'] LOOP
  source:=pg_get_functiondef(('public.'||signature)::regprocedure);
  IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'original_membership_payer_lock_changed:%',signature; END IF;
  EXECUTE replace(source,needle,'PERFORM cm.user_id FROM public.club_members cm');
 END LOOP;
END $membership_lock$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz),
 public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- The original whole-hand check rejected a valid retained Union-house
-- attribution, so one house participant blocked every member club's payout.
-- Accept only the exact immutable accrued house source for that attribution;
-- the original recipient loops and house-retention policy remain unchanged.
DO $house_attribution$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure);
 needle:='OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS NOT TRUE)';
 replacement:='OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND (c.is_union IS NOT TRUE
       OR (c.is_union IS TRUE AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
         JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
         WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
          AND hs.union_id=scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
          AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status=''accrued''
          AND hs.contract->>''is_union_house''=''true'' AND hs.contract->>''attribution_id''=a.id::text
          AND hs.contract->>''club_id''=a.club_id::text AND hs.contract->>''player_id''=a.player_id::text
          AND hs.contract->>''union_id''=hs.union_id::text))))';
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'original_retained_house_attribution_guard_changed'; END IF;
 EXECUTE replace(source,needle,replacement);
END $house_attribution$;
REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;

-- Retained house sources are bank revenue, not a missing player payable.
-- Validate their canonical original disposition before excluding them from
-- the completeness check; every ordinary source still requires a certificate.
DO $house_payable$
DECLARE source text; needle text;
BEGIN
 source:=pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure);
 needle:='p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;';
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'original_rakeback_scope_guard_changed'; END IF;
 source:=replace(source,needle,needle||E'\n IF p_union_id IS NOT NULL THEN PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end); END IF;');
 needle:=E'AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end\n   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)';
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'original_rakeback_missing_payable_guard_changed'; END IF;
 source:=replace(source,needle,E'AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end\n   AND COALESCE((rs.contract->>''is_union_house'')::boolean,false) IS FALSE\n   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)');
 EXECUTE source;
END $house_payable$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- A paid Union scope must validate its committed original payout receipt on
-- replay, not ask the pending-only calculator to rebuild paid player periods.
DO $paid_scope_replay$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 needle:=' PERFORM public.fn_lock_rakeback_payer_clubs(clubs);';
 replacement:=needle||$body$
 IF p_union_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3
     AND r.period_start=p_from AND r.period_end=p_to) THEN
  source_check:=public.fn_settle_accounting_rakeback_stage('union',p_union_id,p_from,p_to);
  IF source_check->>'success' IS DISTINCT FROM 'true' OR source_check->>'duplicate' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'original_paid_scope_replay_not_confirmed' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('success',true,'accounting_version',3,'union_id',p_union_id,'club_id',p_club_id,
    'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'problems','[]'::jsonb,'paid_scope_replay',true);
 END IF;$body$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'original_preparation_replay_location_changed'; END IF;
 EXECUTE replace(source,needle,replacement);
END $paid_scope_replay$;
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

DO $payer$
DECLARE source text; old_block text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
 old_block:=substring(source FROM '  -- \(A\) FIX: baseline at the OPENING of the window\.[\s\S]*?    \) base;');
 IF old_block IS NULL OR position('fn_union_pnl_all_clubs' IN old_block)=0 OR position('opening_treasury' IN old_block)=0
  OR position('PERFORM public.fn_require_union_pnl_evidence(p_union_id,p_start,p_end);' IN source)=0 THEN
  RAISE EXCEPTION 'original_union_pnl_payer_calculation_changed'; END IF;
 replacement:=$replacement$  -- These rows already reconcile accepted outcomes, original cash flows,
  -- exact boundary holdings, tournament deferral and the one rake basis.
  v_prev:=public.fn_union_pnl_qualified_clubs(p_union_id,p_start,p_end);
  CREATE TEMP TABLE IF NOT EXISTS _pnl_tmp (
    club_id uuid PRIMARY KEY,net numeric,seated numeric,detail jsonb,opening_treasury numeric) ON COMMIT DROP;
  DELETE FROM pg_temp._pnl_tmp WHERE true;
  INSERT INTO pg_temp._pnl_tmp(club_id,net,seated,detail)
  SELECT (x->>'club_id')::uuid,(x->>'net')::numeric,(x->>'seated_end')::numeric,x
  FROM jsonb_array_elements(v_prev->'clubs') x;$replacement$;
 EXECUTE replace(source,old_block,replacement);
END $payer$;

CREATE OR REPLACE FUNCTION public.fn_union_eco_adjustment(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS TABLE(club_id uuid,club_name text,players_won numeric,rake_generated numeric,cash_players_won numeric,cash_rake numeric,
 tournament_rake numeric,total_rake_generated numeric,club_commission_rate numeric,rake_earned numeric,eco_base numeric,
 eco_rate numeric,eco_amount numeric,direction text,union_net_eco numeric,eco_base_mode text,baseline_cash_exact boolean,include_horses boolean,eco_enabled boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE proof jsonb; terms jsonb;
BEGIN
 -- Preserve the existing disclosure authorization before reading evidence.
 IF auth.uid() IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM unions u WHERE u.id=p_union_id AND u.owner_id=auth.uid())
  AND NOT EXISTS(SELECT 1 FROM union_admins ua WHERE ua.union_id=p_union_id AND ua.user_id=auth.uid())
  AND NOT EXISTS(SELECT 1 FROM union_clubs uc JOIN club_members cm ON cm.club_id=uc.club_id
   WHERE uc.union_id=p_union_id AND cm.user_id=auth.uid() AND cm.role IN('owner','co_owner','admin','super_agent')) THEN
  RAISE EXCEPTION 'not authorized to read union reconciliation' USING ERRCODE='42501'; END IF;
 proof:=public.fn_union_pnl_qualified_clubs(p_union_id,p_start,p_end);
 terms:=proof#>'{eco_commercial_terms_evidence,segments,0,terms}';
 RETURN QUERY WITH rows AS(
  SELECT x,(x->>'club_id')::uuid id,(x->>'eco_amount')::numeric eco FROM jsonb_array_elements(proof->'clubs') x
 ), total AS(SELECT COALESCE(sum(-eco),0) amount FROM rows)
 SELECT r.id,c.name::text,(x->>'realized_net')::numeric+(x->>'stack_delta')::numeric,(x->>'rake_paid')::numeric,
  (x->>'cash_player_pnl')::numeric,(x->>'cash_rake')::numeric,(x->>'tournament_rake')::numeric,(x->>'rake_paid')::numeric,
  CASE WHEN (x->>'rake_paid')::numeric>0 THEN (x->>'rake_earned')::numeric/(x->>'rake_paid')::numeric ELSE NULL END,
  (x->>'rake_earned')::numeric,(x->>'eco_base')::numeric,(terms->>'eco_rate')::numeric,r.eco,
  CASE WHEN r.eco<0 THEN 'club pays union (profitable week)' WHEN r.eco>0 THEN 'union pays club (losing week)' ELSE 'square' END,
  total.amount,terms->>'eco_base_mode',true,true,(terms->>'eco_enabled')::boolean
 FROM rows r LEFT JOIN clubs c ON c.id=r.id CROSS JOIN total ORDER BY r.eco;
END $$;

CREATE OR REPLACE FUNCTION public.fn_union_reconciliation_report(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS TABLE(club_id uuid,club_name text,buyins numeric,cashouts numeric,realized_net numeric,seated_start numeric,seated_end numeric,
 stack_delta numeric,rake_paid numeric,settle_net numeric,direction text,turnover numeric,house_residual numeric,tolerance numeric,within_tolerance boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE proof jsonb;
BEGIN
 IF auth.uid() IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM unions u WHERE u.id=p_union_id AND u.owner_id=auth.uid())
  AND NOT EXISTS(SELECT 1 FROM union_admins ua WHERE ua.union_id=p_union_id AND ua.user_id=auth.uid())
  AND NOT EXISTS(SELECT 1 FROM union_clubs uc JOIN club_members cm ON cm.club_id=uc.club_id
   WHERE uc.union_id=p_union_id AND cm.user_id=auth.uid() AND cm.role IN('owner','co_owner','admin','super_agent')) THEN
  RAISE EXCEPTION 'not authorized to read union reconciliation' USING ERRCODE='42501'; END IF;
 proof:=public.fn_union_pnl_qualified_clubs(p_union_id,p_start,p_end);
 RETURN QUERY WITH rows AS(SELECT x,(x->>'club_id')::uuid id,(x->>'net')::numeric net,
  (x->>'buyins')::numeric+(x->>'cashouts')::numeric turnover FROM jsonb_array_elements(proof->'clubs') x),
 totals AS(SELECT sum(r.net) residual,greatest(100,round(sum(r.turnover)*0.01,2)) tolerance FROM rows r)
 SELECT r.id,c.name::text,(x->>'buyins')::numeric,(x->>'cashouts')::numeric,(x->>'realized_net')::numeric,
  (x->>'seated_start')::numeric,(x->>'seated_end')::numeric,(x->>'stack_delta')::numeric,(x->>'rake_paid')::numeric,r.net,
  CASE WHEN r.net<0 THEN 'club pays union' WHEN r.net>0 THEN 'union pays club' ELSE 'square' END,
  r.turnover,t.residual,t.tolerance,abs(t.residual)<=t.tolerance
 FROM rows r LEFT JOIN clubs c ON c.id=r.id CROSS JOIN totals t ORDER BY r.net;
END $$;
REVOKE ALL ON FUNCTION public.fn_union_reconciliation_report(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_union_reconciliation_report(uuid,timestamptz,timestamptz) TO authenticated,service_role;

-- Record the same observed commercial mode, never today's settings.
DO $eco_record$
DECLARE source text;
BEGIN
 source:=pg_get_functiondef('public.fn_union_eco_record(uuid,timestamptz,timestamptz,uuid)'::regprocedure);
 IF position('e.eco_amount, v_mode, e.cash_players_won' IN source)=0 THEN RAISE EXCEPTION 'original_eco_record_projection_changed'; END IF;
 source:=replace(source,'e.eco_amount, v_mode, e.cash_players_won','e.eco_amount, e.eco_base_mode, e.cash_players_won');
 source:=replace(source,'v_mode text := fn_union_eco_base_mode(p_union_id);','v_mode text;');
 source:=replace(source,'  INSERT INTO union_eco_ledger (union_id, club_id, period_start, period_end,',
  '  SELECT x.eco_base_mode INTO v_mode FROM public.fn_union_eco_adjustment(p_union_id,p_start,p_end) x LIMIT 1;'||chr(10)||
  '  INSERT INTO union_eco_ledger (union_id, club_id, period_start, period_end,');
 EXECUTE source;
END $eco_record$;

-- Existing explicit settings may be observed prospectively, but are never
-- asserted to have been an original historical write. The private ID fence is
-- what distinguishes this new observation from unsupported old baselines.
CREATE TABLE public.union_pnl_eco_observations (
 agreement_id bigint PRIMARY KEY,
 union_id uuid NOT NULL,
 observed_from timestamptz NOT NULL CHECK(isfinite(observed_from))
);
ALTER TABLE public.union_pnl_eco_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_pnl_eco_observations FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_pnl_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.union_pnl_eco_observations
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
-- Original Union writers were drained by bounded admission above.
DO $eco_observe$
DECLARE u record; receipt bigint; observed timestamptz:=clock_timestamp();
BEGIN
 FOR u IN SELECT id,settings FROM public.unions ORDER BY id LOOP
  INSERT INTO public.accounting_agreement_history(entity_type,entity_key,union_id,club_id,event_type,observed_at,actor_id,before_terms,after_terms)
  VALUES('unions',u.id::text,u.id,NULL,'baseline',observed,NULL,NULL,public.fn_accounting_union_eco_terms(u.settings)) RETURNING id INTO receipt;
  INSERT INTO public.union_pnl_eco_observations VALUES(receipt,u.id,observed);
 END LOOP;
END $eco_observe$;
DO $eco_terms$
DECLARE source text; needle text;
BEGIN
 source:=pg_get_functiondef('public.fn_union_eco_terms_evidence(uuid,timestamptz,timestamptz)'::regprocedure);
 needle:=$needle$ELSIF r.event_type='baseline' THEN issue:='eco_terms_observation_is_not_original_write';$needle$;
 IF position(needle IN source)=0 THEN RAISE EXCEPTION 'original_eco_terms_reader_changed'; END IF;
 source:=replace(source,needle,$replacement$ELSIF r.event_type='baseline' AND NOT EXISTS(SELECT 1 FROM public.union_pnl_eco_observations o
   WHERE o.agreement_id=r.id AND o.union_id=r.union_id AND o.observed_from=r.observed_at AND o.observed_from<=p_start)
   THEN issue:='eco_terms_observation_is_not_original_write';$replacement$);
 EXECUTE source;
 source:=pg_get_functiondef('public.fn_accounting_union_eco_capture()'::regprocedure);
 needle:='stamp timestamptz:=clock_timestamp();';
 IF position(needle IN source)=0 THEN RAISE EXCEPTION 'original_eco_terms_capture_changed'; END IF;
 EXECUTE replace(source,needle,'stamp timestamptz:=(public.fn_union_pnl_original_frame()).observed_at;');
END $eco_terms$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_frame(),public.fn_union_pnl_receipt_frame(),
 public.fn_union_pnl_capture_original_flow(),public.fn_union_pnl_capture_accepted_cash(),public.fn_union_pnl_inventory_observe(),
 public.fn_union_eco_terms_evidence(uuid,timestamptz,timestamptz),public.fn_accounting_union_eco_capture()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_all_clubs(uuid,timestamptz,timestamptz,boolean),
 public.fn_union_pnl_cash_by_club(uuid,timestamptz,timestamptz,boolean),public.fn_union_pnl_baseline(uuid,timestamptz),
 public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz),public.fn_union_eco_record(uuid,timestamptz,timestamptz,uuid),
 public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_pnl_all_clubs(uuid,timestamptz,timestamptz,boolean),
 public.fn_union_pnl_cash_by_club(uuid,timestamptz,timestamptz,boolean),public.fn_union_pnl_baseline(uuid,timestamptz),
 public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz),public.fn_union_eco_record(uuid,timestamptz,timestamptz,uuid),
 public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean) TO service_role;
COMMIT;
