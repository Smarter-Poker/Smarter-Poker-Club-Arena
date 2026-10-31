"""Compose an exact claim-bound chair projection from the installed financial predicate."""
import hashlib, importlib.util
from pathlib import Path
ROOT = Path(__file__).resolve().parents[4]
MIGRATION = 'supabase/migrations/20261029170914_original_claim_attests_exact_authorized_chairs.sql'


def render():
    path = ROOT/'scripts/ci/fixtures/hand-continuation/build-chip-funded-addon-claim.py'
    spec = importlib.util.spec_from_file_location('chair_chip_owner', path)
    owner = importlib.util.module_from_spec(spec); spec.loader.exec_module(owner)
    _, _, pre, *_ = owner.render()
    assert hashlib.md5(pre.encode()).hexdigest() == 'b92400fc1ddc2908cdd42866f547ede6'
    start = pre.index('  IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.payload::jsonb->\'seats\') x')
    end = pre.index("    RAISE EXCEPTION 'HAND_CONTINUATION_ROSTER_CHANGED'", start)
    old_guard = pre[start:end]
    prefix = "  IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.payload::jsonb->'seats') x\n              WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s\n                WHERE "
    assert old_guard.startswith(prefix) and old_guard.endswith(')) THEN\n')
    predicate = old_guard[len(prefix):-len(')) THEN\n')]
    # Admission and projection use the same statement and the exact old funding
    # predicate. No second unvalidated SELECT reads a later seat stack.
    new_guard = """  IF jsonb_typeof(c.payload::jsonb->'seats') IS DISTINCT FROM 'array'
     OR jsonb_array_length(c.payload::jsonb->'seats') = 0 THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ROSTER_CHANGED' USING ERRCODE = '55000';
  END IF;
  SELECT CASE
    WHEN count(*) = jsonb_array_length(c.payload::jsonb->'seats')
      AND count(DISTINCT x->>'user_id') = count(*)
      AND count(DISTINCT x->>'seat_id') = count(*)
    THEN jsonb_agg(jsonb_build_object(
      'user_id', x->>'user_id', 'seat_id', x->>'seat_id',
      'seat_joined_at', x->>'seat_joined_at',
      'stack_before', (x->>'stack_before')::numeric,
      'authorized_stack', s.stack) ORDER BY ordinal)
    ELSE NULL END INTO chair_seats
  FROM jsonb_array_elements(c.payload::jsonb->'seats') WITH ORDINALITY AS roster(x, ordinal)
  JOIN public.table_seats s ON """ + predicate + ";\n  IF chair_seats IS NULL THEN\n"
    declaration = 'DECLARE c smarter_private.hand_continuations; h smarter_private.f06_hand_permits;'
    response = "    'continuation', jsonb_build_object('payload', c.payload, 'sha256', c.payload_sha256,"
    projected = """    'chair_admission', jsonb_build_object(
      'version', 1, 'tournament_id', p_tournament_id, 'table_id', p_table_id,
      'writer_generation', p_lease_generation, 'original_generation', c.original_generation,
      'hand_number', c.hand_number::text, 'sequence', c.sequence::text,
      'payload_sha256', c.payload_sha256, 'seats', chair_seats),
""" + response
    assert pre.count(declaration) == pre.count(response) == 1
    changes = [(declaration, declaration + '\n  chair_seats jsonb;'), (old_guard, new_guard), (response, projected)]
    post = pre
    for old, new in changes: post = post.replace(old, new, 1)
    body = hashlib.md5(post.split('$function$')[1].encode()).hexdigest()
    full = hashlib.md5(post.encode()).hexdigest()
    proof = "EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='"+body+"' AND md5(pg_get_functiondef(p.oid))='"+full+"' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])"
    lit = lambda value: "'"+value.replace("'", "''")+"'"
    sql = "-- Project exact claim-authorized chairs without rewriting the original hand.\n-- The unchanged identity/funding predicate and authorized stack share one statement.\n-- @live-proof: "+proof+"\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\nDO $chairs$ DECLARE f regprocedure:='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure;d text;BEGIN\n"
    sql += " IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(p.prosrc)='a083d06d4906dc350350b847faf1c73f' AND md5(pg_get_functiondef(p.oid))='b92400fc1ddc2908cdd42866f547ede6' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_PREIMAGE_CHANGED' USING ERRCODE='55000';END IF;\n d:=pg_get_functiondef(f);\n"
    for old, new in changes:
        sql += " IF length(d)-length(replace(d,"+lit(old)+",''))<>length("+lit(old)+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_SHAPE_CHANGED';END IF;\n d:=replace(d,"+lit(old)+","+lit(new)+");\n"
    sql += " EXECUTE d;\n IF NOT ("+proof+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_CHAIR_POSTIMAGE_CHANGED';END IF;\nEND $chairs$;\nCOMMIT;\n"
    return sql, pre, post, proof, body, full, changes


if __name__ == '__main__':
    sql, *rest = render(); (ROOT/MIGRATION).write_text(sql); print(rest[3:5])
