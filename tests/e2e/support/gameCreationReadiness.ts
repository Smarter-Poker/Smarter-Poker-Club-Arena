import type { Page, Response } from '@playwright/test';

/** Observe the route's own authorization request; never issue a second RPC. */
export function matchesGameCreationRead(response: Response, clubId: string): boolean {
  try {
    return (
      new URL(response.url()).pathname === '/rest/v1/rpc/fn_game_creation_access' &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.p_club_id === clubId
    );
  } catch {
    return false;
  }
}

/** DOMContentLoaded precedes the asynchronous GameCreationGuard decision. */
export async function waitForGameCreationAuthority(
  page: Pick<Page, 'waitForResponse'>,
  clubId: string,
  timeout: number
): Promise<Response> {
  const response = await page.waitForResponse(
    (candidate) => matchesGameCreationRead(candidate, clubId),
    { timeout }
  );
  if (!response.ok()) {
    throw new Error(`Game creation permission read failed: HTTP ${response.status()}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Game creation permission returned invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Game creation permission returned malformed data');
  }
  const value = body as Record<string, unknown>;
  if (value.allowed === false && typeof value.reason === 'string') {
    throw new Error(`Game creation permission denied: ${value.reason}`);
  }
  if (value.allowed !== true || value.reason !== 'ok' || value.union_id !== null) {
    throw new Error('Game creation permission did not confirm the standalone club route');
  }
  return response;
}
