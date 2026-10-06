-- Read-only accounting reader fixture; actual maintained functions, no payout stubs.
CREATE TABLE public.ca_supply_snapshots (id bigint PRIMARY KEY, taken_at timestamptz NOT NULL, basis_version text,
member_wallets numeric DEFAULT 0,
member_promo numeric DEFAULT 0,
felt numeric DEFAULT 0,
pending_addons numeric DEFAULT 0,
treasuries numeric DEFAULT 0,
chip_pools numeric DEFAULT 0,
club_promo numeric DEFAULT 0,
club_insurance numeric DEFAULT 0,
club_wallets numeric DEFAULT 0,
union_wallets numeric DEFAULT 0,
agent_wallets numeric DEFAULT 0,
agent_promo numeric DEFAULT 0,
bbj_pools numeric DEFAULT 0,
spin_pools numeric DEFAULT 0,
tournament_liability numeric DEFAULT 0,
leaderboard_liability numeric DEFAULT 0,
ticket_escrow numeric DEFAULT 0,
cashout_escrow numeric DEFAULT 0);
CREATE TABLE public.chip_ledger (from_type text,to_type text,amount numeric,category text,metadata jsonb,actor_service text,db_role text,created_at timestamptz);
INSERT INTO public.ca_supply_snapshots(id,taken_at,basis_version,member_wallets,cashout_escrow)
VALUES(1,'2099-01-01','pending-addon-v4',100,NULL),
      (2,'2099-01-02','cashout-escrow-v5',100,0),
      (3,'2099-01-03','cashout-escrow-v5',76.25,23.75);
INSERT INTO public.chip_ledger VALUES('player_wallet','escrow',23.75,'escrow_hold','{}','fixture','authenticated','2099-01-02 12:00Z');
