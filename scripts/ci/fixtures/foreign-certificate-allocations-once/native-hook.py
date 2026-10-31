# Only executed in the maintained isolated PG17 original financial family.
sig='public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)'
old=q("SELECT pg_get_functiondef('"+sig+"'::regprocedure)").stdout
expected=json.loads((R/'scripts/ci/fixtures/foreign-certificate-allocations-once/original-owner.json').read_text())
assert old.strip()==expected['definition'].strip()
# Original family isolates permissions; restore the ACTUAL captured helper ACL.
q('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;')
migration=next((R/'supabase/migrations').glob('*_foreign_certificates_match_their_original_allocations_once.sql'))
text=migration.read_text()
meta_sql="SELECT to_jsonb(p)-'prosrc'-'prosqlbody' FROM pg_proc p WHERE p.oid='"+sig+"'::regprocedure"
meta=q(meta_sql).stdout.strip()
# Compose the actual already-installed index-only prerequisite unchanged.
cover=R/'supabase/migrations/20261027194250_foreign_certificates_read_their_original_cash_cover.sql'
assert hashlib.sha256(cover.read_bytes()).hexdigest()=='c2e733fc24253ee84621638266f1789d5e522c0d4b90d37bf12e2483e1c7faf6'
load(cover)
assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))").stdout.strip()=='154b8afb11b7a9c7617d16fd047c9918'
results.append({'case':'actual-installed194250-cash-cover-composed-unchanged','passed':True})
for label,change,refusal in [('freeze',"UPDATE dr_controls SET frozen=true;",'foreign_certificate_allocations_install_frozen'),('acl',"REVOKE EXECUTE ON FUNCTION "+sig+" FROM service_role;",'foreign_certificate_allocations_original_metadata_changed')]:
 failure=q('BEGIN;'+change+text,check=False)
 assert failure.returncode and refusal in failure.stderr,(label,failure.stderr)
 assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))").stdout.strip()=='154b8afb11b7a9c7617d16fd047c9918'
 assert q(meta_sql).stdout.strip()==meta
 results.append({'case':'allocation-once-installer-'+label+'-refused-atomic','passed':True})
q(text.replace('COMMIT;','ROLLBACK;'))
assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))").stdout.strip()=='154b8afb11b7a9c7617d16fd047c9918'
assert q(meta_sql).stdout.strip()==meta
load(migration)
assert q(meta_sql).stdout.strip()==meta
new=q("SELECT pg_get_functiondef('"+sig+"'::regprocedure)").stdout
assert 'allocation_rows AS MATERIALIZED' in new
replay=q(text,check=False)
assert replay.returncode and 'foreign_certificate_allocations_original_owner_changed' in replay.stderr
post_md5=q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))").stdout.strip()
results.append({'case':'allocation-once-exact-installer-rollback-replay-full-metadata-unchanged','passed':True,'migration_sha256':hashlib.sha256(text.encode()).hexdigest(),'helper_md5':post_md5})
# Source-only function transition; no existing financial owner/pin is changed.
print('ALLOCATION_ONCE_EXACT_INSTALLER_AND_METADATA_PASS',flush=True)
# Independent old/new helper result/error parity on real original paid fixtures.
helper_call="public.fn_standalone_foreign_certificate_periods('club',caw_u('club'),'2026-10-05','2026-10-11','2026-10-05 07:00Z','2026-10-12 07:00Z')"
evaluate="""CREATE OR REPLACE FUNCTION pg_temp.helper_result()RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE r jsonb;BEGIN SELECT jsonb_build_object('accepted',coalesce(jsonb_agg(period_id ORDER BY period_id),'[]'::jsonb))INTO r FROM HELPER_CALL;RETURN r;EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error_state',SQLSTATE);END$$;""".replace('HELPER_CALL',helper_call)
changes=[('unchanged-complete-foreign-cohort',''),
 ('missing-source',"DELETE FROM accounting_cash_rake_sources WHERE id=caw_u('s1');"),
 ('own-null-coordinator',"UPDATE accounting_cash_rake_sources SET coordinator_union_id=NULL WHERE id=caw_u('s1');"),
 ('source-amount-mismatch',"UPDATE accounting_cash_rake_sources SET rake_credit=rake_credit+.01 WHERE id=caw_u('s1');"),
 ('source-record-identity-mismatch',"UPDATE accounting_cash_rake_sources SET rake_record_id=caw_u('different-record')WHERE id=caw_u('s1');")]
for label,expr in [('duplicate-allocation',"source_allocations||jsonb_build_array(source_allocations->0)"),('null-allocation',"source_allocations||'[null]'::jsonb"),('bad-source-uuid',"jsonb_set(source_allocations,'{0,source_id}','\"not-a-uuid\"')"),('invalid-source-kind',"jsonb_set(source_allocations,'{0,source_type}','\"unknown_source\"')"),('rate-outside-range',"jsonb_set(source_allocations,'{0,rate}','1.5')"),('rate-nan',"jsonb_set(source_allocations,'{0,rate}','\"NaN\"')"),('missing-payer-kind',"source_allocations #- '{0,payer_kind}'")]:
 changes.append((label,"UPDATE accounting_rakeback_period_calculations SET source_allocations="+expr+";UPDATE accounting_rakeback_period_calculations SET source_fingerprint=md5(jsonb_build_object('allocations',source_allocations,'rake',rake_generated,'amount',rakeback_amount,'rate',display_rate)::text);"))
for label,change in changes:
 extra="SELECT caw_assert(pg_temp.helper_result()->>'error_state'='22P02','invalidSourceUUIDStillRefuses');"if label=='bad-source-uuid'else''
 q('BEGIN;SELECT zero_seed();'+windows('union','union')+'SELECT '+U2+';SELECT '+U3+';'+change+evaluate+expected['definition']+';CREATE TEMP TABLE helper_before AS SELECT pg_temp.helper_result()result;'+new+';SELECT caw_assert((SELECT result FROM helper_before)=pg_temp.helper_result(),\'originalHelperResultOrErrorParity\');'+extra+'ROLLBACK;')
 results.append({'case':'allocation-once-original-helper-parity-'+label,'passed':True})
 print('PASS allocation-once-original-helper-parity-'+label,flush=True)
