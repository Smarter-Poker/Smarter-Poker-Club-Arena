CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE profiles(id uuid PRIMARY KEY,diamonds numeric,is_horse boolean);
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
CREATE TABLE ca_cert_accounts(user_id uuid,active boolean,tagged_at timestamptz);
CREATE TABLE diamond_wallets(user_id uuid,balance numeric);
CREATE TABLE user_diamonds(user_id uuid,balance numeric);
CREATE TABLE user_diamond_balance(user_id uuid,balance numeric);
CREATE TABLE ca_mint_ledger(holder_id uuid,asset text,holder_type text,action text,amount numeric,payload text);
CREATE TABLE ca_diamond_house(id integer,balance numeric);
CREATE TABLE ca_diamond_house_ledger(delta numeric);
CREATE TABLE poker_diamond_custody(user_id uuid,balance numeric);
CREATE TABLE diamond_spin_days(owner_id uuid,status text,pending_diamonds numeric);
CREATE TABLE diamond_transactions(user_id uuid,created_at timestamptz,amount numeric);
CREATE TABLE ca_diamond_snapshots(id uuid DEFAULT gen_random_uuid(),taken_at timestamptz DEFAULT clock_timestamp(),
 arena_diamonds numeric,profile_diamonds numeric,wallet_diamonds numeric,cert_diamonds numeric,total numeric,
 journaled_delta numeric,delta_vs_prev numeric,unexplained numeric,register_supply numeric,house_balance numeric,
 fixture_diamonds numeric,register_fixture numeric,arena_fixture_diamonds numeric,house_register numeric,house_ledger_total numeric);
CREATE TABLE observations(kind text,detail jsonb);
-- External collaborator boundary: the meter sums both original custody rails.
CREATE FUNCTION fn_ca_arena_diamonds() RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT sum(balance) FROM poker_diamond_custody),0)+coalesce((SELECT sum(pending_diamonds) FROM diamond_spin_days WHERE status='open'),0)
$$;
CREATE FUNCTION fn_ca_diamond_incident(p_rule text,p_severity text,p_user_id uuid,p_amount numeric,p_writer text,p_detail jsonb)
RETURNS void LANGUAGE sql AS $$ INSERT INTO observations VALUES(p_rule,jsonb_build_object('amount',p_amount,'detail',p_detail)) $$;
CREATE FUNCTION fn_ca_raise_drift_incident(p_source text,p_classification text,p_severity text,p_dedupe_key text,
 p_discrepancy numeric,p_expected numeric,p_actual numeric,p_layer text,p_entity_type text,p_entity_id uuid,p_club_id uuid,
 p_union_id uuid,p_table_id uuid,p_tournament_id uuid,p_hand_id uuid,p_settlement_id text,p_wallet_ids uuid[],
 p_transaction_ids uuid[],p_suspected_cause text,p_ledger_balanced boolean,p_metadata jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO observations VALUES(p_classification,jsonb_build_object('discrepancy',p_discrepancy,'expected',p_expected,'actual',p_actual,'metadata',p_metadata));
 RETURN gen_random_uuid(); END $$;

INSERT INTO profiles SELECT md5(g::text)::uuid,g*10,g IN(3,4) FROM generate_series(1,8)g;
INSERT INTO profiles VALUES('00000000-0000-0000-0000-000000000001',12,false),('00000000-0000-0000-0000-000000000002',15,true);
INSERT INTO auth.users SELECT md5(g::text)::uuid,
 CASE WHEN g IN(2,3)THEN 'test.invalid' WHEN g IN(4,5)THEN 'a@horses.smarter.poker' ELSE 'person@real.example' END
 FROM generate_series(1,8)g;
INSERT INTO ca_cert_accounts VALUES(md5('6')::uuid,true,now()-interval '1 day'),(md5('7')::uuid,false,now()-interval '1 day');
-- Missing profiles and duplicate active certification records retain the
-- original EXISTS semantics. NULL identities classify false.
INSERT INTO ca_cert_accounts VALUES(md5('6')::uuid,true,now()-interval '1 day'),(md5('absent')::uuid,true,now()-interval '1 day');
INSERT INTO diamond_wallets SELECT id,diamonds FROM profiles;
INSERT INTO user_diamonds SELECT id,diamonds FROM profiles;
INSERT INTO user_diamond_balance SELECT id,diamonds FROM profiles;
INSERT INTO ca_mint_ledger(holder_id,asset,holder_type,action,amount) SELECT id,'diamonds','player','mint',diamonds FROM profiles;
INSERT INTO ca_mint_ledger(holder_id,asset,holder_type,action,amount) VALUES(md5('absent')::uuid,'diamonds','player','mint',20),(NULL,'diamonds','player','mint',3),
 (md5('house')::uuid,'diamonds','house','mint',100),(md5('house')::uuid,'diamonds','house','burn',10);
INSERT INTO ca_diamond_house VALUES(1,90);
INSERT INTO ca_diamond_house_ledger VALUES(90);
INSERT INTO ca_mint_ledger SELECT md5('1')::uuid,'diamonds','player','mint',1,repeat(md5(g::text),32) FROM generate_series(1,50000)g;
INSERT INTO poker_diamond_custody SELECT id,1 FROM profiles CROSS JOIN generate_series(1,2000);
INSERT INTO poker_diamond_custody VALUES(md5('absent')::uuid,5),(NULL,7);
INSERT INTO diamond_spin_days VALUES(md5('absent')::uuid,'open',8),(md5('2')::uuid,'closed',100);
ANALYZE;
