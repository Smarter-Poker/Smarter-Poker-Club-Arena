import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public Supabase Dashboard production CA, supplied by its SSLConfiguration
// custom-content URL. This is a trust anchor, never a client credential.
export const SUPABASE_CA_FINGERPRINT =
  '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa';
const providerCA = join(
  dirname(fileURLToPath(import.meta.url)),
  'certificates/supabase-prod-ca-2021.crt'
);

export function isSupabaseDatabaseHost(hostname) {
  return /^(?:db\.[a-z0-9]{20}\.supabase\.co|aws-[0-9]+-[a-z]+(?:-[a-z]+)*-[0-9]+\.pooler\.supabase\.com)$/.test(
    hostname
  );
}

export function migrationDatabaseTLS(connectionURL, explicitRoot, environmentRoot) {
  const root = explicitRoot || environmentRoot || connectionURL.searchParams.get('sslrootcert');
  const ssl = { rejectUnauthorized: true };
  if (root) {
    if (root !== 'system') ssl.ca = readFileSync(root, 'utf8');
    return ssl;
  }
  if (!isSupabaseDatabaseHost(connectionURL.hostname)) return ssl;
  const ca = readFileSync(providerCA, 'utf8');
  const certificate = new X509Certificate(ca);
  if (
    certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== SUPABASE_CA_FINGERPRINT ||
    !certificate.ca ||
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now()
  ) {
    throw new Error('pinned provider CA certificate is invalid');
  }
  ssl.ca = ca;
  return ssl;
}
