"""Local publication routing, real archive/import and no-host-build regressions.

Only the Docker executable and root ownership boundary are modeled. No Docker
engine, package installation, SSH, service or production call is made.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'server/scripts'

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

archive_fixture = load('archive_fixture', ROOT / 'tests/operations/engine-image-archive.test.py')
importer = load('prebuilt_import', SCRIPTS / 'import-prebuilt-engine-image.py')
PUBLISHERS = ('publish-club-arena', 'stage-engine-release', 'auto-deploy-hetzner',
              'deploy-monitoring', 'post-deploy-e2e')

class RoutingTests(unittest.TestCase):
    def test_publishers_have_only_fixed_local_routes_and_protected_environment(self):
        for name in PUBLISHERS:
            source = (ROOT / f'.github/workflows/{name}.yml').read_text()
            jobs = re.split(r'^  [\w-]+:\n', source.split('jobs:\n', 1)[1], flags=re.M)[1:]
            self.assertTrue(jobs, name)
            for job in jobs:
                route = re.findall(r'^    runs-on: (.+)$', job, re.M)
                self.assertEqual(len(route), 1, name)
                self.assertIn(route[0], ['[self-hosted, smarter-local-linux-arm64]',
                                         '[self-hosted, smarter-local-publish]'])
                if route[0].endswith('smarter-local-publish]'):
                    self.assertIn('\n    environment: Production\n', job)

    def test_architecture_separates_all_installed_dependency_cache_keys(self):
        source = (ROOT / '.github/workflows/publish-club-arena.yml').read_text()
        for line in source.splitlines():
            if '${{ runner.os }}' in line:
                self.assertIn('${{ runner.os }}-${{ runner.arch }}-', line)

    def test_original_transaction_can_only_require_prebuilt(self):
        source = (SCRIPTS / 'engine-release-transaction.sh').read_text()
        self.assertIn('"$IMAGE_BUILDER" "$REPO_DIR" "$SHA" "$IMAGE_REF" --require-prebuilt', source)
        self.assertIn('assert_time_remaining\ncreate_image_lease\nBUILD_REMAINING=', source)
        workflow = (ROOT / '.github/workflows/auto-deploy-hetzner.yml').read_text()
        self.assertIn('needs: [preflight, engine-doors, produce-image]', workflow)
        self.assertIn('artifact-ids: ${{ needs.produce-image.outputs.artifact_id }}', workflow)
        self.assertIn('normalize_engine_archive', workflow)
        self.assertLess(workflow.index('import-prebuilt-engine-image.py'),
                        workflow.index('- name: Dispatch the staged SHA'))
        self.assertIn('--platform linux/amd64', (SCRIPTS / 'build-engine-image.sh').read_text())
        self.assertIn('python3 -B tests/operations/local-publishers.test.py',
                      (ROOT / '.github/workflows/ci.yml').read_text())

class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='local-publisher-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'repo'
        (self.repo / 'server').mkdir(parents=True)
        (self.repo / 'server/source.txt').write_text('one exact committed server tree\n')
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
        self.git('init', '-q')
        self.git('add', 'server/source.txt')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid',
                 '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'source')
        self.sha = self.git('rev-parse', 'HEAD').strip()
        self.tree = self.git('rev-parse', 'HEAD:server').strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.sha)
        archive_fixture.SHA, archive_fixture.TREE = self.sha, self.tree
        entries, self.image = archive_fixture.fixture()
        self.archive = self.root / 'image.tar'
        archive_fixture.write_tar(self.archive, entries)
        self.digest = archive_fixture.digest(self.archive.read_bytes())
        self.receipts = self.root / 'receipts'
        self.bin = self.root / 'bin'; self.bin.mkdir()
        self.state = self.root / 'docker-state.json'
        self.log = self.root / 'docker-calls.jsonl'
        config = dict(Id=self.image, Os='linux', Architecture='amd64', Config=dict(Labels={
            'org.opencontainers.image.revision': self.sha,
            'com.smarterpoker.engine.source-tree': self.tree,
            'com.smarterpoker.engine.build-contract': 'clean-server-archive-v1'}))
        self.config = self.root / 'expected.json';self.config.write_text(json.dumps(config))
        docker = self.bin / 'docker'
        docker.write_text('#!' + sys.executable + '\n' + '''import json, os, pathlib, sys
args=sys.argv[1:]; state=pathlib.Path(os.environ['FIXTURE_STATE'])
with open(os.environ['FIXTURE_LOG'],'a') as f: f.write(json.dumps(args)+'\\n')
config=json.loads(pathlib.Path(os.environ['FIXTURE_CONFIG']).read_text())
if args[:2]==['image','ls']:
    print(config['Id'] if state.exists() else '')
elif args[:2]==['image','load']:
    data=sys.stdin.buffer.read(); assert data
    state.write_text(json.dumps(config)); print('Loaded image')
elif args[:2]==['image','inspect'] and state.exists():
    config=json.loads(state.read_text())
    if '-f' not in args: print(json.dumps([config]))
    elif args[3]=='{{.Id}}': print(config['Id'])
    elif args[3]=='{{.Os}}/{{.Architecture}}': print(config['Os']+'/'+config['Architecture'])
    else: print(config['Config']['Labels'].get(args[3].split('"')[1],''))
else: sys.exit(97)
''')
        docker.chmod(0o700)
        # Model only the external flock binary on macOS. The Python import uses
        # the real OS flock; neither fixture starts a builder.
        (self.bin / 'flock').write_text('#!/bin/sh\nexit 0\n')
        (self.bin / 'flock').chmod(0o700)
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        FIXTURE_STATE=str(self.state), FIXTURE_LOG=str(self.log),
                        FIXTURE_CONFIG=str(self.config))
        self.patches = [patch.dict(os.environ, self.env), patch.object(importer, 'RECEIPTS', self.receipts),
                        patch.object(importer, 'LOCK', self.root / 'image.lock'),
                        patch.object(importer.os, 'geteuid', return_value=0)]
        # Preserve the real inode/mode/size checks; project only test UID to root.
        orig_lstat, orig_fstat = Path.lstat, os.fstat
        def root_stat(value):
            fields=list(value);fields[4]=0;return os.stat_result(fields)
        def fixture_lstat(p):
            value=root_stat(orig_lstat(p))
            if p in self.root.parents:
                fields=list(value);fields[0] &= ~0o022;value=os.stat_result(fields)
            return value
        self.patches += [patch.object(Path, 'lstat', fixture_lstat),
                         patch.object(os, 'fstat', lambda fd: root_stat(orig_fstat(fd)))]
        for item in self.patches: item.start();self.addCleanup(item.stop)

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], env=self.env,
                              capture_output=True, text=True, check=True).stdout

    def perform(self, **changes):
        args=dict(repo=self.repo, source=self.sha, tree=self.tree, image=self.image,
                  archive=self.archive, expected_archive=self.digest, deadline=int(time.time())+20)
        args.update(changes)
        return importer.import_image(**args)

    def builder(self):
        text=(SCRIPTS / 'build-engine-image.sh').read_text()
        # Exact protected location and UID are mapped into an owned fixture.
        text=text.replace("'/var/lib/club-arena/engine-prebuilt'", repr(str(self.receipts)))
        text=text.replace('st.st_uid != 0', 'st.st_uid != os.geteuid()')
        text=text.replace('info.st_uid != 0', 'info.st_uid != os.geteuid()')
        # The production fixed ancestors are root-only. Test only the owned
        # allocation and receipt parent here; temp-directory ancestors differ.
        text=text.replace('for parent in path.parents:', 'for parent in list(path.parents)[:2]:')
        script=self.root / 'builder.sh';script.write_text(text)
        env=dict(self.env, ENGINE_BUILD_LOCK_FILE=str(self.root/'builder.lock'),
                 ENGINE_BUILD_CONTEXT_ROOT=str(self.root/'contexts'))
        return subprocess.run(['bash', str(script), str(self.repo), self.sha,
                               'club-arena-engine:'+self.sha, '--require-prebuilt'],
                              env=env, capture_output=True, text=True, timeout=10)

    def test_real_archive_import_then_original_builder_reuses_only_exact_image(self):
        record=self.perform()
        receipt=self.receipts/(self.sha+'.json')
        self.assertEqual(record['image_id'],self.image)
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode),0o400)
        self.assertEqual(json.loads(receipt.read_bytes()),record)
        result=self.builder()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('ENGINE_IMAGE_REUSED=true',result.stdout)
        self.assertFalse((self.root/'contexts').exists())
        self.assertNotIn('buildx',self.log.read_text())

    def test_missing_receipt_refuses_before_any_host_build(self):
        result=self.builder()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('required locally built image receipt is absent or invalid',result.stderr)
        self.assertFalse((self.root/'contexts').exists())
        self.assertFalse(self.log.exists())

    def test_archive_or_source_or_deadline_mismatch_never_loads(self):
        for change in [dict(expected_archive='0'*64),dict(tree='0'*40),dict(deadline=1)]:
            with self.subTest(change=change), self.assertRaises((ValueError,TimeoutError)):
                self.perform(**change)
            self.assertFalse(self.state.exists())
            self.assertFalse((self.receipts/(self.sha+'.json')).exists())

    def test_symlinked_receipt_parent_refuses_before_import(self):
        redirected=self.root/'redirected';redirected.mkdir(mode=0o700)
        link=self.root/'redirect';link.symlink_to(redirected,target_is_directory=True)
        with patch.object(importer,'RECEIPTS',link/'receipts'):
            with self.assertRaisesRegex(ValueError,'RECEIPT_PARENT'): self.perform()
        self.assertFalse((redirected/'receipts').exists())
        self.assertFalse(self.state.exists())

    def test_changed_loaded_identity_never_publishes_receipt(self):
        value=json.loads(self.config.read_text());value['Architecture']='arm64'
        self.config.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'LOADED_IDENTITY'): self.perform()
        self.assertFalse((self.receipts/(self.sha+'.json')).exists())

    def test_changed_existing_receipt_cannot_be_overwritten(self):
        self.perform(); receipt=self.receipts/(self.sha+'.json')
        receipt.chmod(0o600);receipt.write_text('{}\n');receipt.chmod(0o400)
        before=self.log.read_text()
        with self.assertRaisesRegex(ValueError,'RECEIPT_TYPE'): self.perform()
        after=self.log.read_text()[len(before):]
        self.assertNotIn('load',after)
        self.assertEqual(receipt.read_text(),'{}\n')

    def test_receipt_does_not_hide_loaded_image_or_label_change(self):
        self.perform();value=json.loads(self.state.read_text());value['Id']='sha256:'+'0'*64
        self.state.write_text(json.dumps(value));result=self.builder()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('image ID changed',result.stderr)
        value['Id']=self.image;value['Config']['Labels']['com.smarterpoker.engine.source-tree']='0'*40
        self.state.write_text(json.dumps(value));result=self.builder()
        self.assertNotEqual(result.returncode,0)
        self.assertIn('host compilation is forbidden',result.stderr)
        self.assertNotIn('buildx',self.log.read_text())

if __name__=='__main__': unittest.main()
