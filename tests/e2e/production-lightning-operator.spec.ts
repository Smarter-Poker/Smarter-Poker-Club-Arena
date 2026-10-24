/** Read-only Lightning cold loads. Never submit an operator decision. */
import { expect, test } from '@playwright/test';

const club = process.env.E2E_LIGHTNING_CLUB_ID || '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const overviewRpc = '/rest/v1/rpc/fn_lightning_operator_overview';
const clusterRpc = '/rest/v1/rpc/fn_lightning_operator_cluster';
const readinessRpc = '/rest/v1/rpc/fn_lightning_rollout_readiness';
const unionContextRpc = '/rest/v1/rpc/fn_club_union_context';

for (const width of [393, 1440]) {
  test(`Lightning operator cold load at ${width}px preserves read ownership and cancel`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    expect(
      Boolean(process.env.SP_EMAIL && process.env.SP_PASS),
      'isolated authenticated account required'
    ).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    const writes: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path === '/rest/v1/rpc/fn_lightning_operator_control' ||
        path === '/rest/v1/rpc/fn_lightning_operator_signal_review'
      )
        writes.push(path);
    });
    const ownerContext = page.waitForResponse((r) => new URL(r.url()).pathname === unionContextRpc);
    const overview = page.waitForResponse((r) => new URL(r.url()).pathname === overviewRpc);
    await page.goto(`clubs/${club}/lightning`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/);
    // A member club shows its union's games (#7884): the page resolves the
    // owning scope with fn_club_union_context, and the overview reads that
    // owner. The expected id comes from the same live answer, never a constant.
    const contextResponse = await ownerContext;
    expect(contextResponse.status()).toBe(200);
    expect(contextResponse.request().postDataJSON().p_club_id).toBe(club);
    const contextBody = await contextResponse.json();
    const context = Array.isArray(contextBody) ? contextBody[0] : contextBody;
    const owner: string = context?.own_union_id ?? context?.member_union_id ?? club;
    expect(owner).toMatch(/^[0-9a-f-]{36}$/);
    const response = await overview;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().p_club_id).toBe(owner);
    const body = await response.json();
    expect(body.ok).not.toBe(false);
    expect(Array.isArray(body.clusters)).toBe(true);
    expect(body.clusters.length, 'real Lightning-capable cluster required').toBeGreaterThan(0);
    await expect(page.locator('#lightning-operations-title')).toHaveText('Lightning');
    await expect(page.getByText(/Updates On Lightning Events/)).toBeVisible();
    const candidate = body.clusters.find(
      (row: Record<string, unknown>) =>
        row.cluster_mode === 'must_move' &&
        row.worker_mode === 'off' &&
        row.frozen == null &&
        row.drain == null &&
        Number.isInteger(row.shadow_window_ms) &&
        typeof (row.flags as Record<string, unknown> | undefined)?.integrity_telemetry === 'boolean'
    );
    expect(candidate, 'a drained Must Move cluster with worker off is required').toBeTruthy();
    const record = page.locator(`[data-cluster-id="${candidate.cluster_id}"]`);
    await expect(record).toBeVisible();
    const cluster = await record.getAttribute('data-cluster-id');
    expect(cluster).toMatch(/^[0-9a-f-]{36}$/);
    // A new document with the selected cluster has no SPA overview state.
    const detail = page.waitForResponse((r) => new URL(r.url()).pathname === clusterRpc);
    const readiness = page.waitForResponse((r) => new URL(r.url()).pathname === readinessRpc);
    await page.goto(`clubs/${club}/lightning?cluster=${cluster}`, {
      waitUntil: 'domcontentloaded',
    });
    const detailResponse = await detail;
    expect(detailResponse.status()).toBe(200);
    expect(detailResponse.request().postDataJSON().p_cluster_id).toBe(cluster);
    const detailBody = await detailResponse.json();
    expect(detailBody.ok).not.toBe(false);
    const settings = detailBody.cluster;
    expect(settings.cluster_id).toBe(cluster);
    expect(settings.cluster_mode).toBe('must_move');
    expect(settings.worker_mode).toBe('off');
    expect(settings.frozen).toBeNull();
    expect(settings.drain).toBeNull();
    expect(Number.isInteger(settings.shadow_window_ms)).toBe(true);
    expect(settings.shadow_window_ms).toBeGreaterThanOrEqual(60000);
    expect(settings.shadow_window_ms).toBeLessThanOrEqual(3600000);
    expect(typeof settings.flags.integrity_telemetry).toBe('boolean');
    const readinessResponse = await readiness;
    expect(readinessResponse.status()).toBe(200);
    const gate = await readinessResponse.json();
    expect(gate.ok, 'the actual authorized readiness read must succeed').toBe(true);
    expect(gate.evidence.migrations.missing).toEqual([]);
    expect(Object.keys(gate.evidence.invariants).length).toBeGreaterThan(0);
    for (const name of ['seven_tables', 'anti_manipulation', 'law_10_5', 'no_anon_door'])
      expect(gate.evidence.invariants[name], `readiness invariant ${name}`).toBe(true);
    // SQL explicitly says it does not evaluate live proofs in this read.
    // Those require the separate installed-proof qualification, never this badge.
    expect(gate.evidence.invariants.proofs_evaluated_in_sql).toBe(false);
    // OFF and missing pilot evidence are valid NO_GO; never require an enable decision.
    await expect(page.locator('#lightning-controls')).toHaveText('Operator Controls');
    const setup = page.getByRole('group', {
      name: 'Calibration And Integrity Controls',
      exact: true,
    });
    await expect(setup).toBeVisible();
    const windowControl = setup.getByRole('button', {
      name: 'Set Calibration Window',
      exact: true,
    });
    await expect(windowControl).toBeEnabled();
    await windowControl.click();
    const windowDialog = page.locator('[data-control-dialog="set_shadow_window"]');
    await expect(windowDialog).toBeVisible();
    const milliseconds = windowDialog.getByRole('textbox', { name: /^Window In Milliseconds/ });
    await expect(milliseconds).toHaveValue(String(settings.shadow_window_ms));
    const confirmWindow = windowDialog.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirmWindow).toBeDisabled();
    await windowDialog
      .getByPlaceholder('Why, For The Audit Trail', { exact: true })
      .fill('Read Only Browser Validation');
    for (const invalid of ['59999', '3600001', '60000.5', 'not-a-number']) {
      await milliseconds.fill(invalid);
      await expect(confirmWindow).toBeDisabled();
      await expect(
        windowDialog.getByText('Whole Milliseconds From 60000 To 3600000', { exact: true })
      ).toBeVisible();
    }
    for (const boundary of ['60000', '60001', '3600000']) {
      await milliseconds.fill(boundary);
      await expect(confirmWindow).toBeEnabled();
    }
    await info.attach(`lightning-${width}-window-validation.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await windowDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(windowDialog).toHaveCount(0);
    const telemetryName = settings.flags.integrity_telemetry
      ? 'Disable Integrity Telemetry'
      : 'Enable Integrity Telemetry';
    const telemetry = setup.getByRole('button', { name: telemetryName, exact: true });
    await expect(telemetry).toBeEnabled();
    await telemetry.click();
    const telemetryDialog = page.locator('[data-control-dialog="set_integrity_telemetry"]');
    await expect(telemetryDialog).toBeVisible();
    await expect(
      telemetryDialog.getByText(settings.flags.integrity_telemetry ? 'Turn Off' : 'Turn On', {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      telemetryDialog.getByRole('button', { name: 'Confirm', exact: true })
    ).toBeDisabled();
    await telemetryDialog
      .getByPlaceholder('Why, For The Audit Trail', { exact: true })
      .fill('Read Only Browser Validation');
    await expect(
      telemetryDialog.getByRole('button', { name: 'Confirm', exact: true })
    ).toBeEnabled();
    await info.attach(`lightning-${width}-integrity-confirmation.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await telemetryDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(telemetryDialog).toHaveCount(0);
    const worker = page.getByRole('group', { name: 'Worker Mode', exact: true });
    await expect(worker).toBeVisible();
    await expect(worker.getByRole('button')).toHaveCount(3);
    const available = worker.locator('button:enabled').first();
    await expect(available).toBeVisible();
    await available.click();
    const dialog = page.locator('[data-control-dialog="set_worker_mode"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await info.attach(`lightning-${width}-confirmation.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
    expect(writes, 'opening and canceling a decision must never write').toEqual([]);
    await info.attach(`lightning-${width}-operator.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const build = await page.request.get('build-info.json', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    expect(build.ok()).toBe(true);
    const provenance = await build.json();
    // Which release this ran against is decided by the release bracket the
    // workflow reads around this whole spec ("Classify the release the
    // Lightning operator certificate ran against"), not by an equality here:
    // a forward publish mid-run is an UNKNOWN non-verdict there, and a
    // rollback or off-lineage SHA is a hard red there. This read only proves
    // the served bundle names one full release SHA, and records it.
    const served = provenance.ca_sha;
    expect(served, 'build-info.json must name one full ca_sha').toMatch(/^[0-9a-f]{40}$/);
    info.annotations.push({ type: 'served-release', description: served });
  });
}
