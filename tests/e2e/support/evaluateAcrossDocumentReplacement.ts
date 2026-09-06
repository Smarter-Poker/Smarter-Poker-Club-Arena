import type { Page } from '@playwright/test';

const TRANSIENT_DOCUMENT_ERROR =
  /execution context was destroyed|cannot find context with specified id|frame was detached/i;

/**
 * Evaluate geometry against the document that survives an SPA/auth redirect.
 * A replacement document is retried; assertion, parsing, and application
 * errors still fail immediately so this cannot turn a product failure green.
 */
export async function evaluateAcrossDocumentReplacement<T>(
  page: Page,
  pageFunction: () => T | Promise<T>
): Promise<T> {
  let lastNavigationError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(pageFunction);
    } catch (error) {
      if (!TRANSIENT_DOCUMENT_ERROR.test(String(error))) throw error;
      lastNavigationError = error;

      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(750);
    }
  }
  throw new Error(
    `Club Arena document did not stabilize after navigation: ${String(lastNavigationError)}`
  );
}
