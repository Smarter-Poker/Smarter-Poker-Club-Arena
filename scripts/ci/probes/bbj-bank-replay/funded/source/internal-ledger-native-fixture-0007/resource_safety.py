"""Owned fixture resource controls. Inert until the reviewed runner calls them."""
import errno
import json
import os
from pathlib import Path
import shutil

MIB = 1024 * 1024
# Conservative local operational admission bounds, not production policy or a
# guarantee against another process consuming shared disk after the check.
STARTUP_DATA_FREE = 2 * 1024 * MIB
WORKING_HEADROOM = 256 * MIB
EVIDENCE_HEADROOM = 64 * MIB
EMERGENCY_RESERVE = 32 * MIB


class DiskBudgetError(RuntimeError):
    pass


def space_probe(stage, data_path, evidence_path, data_required):
    observations = []
    for kind, p, required in (
        ('data', Path(data_path), data_required),
        ('evidence', Path(evidence_path), EVIDENCE_HEADROOM + EMERGENCY_RESERVE),
    ):
        usage = shutil.disk_usage(p)
        observations.append({'kind': kind, 'path': str(p), 'device': p.stat().st_dev,
                             'available_bytes': usage.free, 'required_bytes': required,
                             'admitted': usage.free >= required})
    return {'stage': stage, 'observations': observations,
            'admitted': all(o['admitted'] for o in observations),
            'qualification': 'Point-in-time admission; external disk consumption remains possible'}


class EvidenceStore:
    """Atomic replacement plus an owned, physically allocated emergency reserve.

    If ordinary evidence writing runs out of space, release only this reserve,
    retry preservation, then raise so no further financial work is admitted.
    Cleanup writes may consume the released space without restarting execution.
    """
    def __init__(self, directory):
        self.directory = Path(directory)
        self.reserve = self.directory / '.emergency-space'
        self.reserve_released = False
        self.space_exhausted = False

    def allocate_reserve(self):
        with self.reserve.open('xb') as f:
            block = b'\0' * MIB
            for _ in range(EMERGENCY_RESERVE // MIB):
                f.write(block)
            f.flush()
            os.fsync(f.fileno())

    def release_reserve(self):
        if self.reserve.exists():
            self.reserve.unlink()
        self.reserve_released = True

    def write(self, path, obj, emergency=False):
        path = Path(path)
        if path.parent.resolve() != self.directory.resolve():
            raise ValueError('Evidence writer is limited to this owned run directory')
        pending = path.with_name(path.name + '.pending')
        payload = json.dumps(obj, indent=2, default=str) + '\n'

        def attempt():
            with pending.open('w') as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(pending, path)

        try:
            attempt()
        except OSError as exc:
            if exc.errno != errno.ENOSPC:
                raise
            self.space_exhausted = True
            self.release_reserve()
            attempt()
            if not emergency:
                raise DiskBudgetError('Evidence reserve consumed after ENOSPC; execution stopped') from exc
