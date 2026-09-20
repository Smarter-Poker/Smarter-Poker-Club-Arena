"""Compose the finite mixed disposition after the frozen homogeneous authority."""
import hashlib
import json
from pathlib import Path
import re
import sys

here = Path(__file__).resolve().parent
root = here.parents[3]
predecessor = (root / 'supabase/migrations/20260918064213_interrupted_tournament_generation_disposition.sql').read_text()
rows = json.loads((here / 'generation-preimages.json').read_text())['functions']
changed = {}
original = {}
for row in rows:
    name = row['proname']
    if name not in ('f06_generation_aborted', 'f06_aborted_hand_guard', 'f06_immutable_identity'):
        continue
    found = re.search(r'CREATE OR REPLACE FUNCTION smarter_private\.' + name + r'\([\s\S]+?END \$function\$;', predecessor)
    assert found
    old = found[0][:-1] + '\n'
    original[row['signature']] = old
    if name == 'f06_generation_aborted':
        needle = 'OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts WHERE tournament_id=t AND generation=g);'
        assert old.count(needle) == 1
        new = old.replace(needle, needle[:-1] + '\n OR EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=t AND generation=g);')
    elif name == 'f06_aborted_hand_guard':
        needle = 'OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands\n WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN'
        assert old.count(needle) == 1
        new = old.replace(needle, needle[:-5] + '\n OR EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands\n WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN')
    else:
        new = old
        for ending in ["AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN",
                       "AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) THEN"]:
            marker = 'AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a\n'
            start = new.index(marker)
            # Select the block ending in this exact identity clause.
            candidates = [m.start() for m in re.finditer(re.escape(marker), new)]
            matches = [(p, new.find(ending, p)) for p in candidates]
            matches = [(p, e) for p, e in matches if e >= p and marker not in new[p+len(marker):e]]
            assert len(matches) == 1
            p, e = matches[0]
            block = new[p:e + len(ending)]
            new = new[:p] + block[:-5] + ' ' + block.replace('f06_generation_abort_hands', 'f06_mixed_abort_hands') + new[e + len(ending):]
    changed[row['signature']] = new
assert len(changed) == 3
start = predecessor.index('DO $admission$')
end = predecessor.index('CREATE TABLE smarter_private.f06_generation_aborts')
preamble = predecessor[start:end]
for row in rows:
    if row['signature'] in original:
        preamble = preamble.replace(row['definition_md5'], hashlib.md5(original[row['signature']].encode()).hexdigest())
# The preceding source's duplicate helper binding uses the successor postimage.
preamble = preamble.replace('3c74c8c78714677ae35f82d01ef72720', hashlib.md5(original['smarter_private.f06_generation_aborted(uuid,uuid)'].encode()).hexdigest())
preamble = preamble.replace('F06_GENERATION_INSTALL_ADMISSION_BUSY', 'F06_MIXED_INSTALL_ADMISSION_BUSY')
preamble += """-- Prior original-abort receipts predate joined_at capture. Their unchanged
-- unique occupancy is valid lineage only with the installed stamping authority.
DO $occupancy$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_stamp_seat_occupancy()')
 AND md5(pg_get_functiondef(oid))='4d2645a24bd3b88d7ffc51097b37d640'
 AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
 AND tgname='zzz_stamp_seat_occupancy' AND tgenabled='O' AND tgtype=23 AND tgqual IS NULL
 AND tgfoid=to_regprocedure('public.fn_stamp_seat_occupancy()'))
 OR NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='occupancy_id'
 WHERE i.indexrelid=to_regclass('public.table_seats_occupancy_id_unique') AND i.indrelid='public.table_seats'::regclass
 AND i.indisvalid AND i.indisunique AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey::text=a.attnum::text
 AND i.indpred IS NULL AND i.indexprs IS NULL) THEN
 RAISE EXCEPTION 'F06_MIXED_OCCUPANCY_AUTHORITY_CHANGED'; END IF;
END $occupancy$;
"""
authority = (here / 'mixed-authority.sql').read_text()
schema, rpc = authority.split('-- Called only while', 1)
sql = '''-- Explicit mixed/current/older generation disposition for interrupted MTT/Spin/HU hands.
-- Missing snapshots do not prove never-started: require the complete prior
-- canonical atomic + post-commit receipt and unchanged exact seat generations.
-- One event bundle fences every original and exact current lease generation;
-- chips, accepted hands, other-table parks and existing disposition doors remain.
-- No production data is changed by installation. Reserved version 20260918065923.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
''' + preamble + schema
for sig, definition in changed.items():
    sql += definition.rstrip() + ';\nREVOKE ALL ON FUNCTION ' + sig + ' FROM PUBLIC,anon,authenticated,service_role;\n'
sql += '-- Called only while' + rpc + '\nCOMMIT;\n'
path = root / 'supabase/migrations/20260918065923_mixed_generation_disposition_preserves_committed_stacks.sql'
if '--check' in sys.argv:
    if path.read_text() != sql:
        raise SystemExit('Mixed migration differs from its source-bound composition')
else:
    path.write_text(sql)
