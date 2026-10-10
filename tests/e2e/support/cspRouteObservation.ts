import type { Page } from '@playwright/test';

export type CspViolation = {
  directive: string;
  blockedURI: string;
  disposition: string;
  sourceFile?: string;
  lineNumber?: number;
};

/** Realtime traffic need not stop for a document to expose its CSP violations. */
export async function visitCspRoute(page: Page, url: string): Promise<CspViolation[]> {
  // A second navigation discards the first document's collector. Observe one
  // loaded document, keeping the original navigation cap and lazy-resource dwell.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(2000);
  // A closed/unreadable document is no verdict, never an empty violations list.
  return page.evaluate(
    () => (window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations ?? []
  );
}
