CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
ALTER TABLE public.tournaments ADD COLUMN max_players int DEFAULT 3,
  ADD COLUMN buy_in_fee numeric DEFAULT 0, ADD COLUMN starting_chips int DEFAULT 300,
  ADD COLUMN blind_structure text, ADD COLUMN payout_structure text,
  ADD COLUMN spin_locked_tiers jsonb, ADD COLUMN tournament_type text DEFAULT 'SPIN', ADD COLUMN name text;
CREATE TABLE public.spin_payout_ladder(multiplier numeric PRIMARY KEY,structure jsonb);
INSERT INTO public.spin_payout_ladder VALUES (2, '[{"place":1,"percentage":100}]'), (10, '[{"place":1,"percentage":80},{"place":2,"percentage":20}]');
ALTER TABLE public.rake_records ADD COLUMN player_contributions jsonb;
ALTER TABLE public.chip_ledger ADD COLUMN id uuid PRIMARY KEY,
  ADD COLUMN club_id uuid, ADD COLUMN amount numeric, ADD COLUMN tournament_id uuid,
  ADD COLUMN from_entity_id uuid, ADD COLUMN to_type text, ADD COLUMN to_entity_id uuid,
  ADD COLUMN metadata jsonb;
ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_category_check,
  DROP CONSTRAINT chip_ledger_from_type_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check
  CHECK(category IN ('spin_prize','spin_entry','refund','treasury_transfer','tournament_buyin')),
  ADD CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN ('prize_liability','spin_reserve','player_wallet'));
CREATE TABLE public.engine_tournament_leases(tournament_id uuid PRIMARY KEY,
  lease_generation uuid, protocol_version int DEFAULT 2, heartbeat_at timestamptz DEFAULT now());
CREATE TABLE public.tournament_launch_receipts(tournament_id uuid PRIMARY KEY,
  launch_id uuid, lease_generation uuid, completed_at timestamptz);
CREATE TABLE public.tournament_players(id uuid PRIMARY KEY, tournament_id uuid,
  user_id uuid, status text DEFAULT 'registered');
CREATE TABLE public.wallet_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  related_entity_id uuid, user_id uuid, type text, category text, amount numeric);
CREATE TABLE public.tournament_refund_entitlements(id uuid PRIMARY KEY,
  tournament_id uuid, user_id uuid, entitlement_kind text DEFAULT 'wallet_charge',
  charge_category text DEFAULT 'tournament_buyin', refund_wallet_club_id uuid,
  gross numeric, refund_prize numeric, refund_bounty numeric DEFAULT 0, refund_fee numeric DEFAULT 0,
  source_ledger_id uuid, registration_id uuid, source_satellite_id uuid,
  source_ticket_id uuid, escrow_bucket text DEFAULT 'wallet_gross');
CREATE TABLE public.tournament_refund_tranches(tournament_id uuid, user_id uuid,
  entitlement_id uuid, source_wallet_club_id uuid, amount_paid_now numeric,
  refund_prize numeric, refund_bounty numeric, refund_fee numeric);
CREATE TABLE public.tournament_tickets(source_refund_entitlement_id uuid);
CREATE TABLE public.probe_maintenance(frozen boolean NOT NULL);
INSERT INTO public.probe_maintenance VALUES(false);
-- Maintenance and ownership are controlled dependencies in this isolated test.
-- The launch locking helper, previous refund planner and every money function
-- used by the new RPC are the reviewed installed production definitions.
CREATE FUNCTION public.fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS
  $$ SELECT frozen FROM public.probe_maintenance $$;
CREATE FUNCTION public.fn_spin_rake_rate(numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT 0.08::numeric $$;

CREATE FUNCTION public.probe_spin_fixture(p_id uuid, p_pool numeric DEFAULT 10)
RETURNS void LANGUAGE plpgsql AS $fixture$
DECLARE v_user uuid; v_reg uuid; v_ledger uuid;
  v_club uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
BEGIN
  INSERT INTO public.clubs(id) VALUES(v_club) ON CONFLICT DO NOTHING;
  INSERT INTO public.spin_bonus_pools(club_id,balance) VALUES(v_club,p_pool)
    ON CONFLICT(club_id) DO NOTHING;
  INSERT INTO public.tournaments(id,club_id,buy_in_amount) VALUES(p_id,v_club,1);
  INSERT INTO public.engine_tournament_leases(tournament_id,lease_generation)
    VALUES(p_id,p_id);
  INSERT INTO public.tournament_launch_receipts(tournament_id,launch_id,lease_generation)
    VALUES(p_id,p_id,p_id);
  INSERT INTO public.tournament_escrow(tournament_id,gross_in,fee_entries_in) VALUES(p_id,3,0.24);
  FOR i IN 1..3 LOOP
    v_user := gen_random_uuid(); v_reg := gen_random_uuid(); v_ledger := gen_random_uuid();
    INSERT INTO public.tournament_players(id,tournament_id,user_id) VALUES(v_reg,p_id,v_user);
    INSERT INTO public.wallet_transactions(related_entity_id,user_id,type,category,amount)
      VALUES(p_id,v_user,'debit','tournament_buyin',1);
    INSERT INTO public.chip_ledger(id,club_id,amount,tournament_id,from_type,from_entity_id,
      to_type,to_entity_id,category)
      VALUES(v_ledger,v_club,1,p_id,'player_wallet',v_user,'prize_liability',p_id,'tournament_buyin');
    INSERT INTO public.tournament_refund_entitlements(id,tournament_id,user_id,
      refund_wallet_club_id,gross,refund_prize,source_ledger_id,registration_id)
      VALUES(gen_random_uuid(),p_id,v_user,v_club,1,1,v_ledger,v_reg);
  END LOOP;
  -- Registration has already credited this contribution. Pool input includes it.
  INSERT INTO public.spin_reserve_ledger(club_id,tournament_id,kind,amount,seats,buy_in,house_rake)
    VALUES(v_club,p_id,'contribution',2.76,3,1,0.24);
END;
$fixture$;
