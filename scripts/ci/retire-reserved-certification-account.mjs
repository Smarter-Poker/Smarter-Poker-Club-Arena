#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { cleanupProductionE2EAccount, STALE_ACCOUNT_AGE_MS } from './production-e2e-account.mjs';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

// One explicitly selected, already-owned fixture. This creates no accounts
// and never scans or retires another certificate's identity.
export async function retireReservedCertificationAccount({
  environment = process.env,
  fetchImpl = fetch,
  cleanup = cleanupProductionE2EAccount,
  now = Date.now,
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
  const record = { id, email };
  const requestId = environment.RESERVED_CERTIFICATION_TEMPLATE_REQUEST_ID || '';
  const clubId = environment.RESERVED_CERTIFICATION_TEMPLATE_CLUB_ID || '';
  if (requestId || clubId) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      !uuid.test(requestId) ||
      !uuid.test(clubId) ||
      (!user.deleted_at && !environment.DATABASE_URL)
    ) {
      throw new Error(
        'Exact Template Creation Receipt IDs And Configured Database Access Are Required.'
      );
    }
    if (!user.deleted_at) {
      const query = new URLSearchParams({
        select: 'user_id,request_id,club_id',
        user_id: `eq.${id}`,
        request_id: `eq.${requestId}`,
        club_id: `eq.${clubId}`,
      });
      const receiptResponse = await fetchImpl(
        `${url.replace(/\/$/, '')}/rest/v1/club_creation_requests?${query}`,
        {
          headers: supabaseServerHeaders(key),
          signal: AbortSignal.timeout(30_000),
        }
      );
      const receipts = receiptResponse.status === 200 ? await receiptResponse.json() : null;
      if (
        !Array.isArray(receipts) ||
        receipts.length !== 1 ||
        receipts[0].user_id !== id ||
        receipts[0].request_id !== requestId ||
        receipts[0].club_id !== clubId
      ) {
        throw new Error('The Selected Template Creation Receipt Does Not Match.');
      }
      // Recover the same durable record the creator persisted before creation.
      // The existing cleanup retires only recognized reserved owned clubs before
      // applying its unchanged authority/custody and supported Auth guards.
      record.templateFixtureRequest = { requestId, clubId };
    }
    // A successful retirement removes its creation receipt. Already-retired
    // Auth delegates only the maintained terminal account readback below.
  }
  // A LIVE CERTIFICATE STILL OWNS A YOUNG IDENTITY (2026-10-19). Client
  // browser verification 118134919713 created its identity at 15:14:07 and
  // was mid-sweep when an out-of-band cleanup soft-deleted it at 15:44:06 and
  // retired the template club it owned a minute earlier. The remaining forty
  // minutes of the sweep then failed 65 checks on a signed-out, clubless
  // account - none of them a production defect. The creating job removes its
  // own identity in its always() cleanup; any other caller is recovering an
  // interrupted run, and a run cannot still be executing once its identity is
  // older than the longest job that may own it (STALE_ACCOUNT_AGE_MS). An
  // unreadable creation time is "could not tell" and refuses too. Identities
  // Auth already retired skip this: their readback changes nothing.
  if (!user.deleted_at) {
    const createdAt = Date.parse(user.created_at || '');
    if (!Number.isFinite(createdAt)) {
      throw new Error(
        'Cannot Tell When The Selected Reserved Identity Was Created; A Running Certificate May Own It.'
      );
    }
    if (now() - createdAt < STALE_ACCOUNT_AGE_MS) {
      throw new Error(
        'The Selected Reserved Identity Is Younger Than The Longest Certificate That May Own It; ' +
          `Retire It After ${new Date(createdAt + STALE_ACCOUNT_AGE_MS).toISOString()}.`
      );
    }
  }
  const retired = await cleanup({ environment, fetchImpl, record });
  if (retired !== true) throw new Error('The Selected Reserved Identity Was Not Retired.');
  return retired;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await retireReservedCertificationAccount();
}
