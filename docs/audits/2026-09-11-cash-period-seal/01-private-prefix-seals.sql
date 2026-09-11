-- Candidate only. Private receipt-prefix fences, not a weekly settlement authority.
-- Install only with the reviewed capture/bank generation. No public API grants.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='10s';
CREATE SCHEMA ca_accounting_seal_private;
REVOKE ALL ON SCHEMA ca_accounting_seal_private FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE ca_accounting_seal_private.producer_prefixes (
 cutoff timestamptz PRIMARY KEY CHECK(isfinite(cutoff)),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array'),
 manifest_sha256 text NOT NULL,
 contract_version integer NOT NULL DEFAULT 1 CHECK(contract_version=1)
);
CREATE TABLE ca_accounting_seal_private.bank_manifests (
 producer_cutoff timestamptz PRIMARY KEY REFERENCES ca_accounting_seal_private.producer_prefixes(cutoff),
 bank_cutoff timestamptz NOT NULL CHECK(isfinite(bank_cutoff)),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='array'),
 manifest_sha256 text NOT NULL,
 period_closed boolean NOT NULL DEFAULT false CHECK(NOT period_closed)
);
CREATE INDEX bank_manifests_cutoff ON ca_accounting_seal_private.bank_manifests(bank_cutoff);
CREATE TABLE ca_accounting_seal_private.banked_sources (
 hand_id uuid PRIMARY KEY,
 producer_cutoff timestamptz NOT NULL REFERENCES ca_accounting_seal_private.bank_manifests(producer_cutoff)
);
ALTER TABLE ca_accounting_seal_private.banked_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ca_accounting_seal_private.producer_prefixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ca_accounting_seal_private.bank_manifests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA ca_accounting_seal_private FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION ca_accounting_seal_private.immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$
BEGIN RAISE EXCEPTION 'Cash seal manifests are immutable'; END $f$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ca_accounting_seal_private.producer_prefixes
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ca_accounting_seal_private.producer_prefixes
 FOR EACH STATEMENT EXECUTE FUNCTION ca_accounting_seal_private.immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ca_accounting_seal_private.bank_manifests
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ca_accounting_seal_private.bank_manifests
 FOR EACH STATEMENT EXECUTE FUNCTION ca_accounting_seal_private.immutable();

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ca_accounting_seal_private.banked_sources
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ca_accounting_seal_private.banked_sources
 FOR EACH STATEMENT EXECUTE FUNCTION ca_accounting_seal_private.immutable();

CREATE FUNCTION ca_accounting_seal_private.require_read_committed() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Cash seal requires a fresh read committed snapshot after admission waits' USING ERRCODE='25001';
 END IF;
END $f$;

CREATE FUNCTION ca_accounting_seal_private.admit_producer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE v_cutoff timestamptz;
BEGIN
 IF TG_OP='UPDATE' AND OLD.commission_capture_version IS NULL THEN RETURN NEW; END IF;
 IF NEW.commission_capture_version IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'New accepted receipt requires cash capture generation one';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.hand_id IS DISTINCT FROM OLD.hand_id OR NEW.table_id IS DISTINCT FROM OLD.table_id
   OR NEW.hand_number IS DISTINCT FROM OLD.hand_number OR NEW.committed_at IS DISTINCT FROM OLD.committed_at THEN
   RAISE EXCEPTION 'Accepted producer identity and original timestamp are immutable';
  END IF;
  IF OLD.post_commit_payload IS NOT NULL THEN RETURN NEW; END IF;
 END IF;
 PERFORM ca_accounting_seal_private.require_read_committed();
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('club-arena:cash-producer-prefix:v1',0));
 -- NEW.committed_at was evaluated before this wait. Never replace it with now().
 SELECT max(cutoff) INTO v_cutoff FROM ca_accounting_seal_private.producer_prefixes;
 IF NEW.committed_at IS NULL OR NOT isfinite(NEW.committed_at) OR NEW.committed_at<=v_cutoff THEN
  RAISE EXCEPTION 'Accepted receipt original timestamp is inside a sealed producer prefix' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER aaa_cash_producer_prefix_admission BEFORE INSERT OR UPDATE ON public.hand_atomic_commits
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.admit_producer();

