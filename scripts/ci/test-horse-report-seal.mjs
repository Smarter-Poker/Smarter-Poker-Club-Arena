import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  privateDecrypt,
  createDecipheriv,
  constants,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sealHorseReport } from '../horse-report-seal.mjs';

function recipient(key) {
  const publicKey = createPublicKey(key);
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return { fingerprint };
}
function header(sourceRevision, fingerprint) {
  return {
    version: 1,
    kind: 'horse-human-results',
    source_revision: sourceRevision,
    recipient_sha256: fingerprint,
  };
}

// Test-only independent decryptor. Real owner keys remain in native Keychain.
function unsealHorseReport(envelope, privateKeyPEM) {
  const privateKey = createPrivateKey(privateKeyPEM);
  const { fingerprint } = recipient(privateKey);
  const identity = header(envelope.source_revision, envelope.recipient_sha256);
  if (
    envelope.version !== 1 ||
    envelope.kind !== identity.kind ||
    envelope.algorithm !== 'RSA-OAEP-SHA256+AES-256-GCM' ||
    fingerprint !== identity.recipient_sha256
  )
    throw Error('Sealed report identity mismatch');
  const bytes = (name, max) => {
    const value = envelope[name];
    if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4)
      throw Error('Invalid sealed report field');
    const decoded = Buffer.from(value, 'base64');
    if (!decoded.length || decoded.toString('base64') !== value || decoded.length > max)
      throw Error('Invalid sealed report field');
    return decoded;
  };
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    bytes('wrapped_key', 1024)
  );
  try {
    const nonce = bytes('nonce', 12),
      tag = bytes('tag', 16);
    if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16)
      throw Error('Invalid sealed report field');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(JSON.stringify(identity)));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(bytes('ciphertext', 8 * 1024 * 1024)),
      decipher.final(),
    ]);
    try {
      const report = JSON.parse(plaintext.toString('utf8'));
      if (report?.status !== 'observed' || report.source_revision !== identity.source_revision)
        throw Error('Sealed report content mismatch');
      return report;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

const pair = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const report = {
  status: 'observed',
  source_revision: 'a'.repeat(40),
  scores: [{ user_id: 'PRIVATE_SCORE_MARKER', human_net_chips_after_rake: 123 }],
};

test('sealed report recovers exact private data while public bytes contain only ciphertext', () => {
  const envelope = sealHorseReport(report, pair.publicKey);
  assert.deepEqual(unsealHorseReport(envelope, pair.privateKey), report);
  assert.doesNotMatch(JSON.stringify(envelope), /PRIVATE_SCORE_MARKER|human_net_chips_after_rake/);
  assert.notEqual(sealHorseReport(report, pair.publicKey).ciphertext, envelope.ciphertext);
});

test('recipient, ciphertext and authenticated identity cannot be silently substituted', () => {
  const envelope = sealHorseReport(report, pair.publicKey);
  for (const field of ['wrapped_key', 'nonce', 'tag', 'ciphertext']) {
    const changed = Buffer.from(envelope[field], 'base64');
    changed[0] ^= 1;
    assert.throws(() =>
      unsealHorseReport({ ...envelope, [field]: changed.toString('base64') }, pair.privateKey)
    );
  }
  for (const patch of [
    { source_revision: 'b'.repeat(40) },
    { version: 2 },
    { recipient_sha256: '0'.repeat(64) },
    { algorithm: 'plaintext' },
    { ciphertext: '' },
  ])
    assert.throws(() => unsealHorseReport({ ...envelope, ...patch }, pair.privateKey));
  assert.throws(() => sealHorseReport(report, ''));
  assert.throws(() => sealHorseReport({ ...report, status: 'unavailable' }, pair.publicKey));
  assert.throws(() => sealHorseReport({ ...report, source_revision: undefined }, pair.publicKey));
  const weak = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  assert.throws(() => sealHorseReport(report, weak.publicKey));
});

test('the public repository workflow uploads only encrypted reports and directly checks sealing', () => {
  const workflow = readFileSync('.github/workflows/horse-human-scoreboard.yml', 'utf8');
  assert.doesNotMatch(workflow, /horse-human-results\/report\.json/);
  for (const path of [
    'scripts/horse-report-seal.mjs',
    'scripts/ci/test-horse-report-seal.mjs',
    'scripts/horse-report-keychain.swift',
  ])
    assert.ok(workflow.split(path).length - 1 >= 2, path);
  assert.match(
    workflow,
    /node --test scripts\/ci\/test-horse-human-scoreboard.mjs scripts\/ci\/test-horse-report-seal.mjs/
  );
  assert.match(
    workflow,
    /REPORT_RECIPIENT_PUBLIC_KEY: \$\{\{ vars.HORSE_REPORT_RECIPIENT_PUBLIC_KEY \}\}/
  );
  assert.match(workflow, /sealHorseReport\(report, process.env.REPORT_RECIPIENT_PUBLIC_KEY\)/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/horse-human-results\/report.sealed.json/);
  const helper = readFileSync('scripts/horse-report-keychain.swift', 'utf8');
  assert.equal((helper.match(/SecKeyCopyExternalRepresentation\(/g) ?? []).length, 1);
  assert.match(helper, /SecKeyCopyExternalRepresentation\(publicKey,/);
  assert.match(helper, /kSecAttrIsPermanent as String: true/);
  assert.match(helper, /kSecAttrIsExtractable as String: false/);
  assert.match(helper, /SecKeyCreateDecryptedData\(key, \.rsaEncryptionOAEPSHA256,/);
});
