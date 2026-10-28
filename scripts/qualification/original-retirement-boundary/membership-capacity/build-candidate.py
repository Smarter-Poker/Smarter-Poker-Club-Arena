#!/usr/bin/env python3
"""Compose only the actual missed report caller and its direct hash callers."""
from pathlib import Path
import hashlib,json,re
P=Path(__file__).resolve().parent
catalog=json.loads((P/'actual-original-owner-catalog.json').read_text())
def md5(s):return hashlib.md5(s.encode()).hexdigest()
originals={n:(P/(n+'-original.sql')).read_text()for n in ['report','advance','guard']}
assert {n:md5(s)for n,s in originals.items()}=={'report':'49b47361e2ccd195968d293b1bb7c3c0','advance':'736539c3d60fd047c352e127f18d54bb','guard':'edc8545a57d017a7cce79550dd0520f9'}
post=originals.copy()
old="public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)"
new=(P/'membership-expression.sql').read_text().strip()
assert post['report'].count(old)==1
post['report']=post['report'].replace(old,new)
assert post['advance'].count(md5(originals['report']))==1
post['advance']=post['advance'].replace(md5(originals['report']),md5(post['report']))
for name in ['report','advance']:
 assert post['guard'].count(md5(originals[name]))==1
 post['guard']=post['guard'].replace(md5(originals[name]),md5(post[name]))
a=dict(re.findall(r"\('([^']+)','([0-9a-f]{32})'\)",originals['guard']));b=dict(re.findall(r"\('([^']+)','([0-9a-f]{32})'\)",post['guard']))
assert len(a)==len(b)==65 and set(a)==set(b)
assert {k for k in a if a[k]!=b[k]}=={'public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'}
assert md5(catalog['gen_definition'])=='58dc20e1ba380ccb9b9dee8809731d33'
head='''-- @live-proof: smarter_private.original_inventory_proof_sources_match() AND md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))='REPORT_POST'
-- The original report reads the exact tournament membership predicates as a set.
-- Only the membership expression and its direct report-hash callers change.
-- Generation58dc remains byte-exact and naturally invalidates old derived
-- certificates/84-part generations: original producers must rebuild, never retag.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=public,pg_catalog;
SELECT pg_advisory_xact_lock(530090,1);
DO $pre$BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'original_report_membership_platform_frozen';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'original_report_membership_source65_unqualified';END IF;
 IF md5(pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure))IS DISTINCT FROM '58dc20e1ba380ccb9b9dee8809731d33' THEN RAISE EXCEPTION 'original_report_membership_generation_owner_changed';END IF;
END$pre$;
'''.replace('REPORT_POST',md5(post['report']))
for n in ['report','advance','guard']:
 record=next(o for o in catalog['owners']if o['md5']==md5(originals[n]))
 sig=record['signature'];sig=('public.'+sig if not sig.startswith('smarter_private.')else sig)
 meta=record['metadata'];namespace='smarter_private'if sig.startswith('smarter_private.')else'public';language='sql'if n=='guard'else'plpgsql'
 expected=json.dumps(meta,separators=(',',':'))
 head+=f'''DO $owner_{n}$DECLARE before_meta jsonb;after_meta jsonb;expected_meta jsonb:=$metadata${expected}$metadata$::jsonb;v_oid oid:=to_regprocedure('{sig}');BEGIN
 SELECT to_jsonb(p)-'prosrc'INTO before_meta FROM pg_proc p WHERE p.oid=v_oid;
 expected_meta:=expected_meta||jsonb_build_object('oid',v_oid::text,'proowner','postgres'::regrole::oid::text,'prolang',(SELECT oid::text FROM pg_language WHERE lanname='{language}'),'pronamespace','{namespace}'::regnamespace::oid::text);
 IF before_meta IS DISTINCT FROM expected_meta OR md5(pg_get_functiondef(v_oid))IS DISTINCT FROM '{md5(originals[n])}' THEN RAISE EXCEPTION 'original_report_membership_owner_or_authority_changed:{n}';END IF;
 EXECUTE $qualified_{n}${post[n]}$qualified_{n}$;
 SELECT to_jsonb(p)-'prosrc'INTO after_meta FROM pg_proc p WHERE p.oid=v_oid;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef(v_oid))IS DISTINCT FROM '{md5(post[n])}' THEN RAISE EXCEPTION 'original_report_membership_postimage_changed:{n}';END IF;
END$owner_{n}$;
'''
head+='''-- Preserve the actual PostgreSQL-only report ACL explicitly for source authorization checks.
REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
DO $final$BEGIN
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'original_report_membership_final_source65_not_qualified';END IF;
 IF md5(pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure))IS DISTINCT FROM '58dc20e1ba380ccb9b9dee8809731d33' THEN RAISE EXCEPTION 'original_report_membership_generation_owner_altered';END IF;
END$final$;
COMMIT;
'''
for n,s in post.items():(P/(n+'-candidate.sql')).write_text(s)
(P/'composed-candidate.sql').write_text(head)
(P/'candidate-contract.json').write_text(json.dumps({'kind':'source_composition_contract','source_owners_changed':3,'source65_changed_entries':2,'other_source65_entries_preserved':63,'generation_owner_unchanged':md5(catalog['gen_definition']),'original_md5':{n:md5(s)for n,s in originals.items()},'post_md5':{n:md5(s)for n,s in post.items()},'candidate_sha256':hashlib.sha256(head.encode()).hexdigest()},indent=2)+'\n')
print((P/'candidate-contract.json').read_text())
