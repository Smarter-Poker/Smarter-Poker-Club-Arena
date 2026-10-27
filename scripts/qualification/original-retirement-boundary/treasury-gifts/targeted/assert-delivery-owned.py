"""Tie native owner bodies to the EXACT actual-install source authority."""
import re
W=P.parents[4]
delivery=W/'supabase/migrations/20261027031649_original_treasury_seat_gifts_keep_their_recorded_owner.sql'
text=delivery.read_text();start=text.rfind('CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()');assert start>=0
body=text[start:].split('$function$',2)[1]
expected=dict(re.findall(r"\('([^']+)','([0-9a-f]{32})'\)",body));assert len(expected)==65
wanted=globals().get('delivery_check_signatures',json.loads((P/'qualified-owned-signatures.json').read_text()))
found=json.loads(q("BEGIN;SET LOCAL search_path=pg_catalog;SELECT jsonb_agg(jsonb_build_object('signature',s.signature,'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner::regrole::text)ORDER BY signature)FROM(VALUES"+','.join('('+lit(x)+')'for x in wanted)+')s(signature)LEFT JOIN pg_proc p ON p.oid=to_regprocedure(s.signature);ROLLBACK;'))
assert len(found)==len(wanted)
for r in found:assert r['owner']=='postgres'and r['md5']==expected[r['signature']],r
(O/'actual-delivery-owned-source-match.json').write_text(json.dumps({'actual_delivery':str(delivery.relative_to(W)),'sha256':hashlib.sha256(delivery.read_bytes()).hexdigest(),'exact_matched_owners':found,'controlled_245_trust_sources_not_rebound':True},indent=2)+'\n')

if 'delivery_check_signatures' not in globals():
 for item in json.loads((P.parent/'public-owner-acls.json').read_text()):
  signature='public.'+item['signature'];assert q("SELECT proacl::text FROM pg_proc WHERE oid="+lit(signature)+"::regprocedure")==item['acl'],signature
