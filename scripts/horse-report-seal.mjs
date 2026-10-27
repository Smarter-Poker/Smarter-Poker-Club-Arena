import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

function recipient(key) {
  const publicKey = createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 3072)
    throw Error('A report RSA recipient of at least 3072 bits is required');
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return { publicKey, fingerprint };
}

function header(sourceRevision, fingerprint) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? '') || !/^[a-f0-9]{64}$/.test(fingerprint ?? ''))
    throw Error('Invalid sealed report identity');
  return {
    version: 1,
    kind: 'horse-human-results',
    source_revision: sourceRevision,
    recipient_sha256: fingerprint,
  };
}

/** Public Actions artifacts may contain this ciphertext, never report rows. */
export function sealHorseReport(report, publicKeyPEM) {
  const { publicKey, fingerprint } = recipient(publicKeyPEM);
  if (report?.status !== 'observed') throw Error('An observed report is required');
  const identity = header(report.source_revision, fingerprint);
  const plaintext = Buffer.from(JSON.stringify(report) + '\n');
  if (plaintext.length > 8 * 1024 * 1024) throw Error('Report exceeds its output bound');
  const key = randomBytes(32),
    nonce = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(identity)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ...identity,
      algorithm: 'RSA-OAEP-SHA256+AES-256-GCM',
      wrapped_key: publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        key
      ).toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}
