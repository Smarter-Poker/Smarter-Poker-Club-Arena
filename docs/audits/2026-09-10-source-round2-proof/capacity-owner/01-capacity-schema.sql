-- Prospective capacity candidate. Requires actual accepted/bank source stages.
-- Source windows describe provenance; compatible carry pools span those windows.
CREATE TABLE public.ca_source_funding_pools (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid NOT NULL,
 funding_union_id uuid,funding_route text NOT NULL,contract_version integer NOT NULL CHECK(contract_version=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((funding_route='union_rake_wallet' AND funding_union_id IS NOT NULL)
  OR (funding_route='club_chip_treasury' AND funding_union_id IS NULL)),
 UNIQUE NULLS NOT DISTINCT(club_id,funding_union_id,funding_route,contract_version)
);
CREATE INDEX ca_source_funding_pool_original_union ON public.ca_source_funding_pools(funding_union_id,club_id,id);
CREATE TABLE public.ca_source_funding_lots (
 hand_id uuid NOT NULL REFERENCES public.ca_cash_bank_receipts(hand_id),contributor_id uuid NOT NULL,
 pool_id uuid NOT NULL REFERENCES public.ca_source_funding_pools(id),
 accepted_payload_hash text NOT NULL,earning_week date NOT NULL,
 bank_period_start timestamptz NOT NULL,bank_period_end timestamptz NOT NULL,
 rake_credit numeric NOT NULL,captured_club_rate numeric NOT NULL,
 exact_club_entitlement numeric NOT NULL,exact_hierarchy_entitlement numeric,
 contract_state text NOT NULL CHECK(contract_state IN ('eligible','overpromised','terms_unresolved')),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(hand_id,contributor_id),
 FOREIGN KEY(hand_id,contributor_id) REFERENCES public.ca_cash_commission_facts(hand_id,player_id),
 CHECK(rake_credit>=0 AND rake_credit=round(rake_credit,2) AND rake_credit::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(captured_club_rate BETWEEN 0 AND 1 AND captured_club_rate::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(exact_club_entitlement=rake_credit*captured_club_rate),
 CHECK(exact_hierarchy_entitlement IS NULL OR (exact_hierarchy_entitlement>=0 AND exact_hierarchy_entitlement::text NOT IN ('NaN','Infinity','-Infinity'))),
 CHECK(contract_state<>'eligible' OR (exact_hierarchy_entitlement IS NOT NULL AND exact_hierarchy_entitlement<=exact_club_entitlement)),
 CHECK(extract(isodow FROM earning_week)=1),
 CHECK(isfinite(bank_period_start) AND isfinite(bank_period_end) AND bank_period_end>bank_period_start)
);
CREATE INDEX ca_source_funding_lot_pool ON public.ca_source_funding_lots(pool_id,hand_id,contributor_id);
CREATE TABLE public.ca_source_recipient_accruals (
 hand_id uuid NOT NULL,contributor_id uuid NOT NULL,agent_id uuid NOT NULL,
 pool_id uuid NOT NULL REFERENCES public.ca_source_funding_pools(id),recipient_id uuid NOT NULL,
 earning_week date NOT NULL,contract_rate numeric NOT NULL,downline_rate numeric NOT NULL,
 exact_entitlement numeric NOT NULL,is_direct_payer boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(hand_id,contributor_id,agent_id),
 FOREIGN KEY(hand_id,contributor_id) REFERENCES public.ca_source_funding_lots(hand_id,contributor_id),
 CHECK(contract_rate BETWEEN 0 AND .70 AND downline_rate BETWEEN 0 AND contract_rate),
 CHECK(exact_entitlement>=0 AND exact_entitlement::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE INDEX ca_source_recipient_accrual_discovery ON public.ca_source_recipient_accruals(recipient_id,pool_id,earning_week,hand_id);
CREATE TABLE public.ca_source_club_funding_admissions (
 admission_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 hand_id uuid NOT NULL,contributor_id uuid NOT NULL,
 pool_id uuid NOT NULL REFERENCES public.ca_source_funding_pools(id),bank_closed_through timestamptz NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(hand_id,contributor_id),
 FOREIGN KEY(hand_id,contributor_id) REFERENCES public.ca_source_funding_lots(hand_id,contributor_id),
 CHECK(isfinite(bank_closed_through))
);
CREATE INDEX ca_source_club_admission_pool ON public.ca_source_club_funding_admissions(pool_id,admission_seq,hand_id,contributor_id);
CREATE TABLE public.ca_source_recipient_funding_admissions (
 admission_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 hand_id uuid NOT NULL,contributor_id uuid NOT NULL,agent_id uuid NOT NULL,
 pool_id uuid NOT NULL REFERENCES public.ca_source_funding_pools(id),recipient_id uuid NOT NULL,
 earning_closed_through date NOT NULL,admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(hand_id,contributor_id,agent_id),
 FOREIGN KEY(hand_id,contributor_id,agent_id) REFERENCES public.ca_source_recipient_accruals(hand_id,contributor_id,agent_id),
 FOREIGN KEY(hand_id,contributor_id) REFERENCES public.ca_source_club_funding_admissions(hand_id,contributor_id),
 CHECK(extract(isodow FROM earning_closed_through)=1)
);
CREATE INDEX ca_source_recipient_admission_pool ON public.ca_source_recipient_funding_admissions(pool_id,recipient_id,admission_seq,hand_id);
CREATE TABLE public.ca_source_club_cash_releases (
 release_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,admission_seq_high_water bigint NOT NULL,
 id uuid PRIMARY KEY,pool_id uuid NOT NULL REFERENCES public.ca_source_funding_pools(id),
 bank_closed_through timestamptz NOT NULL,
 amount numeric NOT NULL,cumulative_exact numeric NOT NULL,cumulative_released numeric NOT NULL,
 source_digest text NOT NULL,release_kind text NOT NULL CHECK(release_kind IN ('union_to_club','bank_direct')),
 ledger_id uuid NOT NULL UNIQUE REFERENCES public.chip_ledger(id),
 treasury_transaction_id uuid UNIQUE REFERENCES public.chip_transactions(id),
 union_debit_transaction_id uuid UNIQUE REFERENCES public.union_wallet_transactions(id),
 bank_receipt_hand_id uuid UNIQUE REFERENCES public.ca_cash_bank_receipts(hand_id),
 released_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(amount>0 AND amount=round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(cumulative_exact>=0 AND cumulative_exact::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(cumulative_released<=floor(cumulative_exact*100)/100 AND cumulative_released>=amount),
 CHECK((release_kind='union_to_club' AND treasury_transaction_id IS NOT NULL AND union_debit_transaction_id IS NOT NULL AND bank_receipt_hand_id IS NULL)
  OR (release_kind='bank_direct' AND treasury_transaction_id IS NULL AND union_debit_transaction_id IS NULL AND bank_receipt_hand_id IS NOT NULL))
);
CREATE INDEX ca_source_club_release_pool ON public.ca_source_club_cash_releases(pool_id,released_at,id);
-- These slices attribute released cash against original exact club liabilities.
-- They do not assign separate nonfungible cash wallets to each source.
CREATE TABLE public.ca_source_club_release_slices (
 release_id uuid NOT NULL REFERENCES public.ca_source_club_cash_releases(id),
 hand_id uuid NOT NULL,contributor_id uuid NOT NULL,amount numeric NOT NULL,
 PRIMARY KEY(release_id,hand_id,contributor_id),
 FOREIGN KEY(hand_id,contributor_id) REFERENCES public.ca_source_funding_lots(hand_id,contributor_id),
 CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE TABLE public.ca_source_agent_cash_payments (
 payment_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,admission_seq_high_water bigint NOT NULL,source_digest text NOT NULL,
 id uuid PRIMARY KEY,club_id uuid NOT NULL,recipient_id uuid NOT NULL,
 pool_id uuid NOT NULL REFERENCES public.ca_source_funding_pools(id),earning_closed_through date NOT NULL,
 amount numeric NOT NULL,cumulative_exact numeric NOT NULL,cumulative_paid numeric NOT NULL,
 treasury_transaction_id uuid NOT NULL UNIQUE REFERENCES public.chip_transactions(id),
 wallet_transaction_id uuid NOT NULL UNIQUE REFERENCES public.wallet_transactions(id),
 ledger_id uuid NOT NULL UNIQUE REFERENCES public.chip_ledger(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(amount>0 AND amount=round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(cumulative_exact>=0 AND cumulative_exact::text NOT IN ('NaN','Infinity','-Infinity')),
 CHECK(cumulative_paid>=amount AND cumulative_paid<=floor(cumulative_exact*100)/100)
);
CREATE INDEX ca_source_agent_cash_recipient ON public.ca_source_agent_cash_payments(pool_id,recipient_id,created_at,id);
CREATE TABLE public.ca_source_agent_payment_slices (
 payment_id uuid NOT NULL REFERENCES public.ca_source_agent_cash_payments(id),
 hand_id uuid NOT NULL,contributor_id uuid NOT NULL,agent_id uuid NOT NULL,amount numeric NOT NULL,
 PRIMARY KEY(payment_id,hand_id,contributor_id,agent_id),
 FOREIGN KEY(hand_id,contributor_id,agent_id) REFERENCES public.ca_source_recipient_accruals(hand_id,contributor_id,agent_id),
 CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE TABLE public.ca_source_club_cash_consumptions (
 payment_id uuid NOT NULL REFERENCES public.ca_source_agent_cash_payments(id),
 release_id uuid NOT NULL REFERENCES public.ca_source_club_cash_releases(id),amount numeric NOT NULL,
 PRIMARY KEY(payment_id,release_id),
 CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE INDEX ca_source_club_cash_consumption_release ON public.ca_source_club_cash_consumptions(release_id,payment_id);
-- Recipient source admission above may grow even when no new cash cent is due.
-- Player bridge must bind it AND the matching pool's actual agent cash capacity.
-- It must not treat a fixed gross-payment source slice as a separate source wallet.

CREATE FUNCTION public.fn_ca_source_capacity_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
BEGIN RAISE EXCEPTION 'Source capacity evidence is immutable' USING ERRCODE='55000'; END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_source_capacity_immutable() FROM PUBLIC,anon,authenticated,service_role;
DO $acl$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['ca_source_funding_pools','ca_source_funding_lots','ca_source_recipient_accruals',
  'ca_source_club_funding_admissions','ca_source_recipient_funding_admissions','ca_source_club_cash_releases',
  'ca_source_club_release_slices','ca_source_agent_cash_payments','ca_source_agent_payment_slices',
  'ca_source_club_cash_consumptions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
  EXECUTE format('CREATE TRIGGER ca_source_capacity_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_ca_source_capacity_immutable()',t);
  EXECUTE format('CREATE TRIGGER ca_source_capacity_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_source_capacity_immutable()',t);
 END LOOP;
END $acl$;
