"""Add exact interrupted-custody cases to the installed mixed disposition owner."""
from pathlib import Path
import hashlib
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MIGRATION = 'supabase/migrations/20260918154419_interrupted_hands_preserve_original_custody_without_inventin.sql'
PREDECESSOR = 'supabase/migrations/20260918130733_completed_unaccepted_mtt_snapshots_retain_their_committed_st.sql'


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Exact predecessor boundary changed: ' + old)
    return source.replace(old, new)


def render():
    source = (ROOT / PREDECESSOR).read_text()
    if hashlib.sha256(source.encode()).hexdigest() != 'fae1fcb2df4ea901de89946ae1e4539038e5467ed50fd7f8eb21b491b24f0c2d':
        raise ValueError('Installed mixed predecessor source changed')
    source = replace_once(source, '9a655cf82edac7513824335a4091e3b8', '4415d0e65aec71ecff0e0db366364ecb')
    changes = [
        ('paid public.tournament_paid_stack_custody_receipts;', 'snapshot_absent_spin boolean;\n paid public.tournament_paid_stack_custody_receipts;'),
        ("retired_dispatch:=NULL;\n SELECT x INTO expected_item FROM jsonb_array_elements(p_expected->'hands') x WHERE x->'permit'->>'permit_id'=h.permit_id::text;", "retired_dispatch:=NULL;\n SELECT x INTO expected_item FROM jsonb_array_elements(p_expected->'hands') x WHERE x->'permit'->>'permit_id'=h.permit_id::text;\n snapshot_absent_spin:=COALESCE(expected_item#>>'{interruption,kind}'='snapshot_absent_unaccepted_spin',false);"),
        ("OR NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id\n   AND hand_number=h.hand_number AND is_complete)", "OR (NOT snapshot_absent_spin AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id\n   AND hand_number=h.hand_number AND is_complete))\n OR (snapshot_absent_spin AND EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id\n   AND hand_number>=h.hand_number))"),
        (" END IF;\n SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO roster", " END IF;\n IF snapshot_absent_spin AND retired_dispatch IS NULL THEN\n RAISE EXCEPTION 'F06_SPIN_ABSENT_ORIGINAL_DISPATCH_REQUIRED' USING ERRCODE='55000'; END IF;\n SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO roster"),
        ("OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number>=h.hand_number)\n OR EXISTS(SELECT 1 FROM public.hand_projection_outbox", "OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id\n AND (hand_number>h.hand_number OR (hand_number=h.hand_number AND NOT snapshot_absent_spin)))\n OR EXISTS(SELECT 1 FROM public.hand_projection_outbox"),
        (" RAISE EXCEPTION 'F06_SPIN_PRIOR_LATER_CUSTODY' USING ERRCODE='55000'; END IF;", " RAISE EXCEPTION 'F06_SPIN_PRIOR_LATER_CUSTODY' USING ERRCODE='55000'; END IF;\n" + (HERE / 'snapshot-absent-spin-cards.sql').read_text().rstrip()),
        ("|| CASE WHEN retired_dispatch IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retired_dispatch',retired_dispatch) END;", "|| CASE WHEN retired_dispatch IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retired_dispatch',retired_dispatch) END\n   || CASE WHEN snapshot_absent_spin THEN jsonb_build_object('kind','snapshot_absent_unaccepted_spin',\n     'cards',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,\n       'hand_number',c.hand_number,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id)\n       FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number)) ELSE '{}'::jsonb END;"),
    ]
    for old, new in changes:
        source = replace_once(source, old, new)
    # Apply the earlier-receipt predicate only within the existing completed-MTT
    # boundary. The separate Spin canonical-financial proof remains byte exact.
    old_boundary = (HERE / 'completed-mtt-boundary.sql').read_text().rstrip()
    old_predicate = "(k.status IS DISTINCT FROM 'succeeded' OR a.hand_id IS NULL\n OR k.result IS DISTINCT FROM a.stack_result)"
    new_boundary = replace_once(old_boundary, old_predicate, (HERE / 'completed-mtt-earlier-receipts.sql').read_text().split('\n', 1)[1].strip())
    source = replace_once(source, old_boundary, new_boundary)
    return ('-- Earlier recorded final stack receipts remain locked, unchanged and distinct from canonical outcomes.\n'
            '-- Snapshot absence is not no-start: retain exact original cards, returned refusal and ended dispatch.\n'
            '-- The original canonical financial boundary, full roster and both writer-generation fences remain required.\n'
            '-- No data or money changes on install; the existing disposition remains zero-credit aborted_unsettled.\n' + source)


if __name__ == '__main__':
    sql = render()
    target = ROOT / MIGRATION
    if '--check' in sys.argv:
        if target.read_text() != sql:
            raise SystemExit('Interrupted custody migration differs from exact source composition')
    else:
        target.write_text(sql)
