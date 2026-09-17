"""Protected execution payload: build one unapplied accounting transaction.

Individual components remain independently testable. Installed migration mirrors
are deliberately excluded; activation starts from that verified installed base.
No database is contacted by this builder. Under the current owner policy this
payload is pending protected admission, not a direct execution fallback.
"""
from pathlib import Path
import argparse,hashlib,json,re

root=Path(__file__).resolve().parents[2]
work=root/'supabase/accounting/weekly-v3'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir',required=True,type=Path,help='Reserved protected artifact directory outside the source checkout')
parser.add_argument('--check',action='store_true')
arguments=parser.parse_args()
output=arguments.output_dir.resolve()
if output==root or root in output.parents:
 parser.error('Generated artifacts must remain outside the source checkout')
if not arguments.check:output.mkdir(parents=True,exist_ok=True)
names=[
 '20260914131539_cash_commissions_account_for_every_contributor_once.sql',
 '20260914132216_cash_rakeback_periods_require_one_certified_week.sql',
 '20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql',
 '20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql',
 '20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql',
 '20260914135530_tournament_fees_share_one_recorded_earning_authority.sql',
 '20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql',
 '20260914141013_weekly_player_certificates_include_recognized_tournament_fees.sql',
 '20260914141800_union_close_matches_recorded_earnings_to_every_bank_credit.sql',
 '20260914142256_weekly_statements_follow_recorded_union_and_standalone_books.sql',
 '20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql',
 '20260914143500_weekly_conservation_requires_recorded_scope_and_payment_receipts.sql',
 '20260914144442_cash_accounting_refusals_are_durable_and_retryable.sql',
 '20260914145000_legacy_claims_enter_only_automatic_weekly_accounting.sql',
 '20260914145706_cash_compatibility_calls_share_durable_source_authority.sql',
 '20260914150500_agent_agreements_preserve_club_scope_and_atomic_role_changes.sql',
 '20260914152500_unresolved_cash_sources_prevent_weekly_close.sql',
 '20260914150848_union_pnl_evidence_is_distinct_from_posted_chip_payments.sql',
 '20260914153000_uncertified_union_pnl_blocks_close_and_squareup.sql',
 '20260914154500_weekly_scheduler_visits_every_accounting_scope_fairly.sql',
 '20260914155450_captured_cron_enters_the_sealed_accounting_transition.sql',
 '20260914155500_legacy_recompute_uses_the_single_weekly_coordinator.sql',
 '20260914160000_private_cash_attribution_preserves_recorded_seat_scope.sql',
 '20260914161000_pending_rakeback_writes_require_accounting_authority.sql',
 '20260914161500_rakeback_history_is_private_to_its_payee.sql',
 '20260914162000_no_floor_union_completion_preserves_contiguous_work.sql',
 '20260914162500_standalone_deadlines_follow_their_own_week.sql',
 '20260914163000_canonical_cron_wakes_on_the_hour.sql',
 '20260914163500_messenger_readers_preserve_private_invoices_and_weekly_summaries.sql',
 '20260914164000_push_enrollment_changes_endpoint_ownership_atomically.sql',
 '20260914164500_push_rotation_preserves_current_subscription_ownership.sql',
 '20260914164600_credit_request_reviews_share_one_credit_authority.sql',
 '20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql',
 '20260914164800_correction_documents_preserve_journal_and_payment_meaning.sql',
 '20260914164900_browser_period_controls_retire_to_scoped_observation.sql',
 '20260915140000_correction_writer_retains_exact_request_and_journal_intent.sql',
 '20260915150000_credit_reductions_retain_exact_intent_and_private_records.sql',
]
component_dir=work/'components'
privacy_index=names.index('20260914161500_rakeback_history_is_private_to_its_payee.sql')
if privacy_index!=24:
 raise ValueError('Review privacy negative-fixture prefix when changing predecessor ordering')
present={path.name for path in component_dir.glob('*.sql')}
if len(names)!=len(set(names)) or present!=set(names):
 raise ValueError(f'Component inventory mismatch: unlisted={sorted(present-set(names))}, missing={sorted(set(names)-present)}')
# The new component is a literal, reviewed composition of maintained fragments.
# Changed fragment bytes cannot silently leave the combined component stale.
credit_dir=root/'supabase/accounting/credit-reduction-v1'
assembly=json.loads((credit_dir/'source-assembly.json').read_text())
credit_name='20260915150000_credit_reductions_retain_exact_intent_and_private_records.sql'
if assembly['component_name']!=credit_name or len(assembly['fragments'])!=11:
 raise ValueError('Credit component assembly identity changed')
