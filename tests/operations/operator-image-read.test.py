#!/usr/bin/env python3
"""Fixed-source security checks. No Docker, host or provider calls."""
import base64
import hashlib
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
SPEC=importlib.util.spec_from_file_location('reader',ROOT/'scripts/ci/read-scoped-operator-image.py')
R=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(R)
REQUEST=dict(releaseSha='a'*40,imageId='sha256:'+'b'*64,serverTree='c'*40)


def layer_bytes(names, format=tarfile.USTAR_FORMAT):
    layer=io.BytesIO()
    with tarfile.open(fileobj=layer,mode='w',format=format) as t:
        for name in names:
            m=tarfile.TarInfo(name);m.size=8
            t.addfile(m,io.BytesIO(b'opaque!!'))
    return layer.getvalue()

def archive(names, oci=False, format=tarfile.USTAR_FORMAT):
    layer=layer_bytes(names, format)
    layer_id='sha256:'+hashlib.sha256(layer).hexdigest()
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as t:
        for name,data in [('manifest.json',b'[]'),('b'*64+'.json',b'{}'),('blobs/sha256/'+layer_id[7:] if oci else 'layer/layer.tar',layer)]:
            m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
        if oci:
            value={'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':REQUEST['imageId'],'size':2},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar','digest':layer_id,'size':len(layer)}]}
            data=json.dumps(value).encode();name='blobs/sha256/'+hashlib.sha256(data).hexdigest()
            m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
    return out.getvalue(),layer_id


def gzip_archive(names, *, bad_diff=False, bad_blob=False, truncated=False, concatenated=False, descriptor_first=False):
    layer = layer_bytes(names)
    diff = 'sha256:'+hashlib.sha256(layer).hexdigest()
    packed = gzip.compress(layer, mtime=0)
    if truncated: packed = packed[:-1]
    if concatenated: packed += gzip.compress(b'opaque', mtime=0)
    digest = 'sha256:'+hashlib.sha256(packed).hexdigest()
    blob = 'blobs/sha256/'+('c'*64 if bad_blob else digest[7:])
    graph = {'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':REQUEST['imageId'],'size':2},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar+gzip','digest':digest,'size':len(packed)}]}
    metadata = json.dumps(graph).encode()
    pair = ('blobs/sha256/'+hashlib.sha256(metadata).hexdigest(), metadata)
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w', format=tarfile.USTAR_FORMAT) as t:
        entries = [('manifest.json',b'[]'),('b'*64+'.json',b'{}')]
        entries += [pair,(blob,packed)] if descriptor_first else [(blob,packed),pair]
        for name,data in entries:
            m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
    return out.getvalue(), ('sha256:'+'d'*64 if bad_diff else diff)


class RawReader:
    def __init__(self,raw):self.stream=io.BytesIO(raw)
    def exact(self,size):
        result=self.stream.read(size)
        R.require(len(result)==size,'Fixture truncated')
        return result
    def skip(self,size):self.exact(size)


