/**
 * The one configuration for the engine's raw Postgres sessions.
 *
 * Two services hold a session of their own instead of going through the
 * shared PostgREST client:
 *
 *   - ./handOutboxListener.ts, for LISTEN hand_projection_outbox (2026-09-10);
 *   - ../leaseHeartbeatSession.ts, for the table and tournament lease
 *     heartbeats (2026-09-24), which must not queue behind game traffic for a
 *     PostgREST pool connection.
 *
 * Both read the same connection string and the same TLS settings, so there is
 * one credential to place and one place that says how it is used. The value
 * must be the Supavisor SESSION-mode string (port 5432 on the pooler host) or
 * a direct connection, never the transaction pooler on 6543. Unset disables
 * both services and each keeps its documented fallback. The connection string
 * is never logged.
 */

import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import type pg from 'pg';

export const ENGINE_PG_URL_ENV = 'ENGINE_PG_LISTEN_URL';
export const ENGINE_PG_CA_FILE_ENV = 'ENGINE_PG_LISTEN_CA_FILE';

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

/** The configured session connection string, or '' when none is set. */
export function enginePgConnectionString(): string {
  return process.env[ENGINE_PG_URL_ENV] ?? '';
}

/**
 * Supabase Root 2021 CA (Dashboard > Database > SSL, prod-ca-2021.crt;
 * sha256 80:70:25:AD:...:72:E6:CA:FA, valid to 2031-04-26). Supavisor
 * (*.pooler.supabase.com) presents a chain that ends here, not at a public
 * root, so verified TLS without it fails every connect (measured 2026-10-02:
 * `openssl s_client -starttls postgres` verify error 19 without it, 0 with it).
 * A certificate is public; it is not a credential.
 */
export const SUPABASE_ROOT_2021_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;

/**
 * Verified TLS, with an optional pinned CA bundle. Without one, the system
 * roots plus the Supabase root: a pooler or direct Supabase host verifies,
 * and nothing that verified before stops verifying.
 */
export function enginePgSsl(): pg.ClientConfig['ssl'] {
  const caFile = process.env[ENGINE_PG_CA_FILE_ENV];
  if (caFile) return { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  return { ca: [...tls.rootCertificates, SUPABASE_ROOT_2021_CA], rejectUnauthorized: true };
}

/** Exponential backoff, base 500 ms, capped at 30 s, jittered by +/-25%. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
  return Math.round(delay * (0.75 + random() * 0.5));
}
