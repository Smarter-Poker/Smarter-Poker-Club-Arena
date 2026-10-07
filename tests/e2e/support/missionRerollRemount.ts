import { expect, type Page, type Request } from '@playwright/test';
import { titleCase } from '../../../src/utils/titleCase';

/** Prove persisted rerolls by unmounting the panel and reading its next native dashboard. */
export async function remountConcurrentMissionReceipts(options: {
  page: Page;
  navigate: (route: string) => Promise<void>;
  replacements: { rowId: string; catalogId: string }[];
  balance: number;
  timeoutMs: number;
  attach: (observation: object) => Promise<void>;
}) {
  const { page, navigate, replacements, balance, timeoutMs, attach } = options;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('The concurrent reroll persistence deadline expired.');
    return left;
  };
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('The concurrent reroll persistence deadline expired.')),
            remaining()
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let rerollRequests = 0;
  let armed = false;
  const freshRequests = new Set<Request>();
  const onRequest = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (armed && path.endsWith('/rest/v1/rpc/get_daily_challenge_dashboard_v3'))
      freshRequests.add(request);
    if (path.endsWith('/rest/v1/rpc/reroll_daily_challenge')) rerollRequests += 1;
  };
  page.on('request', onRequest);
  try {
    await bounded(navigate('notifications'));
    await expect(page.locator('#daily-missions')).toHaveCount(0, { timeout: remaining() });
    armed = true;
    const dashboard = page
      .waitForResponse(
        (response) =>
          freshRequests.has(response.request()) &&
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith(
            '/rest/v1/rpc/get_daily_challenge_dashboard_v3'
          ),
        { timeout: remaining() }
      )
      .then(
        (response) => ({ response }),
        (error: unknown) => ({ error })
      );
    // The handled result owns timeout rejection even if navigation fails first.
    await bounded(navigate('challenges'));
    const result = await dashboard;
    if ('error' in result) throw result.error;
    const response = result.response;
    expect(response.ok(), 'The remounted mission dashboard must succeed.').toBe(true);
    const body = await bounded(response.json());
    expect(body.diamondBalance).toBe(balance);
    expect(Array.isArray(body.missions)).toBe(true);
    await expect(page.locator('#daily-missions')).toHaveAttribute('aria-busy', 'false', {
      timeout: remaining(),
    });
    for (const replacement of replacements) {
      const rows = body.missions.filter(
        (row: { id: string; challenge_id: string }) =>
          row.id === replacement.rowId && row.challenge_id === replacement.catalogId
      );
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].name).toBe('string');
      expect(rows[0].name.trim().length).toBeGreaterThan(0);
      const card = page.locator(`#mission-card-${replacement.rowId}`);
      await expect(card).toBeVisible({ timeout: remaining() });
      await expect(card).toContainText(titleCase(rows[0].name), { timeout: remaining() });
    }
    await expect(
      page.getByText('Available Diamonds', { exact: true }).locator('..').locator('strong')
    ).toHaveText(balance.toLocaleString(), { timeout: remaining() });
    await expect(page.getByText('Live Now')).toBeVisible({ timeout: remaining() });
    expect(rerollRequests, 'Panel recovery must not submit another financial operation.').toBe(0);
    await bounded(
      attach({
        kind: 'spa_panel_remount',
        documentReloadProven: false,
        panelUnmounted: true,
        dashboardStatus: response.status(),
        exactReplacementCount: replacements.length,
        balance,
        rerollRequests,
      })
    );
  } finally {
    page.off('request', onRequest);
  }
}
