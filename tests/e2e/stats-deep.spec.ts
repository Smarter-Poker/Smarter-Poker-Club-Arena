import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Request } from '@playwright/test';
import { mountStatsPaneBeforeDebounce } from './support/statsClock';
import { recordNonVerdict } from './support/nonVerdict';

test.describe('Player Stats production experience', () => {
  // The overview rollup is intentionally exhaustive and can take several
  // seconds for the production canary account. Running all three viewport/a11y
  // probes at once creates an artificial three-query cold-start stampede and
  // can push otherwise healthy reads past the authenticated statement limit.
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test.beforeEach(async ({ page }, testInfo) => {
    const configuredBase = String(testInfo.project.use.baseURL || 'http://localhost:5173/');
    const base = new URL(configuredBase);
    test.skip(
      ['localhost', '127.0.0.1'].includes(base.hostname) &&
        (!process.env.SP_EMAIL || !process.env.SP_PASS),
      'local Hub authentication is not configured'
    );
    const statsUrl = base.pathname.includes('/hub/club-arena')
      ? new URL('stats', configuredBase).toString()
      : new URL('/hub/club-arena/stats', configuredBase).toString();
    await page.goto(statsUrl);
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(
        async () =>
          page.url().includes('/auth') ||
          (await page.getByRole('tab', { name: 'Overview' }).count()) > 0 ||
          (await page.getByText("Couldn't Load Your Stats", { exact: true }).count()) > 0,
        { timeout: 60_000 }
      )
      .toBe(true);
    test.skip(page.url().includes('/auth'), 'authenticated Stats session is not configured');
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Player Intelligence' })).toBeAttached({
      timeout: 30_000,
    });
  });

  test('loads the real Stats route and completes dossier shortcuts', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const shortcut = page.getByRole('button', { name: 'Open Deep Analysis' });
    if (await shortcut.isVisible()) {
      await shortcut.click();
      const analysis = page.getByRole('tab', { name: 'Analysis' });
      await expect(analysis).toHaveAttribute('aria-selected', 'true');
      await expect(analysis).toBeFocused();
      await expect(page.locator('#stats-panel-analysis')).toBeVisible();
    }
  });

  test('published downline pagination survives the initial debounce and resets only for changed search', async ({
    page,
  }, testInfo) => {
    // Use the lane's existing isolated session. Ledger reads and their change
    // detector are synthetic; authentication and published JS/CSS assets stay real.
    const expected = process.env.DOWNLINE_JOURNEY_SHA;
    if (!expected || expected === 'UNKNOWN') {
      const description = await recordNonVerdict(testInfo, {
        title: 'The Stats journey source pin is unavailable',
        detail:
          'The closed source resolver did not qualify this journey; the original job pin cannot substitute for it.',
        evidence: { originalJobSha: process.env.LIVE_SHA, journeySha: expected ?? null },
      });
      console.log(
        `[downline-journey-release] ${JSON.stringify({ originalJobSha: process.env.LIVE_SHA, journeySha: expected ?? null, status: 'unknown' })}`
      );
      test.skip(true, description);
    }
    expect(expected, 'The closed Stats resolver must supply its exact client SHA').toMatch(
      /^[a-f0-9]{40}$/
    );
    const bracket: Array<{
      point: string;
      origin: string;
      sha: string | null;
      reason: string | null;
    }> = [];
    const release = async (point: 'before' | 'after') => {
      const reads = await Promise.all(
        ['https://ca-static.smarter.poker', 'https://smarter.poker/hub/club-arena'].map(
          async (origin) => {
            let sha: string | null = null;
            let reason: string | null = null;
            try {
              const response = await page.request.get(
                `${origin}/build-info.json?downline-journey=${Date.now()}`,
                {
                  headers: { 'Cache-Control': 'no-cache' },
                }
              );
              if (!response.ok()) reason = 'build_info_unreadable';
              else {
                const value = (await response.json()).ca_sha;
                if (typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)) sha = value;
                else reason = 'build_info_identity_unreadable';
              }
            } catch {
              reason = 'build_info_unreadable';
            }
            return { point, origin, sha, reason };
          }
        )
      );
      bracket.push(...reads);
      console.log(`[downline-journey-release] ${JSON.stringify({ expected, point, reads })}`);
      if (reads.some((read) => read.reason || read.sha !== expected)) {
        const description = await recordNonVerdict(testInfo, {
          title: 'Published downline pagination release was not established',
          detail:
            'Both origins must serve the exact qualified Stats client before and after this journey.',
          evidence: { originalJobSha: process.env.LIVE_SHA, expected, bracket },
        });
        test.skip(true, description);
      }
    };
    await release('before');
    const reads: Array<{ limit: number; search: string | null }> = [];
    const warmupReads: Array<{ limit: number; search: string | null }> = [];
    const blockedWrites: string[] = [];
    const pendingRest = new Set<Request>();
    const started = (request: Request) => {
      if (new URL(request.url()).pathname.includes('/rest/v1/')) pendingRest.add(request);
    };
    const finished = (request: Request) => pendingRest.delete(request);
    page.on('request', started);
    page.on('requestfinished', finished);
    page.on('requestfailed', finished);
    let armed = false;
    let clockInstalled = false;
    const syntheticClub = 'ee871000-0000-4000-8000-000000000001';
    await page.route('**/rest/v1/**', async (route) => {
      const request = route.request();
      const rpc = new URL(request.url()).pathname.split('/rpc/')[1];
      if (rpc === 'fn_my_agent_roles') {
        await route.fulfill({
          json: [
            {
              club_id: syntheticClub,
              club_name: 'Isolated Pagination Fixture',
              role: 'agent',
              agent_id: 'ee871000-0000-4000-8000-000000000002',
              is_overseer: false,
            },
          ],
        });
      } else if (rpc === 'ca_player_stats_pulse' || rpc === 'ca_player_stats_pulse_by_club') {
        // The synthetic ledger cannot follow this account's live tournament
        // fingerprint. A real pulse change correctly refreshes the expanded
        // ledger, independently of the search debounce under test. Keep this
        // fixture's change input stable; retain the exact request sequence below.
        await route.fulfill({ json: { pulse: 'isolated-pagination-unchanged' } });
      } else if (rpc === 'fn_agent_downline_rake') {
        const body = request.postDataJSON();
        expect(body.p_club_id).toBe(syntheticClub);
        reads.push({ limit: body.p_limit, search: body.p_search });
        const count = body.p_limit === 501 ? 501 : 620;
        await route.fulfill({
          json: Array.from({ length: count }, (_, index) => ({
            player_id: `isolated-pagination-${index}`,
            username: `Fixture Player ${index}`,
            club_id: syntheticClub,
            club_name: 'Isolated Pagination Fixture',
            role: 'player',
            depth: 1,
            upline_user_id: null,
            upline_name: null,
            rake_generated: index + 1,
            hands: index + 2,
            last_hand_at: null,
            downline_players: 0,
            downline_rake: 0,
          })),
        });
      } else if (rpc === 'fn_agent_downline_rake_summary') {
        await route.fulfill({
          json: {
            period_start: null,
            period_end: null,
            members: 620,
            active: 620,
            direct: 620,
            sub_agents: 0,
            hands: 1000,
            rake_generated: 620,
            commission_rate: 0.2,
            estimated_commission: 124,
            last_hand_at: null,
            top_earner: null,
          },
        });
      } else if (armed && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        // During the bounded component interaction, no unknown RPC or REST
        // mutation may escape to the production database. Never log payloads.
        blockedWrites.push(rpc || request.method());
        await route.abort('blockedbyclient');
      } else {
        await route.fallback();
      }
    });
    try {
      // Install before the new document imports Framer: its frame scheduler
      // captures requestAnimationFrame at module initialization. Keep it running
      // through warmup and initial reads; pause only for the fresh timed mount.
      await page.clock.install({ time: Date.now() });
      clockInstalled = true;
      await page.reload();
      const overview = page.getByRole('tab', { name: 'Overview', exact: true });
      const rake = page.getByRole('tab', { name: 'Rake', exact: true });
      const panel = page.getByRole('region', { name: 'Downline Rake Ledger' });
      await expect(overview).toBeVisible();
      await expect(rake).toBeVisible();
      // Resolve the real lazy chunks and auth-backed RPC transport while time
      // runs normally. A cold import can finish after runFor has returned; its
      // passive work must not be mistaken for a failed ledger response.
      await rake.click();
      await expect(panel.getByRole('row')).toHaveCount(501);
      warmupReads.push(...reads.splice(0));
      expect(warmupReads).toEqual([{ limit: 501, search: null }]);
      await overview.click();
      await expect(page.locator('#stats-panel-overview')).toBeVisible();
      await expect(panel).toHaveCount(0);
      await expect(page.locator('.stats-range-status.is-refreshing')).toHaveCount(0);
      await expect.poll(() => pendingRest.size).toBe(0);
      // This is a new component mount, with its own initial debounce. The
      // outgoing animation consumes 220ms, leaving the initial 300ms timer
      // unexpired when Show More is clicked, including on the old component.
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
      const pausedRows = async (count: number) => {
        await expect
          .poll(async () => {
            // Flush only work due now after asynchronous responses. Wall-clock
            // polling never consumes the remaining debounce budget.
            await page.clock.runFor(0);
            return panel.getByRole('row').count();
          })
          .toBe(count);
      };
      // Private record READY schedules the parent's 2s coalesced refresh.
      // A completed warmup REST request does not mean that timer has fired.
      // Drain that startup deadline while the ledger is unmounted, before its
      // initial search debounce exists. This advances virtual time, not a sleep.
      await page.clock.runFor(2_000);
      // Settle the reads started by the startup timer before the fresh mount.
      await expect
        .poll(async () => {
          await page.clock.runFor(0);
          return pendingRest.size;
        })
        .toBe(0);
      armed = true;
      await rake.click();
      await mountStatsPaneBeforeDebounce(page, page.locator('#stats-panel-rake'));
      await expect(page.locator('#stats-panel-rake')).toBeVisible();
      await pausedRows(501);
      expect(reads).toEqual([{ limit: 501, search: null }]);
      await panel.getByRole('button', { name: 'Show 500 More Members' }).click();
      await pausedRows(621);
      expect(reads).toEqual([
        { limit: 501, search: null },
        { limit: 1001, search: null },
      ]);
      await page.clock.runFor(300);
      await pausedRows(621);
      await expect(panel.getByRole('button', { name: 'Show 500 More Members' })).toHaveCount(0);
      expect(reads).toHaveLength(2);
      await panel.getByRole('textbox', { name: 'Search Downline Players' }).fill('river');
      await page.clock.runFor(299);
      expect(reads).toHaveLength(2);
      await page.clock.runFor(1);
      await pausedRows(501);
      expect(reads).toEqual([
        { limit: 501, search: null },
        { limit: 1001, search: null },
        { limit: 501, search: 'river' },
      ]);
      expect(blockedWrites).toEqual([]);
    } finally {
      armed = false;
      page.off('request', started);
      page.off('requestfinished', finished);
      page.off('requestfailed', finished);
      try {
        if (clockInstalled) await page.clock.resume();
        await page.unroute('**/rest/v1/**');
      } finally {
        // Read even after an assertion failure: a concurrent publish is a
        // non-verdict, never evidence that the expected UI regressed.
        await release('after');
      }
    }
    await testInfo.attach('published-downline-pagination', {
      body: JSON.stringify({
        clientSha: expected,
        originalJobSha: process.env.LIVE_SHA,
        bracket,
        syntheticReadResponses: true,
        actualPublishedAssets: true,
        reads,
        warmupReads,
        blockedWrites: 0,
      }),
      contentType: 'application/json',
    });
  });

  test('traverses every owner Stats surface and preserves club and range scope', async ({
    page,
  }) => {
    for (const tabName of [
      'Performance',
      'Positions',
      'Hands',
      'Tournaments',
      'Analysis',
      'Trophies',
      'Rake',
      'Workspace',
      'Overview',
    ]) {
      const tab = page.getByRole('tab', { name: tabName });
      await expect(tab, `${tabName} must remain available`).toBeVisible();
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`#stats-panel-${tabName.toLowerCase()}`)).toBeVisible();
    }

    const clubGroup = page.getByRole('group', { name: 'Statistics Club' });
    const clubButtons = clubGroup.getByRole('button');
    await expect(clubButtons.first()).toHaveText('All Clubs');
    expect(await clubButtons.count()).toBeGreaterThan(2);
    await clubButtons.nth(1).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('statsClub')).not.toBeNull();

    await page.getByRole('button', { name: '30 Days' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe('30d');

    const compare = page.getByRole('button', { name: 'Compare Clubs' });
    await expect(compare).toBeVisible();
    await compare.click();
    await expect(page.getByRole('heading', { name: 'Club Comparison' })).toBeVisible();
    await page.getByRole('button', { name: 'Profit' }).click();
    await expect(page.getByRole('button', { name: 'Profit' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
    expect(new URL(page.url()).searchParams.get('statsClub')).not.toBeNull();
    expect(new URL(page.url()).searchParams.get('range')).toBe('30d');
    expect(new URL(page.url()).searchParams.get('clubSort')).toBe('profit');
  });

  for (const width of [375, 393]) {
    test(`fits a ${width}px phone and keeps all interactive targets usable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.reload();
      await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: 'Player Intelligence' })).toBeAttached();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);

      const shortTargets = await page
        .locator('.stats-page button:visible, .stats-page summary:visible')
        .evaluateAll((targets) =>
          targets
            .map((target) => ({
              label: (target.textContent || '').trim(),
              height: target.getBoundingClientRect().height,
            }))
            .filter((target) => target.height < 44)
        );
      expect(shortTargets).toEqual([]);
    });
  }

  test('stays operable at 200 percent zoom without page overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    const selectedTab = page.getByRole('tab', { selected: true });
    await expect(selectedTab).toBeFocused();
    await expect(selectedTab).toBeVisible();
  });

  test('has no serious or critical automated accessibility violations', async ({ page }) => {
    const results = await new AxeBuilder({ page }).include('.stats-page').analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact || '')
      )
    ).toEqual([]);
  });
});
