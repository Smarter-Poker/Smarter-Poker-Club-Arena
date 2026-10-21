# Executed inside the existing real PG17 boundary fixture, with q/as_user/uid/club.
preimages=json.loads((F/'enhancement-preimages.json').read_text())
q("CREATE TABLE game_management_events(sequence bigserial PRIMARY KEY,event_id uuid UNIQUE DEFAULT gen_random_uuid(),event_type text,scope_kind text,scope_id uuid,club_id uuid,union_id uuid,recipient_id uuid,entity_type text,entity_id uuid,command_id uuid,actor_id uuid,payload jsonb,created_at timestamptz DEFAULT now()); ALTER TABLE game_management_events ENABLE ROW LEVEL SECURITY; CREATE POLICY own ON game_management_events FOR SELECT TO authenticated USING(recipient_id=auth.uid()); GRANT SELECT ON game_management_events TO authenticated;")
q("""CREATE FUNCTION fn_emit_game_management_event(p_event_type text,p_club_id uuid DEFAULT NULL,p_union_id uuid DEFAULT NULL,p_recipient_id uuid DEFAULT NULL,p_entity_type text DEFAULT NULL,p_entity_id uuid DEFAULT NULL,p_command_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
INSERT INTO game_management_events(event_type,scope_kind,scope_id,club_id,union_id,recipient_id,entity_type,entity_id,command_id,actor_id,payload)
VALUES(p_event_type,CASE WHEN p_union_id IS NULL THEN 'club' ELSE 'union' END,COALESCE(p_union_id,p_club_id),p_club_id,p_union_id,p_recipient_id,p_entity_type,p_entity_id,p_command_id,auth.uid(),p_payload)$$;""")
q('SET check_function_bodies=off;'+next(x['definition'] for x in preimages if x['proname']=='fn_emit_management_access_event'))
q("CREATE TRIGGER scope_event AFTER INSERT OR UPDATE OR DELETE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event();")
# Capture the true preimage for the optimized lookup, including its active-edge dependency.
for name in ['fn_club_active_cashier_edges','fn_club_is_in_downline']:
 q(next(x['definition'] for x in preimages if x['proname']==name))
for n,name in [(1,'Owner'),(3,'Source Agent'),(6,'Destination Agent'),(7,'Player Seven'),(8,'Player Eight')]:
 q(f"INSERT INTO profiles(id,alias,username) VALUES('{uid(n)}','{name}','fixture{n}');")
enhancement=next((ROOT/'supabase/migrations').glob('*_agent_transfer_review_history_and_scope_events.sql')).read_text()
q(enhancement.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'enhancement_rollback';END$$;COMMIT;"),'enhancement_rollback')
assert q("SELECT to_regprocedure('fn_preview_club_assignment(uuid,uuid[],uuid,uuid)') IS NULL;")=='t'
q(enhancement)
q(enhancement,'already exists')
for n in [2,3,4,7]:
 for query in [f"SELECT fn_preview_club_assignment('{club}',ARRAY['{uid(7)}'::uuid],'{uid(6)}');",f"SELECT fn_club_assignment_history('{club}');",f"SELECT fn_apply_reviewed_club_assignment('{club}',ARRAY['{uid(7)}'::uuid],'{uid(6)}','{uid(1200)}','x');"]:
  q(as_user(n,query),'not_authorised')
preview_call=f"SELECT fn_preview_club_assignment('{club}',ARRAY['{uid(7)}'::uuid],'{uid(6)}','{uid(3)}');"
review=json.loads(q(as_user(1,preview_call)))
assert review['members'][0]['name']=='Player Seven' and review['members'][0]['source_name']=='Source Agent'
assert review['destination']['name']=='Destination Agent' and review['selected_count']==review['affected_count']==1
q(f"UPDATE club_members SET chip_balance=COALESCE(chip_balance,0)+1 WHERE club_id='{club}' AND user_id='{uid(7)}';")
assert json.loads(q(as_user(1,preview_call)))['review_token']==review['review_token'],'A chip-only update invalidated the hierarchy review'
# A hierarchy change after preview must refuse and move nobody.
q(as_user(1,f"SELECT fn_reassign_club_members('{club}',ARRAY['{uid(8)}'::uuid],'{uid(6)}','{uid(1201)}');"))
apply=f"SELECT fn_apply_reviewed_club_assignment('{club}',ARRAY['{uid(7)}'::uuid],'{uid(6)}','{uid(1202)}','{review['review_token']}','{uid(3)}');"
q(as_user(1,apply),'assignment_review_changed_preview_again')
assert q(f"SELECT agent_id='{uid(3)}' FROM club_members WHERE user_id='{uid(7)}';")=='t'
review2=json.loads(q(as_user(1,preview_call)))
apply=apply.replace(review['review_token'],review2['review_token'])
q('TRUNCATE game_management_events;')
receipt=json.loads(q(as_user(1,apply)));assert receipt['success'] and receipt['moved']==1
assert json.loads(q(as_user(1,apply)))['replayed'] is True
assert q(f"SELECT count(*) FROM club_assignment_operations WHERE id='{uid(1202)}' AND review_snapshot->>'review_token'='{review2['review_token']}';")=='1'
# Prior and new uplines get one recipient-only generic event, even if a row repeats in a bulk transaction.
for viewer in [3,6]:
 assert q(as_user(viewer,"SELECT count(*) FROM game_management_events WHERE payload->>'reason'='member_scope_changed';"))=='1'
 assert q(as_user(viewer,"SELECT bool_and(NOT (payload ? 'members') AND actor_id IS NULL) FROM game_management_events WHERE payload->>'reason'='member_scope_changed';"))=='t'
assert q(as_user(8,"SELECT count(*) FROM game_management_events;"))=='0'
q(f"BEGIN;UPDATE club_members SET status='approved' WHERE club_id='{club}' AND user_id='{uid(7)}'; UPDATE club_members SET status='active' WHERE club_id='{club}' AND user_id='{uid(7)}'; COMMIT;")
assert q(f"SELECT count(*) FROM game_management_events WHERE recipient_id='{uid(6)}' AND payload->>'reason'='member_scope_changed';")=='2'
history=json.loads(q(as_user(1,f"SELECT fn_club_assignment_history('{club}','Player Seven');")))
assert any(row['operation_id']==uid(1202) and row['review']['members'][0]['name']=='Player Seven' for row in history['rows'])
first=json.loads(q(as_user(1,f"SELECT fn_club_assignment_history('{club}','','NULL'::timestamptz,NULL,1);".replace("'NULL'::timestamptz","NULL"))))
assert len(first['rows'])==2 and first['page_size']==1
last=first['rows'][0]
next_page=json.loads(q(as_user(1,f"SELECT fn_club_assignment_history('{club}','','{last['created_at']}','{last['operation_id']}',1);")))
assert all(row['operation_id']!=last['operation_id'] for row in next_page['rows'])
q("SET ROLE anon;SELECT fn_club_assignment_history('"+club+"');",'permission denied')
print('PASS: reviewed assignment, chip-stable/stale hierarchy review, immutable replay, staff-only searchable keyset history, rollback and generic recipient-only immediate scope events')
