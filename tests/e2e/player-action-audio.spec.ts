import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let script: string;
test.beforeAll(async () => {
  const built = await build({
    entryPoints: [resolve('tests/e2e/fixtures/playerActionAudio.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: {
      'import.meta.env': JSON.stringify({
        PROD: false,
        DEV: true,
        VITE_SUPABASE_URL: 'http://127.0.0.1:9',
        VITE_SUPABASE_ANON_KEY: 'isolated-fixture',
      }),
    },
  });
  script = built.outputFiles[0].text;
});

for (const width of [393, 1440]) {
  test(`real player action audio is distinct, scaled and bounded at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent('<button>Enable Sounds</button>');
    await page.addScriptTag({ content: script });
    await page.getByRole('button', { name: 'Enable Sounds' }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).audioFixture.state()))
      .toBe('running');
    const metrics = await page.evaluate(async () => {
      const fixture = (window as any).audioFixture;
      fixture.closeLive();
      return {
        call: await fixture.render([{ action: 'call' }]),
        raise: await fixture.render([{ action: 'raise' }]),
        large: await fixture.render([{ action: 'raise', amount: 60 }]),
        quiet: await fixture.render([{ action: 'raise' }], 0.2),
        rapid: await fixture.render([
          { action: 'raise' },
          { action: 'call', at: 0.02 },
          { action: 'raise', at: 0.04 },
        ]),
      };
    });
    expect(metrics.call.duration).toBeLessThan(0.12);
    expect(metrics.raise.duration).toBeGreaterThan(0.35);
    expect(metrics.large.duration).toBeGreaterThan(metrics.raise.duration);
    expect(metrics.large.rms).toBeGreaterThan(metrics.raise.rms * 1.25);
    expect(metrics.quiet.rms).toBeLessThan(metrics.raise.rms * 0.4);
    expect(metrics.raise.rms).toBeGreaterThan(metrics.call.rms);
    expect(metrics.raise.rms).toBeLessThan(metrics.call.rms * 2);
    for (const audio of Object.values(metrics) as { peak: number; rms: number }[]) {
      expect(audio.peak).toBeLessThan(1);
      expect(audio.rms).toBeGreaterThan(0);
    }
    await info.attach(`action-audio-${width}.json`, {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });
  });
}
