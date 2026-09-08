
CREATE TABLE unions(id uuid PRIMARY KEY);
CREATE TABLE settlement_locks(lock_type text,is_active boolean);
CREATE TABLE union_settlement_floor(union_id uuid PRIMARY KEY,earliest_period_start timestamptz);
CREATE TABLE union_rakeback_log(union_id uuid,period_start timestamptz,period_end timestamptz,total_rakeback numeric,executed_at timestamptz,UNIQUE(union_id,period_start,period_end));
CREATE TABLE ca_settlements(id uuid DEFAULT gen_random_uuid(),settlement_type text,external_ref text,state text,
 union_id uuid,totals jsonb,error_detail text,UNIQUE(settlement_type,external_ref));
ALTER TABLE union_wallets ADD COLUMN total_settlements numeric DEFAULT 0;
ALTER TABLE union_wallet_transactions ADD COLUMN id uuid DEFAULT gen_random_uuid(), ADD COLUMN created_at timestamptz;
ALTER TABLE tournaments ADD COLUMN tournament_type text;
CREATE FUNCTION fn_union_week_start(p_at timestamptz DEFAULT now()) RETURNS timestamptz
 LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',p_at AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
-- The zero-rake fixture exercises boundary admission; attribution is audited separately.
CREATE FUNCTION fn_union_club_rake_basis(uuid,timestamptz,timestamptz,boolean)
 RETURNS TABLE(club_id uuid,game_type text,rake_in numeric,rate numeric,payout numeric)
 LANGUAGE sql AS $$SELECT null::uuid,null::text,0::numeric,0::numeric,0::numeric WHERE false$$;
