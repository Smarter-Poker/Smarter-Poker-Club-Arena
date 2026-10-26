/** Actual credential verification only. This fixed signing domain cannot issue
 * a corrective approval, accept a caller challenge or produce S4 authority. */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { journalHash } from '../horseDecisionJournal/record.js';
import {
  PHASE14_ISSUER_SECRET_NAME,
  PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256,
} from './kernelIssuerTrust.js';
export const CORRECTIVE_SIGNER_IDENTITY_MESSAGE = 'horse-corrective-signer-identity-v1';
export type CorrectiveSignerIdentityResult =
  | {
      status: 'signer_identity_verified';
      identityVerified: true;
      publicKeySha256: string;
      qualified: false;
      activationAllowed: false;
    }
  | {
      status: 'unavailable';
      identityVerified: false;
      reason: string;
      qualified: false;
      activationAllowed: false;
    };
export function probeCorrectiveKernelSignerIdentity(
  environment: Readonly<Record<string, string | undefined>>
): CorrectiveSignerIdentityResult {
  const no = (reason: string): CorrectiveSignerIdentityResult => ({
    status: 'unavailable',
    identityVerified: false,
    reason,
    qualified: false,
    activationAllowed: false,
  });
  try {
    const expected = PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256;
    if (!expected || !/^[a-f0-9]{64}$/.test(expected))
      return no('signer_public_trust_unconfigured');
    const raw = environment[PHASE14_ISSUER_SECRET_NAME];
    if (!raw || raw.length > 8192 || !raw.startsWith('-----BEGIN PRIVATE KEY-----'))
      return no('signer_purpose_key_unavailable');
    const bytes = Buffer.from(raw);
    let key;
    try {
      key = createPrivateKey({ key: bytes, type: 'pkcs8', format: 'pem' });
    } finally {
      bytes.fill(0);
    }
    if (key.asymmetricKeyType !== 'ed25519') return no('signer_purpose_key_refused');
    const publicKey = createPublicKey(key),
      publicKeySha256 = journalHash(
        publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
      );
    if (publicKeySha256 !== expected) return no('signer_public_pin_mismatch');
    // Literal protocol bytes only. No environment value or caller data can
    // become an alternative message or an approval-domain signing oracle.
    const message = Buffer.from(CORRECTIVE_SIGNER_IDENTITY_MESSAGE, 'utf8');
    const signature = sign(null, message, key);
    if (signature.length !== 64 || !verify(null, message, publicKey, signature))
      return no('signer_identity_verification_failed');
    return {
      status: 'signer_identity_verified',
      identityVerified: true,
      publicKeySha256,
      qualified: false,
      activationAllowed: false,
    };
  } catch {
    return no('signer_identity_unavailable');
  }
}
