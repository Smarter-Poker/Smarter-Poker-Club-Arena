# Executed in the existing native PG17 boundary fixture after transfer controls.
# The four raw functions and seven policies are exact captured catalog definitions.
raw=json.loads((F/'helper-oracle-preimages.json').read_text())
for helper in raw['helpers']:
 q(helper['definition'])
q("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER;END IF;END$$;")
for helper in raw['helpers']:
 signature=helper['signature']
 q(f"ALTER FUNCTION public.{signature} OWNER TO postgres; REVOKE ALL ON FUNCTION public.{signature} FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.{signature} TO authenticated,service_role;")
# RLS consumers directly invoking a raw helper would break after a naive revoke.
q("""CREATE TABLE cashout_requests(id uuid PRIMARY KEY,club_id uuid,player_id uuid,agent_id uuid);
CREATE TABLE chip_escrow(id uuid PRIMARY KEY,player_id uuid,cashout_request_id uuid);
CREATE TABLE tournament_tickets(id uuid PRIMARY KEY,club_id uuid,issued_by uuid,holder_id uuid);
CREATE TABLE tournament_ticket_entry_targets(id uuid PRIMARY KEY,club_id uuid,issued_by uuid,holder_id uuid);
CREATE TABLE chip_requests(id uuid PRIMARY KEY,club_id uuid,requester_id uuid,approver_id uuid);
GRANT SELECT ON cashout_requests,chip_escrow,tournament_tickets,tournament_ticket_entry_targets,chip_requests TO authenticated;
ALTER TABLE cashout_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE chip_escrow ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_tickets ENABLE ROW LEVEL SECURITY;ALTER TABLE tournament_ticket_entry_targets ENABLE ROW LEVEL SECURITY;ALTER TABLE chip_requests ENABLE ROW LEVEL SECURITY;""")
for policy in raw['policy_definitions']:
 q(f"CREATE POLICY \"{policy['policy']}\" ON public.\"{policy['table']}\" FOR SELECT TO authenticated USING ({policy['qual']});")
oracle_club=uid(7000)
q(f"INSERT INTO clubs(id,name,owner_id) VALUES('{oracle_club}','Oracle Fixture','{uid(7010)}');")
for number,role,parent in [(7010,'owner',None),(7011,'super_agent',None),(7012,'agent',7011),(7013,'sub_agent',7012),(7014,'player',7013),(7015,'agent',7011),(7016,'player',7015)]:
 q(f"INSERT INTO profiles(id,alias,username) VALUES('{uid(number)}','Oracle {number}','oracle{number}');")
 if role in ('super_agent','agent','sub_agent'):
  q(f"INSERT INTO agents(id,club_id,user_id,role,status,total_players) VALUES('{uid(number+100)}','{oracle_club}','{uid(number)}','{role}','active',0);")
 parent_sql='NULL' if parent is None else "'"+uid(parent)+"'"
 q(f"INSERT INTO club_members(club_id,user_id,role,status,agent_id) VALUES('{oracle_club}','{uid(number)}','{role}','active',{parent_sql});")
