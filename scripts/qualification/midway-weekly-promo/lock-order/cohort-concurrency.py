"""Actual promo + real ledger: coverage must refuse before unknown row locks."""
import subprocess,threading,queue,time,json,hashlib

def qualify(sql,q,O,env,L,critical_only=False):
 assert hashlib.md5((L/'core-original.sql').read_bytes()).hexdigest()=='3e159a80564f2860bed8041dbcd55263'
 assert hashlib.md5((L/'core-candidate.sql').read_bytes()).hexdigest()=='59918abbad797f7fc4e5c4a095b150c3'
 class S:
  def __init__(self,name):
   self.p=subprocess.Popen([str(x) for x in q]+['-v','ON_ERROR_STOP=0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,env=env);self.lines=queue.Queue();self.n=0
   threading.Thread(target=lambda:[self.lines.put(x.rstrip()) for x in self.p.stdout],daemon=True).start()
   self.pid=int(self.run("SET application_name='promo-native-"+name+"';SET statement_timeout='10s';\\set VERBOSITY verbose\nSELECT pg_backend_pid();").splitlines()[-1])
  def send(self,s):
   self.n+=1;tag='__PROMO_END_'+str(self.n)+'__';self.p.stdin.write(s+'\n\\echo '+tag+'\n');self.p.stdin.flush();return tag
  def wait(self,tag):
   out=[]
   while True:
    x=self.lines.get(timeout=15)
    if x==tag:
     result='\n'.join(out);(O/('session-'+str(getattr(self,'pid','initial'))+'-'+str(self.n)+'.log')).write_text(result);return result
    out.append(x)
  def run(self,s):return self.wait(self.send(s))
  def close(self):
   if self.p.poll() is None:self.p.stdin.write('ROLLBACK;\n\\q\n');self.p.stdin.flush();self.p.communicate(timeout=10)
 def blocked(s,by):
  end=time.monotonic()+6
  while time.monotonic()<end:
   if sql(f'SELECT {by.pid}=ANY(pg_blocking_pids({s.pid}));','blocking-'+str(s.pid))=='t':return
   time.sleep(.03)
  raise AssertionError('expected blocking edge absent')
 union='fade0000-0000-0000-0000-000000000001'
 call="SELECT public.fn_midway_weekly_horse_promo('2026-10-19 07:00Z','2026-10-26 07:00Z');"
 h="md5('midway-native-9')::uuid"
 key="hashtextextended('player-stats-user:'||md5('midway-native-2')::uuid::text,0)"
 before=sql("SELECT jsonb_build_object('bank',(SELECT promo_wallet FROM union_wallets),'runs',(SELECT count(*)FROM union_weekly_horse_promo_runs),'ledger',(SELECT count(*)FROM chip_ledger),'recipients',(SELECT count(*)FROM union_weekly_horse_promo_recipients));",'cohort-before')
 out=[]
 if not critical_only:
  for held_profile in [False,True]:
   t,p,x=S('bank'),S('promo'),S('new-horse');xh=None
   try:
    t.run("BEGIN;SELECT promo_wallet FROM union_wallets WHERE union_id='"+union+"' FOR UPDATE;")
    sent=p.send('BEGIN;'+call);blocked(p,t)
    x.run('UPDATE profiles SET is_horse=true WHERE id='+h+';')
    if held_profile:
     x.run('BEGIN;SELECT id FROM profiles WHERE id='+h+' FOR UPDATE;')
     xh=x.send('SELECT pg_advisory_xact_lock('+key+');');blocked(x,p)
    t.run('COMMIT;');result=p.wait(sent)
    assert '55000' in result and 'midway_promo_eligible_cohort_changed' in result,result
    p.run('ROLLBACK;')
    if xh:x.wait(xh);x.run('ROLLBACK;')
    x.run('UPDATE profiles SET is_horse=false WHERE id='+h+';')
    assert sql("SELECT jsonb_build_object('bank',(SELECT promo_wallet FROM union_wallets),'runs',(SELECT count(*)FROM union_weekly_horse_promo_runs),'ledger',(SELECT count(*)FROM chip_ledger),'recipients',(SELECT count(*)FROM union_weekly_horse_promo_recipients));",'cohort-after')==before
    out.append({'case':'newly-eligible-horse-profile-waits-known-key' if held_profile else 'newly-eligible-horse-while-bank-blocked','sqlstate':'55000','no_financial_changes':True,'no_deadlock':True})
   finally:
    for s in [t,p,x]:s.close()
  # Fresh cohort shrink and new membership for an already covered user.
  for change in ['shrink','lifecycle-shrink','covered-user-overlap']:
   club='a0000000-0000-0000-0000-000000000001' if change!='covered-user-overlap' else 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
   user="md5('midway-native-1')::uuid" if change!='covered-user-overlap' else "md5('midway-native-2')::uuid"
   where="club_id='"+club+"' AND user_id="+user
   if change=='covered-user-overlap':sql("UPDATE club_members SET status='banned' WHERE "+where+';','overlap-prefetch-setup')
   t,p=S('cohort-change'),S('fresh-cohort-promo')
   try:
    t.run("BEGIN;SELECT promo_wallet FROM union_wallets WHERE union_id='"+union+"' FOR UPDATE;")
    ps=p.send('BEGIN;'+call);blocked(p,t)
    t.run("UPDATE club_members SET status='"+('banned' if change!='covered-user-overlap' else 'approved')+"' WHERE "+where+';COMMIT;')
    result=p.wait(ps);assert 'ERROR:' not in result,result
    packet=json.loads(next(x for x in result.splitlines() if x.startswith('{')))
    assert packet['eligible_wallets']==(3 if change!='covered-user-overlap' else 4),packet
    assert packet['paid']==50.01 and packet['success'],packet
    p.run('ROLLBACK;')
    sql("UPDATE club_members SET status='"+('active' if change!='covered-user-overlap' else 'approved')+"' WHERE "+where+';','restore-cohort')
    out.append({'case':change,'eligible_wallets':packet['eligible_wallets'],'paid':str(packet['paid']),'financial_transaction':'ROLLED_BACK'})
   finally:
    for x in [t,p]:x.close()
  # Real club-bank -> member disburser versus the actual promo core.
  club='a0000000-0000-0000-0000-000000000001'
  sql("SELECT public.fn_promo_disburse('union','"+union+"','club','"+club+"',5,'native-bank-fixture',NULL,md5('native-bank-fixture')::uuid);",'fund-real-club-bank')
  first=sql("SELECT user_id FROM club_members m JOIN profiles p ON p.id=m.user_id WHERE club_id='"+club+"' AND p.is_horse AND p.horse_status IS DISTINCT FROM 'disabled' AND m.is_active AND m.status IN('active','approved') AND m.membership_lifecycle_status='active' AND m.chip_balance<10000 ORDER BY user_id LIMIT 1;".replace('ONp','ON p'),'first-eligible-user')
  for state in ['original','candidate']:
   sql((L/('core-'+state+'.sql')).read_text()+';','club-cycle-install-'+state)
   c,p,d=S('profile-holder'),S('promo'),S('real-disburser')
   try:
    c.run("BEGIN;SELECT id FROM profiles WHERE id='"+first+"' FOR UPDATE;")
    ps=p.send('BEGIN;'+call);blocked(p,c)
    ds=d.send("BEGIN;SELECT public.fn_promo_disburse('club','"+club+"','player','"+first+"',0.01,'native-bank-cycle','"+club+"',md5('native-bank-cycle')::uuid);")
    blocked(d,p)
    c.run('ROLLBACK;')
    # The original cycle must abort one statement; candidate holds club first,
    # completes without error, then releases its rolled-back payment transaction.
    pr=p.wait(ps);p.run('ROLLBACK;');dr=d.wait(ds);d.run('ROLLBACK;')
    if state=='original':assert '40P01' in pr+dr,(pr,dr)
    else:assert 'ERROR:' not in pr+dr and '"success": true' in pr+dr,(pr,dr)
    out.append({'case':'actual-club-disburser-cycle','source':state,'deadlock':state=='original','results':{'promo':pr,'disburser':dr}})
   finally:
    for x in [c,p,d]:x.close()
 # Complementary native producer boundaries retain actual critical lock owners.
 sql((L/'critical-doors-native-supplement.sql').read_text(),'critical-door-supplement')
 for signature,expected in {'fn_credit_agent_commissions_batch(jsonb)':'1c9d9ff9cfb2803f05223c703f61f09b','fn_process_cash_accounting_source(uuid)':'460e4b0a936b41246548cb0a9efc9f7f','apply_rakeback_player_stats(uuid,uuid,uuid,integer,numeric)':'1519023c9ec579568a347b6088c898ec','fn_sync_profile_total_hands()':'886d9aae3d1fbd18a98d172ebe13758e','fn_sync_mfa_required_on_club_role()':'b09cbcddc87075221d72aee3899e97b4','fn_project_hand_side_effects_after_post_commit_20260908(uuid)':'cee6c2257fcc49c6c6974e5fe8832107'}.items():
  assert sql("SELECT md5(pg_get_functiondef('public."+signature+"'::regprocedure));",'actual-critical-owner-'+signature.split('(')[0])==expected

 a='00000000-0000-0000-0000-000000000001';b='00000000-0000-0000-0000-000000000002';c1='a0000000-0000-0000-0000-000000000001';c2='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
 sql("ALTER TABLE profiles DISABLE TRIGGER trg_auto_connect_dan;INSERT INTO auth.users(id)VALUES('"+a+"'),('"+b+"');INSERT INTO profiles(id,is_horse,horse_status)VALUES('"+a+"',true,'available'),('"+b+"',true,'available') ON CONFLICT(id) DO UPDATE SET is_horse=excluded.is_horse,horse_status=excluded.horse_status;ALTER TABLE profiles ENABLE TRIGGER trg_auto_connect_dan;SELECT set_config('app.club_membership_source','join_club',false);INSERT INTO club_members(club_id,user_id,is_active,status,membership_lifecycle_status,chip_balance)VALUES('"+c1+"','"+b+"',true,'active','active',0),('"+c2+"','"+a+"',true,'active','active',0);",'critical-local-actors')
 # Only seed-time legacy synchronous projections are omitted; current actual
 # outbox projector and actual player_stats/profile trigger run during cases.
 sql("ALTER TABLE hand_history DISABLE TRIGGER hand_history_club_member_stats;ALTER TABLE hand_history DISABLE TRIGGER hand_history_fold_stats;ALTER TABLE hand_history DISABLE TRIGGER hand_history_position_stats;ALTER TABLE hand_history DISABLE TRIGGER trg_ca_stats_live_from_hand;INSERT INTO tables(id,club_id,name,status,game_type)VALUES(md5('promo-lock-table')::uuid,'"+c2+"','Native lock door','closed','cash');INSERT INTO hand_history(id,table_id,hand_number,players,winners,actions,big_blind,rake_amount,pot_size)VALUES(md5('promo-lock-hand')::uuid,md5('promo-lock-table')::uuid,1,jsonb_build_array(jsonb_build_object('userId','"+a+"','stack',100),jsonb_build_object('userId','"+b+"','stack',100)),'[]','[]',2,0,0);INSERT INTO hand_projection_outbox(hand_id,table_id,hand_number)VALUES(md5('promo-lock-hand')::uuid,md5('promo-lock-table')::uuid,1);ALTER TABLE hand_history ENABLE TRIGGER hand_history_club_member_stats;ALTER TABLE hand_history ENABLE TRIGGER hand_history_fold_stats;ALTER TABLE hand_history ENABLE TRIGGER hand_history_position_stats;ALTER TABLE hand_history ENABLE TRIGGER trg_ca_stats_live_from_hand;",'critical-local-hand')
 for state in ['original','candidate']:
  sql((L/('core-'+state+'.sql')).read_text()+';','projector-install-'+state)
  c,p,w=S('member-holder'),S('promo-projector-race'),S('actual-projector')
  try:
   c.run("BEGIN;SELECT user_id FROM club_members WHERE club_id='"+c2+"' AND user_id='"+a+"' FOR UPDATE;")
   p.run("SET deadlock_timeout='100ms';")
   ps=p.send('BEGIN;'+call);blocked(p,c)
   ws=w.send("BEGIN;SELECT public.fn_project_hand_side_effects_after_post_commit_20260908(md5('promo-lock-hand')::uuid);")
   blocked(w,p)
   c.run('ROLLBACK;');pr=p.wait(ps);p.run('ROLLBACK;');wr=w.wait(ws);w.run('ROLLBACK;')
   if state=='original':assert '40P01' in pr+wr,(pr,wr)
   else:assert 'ERROR:' not in pr+wr and '"ok": true' in wr,(pr,wr)
   out.append({'case':'actual-current-projector-profile-trigger','source':state,'deadlock':state=='original','promo':pr,'projector':wr})
  finally:
   for x in [c,p,w]:x.close()
 # Actual member->profile MFA trigger overlaps promo and actual projector.
 sql((L/'core-candidate.sql').read_text()+';','member-profile-candidate-install')
 c,p,w=S('actual-member-role'),S('member-role-promo'),S('member-role-projector')
 try:
  c.run("BEGIN;UPDATE club_members SET role='agent' WHERE club_id='"+c2+"' AND user_id='"+a+"';")
  assert c.run("SELECT mfa_required FROM profiles WHERE id='"+a+"';")=='t'
  ps=p.send('BEGIN;'+call);blocked(p,c)
  ws=w.send("BEGIN;SELECT public.fn_project_hand_side_effects_after_post_commit_20260908(md5('promo-lock-hand')::uuid);")
  blocked(w,p);c.run('ROLLBACK;');pr=p.wait(ps);p.run('ROLLBACK;');wr=w.wait(ws);w.run('ROLLBACK;')
  assert 'ERROR:' not in pr+wr and '"success": true' in pr and '"ok": true' in wr,(pr,wr)
  out.append({'case':'actual-member-role-profile-trigger-overlap','promo_completed':True,'projector_completed':True,'rolled_back':True})
 finally:
  for x in [c,p,w]:x.close()
 # Real current batch keeps all user gates across hand/page order. The
 # producer materializes typed contributor receipts; the process/apply/profile
 # doors remain exact retained originals and are the locks measured here.
 records=[]
 for i,u in enumerate([a,b]):
  rec="md5('promo-batch-record-"+str(i)+"')::uuid";hand="md5('promo-batch-hand-"+str(i)+"')::uuid"
  sql("INSERT INTO rake_records(id,hand_id,club_id,rake_amount,metadata)VALUES("+rec+","+hand+",'"+c2+"',1,'{}');INSERT INTO rake_attributions(hand_id,player_id,rake_amount,rake_record_id,club_id,weighted_rake_credit)VALUES("+hand+",'"+u+"',1,"+rec+",'"+c2+"',1);",'batch-local-source-'+str(i))
  records.append(sql('SELECT '+rec+';','batch-local-source-id-'+str(i)))
 sql("DELETE FROM rakeback_stats_applied WHERE user_id IN('"+a+"','"+b+"');DELETE FROM player_stats WHERE user_id IN('"+a+"','"+b+"');",'batch-fresh-critical-rows')
 sql("INSERT INTO harness_pause(id)VALUES(md5('promo-batch-hand-1')::uuid);",'batch-page-pause')
 items=json.dumps([{'source_type':'cash_rake_record','source_id':r} for r in records])
 batch="SELECT public.fn_credit_agent_commissions_batch('"+items+"'::jsonb);"
 for state in ['original','candidate']:
  sql((L/('core-'+state+'.sql')).read_text()+';','batch-install-'+state)
  c,p,w=S('batch-page-control'),S('promo-batch-race'),S('actual-batch')
  try:
   c.run("BEGIN;SELECT pg_advisory_lock(424243);SELECT user_id FROM club_members WHERE club_id='"+c2+"' AND user_id='"+a+"' FOR UPDATE;")
   p.run("SET deadlock_timeout='100ms';")
   ps=p.send('BEGIN;'+call);blocked(p,c)
   ws=w.send('BEGIN;'+batch)
   if state=='original':
    blocked(w,c);c.run('COMMIT;');time.sleep(.05);c.run('SELECT pg_advisory_unlock(424243);')
    pr=p.wait(ps);p.run('ROLLBACK;');wr=w.wait(ws);w.run('ROLLBACK;')
    assert '40P01' in pr,(pr,wr)
    result=json.loads(next(x for x in wr.splitlines() if x.startswith('{')))
    assert result['ok']==2 and result['failed']==0,result
   else:
    wr=w.wait(ws);w.run('ROLLBACK;')
    result=json.loads(next(x for x in wr.splitlines() if x.startswith('{')))
    assert result['ok']==0 and result['failed']==0 and len(result['deferred'])==2,result
    c.run('COMMIT;SELECT pg_advisory_unlock(424243);');pr=p.wait(ps);p.run('ROLLBACK;')
    assert 'ERROR:' not in pr,pr
   out.append({'case':'actual-current-multi-hand-batch-page-order','source':state,'deadlock':state=='original','promo':pr,'batch':result})
  finally:
   for x in [c,p,w]:x.close()
 # Distinct contributors in the same two clubs must keep progressing while
 # promo waits on its member; the actual batch keeps caller hand order B->A.
 disjoint=[]
 for i,club in [(3,c2),(4,c1)]:
  uid='00000000-0000-0000-0000-00000000000'+str(i)
  sql("ALTER TABLE profiles DISABLE TRIGGER trg_auto_connect_dan;INSERT INTO auth.users(id)VALUES('"+uid+"');ALTER TABLE profiles ENABLE TRIGGER trg_auto_connect_dan;",'disjoint-local-user-'+str(i))
  rec="md5('promo-disjoint-record-"+str(i)+"')::uuid";hand="md5('promo-disjoint-hand-"+str(i)+"')::uuid"
  sql("INSERT INTO rake_records(id,hand_id,club_id,rake_amount,metadata)VALUES("+rec+","+hand+",'"+club+"',1,'{}');INSERT INTO rake_attributions(hand_id,player_id,rake_amount,rake_record_id,club_id,weighted_rake_credit)VALUES("+hand+",'"+uid+"',1,"+rec+",'"+club+"',1);",'disjoint-local-source-'+str(i))
  disjoint.append({'source_type':'cash_rake_record','source_id':sql('SELECT '+rec+';','disjoint-source-id-'+str(i))})
 sql((L/'core-candidate.sql').read_text()+';','disjoint-candidate-install')
 c,p,w=S('disjoint-member-holder'),S('disjoint-promo'),S('disjoint-actual-batch')
 try:
  c.run("BEGIN;SELECT user_id FROM club_members WHERE club_id='"+c2+"' AND user_id='"+a+"' FOR UPDATE;")
  ps=p.send('BEGIN;'+call);blocked(p,c)
  wr=w.run("BEGIN;SELECT public.fn_credit_agent_commissions_batch('"+json.dumps(disjoint)+"'::jsonb);")
  result=json.loads(next(x for x in wr.splitlines() if x.startswith('{')))
  assert result['ok']==2 and result['failed']==0 and result['deferred']==[],result
  w.run('ROLLBACK;');c.run('ROLLBACK;');pr=p.wait(ps);p.run('ROLLBACK;');assert 'ERROR:' not in pr,pr
  out.append({'case':'disjoint-users-same-clubs-B-then-A-current-batch','batch':result,'promo_completed':True})
 finally:
  for x in [c,p,w]:x.close()
 (O/'cohort-concurrency.json').write_text(json.dumps(out,indent=2))
