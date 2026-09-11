#!/usr/bin/env python3
"""Read an existing static artifact under the existing publisher lock. No writes."""
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import time


def need(value, message):
    if not value:
        raise RuntimeError(message)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def secure(info, kind):
    need(kind(info.st_mode) and info.st_uid in (0, os.geteuid()) and
         info.st_mode & 0o022 == 0, 'unsafe artifact ownership/type/mode')


def read_artifact(expected_sha, root='/srv/club-arena', lock_timeout=45):
    need(re.fullmatch('[0-9a-f]{40}', expected_sha) is not None, 'full source SHA required')
    # Every ancestor is real and not writable by another identity. Descendants
    # are opened relative to pinned directory fds with O_NOFOLLOW.
    cursor = os.path.abspath(root)
    while cursor != '/':
        secure(os.lstat(cursor), stat.S_ISDIR)
        cursor = os.path.dirname(cursor)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    root_info = os.fstat(root_fd)
    secure(root_info, stat.S_ISDIR)
    lock_fd = None
    try:
        lock_fd = os.open('.publish.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
        lock_info = os.fstat(lock_fd)
        need(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == os.geteuid() and
             lock_info.st_gid == os.getegid() and stat.S_IMODE(lock_info.st_mode) in (0o600, 0o644, 0o664),
             'unsafe existing publisher lock')
        deadline = time.monotonic() + lock_timeout
        while True:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                need(time.monotonic() < deadline, 'publisher lock timeout')
                time.sleep(0.05)
        need(identity(os.stat('.publish.lock', dir_fd=root_fd, follow_symlinks=False))[:5] == identity(lock_info)[:5],
             'publisher lock changed')
        pointer = os.stat('current', dir_fd=root_fd, follow_symlinks=False)
        need(stat.S_ISLNK(pointer.st_mode) and pointer.st_uid in (0, os.geteuid()), 'unsafe current pointer')
        expected_path = root + '/releases/' + expected_sha
        need(os.readlink('current', dir_fd=root_fd) == expected_path, 'current source changed')
        releases_fd = os.open('releases', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        try:
            releases_info = os.fstat(releases_fd)
            secure(releases_info, stat.S_ISDIR)
            release_fd = os.open(expected_sha, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=releases_fd)
            try:
                release_info = os.fstat(release_fd)
                secure(release_info, stat.S_ISDIR)
                documents, entries, total = {}, [], [0]

                def read_file(directory, name, relative, collect=False):
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                    try:
                        before = os.fstat(fd)
                        secure(before, stat.S_ISREG)
                        need(before.st_size <= 1024 ** 3, 'oversized artifact file')
                        digest, chunks = hashlib.sha256(), []
                        while True:
                            chunk = os.read(fd, 1024 * 1024)
                            if not chunk:
                                break
                            digest.update(chunk)
                            total[0] += len(chunk)
                            need(total[0] <= 10 * 1024 ** 3, 'oversized artifact')
                            if collect:
                                chunks.append(chunk)
                                need(sum(map(len, chunks)) <= 8 * 1024 * 1024, 'oversized metadata')
                        need(identity(before) == identity(os.fstat(fd)) ==
                             identity(os.stat(name, dir_fd=directory, follow_symlinks=False)), 'artifact file changed')
                        return digest.hexdigest(), b''.join(chunks)
                    finally:
                        os.close(fd)

                def walk(directory, prefix=''):
                    before = os.fstat(directory)
                    secure(before, stat.S_ISDIR)
                    names = sorted(os.listdir(directory))
                    for name in names:
                        need(not any(c in name for c in '\n\r\\'), 'ambiguous manifest filename')
                        relative = prefix + name
                        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                            try:
                                need(identity(info) == identity(os.fstat(child)), 'artifact directory changed')
                                walk(child, relative + '/')
                                need(identity(info) == identity(os.stat(name, dir_fd=directory, follow_symlinks=False)), 'artifact directory replaced')
                            finally:
                                os.close(child)
                        else:
                            secure(info, stat.S_ISREG)
                            if relative == '.release-manifest.sha256':
                                continue
                            digest, data = read_file(directory, name, relative, relative in ('build-info.json', 'ca-provenance.json'))
                            entries.append((relative, digest))
                            need(len(entries) <= 100000, 'too many artifact files')
                            if relative in ('build-info.json', 'ca-provenance.json'):
                                documents[relative] = (digest, json.loads(data))
                    need(names == sorted(os.listdir(directory)) and identity(before) == identity(os.fstat(directory)), 'artifact directory changed')

                manifest_digest, manifest = read_file(release_fd, '.release-manifest.sha256', '', True)
                walk(release_fd)
                actual = ''.join(digest + '  ./' + name + '\n' for name, digest in sorted(entries, key=lambda item: item[0].encode())).encode()
                need(manifest == actual and len(entries) > 2, 'immutable manifest does not exactly cover artifact')
                need(read_file(release_fd, '.release-manifest.sha256', '', True)[0] == manifest_digest, 'manifest changed')
                build_hash, build = documents['build-info.json']
                provenance_hash, provenance = documents['ca-provenance.json']
                need(type(build) is dict and type(provenance) is dict, 'invalid provenance documents')
                need(build.get('ca_sha') == expected_sha and build.get('built_by') == 'publish-club-arena.yml' and
                     re.fullmatch('[0-9]+', str(build.get('run_id', ''))) is not None and
                     type(build.get('run_id')) is str and
                     re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', str(build.get('built_at', ''))) is not None,
                     'invalid build identity')
                need(provenance.get('commit') == expected_sha and provenance.get('builtBy') == 'github-actions' and
                     provenance.get('dirty') is False and provenance.get('historyComplete') is True and
                     type(provenance.get('aheadMain')) is int and provenance['aheadMain'] == 0 and
                     type(provenance.get('behindMain')) is int and provenance['behindMain'] == 0 and
                     provenance.get('ciRun') == 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/' + build['run_id'],
                     'invalid original publisher provenance')
                need(identity(release_info) == identity(os.fstat(release_fd)) ==
                     identity(os.stat(expected_sha, dir_fd=releases_fd, follow_symlinks=False)), 'release directory changed')
                need(identity(pointer) == identity(os.stat('current', dir_fd=root_fd, follow_symlinks=False)) and
                     os.readlink('current', dir_fd=root_fd) == expected_path, 'current pointer changed')
                need(identity(os.lstat(root))[:5] == identity(root_info)[:5], 'origin root replaced')
                need(identity(os.stat('releases', dir_fd=root_fd, follow_symlinks=False))[:5] ==
                     identity(releases_info)[:5], 'releases directory replaced')
                final_lock = os.stat('.publish.lock', dir_fd=root_fd, follow_symlinks=False)
                need(identity(final_lock)[:5] == identity(lock_info)[:5], 'publisher lock replaced')
                return {'schema': 1, 'source_sha': expected_sha, 'manifest_sha256': manifest_digest,
                        'file_count': len(entries), 'build_info_sha256': build_hash,
                        'provenance_sha256': provenance_hash, 'build_info': build, 'provenance': provenance,
                        'lock': {'device': lock_info.st_dev, 'inode': lock_info.st_ino},
                        'release': {'device': release_info.st_dev, 'inode': release_info.st_ino},
                        'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            finally:
                os.close(release_fd)
        finally:
            os.close(releases_fd)
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        os.close(root_fd)


if __name__ == '__main__':
    need(len(sys.argv) == 2, 'usage: read-native-frontend.py <exact-source-sha>')
    print(json.dumps(read_artifact(sys.argv[1]), sort_keys=True))
