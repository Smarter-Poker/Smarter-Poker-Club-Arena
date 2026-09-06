import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const ACCOUNT_PREFIX = 'ca-customization-cert-';
const SHARED_POST_DEPLOY_PREFIX = 'ca-customization-cert-postdeploy-';

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

const CLEANUP_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const SERVICE_REQUEST_MAX_ATTEMPTS = 5;
const SERVICE_REQUEST_BASE_DELAY_MS = 500;
const STALE_FIXTURE_MINIMUM_AGE_MS = 5 * 60_000;
const STALE_FIXTURE_CLEANUP_LIMIT = 100;

function isTransientCleanupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    /\((?:429|502|503|504)\)/.test(message) ||
    /PGRST00[0123]|schema cache|retrying|network|fetch|timeout/i.test(message)
  );
}

async function withCleanupRetries<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CLEANUP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientCleanupError(error) || attempt === CLEANUP_RETRY_DELAYS_MS.length)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}
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
  init: RequestInit = {},
  retrySafe = false
): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const methodIsIdempotent =
    retrySafe || ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'].includes(method);

  for (let attempt = 0; attempt < SERVICE_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${environment.supabaseUrl}${path}`, {
        ...init,
        headers: serverHeaders(environment.serviceRoleKey, {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...((init.headers as Record<string, string> | undefined) || {}),
        }),
      });
      const responseText = await response.text();
      let body = undefined as T;
      if (responseText) {
        try {
          body = JSON.parse(responseText) as T;
        } catch {
          if (response.ok) {
            throw new Error(
              `Supabase service request ${method} ${path} returned invalid JSON: ` +
                responseText.slice(0, 400)
            );
          }
        }
      }
      if (response.ok) return body;

      const schemaCacheUnavailable =
        (body as JsonObject | undefined)?.code === 'PGRST002' ||
        responseText.includes('"code":"PGRST002"');
      const retryableStatus =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      // PGRST002 means PostgREST could not resolve the request against its
      // schema cache, so it never invoked even a POST RPC. Other ambiguous
      // transport failures are retried only for idempotent methods; this test
      // harness must never double-credit or double-create a fixture account.
      const safeToRetry = schemaCacheUnavailable || (methodIsIdempotent && retryableStatus);
      if (safeToRetry && attempt + 1 < SERVICE_REQUEST_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, SERVICE_REQUEST_BASE_DELAY_MS * 2 ** attempt)
        );
        continue;
      }

      throw new Error(
        `Supabase service request ${method} ${path} failed ` +
          `(${response.status}): ${responseText.slice(0, 400)}`
      );
    } catch (error) {
      const mayRetryTransport =
        methodIsIdempotent &&
        attempt + 1 < SERVICE_REQUEST_MAX_ATTEMPTS &&
        !String((error as Error)?.message || error).startsWith('Supabase service request');
      if (!mayRetryTransport) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, SERVICE_REQUEST_BASE_DELAY_MS * 2 ** attempt)
      );
    }
  }

  throw new Error(`Supabase service request ${method} ${path} exhausted its retry window.`);
}

export async function readServiceRows<T>(
  environment: CustomizationCertificationEnvironment,
  table: string,
  query: URLSearchParams
): Promise<T[]> {
  return serviceRequest<T[]>(environment, `/rest/v1/${table}?${query.toString()}`);
}

export async function insertServiceRows<T>(
  environment: CustomizationCertificationEnvironment,
  table: string,
  rows: JsonObject | JsonObject[]
): Promise<T[]> {
  return serviceRequest<T[]>(environment, `/rest/v1/${table}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
}

