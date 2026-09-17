"""Retained finite regression bodies, invoked by the same accounting BBJ caller.

Old developer-path/consumed-approval checks are superseded by test_current_ci.py.
Their original files remain byte-preserved provenance. Financial assertions and
all modeled constructor, cleanup, audit, uncertainty and ordering probes below
are executed unchanged; modeled passes never qualify a financial operation.
"""
import hashlib
import ast
import json
from pathlib import Path
from types import ModuleType

from current_ci import require, write_exclusive
from custody import _contained
from retained import RetainedModules

HERE = Path(__file__).resolve().parent
REGRESSION_MANIFEST = '40d1787cbfbab994aef4c6ba3a07a6cb8631806753fcfb41b4a97e4cb678ab13'


class RegressionSources:
    def __init__(self, custody):
        self.custody = custody
        raw = (HERE/'regressions/SOURCES.json').read_bytes()
        require(hashlib.sha256(raw).hexdigest() == REGRESSION_MANIFEST, 'Regression custody manifest changed')
        self.rows = {}
        for row in json.loads(raw)['files']:
            group = custody._manifest['groups'][row['group']]
            require(row['original_seal'] == group['original_integrity_sha256'], 'Regression original seal changed')
            seal = json.loads((HERE/group['historical_seal_path']).read_text())['files']
            if isinstance(seal, list):
                seal = {entry['path']: entry['sha256'] for entry in seal}
            require(seal.get(row['original_member']) == row['sha256'], 'Regression is not its sealed original')
            key = row['group'] + '/' + row['original_member']
            require(key not in self.rows, 'Duplicate regression source')
            self.rows[key] = row
            self.read(key)
        require(len(self.rows) == 6, 'Exact six regression source members required')

    def read(self, name):
        require(name in self.rows, 'Unknown regression input')
        row = self.rows[name]
        path = _contained(HERE, row['path'])
        require(path.resolve().is_relative_to(HERE/'regressions/original'),
                'Regression source escaped original custody')
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == row['sha256'] and len(raw) == row['bytes'],
                'Original regression bytes changed')
        return raw.decode()


def changed(text, before, after):
    require(text.count(before) == 1, 'Retained regression binding seam changed')
    return text.replace(before, after, 1)


def continuity(custody):
    """Source/cleanup custody checks, not execution of an old public runner."""
    original = (HERE/'provenance/backup_adapter/run_integration.py.txt').read_text()
    transforms = json.loads((HERE/'CALLER-TRANSFORMS.json').read_text())
    require(hashlib.sha256(original.encode()).hexdigest() == transforms['original_sha256'], 'Original runner changed')
    body = original[original.index(transforms['retained_body_start']):original.index(transforms['retained_body_end'])]
    require(len(transforms['changes']) == 13, 'Finite caller binding transform inventory changed')
    for item in transforms['changes']:
        body = changed(body, item['before'], item['after'])
    deadline_changes = json.loads((HERE/'DEADLINE-TRANSFORMS.json').read_text())['changes']
    for item in deadline_changes:
        body = changed(body, item['before'], item['after'])
    actual = (HERE/'execution.py').read_text()
    require(actual[actual.index(transforms['retained_body_start']):].rstrip() == body.rstrip(),
            'Internal caller differs beyond its declared portable bindings')
    # The preserved Psql.sql method has a 60-second default. Its owning I/O
    # deadline uses that original cap; no retained call may override it.
    for row in custody._manifest['files']:
        if row['path'].endswith('.py') and row['binding'] == 'exact_direct_input':
            module = ast.parse((HERE/row['path']).read_text())
            for call in ast.walk(module):
                if isinstance(call,ast.Call) and isinstance(call.func,ast.Attribute) and call.func.attr == 'sql':
                    require(len(call.args) == 1 and not call.keywords,
                            'Retained SQL call no longer uses the original default statement cap')
    # The deadline successor changes waits/removal bounds only. All declared
    # changes above are exact; original inactivity/identity predicates stay intact.
    old = original
    rows = json.loads((HERE/'provenance/backup_adapter/RUNNER-TRANSFORMS.json').read_text())
    require(len(rows) == 26, 'Original26 transforms changed')
    for item in reversed(rows):
        old = changed(old, item['after'], item['before'])
    opening_seal = json.loads((HERE/'provenance/opening_adapter/INTEGRITY.json').read_text())['files']
    if isinstance(opening_seal, list):
        opening_seal = {row['path']: row['sha256'] for row in opening_seal}
    require(hashlib.sha256(old.encode()).hexdigest() == opening_seal['run_integration.py'],
            'Original26 inverse transforms no longer recover original0124')
    return {'passed': True, 'original_transform_count': 26, 'portable_transform_count': 13,
            'physical_cleanup_predicates_preserved': True, 'deadline_transform_count': len(deadline_changes)}


