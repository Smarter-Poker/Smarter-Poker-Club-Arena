import type { Page } from '@playwright/test';

export type CspViolation = {
  directive: string;
  blockedURI: string;
  disposition: string;
  sourceFile?: string;
  lineNumber?: number;
};

/** Realtime traffic need not stop for a rendered document to expose its CSP violations. */
export async function visitCspRoute(
  page: Page,
  url: string,
  label = 'arena:/'
): Promise<CspViolation[]> {
  // Never reload: that would discard the first document's collected violations.
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!response || !response.ok())
    throw new Error(`${label}: no successful HTML document (${response?.status() ?? 'missing'})`);
  if (!response.headers()['content-type']?.includes('text/html'))
    throw new Error(`${label}: document is not HTML`);
  await page.locator('body').waitFor({ state: 'visible' });
  const selector = label.startsWith('arena:') ? '#root' : '#__next';
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.waitForFunction(
    (selector) =>
      Boolean((document.querySelector(selector) as HTMLElement | null)?.innerText?.trim()),
    selector
  );
  await page.waitForTimeout(3500);
  const text = await page.locator(selector).innerText();
  if (
    /This Arena Door Is Closed|This page ran into an issue|Something went wrong|This page could not be found/i.test(
      text
    )
  )
    throw new Error(`${label}: route rendered a fallback`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  // An absent/closed/unreadable collector is no verdict, never zero violations.
  return page.evaluate(() => {
    const violations = (window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations;
    if (!Array.isArray(violations)) throw new Error('CSP collector is unavailable');
    return violations;
  });
}
