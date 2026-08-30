import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const ACCOUNT_PREFIX = 'ca-customization-cert-';

export type CustomizationCertificationEnvironment = {
  supabaseUrl: string;
  serviceRoleKey: string;
  publishableKey: string;
};

export type TemporaryCustomizationAccount = {
  id: string;
  email: string;
  password: string;
  client: SupabaseClient;
};

export type StorefrontSku = {
  feature: string;
  diamond_cost: number;
  usage_type: string;
};

type JsonObject = Record<string, unknown>;

function serverHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: key,
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }),
    ...extra,
  };
}

export function requireCustomizationCertificationEnvironment(): CustomizationCertificationEnvironment {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const publishableKey =
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';

  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
    !publishableKey && 'VITE_SUPABASE_ANON_KEY',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Customization commerce certification is enabled but ${missing.join(', ')} is missing.`
    );
  }

  return { supabaseUrl, serviceRoleKey, publishableKey };
}

async function serviceRequest<T>(
  environment: CustomizationCertificationEnvironment,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${environment.supabaseUrl}${path}`, {
    ...init,
    headers: serverHeaders(environment.serviceRoleKey, {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers as Record<string, string> | undefined) || {}),
    }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  if (!response.ok) {
    throw new Error(
      `Supabase service request ${init.method || 'GET'} ${path} failed ` +
        `(${response.status}): ${text.slice(0, 400)}`
    );
  }
  return body;
}

export async function readServiceRows<T>(
  environment: CustomizationCertificationEnvironment,
  table: string,
  query: URLSearchParams
): Promise<T[]> {
  return serviceRequest<T[]>(environment, `/rest/v1/${table}?${query.toString()}`);
}

export async function callServiceRpc<T extends JsonObject>(
  environment: CustomizationCertificationEnvironment,
  rpc: string,
  body: JsonObject
): Promise<T> {
  return serviceRequest<T>(environment, `/rest/v1/rpc/${rpc}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listTableStudioStorefrontSkus(
  environment: CustomizationCertificationEnvironment
): Promise<StorefrontSku[]> {
  const query = new URLSearchParams({
    select: 'feature,diamond_cost,usage_type',
    usage_type: 'eq.permanent',
    or: '(feature.like.studio:*,feature.like.card_back_*)',
    order: 'feature.asc',
  });
  const rows = await readServiceRows<StorefrontSku>(environment, 'feature_pricing', query);
  return rows
    .map((row) => ({ ...row, diamond_cost: Number(row.diamond_cost) }))
    .filter((row) => row.feature && Number.isFinite(row.diamond_cost) && row.diamond_cost > 0);
}

async function waitForProfile(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<void> {
  const query = new URLSearchParams({ select: 'id', id: `eq.${userId}` });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await readServiceRows<{ id: string }>(environment, 'profiles', query);
    if (rows.some((row) => row.id === userId)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Temporary customization account ${userId} never received a profile row.`);
}

