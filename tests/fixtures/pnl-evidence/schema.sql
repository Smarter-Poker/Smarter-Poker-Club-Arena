CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE FUNCTION u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT lpad(n::text,32,'0')::uuid$$;
CREATE FUNCTION ok(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END$$;
CREATE TABLE hand_atomic_commits(table_id uuid,hand_number bigint,hand_id uuid,payload_hash text,stack_result jsonb,committed_at timestamptz,
 post_commit_payload jsonb,post_commit_request_hash text,post_commit_payload_hash text,post_commit_completed_at timestamptz,post_commit_result jsonb,PRIMARY KEY(table_id,hand_number));
CREATE TABLE settlement_idempotency_keys(table_id uuid,hand_id uuid,status text,result jsonb,completed_at timestamptz,PRIMARY KEY(table_id,hand_id));
CREATE TABLE ca_settlements(id uuid PRIMARY KEY,settlement_type text,external_ref text,state text,club_id uuid,union_id uuid,table_id uuid,
 tournament_id uuid,hand_id uuid,idempotency_key text,totals jsonb,created_at timestamptz,updated_at timestamptz);
CREATE TABLE rake_attributions(hand_id uuid,player_id uuid,club_id uuid);
CREATE TABLE union_pnl_settlements(id uuid PRIMARY KEY,union_id uuid,period_start timestamptz,period_end timestamptz,status text,
 total_collected numeric,total_paid numeric,total_unpaid numeric,club_results jsonb,settled_at timestamptz,house_residual numeric);
CREATE TABLE chip_ledger(id uuid PRIMARY KEY,club_id uuid,union_id uuid,category text,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,
 amount numeric,status text,settlement_id text,pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,
 tournament_id uuid,table_id uuid,hand_id uuid,created_at timestamptz);
CREATE TABLE settlement_invoices(id uuid PRIMARY KEY,club_id uuid,source_ledger_id uuid,status text,chips_transferred boolean,message_sent boolean,
 from_entity_type text,from_entity_id text,to_entity_type text,to_entity_id text,gross_amount numeric,net_amount numeric,deductions numeric);
CREATE TABLE tournament_refund_entitlements(id uuid PRIMARY KEY,tournament_id uuid,user_id uuid,entitlement_kind text,charge_category text,
 refund_wallet_club_id uuid,gross numeric,source_ledger_id uuid);
CREATE TABLE tournament_refund_tranches(wallet_transaction_id uuid PRIMARY KEY,entitlement_id uuid,credit_ledger_id uuid,tournament_id uuid,user_id uuid,
 source_wallet_club_id uuid,amount_paid_now numeric,refund_prize numeric,refund_bounty numeric,refund_fee numeric,created_at timestamptz);
-- Poison tables prove that no historical read relies on today's seats,
-- membership, profile.is_horse, or tournament status and play stacks.
CREATE TABLE table_seats(user_id uuid,club_id uuid,stack numeric,joined_at timestamptz);
CREATE TABLE club_members(user_id uuid,club_id uuid);
CREATE TABLE profiles(id uuid,is_horse boolean);
CREATE TABLE tournaments(id uuid,status text);
