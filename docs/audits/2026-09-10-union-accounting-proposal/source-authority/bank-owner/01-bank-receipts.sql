DO $index_required$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.ca_cash_bank_legacy_record_key') AND indisvalid) THEN
  RAISE EXCEPTION 'Cash bank legacy-key expansion index must be valid before activation';
 END IF;
END $index_required$;
-- PROPOSAL ONLY. Install with bank owner replacement and source activation in one
-- bounded transaction. This is bank acknowledgment, not Round1 released cash.
CREATE TABLE public.ca_cash_bank_receipts (
 hand_id uuid PRIMARY KEY REFERENCES public.ca_cash_commission_sources(hand_id),
 contract_version integer NOT NULL CHECK(contract_version=1),
 accepted_payload_hash text NOT NULL,
 rake_record_id uuid NOT NULL UNIQUE REFERENCES public.rake_records(id),
 leg_key uuid NOT NULL, leg text NOT NULL,
 requested_club_id uuid NOT NULL, funding_union_id uuid,
 funding_route text NOT NULL CHECK(funding_route IN ('union_rake_wallet','club_chip_treasury')),
 credited_amount numeric NOT NULL CHECK(credited_amount>0 AND credited_amount=round(credited_amount,2)
  AND credited_amount::text NOT IN ('NaN','Infinity','-Infinity')),
 bbj_contribution numeric NOT NULL, club_net_credit numeric NOT NULL,
 union_wallet_transaction_id uuid UNIQUE REFERENCES public.union_wallet_transactions(id),
 chip_ledger_id uuid UNIQUE REFERENCES public.chip_ledger(id),
 bank_credit_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(leg_key,leg) REFERENCES public.rake_distribution_legs(leg_key,leg),
 CHECK((funding_route='union_rake_wallet' AND funding_union_id IS NOT NULL
  AND leg='union_rake' AND union_wallet_transaction_id IS NOT NULL AND chip_ledger_id IS NULL)
 OR (funding_route='club_chip_treasury' AND funding_union_id IS NULL
  AND leg='chip_treasury' AND union_wallet_transaction_id IS NULL AND chip_ledger_id IS NOT NULL)),
 CHECK(club_net_credit=credited_amount-bbj_contribution)
);
ALTER TABLE public.ca_cash_bank_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_cash_bank_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_cash_bank_receipts TO service_role;
ALTER TABLE public.rake_records ADD COLUMN cash_bank_version integer
 CHECK(cash_bank_version IS NULL OR cash_bank_version=1);
ALTER TABLE public.rake_records ALTER COLUMN cash_bank_version SET DEFAULT 1;
ALTER TABLE public.rake_distribution_legs ADD COLUMN cash_bank_version integer
 CHECK(cash_bank_version IS NULL OR cash_bank_version=1);
ALTER TABLE public.rake_distribution_legs ALTER COLUMN cash_bank_version SET DEFAULT 1;