CREATE FUNCTION ca_accounting_seal_private.seal_producer(p_cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$
DECLARE v_manifest jsonb; v_prior jsonb; v_lower timestamptz;
BEGIN
 PERFORM ca_accounting_seal_private.require_read_committed();
 IF p_cutoff IS NULL OR NOT isfinite(p_cutoff) OR p_cutoff>=clock_timestamp() THEN
  RAISE EXCEPTION 'Producer cutoff must be a finite past instant' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('club-arena:cash-producer-prefix:v1',0));
 SELECT manifest INTO v_prior FROM ca_accounting_seal_private.producer_prefixes WHERE cutoff=p_cutoff;
 IF FOUND THEN RETURN jsonb_build_object('stage','producer_prefix','period_closed',false,'replayed',true,'manifest',v_prior); END IF;
 SELECT max(cutoff) INTO v_lower FROM ca_accounting_seal_private.producer_prefixes;
 IF p_cutoff<=v_lower THEN
  RAISE EXCEPTION 'Producer prefixes advance monotonically';
 END IF;
 -- This private stage has no authority to classify unknown or noncash receipts.
 -- Absence is not interpreted as an empty cash period, even when a table moved.
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits h
   LEFT JOIN public.ca_cash_commission_sources s ON s.hand_id=h.hand_id
   WHERE h.commission_capture_version=1 AND h.committed_at<=p_cutoff
   AND (v_lower IS NULL OR h.committed_at>v_lower)
    AND (h.post_commit_payload IS NULL OR s.hand_id IS NULL
      OR s.accepted_at IS DISTINCT FROM h.committed_at
      OR s.accepted_payload_hash IS DISTINCT FROM h.post_commit_payload_hash
      OR s.table_id IS DISTINCT FROM h.table_id OR s.hand_number IS DISTINCT FROM h.hand_number
      OR s.contributor_count<>(SELECT count(*) FROM public.ca_cash_commission_facts f WHERE f.hand_id=h.hand_id)
      OR s.rake_total IS DISTINCT FROM (SELECT coalesce(sum(f.rake_credit),0) FROM public.ca_cash_commission_facts f WHERE f.hand_id=h.hand_id)
      OR EXISTS(SELECT 1 FROM public.ca_cash_commission_facts f WHERE f.hand_id=h.hand_id
        AND (jsonb_array_length(f.errors)>0 OR f.booked_club_id IS NULL
          OR f.funding_state NOT IN ('club_treasury_owner','union_member','union_self_retained'))))) THEN
  RAISE EXCEPTION 'Producer prefix has unknown, noncash, missing or invalid accepted source facts' USING ERRCODE='55000';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',to_jsonb(s),'facts',
  (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.player_id),'[]') FROM public.ca_cash_commission_facts f WHERE f.hand_id=s.hand_id))
  ORDER BY s.hand_id),'[]') INTO v_manifest
 FROM public.ca_cash_commission_sources s JOIN public.hand_atomic_commits h ON h.hand_id=s.hand_id
 WHERE h.commission_capture_version=1 AND h.committed_at<=p_cutoff
   AND (v_lower IS NULL OR h.committed_at>v_lower);
 INSERT INTO ca_accounting_seal_private.producer_prefixes(cutoff,manifest,manifest_sha256)
 VALUES(p_cutoff,v_manifest,encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex'));
 RETURN jsonb_build_object('stage','producer_prefix','period_closed',false,'replayed',false,'manifest',v_manifest);
END $f$;

CREATE FUNCTION ca_accounting_seal_private.admit_bank() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE v_hand uuid; v_time timestamptz; v_cutoff timestamptz; v_sealed boolean;
BEGIN
 IF TG_TABLE_NAME='rake_records' THEN
  IF NEW.is_tournament IS TRUE OR NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  v_hand:=NEW.hand_id; v_time:=NULL;
 ELSIF TG_TABLE_NAME='rake_distribution_legs' THEN
  IF NEW.leg NOT IN ('union_rake','chip_treasury') THEN RETURN NEW; END IF;
  v_hand:=NEW.leg_key; v_time:=NULL;
 ELSIF TG_TABLE_NAME='chip_ledger' THEN
  IF NEW.category IS DISTINCT FROM 'rake' OR NEW.to_type IS DISTINCT FROM 'club_treasury'
    OR NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  v_hand:=NEW.hand_id; v_time:=NEW.created_at;
 ELSIF TG_TABLE_NAME='union_wallet_transactions' THEN
  IF NEW.tx_type IS DISTINCT FROM 'rake' OR NEW.wallet IS DISTINCT FROM 'rake_wallet'
   OR NEW.direction IS DISTINCT FROM 'credit' THEN RETURN NEW; END IF;
  v_hand:=nullif(current_setting('app.ledger_hand_id',true),'')::uuid; v_time:=NEW.created_at;
 ELSIF TG_TABLE_NAME='ca_cash_bank_receipts' THEN
  v_hand:=NEW.hand_id; v_time:=NEW.bank_credit_at;
 ELSE
  IF NEW.source_type<>'rake_settlement' THEN RETURN NEW; END IF;
  v_hand:=NEW.source_id; v_time:=NULL;
 END IF;
 PERFORM ca_accounting_seal_private.require_read_committed();
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('club-arena:cash-bank-manifest:v1',0));
 SELECT max(bank_cutoff) INTO v_cutoff FROM ca_accounting_seal_private.bank_manifests;
 SELECT EXISTS(SELECT 1 FROM ca_accounting_seal_private.banked_sources WHERE hand_id=v_hand) INTO v_sealed;
 IF v_sealed THEN
  -- ON CONFLICT retries may attempt the same record/leg/contributor insert.
  -- Their original existing receipts must match; NEW money ledger rows never qualify.
  IF TG_TABLE_NAME='rake_records' THEN
   IF EXISTS(SELECT 1 FROM public.rake_records r
    WHERE r.hand_id=v_hand AND r.table_id=NEW.table_id AND r.club_id=NEW.club_id
     AND r.rake_amount=NEW.rake_amount AND r.bbj_contribution=NEW.bbj_contribution
     AND r.pot_size=NEW.pot_size AND r.num_players=NEW.num_players
     AND r.rake_method=NEW.rake_method AND r.player_contributions=NEW.player_contributions
     AND coalesce(r.returned_uncalled,'{}')=coalesce(NEW.returned_uncalled,'{}')) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='rake_distribution_legs' THEN
   IF EXISTS(SELECT 1 FROM public.rake_distribution_legs l
    WHERE l.leg_key=NEW.leg_key AND l.leg=NEW.leg AND l.club_id=NEW.club_id
     AND l.union_id IS NOT DISTINCT FROM NEW.union_id AND l.amount=NEW.amount) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='ca_commission_contributor_receipts' THEN
   IF EXISTS(SELECT 1 FROM public.ca_commission_contributor_receipts c
    WHERE c.source_type=NEW.source_type AND c.source_id=NEW.source_id
      AND c.contributing_user_id=NEW.contributing_user_id AND c.requested_club_id=NEW.requested_club_id
      AND c.rake_credit=NEW.rake_credit AND c.state='applied') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Sealed bank source cannot create a new bank credit or receipt' USING ERRCODE='40001';
 END IF;
 IF v_time IS NOT NULL AND (NOT isfinite(v_time) OR v_time<=v_cutoff) THEN
  RAISE EXCEPTION 'Bank credit original timestamp is inside a sealed bank prefix' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER aaaa_cash_bank_manifest_admission BEFORE INSERT ON public.rake_records
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.admit_bank();
CREATE TRIGGER aaaa_cash_bank_manifest_admission BEFORE INSERT ON public.rake_distribution_legs
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.admit_bank();
CREATE TRIGGER aaaa_cash_bank_manifest_admission BEFORE INSERT ON public.chip_ledger
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.admit_bank();
CREATE TRIGGER aaaa_cash_bank_manifest_admission BEFORE INSERT ON public.union_wallet_transactions
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.admit_bank();
CREATE TRIGGER aaaa_cash_bank_manifest_admission BEFORE INSERT ON public.ca_cash_bank_receipts
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.admit_bank();
CREATE TRIGGER aaaa_cash_bank_manifest_admission BEFORE INSERT ON public.ca_commission_contributor_receipts
 FOR EACH ROW EXECUTE FUNCTION ca_accounting_seal_private.admit_bank();

