#!/usr/bin/env python3
"""Validate canonical original cash row text without publishing private cards.

This prepares local qualification input only; it never connects to a database.
Raw PostgreSQL JSONB text remains opaque to preserve numeric scale and hashes.
"""
import argparse
import hashlib
import json
import pathlib
import sys
sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument('--original-rowraw', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
for path in (args.original_rowraw.resolve(), args.output.resolve()):
    if not str(path).startswith('/Volumes/SmarterWork/agent-work/'):
        raise SystemExit('Private cash qualification input/output must use owned external SSD storage')
rows = json.loads(args.original_rowraw.read_text())
if len(rows) != 17 or len({(r['table_id'], r['hand_number']) for r in rows}) != 17:
    raise SystemExit('Exact17 original inputs required')
result = []
for row in rows:
    for field in ('submission_raw','request_raw','handoff_raw','result_raw','snapshot_raw','table_raw','seats_raw'):
        if not isinstance(row.get(field),str) or not row[field]:
            raise SystemExit('Missing canonical raw original field: '+field)
    original = json.loads(row['submission_raw'])
    request = json.loads(row['request_raw'])
    failed = json.loads(row['result_raw'])['result']
    if original['table_id'] != row['table_id'] or original['hand_number'] != row['hand_number']:
        raise SystemExit('Original identity mismatch')
    if failed.get('success') is not False or failed.get('atomic_hand_commit') is not False or failed.get('reason') != 'atomic_hand_rolled_back' or failed.get('sqlstate') != '23514' or failed.get('error') != 'new row for relation "poker_diamond_jackpot_pools" violates check constraint "poker_diamond_jackpot_pools_backup_residue_check"':
        raise SystemExit('Original exact allocator refusal is missing')
    if hashlib.sha256(row['request_raw'].encode()).hexdigest() != original['request_hash']:
        raise SystemExit('Canonical original request SHA changed')
    if request.get('p_bbj') != 1 or request.get('p_inflow') != 0 or request.get('p_units') != []:
        raise SystemExit('Original money units changed')
    result.append({'submission_id':original['submission_id'],'table_id':row['table_id'],'hand_number':row['hand_number'],'original_generation':original['lease_generation'],'request_sha':original['request_hash'],**{field.removesuffix('_raw')+'_md5':hashlib.md5(row[field].encode()).hexdigest() for field in ('request_raw','handoff_raw','result_raw','snapshot_raw')},'raw':row})
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(result)+'\n')
print(json.dumps({'prepared_originals':len(result),'private_payloads_printed':False,'database_invoked':False}))
