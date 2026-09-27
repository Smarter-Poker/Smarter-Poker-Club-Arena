import { expect, type Page } from '@playwright/test';

type MissionArt = { name: string; bytes: number };
type MissionArtObservation = {
  resourcesSeen: number;
  timelineOverflowed: boolean;
  missionArt: MissionArt[];
  finish: () => void;
};

declare global {
  interface Window {
    __dailyMissionArt?: MissionArtObservation;
  }
}

/** Runs before navigation. Observer delivery survives the browser's 250-entry timeline limit. */
export function installMissionArtObservation(): void {
  const observation: MissionArtObservation = {
    resourcesSeen: 0,
    timelineOverflowed: false,
    missionArt: [],
    finish: () => {},
  };
  const collect = (entries: PerformanceEntry[]) => {
    observation.resourcesSeen += entries.length;
    for (const entry of entries) {
      const resource = entry as PerformanceResourceTiming;
      const path = new URL(resource.name).pathname;
      if (
        /\/images\/challenges\/daily-missions-(?:casino-v2(?:-mobile)?|diamond-96-v1)\.webp$/.test(
          path
        )
      ) {
        observation.missionArt.push({
          name: path.split('/').pop()!,
          bytes: resource.encodedBodySize,
        });
      }
    }
  };
  const observer = new PerformanceObserver((list) => collect(list.getEntries()));
  const overflow = () => {
    observation.timelineOverflowed = true;
  };
  performance.addEventListener('resourcetimingbufferfull', overflow);
  observer.observe({ type: 'resource', buffered: true });
  observation.finish = () => {
    collect(observer.takeRecords());
    observer.disconnect();
    performance.removeEventListener('resourcetimingbufferfull', overflow);
  };
  window.__dailyMissionArt = observation;
}

/** A successful request alone cannot certify a decoded image on the mounted page. */
export async function expectMissionArtworkDecoded(page: Page): Promise<void> {
  for (const selector of [
    '#daily-missions [data-hero-cycle] img',
    '#daily-missions img[src$="daily-missions-diamond-96-v1.webp"]',
  ]) {
    const image = page.locator(selector).first();
    await expect(image).toBeVisible();
    await expect
      .poll(
        () =>
          image.evaluate((element) => {
            const image = element as HTMLImageElement;
            return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
          }),
        { timeout: 4_000, message: `Mission artwork did not decode: ${selector}` }
      )
      .toBe(true);
  }
  // Let decoded pixels paint and deliver their LCP entry before sampling.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      })
  );
}
