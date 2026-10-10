CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE profiles(id uuid PRIMARY KEY,status text,username text);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,chip_balance numeric,held_chips numeric DEFAULT 0,locked_chips numeric DEFAULT 0,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE agents(club_id uuid,user_id uuid,status text,agent_wallet_balance numeric,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,asset text,lifecycle_status text,chip_treasury numeric,updated_at timestamptz);
CREATE TABLE ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text);
CREATE TABLE chip_transactions(club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,metadata jsonb,balance_after numeric);
CREATE TABLE movement_witness(source text,amount numeric,counterparty text,operation text);
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('fixture.frozen',true)='1' $$;
CREATE FUNCTION fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('app.ledger_category',$1,true);
 PERFORM set_config('app.ledger_counterparty',$2,true);
 PERFORM set_config('app.ledger_counterparty_entity',$3::text,true);
 PERFORM set_config('app.ledger_idempotency_key',$5,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);
END $$;
CREATE FUNCTION fixture_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO movement_witness VALUES(TG_TABLE_NAME,
 CASE WHEN TG_TABLE_NAME='club_members' THEN (to_jsonb(NEW)->>'chip_balance')::numeric-(to_jsonb(OLD)->>'chip_balance')::numeric
 ELSE (to_jsonb(NEW)->>'agent_wallet_balance')::numeric-(to_jsonb(OLD)->>'agent_wallet_balance')::numeric END,
 current_setting('app.ledger_counterparty',true),current_setting('app.ledger_idempotency_key',true));
 RETURN NEW;
END $$;
CREATE TRIGGER trg_source_journal AFTER UPDATE OF chip_balance ON club_members FOR EACH ROW EXECUTE FUNCTION fixture_journal();
CREATE TRIGGER trg_source_journal AFTER UPDATE OF agent_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION fixture_journal();
CREATE OR REPLACE FUNCTION public.fn_cashier_member_is_active(p_club uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.club_members m
     WHERE m.club_id = p_club
       AND m.user_id = p_user
       AND coalesce(m.status, 'active') IN ('active', 'approved')
       AND (
         coalesce(m.role, 'player') NOT IN ('super_agent', 'agent', 'sub_agent')
         OR EXISTS (
           SELECT 1
             FROM public.agents a
            WHERE a.club_id = m.club_id
              AND a.user_id = m.user_id
              AND a.status = 'active'
         )
       )
  )
$function$;

INSERT INTO profiles VALUES('00000000-0000-0000-0000-000000000001','active','deleted-active-name'),
 ('00000000-0000-0000-0000-000000000002','deleted','retired'),
 ('00000000-0000-0000-0000-000000000003','active','closing');
INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','chips','active',1000,now());
INSERT INTO club_members(club_id,user_id,role,status,chip_balance) VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','owner','approved',30),
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','player','approved',75),
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','player','approved',10);
INSERT INTO agents VALUES('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','active',25,now());