export async function deleteServiceRows(
  environment: CustomizationCertificationEnvironment,
  table: string,
  query: URLSearchParams
): Promise<void> {
  await serviceRequest<void>(environment, `/rest/v1/${table}?${query.toString()}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

export async function callServiceRpc<T>(
  environment: CustomizationCertificationEnvironment,
  rpc: string,
  body: JsonObject,
  retrySafe = false
): Promise<T> {
  return serviceRequest<T>(
    environment,
    `/rest/v1/rpc/${rpc}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    retrySafe
  );
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
      // Keep commerce/mission certification focused on the target surface.
      // This is a real free library asset and satisfies the same durable gate
      // that the public Avatar Gallery writes during first-run onboarding.
      arena_avatar_url: '/avatars/table/free_samurai@2x.webp',
    }),
  });

  const rows = await readServiceRows<{
    diamonds: number;
    diamond_balance: number;
    is_vip: boolean;
    arena_avatar_url: string | null;
  }>(
    environment,
    'profiles',
    new URLSearchParams({
      select: 'diamonds,diamond_balance,is_vip,arena_avatar_url',
      id: `eq.${userId}`,
    })
  );
  if (
    rows.length !== 1 ||
    Number(rows[0].diamonds) !== 0 ||
    Number(rows[0].diamond_balance) !== 0 ||
    rows[0].is_vip !== false ||
    rows[0].arena_avatar_url !== '/avatars/table/free_samurai@2x.webp'
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
      try {
        await cleanupTemporaryCustomizationAccount(environment, {
          id: userId,
          email,
          password,
          client: createClient(environment.supabaseUrl, environment.publishableKey),
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Temporary account setup failed and cleanup was incomplete for ${userId}.`
        );
      }
    }
    throw error;
  }
}

async function assertRowsRemoved(
  environment: CustomizationCertificationEnvironment,
  table: string,
  column: 'user_id' | 'recipient_user_id' | 'from_user_id' | 'to_user_id' | 'actor_id',
  userId: string
): Promise<void> {
  const rows = await readServiceRows<{ id?: string }>(
    environment,
    table,
    new URLSearchParams({ select: column, [column]: `eq.${userId}`, limit: '1' })
  );
  if (rows.length > 0) {
    throw new Error(`${table}.${column}: reserved fixture residue remains after cleanup`);
  }
}

async function authUserExists(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<boolean> {
  return withCleanupRetries(async () => {
    const response = await fetch(
      `${environment.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { headers: serverHeaders(environment.serviceRoleKey) }
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Supabase Auth verification failed (${response.status}): ${text.slice(0, 400)}`
      );
    }
    return true;
  });
}

function isReservedCertificationEmail(email: string): boolean {
  return email.startsWith(ACCOUNT_PREFIX) && email.endsWith('@example.invalid');
}

/**
 * Recover fixtures whose runner was cancelled before its `finally` block.
 * The age floor protects a concurrent certification, the local marker check
 * protects real accounts, and the database RPC repeats that marker check while
 * holding the Auth row lock before deleting anything.
 */
export async function cleanupStaleTemporaryCustomizationAccounts(
  environment: CustomizationCertificationEnvironment,
  minimumAgeMs = STALE_FIXTURE_MINIMUM_AGE_MS
): Promise<number> {
  // Never permit a caller to turn this recovery sweep into current-run cleanup.
  const safeMinimumAgeMs = Math.max(minimumAgeMs, 60_000);
  const cutoff = new Date(Date.now() - safeMinimumAgeMs).toISOString();
  const candidates = await readServiceRows<{ id: string; email: string; created_at: string }>(
    environment,
    'profiles',
    new URLSearchParams({
      select: 'id,email,created_at',
      // The post-deploy workflow owns one shared login for the entire sweep.
      // It can be older than this helper's five-minute orphan threshold by the
      // time commerce starts, but it is still active. Its own always() cleanup
      // and next-run recovery own that namespace; never reap it mid-suite.
      and: `(email.like.${ACCOUNT_PREFIX}*@example.invalid,email.not.like.${SHARED_POST_DEPLOY_PREFIX}*@example.invalid)`,
      created_at: `lte.${cutoff}`,
      order: 'created_at.asc',
      limit: String(STALE_FIXTURE_CLEANUP_LIMIT + 1),
    })
  );
  if (candidates.length > STALE_FIXTURE_CLEANUP_LIMIT) {
    throw new Error(
      `Refusing to clean more than ${STALE_FIXTURE_CLEANUP_LIMIT} stale certification accounts in one run.`
    );
  }
  for (const candidate of candidates) {
    if (
      !candidate.id ||
      !isReservedCertificationEmail(candidate.email || '') ||
      Date.parse(candidate.created_at) > Date.parse(cutoff)
    ) {
      throw new Error(
        `Refusing invalid stale certification candidate ${candidate.id || 'unknown'}.`
      );
    }
    await callServiceRpc<JsonObject>(
      environment,
      'cleanup_reserved_certification_account',
      { p_user_id: candidate.id },
      true
    );
    if (await authUserExists(environment, candidate.id)) {
      throw new Error(`Stale certification account ${candidate.id} still exists after cleanup.`);
    }
  }
  return candidates.length;
}

/**
 * Remove only a fixture created by createTemporaryCustomizationAccount.
 * The prefix check is deliberately local and server-backed: a typo can never
 * turn this helper into a general account deletion primitive.
 */
async function cleanupTemporaryCustomizationAccountOnce(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount
): Promise<void> {
  if (!isReservedCertificationEmail(account.email)) {
    throw new Error(`Refusing to clean non-certification account ${account.email}.`);
  }

  // 2026-09-04: scope local. A bare signOut() is global and would revoke
  // every session this account has; on a throwaway account that is harmless,
  // but the law (a-script-never-wears-a-persons-face) allows no exceptions.
  await account.client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  const failures: string[] = [];
  const userTables = [
    // Daily Missions certification state. Child/outbox rows are removed before
    // their parent notification or account rows so cleanup remains explicit
    // even if a production FK temporarily loses ON DELETE CASCADE.
    'daily_mission_operations',
    'daily_challenge_progress_events',
    'daily_challenge_event_outbox',
    'daily_challenge_milestone_claims',
    'daily_challenge_claim_batches',
    'daily_challenge_reroll_receipts',
    'daily_challenge_freeze_entitlements',
    'user_daily_challenges',
    'challenge_streak_state',
    'user_notification_preferences',
    'notifications',
    // Deleting mission state intentionally bumps the dashboard revision. This
    // row therefore belongs after every trigger-producing mission table.
    'daily_challenge_dashboard_revisions',
    'wallet_credit_idempotency',
    'wallet_transactions',
    'wallets',
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

  const relatedTables = [
    { table: 'push_outbox', column: 'recipient_user_id' as const },
    { table: 'chip_transactions', column: 'from_user_id' as const },
    { table: 'chip_transactions', column: 'to_user_id' as const },
    { table: 'audit_trail', column: 'actor_id' as const },
  ];

  await callServiceRpc<JsonObject>(
    environment,
    'cleanup_reserved_certification_account',
    {
      p_user_id: account.id,
    },
    true
  ).catch((error) => failures.push(`reserved identity: ${(error as Error).message}`));

  for (const { table, column } of [
    ...relatedTables,
    ...userTables.map((table) => ({ table, column: 'user_id' as const })),
  ]) {
    await assertRowsRemoved(environment, table, column, account.id).catch((error) => {
      failures.push((error as Error).message);
    });
  }

  try {
    if (await authUserExists(environment, account.id)) {
      failures.push('auth.users: reserved fixture still exists after hard delete');
    }
  } catch (error) {
    failures.push(`auth.users final verification: ${(error as Error).message}`);
  }

  if (failures.length) {
    throw new Error(`Temporary customization cleanup was incomplete: ${failures.join(' | ')}`);
  }
}

export async function cleanupTemporaryCustomizationAccount(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount
): Promise<void> {
  return withCleanupRetries(() => cleanupTemporaryCustomizationAccountOnce(environment, account));
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