# Before: a plain player can ask about an entirely different branch and actor.
assert q(as_user(7014,f"SELECT fn_club_bank_role('{oracle_club}','{uid(7015)}');"))=='agent'
assert q(as_user(7014,f"SELECT fn_club_cashier_scope('{oracle_club}','{uid(7015)}');"))=='downline'
assert q(as_user(7014,f"SELECT fn_club_is_in_downline('{oracle_club}','{uid(7015)}','{uid(7016)}');"))=='t'
assert q(as_user(7014,f"SELECT fn_club_cashier_can_transact('{oracle_club}','{uid(7015)}','{uid(7016)}');"))=='t'
# Internal cashout validation deliberately asks on behalf of the assigned agent,
# with the player's JWT. It must remain legal after browser helper revocation.
q("CREATE FUNCTION public.fixture_assigned_agent_can_transact(c uuid,a uuid,p uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT public.fn_club_cashier_can_transact(c,a,p)$$; GRANT EXECUTE ON FUNCTION public.fixture_assigned_agent_can_transact(uuid,uuid,uuid) TO authenticated;")
assert q(as_user(7014,f"SELECT fixture_assigned_agent_can_transact('{oracle_club}','{uid(7013)}','{uid(7014)}');"))=='t'
oracle_migration=next((ROOT/'supabase/migrations').glob('*_bind_private_club_helper_reads_to_the_caller.sql')).read_text()
q(oracle_migration.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'oracle_rollback';END$$;COMMIT;"),'oracle_rollback')
assert q("SELECT to_regprocedure('fn_club_viewer_cashier_scope(uuid)') IS NULL;")=='t'
q(oracle_migration)
q(oracle_migration,'PRIVATE_GRAPH_HELPER_PREIMAGE_CHANGED')
for fn,args in [('fn_club_bank_role',f"'{oracle_club}','{uid(7015)}'"),('fn_club_cashier_scope',f"'{oracle_club}','{uid(7015)}'"),('fn_club_is_in_downline',f"'{oracle_club}','{uid(7015)}','{uid(7016)}'"),('fn_club_cashier_can_transact',f"'{oracle_club}','{uid(7015)}','{uid(7016)}'")]:
 q(as_user(7014,f'SELECT {fn}({args});'),'permission denied')
assert q(as_user(7012,f"SELECT fn_club_viewer_cashier_scope('{oracle_club}');"))=='downline'
assert q(as_user(7012,f"SELECT fn_club_viewer_bank_role('{oracle_club}');"))=='agent'
for fn in ['fn_club_viewer_is_in_downline','fn_club_viewer_can_transact']:
 assert q(as_user(7012,f"SELECT {fn}('{oracle_club}','{uid(7014)}');"))=='t'
 assert q(as_user(7012,f"SELECT {fn}('{oracle_club}','{uid(7016)}');"))=='f'
assert q(as_user(7014,f"SELECT fixture_assigned_agent_can_transact('{oracle_club}','{uid(7013)}','{uid(7014)}');"))=='t'
assert q(as_user(7012,f"SELECT count(*) FROM club_members WHERE club_id='{oracle_club}';"))=='3'
assert q(as_user(7012,f"SELECT count(*) FROM agents WHERE club_id='{oracle_club}';"))=='2'
assert q(as_user(7010,f"SELECT count(*) FROM club_members WHERE club_id='{oracle_club}';"))=='7'
for offset,player,agent in [(0,7014,7013),(1,7016,7015)]:
 q(f"INSERT INTO cashout_requests VALUES('{uid(7300+offset)}','{oracle_club}','{uid(player)}','{uid(agent)}'); INSERT INTO chip_escrow VALUES('{uid(7310+offset)}','{uid(player)}','{uid(7300+offset)}');")
 for table in ['tournament_tickets','tournament_ticket_entry_targets']:
  q(f"INSERT INTO {table} VALUES('{uid(7320+offset)}','{oracle_club}','{uid(7010)}','{uid(7012 if offset==0 else 7015)}');")
 q(f"INSERT INTO chip_requests VALUES('{uid(7330+offset)}','{oracle_club}','{uid(7012 if offset==0 else 7015)}',NULL);")
assert q(as_user(7012,"SELECT count(*) FROM cashout_requests;"))=='1'
assert q(as_user(7013,"SELECT count(*) FROM chip_escrow;"))=='1'
for table in ['tournament_tickets','tournament_ticket_entry_targets','chip_requests']:
 assert q(as_user(7012,f'SELECT count(*) FROM {table};'))=='1'
 assert q(as_user(7010,f'SELECT count(*) FROM {table};'))=='2'
# Existing authoritative assignment still performs arbitrary-root cycle checks.
receipt=json.loads(q(as_user(7010,f"SELECT fn_reassign_club_members('{oracle_club}',ARRAY['{uid(7014)}'::uuid],'{uid(7015)}','{uid(7350)}','{uid(7013)}');")))
assert receipt['success'] and receipt['moved']==1
assert q(as_user(7012,f"SELECT fn_club_viewer_is_in_downline('{oracle_club}','{uid(7014)}');"))=='f'
assert q(as_user(7015,f"SELECT fn_club_viewer_is_in_downline('{oracle_club}','{uid(7014)}');"))=='t'
assert q("SELECT count(*) FROM pg_policies WHERE schemaname='public' AND (qual ~ '(fn_club_is_in_downline|fn_club_cashier_scope|fn_club_cashier_can_transact|fn_club_bank_role)\\(' OR with_check ~ '(fn_club_is_in_downline|fn_club_cashier_scope|fn_club_cashier_can_transact|fn_club_bank_role)\\(');")=='0'
print('PASS: private helper before/after oracle refusal, caller-bound wrappers, all seven RLS policies, trusted assigned-agent delegation, existing atomic assignment, rollback and replay refusal')
