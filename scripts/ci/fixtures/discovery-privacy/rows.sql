ALTER TABLE commander_home_groups ADD PRIMARY KEY(id);
ALTER TABLE commander_home_groups ENABLE ROW LEVEL SECURITY;
-- Same production SELECT policy, including owner/member access to private rows.
CREATE POLICY home_groups_select ON commander_home_groups FOR SELECT TO public USING (
    NOT is_private OR owner_id=auth.uid() OR id IN (SELECT group_id FROM commander_home_members WHERE user_id=auth.uid() AND status='approved')
);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
INSERT INTO commander_home_groups(id,owner_id,name,city,state,is_private,is_active,profile_photo_url,last_activity_at,location_geog,latitude,longitude,member_count,games_hosted)
SELECT ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'20000000-0000-0000-0000-000000000001'::uuid,
       'Fixture '||n,'Chicago','IL',false,true,'photo',now(),point(1,1)::geography,1,1,10,2
FROM generate_series(1,8)n;
INSERT INTO poker_venues(id,name,city,state,lat,lng,is_active,is_suppressed) VALUES (1,'Venue','Chicago','IL',1,1,true,false);
INSERT INTO commander_home_members(group_id,user_id,status,created_at) VALUES ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','approved',now());
