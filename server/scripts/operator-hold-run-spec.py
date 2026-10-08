#!/usr/bin/env python3
"""Fixed, read-only original-generation or rollback-preload run-spec proof."""
import json
import os
from pathlib import Path
import stat
import sys

SOURCE = 'aab0f1e59275489204ea2a141b66f41902177258'
ROOT = Path('/var/lib/club-arena/operator-hold')
MARKER = ROOT.parent / 'operator-hold-required'
COMMAND = ['node', '--import', '/run/club-arena/operator-hold/operator-hold-rollback-bootstrap.mjs', 'dist/index.js']

def private_file(path):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600:
        raise ValueError('private original file invalid')
    return path.read_bytes()

def qualify(source, runtime, root=ROOT, marker=MARKER):
    relevant = source == SOURCE and (os.path.lexists(root) or os.path.lexists(marker))
    if not relevant:
        return 'pre_handoff'
    intent = json.loads(private_file(marker))
    st = root.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError('original bundle invalid')
    handoff = json.loads(private_file(root / 'handoff.json'))
    fence = json.loads(private_file(root / 'restart-fence.json'))
    if fence.get('kind') != 'operator_restart_fence_v1' or fence.get('handoffId') != intent['handoffId'] or fence.get('container') != intent['container'] or fence.get('source') != intent['source']:
        raise ValueError('original restart fence identity mismatch')
    profile = json.loads(private_file(root / 'operator-hold-predecessor-profile.json'))
    for name in ['operator-hold-checkpoint-guard.mjs', 'operator-hold-rollback-bootstrap.mjs']:
        private_file(root / name)
    if private_file(root / 'intent').decode() != intent['handoffId'] + '\n':
        raise ValueError('original intent invalid')
    if intent['source'] != SOURCE or handoff['handoffId'] != intent['handoffId'] or handoff['sourceInstance'] != intent['instance'] or handoff['sourceRelease'] != SOURCE or profile['releaseSha'] != SOURCE or profile['imageId'] != runtime['image']:
        raise ValueError('original authority identity mismatch')
    # An interrupted import may leave the unchanged original owner running.
    # Its in-memory authority was captured/fenced, so do not restart it to prove
    # a preload. Every different container generation MUST use the preload.
    if runtime['id'] == intent['container'] and runtime['startedAt'] == intent['startedAt'] and runtime['pid'] == intent['hostPid']:
        if runtime['cmd'] != ['node', 'dist/index.js']:
            raise ValueError('original process command changed')
        return 'original_owner'
    mounts = [m for m in runtime['mounts'] if m.get('Destination') == '/run/club-arena/operator-hold']
    if runtime['cmd'] != COMMAND or len(mounts) != 1 or mounts[0].get('Source') != str(ROOT) or mounts[0].get('Type') != 'bind' or mounts[0].get('RW') is not False:
        raise ValueError('reconstructed predecessor lacks exact readonly preload')
    return 'rollback_preload'

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('exact source argument required')
        result = qualify(sys.argv[1], json.load(sys.stdin))
    except (OSError, ValueError, KeyError, TypeError):
        sys.stderr.write('operator hold run specification refused\n')
        raise SystemExit(1)
    print('operator_hold_run_spec:' + result)