CREATE FUNCTION ca_accounting_seal_private.seal_bank(p_producer_cutoff timestamptz,p_bank_cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$
DECLARE v_source jsonb; v_row jsonb; v_manifest jsonb:='[]'; v_bank public.ca_cash_bank_receipts%ROWTYPE;
 v_prior ca_accounting_seal_private.bank_manifests%ROWTYPE; v_contributors jsonb;
BEGIN
 PERFORM ca_accounting_seal_private.require_read_committed();
 IF p_bank_cutoff IS NULL OR NOT isfinite(p_bank_cutoff) OR p_bank_cutoff>=clock_timestamp()
   OR p_bank_cutoff<p_producer_cutoff THEN RAISE EXCEPTION 'Invalid bank cutoff' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('club-arena:cash-bank-manifest:v1',0));
 SELECT * INTO v_prior FROM ca_accounting_seal_private.bank_manifests WHERE producer_cutoff=p_producer_cutoff;
 IF FOUND THEN
  IF v_prior.bank_cutoff<>p_bank_cutoff THEN RAISE EXCEPTION 'Bank manifest replay cutoff conflict'; END IF;
  RETURN jsonb_build_object('stage','bank_and_contributor_manifest','period_closed',false,'replayed',true,'manifest',v_prior.manifest);
 END IF;
 SELECT manifest INTO STRICT v_source FROM ca_accounting_seal_private.producer_prefixes WHERE cutoff=p_producer_cutoff;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_source) ORDER BY value->'source'->>'hand_id' LOOP
  IF (v_row->'source'->>'rake_total')::numeric=0 THEN CONTINUE; END IF;
  SELECT * INTO v_bank FROM public.ca_cash_bank_receipts WHERE hand_id=(v_row->'source'->>'hand_id')::uuid;
  IF NOT FOUND OR v_bank.bank_credit_at>p_bank_cutoff THEN
   RAISE EXCEPTION 'Expected original cash source is not banked within the closed bank cutoff' USING ERRCODE='55000';
  END IF;
  PERFORM public.fn_ca_assert_cash_bank_receipt(v_bank.hand_id);
  IF EXISTS(SELECT 1 FROM public.ca_cash_commission_facts f
    LEFT JOIN public.ca_commission_contributor_receipts c ON c.source_type='rake_settlement'
     AND c.source_id=f.hand_id AND c.contributing_user_id=f.player_id
    WHERE f.hand_id=v_bank.hand_id AND f.rake_credit>0
     AND (c.source_id IS NULL OR c.state<>'applied' OR c.requested_club_id<>v_bank.requested_club_id
       OR c.booked_club_id IS DISTINCT FROM f.booked_club_id OR c.rake_credit<>f.rake_credit)) THEN
   RAISE EXCEPTION 'Expected banked source contributor receipt is missing or incomplete' USING ERRCODE='55000';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.contributing_user_id),'[]') INTO v_contributors
   FROM public.ca_commission_contributor_receipts c WHERE c.source_type='rake_settlement' AND c.source_id=v_bank.hand_id;
  v_manifest:=v_manifest||jsonb_build_array(jsonb_build_object('bank',to_jsonb(v_bank),'contributors',v_contributors));
 END LOOP;
 INSERT INTO ca_accounting_seal_private.bank_manifests(producer_cutoff,bank_cutoff,manifest,manifest_sha256)
 VALUES(p_producer_cutoff,p_bank_cutoff,v_manifest,encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex'));
 INSERT INTO ca_accounting_seal_private.banked_sources(hand_id,producer_cutoff)
 SELECT (m->'bank'->>'hand_id')::uuid,p_producer_cutoff FROM jsonb_array_elements(v_manifest) m;
 RETURN jsonb_build_object('stage','bank_and_contributor_manifest','period_closed',false,'replayed',false,'manifest',v_manifest);
END $f$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ca_accounting_seal_private FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
