"""Keep the separately qualified retained-MTT owner and migration byte-identical."""
from pathlib import Path
import sys
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MIGRATION = 'supabase/migrations/20260918233825_retain_mixed_mtt_interrupted_hands_without_changing_custody_.sql'

def render():
    # The generic abort is independent of this owner and may gain its separately
    # qualified projected-witness branch. Pin only authorities consumed here.
    pins = {
        'public.fn_engine_lease_stale_seconds()': '483a7e0ee940744fd557f1f2144d9eba',
        'smarter_private.f06_prior_committed_stacks(uuid,jsonb,jsonb)': '4f914e43de444919d99229775a2ac2e5',
        'public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)': 'd5700b1c4e4663c5b9e12915a75d269b',
        'smarter_private.f06_generation_aborted(uuid,uuid)': '3530559a94372866bf3baec006a8fd3c',
        'smarter_private.f06_aborted_hand_guard()': '56c232740eb495dd2e2164159dfe782c',
    }
    prefix = """-- Retained MTT originals preserve chips, movement authority and their old lease.
-- Missing evidence is not no-start. Exactly qualified original-owner retirement
-- remains mandatory outside SQL; this migration does not actuate a disposition.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pins$ BEGIN
IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
"""
    for sig, digest in pins.items():
        prefix += f"IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('{sig}') AND md5(pg_get_functiondef(oid))='{digest}' AND proowner='postgres'::regrole) THEN RAISE EXCEPTION 'F06_RETAINED_AUTHORITY_CHANGED: {sig}'; END IF;\n"
    for relation, trigger, function in (
        ('public.hand_atomic_commits', 'a00_f06_aborted_hand', 'smarter_private.f06_aborted_hand_guard()'),
        ('public.hand_history', 'a00_f06_aborted_history', 'smarter_private.f06_aborted_hand_guard()'),
        ('public.engine_tournament_leases', 'f06_aborted_generation', 'smarter_private.f06_aborted_generation_guard()'),
        ('smarter_private.f06_mixed_aborts', 'f06_mixed_receipt_immutable', 'smarter_private.f06_abort_receipt_immutable()'),
        ('smarter_private.f06_mixed_abort_hands', 'f06_mixed_hands_immutable', 'smarter_private.f06_abort_receipt_immutable()'),
        ('smarter_private.f06_mixed_abort_generations', 'f06_mixed_generations_immutable', 'smarter_private.f06_abort_receipt_immutable()'),
    ):
        prefix += f"IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='{relation}'::regclass AND tgname='{trigger}' AND tgenabled='O' AND tgfoid=to_regprocedure('{function}')) THEN RAISE EXCEPTION 'F06_RETAINED_FENCE_BINDING_CHANGED: {trigger}'; END IF;\n"
    prefix += "END $pins$;\n"
    return prefix + (HERE / 'retained-mtt-authority.sql').read_text() + '\nCOMMIT;\n'

if __name__ == '__main__':
    if '--check' in sys.argv:
        if (ROOT / MIGRATION).read_text() != render():
            raise SystemExit('Retained MTT migration source changed')
    else:
        (ROOT / MIGRATION).write_text(render())
