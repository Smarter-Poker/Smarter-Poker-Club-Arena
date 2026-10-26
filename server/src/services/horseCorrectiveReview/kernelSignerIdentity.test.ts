import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { journalHash } from '../horseDecisionJournal/record.js';
const state = vi.hoisted(() => ({ pin: null as string | null, messages: [] as string[] }));
vi.mock('./kernelIssuerTrust.js', () => ({
  get PHASE14_ISSUER_TRUSTED_PUBLIC_KEY_SHA256() {
    return state.pin;
  },
  PHASE14_ISSUER_SECRET_NAME: 'HORSE_PHASE14_QUALIFICATION_SIGNING_KEY',
}));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    sign: (algorithm: null, data: Buffer, key: Parameters<typeof actual.sign>[2]) => {
      state.messages.push(data.toString('utf8'));
      return actual.sign(algorithm, data, key);
    },
  };
});
import {
  probeCorrectiveKernelSignerIdentity,
  CORRECTIVE_SIGNER_IDENTITY_MESSAGE,
} from './kernelSignerIdentity.js';
let environment: Record<string, string>;
beforeEach(() => {
  state.messages = [];
  const pair = generateKeyPairSync('ed25519');
  state.pin = journalHash(
    pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  );
  environment = {
    HORSE_PHASE14_QUALIFICATION_SIGNING_KEY: pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
});
describe('purpose signer credential identity probe', () => {
  it('signs and verifies only the fixed non-approval domain and exposes public identity with false qualification flags', () => {
    expect(
      probeCorrectiveKernelSignerIdentity({ ...environment, challenge: 'caller-controlled' })
    ).toEqual({
      status: 'signer_identity_verified',
      identityVerified: true,
      publicKeySha256: state.pin,
      qualified: false,
      activationAllowed: false,
    });
    expect(state.messages).toEqual([CORRECTIVE_SIGNER_IDENTITY_MESSAGE]);
    expect(CORRECTIVE_SIGNER_IDENTITY_MESSAGE).toBe('horse-corrective-signer-identity-v1');
    expect(state.messages[0]).not.toContain('kernel-approval');
  });
  it('refuses an unpinned or substituted key before signing any message', () => {
    state.pin = null;
    expect(probeCorrectiveKernelSignerIdentity(environment)).toMatchObject({
      status: 'unavailable',
      identityVerified: false,
    });
    state.pin = '0'.repeat(64);
    expect(probeCorrectiveKernelSignerIdentity(environment)).toMatchObject({
      reason: 'signer_public_pin_mismatch',
    });
    expect(state.messages).toEqual([]);
  });
  it('keeps absent or malformed credentials unavailable without exposing values', () => {
    expect(probeCorrectiveKernelSignerIdentity({})).toMatchObject({
      status: 'unavailable',
      reason: 'signer_purpose_key_unavailable',
    });
    const result = probeCorrectiveKernelSignerIdentity({
      HORSE_PHASE14_QUALIFICATION_SIGNING_KEY: 'private-invalid-key',
    });
    expect(result).toMatchObject({
      status: 'unavailable',
      qualified: false,
      activationAllowed: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-invalid-key');
    expect(state.messages).toEqual([]);
  });
});
