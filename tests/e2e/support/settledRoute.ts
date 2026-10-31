/**
 * A ROUTE IS MEASURED WHERE ITS ACCESS GUARD DECIDED IT LANDS (2026-10-15)
 *
 * Every access guard (UnionCreationGuard, UnionNetworkGuard, PlatformStaffGuard,
 * UnionOverseerGuard, FinancialAdminGate) renders the same status while it asks
 * the database: "Checking Your Access". When the answer is no, the guard
 * replaces the route with <Navigate replace>, for example /unions/create to
 * /community for an account that is not on the union_creators allowlist.
 *
 * The mobile fit audit used to read page.url() after a fixed 2.2 s settle. The
 * capability RPC (with its two read-only retries) can answer after that, so the
 * audit recorded /unions/create as the destination, the guard then redirected
 * while the audit was resizing, and the post-deploy run failed with
 * "unions/create navigated while resizing to tablet". The redirect was the
 * product working; the audit had captured the guard's question instead of its
 * answer (Post-Deploy E2E run 38675266338, 2026-10-15).
 *
 * So the audit waits for the question to be answered before it records where
 * the route landed. A guard that never answers still fails the audit, by name.
 */

export const ACCESS_CHECK_STATUS_TEXT = 'Checking Your Access';

/** The slice of a Playwright Page this needs, so it can be unit tested. */
export interface AccessCheckPage {
  url(): string;
  getByRole(
    role: 'status',
    options: { name?: string | RegExp }
  ): { filter(options: { hasText: string }): { count(): Promise<number> } };
  locator(selector: string): {
    getAttribute(name: string, options?: { timeout: number }): Promise<string | null>;
  };
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * Resolve once no "Checking Your Access" status is on the page. Throws when the
 * check is still pending after `timeoutMs`, which is a guard that cannot decide
 * and is reported as such rather than measured as a page.
 */
export async function awaitAccessDecision(
  page: AccessCheckPage,
  route: string,
  { timeoutMs = 15_000, pollMs = 250 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = await page
      .getByRole('status', {})
      .filter({ hasText: ACCESS_CHECK_STATUS_TEXT })
      .count();
    if (pending === 0) {
      await captureResponsiveDestination(page, { timeoutMs, pollMs, deadline });
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${route || 'home'} access guard did not decide within ${timeoutMs} ms`);
    }
    await page.waitForTimeout(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** The workspace owns its hydration and complete canonical URL acknowledgement.
 * Its semantic busy state does not depend on directory reads or live sync. */
export async function captureResponsiveDestination(
  page: AccessCheckPage,
  {
    timeoutMs = 10_000,
    pollMs = 100,
    deadline = Date.now() + timeoutMs,
  }: { timeoutMs?: number; pollMs?: number; deadline?: number } = {}
): Promise<string> {
  const began = new URL(page.url());
  if (!/\/clubs\/[^/]+\/members\/?$/.test(began.pathname)) return page.url();
  const remaining = () => {
    const timeout = deadline - Date.now();
    if (timeout <= 0)
      throw new Error(`Roster preference workspace did not settle within ${timeoutMs} ms`);
    return { timeout };
  };
  for (;;) {
    const busy = await page.locator('.members-console').getAttribute('aria-busy', remaining());
    remaining();
    const current = new URL(page.url());
    if (current.origin !== began.origin || current.pathname !== began.pathname) {
      throw new Error('Roster preference workspace navigated while settling');
    }
    if (busy === 'false') return page.url();
    if (Date.now() >= deadline)
      throw new Error(`Roster preference workspace did not settle within ${timeoutMs} ms`);
    await page.waitForTimeout(Math.min(pollMs, remaining().timeout));
  }
}
