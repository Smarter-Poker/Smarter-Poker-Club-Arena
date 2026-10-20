"""Connected full original owner-discharge qualification on the maintained parent cluster.
Original inventory/freeze checks below are isolated installer prerequisites,
not claims that synthetic fixtures qualify production inventory.
"""
import json

def qualify(root,run):
 rows=json.loads((root/'scripts/ci/fixtures/commission-club-history-preimages.json').read_text())
 sql='SET check_function_bodies=off;\n'
 for r in rows:
  sql+=r['definition']+'; REVOKE ALL ON FUNCTION public.'+r['signature']+' FROM PUBLIC,anon,authenticated,service_role;\n'
  if r['signature'].startswith('fn_accounting_legacy'):sql+='GRANT EXECUTE ON FUNCTION public.'+r['signature']+' TO service_role;\n'
 run(sql,'commission-original-all-three-preimages')
 regression=(root/'tests/fixtures/owner-legacy-discharge/regression.sql').read_text()
 # Same complete fixture, real owner function, existing ledger/document triggers.
 # Force a private seam for its two clock reads exactly as that fixture does.
 for changed in [False,True]:
  db='commission_club_after' if changed else 'commission_club_before'
  run('CREATE DATABASE '+db+' TEMPLATE postgres;', 'commission-private-clone-'+db)
  def local(sql,label):run('\\connect '+db+'\n'+sql,label)
  if changed:
   local("RESET request.jwt.claim.role;RESET request.jwt.claims;CREATE SCHEMA IF NOT EXISTS smarter_private;CREATE SCHEMA IF NOT EXISTS supabase_migrations;CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text);CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;",'commission-installer-unrelated-controls')
   local(next((root/'supabase/migrations').glob('20261020163005*.sql')).read_text(),'commission-exact-installer')
  predicate='wt.related_entity_id IS NOT NULL' if changed else 'wt.related_entity_id IS NULL'
  assertion="""
SELECT fixture.assert((SELECT count(*)>0 AND bool_and(%s) FROM wallet_transactions wt WHERE wt.category='commission' AND wt.description IN('Recorded weekly commission budget received (owner-authorized legacy week)','Recorded weekly commission budget passed to child agent (owner-authorized legacy week)')),'legacy actual writer exact NULL-before/club-after');
SELECT fixture.assert(NOT EXISTS(SELECT FROM wallet_transactions wt WHERE wt.category='commission' AND wt.description IN('Recorded weekly commission budget received (owner-authorized legacy week)','Recorded weekly commission budget passed to child agent (owner-authorized legacy week)') AND NOT EXISTS(SELECT FROM chip_ledger cl WHERE cl.category='commission' AND cl.amount=wt.amount AND cl.created_at=wt.created_at AND cl.idempotency_key LIKE 'owner_legacy:%%:round2:%%' AND (CASE wt.type WHEN 'credit' THEN cl.to_entity_id ELSE cl.from_entity_id END)=wt.user_id %s)),'every legacy journal has exact canonical credit/debit club leg');
"""%(predicate,'AND cl.club_id=wt.related_entity_id' if changed else '')
  local(regression+'\n'+assertion, 'commission-legacy-'+('after' if changed else 'before'))
  run('DROP DATABASE '+db+';', 'commission-private-clone-cleanup-'+db)
