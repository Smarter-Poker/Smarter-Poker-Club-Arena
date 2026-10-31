#!/usr/bin/env python3
"""Real PostgreSQL creation/format/fee/refund/idempotency boundaries; no live chips."""
import os, pathlib, subprocess, tempfile, socket, json
root=pathlib.Path(__file__).resolve().parents[2]
pg=pathlib.Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
parent=os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent: raise RuntimeError('Set TMPDIR to owned SSD scratch')
def definition(file,name):
    text=(root/'supabase/migrations'/file).read_text()
    plain='CREATE FUNCTION public.'+name+'('
    replaced='CREATE OR REPLACE FUNCTION public.'+name+'('
    start=text.index(plain if plain in text else replaced)
    end=text.index('$function$;',start)+len('$function$;')
    return text[start:end]
with tempfile.TemporaryDirectory(prefix='sng-satellite-',dir=parent) as folder:
    scratch=pathlib.Path(folder)
    def run(tool,*args,input=None,check=True):
        return subprocess.run([str(pg/tool),*args],input=input,text=True,capture_output=True,check=check)
    run('initdb','-D',str(scratch/'data'),'-A','trust','--no-locale','-E','UTF8')
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0));port=str(reserve.getsockname()[1])
    run('pg_ctl','-D',str(scratch/'data'),'-l',str(scratch/'server.log'),'-o',f'-k {parent} -p {port} -h 127.0.0.1','start')
    try:
        def sql(source,check=True):
            result=run('psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-d','postgres',input=source,check=False)
            if check and result.returncode: raise RuntimeError(result.stderr)
            return result.stdout.strip(),result.stderr,result.returncode
        sql('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
          CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
          CREATE TABLE tournaments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,union_id uuid,name text,
            game_type text,variant text,tournament_type text,buy_in_amount numeric,buy_in_fee numeric,
            guaranteed_prize numeric,starting_chips integer,max_players integer,min_players integer,table_size integer,
            current_players integer,status text,blind_structure text,blind_speed text,is_turbo boolean,payout_structure text,
            start_time timestamptz,late_reg_levels integer,late_reg_mins integer,satellite_target_id uuid,satellite_target uuid,
            satellite_seats integer,synchronized_breaks boolean,is_rebuy boolean,is_reentry boolean,add_on_available boolean,
            max_rebuys integer,max_reentries integer,short_description text,schedule_id uuid,format_contract text);
          CREATE FUNCTION fn_ca_lock_mtt_admission_contract() RETURNS text LANGUAGE sql AS $$SELECT 'unlimited-mtt-v2'::text$$;
          CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
          CREATE FUNCTION fn_ca_satellite_target_accepts_new_feeder(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
''')
        sql(definition('20260917065000_mtt_dual_creation_preparation.sql','fn_ca_is_new_mtt'))
        sql(definition('20260917060000_mtt_persisted_format_preparation.sql','fn_ca_legacy_tournament_format'))
        sql(definition('20260917065000_mtt_dual_creation_preparation.sql','fn_ca_new_tournament_is_unlimited'))
        sql(definition('20260917065000_mtt_dual_creation_preparation.sql','fn_ca_normalize_new_mtt_capacity'))
        sql(definition('20260914005233_tournament_blind_structure_contract.sql','fn_ca_blind_contract_number'))
        sql(definition('20260914005233_tournament_blind_structure_contract.sql','fn_ca_mtt_blind_contract'))
        raw={ 'tournament_type':'SNG','variant':'sng','max_players':9,'min_players':9,'table_size':9,'satellite_seats':2,'satellite_target_id':'00000000-0000-4000-8000-000000000001' }
        assert sql("SELECT fn_ca_is_new_mtt('"+json.dumps(raw)+"'::jsonb)")[0]=='t', 'baseline must lose the fixed field'
        candidate=(root/'supabase/migrations/20261028163610_two_seat_fixed_field_sng_satellites.sql').read_text()
        # This small fixture qualifies the actual creator and format transaction.
        # The required full financial fixture separately executes this entire migration.
        start=candidate.index('-- FIXED_SNG_COHORT_SCOPE_BEGIN')
        end=candidate.index('-- FIXED_SNG_COHORT_SCOPE_END')+len('-- FIXED_SNG_COHORT_SCOPE_END')
        sql(candidate[:start]+candidate[end:])
        assert sql("SELECT fn_ca_is_new_mtt('"+json.dumps(raw)+"'::jsonb), fn_ca_legacy_tournament_format('"+json.dumps(raw)+"'::jsonb)")[0]=='f|sng-v1'
        # Both production BEFORE INSERT functions run, including capacity normalization.
        sql(definition('20260917065000_mtt_dual_creation_preparation.sql','fn_ca_guard_tournament_format'))
        sql("CREATE TRIGGER a_capacity BEFORE INSERT ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_normalize_new_mtt_capacity(); CREATE TRIGGER z_recorded BEFORE INSERT ON tournaments FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_tournament_format();")
        target='00000000-0000-4000-8000-000000000001'
        owner='fade0000-0000-0000-0000-000000000001'
        sql(f'''INSERT INTO tournaments(id,club_id,union_id,name,game_type,tournament_type,variant,buy_in_amount,buy_in_fee,status,start_time,blind_structure)
          VALUES('{target}','{owner}','{owner}','Forty Chip Event','NLH','MTT','freezeout',36,4,'REGISTERING',now()+interval '1 day',
          '[{{"level":1,"smallBlind":25,"bigBlind":50,"durationMinutes":8}}]');''')
        prefix="SET request.jwt.claim.role='service_role'; "
        for seats,expected_entry,expected_third in [(6,19,22.6),(9,12,17.2)]:
            command=f"SELECT fn_ensure_fixed_sng_satellite('{target}',{seats});"
            result=json.loads(sql(prefix+command)[0]); assert result['created'] is True,result
            assert result['entry']==expected_entry and result['fee']==expected_entry/10,result
            assert result['third_place']==expected_third,result
            assert json.loads(sql(prefix+command)[0])['tournament_id']==result['tournament_id'], 'duplicate must reuse original'
            assert json.loads(sql(prefix+command)[0])['created'] is False
            persisted=sql(f"SELECT concat_ws(',',max_players,min_players,table_size,satellite_seats,format_contract,is_rebuy,add_on_available) FROM tournaments WHERE id='{result['tournament_id']}';")[0]
            assert persisted==f'{seats},{seats},{seats},2,sng-v1,f,f',persisted
        sql("UPDATE tournaments SET min_players=NULL WHERE satellite_target_id IS NOT NULL AND max_players=9;")
        refused=sql(prefix+f"SELECT fn_ensure_fixed_sng_satellite('{target}',9)",False)
        assert refused[2]!=0 and 'EXISTING_CONTRACT_MISMATCH' in refused[1], 'nullable prior field must refuse'
        sql("UPDATE tournaments SET min_players=9 WHERE satellite_target_id IS NOT NULL AND max_players=9;")
        assert sql("SELECT count(*) FROM tournaments WHERE satellite_target_id IS NOT NULL")[0]=='2'
        assert sql(f"SELECT fn_ensure_fixed_sng_satellite('{target}',9)",False)[2]!=0,'unprivileged caller refused'
        assert sql(prefix+f"SELECT fn_ensure_fixed_sng_satellite('{target}',7)",False)[2]!=0,'invalid field refused'
        assert sql(prefix+"BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT fn_ensure_fixed_sng_satellite('"+target+"',9);",False)[2]!=0,'repeatable snapshot refused'
        assert sql("SET ROLE authenticated; SELECT fn_ensure_fixed_sng_satellite('"+target+"',9);",False)[2]!=0,'browser execution permission refused'
        sql("DELETE FROM tournaments WHERE satellite_target_id IS NOT NULL;")
        command=prefix+f"SELECT fn_ensure_fixed_sng_satellite('{target}',9);"
        processes=[]
        for _ in range(2):
            process=subprocess.Popen([str(pg/'psql'),'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            process.stdin.write(command);process.stdin.close();process.stdin=None;processes.append(process)
        receipts=[]
        for process in processes:
            out,err=process.communicate();assert process.returncode==0,err;receipts.append(json.loads(out))
        assert receipts[0]['tournament_id']==receipts[1]['tournament_id'],'concurrent creation must have one identity'
        assert sorted(r['created'] for r in receipts)==[False,True]
        assert sql("SELECT count(*) FROM tournaments WHERE satellite_target_id IS NOT NULL")[0]=='1'
        sql(f"UPDATE tournaments SET buy_in_amount=18,buy_in_fee=2 WHERE id='{target}';")
        assert json.loads(sql(prefix+f"SELECT fn_ensure_fixed_sng_satellite('{target}',6)")[0])['reason']=='target_price_ineligible'
        # More price points, including the explicit 25-chip daily exception.
        for ticket in [25,30,35,50,75,100,200,500]:
            sql(f"DELETE FROM tournaments WHERE satellite_target_id IS NOT NULL; UPDATE tournaments SET buy_in_amount={ticket}*0.9,buy_in_fee={ticket}*0.1,schedule_id='a70c1028-1800-2500-9000-000000000001' WHERE id='{target}';")
            for seats in [6,9]:
                receipt=json.loads(sql(prefix+f"SELECT fn_ensure_fixed_sng_satellite('{target}',{seats})")[0])
                expected=(20*ticket+(9*seats-10)-1)//(9*seats-10)
                assert receipt['entry']==expected and receipt['fee']==expected/10,receipt
                remainder=seats*expected*90-2*ticket*100
                assert receipt['third_place']==remainder/100 and remainder>=expected*100,receipt
                assert remainder<ticket*100,'never award a third seat instead of the refund'
        sql(f"UPDATE tournaments SET game_type='PLO6' WHERE id='{target}';")
        assert json.loads(sql(prefix+f"SELECT fn_ensure_fixed_sng_satellite('{target}',9)")[0])['reason']=='target_unavailable','nine-handed six-card Omaha refused'
        print('PASS: real creation, fixed formats, exact10% rake, two seats plus full refund/residue, duplicate identity and refusal boundaries')
    finally:
        run('pg_ctl','-D',str(scratch/'data'),'-m','immediate','stop')
