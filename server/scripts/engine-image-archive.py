#!/usr/bin/env python3
"""Normalize an exact Docker-save image without loading it into any daemon.

This binds bytes to independently supplied image/source identities. It does not
authenticate the producer, qualify host import memory, or authorize deployment.
"""
import hashlib
import json
import io
import os
from pathlib import Path
import re
import stat
import tarfile
import tempfile
import zlib
import time

ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024
MEMBER_LIMIT = 1024 * 1024 * 1024
METADATA_LIMIT = 1024 * 1024
MEMBER_COUNT_LIMIT = 512
LAYER_COUNT_LIMIT = 64
CONTRACT = 'clean-server-archive-v1'
ENV_NAMES = {'PATH','NODE_VERSION','YARN_VERSION','NODE_ENV','ENGINE_ALERT_JOURNAL_DIR','NODE_OPTIONS','GIT_COMMIT_SHA'}


def require(condition, reason):
    if not condition:
        raise ValueError('ENGINE_IMAGE_ARCHIVE_' + reason)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique_object)


def sha256(stream):
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


def canonical_name(name):
    return (isinstance(name, str) and len(name) <= 255
            and re.fullmatch(r'[A-Za-z0-9_./-]+', name)
            and all(part not in {'', '.', '..'} for part in name.split('/')))


class DigestReader:
    def __init__(self, stream, remaining):
        self.stream = stream
        self.remaining = remaining
        self.digest = hashlib.sha256()

    def read(self, size):
        chunk = self.stream.read(min(size, self.remaining))
        self.remaining -= len(chunk)
        self.digest.update(chunk)
        return chunk