async function normalizeTemporaryProfile(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<void> {
  const query = new URLSearchParams({ id: `eq.${userId}` });
  await serviceRequest<void>(environment, `/rest/v1/profiles?${query.toString()}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      diamonds: 0,
      diamond_balance: 0,
      diamond_multiplier: 1,
      is_vip: false,
      vip_tier: null,
      vip_expires_at: null,
    }),
  });

  const rows = await readServiceRows<{
    diamonds: number;
    diamond_balance: number;
    is_vip: boolean;
  }>(
    environment,
    'profiles',
    new URLSearchParams({
      select: 'diamonds,diamond_balance,is_vip',
      id: `eq.${userId}`,
    })
  );
  if (
    rows.length !== 1 ||
    Number(rows[0].diamonds) !== 0 ||
    Number(rows[0].diamond_balance) !== 0 ||
    rows[0].is_vip !== false
  ) {
    throw new Error(`Temporary customization account ${userId} was not normalized.`);
  }
}

export async function createTemporaryCustomizationAccount(
  environment: CustomizationCertificationEnvironment,
  label: string,
  diamonds: number
): Promise<TemporaryCustomizationAccount> {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const email = `${ACCOUNT_PREFIX}${label}-${suffix}@example.invalid`;
  const password = `Ca!${randomUUID()}aA7`;
  let userId = '';

  try {
    const created = await serviceRequest<JsonObject>(environment, '/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          // Profiles may enforce a shorter username than Auth permits. Keep
          // the destructive-cleanup marker in the email, where we validate
          // it, and give the profile trigger a compact unique value.
          username: `Cert${label.slice(0, 4)}${suffix.slice(-8)}`,
          poker_alias: `Cert${label.slice(0, 4)}${suffix.slice(-8)}`,
          display_name: 'Customization Certification',
          full_name: 'Customization Certification',
        },
      }),
    });
    userId = String(created.id || (created.user as JsonObject | undefined)?.id || '');
    if (!userId) throw new Error('Supabase Auth created no user id for the temporary account.');

    await waitForProfile(environment, userId);
    // New player onboarding intentionally starts with promotional diamonds and
    // VIP. A commerce fixture must begin at server-proven zero so purchases
    // exercise real price checks instead of VIP bypasses or gifted currency.
    await normalizeTemporaryProfile(environment, userId);
    if (diamonds > 0) {
      const funded = await callServiceRpc<JsonObject>(environment, 'add_diamonds_to_balance', {
        p_user_id: userId,
        p_amount: diamonds,
        p_type: 'adjustment',
        p_description: 'Temporary Table Studio Commerce Certification',
        p_reference_id: `customization-cert-fund:${userId}`,
      });
      if (funded.success !== true) {
        throw new Error(`Temporary customization funding failed: ${String(funded.error || '')}`);
      }
    }

    const client = createClient(environment.supabaseUrl, environment.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: session, error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || session.user?.id !== userId) {
      throw (
        signInError || new Error('Temporary customization API session belongs to the wrong user.')
      );
    }

    return { id: userId, email, password, client };
  } catch (error) {
    if (userId) {
      await cleanupTemporaryCustomizationAccount(environment, {
        id: userId,
        email,
        password,
        client: createClient(environment.supabaseUrl, environment.publishableKey),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function deleteRows(
  environment: CustomizationCertificationEnvironment,
  table: string,
  column: 'user_id' | 'id',
  userId: string
): Promise<void> {
  const query = new URLSearchParams({ [column]: `eq.${userId}` });
  await serviceRequest<void>(environment, `/rest/v1/${table}?${query.toString()}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

/**
 * Remove only a fixture created by createTemporaryCustomizationAccount.
 * The prefix check is deliberately local and server-backed: a typo can never
 * turn this helper into a general account deletion primitive.
 */
export async function cleanupTemporaryCustomizationAccount(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount
): Promise<void> {
  if (!account.email.startsWith(ACCOUNT_PREFIX) || !account.email.endsWith('@example.invalid')) {
    throw new Error(`Refusing to clean non-certification account ${account.email}.`);
  }

  await account.client.auth.signOut().catch(() => undefined);
  const failures: string[] = [];
  const userTables = [
    'customization_operations',
    'user_theme_settings',
    'user_table_studio_preferences',
    'theme_asset_unlocks',
    'avatar_unlocks',
    'feature_purchases',
    'diamond_transactions',
    'diamond_wallets',
    'signup_errors',
  ];

  for (const table of userTables) {
    await deleteRows(environment, table, 'user_id', account.id).catch((error) => {
      failures.push(`${table}: ${(error as Error).message}`);
    });
  }

  let firstAuthDeleteError: Error | null = null;
  await serviceRequest<void>(
    environment,
    `/auth/v1/admin/users/${encodeURIComponent(account.id)}?should_soft_delete=false`,
    { method: 'DELETE' }
  ).catch((error) => {
    firstAuthDeleteError = error as Error;
  });

  // The normal auth delete cascades these rows. The explicit cleanup also
  // handles an interrupted historical trigger without touching any other id.
  for (const table of ['profiles', 'users']) {
    await deleteRows(environment, table, 'id', account.id).catch((error) => {
      failures.push(`${table}: ${(error as Error).message}`);
    });
  }

  // A historical trigger/FK can make Auth deletion fail until public rows are
  // gone. Retry exactly this reserved fixture once after that cleanup.
  if (firstAuthDeleteError) {
    await serviceRequest<void>(
      environment,
      `/auth/v1/admin/users/${encodeURIComponent(account.id)}?should_soft_delete=false`,
      { method: 'DELETE' }
    ).catch((error) => failures.push(`auth.users: ${(error as Error).message}`));
  }

  if (failures.length) {
    throw new Error(`Temporary customization cleanup was incomplete: ${failures.join(' | ')}`);
  }
}

export function expectedUnlockForFeature(feature: string): string | null {
  if (feature.startsWith('card_back_')) {
    return `cards_id:${feature.slice('card_back_'.length)}`;
  }
  if (!feature.startsWith('studio:')) return null;
  const [, category, ...assetParts] = feature.split(':');
  const assetId = assetParts.join(':');
  return category && assetId ? `${category}:${assetId}` : null;
}
