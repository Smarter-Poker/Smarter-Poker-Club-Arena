"""Synthetic pure controls only; no database or original production proof."""
import copy,importlib.util,json,hashlib
from pathlib import Path
import unittest
p=Path(__file__).with_name('spin-first-archived-postabort.py')
s=importlib.util.spec_from_file_location('draft_reader',p);M=importlib.util.module_from_spec(s);s.loader.exec_module(M)

def fixture():
    projection=dict({k:0 for k in M.B.FINANCIAL},id=M.OPERATION,union_id=M.B.UNION,rake_wallet=5)
    def obs(low,status,amount):
        row=copy.deepcopy(projection);row['rake_wallet']=amount
        return {'transaction_id':'100','snapshot_xmax':'110','isolation':'read committed','rows':[
            {'projection':row,'xmin':str(low),'full_xid':str(low),'eligible':low>=100,'status':status}]}
    rows={k:[] for k in M.SCOPED};rows[M.B.RELATION]=[projection]
    inside=copy.deepcopy(rows);inside['smarter_private.spin_archived_first_admission']=[{'admitted_xid':100}]
    d={'operation':M.OPERATION,'event':M.EVENT,'fee_capture_diagnostic':{'transaction_id':'100'},
        'before':copy.deepcopy(rows),'inside':inside,'replay_state':copy.deepcopy(inside),
        'bank_observations':[obs(99,None,5) for _ in range(3)]}
    e={'observed_at':'synthetic','transaction_id':None,'scoped_rows':copy.deepcopy(rows),
        'original_preimage':{'synthetic':True},'original_funding':{'synthetic':True},
        'history_exists':False,'atomic_commit_exists':False,'operation_id':M.OPERATION,
        'admission_empty':True,'later_authority_absent':{k:True for k in M.AUTHORITY},'tournament_lease_absent':True,
        'postabort_bank_witness':{'reference_transaction_id':'100','reference_status':'aborted','observer_transaction_id':None,
        'snapshot':'100:110:','bank_observation':obs(101,'committed',6)}}
    e['scoped_rows'][M.B.RELATION]=[copy.deepcopy(e['postabort_bank_witness']['bank_observation']['rows'][0]['projection'])]
    return d,e

def check(d,e):return M.validate(d,e,{'synthetic':True},{'synthetic':True})

