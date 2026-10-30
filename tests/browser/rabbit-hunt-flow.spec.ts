import { expect, test } from '@playwright/test';
test.beforeEach(async ({ context, page }, testInfo) => {
  if (testInfo.project.name === 'desktop-cpu4') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await context.addInitScript(() => {
    const token = `e30.${btoa(JSON.stringify({ sub: '11111111-2222-4333-8444-555555555555', session_id: 'rabbit-browser-fixture', exp: 4102444800 }))}.sig`;
    localStorage.setItem(
      'smarter-poker-auth',
      JSON.stringify({
        access_token: token,
        refresh_token: 'fixture',
        expires_at: 4102444800,
        expires_in: 3600,
        token_type: 'bearer',
        user: { id: '11111111-2222-4333-8444-555555555555' },
      })
    );
  });
  await context.route(/\/auth\/v1\//, (r) =>
    r.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { user: { id: '11111111-2222-4333-8444-555555555555' } },
    })
  );
  await context.route(/\/rest\/v1\//, (r) =>
    r.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: [] })
  );
  await page.goto('tests/browser/fixtures/rabbit-flow/index.html', {
    waitUntil: 'domcontentloaded',
  });
});
test('a slow paid response survives closing its tile and restores into hand review exactly once', async ({
  page,
}) => {
  let requests = 0;
  let releaseResponse!: () => void;
  const responseHeld = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/rabbit-hunt', async (route) => {
    requests++;
    // Keep the response pending until the browser observes the slow state and
    // closes the tile. A wall-clock delay races WebKit's rendering schedule.
    await responseHeld;
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        success: true,
        cards: [
          { rank: '2', suit: 'h' },
          { rank: '9', suit: 's' },
        ],
        diamonds_spent: 5,
      },
    });
  });
  try {
    await page.getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' }).click();
    await expect(page.getByText('Still Connecting...', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Review Hand', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Hand Detail', exact: true })).toBeVisible();
    expect(requests).toBe(1);
    releaseResponse();
    await expect(page.locator('.hdm-card--rabbit')).toHaveCount(2);
    expect(requests).toBe(1);
    await expect(page.getByText('Hand 42 · Only You', { exact: true })).toBeVisible();
  } finally {
    releaseResponse();
  }
});
test('the next hand preserves revealed nodes and completed flips release their compositor hint', async ({
  page,
}, testInfo) => {
  await page.route('**/rabbit-hunt', (r) =>
    r.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        success: true,
        cards: [
          { rank: '2', suit: 'h' },
          { rank: '9', suit: 's' },
        ],
        diamonds_spent: 5,
      },
    })
  );
  const sample = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const times: number[] = [];
        const start = performance.now();
        let last = start;
        const frame = (now: number) => {
          times.push(now - last);
          last = now;
          if (now - start < 1000) requestAnimationFrame(frame);
          else resolve(times);
        };
        requestAnimationFrame(frame);
      })
  );
  await page.getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' }).click();
  const cards = page.locator('.community-cards__card--rabbit');
  await expect(cards).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .locator('.community-cards__rabbit-flip')
        .first()
        .evaluate((el) => getComputedStyle(el).willChange)
    )
    .toBe('auto');
  const frames = (await sample).sort((a, b) => a - b);
  const positions = await cards.evaluateAll((els) =>
    els.map((el, i) => {
      el.setAttribute('data-original', String(i));
      return el.getBoundingClientRect().x;
    })
  );
  await page.getByRole('button', { name: 'Next Hand', exact: true }).click();
  expect(
    await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-original')))
  ).toEqual(['0', '1']);
  const next = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().x));
  next.forEach((x, i) => expect(Math.abs(x - positions[i])).toBeLessThan(1));
  await expect(page.getByText('Previous Hand · Only You')).toBeVisible();
  await testInfo.attach('rabbit-reveal', {
    body: await page.screenshot({ path: testInfo.outputPath('rabbit-reveal.png') }),
    contentType: 'image/png',
  });
  const metrics = await page.locator('.community-cards__rabbit-flip').evaluateAll((els) =>
    els.map((el) => ({
      willChange: getComputedStyle(el).willChange,
      duration: getComputedStyle(el).animationDuration,
      delay: getComputedStyle(el).animationDelay,
      active: el.getAnimations().filter((a) => a.playState === 'running').length,
    }))
  );
  expect(metrics.every((x) => x.active === 0)).toBe(true);
  console.log(
    'RABBIT_MOTION_METRICS',
    JSON.stringify({
      project: testInfo.project.name,
      frames: frames.length,
      p95FrameMs: frames[Math.floor(frames.length * 0.95)],
      maxFrameMs: frames.at(-1),
      cards: metrics,
    })
  );
  await testInfo.attach('animation-metrics', {
    body: JSON.stringify({
      cards: metrics,
      frames: frames.length,
      p95FrameMs: frames[Math.floor(frames.length * 0.95)],
      maxFrameMs: frames.at(-1),
    }),
    contentType: 'application/json',
  });
});

