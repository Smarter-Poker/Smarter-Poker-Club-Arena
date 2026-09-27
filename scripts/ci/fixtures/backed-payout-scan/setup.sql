CREATE TABLE public.tournaments (
 id uuid PRIMARY KEY, name text, club_id uuid, prize_pool numeric, ended_at timestamptz,
 status text, variant text, tournament_type text, satellite_target_id uuid,
 fixture_topup numeric DEFAULT 0, fixture_after_delta numeric);
CREATE TABLE public.wallet_transactions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, related_entity_id uuid,
 type text, category text, amount numeric, user_id uuid);
CREATE INDEX ON public.wallet_transactions(related_entity_id,category);
CREATE TABLE public.rake_records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tournament_id uuid,rake_amount numeric,is_tournament boolean,
 created_at timestamptz DEFAULT now(), metadata jsonb DEFAULT '{}');
CREATE INDEX ON public.rake_records(tournament_id);
CREATE INDEX idx_rake_records_club_data_tournament_window ON public.rake_records USING btree (created_at, tournament_id) INCLUDE (rake_amount, metadata) WHERE (is_tournament AND (rake_amount <> (0)::numeric) AND (tournament_id IS NOT NULL));
CREATE TABLE public.chip_ledger(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tournament_id uuid,amount numeric,category text,to_type text);
CREATE INDEX ON public.chip_ledger(tournament_id);
CREATE TABLE public.tournament_guarantee_overlays(tournament_id uuid PRIMARY KEY,amount numeric);
CREATE TABLE public.tournament_conservation_baseline(tournament_id uuid PRIMARY KEY,amount numeric);
CREATE TABLE public.tournament_payouts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tournament_id uuid,user_id uuid,amount numeric,source text,position integer,metadata jsonb);
CREATE INDEX ON public.tournament_payouts(tournament_id,position);
CREATE INDEX ON public.tournament_payouts((metadata->>'satellite_target_id'));
CREATE TABLE public.tournament_satellite_awards(tournament_id uuid,place integer,
 ticket_id uuid,delivery_kind text,PRIMARY KEY(tournament_id,place));
CREATE TABLE public.tournament_tickets(id uuid PRIMARY KEY,status text);
CREATE TABLE public.financial_alerts(severity text,source text,message text,context jsonb,resolved boolean DEFAULT false);
CREATE TABLE public.tournament_payout_backfill_log(tournament_id uuid PRIMARY KEY,top_up numeric,delta_before numeric,delta_after numeric);
CREATE TABLE public.fixture_reconcile_calls(tournament_id uuid,applying boolean);
-- Only the untouched reconciliation dependency is represented by an adapter.
-- Actual scalar delta and the entire old/new caller execute as captured SQL.
CREATE FUNCTION public.fn_tournament_payout_reconcile(p_id uuid,p_apply boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
 SELECT fixture_topup INTO v FROM public.tournaments WHERE id=p_id;
 INSERT INTO public.fixture_reconcile_calls VALUES(p_id,p_apply);
 IF p_apply THEN
  INSERT INTO public.wallet_transactions(related_entity_id,type,category,amount,user_id)
  SELECT id,'credit','prize',fixture_topup,id FROM public.tournaments WHERE id=p_id;
 END IF;
 RETURN jsonb_build_object('total_top_up',v,'total_settled',v);
END $$;
