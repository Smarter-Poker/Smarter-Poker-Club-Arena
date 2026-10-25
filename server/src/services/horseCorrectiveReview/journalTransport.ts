/** Private qualification acquisition through the configured pinned engine SSH
 * identity. Neither operator JSON nor an uploaded artifact authenticates a journal. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  validateHorseJournalRecord,
  type HorseJournalRecord,
} from '../horseDecisionJournal/record.js';
import {
  currentHorseDecisionRuntime,
  type HorseDecisionRuntimeIdentity,
} from '../../engine/horseDecision/replayState.js';
import { readHorseJournalHandRecords } from '../horseDecisionJournal/review.js';
import { evidenceDigest } from './authority.js';

export const JOURNAL_EXPORT_MAX_KEYS = 128;
export const JOURNAL_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const verified = new WeakSet<object>();
export const PRIVATE_JOURNAL_REMOTE_COMMAND = [
  'set -eu',
  "horse_journal_container=$(docker inspect --format '{{.Id}}' club-arena-engine)",
  'case "$horse_journal_container" in \'\'|*[!0-9a-f]*) exit 3;; esac',
  '[ "${#horse_journal_container}" -eq 64 ]',
  'horse_journal_image=$(docker inspect --format \'{{.Image}}\' "$horse_journal_container")',
  'docker image inspect --format \'{{index .Config.Labels "org.opencontainers.image.revision"}}\' "$horse_journal_image"',
  'docker exec -i "$horse_journal_container" node dist/scripts/horsePrivateJournalExport.js',
].join('; ');
export interface CanonicalJournalExport {
  version: 1;
  status: 'canonical_journal_export';
  sourceRelease: string;
  runtime: HorseDecisionRuntimeIdentity;
  recordsByHand: readonly { handKey: string; records: readonly HorseJournalRecord[] }[];
}
export interface AuthenticatedHorseJournalBatch extends Omit<CanonicalJournalExport, 'status'> {
  status: 'authenticated_journal_batch';
  batchDigest: string;
  qualified: false;
  activationAllowed: false;
}
export type AuthenticatedHorseJournalResult =
  | Readonly<AuthenticatedHorseJournalBatch>
  | {
      status: 'unavailable';
      reason: string;
      qualified: false;
      activationAllowed: false;
    };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function keysAreValid(keys: readonly string[]): boolean {
  // Empty keys are an explicit metadata-only probe. They establish no cases or
  // population coverage, and do not touch the journal reader.
  return (
    Array.isArray(keys) &&
    keys.length <= JOURNAL_EXPORT_MAX_KEYS &&
    keys.every((k) => typeof k === 'string' && HASH.test(k)) &&
    new Set(keys).size === keys.length
  );
}
/** Used only by the compiled engine export command. Directory and image source
 * come from the configured running container; no caller path is accepted. */
export function exportCanonicalHorseJournalBatch(
  handKeys: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  readHand: typeof readHorseJournalHandRecords = readHorseJournalHandRecords
): CanonicalJournalExport | null {
  try {
    const directory = environment.HORSE_DECISION_JOURNAL_DIR;
    const sourceRelease = environment.GIT_COMMIT_SHA;
    if (
      !keysAreValid(handKeys) ||
      !directory ||
      !isAbsolute(directory) ||
      !sourceRelease ||
      !SHA.test(sourceRelease)
    )
      return null;
    const started = performance.now();
    const recordsByHand: { handKey: string; records: readonly HorseJournalRecord[] }[] = [];
    let size = 0;
    for (const handKey of handKeys) {
      const records = readHand(directory, handKey);
      if (records.length > 256 || performance.now() - started > 25000) return null;
      for (const record of records) {
        validateHorseJournalRecord(record);
        if (record.handKey !== handKey || record.sourceRelease !== sourceRelease) return null;
        size += Buffer.byteLength(JSON.stringify(record));
        if (size > JOURNAL_EXPORT_MAX_BYTES - 65536) return null;
      }
      recordsByHand.push({ handKey, records });
    }
    return {
      version: 1,
      status: 'canonical_journal_export',
      sourceRelease,
      runtime: currentHorseDecisionRuntime(),
      recordsByHand,
    };
  } catch {
    return null;
  }
}
type Execute = (args: readonly string[], input: string) => Promise<string>;
function execute(args: readonly string[], input: string): Promise<string> {
  // No signing key, DB credential, Node preload or personal SSH configuration is
  // inherited by this child. SSH reads its configured purpose identity file.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      [...args],
      { encoding: 'utf8', timeout: 45000, maxBuffer: JOURNAL_EXPORT_MAX_BYTES, env },
      (error, stdout) =>
        error ? reject(new Error('journal_transport_unavailable')) : resolve(stdout)
    );
    if (!child.stdin) {
      child.kill();
      reject(new Error('journal_transport_unavailable'));
      return;
    }
    child.stdin.on('error', () => reject(new Error('journal_transport_unavailable')));
    child.stdin.end(input);
  });
}
function ownedFile(path: string | undefined, secret: boolean): path is string {
  if (!path || !isAbsolute(path)) return false;
  const stat = lstatSync(path);
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.uid === process.getuid?.() &&
    (stat.mode & (secret ? 0o077 : 0o022)) === 0
  );
}
/** All configuration is captured once. Test execution is an in-process seam;
 * the operator protocol cannot provide a command, key, result or function. */
