"""Extend only the positively retired whole-owner snapshot, never generic abort."""
from pathlib import Path
import hashlib
import runpy
import sys

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = 'supabase/migrations/20260919034506_retired_original_owner_accepts_sealed_zero_on_another_origin.sql'
PROOF = 'scripts/ci/probes/f06-shared-hand-lane/retired-other-zero-proof.sql'


def render(root=ROOT):
    prior = runpy.run_path(str(root / 'scripts/ci/build-f06-retired-origin.py'))
    original = prior['definition'](prior['render'](root), 'smarter_private.f06_retired_origin_snapshot', '$function$')
    once = prior['once']
    patched = once(original, 'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    patched = once(patched, ' oldseat public.table_seats;',
                   ' zero_key public.settlement_idempotency_keys; zero_settlement public.ca_settlements;\n oldseat public.table_seats;')
    patched = once(patched, " OR reg.chips IS DISTINCT FROM 0 OR reg.table_id IS DISTINCT FROM h.table_id",
                   " OR reg.chips IS DISTINCT FROM 0\n OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=reg.table_id AND tournament_id=t)\n OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(physical->'engines') e WHERE e->>'table_id'=reg.table_id::text)")
    patched = once(patched, ' OR a.hand_id IS NULL OR a.table_id IS DISTINCT FROM h.table_id OR a.hand_number>=h.hand_number',
                   ' OR a.hand_id IS NULL OR a.table_id IS DISTINCT FROM reg.table_id\n OR (reg.table_id=h.table_id AND a.hand_number>=h.hand_number)')
    # Other original tables can have accepted newer hands for other players.
    # Their accepted zero gets its own settlement proof, not the target scan.
    patched = once(patched, " OR a.stack_result->>'table_id' IS DISTINCT FROM h.table_id::text",
                   " OR a.stack_result->>'table_id' IS DISTINCT FROM reg.table_id::text")
    patched = once(patched,
                   ' OR EXISTS(SELECT 1 FROM public.hand_atomic_commits later WHERE later.table_id=h.table_id AND later.hand_number>a.hand_number\n AND later.stack_result',
                   ' OR EXISTS(SELECT 1 FROM public.hand_atomic_commits later WHERE later.table_id=ANY(ids)\n AND (later.committed_at>a.committed_at OR (later.table_id=a.table_id AND later.hand_number>a.hand_number))\n AND later.stack_result')
    anchor = ' zeros:=zeros||jsonb_build_array('
    patched = once(patched, anchor, (root / PROOF).read_text() + '\n' + anchor)
    patched = once(patched, "'seat',to_jsonb(oldseat),'atomic_hash'",
                   "'seat',to_jsonb(oldseat),'stack_key',to_jsonb(zero_key),'stack_settlement',to_jsonb(zero_settlement),'atomic_hash'")
    body_md5 = hashlib.md5(original.split('$function$')[1].encode()).hexdigest()
    return f"""-- The original owner stopped every cohort engine. A sealed zero on another
-- original table classifies that player only; it never eliminates or pays them.
-- Keep the generic retained snapshot's selected-table rule unchanged.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $pins$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)')
 AND md5(prosrc)='{body_md5}' AND proowner='postgres'::regrole AND prosecdef
 AND proacl::text='{{postgres=X/postgres}}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
THEN RAISE EXCEPTION 'F06_RETIRED_ZERO_DEPENDENCY_DRIFT'; END IF;
END $pins$;
{patched}
COMMIT;
"""


if __name__ == '__main__':
    rendered = render()
    if '--check' in sys.argv:
        if (ROOT / MIGRATION).read_text() != rendered:
            raise SystemExit('Retired other-table zero migration source changed')
    else:
        (ROOT / MIGRATION).write_text(rendered)
