import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  statfsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gatewayMachineIdSha256 } from './private-record-gateway-host-identity.mjs';

const MAX_CONFIG_BYTES = 1024 * 1024;
const CADDY = '/etc/caddy/Caddyfile';
const MACHINE = '/etc/machine-id';
const MEMORY = '/proc/meminfo';
const PREREQUISITES = Object.freeze([
  '/usr/local/libexec/ca-private-record-gateway-activate',
  '/usr/local/lib/ca-private-record-gateway/private-record-gateway-activate.mjs',
  '/usr/local/lib/ca-private-record-gateway/private-record-gateway-artifact.mjs',
  '/usr/local/lib/ca-private-record-gateway/private-record-gateway-boot.mjs',
  '/usr/local/lib/ca-private-record-gateway/private-record-gateway-host-identity.mjs',
  '/etc/club-arena/private-record-gateway.env',
  '/etc/club-arena/private-record-gateway-host.json',
  '/etc/club-arena/github-actions-trusted-root.jsonl',
  '/etc/systemd/system/ca-private-record-gateway@.service',
  '/etc/systemd/system/ca-private-record-gateway-boot.service',
  '/etc/tmpfiles.d/ca-private-record-gateway.conf',
  '/etc/sudoers.d/ca-private-record-gateway',
  '/srv/ca-private-record-gateway',
  '/srv/ca-private-record-gateway/incoming',
  '/srv/ca-private-record-gateway/releases',
  '/srv/ca-private-record-gateway/active-release.json',
  '/srv/ca-private-record-gateway/bootstrap.lock',
  '/run/ca-private-record-gateway',
  '/run/ca-private-record-gateway/active.sock',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
class InspectionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function refuse(code) {
  throw new InspectionError(code);
}
function reviewedPreimage(encoded) {
  if (
    typeof encoded !== 'string' ||
    !encoded ||
    encoded.length > Math.ceil(MAX_CONFIG_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    refuse('INVALID_REVIEWED_PREIMAGE');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_CONFIG_BYTES || bytes.toString('base64') !== encoded)
    refuse('INVALID_REVIEWED_PREIMAGE');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('INVALID_REVIEWED_PREIMAGE');
  }
  if (bytes.includes(0)) refuse('INVALID_REVIEWED_PREIMAGE');
  return bytes;
}
function protectedBytes(io, path, maximum) {
  const value = io.readProtectedFile(path, maximum);
  if (!Buffer.isBuffer(value) || value.length > maximum) refuse('INVALID_FILE_READBACK');
  return value;
}
function prerequisite(io, path) {
  try {
    const value = io.metadata(path);
    if (
      !value ||
      !['file', 'directory', 'symlink', 'socket', 'other'].includes(value.kind) ||
      !Number.isSafeInteger(value.uid) ||
      !Number.isSafeInteger(value.mode)
    )
      return { path, state: 'unknown', error: 'INVALID_METADATA' };
    return {
      path,
      state: 'present',
      kind: value.kind,
      rootOwned: value.uid === 0,
      mode: (value.mode & 0o777).toString(8).padStart(3, '0'),
      groupOrWorldWritable: (value.mode & 0o022) !== 0,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, state: 'absent' };
    return { path, state: 'unknown', error: 'METADATA_UNAVAILABLE' };
  }
}
/** Pure read-only inspection using only fixed paths. Never returns file contents. */
export function inspectHost(preimageBase64, io) {
  const preimage = reviewedPreimage(preimageBase64);
  const caddy = protectedBytes(io, CADDY, MAX_CONFIG_BYTES);
  if (!caddy.length) refuse('EMPTY_CADDY_CONFIGURATION');
  let occurrences = 0;
  for (
    let position = caddy.indexOf(preimage);
    position !== -1;
    position = caddy.indexOf(preimage, position + 1)
  )
    occurrences++;
  let machineIdSha256;
  try {
    machineIdSha256 = gatewayMachineIdSha256(protectedBytes(io, MACHINE, 128));
  } catch {
    refuse('MACHINE_IDENTITY_UNAVAILABLE');
  }
  let memory;
  try {
    const text = protectedBytes(io, MEMORY, 64 * 1024).toString('utf8');
    const match = text.match(/^MemAvailable:\s+(\d+) kB$/m);
    const available = match ? Number(match[1]) * 1024 : NaN;
    memory =
      Number.isSafeInteger(available) && available >= 0
        ? { state: 'observed', availableBytes: available }
        : { state: 'unknown', error: 'MEMORY_UNAVAILABLE' };
  } catch {
    memory = { state: 'unknown', error: 'MEMORY_UNAVAILABLE' };
  }
  let disk;
  try {
    const available = io.availableDiskBytes();
    disk =
      Number.isSafeInteger(available) && available >= 0
        ? { state: 'observed', availableBytes: available }
        : { state: 'unknown', error: 'DISK_UNAVAILABLE' };
  } catch {
    disk = { state: 'unknown', error: 'DISK_UNAVAILABLE' };
  }
  const version = io.nodeVersion();
  if (
    typeof version !== 'string' ||
    version.length > 64 ||
    !/^v?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.]+)?$/.test(version)
  )
    refuse('NODE_VERSION_UNAVAILABLE');
  const prerequisites = PREREQUISITES.map((path) => prerequisite(io, path));
  return {
    schema: 1,
    component: 'private-record-host-inspection',
    status:
      memory.state === 'unknown' ||
      disk.state === 'unknown' ||
      prerequisites.some((entry) => entry.state === 'unknown')
        ? 'partial'
        : 'observed',
    caddy: {
      bytes: caddy.length,
      sha256: hash(caddy),
      reviewedPreimageBytes: preimage.length,
      reviewedPreimageSha256: hash(preimage),
      exactPreimageOccurrences: occurrences,
    },
    machineIdSha256,
    nodeVersion: version,
    capacity: { memory, disk },
    prerequisites,
    limitation:
      'Read-only metadata, not bootstrap, activation, route correctness or playability certification.',
  };
}
function readProtectedFile(path, maximum) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022 || stat.size > maximum)
      refuse('UNSAFE_OR_OVERSIZED_FIXED_FILE');
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(descriptor, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maximum) refuse('UNSAFE_OR_OVERSIZED_FIXED_FILE');
    return bytes.subarray(0, used);
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    refuse('FIXED_FILE_UNAVAILABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
const fixedIo = {
  readProtectedFile,
  metadata(path) {
    const stat = lstatSync(path);
    return {
      uid: stat.uid,
      mode: stat.mode,
      kind: stat.isSymbolicLink()
        ? 'symlink'
        : stat.isFile()
          ? 'file'
          : stat.isDirectory()
            ? 'directory'
            : stat.isSocket()
              ? 'socket'
              : 'other',
    };
  },
  availableDiskBytes() {
    const stat = statfsSync('/srv');
    return Number(stat.bavail) * Number(stat.bsize);
  },
  nodeVersion: () => process.version,
};
export function runInspectionCli(args, io = fixedIo) {
  try {
    if (!Array.isArray(args) || args.length !== 1) refuse('INVALID_ARGUMENTS');
    const result = inspectHost(args[0], io);
    const output = JSON.stringify(result);
    if (output.length > 16384) refuse('OUTPUT_BOUND_EXCEEDED');
    console.log(output);
    if (result.status !== 'observed') process.exitCode = 2;
  } catch (error) {
    console.log(
      JSON.stringify({
        schema: 1,
        status: 'unavailable',
        error: error instanceof InspectionError ? error.code : 'INSPECTION_UNAVAILABLE',
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runInspectionCli(process.argv.slice(2));
}
