import type { Page, Response } from '@playwright/test';

const TAB_KEYS: Record<string, string> = {
  ALL: 'ALL',
  MTT: 'MTT',
  NLH: 'HOLDEM',
  PLO: 'OMAHA',
  LIMIT: 'LIMIT',
  SPINS: 'SPIN',
  'HEADS UP': 'SNG',
};

/** Advanced Filters shares this endpoint. Its acknowledgement is not a tab save. */
export function isLobbySelectionSave(response: Response, clubId: string, label: string): boolean {
  if (!TAB_KEYS[label]) throw new Error(`Unknown lobby tab: ${label}`);
  if (
    !response.ok() ||
    response.request().method() !== 'POST' ||
    !new URL(response.url()).pathname.endsWith('/rest/v1/user_lobby_filters')
  )
    return false;
  try {
    const body: unknown = response.request().postDataJSON();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const row = body as { club_id?: unknown; view_prefs?: { tab?: unknown } };
    return row.club_id === clubId && row.view_prefs?.tab === TAB_KEYS[label];
  } catch {
    return false;
  }
}

export async function selectLobbyPreference(page: Page, clubId: string, label: string) {
  await Promise.all([
    page.waitForResponse((response) => isLobbySelectionSave(response, clubId, label)),
    page
      .getByRole('tablist', { name: 'Game Type', exact: true })
      .getByRole('tab', { name: label, exact: true })
      .click(),
  ]);
}

/** Keep the ready cold-return document alive until restoration and independent readback finish. */
export async function restoreLobbyPreference({
  originalPage,
  returningPage,
  returningReady,
  clubId,
  original,
  verify,
}: {
  originalPage: Page;
  returningPage: Page | undefined;
  returningReady: boolean;
  clubId: string;
  original: string;
  verify: () => Promise<void>;
}) {
  try {
    const restorePage = returningReady && returningPage ? returningPage : originalPage;
    await selectLobbyPreference(restorePage, clubId, original);
    await verify();
  } finally {
    await returningPage?.close();
  }
}
