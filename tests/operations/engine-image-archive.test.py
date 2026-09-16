"""Exercise real tar bytes and atomic output; no Docker or host import."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('engine_archive', ROOT / 'server/scripts/engine-image-archive.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA, TREE = 'a' * 40, 'b' * 40


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def layer(content):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        entry = tarfile.TarInfo('app/file.txt')
        entry.size = len(content)
        tar.addfile(entry, io.BytesIO(content))
    return result.getvalue()


def fixture(modern=True):
    layers = [layer(b'first'), layer(b'second')]
    config = dict(os='linux', architecture='amd64',
                  config=dict(Env=['PATH=/usr/bin', 'GIT_COMMIT_SHA=' + SHA], Labels={
                      'org.opencontainers.image.revision': SHA,
                      'com.smarterpoker.engine.source-tree': TREE,
                      'com.smarterpoker.engine.build-contract': m.CONTRACT}),
                  rootfs=dict(type='layers', diff_ids=['sha256:' + digest(b) for b in layers]))
    raw = json.dumps(config).encode()
    config_name = 'blobs/sha256/' + digest(raw) if modern else digest(raw) + '.json'
    names = ['blobs/sha256/' + digest(b) if modern else f'old-layer-{i}/layer.tar'
             for i, b in enumerate(layers)]
    manifest = [dict(Config=config_name, RepoTags=['club-arena-engine:' + SHA], Layers=names)]
    entries = [('manifest.json', json.dumps(manifest).encode()), (config_name, raw), *zip(names, layers)]
    # An alternative OCI graph and legacy hints must never reach the importer.
    entries += [('index.json', b'{"unreviewed":"graph"}'), ('oci-layout', b'{}'), ('repositories', b'{}')]
    return entries, 'sha256:' + digest(raw)


def write_tar(path, entries, *, extended=False):
    with tarfile.open(path, mode='w', format=tarfile.PAX_FORMAT if extended else tarfile.USTAR_FORMAT) as tar:
        for name, data in entries:
            member = copy.copy(name) if isinstance(name, tarfile.TarInfo) else tarfile.TarInfo(name)
            member.size = len(data)
            if extended:
                member.pax_headers = {'mtime': '1.123456789'}
            tar.addfile(member, io.BytesIO(data))


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'input.tar'
        self.output = self.root / 'normalized.tar'
        self.entries, self.image = fixture()

    def normalize(self, **kwargs):
        return m.normalize_engine_archive(self.source, self.output,
                                         source_sha=SHA, server_tree=TREE, image_id=self.image, **kwargs)

    def refused(self, reason=None):
        with self.assertRaisesRegex((ValueError, tarfile.TarError, OSError), reason or '.'):
            self.normalize()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob('.engine-image-*')))

    def test_modern_and_legacy_layouts_normalize_to_one_exact_graph(self):
        digests = []
        for modern in [True, False]:
            with self.subTest(modern=modern):
                self.entries, self.image = fixture(modern)
                write_tar(self.source, self.entries)
                receipt = self.normalize()
                self.assertFalse(receipt['producer_authenticated'])
                self.assertFalse(receipt['host_import_qualified'])
                self.assertEqual(receipt['image_id'], self.image)
                self.assertEqual(receipt['archive_sha256'], digest(self.output.read_bytes()))
                self.assertEqual(receipt['input_sha256'], digest(self.source.read_bytes()))
                self.assertEqual(receipt['archive_bytes'], self.output.stat().st_size)
                self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
                with tarfile.open(self.output) as tar:
                    self.assertEqual(tar.getnames(), ['manifest.json', self.image[7:] + '.json',
                                                     'layers/0000.tar', 'layers/0001.tar'])
                    config_bytes = tar.extractfile(self.image[7:] + '.json').read()
                    self.assertEqual('sha256:' + digest(config_bytes), self.image)
                    config = json.loads(config_bytes)
                    for i, expected in enumerate(config['rootfs']['diff_ids']):
                        self.assertEqual('sha256:' + digest(tar.extractfile(f'layers/{i:04d}.tar').read()), expected)
                digests.append(receipt['archive_sha256'])
                self.output.unlink()
        self.assertEqual(digests[0], digests[1])

    def test_directories_are_accepted_but_not_copied(self):
        directory = tarfile.TarInfo('blobs/')
        directory.type = tarfile.DIRTYPE
        write_tar(self.source, [(directory, b''), *self.entries])
        self.normalize()
        with tarfile.open(self.output) as tar:
            self.assertTrue(all(m.isreg() for m in tar))

    def test_wrong_expected_config_identity_refuses(self):
        write_tar(self.source, self.entries)
        self.image = 'sha256:' + 'f' * 64
        self.refused('CONFIG_DIGEST')

    def test_wrong_platform_labels_environment_and_rootfs_refuse(self):
        edits = [lambda c: c.update(os='windows'), lambda c: c.update(architecture='arm64'),
                 lambda c: c['config']['Labels'].update({'org.opencontainers.image.revision': TREE}),
                 lambda c: c['config']['Labels'].update({'com.smarterpoker.engine.source-tree': SHA}),
                 lambda c: c['config']['Labels'].update({'com.smarterpoker.engine.build-contract': 'unknown'}),
                 lambda c: c['config'].update(Env=['GIT_COMMIT_SHA=' + TREE]),
                 lambda c: c['config']['Env'].append('GIT_COMMIT_SHA=' + SHA),
                 lambda c: c['config'].update(Env=['GIT_COMMIT_SHA=' + SHA, 7]),
                 lambda c: c['rootfs'].update(type='other'),
                 lambda c: c['rootfs'].update(diff_ids=[]),
                 lambda c: c['rootfs'].update(diff_ids=['sha256:' + '0' * 64] * 2)]
        for edit in edits:
            with self.subTest(edit=edits.index(edit)):
                entries, _ = fixture()
                c = json.loads(entries[1][1]);edit(c)
                raw = json.dumps(c).encode();entries[1] = (entries[1][0], raw)
                self.image = 'sha256:' + digest(raw)
                write_tar(self.source, entries)
                self.refused('ENGINE_IMAGE_ARCHIVE_')

    def test_missing_or_additional_image_tag_refuses(self):
        for tags in [[], None, ['club-arena-engine:' + TREE], ['club-arena-engine:' + SHA, 'other:tag']]:
            with self.subTest(tags=tags):
                entries, self.image = fixture()
                manifest = json.loads(entries[0][1]);manifest[0]['RepoTags'] = tags
                entries[0] = ('manifest.json', json.dumps(manifest).encode())
                write_tar(self.source, entries);self.refused('EXACT_SINGLE_TAG')

    def test_multiple_images_and_unknown_manifest_fields_refuse(self):
        for extra in [True, False]:
            entries, self.image = fixture();manifest = json.loads(entries[0][1])
            if extra: manifest.append(manifest[0])
            else: manifest[0]['unknown'] = 'ignored-by-some-loaders'
            entries[0] = ('manifest.json', json.dumps(manifest).encode())
            write_tar(self.source, entries);self.refused('ENGINE_IMAGE_ARCHIVE_')

    def test_duplicate_json_keys_refuse(self):
        for config in [False, True]:
            entries, self.image = fixture()
            index = 1 if config else 0
            raw = entries[index][1]
            raw = raw.replace(b'"os": "linux"', b'"os":"windows","os":"linux"') if config else raw.replace(b'"Config":', b'"Config":"other","Config":')
            entries[index] = (entries[index][0], raw)
            if config: self.image = 'sha256:' + digest(raw)
            write_tar(self.source, entries);self.refused('DUPLICATE_JSON_KEY')

    def test_corrupted_layer_refuses_and_removes_partial_output(self):
        entries, self.image = fixture();name, raw = entries[3]
        entries[3] = (name, raw[:-1] + b'!')
        write_tar(self.source, entries);self.refused('LAYER_DIGEST')

    def test_missing_directory_or_metadata_layer_reference_refuses(self):
        for name in ['missing', 'manifest.json', self.entries[1][0], 'blobs']:
            entries, self.image = fixture();manifest = json.loads(entries[0][1]);manifest[0]['Layers'][0] = name
            entries[0] = ('manifest.json', json.dumps(manifest).encode())
            directory = tarfile.TarInfo('blobs');directory.type = tarfile.DIRTYPE
            write_tar(self.source, [(directory, b''), *entries]);self.refused('LAYER_MEMBER')

    def test_links_devices_fifo_and_traversal_refuse_without_extraction(self):
        bad = ['../escape', '/absolute', 'a/./b', 'a//b', 'a/../b', 'bad\nname']
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE]:
            member = tarfile.TarInfo('bad-type');member.type = kind;member.linkname = 'elsewhere';bad.append(member)
        for name in bad:
            with self.subTest(name=str(name)):
                write_tar(self.source, [*self.entries, (name, b'')]);self.refused('ENGINE_IMAGE_ARCHIVE_')

    def test_duplicate_member_name_refuses(self):
        write_tar(self.source, [*self.entries, self.entries[0]]);self.refused('MEMBER_NAME')

    def test_extended_headers_refuse(self):
        write_tar(self.source, self.entries, extended=True);self.refused('EXTENDED_HEADERS')

    def test_oversized_extension_header_is_rejected_before_payload_read(self):
        for kind in [tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK]:
            member = tarfile.TarInfo('extension')
            member.type = kind
            member.size = 1024 ** 3
            self.source.write_bytes(member.tobuf(format=tarfile.USTAR_FORMAT) + bytes(1536))
            self.refused('EXTENDED_HEADERS')

    def test_nonzero_tail_concatenated_archive_and_truncation_refuse(self):
        for kind in ['tail', 'concat', 'truncate']:
            write_tar(self.source, self.entries);raw = self.source.read_bytes()
            if kind == 'tail': raw = raw[:-1] + b'!'
            elif kind == 'concat': raw += raw
            else: raw = raw[:16000]
            self.source.write_bytes(raw);self.refused()

    def test_archive_member_metadata_and_layer_limits_refuse(self):
        for constant, value in [('ARCHIVE_LIMIT', 1024), ('MEMBER_LIMIT', 512),
                                ('METADATA_LIMIT', 10), ('MEMBER_COUNT_LIMIT', 2), ('LAYER_COUNT_LIMIT', 1)]:
            write_tar(self.source, self.entries)
            with patch.object(m, constant, value): self.refused('ENGINE_IMAGE_ARCHIVE_')

    def test_symlink_and_fifo_input_refuse(self):
        actual = self.root / 'actual.tar';write_tar(actual, self.entries)
        self.source.symlink_to(actual);self.refused();self.source.unlink()
        os.mkfifo(self.source);self.refused('REGULAR_BOUNDED_SOURCE')

    def test_existing_output_is_never_replaced(self):
        write_tar(self.source, self.entries);self.output.write_bytes(b'preserve')
        with self.assertRaisesRegex(ValueError, 'DESTINATION_EXISTS'): self.normalize()
        self.assertEqual(self.output.read_bytes(), b'preserve')
        self.assertFalse(list(self.root.glob('.engine-image-*')))

    def test_concurrent_output_creation_is_not_overwritten(self):
        write_tar(self.source, self.entries)
        original_link = m.os.link
        def raced_link(source, destination, **kwargs):
            Path(destination).write_bytes(b'other owner')
            return original_link(source, destination, **kwargs)
        with patch.object(m.os, 'link', raced_link):
            with self.assertRaises(FileExistsError): self.normalize()
        self.assertEqual(self.output.read_bytes(), b'other owner')
        self.assertFalse(list(self.root.glob('.engine-image-*')))

    def test_changed_input_is_rejected_before_publication(self):
        write_tar(self.source, self.entries)
        original = m.sha256
        def mutate_after_digest(stream):
            result = original(stream)
            # Change the source after canonical output validation but before
            # the final input readback and no-replace publication.
            if os.fstat(stream.fileno()).st_ino != self.source.stat().st_ino:
                with self.source.open('r+b') as changed:
                    changed.seek(-1, 2);changed.write(b'!')
            return result
        with patch.object(m, 'sha256', mutate_after_digest): self.refused('SOURCE_CHANGED')


if __name__ == '__main__':
    unittest.main()