class FirstArchivedPostabortTests(unittest.TestCase):
    def test_same_statement_external_and_unchanged(self):
        d,e=fixture();self.assertEqual(check(d,e)['bank_transition'],'external committed version')
        e['postabort_bank_witness']['bank_observation']=copy.deepcopy(d['bank_observations'][2]);e['scoped_rows'][M.B.RELATION]=copy.deepcopy(d['before'][M.B.RELATION])
        self.assertEqual(check(d,e)['bank_transition'],'unchanged')
    def test_failed_closed_mutations(self):
        mutations=[lambda d,e:e['postabort_bank_witness'].update(reference_status='committed'),
            lambda d,e:e['postabort_bank_witness'].update(reference_transaction_id='101'),
            lambda d,e:d['inside']['smarter_private.spin_archived_first_admission'][0].update(admitted_xid=True),
            lambda d,e:e['postabort_bank_witness'].update(observer_transaction_id='100'),
            lambda d,e:e['postabort_bank_witness'].update(snapshot='100:110:100'),
            lambda d,e:e['postabort_bank_witness'].update(snapshot='100:110:101'),
            lambda d,e:e['postabort_bank_witness']['bank_observation'].update(snapshot_xmax='111'),
            lambda d,e:e['postabort_bank_witness']['bank_observation']['rows'][0].update(status=None),
            lambda d,e:e['postabort_bank_witness']['bank_observation']['rows'][0].update(xmin='100',full_xid='100'),
            lambda d,e:e['postabort_bank_witness']['bank_observation']['rows'][0]['projection'].update(rake_wallet=True),
            lambda d,e:e['scoped_rows'][M.B.RELATION].clear(),
            lambda d,e:e['scoped_rows']['public.tournaments'].append({'changed':True}),
            lambda d,e:e['later_authority_absent'].update({'public.hand_history':1}),
            lambda d,e:e.update(admission_empty=1),lambda d,e:e.update(original_funding={}),
            lambda d,e:e['scoped_rows'].pop('public.clubs'),lambda d,e:e['postabort_bank_witness'].update(extra=True),
            lambda d,e:e['postabort_bank_witness'].update(snapshot='100:4294967296:'),
            lambda d,e:e['postabort_bank_witness']['bank_observation']['rows'].append(copy.deepcopy(e['postabort_bank_witness']['bank_observation']['rows'][0]))]
        for i,mutate in enumerate(mutations):
            d,e=fixture();mutate(d,e)
            with self.subTest(i=i),self.assertRaises((ValueError,KeyError)):check(d,e)
    def test_bind_is_numeric_and_original_identity_bound(self):
        d,e=fixture();query=M.bind_query(d)
        self.assertNotIn('__VERIFIED_ORIGINAL_T__',query);self.assertIn("SELECT '100'::numeric t",query)
        for value in ('100;SELECT1','0100',True,'-1',str(2**64)):
            d,e=fixture();d['fee_capture_diagnostic']['transaction_id']=value
            with self.subTest(value=value),self.assertRaises(ValueError):M.bind_query(d)
    def test_lossless_json_refuses_duplicate_and_nonfinite(self):
        self.assertEqual(str(M.decode_json('{"n":1.20}')['n']),'1.20')
        for raw in ('{"n":1,"n":2}','{"n":NaN}','{"n":Infinity}'):
            with self.subTest(raw=raw),self.assertRaises(ValueError):M.decode_json(raw)

    def test_retained_original_row_and_query_binding(self):
        d,e=fixture();query=M.bind_query(d)
        receipt={'query':query,'query_sha256':hashlib.sha256(query.encode()).hexdigest(),
            'original_output':json.dumps(e)+'\n','evidence':copy.deepcopy(e),'validation':check(d,e)}
        self.assertEqual(M.validate_receipt(d,receipt,{'synthetic':True},{'synthetic':True})['nonbank_rowsets_exact'],20)
        mutations=[lambda r:r.update(query=r['query']+'SELECT 1;'),lambda r:r.update(query_sha256='wrong'),
            lambda r:r.update(original_output=''),lambda r:r.update(original_output=r['original_output']+'{}'),
            lambda r:r.update(original_output=r['original_output'].replace('"history_exists": false','"history_exists": false,"history_exists": false')),
            lambda r:r['evidence'].update(admission_empty=False),lambda r:r['validation'].update(production_qualified=True),
            lambda r:r.update(extra=True)]
        for i,mutate in enumerate(mutations):
            bad=copy.deepcopy(receipt);mutate(bad)
            with self.subTest(i=i),self.assertRaises(ValueError):M.validate_receipt(d,bad,{'synthetic':True},{'synthetic':True})
    def test_successful_cases_read_after_explicit_worker_rollback(self):
        source=Path(__file__).with_name('spin-first-archived-bank-races.py').read_text()
        start=source.index("c['rollback_output']=worker.command('ROLLBACK;")
        read=source.index('raw=observer.command(query)')
        self.assertLess(start,read)
        self.assertIn("if kind in SUCCESS:",source[start:read])
        self.assertIn("postabort.validate_receipt(d,c['postabort'],expected_preimage,expected_funding)",source)
        self.assertIn("c['kind'] in ('external_after_observation','external_replay_blocked')",source)
        self.assertIn("wait['waiting_xids']==[xid]",source)
        self.assertIn("external.start(update)",source)

    def test_expected_preimage_is_owner_attestation_not_internal_rows(self):
        root=Path(__file__).resolve().parents[2]
        expected,funding=M.expected_original(root)
        self.assertEqual(set(expected),{'preimage_matched','financial_authority','evidence_kind',
            'source_sha256','tournament_id','original_atomic_commit','first_history','last_history','original_result'})
        self.assertIs(expected['preimage_matched'],True)
        self.assertIs(expected['financial_authority'],False)
        self.assertIsNone(expected['original_atomic_commit'])
        self.assertEqual(expected['tournament_id'],M.EVENT)
        self.assertNotIn('chip_ledger',expected)
        self.assertIsInstance(funding,dict)

    def test_sql_projection_is_one_materialized_row_source(self):
        self.assertEqual(M.QUERY.count('FROM public.union_wallets'),1)
        self.assertIn("'public.union_wallets',(SELECT coalesce(jsonb_agg(projection",M.QUERY)
        self.assertIn('FROM snapshot CROSS JOIN authority CROSS JOIN bank_witness;',M.QUERY)
        self.assertNotIn('txid_current()',M.QUERY)

if __name__=='__main__':unittest.main()
