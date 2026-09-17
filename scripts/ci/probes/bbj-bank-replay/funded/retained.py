"""Finite bindings for exact retained modules. SQL, case bodies and comparators stay unchanged.

Obsolete developer-path/import/admission functions are rebound. The complete
metadata selection is also projected onto the original DDL planner after its
immutable builtins are checked. There is no external-path fallback, historical
review override, or public execution entry point.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sys
from types import ModuleType

from current_ci import ACTOR, CLUB, OPENING, require, sha


@contextmanager
def imports(values):
    previous = {name: sys.modules.get(name) for name in values}
    try:
        for name, value in values.items():
            require(previous[name] is None or previous[name] is value,
                    'Conflicting retained module import: ' + name)
            sys.modules[name] = value
        yield
    finally:
        for name, value in previous.items():
            require(sys.modules.get(name) is values[name], 'Retained import ownership changed')
            if value is None:
                del sys.modules[name]
            else:
                sys.modules[name] = value


def obsolete(*args, **kwargs):
    raise RuntimeError('Historical admission is not a current accounting CI permit')


INSTALLER_PREFIX = "SET LOCAL lock_timeout = '1000ms';\nSET LOCAL statement_timeout = '15000ms';"


def literal_installer_transport(source):
    """Frame one authenticated installer; psql must not strip its audit comments.

    The two original SET statements still execute first on the same connection.
    gexec sends its single returned text value literally, including the complete
    original DO query's whitespace/comments. It does not interpret its contents
    as psql commands or variables. The caller supplies sealed source, never a
    query observed from a previous run.
    """
    require(source.startswith(INSTALLER_PREFIX), 'Exact original installer SET order required')
    body = source[len(INSTALLER_PREFIX):]
    require(body.startswith('\n-- ') and '\nDO $install$\n' in body and body.endswith('$install$;\n'),
            'Complete original installer DO source required')
    tag = '$bbj_literal_' + hashlib.sha256(body.encode()).hexdigest() + '$'
    require(tag not in body, 'Installer literal delimiter collision')
    original = source.rstrip().rstrip(';') + ';\n\\echo '

    def frame(payload):
        if not payload.startswith(INSTALLER_PREFIX):
            return payload
        require(payload.startswith(original), 'Unrecognized original installer transport payload')
        barrier = payload[len(original):]
        require(re.fullmatch(r'g8_barrier_[0-9a-f]{32}\n', barrier) is not None,
                'Exact original installer barrier required')
        return INSTALLER_PREFIX + '\nSELECT ' + tag + body + tag + '\n\\gexec\n\\echo ' + barrier
    return frame


class RetainedModules:
    def __init__(self, custody, operation, selected):
        self.custody, self.operation, self.selected = custody, operation, selected
        self.modules = {}
        self.source_changes = []
        self.config = self.source_config()
        self.resource = self.load('resources/resource_safety.py')
        self.driver = self.load('schema/sequence_driver.py')
        self.preflight = self.load('schema/preflight.py')
        self.identity = self.load('identity/oid_identity.py')
        self.parser = self.load('parser/catalog_contract.py')
        builder = self.load('registry/build_registry.py')
        self.registry = self.load('registry/registry_preflight.py', {'build_registry': builder})
        self.binding = self.load('opening_adapter/binding.py')
        for name in ('verify_binding', 'verify_seal', 'verify_prior_fixture_preflight', 'assert_prior_disposals'):
            setattr(self.binding, name, obsolete)
        self.binding.load = self.read_path
        self.queries = self.load('opening_adapter/catalog_queries.py')
        old = "pins=json.loads((HERE/'SOURCE-PINS.json').read_text());"
        self.normalizer = self.load('opening_adapter/normalization.py',
                                   {'binding': self.binding, 'catalog_queries': self.queries},
                                   ((old, 'pins=current_source_binding();'),))
        self.normalizer.current_source_binding = self.checked_config
        self.normalizer.load_module = self.load_path
        contract = self.load('opening/packet_contract.py')
        contract.read = self.opening_read
        contract.sha = self.checked_sha
        contract.verify_pins = self.verify_sources
        contract.verify_authorization = lambda auth, driver, seed: self.authorize('opening', auth, driver, seed)
        self.contract = contract
        with imports({'packet_contract': contract}):
            pair = self.load('opening/pair_support.py')
            noninterference = self.load('opening/noninterference.py')
            supplemental = self.load('opening/supplemental.py')
            self.opening_supplemental = supplemental
            self.opening = self.load('opening/case_module.py', {
                'pair_support': pair, 'supplemental': supplemental, 'noninterference': noninterference})
        self.opening_adapter = self.load('opening_adapter/case_module.py', {'binding': self.binding})
        self.opening_adapter.author_modules = lambda: (self.opening, supplemental, self.checked_config())
        self.backup = self.load('backup/case_module.py')
        self.backup.read = lambda name: custody.read_json('backup/' + name)
        self.backup.sha = self.checked_sha
        self.backup.verify_authorization = lambda auth, driver, seed, opening: self.authorize('transfer', auth, driver, seed, opening)
        self.promo = self.load('promo/case_module.py')
        self.promo.SHARED = custody.group_path('backup')
        self.promo.read = lambda name: custody.read_json('backup/' + name)
        self.promo.sha = self.checked_sha
        self.promo.verify_authorization = lambda auth, driver, seed, opening: self.authorize('transfer', auth, driver, seed, opening)
        self.supplement = self.load('supplement/supplemental.py', replacements=((
            "log['audit_plan']=A.planned_events(models,choice)",
            "log['audit_plan']=plan_complete_preimage(models,choice)"),))
        self.supplement.plan_complete_preimage = self.plan_complete_preimage
        self.supplement.Q = self.load('supplement/queries.py')
        self.supplement.A = self.load('supplement/audit_contract.py')
        self.supplement.read = self.read_path
        self.supplement.sha = self.checked_sha
        self.supplement.verify_sources = self.supplement_sources
        self.supplement.libraries = lambda unused: (
            self.preflight, self.binding, self.registry, supplemental, self.queries, self.backup)
        audit = custody.read_json('supplement/AUDIT-EXPECTED.json')
        installers = [row for row in audit['dispatches'] if row['sql'].startswith(INSTALLER_PREFIX)]
        require(len(installers) == 1, 'One sealed original installer dispatch required')
        installer = installers[0]
        require(hashlib.sha256(installer['sql'].encode()).hexdigest() == installer['sha256'],
                'Original installer dispatch hash differs')
        models = custody.read_json('supplement/EXPECTED.json')
        statements = [sql for item in models['functions'] for sql in item['statements']]
        require(statements.count(installer['sql']) == 1, 'Installer must match original metadata source')
        self.literal_dispatch = literal_installer_transport(installer['sql'])
        group = 'backup_adapter' if selected == 'SEQ08_BBJ_BACKUP_POSITIVE_MAIN_TRANSFER_25' else 'promo_adapter'
        self.adapter_binding = ModuleType('current_bbj_adapter_binding')
        self.adapter_binding.CASE = selected
        self.adapter_binding.require = require
        self.adapter_binding.digest = self.checked_sha
        self.adapter_binding.load = self.adapter_read
        self.adapter_binding.verify_binding = self.verify_binding
        self.adapter = self.load(group + '/case_module.py', {'binding': self.adapter_binding})
        self.adapter.parent_modules = lambda: (self.opening_adapter, self.normalizer, self.opening, supplemental)
        self.adapter.backup_module = lambda: self.backup
        if group == 'promo_adapter':
            self.adapter.promo_module = lambda: self.promo
        self.adapter.supplemental_module = lambda: self.supplement
        self.group = group

    def plan_complete_preimage(self, models, choice):
        """Preserve the full collector contract and the original four-function planner.

        The collector checks public functions followed by immutable RI builtins.
        Only the public prefix can own supplemental DDL; missing, changed or
        non-final builtin observations must never be silently sliced away.
        """
        require(type(choice) is dict and set(choice) == {'functions', 'tables', 'sequences'},
                'Complete original preimage categories required')
        for kind in ('functions', 'tables', 'sequences'):
            expected = len(models[kind]) + (len(models['builtins']) if kind == 'functions' else 0)
            require(type(choice[kind]) is list and len(choice[kind]) == expected,
                    'Complete original ' + kind + ' preimage selection required')
        public_count = len(models['functions'])
        for item, phase in zip(models['builtins'], choice['functions'][public_count:]):
            require(phase == 'after' and item['statements'] == [] and
                    self.supplement.exact(item['before'], item['after']),
                    'Original immutable builtin preimage changed')
        planner_choice = {**choice, 'functions': choice['functions'][:public_count]}
        return self.supplement.A.planned_events(models, planner_choice)

    def source_config(self):
        custody = self.custody
        groups = custody._manifest['groups']
        mapping = {'fixture': 'registry', 'resource_fixture': 'resources', 'schema_fixture': 'schema',
                   'identity_fixture': 'identity', 'parser_fixture': 'parser',
                   'opening_adapter': 'opening_adapter', 'author_packet': 'opening',
                   'backup_packet': 'backup', 'promo_packet': 'promo', 'supplemental_packet': 'supplement'}
        result = {name: str(custody.group_path(group)) for name, group in mapping.items()}
        for name, group in mapping.items():
            key = {'author_packet': 'author_integrity_sha256', 'backup_packet': 'backup_integrity_sha256',
                   'promo_packet': 'promo_integrity_sha256', 'supplemental_packet': 'supplemental_integrity_sha256'}.get(name, name + '_integrity_sha256')
            result[key] = groups[group]['original_integrity_sha256']
        result.update(seed_path=str(custody.source_path('resources/seed.sql')),
                      seed_sha256=sha(custody.source_path('resources/seed.sql')),
                      driver_sha256=sha(custody.source_path('schema/sequence_driver.py')),
                      supplemental_module='supplemental.py')
        return result

    def verify_sources(self):
        self.custody.__class__()  # All87 selected original members and seals, never the old683 graph.
        return self.custody.receipt()

    def checked_config(self):
        self.verify_sources()
        return dict(self.config)

    def input_id(self, path):
        path = Path(path).resolve()
        found = [name for name, row in self.custody._files.items()
                 if (self.custody._root / row['path']).resolve() == path and row['binding'] == 'exact_direct_input']
        require(len(found) == 1, 'Only an explicitly mapped executable source input is readable: ' + str(path))
        return found[0]

    def read_path(self, path):
        return self.custody.read_json(self.input_id(path))

    def checked_sha(self, path):
        return hashlib.sha256(self.custody.read_bytes(self.input_id(path))).hexdigest()

    def opening_read(self, name):
        if name == 'SOURCE-PINS.json':
            # This is a new finite source binding, not the old all-member/policy authority list.
            return [{'role': 'base_checker', 'path': str(self.custody.source_path('schema/preflight.py')),
                     'sha256': self.checked_sha(self.custody.source_path('schema/preflight.py'))}]
        return self.custody.read_json('opening/' + name)

    def adapter_read(self, path):
        require(Path(path).resolve() == self.custody.group_path(
            'backup_adapter' if self.selected.endswith('BACKUP_POSITIVE_MAIN_TRANSFER_25') else 'promo_adapter') / 'SOURCE-PINS.json',
            'Unexpected adapter metadata lookup')
        return self.checked_config()

    def supplement_sources(self):
        self.verify_sources()
        return {name: str(self.custody.group_path(group)) for name, group in {
            'schema_fixture': 'schema', 'registry_fixture': 'registry', 'opening': 'opening',
            'adapter0124': 'opening_adapter', 'case': 'backup'}.items()}

    def load(self, source_id, names=None, replacements=()):
        if source_id in self.modules:
            return self.modules[source_id]
        path = self.custody.source_path(source_id)
        raw = self.custody.read_bytes(source_id)
        text = raw.decode()
        for before, after in replacements:
            require(text.count(before) == 1, 'Exact legacy path-read replacement differs')
            text = text.replace(before, after, 1)
            self.source_changes.append({'source': source_id, 'before': before, 'after': after})
        module = ModuleType('retained_bbj_' + source_id.replace('/', '_').replace('.', '_'))
        module.__file__ = str(path)
        # Compilation happens only inside the existing CI entry point, never at source preparation.
        with imports(names or {}):
            exec(compile(text, str(path), 'exec'), module.__dict__)
        self.modules[source_id] = module
        return module

    def load_path(self, unused_name, path):
        return self.load(self.input_id(path))

    def verify_binding(self, authorization, base_driver=None, case=None):
        require(self.operation is not None, 'Current accounting operation required')
        self.operation.require_case(authorization, case, base_driver)
        self.verify_sources()
        return (self.custody.group_path('registry'), self.custody.group_path('resources'),
                self.custody.group_path('schema'), [self.selected], {'historical_authority_reused': False})

    def authorize(self, phase, auth, driver, seed, opening=None):
        require(self.operation is not None, 'Current accounting financial operation required')
        group = 'opening' if phase == 'opening' else 'backup' if self.selected.endswith('BACKUP_POSITIVE_MAIN_TRANSFER_25') else 'promo'
        require(auth.get('packet_sha256') == self.custody._manifest['groups'][group]['original_integrity_sha256'],
                'Exact original selected case seal required')
        self.operation.verify_financial_call(self.selected, phase, auth, driver, seed, opening)