assembled=assembly['header'].encode('utf-8')
seen=set()
for fragment in assembly['fragments']:
 name=fragment['name']
 if not re.fullmatch(r'[a-z-]+\.sql',name) or name in seen:
  raise ValueError('Credit component fragment identity is invalid')
 seen.add(name)
 content=(credit_dir/name).read_bytes()
 if len(content)!=fragment['bytes'] or hashlib.sha256(content).hexdigest()!=fragment['sha256']:
  raise ValueError('Credit component fragment changed: '+name)
 assembled+=('-- Fragment '+name+'\n').encode('utf-8')+content+b'\n'
assembled+=assembly['footer'].encode('utf-8')
if ((component_dir/credit_name).read_bytes()!=assembled
 or hashlib.sha256(assembled).hexdigest()!=assembly['component_sha256']):
 raise ValueError('Credit component must be reassembled and reviewed from its current fragments')
# A later lock-order replacement must retain the exact current cashier body.
# Literal fragment hashes alone cannot detect a changed predecessor component.
cashier_signature='public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'
cashier_path='supabase/accounting/weekly-v3/components/20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql'
lock_source=(credit_dir/'lock-order-successor.sql').read_text()
def cashier_definition(source):
 matches=re.findall(r'(CREATE(?: OR REPLACE)? FUNCTION public\.fn_cashier_cashout_transition\([^$]*?AS \$function\$)(.*?)\$function\$;',source,re.S)
 if len(matches)!=1:raise ValueError('Cashier lock-order function identity changed')
 return matches[0]
before_header,before_body=cashier_definition((root/cashier_path).read_text())
after_header,after_body=cashier_definition(lock_source)
if cashier_definition((credit_dir/'lock-order-predecessors.sql').read_text())!=(before_header,before_body):
 raise ValueError('Cashier retained lock-order predecessor differs from its staged component')
provenance=json.loads((credit_dir/'lock-order-source-provenance.json').read_text())['functions']
cashier_provenance=[item for item in provenance if item['signature']==cashier_signature]
guards=re.findall(r'\$expected_functions\$(.*?)\$expected_functions\$::jsonb',lock_source,re.S)
if len(cashier_provenance)!=1 or len(guards)!=2:
 raise ValueError('Cashier lock-order authority inventory changed')
cashier_provenance=cashier_provenance[0]
before_guard=[item for item in json.loads(guards[0]) if item['signature']==cashier_signature]
after_guard=[item for item in json.loads(guards[1]) if item['signature']==cashier_signature]
if len(before_guard)!=1 or len(after_guard)!=1:
 raise ValueError('Cashier lock-order guard inventory changed')
if (cashier_provenance['staged_source']!=cashier_path
 or hashlib.md5(before_body.encode()).hexdigest()!=cashier_provenance['staged_body_md5']
 or before_guard[0]['source_md5']!=cashier_provenance['staged_body_md5']):
 raise ValueError('Cashier lock-order predecessor changed; review and refresh its exact successor')
if (before_body.count('\nBEGIN\n')!=1
 or after_header!=before_header.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
 or after_body!=before_body.replace('\nBEGIN\n','\nBEGIN'+cashier_provenance['only_body_delta']+'\n',1)
 or hashlib.md5(after_body.encode()).hexdigest()!=cashier_provenance['successor_body_md5']
 or after_guard[0]['source_md5']!=cashier_provenance['successor_body_md5']
 or json.loads(guards[1])!=json.loads((credit_dir/'guard-lock-successor-sources.json').read_text())):
 raise ValueError('Cashier lock-order successor must preserve the reviewed predecessor and mutex')

parts=[];manifest=[]
for name in names:
 path=root/'supabase/accounting/weekly-v3/components'/name
 source=path.read_text()
 begin=len(re.findall(r'^BEGIN;\s*$',source,re.M))
 commit=len(re.findall(r'^COMMIT;\s*$',source,re.M))
 expected=0 if name.startswith('20260914135530_') else 1
 if (begin,commit)!=(expected,expected):
  raise ValueError(f'{name}: unexpected transaction boundaries {begin}/{commit}')
 if re.search(r'^\s*(?:VACUUM|CREATE\s+DATABASE|DROP\s+DATABASE|COMMIT\s+AND|ROLLBACK\s*;)|\bINDEX\s+CONCURRENTLY\b',source,re.I|re.M):
  raise ValueError(f'{name}: non-atomic statement is not allowed')
 payload=re.sub(r'^(?:BEGIN|COMMIT);\s*$','',source,flags=re.M).strip()
 manifest.append({'name':name,'sha256':hashlib.sha256(source.encode()).hexdigest()})
 parts.append('-- Component '+name+'\n'+payload+'\n')
