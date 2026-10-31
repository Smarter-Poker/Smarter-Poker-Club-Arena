"""Real private-capsule attestation is read-only and requires frozen custody."""
MIGRATION = 'supabase/migrations/20261029093051_attest_frozen_original_hand_continuation_custody.sql'


def qualify(e, root, hand, db):
    case = e.database(db)
    source = (root / MIGRATION).read_text()
    proof = source.split('-- @live-proof: ', 1)[1].splitlines()[0]
    probe = (root / 'scripts/ci/probes/hand-continuation-native.sql').read_text()
    prefix = probe[:probe.index('DO $boundaries$')]
    context = """SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('app.smarter_data_actor','tournament-manager',true);
SELECT set_config('app.smarter_tournament_id','86000000-0000-0000-0000-000000000001',true);
SELECT set_config('app.smarter_tournament_lease_generation','86500000-0000-0000-0000-000000000001',true);
"""
    call = """public.fn_f06_attest_frozen_hand_continuation(
'86000000-0000-0000-0000-000000000001','86500000-0000-0000-0000-000000000001',
'86100000-0000-0000-0000-000000000001',8600001,0,
(SELECT payload_sha256 FROM smarter_private.hand_continuations))"""
    freeze = """INSERT INTO public.engine_maintenance_break
(id,phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token)
VALUES(true,'counting_down',clock_timestamp()-interval '3 minutes',
clock_timestamp()-interval '1 minute',clock_timestamp()+interval '4 minutes',true,
'86800000-0000-0000-0000-000000000001');"""

    def snapshot(label):
        return (e.snapshot(case, label+'-data'), e.catalog_snapshot(case, label+'-catalog'),
                hand.private_snapshot(e, case, label+'-private'))

    def refused(label, mutation, expected, expression=call, actor=context):
        before = snapshot(label+'-before')
        code, _, error = e.sql(case, 'BEGIN;'+mutation+actor+'SELECT '+expression+';ROLLBACK;',
                               label='attestation-refusal-'+label, check=False)
        if not code or expected not in error or before != snapshot(label+'-after'):
            raise RuntimeError('Frozen attestation refusal/rollback failed: '+label+' '+error)

    try:
        before = snapshot('attestation-install-before')
        e.sql(case, "DO $$BEGIN IF ("+proof+") IS DISTINCT FROM false THEN RAISE EXCEPTION 'ATTESTATION_WITNESS_FALSE_BEFORE';END IF;END$$;", label='attestation-catalog-witness-before')
        # The old server has no native frozen read door; its claim owner
        # correctly refuses to write in a freeze. The new door is distinct.
        code, _, error = e.sql(case, 'SELECT '+call+';', label='attestation-old-door-absent', check=False)
        if not code or 'does not exist' not in error:
            raise RuntimeError('Missing old attestation door was not reproduced')
        inside = source.replace('BEGIN;', '', 1).rsplit('COMMIT;', 1)[0]
        e.sql(case, 'BEGIN;'+inside+'ROLLBACK;', label='attestation-install-full-rollback')
        if before != snapshot('attestation-install-after'):
            raise RuntimeError('Frozen attestation installation rollback changed state')
        e.sql(case, file=root/MIGRATION, label='attestation-exact-source-install')
        e.sql(case, "DO $$BEGIN IF ("+proof+") IS DISTINCT FROM true THEN RAISE EXCEPTION 'ATTESTATION_WITNESS_TRUE_AFTER';END IF;END$$;", label='attestation-catalog-witness-after')
        e.sql(case, "DO $$BEGIN IF has_function_privilege('service_role','smarter_private.attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text)','execute') OR has_function_privilege('anon','smarter_private.attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text)','execute') OR has_function_privilege('authenticated','smarter_private.attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text)','execute') THEN RAISE EXCEPTION 'PRIVATE_ATTESTATION_KERNEL_EXPOSED';END IF;END$$;", label='attestation-private-kernel-role-denials')
        e.sql(case, 'BEGIN;'+(e.output/'opening.sql').read_text()+prefix+
              'SELECT pg_temp.retain_continuation(0);'+freeze+'COMMIT;',
              label='attestation-real-original-frozen-opening')
        # Resolve the digest as the fixture owner, then call as the actual
        # service role in a PostgreSQL READ ONLY transaction. Private SELECT
        # remains forbidden to that caller.
        _, digest, _ = e.sql(case, 'SELECT payload_sha256 FROM smarter_private.hand_continuations;',
                              label='attestation-fixture-digest')
        digest = digest.strip()
        if len(digest) != 64:
            raise RuntimeError('Frozen attestation fixture digest invalid')
        service_call = call.replace('(SELECT payload_sha256 FROM smarter_private.hand_continuations)',
                                    "'"+digest+"'")
        before = snapshot('attestation-read-before')
        _, output, _ = e.sql(case, 'BEGIN READ ONLY;'+context+'SET LOCAL ROLE service_role;SELECT '+
            service_call+";COMMIT;", label='attestation-real-service-read-only')
        import json
        answers = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        if len(answers) != 1:
            raise RuntimeError('Frozen attestation reply missing')
        answer = answers[0]
        expected_keys = {'ok','frozen','tournament_id','writer_generation','table_id','hand_number',
            'sequence','sha256','permit_id','original_generation','lifecycle','custody_id',
            'controller_sha256','announced_at','break_started_at','break_ends_at'}
        if (set(answer) != expected_keys or answer['ok'] is not True or answer['frozen'] is not True
                or answer['sha256'] != digest or answer['hand_number'] != '8600001'
                or answer['sequence'] != '0' or 'private-controller' in output):
            raise RuntimeError('Frozen attestation metadata/privacy failed')
        if before != snapshot('attestation-read-after'):
            raise RuntimeError('Frozen read attestation changed catalog/data/custody')
        refused('missing-freeze', 'DELETE FROM public.engine_maintenance_break;',
                'HAND_CONTINUATION_ATTESTATION_REQUIRES_FREEZE')
        refused('expired-freeze', "UPDATE public.engine_maintenance_break SET break_ends_at=clock_timestamp()-interval '1 second';",
                'HAND_CONTINUATION_ATTESTATION_REQUIRES_FREEZE')
        refused('wrong-sequence', '', 'HAND_CONTINUATION_ATTESTATION_CAPSULE_CHANGED',
                call.replace('8600001,0,', '8600001,1,'))
        refused('wrong-digest', '', 'HAND_CONTINUATION_ATTESTATION_CAPSULE_CHANGED',
                call.replace('(SELECT payload_sha256 FROM smarter_private.hand_continuations)', "repeat('0',64)"))
        refused('missing-capsule', '', 'HAND_CONTINUATION_ATTESTATION_CAPSULE_CHANGED',
                call.replace('8600001,0,', '8600002,0,'))
        refused('wrong-writer', "UPDATE smarter_private.hand_continuations SET writer_generation=md5('other-writer')::uuid;",
                'HAND_CONTINUATION_ATTESTATION_CAPSULE_CHANGED')
        refused('corrupt-payload', "UPDATE smarter_private.hand_continuations SET payload=payload||' ';",
                'HAND_CONTINUATION_ATTESTATION_CAPSULE_CHANGED')
        refused('stale-lease', "UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds';",
                'F06_LEASE_FENCED')
        refused('wrong-actor', '', 'F06_PROTOCOL2_REQUIRED', actor=context.replace("'tournament-manager'", "'engine'"))
        refused('changed-original-binding', """UPDATE smarter_private.hand_continuations
SET payload=jsonb_set(payload::jsonb,'{original,lifecycle}','"999"'::jsonb)::text;
UPDATE smarter_private.hand_continuations SET payload_sha256=encode(extensions.digest(payload,'sha256'),'hex');""",
                'HAND_CONTINUATION_ATTESTATION_BINDING_CHANGED')
        refused('accepted-permit', """ALTER TABLE smarter_private.f06_hand_permits DISABLE TRIGGER f06_retained_submission_guard;
UPDATE smarter_private.f06_hand_permits SET state='accepted',evidence_id=permit_id;""",
                'HAND_CONTINUATION_ATTESTATION_ORIGINAL_UNPROVEN')
        refused('later-permit', """INSERT INTO smarter_private.f06_hand_permits
(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state)
SELECT md5('later-permit')::uuid,tournament_id,table_id,lifecycle,hand_number+1,custody_id,generation,'never_started'
FROM smarter_private.f06_hand_permits;""", 'HAND_CONTINUATION_ATTESTATION_ORIGINAL_UNPROVEN')
        for role in ('anon', 'authenticated'):
            refused('public-role-'+role, '', 'permission denied for function',
                    expression=service_call, actor=context+'SET LOCAL ROLE '+role+';')
        e.report['frozen_original_attestation'] = {'passed': True, 'old_door_missing': True,
            'real_service_read_only_transaction': True, 'metadata_only': True,
            'full_public_private_data_catalog_unchanged': True, 'negative_cases': 14,
            'installation_full_rollback': True}
    finally:
        e.discard(case)
