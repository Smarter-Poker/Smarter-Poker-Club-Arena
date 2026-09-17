import { createPublicKey, verify } from 'node:crypto';
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import type { CorrectiveReviewAuthority, CorrectiveAuthorityEnvelope } from './contract.js';

const verified = new WeakSet<object>();
export const sha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const evidenceDigest = (value: unknown): string => journalHash(horseJournalJson(value));
export const authoritySigningBytes = (authority: CorrectiveReviewAuthority): Buffer =>
  Buffer.from(horseJournalJson(['horse-corrective-review-authority-v1', authority]));

/** The trust-key digest comes from an independent owner configuration, never
 * from the source/reference envelope. A caller cannot qualify its own facts
 * merely by setting a field or computing a matching hash. */
export function verifyCorrectiveAuthority(
  envelope: unknown,
  trustedPublicKeyDigest: string | undefined
): CorrectiveReviewAuthority | null {
  try {
    const e = envelope as CorrectiveAuthorityEnvelope;
    const a = e?.authority;
    if (
      !sha256(trustedPublicKeyDigest) ||
      !a ||
      a.version !== 1 ||
      a.role !== 'accepted_source_and_counterfactual_reference' ||
      !sha256(a.handKey) ||
      typeof a.qualificationId !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(a.qualificationId) ||
      !['synthetic_fixture', 'reviewed_reference'].includes(a.evidenceClass) ||
      (a.commitmentDigest !== null && !sha256(a.commitmentDigest)) ||
      !Array.isArray(a.referenceDigests) ||
      a.referenceDigests.length > 128 ||
      a.referenceDigests.some((d) => !sha256(d)) ||
      new Set(a.referenceDigests).size !== a.referenceDigests.length ||
      typeof e.publicKeyPem !== 'string' ||
      e.publicKeyPem.length > 2048 ||
      !e.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----') ||
      typeof e.signature !== 'string'
    )
      return null;
    const key = createPublicKey(e.publicKeyPem);
    const der = key.export({ type: 'spki', format: 'der' });
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      journalHash(der.toString('base64')) !== trustedPublicKeyDigest
    )
      return null;
    const signature = Buffer.from(e.signature, 'base64');
    if (
      signature.length !== 64 ||
      signature.toString('base64') !== e.signature ||
      !verify(null, authoritySigningBytes(a), key, signature)
    )
      return null;
    const result = JSON.parse(horseJournalJson(a)) as CorrectiveReviewAuthority;
    Object.freeze(result.referenceDigests);
    Object.freeze(result);
    verified.add(result);
    return result;
  } catch {
    return null;
  }
}

export function isVerifiedCorrectiveAuthority(value: unknown): value is CorrectiveReviewAuthority {
  return !!value && typeof value === 'object' && verified.has(value);
}