def run_retained_regressions(custody, selected, fresh_events, evidence):
    source = RegressionSources(custody)
    report = {'passed': False, 'modeled_only': True, 'financial_qualification': False,
              'historical_run_answers_used': False, 'stages': []}
    # Fresh instances prevent modeled monkeypatches from escaping into actual financial execution.
    def bindings():
        return RetainedModules(custody, None, 'SEQ08_BBJ_BACKUP_POSITIVE_MAIN_TRANSFER_25')
    def execute(label, text, context):
        stage = {'name': label, 'status': 'ATTEMPTED', 'checks': []}
        report['stages'].append(stage)
        namespace = {'__name__': 'retained_bbj_checks', '__file__': str(HERE/'regressions'/label), **context}
        try:
            exec(compile(text, str(HERE/'regressions'/label), 'exec'), namespace)
            checks = namespace.get('checks', [])
            require(type(checks) is list and checks and all(row.get('passed') is True for row in checks),
                    'Retained regressions must execute nonzero complete successes')
            stage.update(status='PASSED_MODELED_ONLY', checks=checks, count=len(checks))
        except BaseException as error:
            stage.update(status='FAILED', checks=namespace.get('checks', []),
                         error_type=type(error).__name__, error=str(error))
            raise
    try:
        report['source_continuity'] = continuity(custody)
        bound = bindings()
        text = source.read('backup_adapter/check_adapter.py')
        start = text.index("identity={'database':'fixture_base'")
        end = text.index("report={'status':'PASS','scope':")
        # Historical full683pin/native-approval/source-generator prelude stays provenance.
        # The physical/constructor/cleanup/choreography/metadata/failure checks are unchanged.
        text = text[start:end]
        prelude = '''import ast, hashlib, json, sys
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
checks=[]
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append({'name':name,'passed':True})
def refused(name,fn):
    try:fn()
    except Exception:
        check(name,True);return
    raise AssertionError('Did not refuse: '+name)
'''
        execute('adapter_checks.py', prelude + text, {'adapter': bound.adapter, 'pins': bound.config})
        bound = bindings()
        text = source.read('backup_adapter/test_audit_reader.py')
        old = "sys.path.insert(0,str(HERE))\nimport case_module as adapter"
        text = changed(text, old, '# The exact current bound adapter is supplied by the accounting caller.')
        execute('audit_reader.py', text, {'adapter': bound.adapter})
        bound = bindings()
        text = source.read('supplement/test_audit_contract.py')
        start = text.index("spec = importlib.util.spec_from_file_location")
        end = text.index('checks = []', start)
        text = text[:start] + "a = bound.supplement.A\nmodel = custody.read_json('supplement/AUDIT-EXPECTED.json')\nmodels = custody.read_json('supplement/EXPECTED.json')\n" + text[end:]
        execute('audit_contract.py', text, {'bound': bound, 'custody': custody})
        # Same eight original promo uncertainty/order cases; old false native-template
        # assertion is replaced by current CI rejection tests, not accepted as authority.
        promo = RetainedModules(custody, None, 'SEQ08_BBJ_PROMO_POSITIVE_MAIN_TRANSFER_25')
        text = source.read('promo_adapter/test_promo_composition.py')
        text = changed(text, "sys.path.insert(0, str(HERE))\nimport binding\nimport case_module as adapter", '')
        operation = {'move_operation': 'modeled-current-promo-operation',
                     'move_reason': 'Modeled fresh promo transfer reason only.'}
        proxy = ModuleType('modeled_promo_binding')
        proxy.CASE = promo.selected
        def modeled_read(path):
            if Path(path).name == 'SOURCE-PINS.json':
                return promo.config
            if Path(path).name == 'OPERATION.json':
                return operation
            return promo.read_path(path)
        proxy.load = modeled_read
        text += "\nchecks=[exercise(mode) for mode in ('success','opening_failure','double_seed','promo_failure','uncertain_commit','missing_phase','extra_phase','cleanup_failure')]\n"
        execute('promo_composition.py', text, {'binding': proxy, 'adapter': promo.adapter})
        # The original offline collector now replays THIS run's validated base
        # responses. It never imports a historical execution receipt into the fixture.
        bound = bindings()
        text = source.read('supplement/test_offline.py')
        text = changed(text, "P=Path(__file__).resolve().parent", "P=custody.group_path('supplement')")
        old = "s=ModuleType('bbj_test_supplemental');s.__file__=str(P/'supplemental.py');exec(compile((P/'supplemental.py').read_text(),s.__file__,'exec'),s.__dict__)\na=s.read(P/'SOURCE-AUTHORITY.json');m=s.read(P/'EXPECTED.json');C=Path(a['case']);A=Path(a['adapter0124'])"
        new = "s=bound.supplement\na=bound.supplement_sources();m=custody.read_json('supplement/EXPECTED.json');C=custody.group_path('backup');A=custody.group_path('opening_adapter')"
        text = changed(text, old, new)
        old = "fixture_path=A/'execution-runs/ec5d102b7b694b0abedf9d7afbdea441/PREFLIGHT.json'\nold=s.read(fixture_path);answers={}"
        text = changed(text, old, "old={'events':fresh_events};answers={}")
        old = "Path(next(x['path'] for x in a['pins'] if x['path'].endswith('/20260912070357_bbj_bank_move_replay_matches_payload.sql'))).read_text()"
        text = changed(text, old, "current_installer")
        original_read = bound.supplement.read
        def read(path):
            if Path(path) == custody.group_path('backup')/'CURRENT-TRIGGER-FUNCTIONS.json':
                return json.loads(source.read('backup/CURRENT-TRIGGER-FUNCTIONS.json'))
            return original_read(path)
        bound.supplement.read = read
        root = HERE.parents[4]
        installer = root/'supabase/migrations/20260912070357_bbj_bank_move_replay_matches_payload.sql'
        installer_text = installer.read_text()
        require(hashlib.sha256(installer_text.encode()).hexdigest() == 'c70c4ee46dab55852206cfa31cc3adcfe721cd2746a79c436cc555fb66ddb6d4',
                'Maintained original BBJ installer changed')
        execute('supplemental_protocol.py', text, {'bound': bound, 'custody': custody,
                'fresh_events': fresh_events, 'current_installer': installer_text})
        require(len(report['stages']) == 5 and all(row['status'] == 'PASSED_MODELED_ONLY' for row in report['stages']),
                'All five retained regression groups required')
        report['passed'] = True
        return report
    except BaseException as error:
        report.update(error_type=type(error).__name__, error=str(error))
        raise
    finally:
        write_exclusive(Path(evidence)/'RETAINED-REGRESSIONS.json', report)
