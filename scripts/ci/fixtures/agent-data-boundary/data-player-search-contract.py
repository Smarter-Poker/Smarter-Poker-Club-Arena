# Runs inside the existing real-role agent boundary cluster after its unchanged
# hierarchy qualification. The original roster authority is used, not a mock.
search_migration = next((ROOT/'supabase/migrations').glob('*_club_data_player_search_matches_player_identities_before_its.sql')).read_text()
# Install the maintained Data scope authority and old paged reader as baselines.
import re
scope_source=(ROOT/'supabase/migrations/20261021202610_club_data_totals_use_exact_game_types_and_union_scope.sql').read_text()
scope_definition=re.search(r'CREATE OR REPLACE FUNCTION public.fn_ca_club_data_scope\(.*?\$function\$;',scope_source,re.S).group(0)
q('CREATE TABLE IF NOT EXISTS unions(id uuid PRIMARY KEY); CREATE OR REPLACE FUNCTION ca_can_oversee_union(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;'+scope_definition)
q((ROOT/'tests/fixtures/stats-club-scope/roster-join-sort/page-before.sql').read_text())
for n,name in [(1,'KingFish'),(2,'WooWoo'),(3,'Quinn'),(4,'Nine'),(5,'Emo'),(6,'Sibling'),(7,'Other'),(8,'Private')]:
 q(f"INSERT INTO profiles(id,username,alias,display_name,player_number) VALUES('{uid(n)}','{name.lower()}','{name}','Hidden Legal {n}','{n}');")
for n in range(20,50):
 q(f"INSERT INTO profiles(id,username,alias,player_number) VALUES('{uid(n)}','aaaa{n}','AAAA{n}','{n}'); INSERT INTO club_members(club_id,user_id,role,status,agent_id) VALUES('{club}','{uid(n)}','player','active','{uid(1)}');")
# >20 other players match only KingFish's upline name: reproduce the live bug.
old=json.loads(q(as_user(1,f"SELECT ca_club_members_page('{club}','KingFish','all','name',NULL,20);")))
assert old['has_more'] and len(old['items'])==20
assert not any(row['user_id']==uid(1) for row in old['items']),old
q(as_user(1,f"SELECT ca_club_data_player_search('{club}','KingFish',20);"),'does not exist')
# Rollback leaves the function absent; apply once, no production access.
q(search_migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'search_rollback';END$$;COMMIT;"),'search_rollback')
assert q("SELECT to_regprocedure('ca_club_data_player_search(uuid,text,integer)') IS NULL;")=='t'
q(search_migration)
def search(actor,term,limit=20,c=club):
 return json.loads(q(as_user(actor,f"SELECT ca_club_data_player_search('{c}','{term}',{limit});")))['items']
rows=search(1,' KingFish ')
assert len(rows)==1 and rows[0]['user_id']==uid(1),rows
assert set(rows[0])=={'user_id','management_club_id','alias','username','player_number','can_view_financials'}
assert rows[0]['management_club_id']==club and rows[0]['can_view_financials']
assert search(1,'kInGfIsH')[0]['user_id']==uid(1)
assert search(1,'1')[0]['user_id']==uid(1) # exact number ahead of substring matches
assert len(search(1,'AAAA',200))==20
assert len(search(1,'AAAA',1))==1
assert search(1,'')==[] and search(1,'no-such-player')==[]
assert search(1,'Hidden Legal')==[] # real names are not an identity fallback
assert search(1,'King')[0]['user_id']==uid(1)
assert search(1,'Fish')[0]['user_id']==uid(1)
# Hidden identities never consume the bounded result slots for another downline.
assert search(3,'KingFish')==[]
assert search(2,'WooWoo')[0]['user_id']==uid(2)
assert search(2,'KingFish')==[]
q(as_user(5,f"SELECT ca_club_data_player_search('{club}','Emo',20);"),'not authorized')
q(as_user(99,f"SELECT ca_club_data_player_search('{club}','KingFish',20);"),'not authorized')
q(as_user(3,f"SELECT ca_club_data_player_search('{uid(999)}','KingFish',20);"),'not authorized')
q("SET ROLE authenticated; RESET request.jwt.claim.sub; SELECT ca_club_data_player_search('"+club+"','KingFish',20);",'not authorized')
q("SET ROLE anon; SELECT ca_club_data_player_search('"+club+"','KingFish',20);",'permission denied')
assert q("SELECT NOT has_function_privilege('anon','ca_club_data_player_search(uuid,text,integer)','EXECUTE') AND has_function_privilege('authenticated','ca_club_data_player_search(uuid,text,integer)','EXECUTE');")=='t'
assert q("SELECT prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid='ca_club_data_player_search(uuid,text,integer)'::regprocedure;")=='t'
q(f"UPDATE profiles SET alias='AAAAZZZ' WHERE id='{uid(3)}';")
assert search(3,'AAAA',1)[0]['user_id']==uid(3) # private rows cannot consume the limit
# Exact identity wins even if more than a page of true substring matches precede it.
q(f"UPDATE profiles SET alias='AAAA KingFish '||player_number WHERE id IN (SELECT user_id FROM club_members WHERE club_id='{club}' AND user_id>'{uid(19)}');")
assert search(1,'KingFish')[0]['user_id']==uid(1)
q(search_migration,'already exists')
print('PASS: real roster reproduced KingFish upline crowding; identity-only exact/prefix/contains/number ranking, 20-result bound, minimal output, role/club/downline privacy, rollback and replay verified')

print('DATA_PLAYER_SEARCH_DEFINITION_MD5 '+q("SELECT md5(pg_get_functiondef('ca_club_data_player_search(uuid,text,integer)'::regprocedure));"))
proof=re.search(r'^-- @live-proof: (.+)$',search_migration,re.M).group(1)
assert q('SELECT '+proof+';')=='t'
print('PASS: declared live source/ACL proof matches the actually qualified function')
