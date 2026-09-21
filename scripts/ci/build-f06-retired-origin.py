"""Compose the absent-row owner without replacing the original financial proof."""
from pathlib import Path
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = 'supabase/migrations/20260919024642_retired_original_managers_retain_authority_without_restoring.sql'
AUTHORITY = 'scripts/ci/probes/f06-retired-origin-authority.sql'
COHORTS = 'scripts/ci/probes/f06-retired-origin-cohorts.json'
RETAINED = 'scripts/ci/probes/f06-shared-hand-lane/retained-mtt-authority.sql'
MIXED = 'scripts/ci/probes/f06-mixed-custody-authority.sql'


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('retired origin composition anchor drift: ' + before)
    return text.replace(before, after, 1)


def definition(source, name, delimiter):
    return re.search(r'CREATE FUNCTION ' + re.escape(name) + r'\(.*?' +
                     re.escape(delimiter) + r'.*?' + re.escape(delimiter) + ';', source, re.S)[0]


def render(root=ROOT):
    retained = (root / RETAINED).read_text()
    mixed = (root / MIXED).read_text()
    original = definition(retained, 'smarter_private.f06_retained_mtt_abort_snapshot', '$function$')
    disposition = definition(retained, 'public.fn_f06_abort_retained_mtt_hands', '$function$')
    prepare = definition(mixed, 'public.fn_f06_prepare_mixed_manager_custody', '$$')
    catalogue = definition(mixed, 'public.fn_f06_mixed_custody_contract', '$$')
    pins = ''
    for sql, signature, delimiter in [
        (original, 'smarter_private.f06_retained_mtt_abort_snapshot(jsonb)', '$function$'),
        (disposition, 'public.fn_f06_abort_retained_mtt_hands(uuid,jsonb)', '$function$'),
        (prepare, 'public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)', '$$'),
        (catalogue, 'public.fn_f06_mixed_custody_contract()', '$$'),
    ]:
        body = sql.split(delimiter)[1]
        acl = '{postgres=X/postgres}' if signature.startswith('smarter_private.') else '{postgres=X/postgres,service_role=X/postgres}'
        config = 'search_path=pg_catalog' if signature == 'public.fn_f06_mixed_custody_contract()' else 'search_path=pg_catalog, public, smarter_private'
        pins += f"IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('{signature}') AND md5(prosrc)='{hashlib.md5(body.encode()).hexdigest()}' AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{acl}' AND proconfig=ARRAY['{config}']) THEN RAISE EXCEPTION 'F06_RETIRED_DEPENDENCY_DRIFT: {signature}'; END IF;\n"
    cohort = "CREATE FUNCTION smarter_private.f06_retired_origin_cohort(t uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $cohort$ SELECT $data$" + json.dumps(json.loads((root / COHORTS).read_text()), separators=(',', ':'), sort_keys=True) + "$data$::jsonb->t::text $cohort$;\nREVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_cohort(uuid) FROM PUBLIC,anon,authenticated,service_role;\n"
    # Clone the complete retained-hand proof. Only its owning authority changes;
    # roster, paid continuity, snapshots, unknown submissions and mixed rows do not.
    clone = once(original, 'f06_retained_mtt_abort_snapshot', 'f06_retired_origin_snapshot')
    for anchor in [' SELECT * INTO lease FROM public.engine_tournament_leases', ' PERFORM smarter_private.f06_try_lane(t);']:
        if clone.count(anchor) != 1:
            raise ValueError('retired origin authority boundary drift: ' + anchor)
    lease_start = clone.index(' SELECT * INTO lease FROM public.engine_tournament_leases')
    lease_end = clone.index(' PERFORM smarter_private.f06_try_lane(t);', lease_start)
    clone = clone[:lease_start] + ' PERFORM smarter_private.f06_retired_origin_begin(p_input);\n' + clone[lease_end:]
    clone = once(clone, "physical->>'instance_id' IS DISTINCT FROM lease.instance_id", "physical->>'instance_id' IS DISTINCT FROM '1-3846b8bb'")
    clone = once(clone, "physical->>'source' IS DISTINCT FROM lease.engine_version", "physical->>'source' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d'")
    clone = once(clone, "'lease',to_jsonb(lease)", "'lease',NULL")
    clone += '\nREVOKE ALL ON FUNCTION smarter_private.f06_retired_origin_snapshot(jsonb) FROM PUBLIC,anon,authenticated,service_role;\n'
    patched = once(original, 'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    patched = once(patched, ' SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;',
        " PERFORM smarter_private.f06_retired_origin_lock(t);\n SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;\n IF NOT FOUND AND p_input ? 'retired_origin_id' THEN RETURN smarter_private.f06_retired_origin_disposition(p_input); END IF;")
    disposition = once(disposition, 'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    disposition = once(disposition, " PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));", " IF p_expected ? 'retired_origin_id' AND (p_expected->>'retired_origin_id')::uuid IS DISTINCT FROM p_receipt_id THEN RAISE EXCEPTION 'F06_RETIRED_OPERATION_CHANGED'; END IF;\n PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));")
    prepare = once(prepare, 'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    prepare = once(prepare, 'DECLARE l public.engine_tournament_leases;', 'DECLARE retired_origin boolean:=false; l public.engine_tournament_leases;')
    prepare = once(prepare, ' SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR UPDATE;',
        " PERFORM smarter_private.f06_retired_origin_lock(p_tournament_id);\n SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR UPDATE;\n IF NOT FOUND AND checkpoint IS NOT NULL AND EXISTS(SELECT 1 FROM smarter_private.f06_retired_manager_origins WHERE tournament_id=p_tournament_id AND origin_generation=p_origin_generation) THEN retired_origin:=true;\n ELSE")
    prepare = once(prepare, "THEN RAISE EXCEPTION 'F06_MIXED_OLD_PROCESS_CHANGED'; END IF;", "THEN RAISE EXCEPTION 'F06_MIXED_OLD_PROCESS_CHANGED'; END IF;\n END IF;")
    prepare = once(prepare, ' canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);',
        ' canonical:=smarter_private.f06_mixed_custody_snapshot(p_tournament_id,p_origin_generation,p_local);\n IF retired_origin THEN PERFORM smarter_private.f06_retired_origin_transfer(p_tournament_id,p_origin_generation,p_local,canonical); END IF;')
    catalogue = once(catalogue, 'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    additions = [
        'public.fn_f06_attest_retired_manager_origin(uuid,jsonb,jsonb)',
        'smarter_private.f06_retired_origin_cohort(uuid)',
        'smarter_private.f06_retired_origin_lock(uuid)',
        'smarter_private.f06_retired_origin_begin(jsonb)',
        'smarter_private.f06_retired_origin_snapshot(jsonb)',
        'smarter_private.f06_retired_origin_disposition(jsonb)',
        'smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb)',
        'smarter_private.f06_retired_origin_claim_guard()',
        'smarter_private.f06_retained_mtt_abort_snapshot(jsonb)',
        'public.fn_f06_abort_retained_mtt_hands(uuid,jsonb)',
    ]
    catalogue = once(catalogue, "('public.fn_f06_mixed_custody_contract()')", "('public.fn_f06_mixed_custody_contract()'),\n " + ',\n '.join("('" + s + "')" for s in additions))
    prefix = "-- Exact retired original custody; no lease is inserted or resurrected.\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='15s';\nDO $pins$ BEGIN\n" + pins + "END $pins$;\n"
    return prefix + cohort + (root / AUTHORITY).read_text() + '\n' + clone + '\n' + patched + '\n' + disposition + '\n' + prepare + '\n' + catalogue + '\nCOMMIT;\n'


if __name__ == '__main__':
    rendered = render()
    if '--check' in sys.argv:
        if (ROOT / MIGRATION).read_text() != rendered:
            raise SystemExit('Retired origin migration source changed')
    else:
        (ROOT / MIGRATION).write_text(rendered)