def normalize_engine_archive(source, destination, *, source_sha, server_tree, image_id):
    """Write one canonical, exact-image Docker archive by atomic no-replace link.

    Legacy config identities use verified uncompressed layers. OCI manifest identities
    retain the exact original manifest/config/compressed layer bytes. Docker's
    auxiliary OCI indexes, legacy metadata and foreign layer hints are omitted;
    no second importer can choose a different graph from auxiliary metadata.
    """
    require(all(isinstance(value, str) and re.fullmatch('[0-9a-f]{40}', value)
                for value in (source_sha, server_tree)), 'SOURCE_IDENTITY')
    require(isinstance(image_id, str) and re.fullmatch('sha256:[0-9a-f]{64}', image_id), 'IMAGE_IDENTITY')
    normalization_deadline = time.monotonic()+120
    source, destination = Path(source), Path(destination)
    require(source.is_absolute() and destination.is_absolute(), 'ABSOLUTE_PATHS')
    require(not destination.exists() and not destination.is_symlink(), 'DESTINATION_EXISTS')
    expected_tag = 'club-arena-engine:' + source_sha
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    temporary = None
    published = False
    try:
        before = os.fstat(source_fd)
        require(stat.S_ISREG(before.st_mode) and 1024 <= before.st_size <= ARCHIVE_LIMIT,
                'REGULAR_BOUNDED_SOURCE')
        with os.fdopen(source_fd, 'rb', closefd=False) as source_stream:
            original_digest = sha256(source_stream)
            source_stream.seek(0)
            # Inspect each fixed-size header before any tar parser can consume
            # PAX/GNU extension payloads using an attacker-controlled size.
            members = {}
            previous_end = 0
            while True:
                source_stream.seek(previous_end)
                header = source_stream.read(512)
                require(len(header) == 512, 'END_MARKERS')
                if header == bytes(512):
                    break
                require(len(members) < MEMBER_COUNT_LIMIT, 'MEMBER_COUNT')
                member = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
                require(member.type not in {tarfile.XHDTYPE, tarfile.XGLTYPE,
                                            tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK},
                        'EXTENDED_HEADERS')
                require(member.type in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE}, 'MEMBER_TYPE')
                name = member.name.rstrip('/') if member.isdir() else member.name
                require(canonical_name(name) and name not in members, 'MEMBER_NAME')
                require(0 <= member.size <= MEMBER_LIMIT and (not member.isdir() or member.size == 0),
                        'MEMBER_SIZE')
                member.offset_data = previous_end + 512
                previous_end = member.offset_data + ((member.size + 511) // 512) * 512
                require(previous_end <= before.st_size, 'TRUNCATED_MEMBER')
                members[name] = member
            require(before.st_size - previous_end >= 1024 and before.st_size % 512 == 0,
                    'END_MARKERS')
            source_stream.seek(previous_end)
            while chunk := source_stream.read(1024 * 1024):
                require(not any(chunk), 'TRAILING_DATA')

            def metadata(name):
                require(canonical_name(name) and name in members and members[name].isreg(),
                        'METADATA_MEMBER')
                require(0 < members[name].size <= METADATA_LIMIT, 'METADATA_SIZE')
                source_stream.seek(members[name].offset_data)
                return source_stream.read(members[name].size)

            manifest = decode(metadata('manifest.json'))
            require(isinstance(manifest, list) and len(manifest) == 1, 'ONE_IMAGE_REQUIRED')
            item = manifest[0]
            require(isinstance(item, dict) and {'Config', 'RepoTags', 'Layers'} <= set(item)
                    and set(item) <= {'Config', 'RepoTags', 'Layers', 'Parent', 'LayerSources'},
                    'MANIFEST_SHAPE')
            require(item['RepoTags'] == [expected_tag], 'EXACT_SINGLE_TAG')
            config_bytes = metadata(item['Config'])
            config_digest='sha256:'+hashlib.sha256(config_bytes).hexdigest()
            oci_mode=config_digest != image_id
            oci_metadata=[]
            if oci_mode:
                native_name='blobs/sha256/'+image_id[7:]
                require(native_name in members,'CONFIG_DIGEST')
                native_bytes=metadata(native_name)
                require('sha256:'+hashlib.sha256(native_bytes).hexdigest()==image_id,'OCI_NATIVE_DIGEST')
                native=decode(native_bytes)
                require(isinstance(native,dict) and set(native)=={'schemaVersion','mediaType','config','layers'}
                        and native['schemaVersion']==2 and native['mediaType']=='application/vnd.oci.image.manifest.v1+json','OCI_NATIVE_MANIFEST')
                descriptor=native['config']
                require(descriptor=={'mediaType':'application/vnd.oci.image.config.v1+json','digest':config_digest,'size':len(config_bytes)}
                        and item['Config']=='blobs/sha256/'+config_digest[7:],'OCI_NATIVE_CONFIG')
                index_bytes=metadata('index.json');index=decode(index_bytes)
                require(isinstance(index,dict) and set(index)<= {'schemaVersion','mediaType','manifests'}
                        and index.get('schemaVersion')==2 and index.get('mediaType')=='application/vnd.oci.image.index.v1+json'
                        and isinstance(index.get('manifests'),list) and len(index['manifests'])==1,'OCI_INDEX')
                selected=index['manifests'][0]
                require(isinstance(selected,dict) and set(selected)<= {'mediaType','digest','size','platform','annotations'}
                        and selected.get('mediaType')=='application/vnd.oci.image.manifest.v1+json'
                        and selected.get('digest')==image_id and selected.get('size')==len(native_bytes),'OCI_INDEX_IDENTITY')
                require('platform' not in selected or selected['platform']=={'architecture':'amd64','os':'linux'},'OCI_INDEX_PLATFORM')
                if 'annotations' in selected:
                    require(isinstance(selected['annotations'],dict) and set(selected['annotations'])<= {'org.opencontainers.image.ref.name'}
                            and all(isinstance(x,str) and re.fullmatch('[A-Za-z0-9_:/.-]{1,200}',x) for x in selected['annotations'].values()),'OCI_INDEX_ANNOTATIONS')
                layout_bytes=metadata('oci-layout')
                require(decode(layout_bytes)=={'imageLayoutVersion':'1.0.0'},'OCI_LAYOUT')
                oci_metadata=[('oci-layout',layout_bytes),('index.json',index_bytes),(native_name,native_bytes)]
            config = decode(config_bytes)
            require(isinstance(config, dict) and config.get('os') == 'linux'
                    and config.get('architecture') == 'amd64', 'PLATFORM')
            if oci_mode: require(set(config)<= {'architecture','config','created','history','os','rootfs'},'OCI_CONFIG_SHAPE')
            runtime = config.get('config')
            require(isinstance(runtime, dict) and isinstance(runtime.get('Labels'), dict), 'LABELS')
            labels = runtime['Labels']
            require(labels.get('org.opencontainers.image.revision') == source_sha
                    and labels.get('com.smarterpoker.engine.source-tree') == server_tree
                    and labels.get('com.smarterpoker.engine.build-contract') == CONTRACT, 'SOURCE_LABELS')
            env = runtime.get('Env')
            require(isinstance(env, list) and all(isinstance(x, str) for x in env)
                    and [x for x in env if x.startswith('GIT_COMMIT_SHA=')]
                    == ['GIT_COMMIT_SHA=' + source_sha], 'BAKED_REVISION')
            if oci_mode:
                names=[x.partition('=')[0] for x in env]
                require(names and len(names)==len(set(names)) and set(names)<=ENV_NAMES,'OCI_ENV_NAMES')
            rootfs = config.get('rootfs')
            require(isinstance(rootfs, dict) and rootfs.get('type') == 'layers', 'ROOTFS')
            diff_ids, layers = rootfs.get('diff_ids'), item['Layers']
            require(isinstance(diff_ids, list) and isinstance(layers, list)
                    and 0 < len(diff_ids) == len(layers) <= LAYER_COUNT_LIMIT, 'LAYERS')
            require(all(isinstance(value, str) and re.fullmatch('sha256:[0-9a-f]{64}', value)
                        for value in diff_ids), 'LAYER_IDENTITIES')
            for name in layers:
                require(canonical_name(name) and name in members and members[name].isreg()
                        and name not in {'manifest.json', item['Config']}, 'LAYER_MEMBER')
            require(sum(members[name].size for name in layers) + len(config_bytes)
                    + (len(layers) + 4) * 10240 <= ARCHIVE_LIMIT, 'OUTPUT_SIZE')

            if oci_mode:
                descriptors=native['layers']
                require(isinstance(descriptors,list) and len(descriptors)==len(layers),'OCI_LAYER_COUNT')
                for name,descriptor in zip(layers,descriptors):
                    require(isinstance(descriptor,dict) and set(descriptor)=={'mediaType','digest','size'}
                            and isinstance(descriptor['digest'],str) and re.fullmatch('sha256:[0-9a-f]{64}',descriptor['digest'])
                            and name=='blobs/sha256/'+descriptor['digest'][7:] and descriptor['size']==members[name].size
                            and descriptor['mediaType'] in {'application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+gzip'},'OCI_LAYER_BINDING')
            output_names = layers if oci_mode else [f'layers/{index:04d}.tar' for index in range(len(layers))]
            config_name = item['Config'] if oci_mode else image_id.removeprefix('sha256:') + '.json'
            normalized_manifest = json.dumps([dict(Config=config_name, RepoTags=[expected_tag],
                                                  Layers=output_names)], separators=(',', ':')).encode()
            fd, temporary_name = tempfile.mkstemp(prefix='.engine-image-', suffix='.tar',
                                                 dir=destination.parent)
            temporary = Path(temporary_name)
            with os.fdopen(fd, 'w+b') as output:
                with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as normalized:
                    for name, raw in [('manifest.json', metadata('manifest.json') if oci_mode else normalized_manifest), (config_name, config_bytes)]+oci_metadata:
                        member = tarfile.TarInfo(name)
                        member.size, member.mode, member.mtime = len(raw), 0o444, 0
                        normalized.addfile(member, io.BytesIO(raw))
                    for layer_index,(name, output_name, expected_digest) in enumerate(zip(layers, output_names, diff_ids)):
                        member = tarfile.TarInfo(output_name)
                        member.mode, member.mtime = 0o444, 0
                        source_stream.seek(members[name].offset_data)
                        prefix = source_stream.read(2)
                        source_stream.seek(members[name].offset_data)
                        if oci_mode:
                            require((prefix==b'\x1f\x8b')==(descriptors[layer_index]['mediaType']=='application/vnd.oci.image.layer.v1.tar+gzip'),'OCI_LAYER_ENCODING')
                        if prefix == b'\x1f\x8b':
                            # OCI gzip blob hashes bind compressed bytes; RootFS binds decoded tar.
                            require(re.fullmatch('blobs/sha256/[0-9a-f]{64}', name), 'COMPRESSED_LAYER_NAME')
                            deadline = normalization_deadline
                            compressed = DigestReader(source_stream, members[name].size)
                            decoder, digest, size = zlib.decompressobj(31), hashlib.sha256(), 0
                            with tempfile.TemporaryFile(dir=destination.parent) as decoded:
                                while compressed.remaining:
                                    require(time.monotonic() < deadline, 'LAYER_DECODE_DEADLINE')
                                    pending = compressed.read(65536)
                                    require(pending, 'COMPRESSED_LAYER_TRUNCATED')
                                    while pending:
                                        require(time.monotonic() < deadline, 'LAYER_DECODE_DEADLINE')
                                        try:
                                            chunk = decoder.decompress(pending,65536)
                                        except zlib.error as error:
                                            raise ValueError('ENGINE_IMAGE_ARCHIVE_COMPRESSED_LAYER') from error
                                        pending = decoder.unconsumed_tail
                                        size += len(chunk)
                                        require(size <= MEMBER_LIMIT and output.tell()+size+10240 <= ARCHIVE_LIMIT,
                                                'DECODED_LAYER_SIZE')
                                        digest.update(chunk); decoded.write(chunk)
                                        require(not decoder.unused_data, 'COMPRESSED_TRAILING_DATA')
                                require(decoder.eof and not decoder.unconsumed_tail, 'COMPRESSED_LAYER_TRUNCATED')
                                require(compressed.digest.hexdigest() == name.split('/')[-1], 'COMPRESSED_LAYER_DIGEST')
                                require('sha256:'+digest.hexdigest() == expected_digest, 'LAYER_DIGEST')
                                if oci_mode:
                                    member.size=members[name].size
                                    source_stream.seek(members[name].offset_data)
                                    original=DigestReader(source_stream,member.size)
                                    normalized.addfile(member,original)
                                    require(original.remaining==0 and original.digest.hexdigest()==name.split('/')[-1],'OCI_LAYER_CHANGED')
                                else:
                                    member.size = size
                                    decoded.seek(0); normalized.addfile(member,decoded)
                        else:
                            member.size = members[name].size
                            reader = DigestReader(source_stream, member.size)
                            normalized.addfile(member, reader)
                            require(reader.remaining == 0 and 'sha256:' + reader.digest.hexdigest() == expected_digest,
                                    'LAYER_DIGEST')
                            if oci_mode: require('sha256:'+reader.digest.hexdigest()==descriptors[layer_index]['digest'],'OCI_LAYER_DIGEST')
                output.flush()
                os.fsync(output.fileno())
                require(output.tell() <= ARCHIVE_LIMIT, 'OUTPUT_SIZE')
                output.seek(0)
                canonical_digest = sha256(output)
                canonical_size = output.tell()
            source_stream.seek(0)
            require(sha256(source_stream) == original_digest, 'SOURCE_CHANGED')
            after = os.fstat(source_fd)
            require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                    'SOURCE_CHANGED')
            os.link(temporary, destination, follow_symlinks=False)
            published = True
            directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            return dict(version=1, scope='engine-image-archive-normalization', image_id=image_id,
                        source_sha=source_sha, server_tree=server_tree, build_contract=CONTRACT,
                        input_sha256=original_digest, archive_sha256=canonical_digest,
                        archive_bytes=canonical_size, layers=len(layers), platform='linux/amd64',
                        producer_authenticated=False, host_import_qualified=False)
    except BaseException:
        if published:
            destination.unlink()
        raise
    finally:
        os.close(source_fd)
        if temporary is not None:
            temporary.unlink(missing_ok=True)