test('a lost response recovers the same hand and keeps the server receipt charge singular', async ({
  page,
}) => {
  let calls = 0;
  let charges = 0;
  const bodies: unknown[] = [];
  await page.route('**/rabbit-hunt', async (route) => {
    calls++;
    bodies.push(route.request().postDataJSON());
    if (calls === 1) {
      charges++;
      await route.abort('connectionreset');
      return;
    }
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        success: true,
        source: 'already_revealed',
        diamonds_spent: 0,
        cards: [
          { rank: '2', suit: 'h' },
          { rank: '9', suit: 's' },
        ],
      },
    });
  });
  await page.getByRole('button', { name: 'Review Hand', exact: true }).click();
  await page.getByRole('button', { name: 'Show What Would Have Come', exact: true }).click();
  await page.getByRole('button', { name: 'Recover This Hand', exact: true }).click();
  await expect(page.locator('.hdm-card--rabbit')).toHaveCount(2);
  expect(calls).toBe(2);
  expect(charges).toBe(1);
  expect(bodies).toEqual([
    { tableId: 'fixture-table', handNumber: 42 },
    { tableId: 'fixture-table', handNumber: 42 },
  ]);
});

test('a stalled recovery chunk times out before billing and cannot charge when it arrives late', async ({
  page,
  context,
}) => {
  let purchases = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route('**/*rabbitHuntReceipts*.js', async (route) => {
    await hold;
    await route.continue();
  });
  await page.route('**/rabbit-hunt', async (route) => {
    purchases++;
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        success: true,
        cards: [
          { rank: '2', suit: 'h' },
          { rank: '9', suit: 's' },
        ],
        diamonds_spent: 5,
      },
    });
  });
  await page.getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' }).click();
  await expect(page.getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' })).toBeEnabled({
    timeout: 10000,
  });
  expect(purchases).toBe(0);
  release();
  await expect(page.getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' })).toBeEnabled();
  await page.getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' }).click();
  await expect(page.locator('.community-cards__card--rabbit')).toHaveCount(2);
  expect(purchases).toBe(1);
});

test('a purchase accepted before expiry stays visible until its delayed result arrives', async ({
  page,
}) => {
  await page.clock.install();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Review Hand', exact: true }).click();
  await page.clock.fastForward(88000);
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/rabbit-hunt', async (route) => {
    requests++;
    await gate;
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        success: true,
        cards: [
          { rank: '2', suit: 'h' },
          { rank: '9', suit: 's' },
        ],
        diamonds_spent: 5,
      },
    });
  });
  await page.getByRole('button', { name: 'Show What Would Have Come', exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.clock.fastForward(3000);
  await expect(
    page.getByRole('button', { name: 'Still Connecting...', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Still Connecting...', exact: true })
  ).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('rabbit-pending-after-expiry.png') });
  release();
  await expect(page.locator('.hdm-card--rabbit')).toHaveCount(2);
  expect(requests).toBe(1);
});