CREATE FUNCTION public.fn_ca_assert_cash_bank_receipt(p_hand_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.ca_cash_bank_receipts b
  JOIN public.ca_cash_commission_sources s ON s.hand_id=b.hand_id
  JOIN public.hand_atomic_commits h ON h.hand_id=s.hand_id
  JOIN public.ca_cash_commission_authority a ON a.singleton AND a.contract_version=1
  JOIN public.rake_records r ON r.id=b.rake_record_id
  JOIN public.rake_distribution_legs l ON l.leg_key=b.leg_key AND l.leg=b.leg
  LEFT JOIN public.union_wallet_transactions u ON u.id=b.union_wallet_transaction_id
  LEFT JOIN public.chip_ledger c ON c.id=b.chip_ledger_id
  WHERE b.hand_id=p_hand_id AND b.contract_version=a.contract_version
   AND h.commission_capture_version=a.contract_version
   AND h.post_commit_payload_hash=s.accepted_payload_hash
   AND b.accepted_payload_hash=s.accepted_payload_hash
   AND b.leg_key=s.bank_leg_key AND b.leg_key=s.hand_id
   AND b.requested_club_id=s.requested_club_id
   AND b.funding_union_id IS NOT DISTINCT FROM s.funding_union_id
   AND b.funding_route=s.funding_route AND b.credited_amount=s.rake_total
   AND r.cash_bank_version=1 AND r.hand_id=s.hand_id
   AND r.table_id=s.table_id AND r.club_id=s.requested_club_id
   AND r.rake_amount=s.rake_total AND r.rake_method=s.rake_method
   AND r.player_contributions=s.contributions AND coalesce(r.returned_uncalled,'{}')=s.returned_uncalled
   AND NOT r.is_tournament AND r.tournament_id IS NULL
   AND r.bbj_contribution=b.bbj_contribution
   AND r.bbj_contribution=(h.post_commit_payload->'rake'->>'bbj')::numeric
   AND r.pot_size=(h.post_commit_payload->'rake'->>'pot')::numeric
   AND r.num_players=(h.post_commit_payload->'rake'->>'num_players')::integer
   AND r.metadata->>'hand_number'=s.hand_number::text
   AND l.cash_bank_version=1 AND l.club_id=b.requested_club_id
   AND l.union_id IS NOT DISTINCT FROM b.funding_union_id AND l.amount=b.credited_amount
   AND NOT EXISTS(SELECT 1 FROM public.rake_distribution_legs z WHERE z.leg_key=b.leg_key
     AND z.leg IN ('union_rake','chip_treasury') AND z.leg<>b.leg)
   AND ((b.funding_route='union_rake_wallet' AND u.union_id=b.funding_union_id
     AND u.club_id=b.requested_club_id AND u.amount=b.credited_amount
     AND u.wallet='rake_wallet' AND u.direction='credit' AND u.tx_type='rake'
     AND u.created_at=b.bank_credit_at)
    OR (b.funding_route='club_chip_treasury' AND c.from_type='table_stack'
     AND c.from_entity_id=s.table_id AND c.to_type='club_treasury'
     AND c.to_entity_id=b.requested_club_id AND c.club_id=b.requested_club_id
     AND c.table_id=s.table_id AND c.hand_id=s.hand_id AND c.amount=b.credited_amount
     AND c.category='rake' AND c.status='posted' AND c.created_at=b.bank_credit_at))
 ) THEN RAISE EXCEPTION 'Captured cash bank receipt is missing or conflicts with credited source'; END IF;
END $f$;

CREATE FUNCTION public.fn_ca_cash_bank_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_owner name;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Captured cash bank receipt is immutable'; END IF;
 SELECT pg_get_userbyid(proowner) INTO STRICT v_owner FROM pg_proc
 WHERE oid='public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure;
 IF current_user IS DISTINCT FROM v_owner THEN
  RAISE EXCEPTION 'Only the cash bank owner may acknowledge credited source' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER ca_cash_bank_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.ca_cash_bank_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_receipt_guard();

CREATE FUNCTION public.fn_ca_cash_bank_deferred_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_hand uuid;
BEGIN
 IF TG_TABLE_NAME='rake_records' THEN
  v_hand:=NEW.hand_id;
  IF v_hand IS NULL THEN
   SELECT hand_id INTO v_hand FROM public.ca_cash_commission_sources
   WHERE table_id=NEW.table_id AND hand_number::text=NEW.metadata->>'hand_number';
  END IF;
 ELSE
  IF NEW.leg NOT IN ('union_rake','chip_treasury') THEN RETURN NULL; END IF;
  SELECT hand_id INTO v_hand FROM public.ca_cash_commission_sources
  WHERE hand_id=NEW.leg_key OR md5('rake:'||table_id::text||':'||hand_number::text)::uuid=NEW.leg_key;
 END IF;
 IF EXISTS(SELECT 1 FROM public.ca_cash_commission_sources WHERE hand_id=v_hand) THEN
  PERFORM public.fn_ca_assert_cash_bank_receipt(v_hand);
  IF TG_TABLE_NAME='rake_records' AND NOT EXISTS(SELECT 1 FROM public.ca_cash_bank_receipts WHERE hand_id=v_hand AND rake_record_id=(to_jsonb(NEW)->>'id')::uuid) THEN
   RAISE EXCEPTION 'Cash bank record is not the acknowledged accepted source';
  END IF;
  IF TG_TABLE_NAME='rake_distribution_legs' AND NOT EXISTS(SELECT 1 FROM public.ca_cash_bank_receipts WHERE hand_id=v_hand AND leg_key=(to_jsonb(NEW)->>'leg_key')::uuid AND leg=to_jsonb(NEW)->>'leg') THEN
   RAISE EXCEPTION 'Cash bank leg is not the acknowledged accepted source';
  END IF;
 END IF;
 RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER ca_cash_bank_record_must_acknowledge AFTER INSERT ON public.rake_records
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_deferred_guard();
CREATE CONSTRAINT TRIGGER ca_cash_bank_leg_must_acknowledge AFTER INSERT ON public.rake_distribution_legs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_deferred_guard();

