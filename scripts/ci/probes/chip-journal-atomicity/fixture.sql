
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
CREATE TABLE chip_ledger(id uuid DEFAULT gen_random_uuid(), performed_by uuid,from_type text,from_entity_id uuid,from_label text,to_type text,to_entity_id uuid,to_label text,amount numeric CHECK(amount>0),category text,club_id uuid,union_id uuid,table_id uuid,hand_id uuid,tournament_id uuid,description text,pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,idempotency_key text UNIQUE,metadata jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE ca_ledger_write_failures(club_id uuid,user_id uuid,delta numeric,sqlstate text,message text);
CREATE TABLE clubs(id uuid PRIMARY KEY,name text,union_id uuid,chip_treasury numeric DEFAULT 100,total_rake numeric DEFAULT 0,updated_at timestamptz);
CREATE TABLE bbj_pools(id uuid PRIMARY KEY,club_id uuid,main_balance numeric DEFAULT 100,backup_balance numeric DEFAULT 10,promo_balance numeric DEFAULT 5);
CREATE TABLE club_members(id uuid PRIMARY KEY,user_id uuid,club_id uuid,chip_balance numeric DEFAULT 100);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,min_buy_in numeric,max_buy_in numeric,is_private boolean DEFAULT true,union_id uuid,tournament_id uuid,is_template boolean DEFAULT false);
CREATE TABLE table_seats(table_id uuid,user_id uuid,seat_number int,stack numeric,is_sitting_out boolean,left_at timestamptz,UNIQUE(table_id,user_id),UNIQUE(table_id,seat_number));
CREATE TABLE chip_transactions(id uuid,club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,balance_after numeric,created_at timestamptz);
CREATE TABLE cash_baselines(user_id uuid,table_id uuid,amount numeric);
CREATE TABLE engine_maintenance_break(
 id boolean PRIMARY KEY DEFAULT true,
 phase text NOT NULL,
 announced_at timestamptz NOT NULL,
 break_ends_at timestamptz,
 enforce_freeze boolean NOT NULL DEFAULT true
);
CREATE TABLE entry_purchase_idempotency_receipts(
 key_domain text NOT NULL,
 idempotency_key text NOT NULL,
 request jsonb NOT NULL,
 response jsonb,
 claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 completed_at timestamptz,
 CONSTRAINT entry_purchase_idempotency_receipts_pkey
  PRIMARY KEY(key_domain,idempotency_key),
 CONSTRAINT entry_purchase_idempotency_receipts_domain_nonempty
  CHECK (length(btrim(key_domain)) > 0),
 CONSTRAINT entry_purchase_idempotency_receipts_key_nonempty
  CHECK (length(btrim(idempotency_key)) > 0)
);
CREATE FUNCTION fn_actor_can_manage_club_treasury(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_cash_rejoin_floor(uuid,uuid) RETURNS numeric LANGUAGE sql AS 'SELECT NULL::numeric';
CREATE FUNCTION fn_cash_session_open(uuid,uuid,numeric) RETURNS void LANGUAGE sql AS 'INSERT INTO cash_baselines VALUES($1,$2,$3)';
CREATE FUNCTION fn_cash_session_add_baseline(uuid,uuid,numeric) RETURNS void LANGUAGE sql AS 'INSERT INTO cash_baselines VALUES($1,$2,$3)';
CREATE TABLE hand_history(id uuid,table_id uuid,hand_number int,created_at timestamptz);
CREATE TABLE tournaments(id uuid,is_private boolean,union_id uuid);
CREATE TABLE rake_records(id uuid DEFAULT gen_random_uuid(),hand_id uuid,table_id uuid,club_id uuid,rake_amount numeric,bbj_contribution numeric,pot_size numeric,num_players int,player_contributions jsonb,is_tournament boolean,tournament_id uuid,source text,metadata jsonb,rake_method text,returned_uncalled jsonb,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX rake_hand ON rake_records(hand_id) WHERE hand_id IS NOT NULL;
CREATE TABLE rake_distribution_legs(leg_key uuid,leg text,club_id uuid,union_id uuid,amount numeric,UNIQUE(leg_key,leg));
CREATE TABLE club_wallets(club_id uuid PRIMARY KEY,chip_balance numeric DEFAULT 0,period_rake_collected numeric DEFAULT 0,period_bbj_contribution numeric DEFAULT 0,lifetime_rake_collected numeric DEFAULT 0,lifetime_bbj_contribution numeric DEFAULT 0,updated_at timestamptz);
CREATE TABLE club_wallet_transactions(club_id uuid,type text,amount numeric,balance_after numeric,related_id uuid,reason text);
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY,chip_balance numeric,rake_wallet numeric,total_rake_collected numeric,updated_at timestamptz);
CREATE TABLE union_wallet_transactions(union_id uuid,club_id uuid,amount numeric,tx_type text,wallet text,direction text,balance_after numeric,notes text);
CREATE FUNCTION injected_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fault text:=current_setting('test.journal_sqlstate',true);
BEGIN
 IF COALESCE(fault,'')<>'' THEN RAISE EXCEPTION 'injected journal failure' USING ERRCODE=fault; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fault BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION injected_journal_failure();
