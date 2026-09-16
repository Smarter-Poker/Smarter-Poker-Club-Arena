#!/usr/bin/env python3
"""Normalize an exact Docker-save image without loading it into any daemon.

This binds bytes to independently supplied image/source identities. It does not
authenticate the producer, qualify host import memory, or authorize deployment.
"""
import gzip
import hashlib
import json
import io
import os
from pathlib import Path
import re
import stat
import tarfile
import tempfile

ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024
MEMBER_LIMIT = 1024 * 1024 * 1024
METADATA_LIMIT = 1024 * 1024
MEMBER_COUNT_LIMIT = 512
LAYER_COUNT_LIMIT = 64
CONTRACT = 'clean-server-archive-v1'


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

    def read(self, size=-1):
        chunk = self.stream.read(self.remaining if size < 0 else min(size, self.remaining))
        self.remaining -= len(chunk)
        self.digest.update(chunk)
        return chunk


def normalize_engine_archive(source, destination, *, source_sha, server_tree, image_id):
    """Write one canonical, exact-image Docker archive by atomic no-replace link.

    Legacy config identities retain their original uncompressed Docker graph.
    OCI manifest identities retain only the proven manifest/config/layer graph,
    with a canonical single-tag index and equivalent Docker manifest. Unrelated
    metadata cannot supply a second image or change the authenticated identity.
    """
    require(all(isinstance(value, str) and re.fullmatch('[0-9a-f]{40}', value)
                for value in (source_sha, server_tree)), 'SOURCE_IDENTITY')
    require(isinstance(image_id, str) and re.fullmatch('sha256:[0-9a-f]{64}', image_id), 'IMAGE_IDENTITY')
    source, destination = Path(source), Path(destination)
    require(source.is_absolute() and destination.is_absolute(), 'ABSOLUTE_PATHS')
    require(not destination.exists() and not destination.is_symlink(), 'DESTINATION_EXISTS')
    expected_tag = 'club-arena-engine:' + source_sha
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    temporary = None
    published = False
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and 1024 <= before.st_size <= ARCHIVE_LIMIT,
                'REGULAR_BOUNDED_SOURCE')
        with os.fdopen(descriptor, 'rb', closefd=False) as source_stream:
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
            config_id = 'sha256:' + hashlib.sha256(config_bytes).hexdigest()
            oci_manifest = None
            if config_id != image_id:
                # Docker's containerd store identifies an image by its manifest,
                # while the classic store uses its config. Authenticate the
                # exact supplied manifest before accepting that distinct case.
                oci_name = 'blobs/sha256/' + image_id[7:]
                require(oci_name in members, 'CONFIG_DIGEST')
                oci_bytes = metadata(oci_name)
                require('sha256:' + hashlib.sha256(oci_bytes).hexdigest() == image_id,
                        'OCI_MANIFEST_DIGEST')
                oci_manifest = decode(oci_bytes)
                manifest_type = 'application/vnd.oci.image.manifest.v1+json'
                require(isinstance(oci_manifest, dict)
                        and set(oci_manifest) == {'schemaVersion', 'mediaType', 'config', 'layers'}
                        and oci_manifest['schemaVersion'] == 2
                        and oci_manifest['mediaType'] == manifest_type, 'OCI_MANIFEST')

                def oci_descriptor(value, name, media_types):
                    require(isinstance(value, dict)
                            and set(value) == {'mediaType', 'digest', 'size'}
                            and value['mediaType'] in media_types
                            and isinstance(value['digest'], str)
                            and re.fullmatch('sha256:[0-9a-f]{64}', value['digest'])
                            and name == 'blobs/sha256/' + value['digest'][7:]
                            and name in members and members[name].isreg()
                            and type(value['size']) is int
                            and value['size'] == members[name].size, 'OCI_DESCRIPTOR')

                oci_descriptor(oci_manifest['config'], item['Config'],
                               {'application/vnd.oci.image.config.v1+json'})
                require(oci_manifest['config']['digest'] == config_id, 'CONFIG_DIGEST')
                index = decode(metadata('index.json'))
                require(isinstance(index, dict) and index.get('schemaVersion') == 2
                        and index.get('mediaType') == 'application/vnd.oci.image.index.v1+json'
                        and isinstance(index.get('manifests'), list)
                        and len(index['manifests']) == 1, 'OCI_SINGLE_IMAGE')
                selected = index['manifests'][0]
                require(isinstance(selected, dict)
                        and set(selected) <= {'mediaType', 'digest', 'size', 'annotations'},
                        'OCI_INDEX_DESCRIPTOR')
                oci_descriptor({k: v for k, v in selected.items() if k != 'annotations'},
                               oci_name, {manifest_type})
                annotations = selected.get('annotations', {})
                require(isinstance(annotations, dict)
                        and annotations.get('io.containerd.image.name', 'docker.io/library/' + expected_tag)
                            == 'docker.io/library/' + expected_tag
                        and annotations.get('org.opencontainers.image.ref.name', source_sha) == source_sha,
                        'EXACT_SINGLE_TAG')
                require(decode(metadata('oci-layout')) == {'imageLayoutVersion': '1.0.0'}, 'OCI_LAYOUT')
            config = decode(config_bytes)
            require(isinstance(config, dict) and config.get('os') == 'linux'
                    and config.get('architecture') == 'amd64', 'PLATFORM')
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

            if oci_manifest is not None:
                descriptors = oci_manifest['layers']
                require(isinstance(descriptors, list) and len(descriptors) == len(layers), 'OCI_LAYERS')
                expanded_total = 0
                for name, layer_descriptor, diff_id in zip(layers, descriptors, diff_ids):
                    oci_descriptor(layer_descriptor, name,
                                   {'application/vnd.oci.image.layer.v1.tar',
                                    'application/vnd.oci.image.layer.v1.tar+gzip'})
                    source_stream.seek(members[name].offset_data)
                    reader = DigestReader(source_stream, members[name].size)
                    decoded = (gzip.GzipFile(fileobj=reader, mode='rb')
                               if layer_descriptor['mediaType'].endswith('+gzip') else reader)
                    expanded, digest = 0, hashlib.sha256()
                    try:
                        while chunk := decoded.read(min(1024 * 1024, MEMBER_LIMIT - expanded + 1,
                                                        ARCHIVE_LIMIT - expanded_total + 1)):
                            expanded += len(chunk)
                            expanded_total += len(chunk)
                            require(expanded <= MEMBER_LIMIT and expanded_total <= ARCHIVE_LIMIT,
                                    'LAYER_EXPANSION_LIMIT')
                            digest.update(chunk)
                    finally:
                        if decoded is not reader:
                            decoded.close()
                    require(reader.remaining == 0
                            and 'sha256:' + reader.digest.hexdigest() == layer_descriptor['digest'],
                            'OCI_LAYER_DIGEST')
                    require('sha256:' + digest.hexdigest() == diff_id, 'LAYER_DIGEST')

            output_names = [f'layers/{index:04d}.tar' for index in range(len(layers))]
            config_name = image_id.removeprefix('sha256:') + '.json'
            normalized_manifest = json.dumps([dict(Config=config_name, RepoTags=[expected_tag],
                                                  Layers=output_names)], separators=(',', ':')).encode()
            output_metadata = [('manifest.json', normalized_manifest), (config_name, config_bytes)]
            output_digests = diff_ids
            if oci_manifest is not None:
                output_names = layers
                output_digests = [entry['digest'] for entry in oci_manifest['layers']]
                canonical_index = dict(schemaVersion=2, mediaType='application/vnd.oci.image.index.v1+json',
                                       manifests=[dict(mediaType=manifest_type, digest=image_id,
                                                       size=len(oci_bytes), annotations={
                                           'io.containerd.image.name': 'docker.io/library/' + expected_tag,
                                           'org.opencontainers.image.ref.name': source_sha})])
                docker_manifest = [dict(Config=item['Config'], RepoTags=[expected_tag], Layers=layers)]
                output_metadata = [
                    ('manifest.json', json.dumps(docker_manifest, separators=(',', ':')).encode()),
                    ('index.json', json.dumps(canonical_index, separators=(',', ':')).encode()),
                    ('oci-layout', b'{"imageLayoutVersion":"1.0.0"}'),
                    (oci_name, oci_bytes), (item['Config'], config_bytes)]
                require(sum(len(raw) for _, raw in output_metadata)
                        + sum(members[name].size for name in layers)
                        + (len(layers) + len(output_metadata) + 2) * 10240 <= ARCHIVE_LIMIT,
                        'OUTPUT_SIZE')
            fd, temporary_name = tempfile.mkstemp(prefix='.engine-image-', suffix='.tar',
                                                 dir=destination.parent)
            temporary = Path(temporary_name)
            with os.fdopen(fd, 'w+b') as output:
                with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as normalized:
                    for name, raw in output_metadata:
                        member = tarfile.TarInfo(name)
                        member.size, member.mode, member.mtime = len(raw), 0o444, 0
                        normalized.addfile(member, io.BytesIO(raw))
                    written = set()
                    for name, output_name, expected_digest in zip(layers, output_names, output_digests):
                        if output_name in written:
                            continue
                        written.add(output_name)
                        member = tarfile.TarInfo(output_name)
                        member.size, member.mode, member.mtime = members[name].size, 0o444, 0
                        source_stream.seek(members[name].offset_data)
                        reader = DigestReader(source_stream, member.size)
                        normalized.addfile(member, reader)
                        require(reader.remaining == 0 and 'sha256:' + reader.digest.hexdigest() == expected_digest,
                                'LAYER_DIGEST')
                output.flush()
                os.fsync(output.fileno())
                require(output.tell() <= ARCHIVE_LIMIT, 'OUTPUT_SIZE')
                output.seek(0)
                canonical_digest = sha256(output)
                canonical_size = output.tell()
            source_stream.seek(0)
            require(sha256(source_stream) == original_digest, 'SOURCE_CHANGED')
            after = os.fstat(descriptor)
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
        os.close(descriptor)
        if temporary is not None:
            temporary.unlink(missing_ok=True)
