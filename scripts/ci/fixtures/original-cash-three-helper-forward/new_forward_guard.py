"""Exact new forward predicate controls, reused original native PG fixture.

Actual derived snapshot rows exercise key/hash/timestamp predicates. Financial
reader boundaries are explicit native text adapters with exact inverses; these
are not production financial/GEN proofs. Raw hash construction is tested on
separate synthetic12-column rows. No maintained source guard is changed.
"""
import json,re,hashlib

def run(must,call,F):
    m=json.loads((F/'new-forward-native-binding.json').read_text())
    for name,digest in m['files'].items():assert hashlib.sha256((F/name).read_bytes()).hexdigest()==digest,name
    R=F.parents[3]
    for relative,digest in m['source_sha256'].items():assert hashlib.sha256((R/relative).read_bytes()).hexdigest()==digest,relative
    s=(R/m['forward_migration']).read_text();d=json.loads((F/'new-forward-derived-cache-snapshots.json').read_text())
    original_binding=json.loads((F/'source-binding.json').read_text())
    original=(F.parents[3]/'supabase/migrations'/original_binding['migration']).read_text()
    assert hashlib.sha256(original.encode()).hexdigest()==m['original_migration_sha256'],'original6e83source changed'
    assert re.findall(r'\$eight\$(.*?)\$eight\$',s,re.S)==re.findall(r'\$eight\$(.*?)\$eight\$',original,re.S),'full27 original GEN/source guards changed'
    assert s.split('-- BEGIN EXACT THREE OWNERS')[1].split('-- END EXACT THREE OWNERS')[0]==original.split('-- BEGIN EXACT THREE OWNERS')[1].split('-- END EXACT THREE OWNERS')[0]
    assert len(d['current759'])==759 and len(d['old84'])==84
    assert 'b8d99249ccae0bb4fea16d37419c71d9'not in s and '9bec3874c122122649f0775d4bdb0c96'not in s
    assert s.count("version='20261029230502'")==1 and "forward3_superseded_original_already_installed"in s
    assert s.count("version='"+m['forward_version']+"'")==1 and 'UNALLOCATED_FORWARD3_VERSION'not in s
    lit=lambda x:"'"+x.replace("'","''")+"'"
    admission=re.search(r'DO \$forward3_cache_admission\$.*?END \$forward3_cache_admission\$;',s,re.S).group()
    post=re.search(r'DO \$forward3_cache_post\$.*?END \$forward3_cache_post\$;',s,re.S).group()
    paid=re.search(r'DO \$saved_pre\$.*?END\$saved_pre\$;',s,re.S).group()
    goldpaid=json.loads(re.search(r'\$expected\$(.*?)\$expected\$',paid,re.S).group(1))
    # Sole admission fixture adaptation: synthetic[] financial-snapshot digest.
    native40=hashlib.md5(b'[]').hexdigest();assert admission.count('bf419dcc51e70b4275e04c7f452f5ade')==1
    admit=admission.replace('bf419dcc51e70b4275e04c7f452f5ade',native40)
    assert admit.replace(native40,'bf419dcc51e70b4275e04c7f452f5ade')==admission
    # Sole post fixture adapters: controlled derived-after/financial snapshots.
    after=post.replace('pg_temp._forward3_partial_rows()','_native_after ').replace('pg_temp._refresh_paid40()','(SELECT rows FROM _native_current40)')
    assert after.replace('_native_after ','pg_temp._forward3_partial_rows()').replace('(SELECT rows FROM _native_current40)','pg_temp._refresh_paid40()')==post
    schema="CREATE TABLE public.accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz);"
    must(schema)
    def setup(rows):
        return "BEGIN;SET LOCAL timezone='UTC';CREATE TEMP TABLE _forward3_all_cache_before AS SELECT*FROM jsonb_to_recordset("+lit(json.dumps(rows))+"::jsonb)AS p(k text,kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,computed_at timestamptz,full_md5 text,economic_md5 text);CREATE TEMP TABLE _native_after AS SELECT*FROM _forward3_all_cache_before;CREATE TEMP TABLE _forward3_manual40_before AS SELECT'[]'::jsonb rows;CREATE TEMP TABLE _native_current40 AS SELECT'[]'::jsonb rows;CREATE TEMP TABLE _forward_eight_saved AS SELECT "+lit(json.dumps(goldpaid))+"::jsonb paid,'{\"round2_union_window\":{\"count\":84,\"sorted_md5\":\"182c2b06b6d2b48ac32fd391a5882d05\"}}'::jsonb earned;"
    results=[]
    def test(name,before='',failure=None,after_mut='',rows=None):
        sql=setup(rows or d['current759'])+before+paid+admit+after_mut+after+'ROLLBACK;'
        r=call(sql)
        assert (r.returncode==0 if failure is None else r.returncode and failure in r.stdout),(name,r.stdout[:1800]+r.stdout[-500:])
        results.append({'case':name,'passed':True,'expected_refusal':failure})
    test('current-genuine759-derived-cache-admission')
    old={p['k']:p for p in d['old84']};prior=[old.get(p['k'],p)if p['kind']=='earned_plan_window'else p for p in d['current759']]
    test('old84-timestamps-and-fullhashes-allowed-with-identical-golden-economics',rows=prior)
    target=" WHERE kind='earned_plan_window'AND union_id='fade0000-0000-0000-0000-000000000001'AND period_start='2026-10-19 07:00Z'AND window_start='2026-10-19 07:00Z'"
    for name,mut,reason in [
      ('missing-key','DELETE FROM _forward3_all_cache_before'+target,'forward3_exact84_canonical_windows_required'),
      ('duplicate-key','INSERT INTO _forward3_all_cache_before SELECT*FROM _forward3_all_cache_before'+target,'forward3_exact84_canonical_windows_required'),
      ('offgrid-key',"UPDATE _forward3_all_cache_before SET window_start=window_start+interval '1 minute'"+target,'forward3_exact84_canonical_windows_required'),
      ('wrong-window-end',"UPDATE _forward3_all_cache_before SET window_end=window_end+interval '1 minute'"+target,'forward3_exact84_canonical_windows_required'),
      ('economic-payload-or-ID-map-drift',"UPDATE _forward3_all_cache_before SET economic_md5='00000000000000000000000000000000'"+target,'forward3_genuine84_economic_payload_or_maps_changed'),
      ('extra-column','ALTER TABLE accounting_close_partials ADD COLUMN unexpected text','forward3_partial_12_column_contract_changed'),
      ('column-type','ALTER TABLE accounting_close_partials ALTER COLUMN cash_md5 TYPE text','forward3_partial_12_column_contract_changed'),
      ('original-paid-five',"UPDATE _forward_eight_saved SET paid='{}'",'weekly_linked_eight_paid_or_84proofs_changed'),
      ('R2-proof',"UPDATE _forward_eight_saved SET earned='{}'",'weekly_linked_eight_paid_or_84proofs_changed'),
      ('manual40-admission',"UPDATE _forward3_manual40_before SET rows='[1]'",'forward3_manual40_receipts_changed')]:test(name,mut+';',reason)
    for name,mut,reason in [
      ('post-timestamp',"UPDATE _native_after SET computed_at=computed_at+interval '1 second'"+target,'forward3_any_cache_row_or_timestamp_changed'),
      ('post-fullpayload',"UPDATE _native_after SET full_md5='changed'"+target,'forward3_any_cache_row_or_timestamp_changed'),
      ('post-missing-row','DELETE FROM _native_after'+target,'forward3_any_cache_row_or_timestamp_changed'),
      ('post-extra-row','INSERT INTO _native_after SELECT*FROM _native_after'+target,'forward3_any_cache_row_or_timestamp_changed'),
      ('post-unrelated-cache-row',"UPDATE _native_after SET full_md5='changed'WHERE kind<>'earned_plan_window'",'forward3_any_cache_row_or_timestamp_changed'),
      ('post-manual40',"UPDATE _native_current40 SET rows='[1]'",'forward3_manual40_receipts_changed')]:test(name,failure=reason,after_mut=mut+';')
    # Execute exact superseded-history refusal independent of real stats/GEN.
    history=re.search(r" IF EXISTS\(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261029230502'\).*?END IF;",s).group()
    must('CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text);')
    must('BEGIN;DO $$BEGIN '+history+'END$$;ROLLBACK;')
    r=call("BEGIN;INSERT INTO supabase_migrations.schema_migrations VALUES('20261029230502');DO $$BEGIN "+history+'END$$;ROLLBACK;');assert r.returncode and 'forward3_superseded_original_already_installed'in r.stdout;results.append({'case':'superseded-history-must-remain-absent','passed':True})
    own_history=re.search(r" IF EXISTS\(SELECT FROM supabase_migrations.schema_migrations WHERE version='"+re.escape(m['forward_version'])+r"'\).*?END IF;",s).group()
    r=call("BEGIN;INSERT INTO supabase_migrations.schema_migrations VALUES('"+m['forward_version']+"');DO $$BEGIN "+own_history+'END$$;ROLLBACK;');assert r.returncode and 'weekly_linked_eight_replay_refused'in r.stdout;results.append({'case':'new-own-version-replay-refused','passed':True})
    # Actual constructor, separate raw synthetic row: each value/IDs/map matters.
    fn=re.search(r'CREATE FUNCTION pg_temp._forward3_partial_rows\(\).*?\$partial_rows\$;',s,re.S).group()
    seed="INSERT INTO accounting_close_partials VALUES('earned_plan_window','fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-19 09:00Z','{\"value\":1}',ARRAY[]::uuid[],'\\x01',ARRAY[]::uuid[],'\\x02','2026-10-30 05:00Z');"
    for column,value in [('value',"'{\"value\":2}'::jsonb"),('cash_ids',"ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]"),('cash_md5',"'\\x03'::bytea"),('fee_ids',"ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]"),('fee_md5',"'\\x04'::bytea")]:
        must('BEGIN;'+fn+seed+"CREATE TEMP TABLE native_raw_before AS SELECT economic_md5 FROM pg_temp._forward3_partial_rows();UPDATE accounting_close_partials SET "+column+'='+value+";DO $$BEGIN IF(SELECT economic_md5 FROM pg_temp._forward3_partial_rows())IS NOT DISTINCT FROM(SELECT economic_md5 FROM native_raw_before)THEN RAISE EXCEPTION 'raw_hash_mutation_missing';END IF;END$$;ROLLBACK;")
        results.append({'case':'raw-hash-constructor-'+column,'passed':True})
    must('BEGIN;'+fn+seed+"CREATE TEMP TABLE native_raw_before AS SELECT economic_md5,full_md5 FROM pg_temp._forward3_partial_rows();UPDATE accounting_close_partials SET computed_at=computed_at+interval '1 hour';DO $$BEGIN IF(SELECT economic_md5 FROM pg_temp._forward3_partial_rows())IS DISTINCT FROM(SELECT economic_md5 FROM native_raw_before)OR(SELECT full_md5 FROM pg_temp._forward3_partial_rows())IS NOT DISTINCT FROM(SELECT full_md5 FROM native_raw_before)THEN RAISE EXCEPTION 'timestamp_economic_separation_wrong';END IF;END$$;ROLLBACK;")
    results.append({'case':'raw-timestamp-affects-full-not-economic-digest','passed':True})
    # Full-row representation covers ALL12 original fields using the exact maintained constructor.
    full_mutations=[('kind',"'changed'"),('union_id',"'00000000-0000-0000-0000-000000000099'::uuid"),('period_start',"period_start+interval '1 second'"),('period_end',"period_end+interval '1 second'"),('window_start',"window_start+interval '1 second'"),('window_end',"window_end+interval '1 second'"),('value',"'{\"value\":2}'::jsonb"),('cash_ids',"ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]"),('cash_md5',"'\\x03'::bytea"),('fee_ids',"ARRAY['00000000-0000-0000-0000-000000000001']::uuid[]"),('fee_md5',"'\\x04'::bytea"),('computed_at',"computed_at+interval '1 second'")]
    for column,value in full_mutations:
        for suffix,replacement in [('changed',value),('null','NULL')]:
            must('BEGIN;'+fn+seed+"CREATE TEMP TABLE native_raw_before AS SELECT full_md5 FROM pg_temp._forward3_partial_rows();UPDATE accounting_close_partials SET "+column+'='+replacement+";DO $$BEGIN IF(SELECT full_md5 FROM pg_temp._forward3_partial_rows())IS NOT DISTINCT FROM(SELECT full_md5 FROM native_raw_before)THEN RAISE EXCEPTION 'full12_hash_mutation_missing';END IF;END$$;ROLLBACK;")
            results.append({'case':'all12-full-hash-'+column+'-'+suffix,'passed':True})
    for column in ['cash_ids','fee_ids']:
        first="ARRAY['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002']::uuid[]"
        reversed_ids="ARRAY['00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001']::uuid[]"
        must('BEGIN;'+fn+seed+'UPDATE accounting_close_partials SET '+column+'='+first+";CREATE TEMP TABLE native_raw_before AS SELECT economic_md5,full_md5 FROM pg_temp._forward3_partial_rows();UPDATE accounting_close_partials SET "+column+'='+reversed_ids+";DO $$BEGIN IF(SELECT economic_md5 FROM pg_temp._forward3_partial_rows())IS NOT DISTINCT FROM(SELECT economic_md5 FROM native_raw_before)OR(SELECT full_md5 FROM pg_temp._forward3_partial_rows())IS NOT DISTINCT FROM(SELECT full_md5 FROM native_raw_before)THEN RAISE EXCEPTION 'ordered_array_hash_mutation_missing';END IF;END$$;ROLLBACK;")
        results.append({'case':'ordered-array-both-hashes-'+column,'passed':True})
    driver=s.split('BEGIN;',1)[1].rsplit('COMMIT;',1)[0]
    must('BEGIN;CREATE FUNCTION pg_temp.parse_new_forward()RETURNS void LANGUAGE plpgsql AS $parse_new$BEGIN IF false THEN '+driver+' END IF;END;$parse_new$;ROLLBACK;')
    results.append({'case':'full-new-forward-outer-grammar','passed':True})
    for phase in ['pre','post']:
        reader=(F/m['readers'][phase]).read_text()
        reader=reader[reader.index('BEGIN ISOLATION LEVEL'):].split(';',1)[1].rsplit('ROLLBACK;',1)[0]
        must('BEGIN;CREATE FUNCTION pg_temp.parse_new_reader()RETURNS void LANGUAGE plpgsql AS $parse_reader$BEGIN IF false THEN '+reader+' END IF;END;$parse_reader$;ROLLBACK;')
        results.append({'case':phase+'-new-forward-reader-grammar','passed':True})
    return {'cases':results,'allocated_forward_sha256':hashlib.sha256(s.encode()).hexdigest(),'allocated_version':m['forward_version'],'boundary':'Derived actual snapshot predicate controls plus raw synthetic hash constructor; not actual financial/GEN/history qualification','exact_native_text_adapter_inverse':True}
