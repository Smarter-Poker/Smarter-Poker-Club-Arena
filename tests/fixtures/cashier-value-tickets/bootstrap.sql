CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.actor',true),'')::uuid$$;
CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean);
CREATE TABLE club_members(club_id uuid,user_id uuid,chip_balance numeric,role text,status text,agent_id uuid,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE union_clubs(union_id uuid,club_id uuid);
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,buy_in_amount numeric,buy_in_fee numeric,bounty_amount numeric,is_bounty boolean,is_pko boolean,is_mystery_bounty boolean,asset text DEFAULT 'chips',status text DEFAULT 'REGISTERING');
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,issued_by uuid,holder_id uuid,value numeric,note text,status text DEFAULT 'issued',redemption_mode text DEFAULT 'wallet_chips',source_tournament_id uuid,source_refund_entitlement_id uuid,source_satellite_id uuid,created_at timestamptz DEFAULT now(),redeemed_at timestamptz);
CREATE TABLE tournament_ticket_entry_targets(ticket_id uuid PRIMARY KEY,tournament_id uuid,club_id uuid,issued_by uuid,holder_id uuid,value numeric,entry_prize numeric,entry_bounty numeric,entry_fee numeric);
CREATE TABLE chip_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,balance_after numeric,metadata jsonb);
CREATE TABLE wallet_transactions(user_id uuid,wallet_type text,type text,amount numeric,category text,description text,balance_after numeric);
CREATE TABLE tournament_players(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tournament_id uuid,user_id uuid,registered_at timestamptz DEFAULT now(),UNIQUE(tournament_id,user_id));
CREATE TABLE entry_receipts(tournament_id uuid,user_id uuid,charge numeric,prize numeric,bounty numeric,rake numeric);
-- Explicit unchanged dependency boundaries: this harness qualifies the real
-- issuer, selector, routing, ticket-row locks and outer atomic redemption.
-- It does not certify gameplay, seat allocation or the full admission closure.
CREATE FUNCTION fn_club_cashier_can_transact(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid) RETURNS void LANGUAGE sql AS $$SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))$$;
CREATE FUNCTION fn_ca_lock_mtt_admission_contract() RETURNS void LANGUAGE sql AS $$SELECT pg_advisory_xact_lock_shared(530090,1)$$;
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.frozen',true),'')='true'$$;
CREATE FUNCTION fn_ca_tournament_unit_cents(uuid) RETURNS integer LANGUAGE sql AS $$SELECT CASE WHEN asset='diamonds' THEN 100 ELSE 1 END FROM tournaments WHERE id=$1$$;
CREATE FUNCTION fn_tournament_entry_split(numeric,numeric,numeric,boolean) RETURNS TABLE(charge numeric,prize numeric,bounty numeric,rake numeric) LANGUAGE sql AS $$SELECT $1+$2,$1-CASE WHEN $4 THEN coalesce($3,0) ELSE 0 END,CASE WHEN $4 THEN coalesce($3,0) ELSE 0 END,$2$$;
CREATE FUNCTION fn_tournament_club_for_user(uuid,uuid,uuid) RETURNS uuid LANGUAGE sql AS $$SELECT $3 FROM tournaments t WHERE t.id=$2 AND (t.club_id=$3 OR EXISTS(SELECT 1 FROM union_clubs uc WHERE uc.union_id=t.union_id AND uc.club_id=$3)) AND EXISTS(SELECT 1 FROM club_members m WHERE m.club_id=$3 AND m.user_id=$1 AND m.status IN ('active','approved'))$$;
CREATE FUNCTION fn_register_for_tournament_before_terminal_seat_gate(tid uuid,unused boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t tournaments;sp record;rid uuid;
BEGIN
 SELECT * INTO t FROM tournaments WHERE id=tid;
 IF t.status<>'REGISTERING' THEN RETURN jsonb_build_object('ok',false,'reason','registration_closed'); END IF;
 SELECT * INTO sp FROM fn_tournament_entry_split(t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty OR t.is_pko OR t.is_mystery_bounty);
 UPDATE club_members SET chip_balance=chip_balance-sp.charge WHERE user_id=auth.uid() AND club_id=nullif(split_part(current_setting('app.ca_entry_paying_club'),':',3),'')::uuid AND chip_balance>=sp.charge;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','insufficient_balance'); END IF;
 INSERT INTO tournament_players(tournament_id,user_id) VALUES(tid,auth.uid()) RETURNING id INTO rid;
 INSERT INTO entry_receipts VALUES(tid,auth.uid(),sp.charge,sp.prize,sp.bounty,sp.rake);
 RETURN jsonb_build_object('ok',true,'registration_id',rid,'cost',sp.charge);
END$$;
CREATE FUNCTION fn_register_horse_for_tournament_before_atomic_lifecycle_gate(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT fn_register_for_tournament_before_terminal_seat_gate($1,false)$$;
CREATE FUNCTION fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('ok',false,'reason','satellite_boundary')$$;
