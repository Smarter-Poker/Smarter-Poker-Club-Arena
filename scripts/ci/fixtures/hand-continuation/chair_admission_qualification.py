"""Exact claim response authorization on the same maintained real funding closure."""
from satellite_qualifier_fixture import module
MIGRATION = 'supabase/migrations/20261029170914_original_claim_attests_exact_authorized_chairs.sql'


def qualify(e, root, hand, case, setup, purchase, successor, call, terminal, final, negatives, diamond, snapshot):
    builder = module(root/'scripts/ci/fixtures/hand-continuation/build-chair-admission-claim.py', 'chair_claim_builder')
    migration, pre, post, proof, body, full, changes = builder.render()
    if migration != (root/MIGRATION).read_text(): raise RuntimeError('Chair admission composition drift')
    missing = "DO $$DECLARE r jsonb;BEGIN r:="+call+";IF NOT r ? 'chair_admission' THEN RAISE EXCEPTION 'CHAIR_ADMISSION_MISSING';END IF;END$$;"
    before = snapshot('chair-old-before')
    code, _, error = e.sql(case, 'BEGIN;'+setup+purchase+successor+missing+'ROLLBACK;', label='chair-old-response-regression', check=False)
    if not code or 'CHAIR_ADMISSION_MISSING' not in error or before != snapshot('chair-old-after'):
        raise RuntimeError('Old claim response defect not reproduced:'+error)
    e.sql(case, 'DO $$BEGIN IF ('+proof+") IS DISTINCT FROM false THEN RAISE EXCEPTION 'CHAIR_PROOF_FALSE';END IF;END$$;", label='chair-witness-before')
    wrapper = "BEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n"
    inside = migration.replace(wrapper, "SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';", 1)[:-len('COMMIT;\n')]
    e.sql(case, 'BEGIN;'+inside+'ROLLBACK;', label='chair-install-rollback')
    if before != snapshot('chair-install-after'): raise RuntimeError('Chair installation rollback differs')
    for label, change in [('acl', 'GRANT EXECUTE ON FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) TO anon;'), ('config', 'ALTER FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) SET search_path=public;'), ('body', pre.replace('AS $function$', 'AS $function$\n-- isolated body drift', 1))]:
        clone = e.database(case)
        e.sql(clone, change, label='chair-drift-'+label)
        original = (e.snapshot(clone,'chair-drift-data-before'), e.catalog_snapshot(clone,'chair-drift-catalog-before'), hand.private_snapshot(e,clone,'chair-drift-private-before'))
        code, _, error = e.sql(clone, file=root/MIGRATION, label='chair-install-refuse-'+label, check=False)
        after = (e.snapshot(clone,'chair-drift-data-after'), e.catalog_snapshot(clone,'chair-drift-catalog-after'), hand.private_snapshot(e,clone,'chair-drift-private-after'))
        if not code or 'HAND_CONTINUATION_CHAIR_PREIMAGE_CHANGED' not in error or original != after: raise RuntimeError('Chair installation drift not refused:'+label+error)
        e.discard(clone)
    e.sql(case, file=root/MIGRATION, label='chair-exact-install')
    e.sql(case, 'DO $$BEGIN IF ('+proof+") IS DISTINCT FROM true THEN RAISE EXCEPTION 'CHAIR_PROOF_TRUE';END IF;END$$;", label='chair-witness-after')
    reverse = "pg_get_functiondef('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure)"
    for i, (old, new) in enumerate(reversed(changes)): reverse = 'replace('+reverse+',$new'+str(i)+'$'+new+'$new'+str(i)+'$,$old'+str(i)+'$'+old+'$old'+str(i)+'$)'
    e.sql(case, 'DO $$BEGIN IF '+reverse+' IS DISTINCT FROM $pre$'+pre+"$pre$ THEN RAISE EXCEPTION 'CHAIR_UNRELATED_FUNCTION_BYTES_CHANGED';END IF;END$$;", label='chair-reverse-exact-owner')
    checks = """DO $checks$DECLARE prior text; digest text; expected jsonb; r jsonb; again jsonb;
BEGIN
 SELECT hc.payload,hc.payload_sha256 INTO prior,digest FROM smarter_private.hand_continuations hc;
 SELECT jsonb_build_object('version',1,'tournament_id','86000000-0000-0000-0000-000000000001',
  'table_id','86100000-0000-0000-0000-000000000001','writer_generation','86500000-0000-0000-0000-000000000002',
  'original_generation',prior::jsonb#>>'{original,lease_generation}',
  'hand_number','8600001','sequence','1','payload_sha256',digest,
  'seats',jsonb_agg(jsonb_build_object('user_id',x->>'user_id','seat_id',x->>'seat_id',
   'seat_joined_at',x->>'seat_joined_at','stack_before',(x->>'stack_before')::numeric,
   'authorized_stack',s.stack) ORDER BY ordinal)) INTO expected
 FROM jsonb_array_elements(prior::jsonb->'seats') WITH ORDINALITY a(x,ordinal)
 JOIN public.table_seats s ON s.id::text=x->>'seat_id';
 r:="""+call+""";
 IF r->'chair_admission' IS DISTINCT FROM expected OR r#>>'{continuation,payload}' IS DISTINCT FROM prior
  OR r#>>'{continuation,sha256}' IS DISTINCT FROM digest THEN RAISE EXCEPTION 'CHAIR_ATTESTATION_INEXACT';END IF;
 again:="""+call+""";
 IF again IS DISTINCT FROM r THEN RAISE EXCEPTION 'CHAIR_REPLAY_CHANGED';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(r#>'{chair_admission,seats}') x
  WHERE (x->>'authorized_stack')::numeric-(x->>'stack_before')::numeric=10000)<>1
  OR (SELECT payload FROM smarter_private.hand_continuations WHERE hand_number=8600001) IS DISTINCT FROM prior
  OR (SELECT payload_sha256 FROM smarter_private.hand_continuations WHERE hand_number=8600001) IS DISTINCT FROM digest
 THEN RAISE EXCEPTION 'CHAIR_BASELINE_OR_PAYLOAD_REWRITTEN';END IF;
END $checks$;"""
    for label, evidence in [('chips', ''), ('diamonds', diamond)]:
        before = snapshot('chair-'+label+'-before')
        e.sql(case, 'BEGIN;'+setup+purchase+evidence+successor+checks+terminal+final+'ROLLBACK;', label='chair-'+label+'-funded-exact-atomic-once')
        if before != snapshot('chair-'+label+'-after'): raise RuntimeError('Chair funded proof rollback differs:'+label)
    for label, mutation in negatives:
        corrupt = 'SET LOCAL session_replication_role=replica;UPDATE public.tournament_participant_funding_receipts SET '+mutation+';SET LOCAL session_replication_role=origin;'
        before = snapshot('chair-negative-'+label+'-before')
        code, _, error = e.sql(case, 'BEGIN;'+setup+purchase+corrupt+successor+'SELECT '+call+';ROLLBACK;', label='chair-negative-'+label, check=False)
        if not code or 'HAND_CONTINUATION_ROSTER_CHANGED' not in error or before != snapshot('chair-negative-'+label+'-after'): raise RuntimeError('Chair funding negative admitted:'+label+error)
    for label, mutation, invocation in [
        ('unfunded', 'SET LOCAL session_replication_role=replica;DELETE FROM public.tournament_participant_funding_receipts;SET LOCAL session_replication_role=origin;', call),
        ('chair-identity', "SET LOCAL session_replication_role=replica;UPDATE public.table_seats SET joined_at=joined_at+interval '1 microsecond' WHERE id='86300000-0000-0000-0000-000000000001';SET LOCAL session_replication_role=origin;", call),
        ('stale-generation', '', call.replace('86500000-0000-0000-0000-000000000002', '86500000-0000-0000-0000-000000000001')),
        ('duplicate-roster', "SET LOCAL session_replication_role=replica;UPDATE smarter_private.hand_continuations SET payload=jsonb_set(payload::jsonb,'{seats}',jsonb_build_array(payload::jsonb#>'{seats,0}',payload::jsonb#>'{seats,0}'))::text;SET LOCAL session_replication_role=origin;", call),
    ]:
        before = snapshot('chair-fence-'+label+'-before')
        code, _, error = e.sql(case, 'BEGIN;'+setup+purchase+mutation+successor+'SELECT '+invocation+';ROLLBACK;', label='chair-fence-'+label, check=False)
        if not code or before != snapshot('chair-fence-'+label+'-after'): raise RuntimeError('Chair fence admitted/changed data:'+label+error)
    e.report['chair_admission'] = {'passed': True, 'old_missing_response_reproduced': True, 'same_statement_authorization_projection': True, 'unchanged_complete_financial_predicate': True, 'chips_and_diamonds_atomic_once': True, 'same_original_payload_hash_baseline': True, 'canonical_claim_envelope_exact': True, 'negative_funding_cases': [x[0] for x in negatives], 'fences': ['unfunded','chair-identity','stale-generation','duplicate-roster'], 'installation_refusals': 3, 'complete_rollback': True, 'post_body_md5': body, 'post_full_md5': full}
