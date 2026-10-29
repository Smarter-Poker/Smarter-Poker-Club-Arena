#!/usr/bin/env python3
"""Hermetic regressions for commit ownership and independent action census."""
import copy,importlib.util,json,subprocess,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('turn_census',Path(__file__).with_name('horse-turn-census-packet.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
START='2026-10-28T01:00:00.000Z';END='2026-10-28T01:00:40.000Z';SHA='a'*40
IDS=[f'00000000-0000-4000-8000-{i:012x}' for i in range(1000)]
def fixture():
    return {'timeIndexValid':True,'snapshot':'1:2:','readAt':END,'horseIds':IDS[::-1],
      'hands':[{'id':'10000000-0000-4000-8000-000000000001','table_id':'20000000-0000-4000-8000-000000000001','lease_generation':'30000000-0000-4000-8000-000000000001','hand_number':'1000001','source_owner':'classic','accepted':True,'actions_valid':True,'original_actions_match':True,'non_decision_diagnostics':{'forcedPosts':0,'uncalledReturns':0,'unknownNonDecision':0},'committed_at_ms':1793149201000,'original_context_match':True,'original_context':{'variant':'nlh','format':'cash','provenance':'retained_submission_and_committed_history'},
       'actions':[{'actorId':IDS[1],'actionOrdinal':3,'stage':'preflop','action':'check','origin':'horse_policy','amount':0,'seat':1,'timestamp':1793149199000}]}]}
def make(v=None):return c.packet_from_rows(v or fixture(),SHA,START,END)
class CensusTests(unittest.TestCase):
    def test_context_all_supported_variants_and_original_match(self):
        for variant in sorted(c.VARIANTS):
            v=fixture();v['hands'][0]['original_context']['variant']=variant
            p,a=make(v);self.assertEqual(p['version'],3);self.assertEqual(p['hands'][0]['context']['variant'],variant)
            self.assertEqual(a['handDomains'][0]['context'],p['hands'][0]['context'])
        for value in ('plo', 'plo_hilo', 'eight_cards', None):
            v=fixture();v['hands'][0]['original_context']['variant']=value
            with self.assertRaises(ValueError):make(v)
        v=fixture();v['hands'][0]['original_context_match']=False
        with self.assertRaisesRegex(ValueError,'original_context_mismatch'):make(v)
    def test_legacy_ledger_remains_unknown_and_mixed_union_refused(self):
        p,a=make();new=c.summarize(p,a,[])['turnCensusLedger'];old=copy.deepcopy(new)
        old['schema']='horse-turn-census-ledger-v1'
        for o in old['observations']:
            for h in o['handDomains']:h.pop('context')
        for r in old['turns']:r.pop('contextBinding');r.pop('historyReason')
        before=copy.deepcopy(old)
        self.assertEqual(c.ledger_summary(c.validate_ledger(old))['contextEvidence']['unknown:unknown']['matchedContextTurns'],0)
        self.assertEqual(old,before)
        with self.assertRaisesRegex(ValueError,'census_union_mismatch'):c.union_ledgers([old,new])
    def test_context_attestation_tampering_refuses(self):
        p,a=make();a['handDomains'][0]['context']={**a['handDomains'][0]['context'],'variant':'plo8'}
        with self.assertRaisesRegex(ValueError,'census_domain'):c.summarize(p,a,[])
    def test_boundary_commit_owns_earlier_decision(self):
        p,a=make();self.assertEqual(p['hands'][0]['actions'][0]['timestamp'],1793149199000);self.assertEqual(a['expectedActions'],1)
    def test_full_original_ordinal_and_sorted_cohort(self):
        p,a=make();self.assertEqual(p['horseIds'],IDS);self.assertEqual(p['hands'][0]['actions'][0]['actorIndex'],1);self.assertEqual(p['hands'][0]['actions'][0]['actionOrdinal'],3)
    def test_all_origins_retained(self):
        v=fixture();base=v['hands'][0]['actions'][0];v['hands'][0]['actions']=[{**base,'origin':origin,'actionOrdinal':i} for i,origin in enumerate(sorted(c.ORIGINS))]
        self.assertEqual(make(v)[1]['expectedActions'],6)
    def test_original_acceptance_and_actions_required(self):
        for key in ('accepted','actions_valid','original_actions_match'):
            v=fixture();v['hands'][0][key]=False
            with self.assertRaises(ValueError):make(v)
    def test_source_and_roster_refused(self):
        with self.assertRaises(ValueError):c.packet_from_rows(fixture(),'bad',START,END)
        v=fixture();v['horseIds'][0]=v['horseIds'][1]
        with self.assertRaises(ValueError):make(v)
    def test_ordinal_duplicate_refused(self):
        v=fixture();v['hands'][0]['actions']*=2
        with self.assertRaises(ValueError):make(v)
    def test_unknown_policy_actor_not_silently_dropped(self):
        v=fixture();v['hands'][0]['actions'][0]['actorId']='f'*36
        with self.assertRaises(ValueError):make(v)
    def test_attestation_no_raw_actor_or_card(self):
        p,a=make();encoded=json.dumps(a);self.assertNotIn(IDS[1],encoded);self.assertNotIn('cards',encoded);self.assertEqual(a['handDomains'][0]['domainDigest'],c.digest(p['hands'][0]['actions']))
    def test_commit_half_open_end(self):
        v=fixture();v['hands'][0]['committed_at_ms']=1793149240000
        with self.assertRaises(ValueError):make(v)
    def test_nullable_exact_fields(self):
        v=fixture();v['hands'][0]['actions'][0].update(amount=None,seat=None,timestamp=None);self.assertIsNone(make(v)[0]['hands'][0]['actions'][0]['amount'])
    def test_partition_limits_no_truncation(self):
        p,_=make();hand=p['hands'][0];p['hands']=[{**hand,'actions':[{}]*600} for _ in range(17)]
        with self.assertRaises(ValueError):c.partition_packets(p)
    def test_partition_closed_output_working_bound(self):
        self.assertEqual(c.PARTITION_TURN_LIMIT,256)
        p,_=make();hand=p['hands'][0]
        p['hands']=[{**hand,'actions':[{}]*256},{**hand,'actions':[{}]}]
        self.assertEqual([sum(len(h['actions']) for h in part['hands']) for part in c.partition_packets(p)],[256,1])
        p['hands']=[{**hand,'actions':[{}]*257}]
        with self.assertRaisesRegex(ValueError,'partition_action_bound'):c.partition_packets(p)
    def test_query_bounded_independent_projection(self):
        q=c.query(START,END);self.assertIn('LIMIT 1025',q);self.assertIn('WITH ORDINALITY',q);self.assertIn('submission_id=h.id',q);self.assertIn('s.original_actions=h.actions',q);self.assertNotIn("a.value->'cards'",q)
    def test_known_nondecisions_retained_separately(self):
        v=fixture();v['hands'][0]['non_decision_diagnostics']={'forcedPosts':2,'uncalledReturns':1,'unknownNonDecision':0}
        p,a=make(v);result=c.summarize(p,a,[]);self.assertEqual(result['expectedTurns'],1);self.assertEqual(result['nonDecisionDiagnostics']['forcedPosts'],2);self.assertEqual(c.union_ledgers([result['turnCensusLedger']]*2)['nonDecisionDiagnostics']['uncalledReturns'],1)
    def test_unknown_nondecision_refuses_instead_of_dropping(self):
        v=fixture();v['hands'][0]['non_decision_diagnostics']['unknownNonDecision']=1
        with self.assertRaisesRegex(ValueError,'unknown_nondecision'):make(v)
    def test_missing_partition_keeps_independent_expected_row(self):
        p,a=make();s=c.summarize(p,a,[]);self.assertEqual(s['expectedTurns'],1);self.assertEqual(s['missingTurns'],1);self.assertEqual(s['unobservedHorses'],1000)
    def test_union_retry_deduplicates_and_overlap_refuses(self):
        p,a=make();l=c.summarize(p,a,[])['turnCensusLedger'];self.assertEqual(c.union_ledgers([l,l])['expectedTurns'],1)
        other=copy.deepcopy(l);other['observations'][0]['packetDigest']='f'*64
        with self.assertRaises(ValueError):c.union_ledgers([l,other])
    def test_union_source_cohort_mismatch_refused(self):
        p,a=make();l=c.summarize(p,a,[])['turnCensusLedger']
        for field,value in [('sourceSha','b'*40),('cohortDigest','c'*64)]:
            other=copy.deepcopy(l);other[field]=value
            with self.assertRaises(ValueError):c.union_ledgers([l,other])
    def test_union_disjoint_keeps_missing_turns(self):
        p,a=make();l=c.summarize(p,a,[])['turnCensusLedger'];other=copy.deepcopy(l)
        other['observations'][0].update(packetDigest='e'*64,window={'startUtc':'2026-10-28T01:00:40.000Z','endUtc':'2026-10-28T01:01:20.000Z'});other['turns'][0]['handKey']='d'*64
        other['observations'][0]['handDomains'][0].update(handKey='d'*64,committedAtMs=1793149241000)
        result=c.union_ledgers([l,other]);self.assertEqual(result['expectedTurns'],2);self.assertEqual(result['missingTurns'],2)
    def test_private_field_ledger_injection_refused(self):
        p,a=make();l=c.summarize(p,a,[])['turnCensusLedger'];l['turns'][0]['cards']=['As','Ah']
        with self.assertRaises(ValueError):c.validate_ledger(l)
    def test_retained_ledger_omission_refused(self):
        p,a=make();l=c.summarize(p,a,[])['turnCensusLedger'];l['turns']=[]
        with self.assertRaisesRegex(ValueError,'census_ledger_omission'):c.validate_ledger(l)
    def test_javascript_numeric_digest(self):
        self.assertEqual(c.transport_digest({'amount':1.0,'timestamp':1e18}),c.transport_digest({'amount':1,'timestamp':1000000000000000000}))
    def test_actual_proof_module_digest_matches(self):
        p,_=make();p['hands'][0]['actions'][0]['amount']=1.0
        run=subprocess.run(['node','--input-type=module','-e',"import fs from 'node:fs';import{horseTurnCensusPacketDigest}from'./scripts/ci/horse-turn-census-proof.mjs';process.stdout.write(horseTurnCensusPacketDigest(JSON.parse(fs.readFileSync(0,'utf8'))));"],input=json.dumps(p),text=True,capture_output=True,check=True)
        self.assertEqual(run.stdout,c.transport_digest(p))
    def test_observed_row_omission_rejected(self):
        p,a=make();part=c.partition_packets(p)[0];row=c.missing_row(c.expected_rows(part)[0]);row['actionOrdinal']=4
        row['contextBinding']='unknown';row['historyReason']='unknown'
        observation={'version':3,'scope':'supplied_committed_turn_census','status':'unknown','rawRecordsExported':False,'replayVerified':False,'completePopulation':False,'strategyCorrectnessVerified':False,'activationAllowed':False,'sourceSha':SHA,'packetDigest':c.transport_digest(part),'expectedTurns':1,'validatedBytes':0,'boundReached':False,'missingTurns':1,'contradictoryTurns':0,'extraneousCaptures':0,'unboundCaptures':0,'inspectedHands':1,'remainingHands':0,'turns':[row]}
        result={'qualifiedExecution':True,'sourceSha':SHA,'packetDigest':observation['packetDigest'],'execution':{'observation':observation,'release':SHA,'exitCode':0,'containerExitCode':0,'sameServingIdentityAfter':True,'observerRemoved':True,'cleanupExitCode':0,'oomKilled':False,'readOnly':True,'network':'none','horseJournalMountVerified':True,'servingContainer':'a'*64,'imageId':'sha256:'+'b'*64,'servingStartedAt':START}}
        with self.assertRaisesRegex(ValueError,'census_expected_omission'):c.summarize(p,a,[result])
    def test_discard_binding_cannot_label_betting_input(self):
        p,_=make();row=c.missing_row(c.expected_rows(p)[0]);row.update(inputBinding='original_discard_request_and_controller',publicRead='not_applicable',historicalRead='not_applicable')
        with self.assertRaises(ValueError):c.validate_turn(row)
    def test_discard_lane_is_exact_and_forced_is_not_consumption(self):
        p,_=make();row=c.missing_row(c.expected_rows(p)[0]);row.update(action='discard',capture='present',execution='intended',selection='matched',expectedBinding='matched',handReconciliation='reconciled',inputBinding='original_discard_request_and_controller',publicRead='not_applicable',historicalRead='not_applicable')
        for stage in ('flop','pineapple_discard'):
            row['stage']=stage;self.assertEqual(c.validate_turn(row)['inputBinding'],'original_discard_request_and_controller')
        row['stage']='turn'
        with self.assertRaises(ValueError):c.validate_turn(row)
        forced=c.missing_row(c.expected_rows(p)[0]);forced.update(origin='forced',publicRead='not_applicable',historicalRead='not_applicable')
        self.assertEqual(c.validate_turn(forced)['inputBinding'],'unknown')
if __name__=='__main__':unittest.main()
