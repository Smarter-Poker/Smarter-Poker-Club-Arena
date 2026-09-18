"""Compose the additive generation receipt guards from actual installed bodies."""
import hashlib
import json
from pathlib import Path
import sys

here = Path(__file__).resolve().parent
root = here.parents[3]
rows = json.loads((here / 'generation-preimages.json').read_text())['functions']
changed = {}
for row in rows:
    old = row['definition']
    new = old
    if row['proname'] == 'f06_generation_aborted':
        needle = 'WHERE tournament_id=t AND (generation=g OR retired_lease_generation=g));'
        assert old.count(needle) == 1
        new = old.replace(needle, needle[:-1] + "\n OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts WHERE tournament_id=t AND generation=g);")
    if row['proname'] == 'f06_aborted_hand_guard':
        needle = 'WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN'
        assert old.count(needle) == 1
        new = old.replace(needle, 'WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number)\n OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands\n WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN')
    if row['proname'] == 'f06_immutable_identity':
        needle = "AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN"
        assert old.count(needle) == 1
        new = new.replace(needle, needle[:-5] + " AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a\n WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid\n AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid\n AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN")
        needle = "AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) THEN"
        assert old.count(needle) == 1
        new = new.replace(needle, needle[:-5] + " AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a\n WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid\n AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid\n AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) THEN")
    if new != old:
        changed[row['signature']] = new
assert len(changed) == 3
# Only the two changed hand-write trigger bindings need old-frame drainage.
# The generation/identity additions are guarded by the owning lease/row lanes;
# no existing relation/constraint/trigger DDL occurs in this additive migration.
# SHARE drains RowExclusive writers but permits unrelated lease and hand readers.
# Preserve the finite first-gate budget and release every partial lock set.
predecessor = (root / 'supabase/migrations/20260918061004_interrupted_original_hands_fence_their_successor_lease.sql').read_text()
admission = predecessor[predecessor.index('DO $admission$'):predecessor.index('DO $preimages$')]
admission = admission.replace('LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE;',
                              'LOCK TABLE public.hand_atomic_commits IN SHARE MODE;')
admission = admission.replace('LOCK TABLE smarter_private.f06_unsettled_hand_aborts IN ACCESS EXCLUSIVE MODE NOWAIT;',
                              'LOCK TABLE public.hand_history IN SHARE MODE NOWAIT;')
admission = admission.replace('F06_SUCCESSOR_INSTALL_ADMISSION_BUSY', 'F06_GENERATION_INSTALL_ADMISSION_BUSY')
sql = '''-- Separate whole-generation interrupted-hand disposition. Zero chips credited.
-- The installed HU and successor RPCs and their unique constraints are unchanged.
-- Exact current lease + full reserved set + saved-stack arithmetic are mandatory.
-- Accepted siblings and accepted-source park requests are never withdrawn.
-- Version reserved by scripts/new-migration.mjs; installation is not actuation.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
'''+admission+'DO $preimages$ BEGIN\n'
for row in rows:
    sig = row['signature']
    if '.' not in sig.split('(')[0]:
        sig = 'public.' + sig
    digest = hashlib.md5(row['definition'].encode()).hexdigest()
    assert digest == row['definition_md5']
    sql += f" IF md5(pg_get_functiondef('{sig}'::regprocedure))<>'{digest}' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{row['acl']}' FROM pg_proc WHERE oid='{sig}'::regprocedure) THEN RAISE EXCEPTION 'F06_GENERATION_PREIMAGE_CHANGED {sig}'; END IF;\n"
# Reuse the exact existing trigger/request-hook dependency assertions, preserving
# the successor's actual helper postimage rather than replaying its installation.
unchanged = predecessor[predecessor.index(' IF public.fn_platform_frozen() THEN'):predecessor.index(' -- The predecessor was installed separately:')]
unchanged = unchanged.replace("'7d5e74e099589f1e381b98c3db039aa6'", "'3c74c8c78714677ae35f82d01ef72720'")
sql += unchanged.replace('F06_SUCCESSOR_ABORT_PREIMAGE_CHANGED', 'F06_GENERATION_FENCE_PREIMAGE_CHANGED')
start = predecessor.index(' -- The predecessor was installed separately:')
end = predecessor.index('END $preimages$;', start)
sql += predecessor[start:end] + 'END $preimages$;\n'
authority = (here / 'generation-authority.sql').read_text()
schema, rpc = authority.split('CREATE FUNCTION public.fn_f06_abort_unsettled_generation', 1)
sql += schema
for sig, definition in changed.items():
    sql += definition.rstrip() + ';\nREVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;\n'
sql += 'CREATE FUNCTION public.fn_f06_abort_unsettled_generation' + rpc + '\nCOMMIT;\n'
path = root / 'supabase/migrations/20260918064213_interrupted_tournament_generation_disposition.sql'
if '--check' in sys.argv:
    if path.read_text() != sql:
        raise SystemExit('Generation migration differs from its source-bound composition')
else:
    path.write_text(sql)
