#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  cleanupProductionE2EAccount,
  retireProductionCreateClubFixtures,
} from './production-e2e-account.mjs';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

// One explicitly selected, already-owned fixture. This creates no accounts
// and never scans or retires another certificate's identity.
export async function retireReservedCertificationAccount({
  environment = process.env,
  fetchImpl = fetch,
  cleanup = cleanupProductionE2EAccount,
  retireFixtures = retireProductionCreateClubFixtures,
} = {}) {
  const id = environment.RESERVED_CERTIFICATION_ACCOUNT_ID;
  const email = environment.RESERVED_CERTIFICATION_ACCOUNT_EMAIL;
  if (
    id?.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
    email !== email?.trim() ||
    !/^ca-customization-cert-postdeploy-[a-z0-9-]+@example\.invalid$/.test(email || '')
  ) {
    throw new Error('Exactly One Reserved Post-Deploy UUID And Email Are Required.');
  }
  const url = environment.SUPABASE_URL;
  const key = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Configured Supabase Access Is Required.');
  // Verify the requested pair before the membership-cleanup transaction.
  // Already-soft-retired identities are admitted only to the maintained
  // durable retirement readback; this creates no new Auth operation.
  const response = await fetchImpl(`${url.replace(/\/$/, '')}/auth/v1/admin/users/${id}`, {
    headers: supabaseServerHeaders(key),
    signal: AbortSignal.timeout(30_000),
  });
  const body = response.status === 200 ? await response.json() : null;
  const user = body?.user || body;
  if (response.status !== 200 || user?.id !== id || (!user.deleted_at && user.email !== email)) {
    throw new Error('The Selected Reserved UUID And Email Do Not Match Auth.');
  }
  // A cancelled run loses its local templateFixtureRequest record. Discover
  // only this verified identity's recognized fixtures through the maintained
  // guarded door before account cleanup. Already-retired Auth needs readback only.
  if (!user.deleted_at) await retireFixtures({ environment, fetchImpl, record: { id, email } });
  const retired = await cleanup({ environment, fetchImpl, record: { id, email } });
  if (retired !== true) throw new Error('The Selected Reserved Identity Was Not Retired.');
  return retired;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await retireReservedCertificationAccount();
}
