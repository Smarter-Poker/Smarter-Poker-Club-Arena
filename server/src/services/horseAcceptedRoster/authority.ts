/** PREPARED, UNEXECUTED separate roster-source authority domain. No signer,
 * configured production key or qualified producer is provided in this packet. */
import { createPublicKey, verify } from 'node:crypto';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import { digest, sha, freeze } from './schema.js';
import type { UnknownObject, RosterSourceAuthority, RosterSourceTrust } from './contract.js';
const verified = new WeakSet<object>();
export const rosterAuthoritySigningBytes = (a: unknown): Buffer =>
  Buffer.from(horseJournalJson(['horse-accepted-roster-source-v1', a]));
const exact = (v: unknown, keys: readonly string[]): v is UnknownObject =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join('|') === [...keys].sort().join('|');
/** trust is an independent owner configuration, never copied from the envelope,
 * raw-row file, profile data, roster capsule, or a derived source/hash field. */
export function verifyRosterSourceAuthority(
  envelope: unknown,
  trust: RosterSourceTrust | undefined,
  exported: unknown,
  handKey: string
): RosterSourceAuthority | null {
  try {
    if (
      !trust ||
      !sha(trust.publicKeyDigest) ||
      !sha(trust.producerSourceDigest) ||
      !exact(envelope, ['authority', 'publicKeyPem', 'signature'])
    )
      return null;
    const a = envelope.authority;
    if (
      !exact(a, [
        'version',
        'role',
        'handKey',
        'qualificationId',
        'evidenceClass',
        'producerSourceDigest',
        'exportDigest',
      ]) ||
      a.version !== 1 ||
      a.role !== 'accepted_roster_source' ||
      !sha(a.handKey) ||
      a.handKey !== handKey ||
      typeof a.qualificationId !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(a.qualificationId) ||
      (a.evidenceClass !== 'synthetic_fixture' && a.evidenceClass !== 'reviewed_source') ||
      (a.evidenceClass === 'synthetic_fixture' && trust.allowSynthetic !== true) ||
      a.producerSourceDigest !== trust.producerSourceDigest ||
      !sha(a.exportDigest) ||
      a.exportDigest !== digest(exported) ||
      typeof envelope.publicKeyPem !== 'string' ||
      envelope.publicKeyPem.length > 2048 ||
      !envelope.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----') ||
      typeof envelope.signature !== 'string' ||
      envelope.signature.length !== 88
    )
      return null;
    const key = createPublicKey(envelope.publicKeyPem);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      journalHash(key.export({ type: 'spki', format: 'der' }).toString('base64')) !==
        trust.publicKeyDigest
    )
      return null;
    const signature = Buffer.from(envelope.signature, 'base64');
    if (
      signature.length !== 64 ||
      signature.toString('base64') !== envelope.signature ||
      !verify(null, rosterAuthoritySigningBytes(a), key, signature)
    )
      return null;
    const result = freeze(JSON.parse(horseJournalJson(a)) as RosterSourceAuthority);
    verified.add(result);
    return result;
  } catch {
    return null;
  }
}
export const isVerifiedRosterAuthority = (authority: unknown): authority is RosterSourceAuthority =>
  !!authority && typeof authority === 'object' && verified.has(authority);
