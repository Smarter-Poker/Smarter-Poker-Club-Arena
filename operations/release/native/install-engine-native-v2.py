#!/usr/bin/python3
"""Install/upgrade an inactive v2 intake configuration; never activate identities."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('engine_native_v2', Path(__file__).with_name('engine-native-v2.py'))
NATIVE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(NATIVE)
BASE = NATIVE.BASE
CURRENT = Path('/etc/club-arena-release-controller/engine-operation-v2.json')
VERSIONS = CURRENT.parent / 'engine-native-v2'
ROUTER = Path('/usr/local/lib/club-arena-release-controller/engine-intake-v2.py')


class Validation:
    def verify(self, files, directory):
        for name, raw in files.items():
            NATIVE.immutable(directory / name, raw, 0o644)
        result = BASE.command(['/usr/bin/systemd-analyze', 'verify', *[directory / name for name in files]])
        BASE.require(result.returncode == 0)
        node = BASE.command(['/usr/bin/node', '--version'])
        BASE.require(node.returncode == 0 and int(node.stdout.strip().lstrip('v').split('.')[0]) >= 22)


def install(raw, expected_digest, prior_digest, *, current=CURRENT, versions=VERSIONS,
            router=ROUTER, verifier=NATIVE.verify_configuration, validator=None, interrupt=lambda stage: None):
    BASE.require(len(raw) <= 65536 and NATIVE.digest(raw) == expected_digest)
    BASE.require(prior_digest == 'none' or re.fullmatch(r'[0-9a-f]{64}', prior_digest))
    config = json.loads(raw)
    verifier(config)
    # The authority config is independently retained for every accepted item.
    BASE.require(Path(config['authority_config_path']).parent.name == config['authority_config_digest'])
    generation = versions / expected_digest
    NATIVE.directory(generation)
    NATIVE.immutable(generation / 'configuration.json', raw)
    intent = {'configuration_digest': expected_digest, 'prior_configuration_digest': prior_digest,
              'bundle_digest': config['bundle_digest'], 'protocol': 2,
              'policy_digest': config['policy_digest']}
    NATIVE.immutable(generation / 'install-intent.json', NATIVE.canonical(intent))
    # Validate real rendered unit syntax without installing, enabling or starting
    # a unit. The all-zero operation is only a syntax fixture in this generation.
    operation = '00000000-0000-0000-0000-000000000000'
    files = NATIVE.rendered_units(operation, config, NATIVE.ROOT / operation)
    (validator or Validation()).verify(files, generation)
    NATIVE.directory(router.parent)
    router_raw=BASE.secure(Path(config['bundle_path'])/'native/engine-intake-dispatch-v2.py').read_bytes()
    # A future incompatible router needs a new explicit protocol, never an
    # in-place alteration of the v2 router used by previously accepted items.
    NATIVE.immutable(router,router_raw,0o755)
    interrupt('VALIDATED')
    if current.exists():
        actual = NATIVE.digest(BASE.secure(current).read_bytes())
        BASE.require(actual in (prior_digest, expected_digest))
    else:
        BASE.require(prior_digest == 'none')
        actual = 'none'
    if actual != expected_digest:
        temporary = current.with_name('.' + current.name + '.' + uuid4().hex)
        try:
            NATIVE.immutable(temporary, raw)
            os.replace(temporary, current)
            NATIVE.sync(current.parent)
        finally:
            temporary.unlink(missing_ok=True)
        interrupt('POINTER_UPDATED')
    receipt = {**intent, 'state': 'INSTALLED_INACTIVE',
               'router_digest':NATIVE.digest(router_raw),
               'unit_template_digests': {name: NATIVE.digest(value) for name, value in files.items()},
               'native_syntax_verified': True, 'identity_verified': False, 'execution_activated': False}
    NATIVE.immutable(generation / 'installed.json', NATIVE.canonical(receipt))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configuration', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--expected-current-digest', required=True)
    args = parser.parse_args()
    BASE.require(os.geteuid() == 0)
    raw = BASE.secure(args.configuration).read_bytes()
    config = json.loads(raw)
    BASE.require(Path(__file__).resolve().parent.parent == Path(config['bundle_path']))
    with NATIVE.mutation_lock():
        result = install(raw, args.sha256, args.expected_current_digest)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'RELEASE_ENGINE_NATIVE_INSTALL_REFUSED'}))
        sys.exit(1)
