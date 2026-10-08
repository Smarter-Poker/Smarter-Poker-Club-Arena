#!/usr/bin/env python3
"""Explicit fixed immutable-image read for an isolated transition drill.

Never imports application code, creates a container, changes a daemon, or releases.
"""
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import types
import zlib

LIMIT = 2 * 1024 * 1024 * 1024
STREAM_SECONDS = 120
ENV_NAMES = {'PATH', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV',
             'ENGINE_ALERT_JOURNAL_DIR', 'NODE_OPTIONS', 'GIT_COMMIT_SHA'}
SCHEMA = 'operator-hold-immutable-image/v1'


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def selection(value):
    require(isinstance(value, dict) and set(value) == {'releaseSha', 'imageId', 'serverTree'},
            'Exact immutable selection required')
    require(all(isinstance(value[k], str) and re.fullmatch('[0-9a-f]{40}', value[k])
                for k in ('releaseSha', 'serverTree')), 'Invalid source identity')
    require(isinstance(value['imageId'], str) and
            re.fullmatch('sha256:[0-9a-f]{64}', value['imageId']), 'Invalid image identity')
    return value


def common():
    if '_COMMON' in globals():
        return globals()['_COMMON']
    path = Path(__file__).with_name('read-scoped-operator-hold-provenance.py')
    spec = importlib.util.spec_from_file_location('image_provenance', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def environment_names(raw):
    names = raw.decode().splitlines()
    # Docker appends one newline after the template, whose range already ends in LF.
    if raw.endswith(b"\n\n") and names and names[-1] == "":
        names.pop()
    require(names and len(names) == len(set(names)) and set(names) <= ENV_NAMES,
            'Baked environment names refused')
    return sorted(names)


def identity(request):
    c = common()
    native = c.remote({k: request[k] for k in ('releaseSha', 'imageId')})
    fmt = '{{.Id}} {{.Os}} {{.Architecture}} {{.Size}} {{index .Config.Labels "com.smarterpoker.engine.source-tree"}} {{index .Config.Labels "com.smarterpoker.engine.build-contract"}}'
    fields = c.run_read(['docker', 'image', 'inspect', '--format', fmt, request['imageId']]).decode().strip().split()
    require(len(fields) == 6 and fields[:3] == [request['imageId'], 'linux', 'amd64'] and
            fields[3].isdigit() and 0 < int(fields[3]) <= LIMIT and
            fields[4:] == [request['serverTree'], 'clean-server-archive-v1'],
            'Exact immutable image metadata refused')
    # Docker emits only names; runtime Config.Env and all values remain unread.
    fmt = '{{range .Config.Env}}{{index (split . "=") 0}}{{println}}{{end}}'
    names = environment_names(c.run_read(['docker', 'image', 'inspect', '--format', fmt,
                                        request['imageId']]))
    tag = 'club-arena-engine:' + request['releaseSha']
    require(c.run_read(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip() == request['imageId'], 'Immutable tag differs')
    layers = json.loads(c.run_read(['docker','image','inspect','--format','{{json .RootFS.Layers}}',request['imageId']]))
    require(isinstance(layers,list) and 0 < len(layers) <= 128 and len(layers)==len(set(layers)) and all(isinstance(x,str) and re.fullmatch('sha256:[0-9a-f]{64}',x) for x in layers), 'Layer graph refused')
    return {'tag': tag, 'layerDiffIds': layers, 'native': native, 'imageBytesUpperBound': int(fields[3]),
            'serverTree': fields[4], 'buildContract': fields[5], 'environmentNames': names}


def forbidden_layer_path(name):
    if name in {'.','./'}:return False
    parts = name.rstrip('/').removeprefix('./').split('/')
    require(name and not name.startswith('/') and all(x not in ('', '..') for x in parts),
            'Layer path refused')
    return any(x == '.env' or x.startswith('.env.') or x == '.wh..env' or x.startswith('.wh..env.') or x in
               {'id_rsa','id_ed25519','id_ecdsa','id_dsa','credentials','service-account.json','.npmrc','.pypirc','.netrc','.git-credentials','application_default_credentials.json'} for x in parts)


def admitted_layer_path(name, kind, size):
    if not forbidden_layer_path(name):
        return True
    # A resolved ordinary empty .npmrc has no payload or executable/link behavior.
    parts = name.rstrip('/').removeprefix('./').split('/')
    return (kind == tarfile.REGTYPE and size == 0 and parts[-1] == '.npmrc'
            and not forbidden_layer_path('/'.join(
                'empty-npmrc' if part == '.npmrc' else part for part in parts)))


def inspect_layer_headers(path):
    """Inspect resolved tar names; file values are never decoded or followed."""
    class FileReader:
        def __init__(self, stream, deadline): self.stream,self.deadline = stream,deadline
        def exact(self, size):
            require(time.monotonic()<self.deadline,'Local layer deadline exceeded')
            raw = self.stream.read(size)
            require(len(raw) == size, 'Layer truncated')
            return raw
        def skip(self, size):
            while size:
                n = min(size, 65536); self.exact(n); size -= n
    with tarfile.open(path, 'r:') as outer:
        manifest = json.load(outer.extractfile('manifest.json'))
        require(isinstance(manifest, list) and len(manifest) == 1, 'One image required')
        total, decoded_total = 0, 0
        deadline=time.monotonic()+STREAM_SECONDS
        for name in manifest[0]['Layers']:
            stream = outer.extractfile(name)
            require(stream is not None, 'Layer unavailable')
            size=outer.getmember(name).size
            require(2 <= size <= LIMIT and time.monotonic()<deadline,'Local layer bound refused')
            prefix=stream.read(2);stream.seek(0)
            if prefix==b'\x1f\x8b':
                stream.read(2)
                decoded=GzipLayerReader(FileReader(stream,deadline),size,prefix,deadline)
                total += scan_layer(decoded,None);decoded_total += decoded.count
            else:
                total += scan_layer(FileReader(stream,deadline),size);decoded_total += size
            require(decoded_total<=LIMIT,'Local decoded archive size refused')
            require(total <= 1000000, 'Layer member count refused')
    return total


def stream_archive(args, source, destination, *, limit=LIMIT, seconds=STREAM_SECONDS):
    require(not destination.exists() and len(source) <= 131072, 'Stream input/destination refused')
    deadline = time.monotonic()+seconds
    created = False
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
        selector = selectors.DefaultSelector()
        os.set_blocking(process.stdin.fileno(),False)
        os.set_blocking(process.stdout.fileno(),False)
        selector.register(process.stdin,selectors.EVENT_WRITE)
        selector.register(process.stdout,selectors.EVENT_READ)
        sent, count, eof = 0, 0, False
        try:
            with destination.open('xb') as sink:
                created = True
                destination.chmod(0o600)
                while not eof:
                    remaining=deadline-time.monotonic()
                    require(remaining>0,'Image stream deadline exceeded')
                    events=selector.select(remaining)
                    require(events,'Image stream timed out')
                    require(os.fstat(errors.fileno()).st_size <= 65536,'Diagnostic size exceeded')
                    for event,_ in events:
                        if event.fileobj is process.stdin:
                            sent += os.write(process.stdin.fileno(),source[sent:sent+65536])
                            if sent == len(source):
                                selector.unregister(process.stdin);process.stdin.close()
                        else:
                            chunk=os.read(process.stdout.fileno(),65536)
                            if not chunk: eof=True;break
                            count += len(chunk)
                            require(count <= limit,'Image stream size exceeded')
                            sink.write(chunk)
                sink.flush();os.fsync(sink.fileno())
            require(sent == len(source) and process.wait(timeout=max(.01,deadline-time.monotonic())) == 0,
                    'Image stream outcome refused')
            require(os.fstat(errors.fileno()).st_size <= 65536 and count >=1024,'Stream diagnostic/size refused')
            return count
        except BaseException:
            if process.poll() is None:process.kill()
            process.wait(timeout=5)
            if created:destination.unlink(missing_ok=True)
            raise
        finally:
            selector.close()
            if not process.stdin.closed:process.stdin.close()
            process.stdout.close()


def validate_transition(before, after, request):
    require(before == after, 'Image/runtime changed during retrieval')
    common().validate_result(before['native'], {k: request[k] for k in ('releaseSha','imageId')})
    require(before['serverTree'] == request['serverTree'] and
            before['buildContract'] == 'clean-server-archive-v1', 'Source proof differs')


class BoundedArchiveReader:
    """Hash opaque bytes while parsing only fixed tar headers, on the host."""
    def __init__(self, stream, deadline, limit=LIMIT):
        self.stream, self.deadline, self.limit = stream, deadline, limit
        self.count, self.digest = 0, hashlib.sha256()
        self.layer_digest = None
        self.selector = selectors.DefaultSelector()
        self.selector.register(stream, selectors.EVENT_READ)

    def exact(self, size):
        result = bytearray()
        while len(result) < size:
            remaining = self.deadline - time.monotonic()
            require(remaining > 0 and self.selector.select(remaining), 'Host scan deadline exceeded')
            chunk = os.read(self.stream.fileno(), min(65536, size-len(result)))
            require(chunk, 'Archive truncated')
            self.count += len(chunk)
            require(self.count <= self.limit, 'Host archive size exceeded')
            self.digest.update(chunk)
            if self.layer_digest is not None:self.layer_digest.update(chunk)
            result.extend(chunk)
        return bytes(result)

    def skip(self, size):
        while size:
            chunk = min(size, 65536)
            self.exact(chunk)  # Opaque bytes: no decoding or file-value inspection.
            size -= chunk

    def finish(self):
        while True:
            remaining = self.deadline-time.monotonic()
            require(remaining > 0 and self.selector.select(remaining), 'Host scan deadline exceeded')
            chunk = os.read(self.stream.fileno(), 65536)
            if not chunk: break
            self.count += len(chunk)
            require(self.count <= self.limit and not any(chunk), 'Archive trailing data refused')
            self.digest.update(chunk)
        return self.digest.hexdigest()

    def close(self):
        self.selector.close()


def header(raw, *, inner=False):
    try:
        member = tarfile.TarInfo.frombuf(raw, 'utf-8', 'strict')
    except (tarfile.HeaderError, UnicodeError, ValueError) as error:
        raise RuntimeError('Archive header refused') from error
    extended = {tarfile.XHDTYPE, tarfile.XGLTYPE,
                tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK}
    require(inner or member.type not in extended, 'Extended outer header refused')
    require(admitted_layer_path(member.name, member.type, member.size) if inner else
            not forbidden_layer_path(member.name), 'Baked credential path refused')
    require(0 <= member.size <= LIMIT, 'Member size refused')
    return member


def path_metadata(raw):
    """Bounded local PAX fields only, never arbitrary attributes/file values."""
    result, position = {}, 0
    while position < len(raw):
        space = raw.find(b' ', position, position+12)
        require(space > position and raw[position:space].isdigit(), 'PAX length refused')
        length = int(raw[position:space])
        end = position+length
        require(space+1 < end <= len(raw) and raw[end-1:end] == b'\n', 'PAX record refused')
        record = raw[space+1:end-1]
        key, separator, value = record.partition(b'=')
        require(separator and key in {b'path', b'linkpath', b'size', b'uid', b'gid',
                b'mtime', b'atime', b'ctime', b'uname', b'gname'} and key not in result,
                'PAX field refused')
        require(value and b'\0' not in value, 'PAX value refused')
        if key in {b'path', b'linkpath'}:
            text = value.decode('utf-8', 'strict')
            require(not any(ord(x) < 32 or ord(x) == 127 for x in text), 'Path control refused')
            result[key] = text
        elif key == b'size':
            require(value.isdigit() and int(value) <= LIMIT, 'PAX size refused')
            result[key] = int(value)
        else:
            # Ordinary ownership/timestamp metadata cannot carry arbitrary strings.
            pattern = rb'-?[0-9]+(?:\.[0-9]+)?' if key in {b'mtime', b'atime', b'ctime'} else rb'[0-9]+'
            if key in {b'uname', b'gname'}: pattern = rb'[A-Za-z0-9_.-]{1,64}'
            require(re.fullmatch(pattern, value) is not None, 'PAX metadata refused')
            result[key] = None
        position = end
    return {k:v for k,v in result.items() if k in {b'path', b'linkpath', b'size'}}


class GzipLayerReader:
    """One bounded gzip member; hash decoded bytes without inspecting file values."""
    def __init__(self, reader, size, prefix, deadline):
        self.reader, self.left, self.pending = reader, size-len(prefix), prefix
        self.decoder = zlib.decompressobj(31)
        self.deadline, self.count, self.digest = deadline, 0, hashlib.sha256()
        self.done = False

    def read(self, size):
        require(0 < size <= 65536, 'Decoded read size refused')
        result = bytearray()
        while len(result) < size and not self.done:
            require(time.monotonic() < self.deadline, 'Layer decode deadline exceeded')
            if not self.pending:
                require(self.left > 0, 'Compressed layer truncated')
                n = min(self.left, 65536)
                self.pending = self.reader.exact(n); self.left -= n
            try:
                chunk = self.decoder.decompress(self.pending, size-len(result))
            except zlib.error as error:
                raise RuntimeError('Compressed layer refused') from error
            self.pending = self.decoder.unconsumed_tail
            self.count += len(chunk)
            require(self.count <= LIMIT, 'Decoded layer size exceeded')
            self.digest.update(chunk); result.extend(chunk)
            if self.decoder.eof:
                require(not self.decoder.unused_data and not self.pending and self.left == 0,
                        'Compressed trailing/member data refused')
                self.done = True
        return bytes(result)

    def exact(self, size):
        raw = self.read(size)
        require(len(raw) == size, 'Decoded layer truncated')
        return raw

    def skip(self, size):
        while size:
            n = min(size, 65536); self.exact(n); size -= n

    def finish_padding(self):
        while not self.done:
            require(not any(self.read(65536)), 'Decoded layer trailing data refused')
        return self.count


def scan_layer(reader, size):
    """Scan all names including bounded PAX/GNU overrides; payloads stay opaque."""
    left, count, pending, extensions = size, 0, {}, 0
    while left is None or left >= 512:
        raw = reader.exact(512)
        if left is not None: left -= 512
        if raw == bytes(512):
            require(not pending and extensions == 0, 'Orphan path metadata refused')
            if left is None:
                reader.finish_padding()
                return count
            while left:
                n = min(left, 65536)
                require(not any(reader.exact(n)), 'Layer trailing data refused'); left -= n
            return count
        entry = header(raw, inner=True)
        count += 1
        require(count <= 1000000, 'Layer header count refused')
        require(entry.type != tarfile.XGLTYPE, 'Global PAX metadata refused')
        if entry.type in {tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK}:
            extensions += 1
            require(extensions <= 3 and 0 < entry.size <= 8192, 'Path metadata bounds refused')
            padded = ((entry.size+511)//512)*512
            require(left is None or padded <= left, 'Path metadata truncated')
            metadata = reader.exact(entry.size)
            reader.skip(padded-entry.size)
            if left is not None: left -= padded
            if entry.type == tarfile.XHDTYPE:
                values = path_metadata(metadata)
            else:
                require(metadata.endswith(b'\0') and b'\0' not in metadata[:-1], 'GNU path metadata refused')
                value = metadata[:-1].decode('utf-8', 'strict')
                require(value and not any(ord(x) < 32 or ord(x) == 127 for x in value), 'GNU path control refused')
                values = {b'path' if entry.type == tarfile.GNUTYPE_LONGNAME else b'linkpath': value}
            require(not set(values).intersection(pending), 'Duplicate path metadata refused')
            pending.update(values)
            continue
        name = pending.get(b'path', entry.name)
        link = pending.get(b'linkpath', entry.linkname)
        payload_size = pending.get(b'size', entry.size)
        require(admitted_layer_path(name, entry.type, payload_size), 'Baked credential path refused')
        if entry.issym() or entry.islnk():
            require(not any(forbidden_layer_path(p) for p in link.split('/') if p not in {'', '.', '..'}), 'Credential link refused')
        else:
            require(b'linkpath' not in pending, 'Non-link path override refused')
        pending, extensions = {}, 0
        payload = ((payload_size+511)//512)*512
        require(left is None or payload <= left, 'Layer truncated')
        reader.skip(payload)
        if left is not None: left -= payload
    raise RuntimeError('Layer end markers refused')


def metadata_json(raw):
    def unique(pairs):
        result={}
        for key,value in pairs:
            require(key not in result,'Duplicate OCI metadata key refused')
            result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=unique)


def graph_descriptor(raw, image_id, layer_ids, layer_blobs=None):
    """Only bounded OCI graph metadata, never a config or layer file payload."""
    value=metadata_json(raw)
    require(isinstance(value,dict) and value.get('schemaVersion') == 2,
            'Unknown OCI metadata refused')
    def descriptor(item):
        require(isinstance(item,dict) and set(item) <= {'mediaType','digest','size','platform','annotations'}
                and {'mediaType','digest','size'} <= set(item), 'OCI descriptor refused')
        require(item['mediaType'] in {'application/vnd.oci.image.manifest.v1+json','application/vnd.oci.image.config.v1+json','application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+gzip'}
                and re.fullmatch('sha256:[0-9a-f]{64}',item['digest'])
                and type(item['size']) is int and 0 < item['size'] <= LIMIT, 'OCI descriptor identity refused')
        if 'platform' in item:require(item['platform'] == {'architecture':'amd64','os':'linux'}, 'OCI platform refused')
        if 'annotations' in item:
            require(isinstance(item['annotations'],dict) and set(item['annotations']) <= {'org.opencontainers.image.ref.name'}
                    and all(isinstance(x,str) and re.fullmatch('[A-Za-z0-9_:/.-]{1,200}',x) for x in item['annotations'].values()), 'OCI annotations refused')
    if 'config' in value:
        require(set(value) <= {'schemaVersion','mediaType','config','layers'} and isinstance(value.get('layers'),list), 'OCI manifest refused')
        descriptor(value['config'])
        require(value['config']['digest']==image_id, 'Foreign OCI config refused')
        for item in value['layers']:descriptor(item)
        require([((layer_blobs or {}).get(x['digest']) or x['digest']) for x in value['layers']] == layer_ids, 'OCI layer graph differs')
        require(all(x['mediaType'] == ('application/vnd.oci.image.layer.v1.tar+gzip' if x['digest'] != ((layer_blobs or {}).get(x['digest']) or x['digest']) else 'application/vnd.oci.image.layer.v1.tar') for x in value['layers']), 'OCI layer encoding differs')
    else:
        require(set(value) <= {'schemaVersion','mediaType','manifests'} and isinstance(value.get('manifests'),list) and len(value['manifests']) == 1, 'OCI index refused')
        descriptor(value['manifests'][0])


def validate_oci_manifest_identity(objects, image_id, layer_ids, layer_blobs, blob_sizes,
                                   *, expected_tag, source_sha, server_tree):
    """Native containerd identity is the original manifest digest, not config SHA."""
    native_name='blobs/sha256/'+image_id[7:]
    raw=objects[native_name]
    require('sha256:'+hashlib.sha256(raw).hexdigest()==image_id, 'OCI native manifest digest differs')
    manifest=metadata_json(raw)
    require(isinstance(manifest,dict) and set(manifest)=={'schemaVersion','mediaType','config','layers'}
            and manifest['schemaVersion']==2 and manifest['mediaType']=='application/vnd.oci.image.manifest.v1+json', 'OCI native manifest refused')
    config_descriptor=manifest['config']
    require(isinstance(config_descriptor,dict) and set(config_descriptor)=={'mediaType','digest','size'}
            and config_descriptor['mediaType']=='application/vnd.oci.image.config.v1+json'
            and isinstance(config_descriptor['digest'],str) and re.fullmatch('sha256:[0-9a-f]{64}',config_descriptor['digest']), 'OCI native config descriptor refused')
    config_name='blobs/sha256/'+config_descriptor['digest'][7:]
    require(config_name in objects and len(objects[config_name])==config_descriptor['size']
            and 'sha256:'+hashlib.sha256(objects[config_name]).hexdigest()==config_descriptor['digest'], 'OCI native config binding differs')
    config=metadata_json(objects[config_name])
    require(isinstance(config,dict) and set(config)=={'architecture','config','created','history','os','rootfs'}
            and config['architecture']=='amd64' and config['os']=='linux', 'OCI native config shape refused')
    require(config['rootfs']=={'type':'layers','diff_ids':layer_ids}, 'OCI native config RootFS differs')
    runtime=config['config'];require(isinstance(runtime,dict) and set(runtime) <= {'ArgsEscaped','Cmd','Entrypoint','Env','ExposedPorts','Healthcheck','Labels','WorkingDir'}, 'OCI runtime refused')
    env=runtime.get('Env')
    require(isinstance(env,list) and all(isinstance(x,str) and '=' in x for x in env), 'OCI environment names refused')
    names=[x.partition('=')[0] for x in env]
    require(names and len(names)==len(set(names)) and set(names)<=ENV_NAMES, 'OCI environment names refused')
    labels=runtime.get('Labels')
    require(isinstance(labels,dict) and labels.get('org.opencontainers.image.revision')==source_sha
            and labels.get('com.smarterpoker.engine.source-tree')==server_tree
            and labels.get('com.smarterpoker.engine.build-contract')=='clean-server-archive-v1', 'OCI native source binding differs')
    graph_descriptor(raw, config_descriptor['digest'], layer_ids, layer_blobs)
    layer_names=[]
    for descriptor in manifest['layers']:
        require(blob_sizes.get(descriptor['digest'])==descriptor['size'], 'OCI native layer size differs')
        layer_names.append('blobs/sha256/'+descriptor['digest'][7:])
    docker=metadata_json(objects.get('manifest.json',b'null'))
    require(isinstance(expected_tag,str) and isinstance(docker,list) and len(docker)==1
            and isinstance(docker[0],dict) and set(docker[0]) <= {'Config','RepoTags','Layers','LayerSources'}
            and docker[0].get('Config')==config_name and docker[0].get('RepoTags')==[expected_tag]
            and docker[0].get('Layers')==layer_names, 'OCI Docker identity binding differs')
    index=metadata_json(objects.get('index.json',b'null'))
    graph_descriptor(objects.get('index.json',b'null'), image_id, layer_ids, layer_blobs)
    descriptor=index['manifests'][0]
    require(index.get('mediaType')=='application/vnd.oci.image.index.v1+json'
            and descriptor['mediaType']=='application/vnd.oci.image.manifest.v1+json'
            and descriptor['digest']==image_id and descriptor['size']==len(raw), 'OCI native index differs')
    require(metadata_json(objects.get('oci-layout',b'null'))=={'imageLayoutVersion':'1.0.0'}, 'OCI layout refused')
    require(set(objects) <= {'manifest.json','index.json','oci-layout',native_name,config_name}, 'Foreign OCI metadata refused')
    return config_descriptor['digest']


def scan_host_archive(reader, image_id, layer_ids, *, expected_tag=None, source_sha=None, server_tree=None):
    """Complete first save stays on host; all historical layer headers checked."""
    count, layers, seen, scanned = 0, 0, set(), set()
    descriptors, layer_blobs, decoded_total = [], {}, 0
    objects, blob_sizes = {}, {}
    while True:
        raw = reader.exact(512)
        if raw == bytes(512):
            require(reader.exact(512) == bytes(512), 'Outer end markers refused')
            digest = reader.finish()
            require(scanned == set(layer_ids), 'Incomplete historical layer graph')
            native_raw=objects.get('blobs/sha256/'+image_id[7:])
            native_value=metadata_json(native_raw) if native_raw else None
            if isinstance(native_value,dict) and native_value.get('schemaVersion')==2:
                validate_oci_manifest_identity(objects,image_id,layer_ids,layer_blobs,blob_sizes,
                    expected_tag=expected_tag,source_sha=source_sha,server_tree=server_tree)
            else:
                for raw in descriptors: graph_descriptor(raw, image_id, layer_ids, layer_blobs)
            return {'sha256': digest, 'bytes': reader.count, 'layerHeaderCount': count,
                    'layers': layers, 'credentialHeadersRefused': True}
        member = header(raw)
        name = member.name.rstrip('/')
        require(name not in seen and len(seen) < 100000, 'Outer membership refused')
        seen.add(name)
        require(member.type in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE}, 'Outer type refused')
        is_config = name in {image_id[7:]+'.json', 'blobs/sha256/'+image_id[7:]}
        is_blob = re.fullmatch('blobs/sha256/[0-9a-f]{64}',name) is not None
        if is_blob: blob_sizes['sha256:'+name.split('/')[-1]]=member.size
        is_layer = name.endswith('/layer.tar') or (is_blob and 'sha256:'+name.split('/')[-1] in layer_ids)
        if is_layer:
            layers += 1
            require(layers <= 128, 'Layer count refused')
            reader.layer_digest = hashlib.sha256()
            count += scan_layer(reader, member.size)
            decoded_total += member.size
            require(decoded_total <= LIMIT, 'Decoded archive size exceeded')
            require(count <= 1000000, 'Layer header count refused')
            digest='sha256:'+reader.layer_digest.hexdigest()
            reader.layer_digest=None
            require(digest in layer_ids and digest not in scanned, 'Layer digest graph differs')
            scanned.add(digest)
        elif is_blob and not is_config:
            require(member.size >= 2, 'OCI blob size refused')
            reader.layer_digest = hashlib.sha256()
            prefix = reader.exact(2)
            if prefix == b'\x1f\x8b':
                layers += 1
                require(layers <= 128, 'Layer count refused')
                decoded = GzipLayerReader(reader, member.size, prefix, reader.deadline)
                count += scan_layer(decoded, None)
                decoded_total += decoded.count
                require(decoded_total <= LIMIT and count <= 1000000, 'Decoded archive size/count exceeded')
                diff_id = 'sha256:'+decoded.digest.hexdigest()
                require(diff_id in layer_ids and diff_id not in scanned, 'Layer digest graph differs')
                scanned.add(diff_id)
                layer_blobs['sha256:'+name.split('/')[-1]] = diff_id
            else:
                require(member.size <= 65536 and len(descriptors) < 128, 'OCI metadata size/count refused')
                metadata_raw=prefix+reader.exact(member.size-2)
                descriptors.append(metadata_raw);objects[name]=metadata_raw
            require(reader.layer_digest.hexdigest() == name.split('/')[-1], 'OCI blob digest differs')
            reader.layer_digest = None
        else:
            require(member.isdir() and member.size == 0 or
                    (is_config or name in {'manifest.json','repositories','index.json','oci-layout'})
                    and member.size <= 1048576, 'Unsupported image archive format')
            if is_config or name in {'manifest.json','index.json','oci-layout'}:
                objects[name]=reader.exact(member.size)
            else:
                reader.skip(member.size)
        reader.skip((-member.size) % 512)


def host_preflight(request):
    before = identity(request)
    deadline = time.monotonic()+STREAM_SECONDS
    process = subprocess.Popen(['docker','image','save',before['tag']],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    reader = BoundedArchiveReader(process.stdout, deadline)
    try:
        receipt = scan_host_archive(reader, request['imageId'], before['layerDiffIds'],
            expected_tag=before['tag'],source_sha=request['releaseSha'],server_tree=request['serverTree'])
        require(process.wait(timeout=max(.01,deadline-time.monotonic())) == 0, 'Host scan failed')
        validate_transition(before, identity(request), request)
        return {'identity': before, 'scan': receipt}
    finally:
        reader.close()
        if process.poll() is None: process.kill(); process.wait(timeout=5)
        process.stdout.close()


def remote(mode, request):
    if mode == '--identity':
        print(json.dumps(identity(request))); return
    if mode == '--preflight':
        print(json.dumps(host_preflight(request))); return
    require(mode == '--save', 'Unknown fixed read mode')
    before = identity(request)
    # Caller must first admit the complete host-only scan. Exact immutable tag
    # and image binding are rechecked; this second save must match its digest.
    subprocess.run(['docker','image','save',before['tag']],stdout=sys.stdout.buffer,
                   stderr=subprocess.DEVNULL,check=True,timeout=STREAM_SECONDS)
    validate_transition(before, identity(request), request)


def main():
    if len(sys.argv) == 3 and sys.argv[1] in ('--identity','--preflight','--save'):
        remote(sys.argv[1], selection(json.loads(base64.b64decode(sys.argv[2], validate=True))))
        return
    require(len(sys.argv) == 1 and os.environ.get('GITHUB_EVENT_NAME') == 'repository_dispatch',
            'Explicit retrieval dispatch required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    require(event.get('action') == 'audit-production-integrity' and
            event.get('repository', {}).get('private') is True, 'Private explicit repository required')
    request = selection(event.get('client_payload', {}).get('operator_hold_image'))
    c = common()
    public = c.health()
    require(public['releaseSha'] == request['releaseSha'], 'Requested engine not serving')
    host = os.environ.get('HETZNER_HOST', '')
    key = os.environ.get('HETZNER_SSH_PRIVATE_KEY', '')
    pin = os.environ.get('HETZNER_HOST_KEY', '')
    require(re.fullmatch('[A-Za-z0-9.-]+',host) and not host.startswith('-') and
            key.strip() and pin.strip(), 'Configured read bridge unavailable')
    directory = Path(tempfile.mkdtemp(prefix='operator-image-', dir=os.environ['RUNNER_TEMP']))
    destination = Path('artifacts/operator-hold-image')
    published = False
    created_destination = False
    try:
        for name, value in [('key',key),('known_hosts',pin)]:
            path=directory/name;path.write_text(value+'\n');path.chmod(0o600)
        for args in [['ssh-keygen','-y','-f',str(directory/'key')],
                     ['ssh-keygen','-l','-f',str(directory/'known_hosts')]]:
            subprocess.run(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                           check=True,timeout=5)
        base=['ssh','-i',str(directory/'key'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes',
              '-o','StrictHostKeyChecking=yes','-o','GlobalKnownHostsFile=/dev/null',
              '-o','UserKnownHostsFile='+str(directory/'known_hosts'),'-o','ConnectTimeout=10',
              'root@'+host]
        encoded=base64.b64encode(json.dumps(request).encode()).decode()
        common_source=Path(__file__).with_name('read-scoped-operator-hold-provenance.py').read_bytes()
        prelude="import types,base64\n_COMMON=types.ModuleType('common')\nexec(compile(base64.b64decode("+repr(base64.b64encode(common_source).decode())+"),'fixed-common','exec'),_COMMON.__dict__)\n"
        source=prelude.encode()+Path(__file__).read_bytes()
        def args(mode):return base+["python3 - "+mode+" '"+encoded+"'"]
        def read_identity():
            r=subprocess.run(args('--identity'),input=source,capture_output=True,timeout=70)
            require(r.returncode==0 and len(r.stdout)<=262144,'Identity bridge refused')
            return json.loads(r.stdout)
        preflight_reply=subprocess.run(args('--preflight'),input=source,capture_output=True,timeout=190)
        require(preflight_reply.returncode == 0 and len(preflight_reply.stdout) <= 262144, 'Host preflight refused')
        preflight=json.loads(preflight_reply.stdout)
        before=preflight['identity']
        require(before == read_identity(), 'Host preflight identity changed')
        require(before['native']['hostBefore']==public,'Public/host admission differs')
        raw=directory/'received.tar'
        stream_archive(args('--save'),source,raw)
        require(raw.stat().st_size == preflight['scan']['bytes'], 'Preflight stream size differs')
        with raw.open('rb') as received:
            require(hashlib.file_digest(received,'sha256').hexdigest() == preflight['scan']['sha256'], 'Preflight stream digest differs')
        after=read_identity()
        validate_transition(before,after,request)
        require(c.health()==public,'Public engine changed')
        spec=importlib.util.spec_from_file_location('image_archive',Path('server/scripts/engine-image-archive.py'))
        normalizer=importlib.util.module_from_spec(spec);spec.loader.exec_module(normalizer)
        normalized=directory/'image.tar'
        result=normalizer.normalize_engine_archive(raw,normalized,source_sha=request['releaseSha'],
                                                  server_tree=request['serverTree'],image_id=request['imageId'])
        layer_count=inspect_layer_headers(normalized)
        require(not destination.exists(),'Artifact destination exists')
        destination.mkdir(parents=True,mode=0o700)
        created_destination = True
        shutil.copyfile(normalized,destination/'image.tar');(destination/'image.tar').chmod(0o600)
        result.update(schema=SCHEMA,observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      producer_authenticated=True,hostBefore=public,containerBefore=before['native']['containerBefore'],
                      containerAfter=after['native']['containerAfter'],layerHeaderCount=layer_count,
                      environmentNames=before['environmentNames'],hostPreflight=preflight['scan'],readOnly=True,fullBPassed=False,
                      host_import_qualified=False)
        (destination/'manifest.json').write_text(json.dumps(result,indent=2)+'\n')
        (destination/'manifest.json').chmod(0o600)
        published=True
        print('Exact immutable image retained privately. No production mutation performed.')
    finally:
        if created_destination and not published and destination.exists():shutil.rmtree(destination)
        shutil.rmtree(directory)


if __name__=='__main__':
    try:main()
    except Exception:
        print('Immutable image retrieval refused. No production mutation performed.',file=sys.stderr)
        sys.exit(1)
