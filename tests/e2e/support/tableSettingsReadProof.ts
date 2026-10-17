import type { Response } from '@playwright/test';

/** Partial shell reads cannot prove that the settings panel hydrated. */
export function isCompleteSettingsRead(response: Response, ownerId?: string): boolean {
  const url = new URL(response.url());
  const owner = url.searchParams.get('user_id');
  return (
    response.request().method() === 'GET' &&
    url.pathname.endsWith('/rest/v1/user_table_settings') &&
    url.searchParams.getAll('select').length === 1 &&
    url.searchParams.get('select') === '*' &&
    url.searchParams.getAll('user_id').length === 1 &&
    !!owner?.startsWith('eq.') &&
    owner.length > 3 &&
    (ownerId === undefined || owner === `eq.${ownerId}`)
  );
}

/** A failed or different-account read must never become default-value success. */
export async function requireOwnSettingsRow(
  response: Response,
  ownerId: string
): Promise<Record<string, unknown> | null> {
  if (!ownerId || !isCompleteSettingsRead(response, ownerId))
    throw new Error('The settings read did not belong to the signed-in account');
  if (!response.ok()) throw new Error(`The settings read returned HTTP ${response.status()}`);
  const raw: unknown = await response.json();
  if (Array.isArray(raw) && raw.length > 1)
    throw new Error('The settings read returned more than one account row');
  const row = Array.isArray(raw) ? (raw[0] ?? null) : raw;
  if (row === null) return null;
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('The settings read returned an invalid row');
  if ((row as Record<string, unknown>).user_id !== ownerId)
    throw new Error('The settings response contained another account row');
  return row as Record<string, unknown>;
}