class ReaderTests(unittest.TestCase):
    def test_selection_exact(self):
        self.assertEqual(R.selection(REQUEST),REQUEST)
        for bad in [{**REQUEST,'command':'docker run'}, {**REQUEST,'releaseSha':'main'}, {**REQUEST,'imageId':'tag'}]:
            with self.assertRaises(RuntimeError):R.selection(bad)

    def test_names_only_refuses_sensitive_or_duplicates(self):
        self.assertEqual(R.environment_names(b'PATH\nNODE_ENV\n'),['NODE_ENV','PATH'])
        for names in [b'SUPABASE_SERVICE_ROLE_KEY\n',b'PATH\nPATH\n',b'']:
            with self.assertRaises(RuntimeError):R.environment_names(names)

    def test_docker_format_single_extra_terminal_newline(self):
        names = b'PATH\nNODE_VERSION\nYARN_VERSION\nNODE_ENV\nENGINE_ALERT_JOURNAL_DIR\nNODE_OPTIONS\nGIT_COMMIT_SHA\n'
        self.assertEqual(R.environment_names(names + b'\n'), sorted(names.decode().splitlines()))
        for bad in [names + b'\n\n', b'PATH\n\nNODE_ENV\n\n', b'PATH\nPATH\n\n', b'UNKNOWN\n\n', b'\n\n']:
            with self.subTest(raw=bad), self.assertRaises(RuntimeError):
                R.environment_names(bad)

    def scan(self,fixture):
        data,layer_id=fixture
        child=subprocess.Popen([sys.executable,'-c',"import sys,base64;sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))",base64.b64encode(data).decode()],stdout=subprocess.PIPE)
        reader=R.BoundedArchiveReader(child.stdout,time.monotonic()+3)
        try:return R.scan_host_archive(reader,REQUEST['imageId'],[layer_id])
        finally:
            reader.close();child.stdout.close()
            if child.poll() is None:child.kill()
            child.wait(timeout=3)

    def test_complete_host_scan_digest(self):
        fixture=archive(['app/dist/index.js','usr/bin/node'])
        data,_=fixture
        result=self.scan(fixture)
        self.assertEqual(result['sha256'],hashlib.sha256(data).hexdigest())
        self.assertEqual(result['bytes'],len(data));self.assertEqual(result['layerHeaderCount'],2)

    def test_oci_descriptor_is_not_mistaken_for_a_layer(self):
        result=self.scan(archive(['app/dist/index.js'],oci=True))
        self.assertEqual(result['layers'],1)

    def test_actual_oci_gzip_layer_is_scanned_and_graph_bound(self):
        for first in [False,True]:
            with self.subTest(descriptor_first=first):
                result = self.scan(gzip_archive(['app/dist/index.js'],descriptor_first=first))
                self.assertEqual(result['layers'],1)
                self.assertEqual(result['layerHeaderCount'],1)

    def test_gzip_historical_credentials_graph_and_partial_refuse(self):
        for names,opts in [(['app/.env'],{}),(['app/safe'],{'bad_diff':True}),(['app/safe'],{'bad_blob':True}),(['app/safe'],{'truncated':True}),(['app/safe'],{'concatenated':True})]:
            with self.subTest(opts=opts,names=names), self.assertRaises(RuntimeError):
                self.scan(gzip_archive(names,**opts))
        with patch.object(R,'LIMIT',1000), self.assertRaises(RuntimeError):
            self.scan(gzip_archive(['app/safe']))

    def test_bounded_inner_pax_and_gnu_long_names(self):
        for format in [tarfile.PAX_FORMAT, tarfile.GNU_FORMAT]:
            safe='app/node_modules/'+('safe-package/'*12)+'index.js'
            with self.subTest(format=format):
                result=self.scan(archive([safe],format=format))
                self.assertEqual(result['layers'],1)
                with self.assertRaises(RuntimeError):
                    self.scan(archive([safe+'/../.env'],format=format))
                with self.assertRaises(RuntimeError):
                    self.scan(archive([safe+'/.env.production'],format=format))

    def test_long_link_resolved_credential_path_refused(self):
        for format in [tarfile.PAX_FORMAT,tarfile.GNU_FORMAT]:
            layer=io.BytesIO()
            with tarfile.open(fileobj=layer,mode='w',format=format) as t:
                m=tarfile.TarInfo('app/safe-link');m.type=tarfile.SYMTYPE
                m.linkname=('long-directory/'*12)+'.env';t.addfile(m)
            with self.assertRaises(RuntimeError):R.scan_layer(RawReader(layer.getvalue()),len(layer.getvalue()))

    def test_pax_metadata_is_bounded_and_typed(self):
        for raw in [b'999 path=short\n', b'19 unknown=opaque\n', b'0 path=short\n', b'16 path=bad\x00name\n']:
            with self.subTest(raw=raw),self.assertRaises((RuntimeError,UnicodeError)):
                R.path_metadata(raw)
        m=tarfile.TarInfo('pax');m.type=tarfile.XHDTYPE;m.size=8193
        with self.assertRaises(RuntimeError):R.scan_layer(RawReader(m.tobuf()+bytes(9216)),9728)
        m.type=tarfile.XGLTYPE;m.size=0
        with self.assertRaises(RuntimeError):R.scan_layer(RawReader(m.tobuf()+bytes(1024)),1536)

    def test_foreign_or_secret_shaped_oci_metadata_refused(self):
        for value in [{'schemaVersion':2,'Env':['SECRET=never-export']}, {'schemaVersion':2,'manifests':[]}]:
            with self.assertRaises(RuntimeError):R.graph_descriptor(json.dumps(value).encode(),REQUEST['imageId'],[])

    def test_all_historical_layer_headers_refused(self):
        for name in ['app/.env','app/.env.production','root/.aws/credentials','root/id_ed25519','root/.npmrc','root/.git-credentials']:
            with self.subTest(name=name),self.assertRaises(RuntimeError):self.scan(archive([name]))

    def test_empty_regular_npmrc_only(self):
        def one(name, *, size=0, kind=tarfile.REGTYPE, pax=None, link=''):
            out=io.BytesIO()
            with tarfile.open(fileobj=out,mode='w',format=tarfile.PAX_FORMAT) as t:
                m=tarfile.TarInfo(name);m.type=kind;m.size=size;m.linkname=link
                if pax:m.pax_headers=pax
                t.addfile(m,io.BytesIO(b'x'*size))
            return out.getvalue()
        for name in ['root/.npmrc','app/.npmrc']:
            raw=one(name)
            self.assertEqual(R.scan_layer(RawReader(raw),len(raw)),1)
        for raw in [one('root/.npmrc',size=1),
                    one('root/.npmrc',kind=tarfile.DIRTYPE),
                    one('root/.npmrc',kind=tarfile.SYMTYPE,link='safe'),
                    one('root/.npmrc',kind=tarfile.LNKTYPE,link='safe'),
                    one('root/.env'),one('root/.netrc'),
                    one('root/credentials/.npmrc'),
                    one('root/.npmrc/safe'),
                    one('root/.npmrc',pax={'size':'1'}),
                    one('safe',pax={'path':'root/.npmrc','size':'1'}),
                    one('root/.npmrc',pax={'path':'root/.env'})]:
            with self.subTest(length=len(raw)),self.assertRaises(RuntimeError):
                R.scan_layer(RawReader(raw),len(raw))
        raw=one('safe',pax={'path':'root/.npmrc'})
        self.assertEqual(R.scan_layer(RawReader(raw),len(raw)),2)

    def test_deleted_env_whiteout_refused(self):
        with self.assertRaises(RuntimeError):self.scan(archive(['app/.wh..env']))

    def test_unknown_archive_type_refused(self):
        with self.assertRaises(RuntimeError):self.scan((b'not tar'+bytes(10233),'sha256:'+'d'*64))

    def test_scan_deadline_is_bounded(self):
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],stdout=subprocess.PIPE)
        reader=R.BoundedArchiveReader(child.stdout,time.monotonic()+.05)
        try:
            with self.assertRaises(RuntimeError):reader.exact(512)
        finally:reader.close();child.kill();child.wait();child.stdout.close()

    def test_tag_is_original_exact_image(self):
        class C:
            def remote(self,r):return {'native':'fixed'}
            def run_read(self,args):
                fmt=args[4]
                if fmt=='{{json .RootFS.Layers}}':return json.dumps(['sha256:'+'d'*64]).encode()
                if fmt=='{{.Id}}':return b'sha256:'+b'b'*64+b'\n'
                if fmt.startswith('{{range'):return b'PATH\n'
                return ('sha256:'+'b'*64+' linux amd64 1234 '+'c'*40+' clean-server-archive-v1').encode()
        with patch.object(R,'common',return_value=C()):self.assertEqual(R.identity(REQUEST)['tag'],'club-arena-engine:'+'a'*40)
        class Wrong(C):
            def run_read(self,args):
                if args[4]=='{{.Id}}':return b'sha256:'+b'd'*64
                return super().run_read(args)
        with patch.object(R,'common',return_value=Wrong()),self.assertRaises(RuntimeError):R.identity(REQUEST)

    def test_stream_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'image.tar'
            result=R.stream_archive([sys.executable,'-c',"import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b'x'*2048)"],b'fixed',target,seconds=2)
            self.assertEqual(result,2048);self.assertEqual(target.stat().st_mode&0o777,0o600)

    def test_stream_failures_remove_only_own_file(self):
        for code,limit in [("import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b'x'*2048)",1024),("import sys;sys.stdin.buffer.read();sys.exit(1)",10000),("import time;time.sleep(10)",10000)]:
            with tempfile.TemporaryDirectory() as tmp:
                target=Path(tmp)/'image.tar'
                with self.assertRaises((RuntimeError,BrokenPipeError)):R.stream_archive([sys.executable,'-c',code],b'fixed',target,limit=limit,seconds=.1)
                self.assertFalse(target.exists())

    def test_existing_output_not_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'image.tar';target.write_bytes(b'existing')
            with self.assertRaises(RuntimeError):R.stream_archive([],b'fixed',target)
            self.assertEqual(target.read_bytes(),b'existing')

    def test_identity_change_refused(self):
        with self.assertRaises(RuntimeError):R.validate_transition({'identity':'old'},{'identity':'new'},REQUEST)

    def test_host_preflight_before_any_archive_egress(self):
        source=(ROOT/'scripts/ci/read-scoped-operator-image.py').read_text()
        begin=source.index('preflight_reply=subprocess.run')
        self.assertLess(begin,source.index("stream_archive(args('--save')"))
        self.assertIn("preflight['scan']['sha256']",source)
        self.assertNotIn("['docker', 'run'",source)
        self.assertNotIn('docker tag',source)
        self.assertIn('created_destination and not published',source)

    def test_workflow_explicit_private_bounded(self):
        source=(ROOT/'.github/workflows/production-integrity-audit.yml').read_text()
        job=source.split('  scoped_operator_hold_image:',1)[1].split('  scoped_operator_hold_provenance:',1)[0]
        self.assertIn("github.event_name == 'repository_dispatch'",job)
        self.assertIn('github.event.repository.private == true',job)
        self.assertIn('retention-days: 1',job)
        self.assertNotIn('if: always()',job)
        self.assertLess(job.index('operator-image-read.test.py'),job.index('HETZNER_SSH_PRIVATE_KEY'))
        self.assertIn('persist-credentials: false',job)
        self.assertNotIn('issues: write',job)

if __name__=='__main__':unittest.main()
