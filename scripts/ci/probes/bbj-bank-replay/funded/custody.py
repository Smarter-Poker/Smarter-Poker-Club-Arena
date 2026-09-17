"""Repository-relative, exact-byte custody for the retained funded BBJ inputs.

Import is inert. This module starts no process, imports no retained adapter,
opens no database, and accepts no historical decision as execution authority.
The existing accounting runner must supply its fresh operation/runtime binding
before using these inputs for financial qualification.
"""
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
from types import MappingProxyType


MANIFEST_SHA256 = 'f1c37e277f3291ee39fe962fe96ce8179641e46c38ec94b622264abe839f4a29'
HERE = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON field: ' + key)
        result[key] = value
    return result


def _json(raw):
    return json.loads(raw, object_pairs_hook=_unique_object)


def _contained(root, relative):
    require(type(relative) is str and relative, 'Nonempty repository-relative path required')
    parts = PurePosixPath(relative)
    require(not parts.is_absolute() and relative == parts.as_posix() and
            all(part not in ('', '.', '..') for part in parts.parts),
            'Noncanonical or escaping source path: ' + relative)
    path = root
    for part in parts.parts:
        path = path / part
        require(not path.is_symlink(), 'Symlink is not an immutable source member: ' + relative)
    require(path.resolve().is_relative_to(root), 'Source escaped the maintained fixture')
    return path


class FundedSourceCustody:
    """Verified input paths and bytes; this object is not a financial run permit."""

    def __init__(self):
        root = HERE
        manifest_path = _contained(root, 'SOURCE-CLOSURE.json')
        raw = manifest_path.read_bytes()
        require(sha256(raw).hexdigest() == MANIFEST_SHA256, 'Funded source manifest hash changed')
        manifest = _json(raw)
        require(manifest.get('format') == 1 and manifest.get('funded_execution_enabled') is False,
                'Source-only custody format changed')
        require(manifest.get('required_postgresql_version') == '17.11',
                'Accepted PostgreSQL minor binding changed')
        self._root = root
        self._manifest = manifest
        files, origins, paths = {}, {}, set()
        for row in manifest['files']:
            require(type(row) is dict and type(row.get('id')) is str,
                    'Exact source member record required')
            require(row['id'] not in files and row['original_path'] not in origins and
                    row['path'] not in paths, 'Duplicate source identity, origin or destination')
            self._read_row(row)
            files[row['id']] = row
            origins[row['original_path']] = row['id']
            paths.add(row['path'])
        self._files = MappingProxyType(files)
        self._origins = MappingProxyType(origins)
        seals = {}
        for key, group in manifest['groups'].items():
            seal_row = next((row for row in manifest['provenance']
                             if row['path'] == group['historical_seal_path']), None)
            require(seal_row is not None and
                    seal_row['sha256'] == group['original_integrity_sha256'],
                    'Original seal binding missing: ' + key)
            old = _json(self._read_row(seal_row))['files']
            if type(old) is dict:
                seals[key] = old
            else:
                require(type(old) is list and len({row['path'] for row in old}) == len(old),
                        'Duplicate original sealed member: ' + key)
                seals[key] = {row['path']: row['sha256'] for row in old}
            require(_contained(root, group['path']).is_dir(), 'Missing source group: ' + key)
        for row in manifest['files']:
            require(seals[row['original_packet']].get(row['original_member']) == row['sha256'],
                    'Input does not match its original accepted seal: ' + row['id'])
        for row in manifest['provenance']:
            require(row['path'] not in paths, 'Duplicate provenance destination')
            paths.add(row['path'])
            self._read_row(row)
            if 'original_member' in row:
                require(seals[row['original_packet']].get(row['original_member']) == row['sha256'],
                        'Original runner/transform provenance changed')
        require(len(files) == 70 and len(manifest['provenance']) == 17,
                'Finite retained source inventory changed')
        require(all(source in files for source in manifest['sql_order']) and
                len(manifest['sql_order']) == len(set(manifest['sql_order'])) == 9,
                'Original SQL order is incomplete or duplicated')

    def _read_row(self, row):
        path = _contained(self._root, row['path'])
        require(path.is_file(), 'Missing retained source member: ' + row['path'])
        raw = path.read_bytes()
        require(sha256(raw).hexdigest() == row['sha256'],
                'Retained source hash changed: ' + row['path'])
        if 'bytes' in row:
            require(len(raw) == row['bytes'], 'Retained source size changed: ' + row['path'])
        return raw

    def _input(self, source_id):
        require(source_id in self._files, 'Unmapped retained source identity: ' + str(source_id))
        row = self._files[source_id]
        require(row['binding'] == 'exact_direct_input',
                'Historical admission/path metadata is not a fresh execution input: ' + source_id)
        return row

    def read_bytes(self, source_id):
        """Verify on every read, returning exact original bytes for an explicit input."""
        return self._read_row(self._input(source_id))

    def read_json(self, source_id):
        return _json(self.read_bytes(source_id))

    def source_path(self, source_id):
        """An exact mapped local path; callers must reverify bytes at use time."""
        row = self._input(source_id)
        self._read_row(row)
        return _contained(self._root, row['path'])

    def resolve_original_reference(self, original_path):
        """Resolve an exact known origin without ever reading that external path."""
        require(type(original_path) is str and original_path in self._origins,
                'No external-path fallback for an unmapped source reference')
        return self.source_path(self._origins[original_path])

    def group_path(self, group):
        require(group in self._manifest['groups'], 'Unknown maintained source group')
        return _contained(self._root, self._manifest['groups'][group]['path'])

    def ordered_sql(self):
        """Original SQL as verified bytes, not executed statements or a new runner."""
        return tuple((source_id, self.read_bytes(source_id))
                     for source_id in self._manifest['sql_order'])

    def receipt(self):
        return {
            'status': 'SOURCE_CUSTODY_ONLY',
            'manifest_sha256': MANIFEST_SHA256,
            'direct_and_binding_source_files': len(self._files),
            'historical_provenance_files': len(self._manifest['provenance']),
            'required_postgresql_version': '17.11',
            'runtime_verified': False,
            'financial_execution_authorized': False,
            'funded_cases_executed': [],
            'source_binding_pending': list(self._manifest['unresolved_legacy_binding_functions']),
        }
