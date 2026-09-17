import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CORRECTIVE_LIMITS } from './contract.js';

const owned = (s: Stats) =>
  (s.mode & 0o077) === 0 && (!process.getuid || s.uid === process.getuid());
export function readPrivateCorrectiveJson(path: string, maximumBytes: number): unknown {
  if (!isAbsolute(path) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw Error('private_input_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || !owned(s) || s.size < 1 || s.size > maximumBytes)
      throw Error('private_input_invalid');
    const bytes = Buffer.alloc(s.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = readSync(fd, bytes, count, bytes.length - count, null);
      if (next === 0) break;
      count += next;
    }
    if (count !== s.size || fstatSync(fd).size !== s.size) throw Error('private_input_changed');
    return JSON.parse(bytes.subarray(0, count).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/** Publish only a complete fsynced private artifact; never overwrite a prior
 * finding, follow an output symlink or write into a shared directory. */
export function writePrivateCorrectiveResult(path: string, json: string): void {
  if (!isAbsolute(path) || Buffer.byteLength(json) > CORRECTIVE_LIMITS.outputBytes)
    throw Error('private_output_invalid');
  const parent = dirname(path),
    s = lstatSync(parent);
  if (!s.isDirectory() || s.isSymbolicLink() || !owned(s)) throw Error('private_output_invalid');
  const canonical = realpathSync(parent);
  if (canonical !== parent) throw Error('private_output_parent_alias');
  const temporary = join(canonical, `.horse-review-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(fd, json);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, path);
    unlinkSync(temporary);
    const dir = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* The completed file has already been published or no temp was created. */
    }
  }
}
