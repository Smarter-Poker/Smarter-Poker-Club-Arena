import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expectMissionArtworkDecoded,
  installMissionArtObservation,
} from '../support/dailyMissionArtObservation';

// Credential-free browser regression. Every response comes from this test's
// localhost server; it never opens the app or calls a production data API.
for (const brokenDiamond of [false, true]) {
  test(`Daily Missions observes late artwork after timeline overflow (broken=${brokenDiamond})`, async ({
    browser,
  }) => {
    const artwork = resolve(import.meta.dirname, '../../../public/images/challenges');
    const hero = readFileSync(resolve(artwork, 'daily-missions-casino-v2.webp'));
    const diamond = readFileSync(resolve(artwork, 'daily-missions-diamond-96-v1.webp'));
    const server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      if (path === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html><main id="daily-missions"><div data-hero-cycle="daily"><img width="96" height="96" src="/images/challenges/daily-missions-casino-v2.webp"></div></main>'
        );
      } else if (path === '/images/challenges/daily-missions-casino-v2.webp') {
        response.setHeader('Content-Type', 'image/webp');
        response.end(hero);
      } else if (path === '/images/challenges/daily-missions-diamond-96-v1.webp') {
        response.setHeader('Content-Type', 'image/webp');
        response.end(brokenDiamond ? 'not an image' : diamond);
      } else {
        response.setHeader('Content-Type', 'text/plain');
        response.end('padding');
      }
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local fixture port');
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      await page.addInitScript(installMissionArtObservation);
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.evaluate(async () => {
        // Consume bodies so each completed request has a resource timing.
        for (let index = 0; index < 280; index++) await (await fetch(`/padding/${index}`)).text();
      });
      await page.waitForFunction(() => (window.__dailyMissionArt?.resourcesSeen ?? 0) >= 281);
      await page.evaluate(() => {
        const image = new Image();
        image.width = 96;
        image.height = 96;
        image.src = '/images/challenges/daily-missions-diamond-96-v1.webp';
        document.querySelector('#daily-missions')!.append(image);
      });
      await page.waitForFunction(() =>
        window.__dailyMissionArt?.missionArt.some((asset) => asset.name.includes('diamond'))
      );
      const evidence = await page.evaluate(() => {
        const observation = window.__dailyMissionArt!;
        observation.finish();
        return {
          overflowed: observation.timelineOverflowed,
          seen: observation.resourcesSeen,
          art: observation.missionArt,
          oldTimeline: performance
            .getEntriesByType('resource')
            .filter((entry) =>
              /\/images\/challenges\/daily-missions-(?:casino|diamond)/.test(entry.name)
            )
            .map((entry) => new URL(entry.name).pathname.split('/').pop()),
        };
      });
      expect(evidence.overflowed).toBe(true);
      expect(evidence.seen).toBeGreaterThan(250);
      // This is exactly the old production failure while the image is present.
      expect(evidence.oldTimeline).toEqual(['daily-missions-casino-v2.webp']);
      expect(evidence.art.map((asset) => asset.name)).toEqual([
        'daily-missions-casino-v2.webp',
        'daily-missions-diamond-96-v1.webp',
      ]);
      expect(evidence.art.map((asset) => asset.bytes)).toEqual([
        hero.byteLength,
        brokenDiamond ? Buffer.byteLength('not an image') : diamond.byteLength,
      ]);
      if (brokenDiamond) {
        await expect(expectMissionArtworkDecoded(page)).rejects.toThrow(
          'Mission artwork did not decode'
        );
      } else {
        await expectMissionArtworkDecoded(page);
      }
    } finally {
      await context.close();
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done()))
      );
    }
  });
}
