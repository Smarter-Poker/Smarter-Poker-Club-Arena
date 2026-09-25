"""Compose the one original pruned EarlyBird witness into the existing owner."""
from pathlib import Path
import hashlib
import json
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MIGRATION = 'supabase/migrations/20260918232101_earlybird_original_projected_evidence_retains_truthful_dispo.sql'
PREDECESSOR = 'supabase/migrations/20260918154419_interrupted_hands_preserve_original_custody_without_inventin.sql'
WITNESS = 'earlybird-original-projected-witness.json'


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Exact predecessor boundary changed: ' + old)
    return source.replace(old, new)


def render():
    source = (ROOT / PREDECESSOR).read_text()
    if hashlib.sha256(source.encode()).hexdigest() != 'ec4a769216b89225e6542cdc50c0a51a675872e85cbaae089ca9d87d6ee782d4':
        raise ValueError('Original interrupted custody predecessor changed')
    witness = json.loads((HERE / WITNESS).read_text())
    # This is a source-bound historical observation, not a caller-supplied
    # substitute snapshot and not a reconstruction of missing state_json.
    declaration = """snapshot_absent_spin boolean;
 pruned_snapshot boolean; snapshot_projection jsonb;
 original_pruned_witness CONSTANT jsonb := $earlybird_original$%s$earlybird_original$::jsonb;""" % json.dumps(witness, indent=2)
    source = replace_once(source, 'snapshot_absent_spin boolean;', declaration)
    source = replace_once(source, "md5(pg_get_functiondef(oid))='4415d0e65aec71ecff0e0db366364ecb'", "md5(pg_get_functiondef(oid))='483b508311d233d3da73e55db17499ce'")
    source = replace_once(source, ' prior_proof:=NULL; historical:=NULL;', """ prior_proof:=NULL; historical:=NULL; snapshot_projection:=NULL;
 pruned_snapshot:=COALESCE(expected_item#>>'{interruption,kind}'='pruned_completed_unaccepted_mtt',false);""")
    old = " END IF;\n IF snap.id IS NOT NULL THEN\n known_started:=known_started+1;"
    new = """ END IF;
 IF pruned_snapshot THEN
 -- The original row was pruned while its permit remained reserved. Only this
 -- exact original observation may supply its captured semantic projection.
 -- The historical whole-row hash is provenance; it cannot be recomputed.
 IF t IS DISTINCT FROM (original_pruned_witness#>>'{original_permit,tournament_id}')::uuid
 OR to_jsonb(h) IS DISTINCT FROM original_pruned_witness->'original_permit'
 OR event.format_contract NOT IN ('mtt-v1','mtt-v2')
 OR cardinality(tab_ids)<>1 OR cardinality(reserved_ids)<>1
 OR snap.id IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR expected_item#>>'{interruption,paid_receipt_id}' IS DISTINCT FROM original_pruned_witness->>'paid_receipt_id'
 OR expected_item#>'{interruption,snapshot_witness}' IS DISTINCT FROM original_pruned_witness THEN
 RAISE EXCEPTION 'F06_EARLYBIRD_ORIGINAL_WITNESS_CHANGED' USING ERRCODE='55000'; END IF;
 snapshot_projection:=original_pruned_witness->'snapshot';
 ELSIF snap.id IS NOT NULL THEN
 snapshot_projection:=jsonb_build_object('id',snap.id,'row_hash',md5(to_jsonb(snap)::text),
 'stage',snap.stage,'state_stage',snap.state_json->>'stage','is_complete',snap.is_complete,
 'created_at',snap.created_at,'players',snap.state_json->'players','pot',snap.state_json->'pot');
 END IF;
 IF snapshot_projection IS NOT NULL THEN
 known_started:=known_started+1;"""
    source = replace_once(source, old, new)
    start = source.index(' IF snapshot_projection IS NOT NULL THEN')
    end = source.index(' ELSE\n prior_based:=prior_based+1;', start)
    original = source[start:end]
    boundary = original
    for old, new in (
        ('snap.stage', "snapshot_projection->>'stage'"),
        ("snap.state_json->>'stage'", "snapshot_projection->>'state_stage'"),
        ("snap.state_json->'players'", "snapshot_projection->'players'"),
        ("snap.state_json->>'pot'", "snapshot_projection->>'pot'"),
        ('snap.is_complete', "(snapshot_projection->>'is_complete')::boolean"),
        ('snap.created_at', "(snapshot_projection->>'created_at')::timestamptz"),
        ('id<>snap.id', "id<>(snapshot_projection->>'id')::uuid"),
    ):
        if old not in boundary:
            raise ValueError('Missing semantic field: ' + old)
        boundary = boundary.replace(old, new)
    boundary = replace_once(boundary,
        "OR expected_item#>>'{interruption,kind}' IS DISTINCT FROM 'completed_unaccepted_mtt'\n OR jsonb_typeof(snap.state_json->'actionHistory') IS DISTINCT FROM 'array'\n OR jsonb_array_length(snap.state_json->'actionHistory')<>0",
        """OR expected_item#>>'{interruption,kind}' IS DISTINCT FROM
   (CASE WHEN pruned_snapshot THEN 'pruned_completed_unaccepted_mtt' ELSE 'completed_unaccepted_mtt' END)
 OR (NOT pruned_snapshot AND (jsonb_typeof(snap.state_json->'actionHistory') IS DISTINCT FROM 'array'
   OR jsonb_array_length(snap.state_json->'actionHistory')<>0))
 -- jsonb_array_length(actionHistory)=0 was observed in the original query.
 -- Consume that count; do not fabricate an absent actionHistory array.
 OR (pruned_snapshot AND snapshot_projection->'action_count' IS DISTINCT FROM '0'::jsonb)""")
    boundary = replace_once(boundary,
        "historical:=jsonb_build_object('kind','completed_unaccepted_mtt','paid_receipt_id',paid.id,",
        "historical:=jsonb_build_object('kind',CASE WHEN pruned_snapshot THEN 'pruned_completed_unaccepted_mtt' ELSE 'completed_unaccepted_mtt' END,'paid_receipt_id',paid.id,")
    if not boundary.endswith(' END IF;\n'):
        raise ValueError('Completed boundary end changed')
    boundary = boundary[:-len(' END IF;\n')] + """ IF pruned_snapshot THEN
 historical:=historical||jsonb_build_object('snapshot_witness',original_pruned_witness);
 END IF;
 END IF;
"""
    source = replace_once(source, original, boundary)
    source = replace_once(source,
        "'snapshot_id',snap.id,\n 'snapshot_hash',CASE WHEN snap.id IS NULL THEN NULL ELSE md5(to_jsonb(snap)::text) END",
        """'snapshot_id',(snapshot_projection->>'id')::uuid,
 'snapshot_hash',snapshot_projection->>'row_hash'""")
    return ("-- The existing disposition may consume one original historical projection after retention loss.\n"
            "-- The full snapshot row/state_json does not survive and is never reconstructed or inserted.\n"
            "-- The historical row MD5 identifies the original observation; it is not recomputed from the projection.\n"
            "-- Exact original permit/event, all current custody/financial guards and zero-credit outcome remain required.\n"
            "-- No business mutation on install. Root separately proves physical retirement before any invocation.\n" + source)


if __name__ == '__main__':
    sql = render()
    target = ROOT / MIGRATION
    if '--check' in sys.argv:
        if target.read_text() != sql:
            raise SystemExit('EarlyBird projected migration differs from exact source composition')
    else:
        target.write_text(sql)
