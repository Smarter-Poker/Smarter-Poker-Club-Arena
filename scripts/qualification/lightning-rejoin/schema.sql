ALTER TABLE tables ADD COLUMN cluster_id uuid, ADD COLUMN lifecycle text DEFAULT 'live', ADD COLUMN is_deleted boolean DEFAULT false;
ALTER TABLE cash_player_session ADD COLUMN cluster_id uuid, ADD COLUMN table_id uuid, ADD COLUMN opened_at timestamptz DEFAULT now();
CREATE TABLE cash_games(id uuid PRIMARY KEY,cluster_mode text,lightning_enabled boolean DEFAULT true,cluster_epoch int DEFAULT 1);
CREATE TABLE lightning_pool_session(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cluster_id uuid,cluster_epoch int,player_id uuid,cash_player_session_id uuid,state text,entered_at timestamptz,starting_stack numeric,anchor_seat_id uuid,exited_at timestamptz);
CREATE UNIQUE INDEX one_open_session ON lightning_pool_session(cluster_id,player_id) WHERE exited_at IS NULL;
CREATE TABLE lightning_pool_slot(id uuid DEFAULT gen_random_uuid(),pool_session_id uuid,cluster_id uuid,cluster_epoch int,player_id uuid,slot int,opened_at timestamptz,closed_at timestamptz,close_reason text,updated_at timestamptz);
CREATE UNIQUE INDEX one_open_slot ON lightning_pool_slot(cluster_id,player_id) WHERE closed_at IS NULL;
CREATE TABLE lightning_reservation(player_id uuid,cluster_id uuid,state text);
CREATE TABLE cash_cluster_events(game_id uuid,table_id uuid,kind text,payload jsonb,cluster_epoch int);
CREATE SCHEMA realtime;
CREATE TABLE realtime.signals(payload jsonb,event text,topic text,private boolean);
CREATE FUNCTION realtime.send(jsonb,text,text,boolean) RETURNS void LANGUAGE sql AS $$INSERT INTO realtime.signals VALUES($1,$2,$3,$4)$$;
-- Synthetic surrounding admission inputs; the pool/slot/cashout owners run verbatim.
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('test.frozen',true),''),'false')::boolean$$;
CREATE FUNCTION fn_lightning_player_in_hand(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(nullif(current_setting('test.hand',true),''),'false')::boolean$$;
CREATE FUNCTION fn_rg_require_not_excluded(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('ok',NOT coalesce(nullif(current_setting('test.excluded',true),''),'false')::boolean)$$;
CREATE FUNCTION fn_lightning_joins_enabled(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE FUNCTION fn_cash_leave_check(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"allowed":true}'::jsonb$$;
INSERT INTO cash_games(id,cluster_mode) VALUES('70000000-0000-4000-8000-000000000001','lightning');
UPDATE tables SET cluster_id='70000000-0000-4000-8000-000000000001' WHERE id='30000000-0000-4000-8000-000000000001';
INSERT INTO cash_player_session(player_id,scope_type,scope_id,cluster_id,table_id,rejoin_window_ms,baseline) VALUES('10000000-0000-4000-8000-000000000002','table','30000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',0,200);

CREATE FUNCTION fn_cash_game_barred_seconds(uuid,uuid) RETURNS integer LANGUAGE sql AS $$SELECT NULL::integer$$;