header='''-- UNAPPLIED CANDIDATE. Generated from source-reviewed components.
-- Generation is not qualification; the complete final tree requires fresh
-- protected execution. Historical component results do not certify these bytes.
-- Complete schema replay, commercial terms, compatible engine reader deployment,
-- and exact live preimage verification are still required before activation.
-- All components share ONE transaction; no partial coordinator cutover.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='300s';
SELECT pg_advisory_xact_lock(hashtextextended('accounting-authority-install',0));
'''
sql=header+'\n'.join(parts)+'\nCOMMIT;\n'
assert len(re.findall(r'^BEGIN;\s*$',sql,re.M))==1
assert len(re.findall(r'^COMMIT;\s*$',sql,re.M))==1
candidate=output/'candidate.sql'
if arguments.check:
 if candidate.read_text()!=sql:raise SystemExit('Accounting activation candidate is stale; regenerate it from its components')
else:candidate.write_text(sql)
# This prefix is only a negative-fixture prerequisite. The privacy
# component is then invoked separately to prove its guard and rollback after
# injecting a bad inherited service role. Never use this prefix for activation.
privacy_predecessor='-- NEGATIVE FIXTURE ONLY. NOT AN ACTIVATION ARTIFACT.\n'+header+'\n'.join(parts[:privacy_index])+'\nCOMMIT;\n'
privacy_predecessor_path=output/'qualification-preprivacy.sql'
if arguments.check:
 if privacy_predecessor_path.read_text()!=privacy_predecessor:raise SystemExit('Privacy rejection predecessor is stale')
else:privacy_predecessor_path.write_text(privacy_predecessor)
# Negative/acceptance fixture baseline only: preserve captured live attnums
# across the known removed agents column. The retained schema input is never
# edited, and this artifact is never an activation component.
transform_path=root/'tests/fixtures/credit-reduction-authority/baseline-ordinal-transform.json'
transform=json.loads(transform_path.read_text())
if (transform['input_path']!='tests/fixtures/full-weekly-accounting/schema.sql'
 or transform['output_name']!='qualification-credit-baseline.sql' or transform['match_count']!=1):
 raise ValueError('Unexpected credit fixture baseline transformation identity')
baseline_input=(root/transform['input_path']).read_bytes()
if (len(baseline_input)!=transform['input_bytes']
 or hashlib.sha256(baseline_input).hexdigest()!=transform['input_sha256']):
 raise ValueError('Retained fixture baseline input changed')
capture=(root/'supabase/accounting/credit-reduction-v1/captured-credit-catalog.json').read_bytes()
if hashlib.sha256(capture).hexdigest()!=transform['capture_sha256']:
 raise ValueError('Credit baseline ordinal capture changed')
baseline_text=baseline_input.decode('utf-8')
if baseline_text.count(transform['before'])!=1:
 raise ValueError('Credit fixture baseline anchor changed')
baseline=baseline_text.replace(transform['before'],transform['after']).encode('utf-8')
if (len(baseline)!=transform['output_bytes']
 or hashlib.sha256(baseline).hexdigest()!=transform['output_sha256']):
 raise ValueError('Credit fixture baseline output changed')
baseline_path=output/'qualification-credit-baseline.sql'
if arguments.check:
 if baseline_path.read_bytes()!=baseline:raise SystemExit('Credit qualification baseline is stale')
else:baseline_path.write_bytes(baseline)
manifest=json.dumps({
 'status':'unapplied_candidate_requires_protected_qualification','components':manifest,'sha256':hashlib.sha256(sql.encode()).hexdigest(),
 'excluded_installed_migrations':['20260914132918','20260914132929','20260914132940','20260914140459','20260914141405','20260914151155'],
 'not_yet_included':[],
 'qualification_only':{'privacy_predecessor':{'file':privacy_predecessor_path.name,
  'through_component':names[privacy_index-1],'component_count':privacy_index,
  'sha256':hashlib.sha256(privacy_predecessor.encode()).hexdigest(),
  'activation_allowed':False},
 'credit_baseline':{'file':baseline_path.name,'input_sha256':transform['input_sha256'],
  'transform_sha256':hashlib.sha256(transform_path.read_bytes()).hexdigest(),
  'sha256':hashlib.sha256(baseline).hexdigest(),'activation_allowed':False}},
},indent=2)+'\n'
manifest_path=output/'manifest.json'
if arguments.check:
 if manifest_path.read_text()!=manifest:raise SystemExit('Accounting activation manifest is stale')
else:manifest_path.write_text(manifest)
print(f'Bound {len(names)} components in one transaction, {len(sql.encode())} bytes; qualification and activation remain separate')