export function createAuthenticatedHorseJournalReader(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: { execute?: Execute } = {}
): (handKeys: readonly string[]) => Promise<AuthenticatedHorseJournalResult> {
  let args: string[] | null = null;
  try {
    const host = environment.HORSE_REVIEW_SSH_HOST;
    const key = environment.HORSE_REVIEW_SSH_KEY_PATH;
    const known = environment.HORSE_REVIEW_SSH_KNOWN_HOSTS_PATH;
    if (
      !host ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host) ||
      !ownedFile(key, true) ||
      !ownedFile(known, false)
    )
      throw Error();
    args = [
      '-F',
      '/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${known}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'VerifyHostKeyDNS=no',
      '-o',
      'UpdateHostKeys=no',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'ConnectTimeout=10',
      '-i',
      key,
      `root@${host}`,
      PRIVATE_JOURNAL_REMOTE_COMMAND,
    ];
  } catch {
    /* Fixed configuration refusal; no credential contents are read. */
  }
  const run = dependencies.execute ?? execute;
  let busy = false;
  return async (handKeys) => {
    const no = (reason: string): AuthenticatedHorseJournalResult => ({
      status: 'unavailable',
      reason,
      qualified: false,
      activationAllowed: false,
    });
    if (!keysAreValid(handKeys)) return no('journal_keys_invalid');
    if (!args) return no('journal_transport_configuration_unavailable');
    if (busy) return no('journal_transport_busy');
    const requested = [...handKeys];
    busy = true;
    try {
      const stdout = await run(args, JSON.stringify({ version: 1, handKeys: requested }) + '\n');
      if (Buffer.byteLength(stdout) > JOURNAL_EXPORT_MAX_BYTES) return no('journal_export_bounds');
      const boundary = stdout.indexOf('\n');
      const imageSource = stdout.slice(0, boundary).trim();
      if (boundary < 0 || !SHA.test(imageSource)) return no('journal_image_identity_unknown');
      const raw: unknown = JSON.parse(stdout.slice(boundary + 1));
      if (
        !object(raw) ||
        Object.keys(raw).sort().join(',') !==
          'recordsByHand,runtime,sourceRelease,status,version' ||
        raw.version !== 1 ||
        raw.status !== 'canonical_journal_export' ||
        raw.sourceRelease !== imageSource ||
        !object(raw.runtime) ||
        Object.keys(raw.runtime).sort().join(',') !== 'arch,node,v8' ||
        typeof raw.runtime.node !== 'string' ||
        !/^v\d+\.\d+\.\d+$/.test(raw.runtime.node) ||
        typeof raw.runtime.v8 !== 'string' ||
        raw.runtime.v8.length > 128 ||
        !/^[a-zA-Z0-9_.-]+$/.test(raw.runtime.v8) ||
        typeof raw.runtime.arch !== 'string' ||
        !['x64', 'arm64'].includes(raw.runtime.arch) ||
        !Array.isArray(raw.recordsByHand) ||
        raw.recordsByHand.length !== requested.length
      )
        return no('journal_export_refused');
      const byHand = raw.recordsByHand as unknown[];
      for (let i = 0; i < byHand.length; i++) {
        const entry = byHand[i];
        if (
          !object(entry) ||
          Object.keys(entry).sort().join(',') !== 'handKey,records' ||
          entry.handKey !== requested[i] ||
          !Array.isArray(entry.records) ||
          entry.records.length > 256
        )
          return no('journal_export_refused');
        for (const record of entry.records) {
          validateHorseJournalRecord(record);
          if (record.handKey !== entry.handKey || record.sourceRelease !== imageSource)
            return no('journal_export_refused');
        }
      }
      // raw is already a detached JSON parse with a bounded wire size. A
      // complete page is not one 512 KiB journal record.
      const body = raw as unknown as CanonicalJournalExport;
      const commitment = createHash('sha256')
        .update('horse-canonical-private-journal-batch-v1\0')
        .update(evidenceDigest({ sourceRelease: body.sourceRelease, runtime: body.runtime }));
      for (const entry of body.recordsByHand)
        commitment.update('\n').update(
          evidenceDigest({
            handKey: entry.handKey,
            recordDigests: entry.records.map((record) => record.sha256),
          })
        );
      for (const entry of body.recordsByHand) {
        for (const record of entry.records) Object.freeze(record);
        Object.freeze(entry.records);
        Object.freeze(entry);
      }
      Object.freeze(body.recordsByHand);
      Object.freeze(body.runtime);
      const result = Object.freeze({
        ...body,
        status: 'authenticated_journal_batch' as const,
        batchDigest: commitment.digest('hex'),
        qualified: false as const,
        activationAllowed: false as const,
      });
      verified.add(result);
      return result;
    } catch {
      return no('journal_transport_unavailable');
    } finally {
      busy = false;
    }
  };
}
export function isAuthenticatedHorseJournalBatch(
  value: unknown
): value is Readonly<AuthenticatedHorseJournalBatch> {
  return !!value && typeof value === 'object' && verified.has(value);
}
