import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { supabaseServerHeaders } from '../../../scripts/ci/supabase-auth-headers.mjs';
import {
  requireCustomizationCertificationEnvironment,
  readServiceRows,
  insertServiceRows,
  deleteServiceRows,
} from '../support/temporaryCustomizationAccount';
import { expect, test, type Response } from '@playwright/test';

const clubId = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const tableResponse = (response: Response, table: string) => {
  const url = new URL(response.url());
  return url.pathname.endsWith(`/rest/v1/${table}`) && response.request().method() === 'GET';
};

const expectPhoneFit = async (page: import('@playwright/test').Page) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
};

test.describe('Visible achievement and rate history readers', () => {
  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Reserved authenticated production fixture is required.'
  );

  test('reads the signed-in achievement progress again while the page stays visible', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const reads: Response[] = [];
    page.on('response', (response) => {
      if (tableResponse(response, 'training_user_achievements')) reads.push(response);
    });
    await page.goto('achievements', { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(
      page.getByRole('heading', { name: 'Achievement Archive', exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => reads.length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
    const first = reads[0];
    const ownerFilter = new URL(first.url()).searchParams.get('user_id');
    expect(ownerFilter).toMatch(/^eq\.[0-9a-f-]{36}$/);
    for (const response of [first, reads.at(-1)!]) {
      expect(response.status()).toBe(200);
      const url = new URL(response.url());
      expect(url.searchParams.get('user_id')).toBe(ownerFilter);
      expect(url.searchParams.get('select')).toBe('id,achievement_id,user_id,progress,unlocked_at');
      const rows = await response.json();
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows) expect(`eq.${row.user_id}`).toBe(ownerFilter);
    }
    await expect(
      page.getByRole('button', { name: 'Open Getting Started', exact: true })
    ).toBeVisible();
    await expect(
      page.getByText('Achievement progress could not be loaded.', { exact: true })
    ).toHaveCount(0);
    // Read-only proof: no unlock, reward, financial command or fixture mutation.
  });

  test('reads both club-scoped rate histories again without a WAL subscription', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const reads = new Map<string, Response[]>([
      ['commission_rate_audit', []],
      ['rake_rate_audit', []],
    ]);
    page.on('response', (response) => {
      for (const [table, list] of reads) if (tableResponse(response, table)) list.push(response);
    });
    await page.goto(`rate-audit?club=${clubId}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Rate Audit Trail', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => Math.min(...[...reads.values()].map((list) => list.length)), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);
    let expectedCount = 0;
    for (const list of reads.values()) {
      for (const response of [list[0], list.at(-1)!]) {
        expect(response.status()).toBe(200);
        const url = new URL(response.url());
        expect(url.searchParams.get('club_id')).toBe(`eq.${clubId}`);
        expect(url.searchParams.get('limit')).toBe('100');
        expect(Array.isArray(await response.json())).toBe(true);
      }
      expectedCount += (await list.at(-1)!.json()).length;
    }
    await expect(page.getByText(`${expectedCount} Changes`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    const filterGroups = page.getByRole('group', { name: /Rate Type|Reading Window/ });
    await expect(filterGroups).toHaveCount(2);
    const controls = filterGroups.getByRole('button');
    await expect(controls).toHaveCount(7);
    for (const control of await controls.all()) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expectPhoneFit(page);
  });

  test('reads the scoped settlement ledger on a phone without substituting an empty state', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const reads: Response[] = [];
    page.on('response', (response) => {
      if (tableResponse(response, 'settlement_invoices')) reads.push(response);
    });

    await page.goto(`settlement-history?club=${clubId}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(
      page.getByRole('heading', { name: 'Settlement History', exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => reads.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

    const response = reads.at(-1)!;
    expect(response.status()).toBe(200);
    const url = new URL(response.url());
    expect(url.searchParams.get('select')?.replace(/\s/g, '')).toBe(
      'id,period_id,invoice_type,gross_amount,net_amount,breakdown,status,created_at'
    );
    expect(url.searchParams.get('club_id')).toBe(`eq.${clubId}`);
    expect(url.searchParams.get('invoice_type')).toBe('eq.union_to_club');
    expect(url.searchParams.get('breakdown->>union_hold_amount')).toBe('not.is.null');
    expect(url.searchParams.get('breakdown->>club_retained')).toBe('not.is.null');
    expect(url.searchParams.get('limit')).toBe('50');
    const rows = await response.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length, 'the settlement observer needs a real rendered cycle').toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await expect(page.getByText('No Settlement Cycles Yet', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^Period:/).first()).toBeVisible({ timeout: 30_000 });
    await expectPhoneFit(page);
  });
  test('a reserved owner notification invalidates progress without inventing an unlock', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fixturePath = process.env.E2E_TEST_ACCOUNT_FILE;
    if (!fixturePath) throw new Error('The existing reserved account record is required.');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const ownerId = String(fixture.id || '');
    const email = String(fixture.email || '');
    if (
      !/^[0-9a-f-]{36}$/i.test(ownerId) ||
      !email.startsWith('ca-customization-cert-postdeploy-') ||
      !email.endsWith('@example.invalid') ||
      email !== process.env.SP_EMAIL ||
      !Number.isFinite(Date.parse(fixture.createdAt)) ||
      Math.abs(Date.now() - Date.parse(fixture.createdAt)) > 2 * 60 * 60_000
    ) {
      throw new Error('Refusing a notification fixture outside this run reserved identity.');
    }
    const environment = requireCustomizationCertificationEnvironment();
    const identityResponse = await fetch(
      `${environment.supabaseUrl}/auth/v1/admin/users/${ownerId}`,
      { headers: supabaseServerHeaders(environment.serviceRoleKey) }
    );
    expect(identityResponse.status).toBe(200);
    const identity = await identityResponse.json();
    expect(identity.id).toBe(ownerId);
    expect(identity.email).toBe(email);
    const progressQuery = new URLSearchParams({
      select: 'id,achievement_id,user_id,progress,unlocked_at',
      user_id: `eq.${ownerId}`,
      achievement_id: 'eq.hands_100',
    });
    const before = await readServiceRows<{ progress: number; unlocked_at: string | null }>(
      environment,
      'training_user_achievements',
      progressQuery
    );
    expect(before.every((row) => !row.unlocked_at && Number(row.progress) < 100)).toBe(true);

    const fixtureIds = [randomUUID(), randomUUID()];
    const topic = `realtime:achievement-notifications-${ownerId}`;
    let ownerJoin = false;
    const delivered = new Set<string>();
    const reads: Response[] = [];
    let startedReads = 0;
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname.endsWith('/rest/v1/training_user_achievements') &&
        request.method() === 'GET'
      )
        startedReads++;
    });
    page.on('response', (response) => {
      if (tableResponse(response, 'training_user_achievements')) reads.push(response);
    });
    page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          const frameTopic = Array.isArray(frame) ? frame[2] : frame.topic;
          const event = Array.isArray(frame) ? frame[3] : frame.event;
          const body = Array.isArray(frame) ? frame[4] : frame.payload;
          if (frameTopic === topic && event === 'phx_join') {
            ownerJoin =
              body?.config?.postgres_changes?.some(
                (binding: any) =>
                  binding.table === 'notifications' &&
                  binding.event === 'INSERT' &&
                  binding.filter === `user_id=eq.${ownerId}`
              ) === true;
          }
        } catch {
          /* Unrelated non-JSON frame. Never retain authentication payloads. */
        }
      });
      socket.on('framereceived', ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          const frameTopic = Array.isArray(frame) ? frame[2] : frame.topic;
          const event = Array.isArray(frame) ? frame[3] : frame.event;
          const body = Array.isArray(frame) ? frame[4] : frame.payload;
          const row = body?.data?.record;
          if (
            frameTopic === topic &&
            event === 'postgres_changes' &&
            row?.user_id === ownerId &&
            fixtureIds.includes(row?.id)
          )
            delivered.add(row.id);
        } catch {
          /* Unrelated non-JSON frame. */
        }
      });
    });
    try {
      await page.goto('achievements', { waitUntil: 'domcontentloaded' });
      await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
      await expect(
        page.getByRole('button', { name: 'Open Getting Started', exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => ownerJoin, { timeout: 20_000 }).toBe(true);
      await expect.poll(() => reads.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
      for (const response of reads) {
        expect(response.status()).toBe(200);
        expect(new URL(response.url()).searchParams.get('user_id')).toBe(`eq.${ownerId}`);
      }
      // Initial load and subscription/rejoin reads have both completed.
      await Promise.all(reads.map((response) => response.finished()));
      const beforeWrongType = startedReads;
      const notification = (id: string, type: string) => ({
        id,
        user_id: ownerId,
        type,
        title: 'Reserved Notification Read Certification',
        message: 'Temporary In-App Carrier Fixture',
        data: {
          achievement_id: 'hands_100',
          source: 'achievement-read-certification',
          _push: 'in-app-only',
        },
      });
      await insertServiceRows(environment, 'notifications', notification(fixtureIds[0], 'system'));
      await expect.poll(() => delivered.has(fixtureIds[0]), { timeout: 15_000 }).toBe(true);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
      expect(startedReads).toBe(beforeWrongType);
      const nextRead = page.waitForResponse(
        (response) => tableResponse(response, 'training_user_achievements'),
        { timeout: 15_000 }
      );
      await insertServiceRows(
        environment,
        'notifications',
        notification(fixtureIds[1], 'achievement')
      );
      await expect.poll(() => delivered.has(fixtureIds[1]), { timeout: 15_000 }).toBe(true);
      const response = await nextRead;
      expect(response.status()).toBe(200);
      expect(new URL(response.url()).searchParams.get('user_id')).toBe(`eq.${ownerId}`);
      const rows = await response.json();
      expect(rows.filter((row: any) => row.achievement_id === 'hands_100')).toEqual(before);
      await expect(page.getByText('Achievement Unlocked!', { exact: true })).toHaveCount(0);
      expect(
        await readServiceRows(environment, 'training_user_achievements', progressQuery)
      ).toEqual(before);
    } finally {
      const exactFixture = new URLSearchParams({
        id: `in.(${fixtureIds.join(',')})`,
        user_id: `eq.${ownerId}`,
        'data->>source': 'eq.achievement-read-certification',
      });
      await deleteServiceRows(environment, 'notifications', exactFixture);
      expect(
        await readServiceRows(
          environment,
          'notifications',
          new URLSearchParams({
            select: 'id',
            id: `in.(${fixtureIds.join(',')})`,
            user_id: `eq.${ownerId}`,
          })
        )
      ).toEqual([]);
    }
  });
});
