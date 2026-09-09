import type { Page } from '@playwright/test';

type TermsGateStatus = 'accepted' | 'not_accepted' | 'unknown';

const DECIDED_TERMS_SELECTOR = '[data-tos-gate-status]:not([data-tos-gate-status="checking"])';

async function waitForTermsDecision(page: Page): Promise<TermsGateStatus> {
  const decision = page.locator(DECIDED_TERMS_SELECTOR);
  await decision.waitFor({ state: 'attached', timeout: 60_000 });
  const status = await decision.getAttribute('data-tos-gate-status');
  if (status === 'accepted' || status === 'not_accepted') return status;
  if (status === 'unknown') {
    throw new Error('The production Terms Of Service query did not answer; acceptance is unknown.');
  }
  throw new Error(`Unexpected production Terms Of Service gate status: ${String(status)}`);
}

/**
 * Bring the isolated authenticated account through the outermost server-backed
 * gate before global setup asks AppLayout about the inner profile gate.
 *
 * The write goes through the same public UI and idempotent endpoint a player
 * uses. A subsequent full reload must read `accepted` from the canonical
 * profile column again; neither a hidden DOM mutation nor a client-only state
 * flip can satisfy this preflight.
 */
export async function ensureAcceptedTerms(page: Page): Promise<boolean> {
  const status = await waitForTermsDecision(page);
  if (status === 'accepted') return false;

  const heading = page.getByRole('heading', { name: 'Terms Of Service', exact: true });
  await heading.waitFor({ state: 'visible', timeout: 30_000 });

  const agreement = page.getByRole('checkbox', {
    name: 'I Have Read And Agree To The Terms Of Service And Privacy Policy',
    exact: true,
  });
  await agreement.check({ timeout: 20_000 });

  const acceptanceResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/club-arena/accept-tos',
    { timeout: 30_000 }
  );
  await page.getByRole('button', { name: 'Accept & Continue', exact: true }).click({
    timeout: 20_000,
  });
  const response = await acceptanceResponse;
  if (!response.ok()) {
    throw new Error(`Terms Of Service acceptance failed in production (${response.status()}).`);
  }

  await page
    .locator('[data-tos-gate-status="accepted"]')
    .waitFor({ state: 'attached', timeout: 30_000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  const persistedStatus = await waitForTermsDecision(page);
  if (persistedStatus !== 'accepted') {
    throw new Error('Terms Of Service acceptance appeared to succeed but did not persist.');
  }

  console.log('[global-setup] dedicated account Terms Of Service acceptance is persisted.');
  return true;
}
