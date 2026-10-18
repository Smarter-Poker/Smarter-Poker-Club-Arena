INSERT INTO clubs(id,name,code,slug,owner_id)
 SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'Concurrent '||g,g::text,'concurrent-'||g,'00000000-0000-4000-8000-000000000002'
 FROM generate_series(7,8) g;
INSERT INTO club_members SELECT id,'00000000-0000-4000-8000-000000000002','owner' FROM clubs WHERE code IN ('7','8');
INSERT INTO tables SELECT id,id,name FROM clubs WHERE code IN ('7','8');
INSERT INTO hand_history SELECT id,id,'{"trigger_reason":"interval","board_count":2,"variant":"plo4","ante_amount":1}',
 (((now() AT TIME ZONE 'UTC')::date-2)::timestamp AT TIME ZONE 'UTC')+interval '1 hour',20,1,'[{},{}]'
 FROM tables WHERE club_id IN ('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000008');
