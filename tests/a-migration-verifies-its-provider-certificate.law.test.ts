import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { expect, test } from 'vitest';

test('the migration provider route supplies its pinned public CA and keeps strict TLS', () => {
  const pem = readFileSync('scripts/ci/certificates/supabase-prod-ca-2021.crt', 'utf8');
  const cert = new X509Certificate(pem);
  expect(createHash('sha256').update(pem).digest('hex')).toBe(
    '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7'
  );
  expect(cert.ca).toBe(true);
  expect(cert.verify(cert.publicKey)).toBe(true);
  expect(pem).not.toContain('PRIVATE KEY');
  expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now());
  expect(readFileSync('.github/workflows/apply-merged-migration.yml', 'utf8')).toContain(
    '--ssl-root-cert scripts/ci/certificates/supabase-prod-ca-2021.crt'
  );
  expect(readFileSync('scripts/ci/apply-recorded-migration.mjs', 'utf8')).toContain(
    'rejectUnauthorized: true'
  );
});
