import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { waitForLeaderboardEntryMotion } from '../support/leaderboardMotion';

test('leaderboard contrast certification waits for actual entrance motion and retains contrast refusal', async ({
  page,
}) => {
  const css =
    readFileSync('src/pages/LeaderboardPage.css', 'utf8') +
    readFileSync('src/styles/animations.css', 'utf8');
  await page.setContent(
    `<style>body{background:#000}${css}</style><main class="leaderboard-page"><div class="club-page-body"><div class="podium-section" style="opacity:0;animation:animationsFadeInUp 0.7s ease-out forwards">${[1, 2, 3].map((i) => `<div class="podium-place"><div class="entry-info"><span class="entry-name">Player ${i}</span><span class="entry-vip-tag">VIP</span><div class="entry-subline">13.7K Hands</div></div></div>`).join('')}</div></div></main>`
  );
  await page.evaluate(() => {
    const motion = document.querySelector('.podium-section')!.getAnimations()[0];
    motion.pause();
    motion.currentTime = 120;
  });
  const contrastNodes = async () =>
    (await new AxeBuilder({ page }).include('main').analyze()).violations
      .filter((v) => v.id === 'color-contrast')
      .flatMap((v) => v.nodes);
  expect(await contrastNodes()).toHaveLength(9);
  await page.evaluate(() => document.querySelector('.podium-section')!.getAnimations()[0].play());
  await waitForLeaderboardEntryMotion(page, 'main', 'Original Entrance');
  expect(await contrastNodes()).toHaveLength(0);
  // The motion wait must not turn a genuinely unreadable settled palette green.
  await page.addStyleTag({ content: '.leaderboard-page .entry-name{color:#333}' });
  await waitForLeaderboardEntryMotion(page, 'main', 'Unreadable Settled Palette');
  expect(await contrastNodes()).toHaveLength(3);
});
