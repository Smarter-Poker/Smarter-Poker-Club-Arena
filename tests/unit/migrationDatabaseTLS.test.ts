import { test } from 'vitest';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import {
  migrationDatabaseTLS,
  isSupabaseDatabaseHost,
  SUPABASE_CA_FINGERPRINT,
} from '../../scripts/ci/migration-database-tls.mjs';

const direct = new URL('postgres://db.abcdefghijklmnopqrst.supabase.co:5432/postgres');
test('recognized Supabase database and pooler get the pinned valid public CA', () => {
  for (const host of [direct.hostname, 'aws-0-us-east-1.pooler.supabase.com']) {
    assert.equal(isSupabaseDatabaseHost(host), true);
    const ssl = migrationDatabaseTLS(new URL(`postgres://${host}/postgres`));
    assert.equal(ssl.rejectUnauthorized, true);
    const certificate = new X509Certificate(ssl.ca);
    assert.equal(
      certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
      SUPABASE_CA_FINGERPRINT
    );
    assert.equal(certificate.ca, true);
    assert.equal(certificate.verify(certificate.publicKey), true);
    assert.ok(Date.parse(certificate.validTo) > Date.now());
    assert.equal(ssl.checkServerIdentity, undefined);
    assert.ok(
      checkServerIdentity('wrong.example', {
        subjectaltname: 'DNS:db.abcdefghijklmnopqrst.supabase.co',
      })
    );
  }
});
test('custom databases and deceptive provider suffixes retain system trust', () => {
  for (const host of [
    'localhost',
    'db.example.com',
    'db.short.supabase.co',
    'db.abcdefghijklmnopqrst.supabase.co.attacker.example',
    'aws-0-us-east-1.pooler.supabase.com.attacker.example',
    'arbitrary.pooler.supabase.com',
    'supabase.co',
  ]) {
    assert.equal(isSupabaseDatabaseHost(host), false);
    assert.deepEqual(migrationDatabaseTLS(new URL(`postgres://${host}/postgres`)), {
      rejectUnauthorized: true,
    });
  }
});
test('explicit argument, environment and URL root priority remain authoritative', () => {
  const withURL = new URL(direct);
  withURL.searchParams.set('sslrootcert', '/missing-url-ca');
  assert.deepEqual(migrationDatabaseTLS(withURL, 'system', '/missing-env-ca'), {
    rejectUnauthorized: true,
  });
  assert.deepEqual(migrationDatabaseTLS(withURL, undefined, 'system'), {
    rejectUnauthorized: true,
  });
  withURL.searchParams.set('sslrootcert', 'system');
  assert.deepEqual(migrationDatabaseTLS(withURL), { rejectUnauthorized: true });
  assert.throws(() => migrationDatabaseTLS(direct, '/missing-explicit-ca', 'system'));
});