CREATE FUNCTION public.fn_ca_cash_bank_source_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_hand uuid; v_new_hand uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.cash_bank_version IS DISTINCT FROM OLD.cash_bank_version THEN
  RAISE EXCEPTION 'Cash bank generation is immutable';
 END IF;
 v_hand:=CASE WHEN TG_TABLE_NAME='rake_records' THEN (to_jsonb(OLD)->>'hand_id')::uuid
  ELSE (to_jsonb(OLD)->>'leg_key')::uuid END;
 IF TG_OP='UPDATE' THEN
  v_new_hand:=CASE WHEN TG_TABLE_NAME='rake_records' THEN (to_jsonb(NEW)->>'hand_id')::uuid
   ELSE (to_jsonb(NEW)->>'leg_key')::uuid END;
 END IF;
 IF EXISTS(SELECT 1 FROM public.ca_cash_commission_sources WHERE hand_id IN(v_hand,v_new_hand)
  OR md5('rake:'||table_id::text||':'||hand_number::text)::uuid IN(v_hand,v_new_hand)) THEN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='rake_records'
   AND (to_jsonb(NEW)-'terminal_closed_at')=(to_jsonb(OLD)-'terminal_closed_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Captured cash bank identity is immutable';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER ca_cash_bank_source_immutable BEFORE UPDATE OR DELETE ON public.rake_records
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_source_immutable();
CREATE TRIGGER ca_cash_bank_leg_immutable BEFORE UPDATE OR DELETE ON public.rake_distribution_legs
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_source_immutable();
REVOKE ALL ON FUNCTION public.fn_ca_assert_cash_bank_receipt(uuid),
 public.fn_ca_cash_bank_receipt_guard(),public.fn_ca_cash_bank_deferred_guard(),
 public.fn_ca_cash_bank_source_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_cash_bank_receipt_no_truncate BEFORE TRUNCATE
 ON public.ca_cash_bank_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_bank_receipt_guard();
CREATE FUNCTION public.fn_ca_cash_bank_credit_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.ca_cash_bank_receipts) THEN
   RAISE EXCEPTION 'Acknowledged cash bank credit cannot be truncated';
  END IF;
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM public.ca_cash_bank_receipts b
  WHERE (TG_TABLE_NAME='union_wallet_transactions' AND b.union_wallet_transaction_id=OLD.id)
   OR (TG_TABLE_NAME='chip_ledger' AND b.chip_ledger_id=OLD.id)) THEN
  RAISE EXCEPTION 'Acknowledged cash bank credit is immutable';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER ca_cash_bank_credit_immutable BEFORE UPDATE OR DELETE ON public.union_wallet_transactions
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_credit_immutable();
CREATE TRIGGER ca_cash_bank_credit_immutable BEFORE UPDATE OR DELETE ON public.chip_ledger
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_credit_immutable();
CREATE TRIGGER ca_cash_bank_credit_no_truncate BEFORE TRUNCATE ON public.union_wallet_transactions
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_bank_credit_immutable();
CREATE TRIGGER ca_cash_bank_credit_no_truncate BEFORE TRUNCATE ON public.chip_ledger
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_bank_credit_immutable();
REVOKE ALL ON FUNCTION public.fn_ca_cash_bank_credit_immutable() FROM PUBLIC,anon,authenticated,service_role;
-- Old NULL-hand fallback uses this deterministic key. It cannot bypass the
-- deferred source classification if a complete accepted table/hand source exists.
CREATE UNIQUE INDEX ca_cash_source_legacy_bank_key
 ON public.ca_cash_commission_sources((md5('rake:'||table_id::text||':'||hand_number::text)::uuid));
