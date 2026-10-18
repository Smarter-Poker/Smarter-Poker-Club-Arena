CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
CREATE TABLE unions(id uuid PRIMARY KEY,name text,owner_id uuid);
CREATE TABLE clubs(id uuid PRIMARY KEY,name text,code text,slug text);
CREATE TABLE union_clubs(union_id uuid,club_id uuid);
CREATE TABLE settlement_invoices(id uuid PRIMARY KEY,club_id uuid,invoice_type text,status text,net_amount numeric,breakdown jsonb,created_at timestamptz,due_at timestamptz,message_sent boolean);
CREATE FUNCTION ca_can_oversee_union(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM unions WHERE id=$1 AND owner_id=auth.uid()) $$;
INSERT INTO unions VALUES('00000000-0000-4000-8000-000000000001','Union','00000000-0000-4000-8000-000000000002');
INSERT INTO clubs VALUES('00000000-0000-4000-8000-000000000003','Legacy Club','123','legacy'),('00000000-0000-4000-8000-000000000004','Current Club','456','current');
INSERT INTO union_clubs SELECT '00000000-0000-4000-8000-000000000001'::uuid,id FROM clubs;
INSERT INTO settlement_invoices SELECT id,id,'union_weekly_squareup',CASE WHEN code='123' THEN 'paid' ELSE 'generated' END,100,
 jsonb_build_object('union_id','00000000-0000-4000-8000-000000000001','period_start','2026-10-05','period_end','2026-10-12','direction','club owes union','rake_generated',200,'rakeback_due',180,'union_fee_kept',20)||CASE WHEN code='456' THEN jsonb_build_object('paid_total',25) ELSE '{}'::jsonb END,now(),now()+interval '1 day',true FROM clubs;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000002',false);
CREATE TABLE original_invoice_snapshot AS SELECT md5(string_agg(to_jsonb(i)::text,',' ORDER BY id)) hash FROM settlement_invoices i;
