#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

export const OPENING_GRANT_CHIPS = 100_000;
export const DEFAULT_CERTIFICATION_GRANTS = 3;

export function readCapacity(overview, grants = DEFAULT_CERTIFICATION_GRANTS) {
  const required = OPENING_GRANT_CHIPS * grants;
  const headroom = Number(overview?.policy?.headroom_24h_chips);
  const issued = Number(overview?.issuance?.issued_24h);
  const ceiling = Number(overview?.policy?.rolling_24h_cap_chips);

  if (overview?.ok !== true || !Number.isFinite(headroom) || !Number.isFinite(issued)) {
    throw new Error('Club Create Capacity Is Unknown: The Mint Overview Was Incomplete.');
  }

  return {
    ok: headroom >= required,
    required,
    headroom,
    issued,
    ceiling: Number.isFinite(ceiling) ? ceiling : null,
    grants,
  };
}

export function describeCapacity(capacity) {
  const available = capacity.headroom.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const required = capacity.required.toLocaleString('en-US');
  const ceiling =
    capacity.ceiling == null
      ? 'Unknown'
      : capacity.ceiling.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return capacity.ok
    ? `Club Create Capacity Ready: ${available} Chips Available; ${required} Required.`
    : `Club Create Capacity Refused: ${available} Chips Available; ${required} Required; ` +
        `Rolling Ceiling ${ceiling}. Adjust The Audited Mint Policy With A Recorded Reason ` +
        `Or Wait For Issuance To Leave The Rolling Window.`;
}

export async function checkClubCreateCapacity({
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  const supabaseUrl = String(environment.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = String(environment.SUPABASE_SERVICE_ROLE_KEY || '');
  const grants = Number(
    environment.CLUB_CREATE_CERT_REQUIRED_GRANTS || DEFAULT_CERTIFICATION_GRANTS
  );
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL And SUPABASE_SERVICE_ROLE_KEY Are Required.');
  }
  if (!Number.isSafeInteger(grants) || grants < 1 || grants > 20) {
    throw new Error('CLUB_CREATE_CERT_REQUIRED_GRANTS Must Be An Integer From 1 Through 20.');
  }

  // Capacity is advisory; the existing issuance transaction remains the authority.
  // Avoid lifetime reconciliation and seat totals in the full Mint overview.
  const headers = supabaseServerHeaders(serviceRoleKey, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  const [issuedResponse, policyResponse] = await Promise.all([
    fetchImpl(`${supabaseUrl}/rest/v1/rpc/fn_ca_mint_issued_24h`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_asset: 'chips', p_except_leg: null }),
    }),
    fetchImpl(`${supabaseUrl}/rest/v1/ca_mint_policy?id=eq.1&select=rolling_24h_cap_chips`, {
      method: 'GET',
      headers,
    }),
  ]);
  for (const response of [issuedResponse, policyResponse]) {
    if (!response.ok) throw new Error(`Club Create Capacity Read Failed (${response.status}).`);
  }
  const [issuedBody, policyBody] = await Promise.all([
    issuedResponse.json().catch(() => undefined),
    policyResponse.json().catch(() => undefined),
  ]);
  function amount(value) {
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !value.trim())
    )
      return NaN;
    return Number(value);
  }
  const issued = amount(issuedBody);
  const ceiling =
    Array.isArray(policyBody) && policyBody.length === 1
      ? amount(policyBody[0]?.rolling_24h_cap_chips)
      : NaN;
  if (!Number.isFinite(issued) || issued < 0 || !Number.isFinite(ceiling) || ceiling < 0) {
    throw new Error(
      'Club Create Capacity Is Unknown: The Rolling Issuance Or Policy Was Incomplete.'
    );
  }
  const capacity = readCapacity(
    {
      ok: true,
      issuance: { issued_24h: issued },
      policy: { rolling_24h_cap_chips: ceiling, headroom_24h_chips: ceiling - issued },
    },
    grants
  );
  const message = describeCapacity(capacity);
  console.log(message);
  if (environment.GITHUB_STEP_SUMMARY) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `### Club Create Capacity\n\n${message}\n`);
  }
  if (!capacity.ok) {
    throw Object.assign(new Error(message), { code: 'CLUB_CREATE_CAPACITY_REFUSED' });
  }
  return capacity;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  checkClubCreateCapacity().catch((error) => {
    console.error(`[club-create-capacity] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