CREATE CONSTRAINT TRIGGER ca_cash_bank_receipt_is_valid AFTER INSERT ON public.ca_cash_bank_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_deferred_guard();
CREATE FUNCTION public.fn_ca_cash_bank_admission(p_hand uuid,p_table uuid,p_number text) RETURNS void
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('club-arena:cash-bank:'||
  CASE WHEN p_table IS NOT NULL AND p_number IS NOT NULL THEN p_table::text||':'||p_number
   ELSE p_hand::text END,0));
END $f$;
CREATE FUNCTION public.fn_ca_cash_bank_record_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF EXISTS(SELECT 1 FROM public.ca_cash_commission_sources
  WHERE table_id=NEW.table_id AND hand_number::text=NEW.metadata->>'hand_number'
   AND hand_id IS DISTINCT FROM NEW.hand_id) THEN
  RAISE EXCEPTION 'Cash bank record contradicts accepted table and hand identity';
 END IF;
 -- Also executes for ON CONFLICT DO NOTHING and old compiled owner invocations.
 PERFORM public.fn_ca_cash_bank_admission(NEW.hand_id,NEW.table_id,NEW.metadata->>'hand_number');
 RETURN NEW;
END $f$;
CREATE TRIGGER aaa_cash_bank_record_admission BEFORE INSERT ON public.rake_records
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_record_admission();
REVOKE ALL ON FUNCTION public.fn_ca_cash_bank_admission(uuid,uuid,text),
 public.fn_ca_cash_bank_record_admission() FROM PUBLIC,anon,authenticated,service_role;
-- Function-body replacement alone cannot fence an already compiled legacy
-- owner. The actual spendable-leg insertion also enforces original identity.
CREATE FUNCTION public.fn_ca_cash_bank_spendable_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_table uuid; v_number text; v_alias uuid; v_real uuid;
BEGIN
 IF NEW.leg NOT IN ('union_rake','chip_treasury') THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('club-arena:cash-bank-leg:'||NEW.leg_key::text,0));
 SELECT r.table_id,r.metadata->>'hand_number' INTO v_table,v_number
 FROM public.rake_records r WHERE r.hand_id=NEW.leg_key LIMIT 1;
 IF NOT FOUND THEN
  SELECT r.table_id,r.metadata->>'hand_number' INTO v_table,v_number
  FROM public.rake_records r WHERE r.hand_id IS NULL
   AND md5('rake:'||r.table_id::text||':'||(r.metadata->>'hand_number'))::uuid=NEW.leg_key
  ORDER BY r.created_at,r.id LIMIT 1;
 END IF;
 IF v_table IS NOT NULL AND v_number IS NOT NULL THEN
  v_alias:=md5('rake:'||v_table::text||':'||v_number)::uuid;
  SELECT id INTO v_real FROM public.hand_history WHERE table_id=v_table
   AND hand_number::text=v_number ORDER BY created_at DESC LIMIT 1;
 END IF;
 IF EXISTS(SELECT 1 FROM public.rake_distribution_legs l
  WHERE l.leg_key IN(NEW.leg_key,v_alias,v_real) AND l.leg IN ('union_rake','chip_treasury')
   AND (l.leg_key<>NEW.leg_key OR l.leg<>NEW.leg
    OR l.club_id IS DISTINCT FROM NEW.club_id OR l.union_id IS DISTINCT FROM NEW.union_id
    OR l.amount IS DISTINCT FROM NEW.amount)) THEN
  RAISE EXCEPTION 'Cash bank spendable leg conflicts with its original route or identity';
 END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER aaa_cash_bank_spendable_identity BEFORE INSERT ON public.rake_distribution_legs
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_bank_spendable_identity();
REVOKE ALL ON FUNCTION public.fn_ca_cash_bank_spendable_identity() FROM PUBLIC,anon,authenticated,service_role;
