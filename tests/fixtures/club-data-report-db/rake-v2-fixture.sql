-- Private native schema dependencies for the existing immutable export door.
ALTER TABLE clubs ADD COLUMN code text, ADD COLUMN avatar_url text, ADD COLUMN logo_url text;
CREATE OR REPLACE FUNCTION fn_like_escape(text) RETURNS text LANGUAGE sql AS $$SELECT replace(replace(replace($1,'\','\\'),'%','\%'),'_','\_')$$;
CREATE OR REPLACE FUNCTION fn_is_club_admin_uid(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
CREATE OR REPLACE FUNCTION ca_can_read_rake_agent(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
CREATE TABLE ca_club_data_exports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,club_id uuid,request_id uuid,kind text,scope_type text,scope_id uuid,union_id uuid,agent_user_id uuid,date_from date,date_to date,request_search text,sort_key text,status text DEFAULT 'preparing',total_rows integer,total_amount numeric,expires_at timestamptz DEFAULT now()+interval '10 minutes',metadata jsonb,metadata_fingerprint text,UNIQUE(user_id),UNIQUE(user_id,request_id));
CREATE TABLE ca_club_data_export_rows(export_id uuid,ordinal integer,payload jsonb,PRIMARY KEY(export_id,ordinal));
CREATE OR REPLACE FUNCTION ca_prune_expired_club_data_exports(integer) RETURNS integer LANGUAGE sql AS $$SELECT 0$$;

-- Other scope branches retain existing production behavior; this fixture
-- exercises union scope and refuses accidental use of these unrelated paths.
CREATE FUNCTION fn_ca_rake_by_downline(uuid,uuid,timestamptz,timestamptz,integer,integer,text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"total":0,"rows":[]}'::jsonb$$;
CREATE FUNCTION fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"total":0,"rows":[]}'::jsonb$$;
