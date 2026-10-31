"""Add fixed-field scenes to the existing owned, real satellite financial fixture."""
import hashlib
import json
from satellite_qualifier_fixture import function_sql
import re

def qualify(e,root,db,output):
    outputs=output/'fixed-sng'
    outputs.mkdir()
    oct_path=root/'supabase/migrations/20261017004440_satellites_seat_bounty_targets.sql'
    oct_text=oct_path.read_text()
    bodies=re.findall(r'^CREATE OR REPLACE FUNCTION public\.\w+\(.*?\$function\$;\n',oct_text,re.S|re.M)
    if len(bodies)<10: raise ValueError('current satellite financial owner definitions missing')
    helper_path=root/'supabase/migrations/20260929161500_a_diamond_satellite_seat_is_a_whole_ticket.sql'
    helper_text=helper_path.read_text()
    helper=re.search(r'^CREATE (?:OR REPLACE )?FUNCTION public\.fn_ca_assert_satellite_asset\(.*?\$function\$;\n',helper_text,re.S|re.M)
    if not helper: raise ValueError('actual asset authority missing')
    unit_files=[root/'scripts/ci/probes/satellite-bounty-split'/f'{name}.sql' for name in
        ['fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents','fn_ca_recovery_fee_cents','fn_ca_tournament_fee_ratio','fn_poker_diamond_tournament']]
    bust_path=root/'supabase/migrations/20260921095012_satellite_awards_and_final_table_deals_rank_a_same_hand_bust.sql'
    bust=re.search(r'^CREATE OR REPLACE FUNCTION public\.fn_ca_tournament_bust_at\(.*?\$f08_bust_at\$;\n',bust_path.read_text(),re.S|re.M)
    if not bust: raise ValueError('actual causal bust authority missing')
    lane_path=root/'supabase/migrations/20261003164157_a_finish_waits_only_for_what_it_shares.sql'
    lane=re.search(r'^CREATE FUNCTION public\.fn_ca_lock_satellite_answer_lane\(.*?\$function\$;\n',lane_path.read_text(),re.S|re.M)
    if not lane: raise ValueError('actual qualifier answer lane missing')
    reader_path=root/'scripts/ci/fixtures/fixed-sng-satellite-current-readers.json'
    capture=json.loads(reader_path.read_text())
    readers=capture['functions']
    registry=capture['chip_retirement_registry']
    if registry['store']!='chip_retirement' or registry['treatment']!='noncirculating': raise ValueError('captured retirement declaration drifted')
    expected={'fn_ca_assert_satellite_cohort_standings(uuid)':'5c883464a5d0c61e32259a8764f08db0',
      'fn_get_satellite_qualifier_state(uuid)':'08db3d2a8d33c2d9eebaf0fa20be4b65',
      'fn_resolve_satellite_qualifier_outcome(uuid,uuid[])':'e9584dc02fed91f2c252e8996bcce3b6'}
    if {r['signature']:r['source_md5'] for r in readers}!=expected: raise ValueError('captured current reader set drifted')
    sql='BEGIN;\nALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT \'chips\';\nALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS is_platform boolean DEFAULT false;\n'
    sql+="INSERT INTO public.ca_chip_store_coverage SELECT * FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,'"+json.dumps(registry).replace("'","''")+"'::jsonb);\n"
    sql+='\n'.join(path.read_text().rstrip().rstrip(';')+';' for path in unit_files)+'\n'+helper.group(0).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)+'\n'+'\n'.join(bodies)+'\n'+bust.group(0)+'\n'+lane.group(0).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)+'\n'+'\n'.join(function_sql(row) for row in readers)+'\nCOMMIT;\n'
    (outputs/'current-owners.sql').write_text(sql)
    e.sql(db,file=outputs/'current-owners.sql',label='fixed-sng-current-satellite-owners',seconds=120)
    candidate=root/'supabase/migrations/20261028163610_two_seat_fixed_field_sng_satellites.sql'
    e.sql(db,file=candidate,label='fixed-sng-exact-candidate',seconds=60)
    source=root/'scripts/ci/probes/satellite-qualifiers-native.sql'
    probe=source.read_text()
    changes=[
      ('tournament_type,variant,format_contract,satellite_target_id,satellite_target,satellite_seats)',
       'tournament_type,variant,format_contract,satellite_target_id,satellite_target,satellite_seats,table_size)'),
      ("'mtt-v2',NULL,NULL,NULL),", "'mtt-v2',NULL,NULL,NULL,9),"),
      ("(source_id,'Native Qualifier Source '||case_name,26.25,0,1000,clock_timestamp()+interval '1 hour','REGISTERING',\n   0,NULL,3,0,club,0,0,0,false,false,false,0,0,0,'SATELLITE','satellite','mtt-v2',target_id,target_id,2);",
       "(source_id,'Native Qualifier Source '||case_name,17.1,1.9,1000,clock_timestamp()+interval '1 hour','REGISTERING',\n   0,6,6,0,club,0,0,0,false,false,false,0,0,0,'SNG','sng','sng-v1',target_id,target_id,2,6);"),
      ("'Native Qualifier Target '||case_name,45,5,1000", "'Native Qualifier Target '||case_name,36,4,1000"),
      (" PERFORM pg_temp.qualifier_assert((SELECT prize_balance=105", " PERFORM set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);\n SET CONSTRAINTS ALL IMMEDIATE;\n SET CONSTRAINTS ALL DEFERRED;\n PERFORM pg_temp.qualifier_assert((SELECT prize_balance=105"),
      ("  INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(session_id,u,now(),now());",
       "  INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,transaction_id,after_terms) SELECT 'club_members',club::text||':'||u::text,club,u,'INSERT',transaction_timestamp()-interval '1 day',txid_current(),to_jsonb(cm) FROM public.club_members cm WHERE cm.club_id=club AND cm.user_id=u;\n  INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(session_id,u,now(),now());"),
      (" INSERT INTO public.tournaments(id,name,buy_in_amount", " INSERT INTO public.club_wallets(id,club_id,chip_balance,period_rake_collected,period_commission_paid,period_bbj_contribution,period_started_at,lifetime_rake_collected,lifetime_commission_paid,lifetime_bbj_contribution,created_at,updated_at,insurance_balance) VALUES(gen_random_uuid(),club,0,0,0,0,now(),0,0,0,now(),now(),0);\n INSERT INTO public.tournaments(id,name,buy_in_amount"),
      ('1..4 LOOP','1..6 LOOP'),('current_players=4','current_players=6'),('4000/survivors','6000/survivors'),('5-i','7-i'),
      ("(r->>'cost')::numeric=26.25","(r->>'cost')::numeric=19"),
      ('prize_balance=105 AND gross_in=105','prize_balance=102.6 AND fee_balance=11.4 AND gross_in=114'),
      ('source_id,target_id,2,50,100,105','source_id,target_id,2,40,80,102.6'),
      ("(r->>'prize_pool')::numeric=105","(r->>'prize_pool')::numeric=102.6"),
      ('sum(ticket_value+remainder_value)=105','sum(ticket_value+remainder_value)=102.6'),
      ("format_contract='mtt-v2' AND max_players IS NULL","format_contract='sng-v1' AND max_players=6"),
      ('count(*)=4-survivors AND count(DISTINCT position)=4-survivors','count(*)=6-survivors AND count(DISTINCT position)=6-survivors'),
      ('sum(amount)=100','sum(amount)=80'),('min(amount)=5 AND min(place)=3','min(amount)=22.6 AND min(place)=3'),
      ('prize_balance=90 AND fee_balance=10','prize_balance=72 AND fee_balance=8'),
      ('prize_out=105','prize_out=102.6'),
      ("CASE WHEN i<=2 THEN 50 WHEN i=3 THEN 5 ELSE 0 END","CASE WHEN i<=2 THEN 40 WHEN i=3 THEN 22.6 ELSE 0 END"),
    ]
    for old,new in changes:
        if old not in probe: raise ValueError('fixed SNG financial scene seam missing: '+old)
        probe=probe.replace(old,new)
    (outputs/'probe.sql').write_text(probe)
    before=e.snapshot(db,'fixed-sng-before-data')
    catalog=e.catalog_snapshot(db,'fixed-sng-before-catalog')
    code,out,err=e.sql(db,file=outputs/'probe.sql',label='fixed-sng-funded-two-seat-finish',seconds=180,check=False)
    (outputs/'stdout.txt').write_text(out);(outputs/'stderr.txt').write_text(err)
    if code: raise RuntimeError('fixed SNG financial settlement refused: '+err[-5000:])
    if 'SATELLITE_QUALIFIERS_NATIVE_PASS' not in out: raise RuntimeError('fixed SNG financial proof missing')
    e.report['fixed_sng_satellite']={'paid_entries_per_scene':6,'gross':114,'fee':11.4,'seat_value':40,'seats':2,'third_place':22.6,'assertions':len(re.findall('NOTICE:  QUALIFIER PASS:',err)),'actual_financial_owners':True}
    if before!=e.snapshot(db,'fixed-sng-after-data') or catalog!=e.catalog_snapshot(db,'fixed-sng-after-catalog'):
        raise RuntimeError('fixed SNG financial scene did not roll back exactly')
    return {str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest()
      for path in [oct_path,helper_path,bust_path,lane_path,reader_path,candidate,source,root/'scripts/ci/fixed_sng_satellite_financial.py',*unit_files]}
