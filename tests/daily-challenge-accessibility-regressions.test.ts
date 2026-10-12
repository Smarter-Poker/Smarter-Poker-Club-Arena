import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceBetween } from './helpers/sourceWindow';
import { readDailyChallengesUnit } from './helpers/dailyChallengesSources';

const PAGE = readFileSync(resolve('src/pages/DailyChallengesPage.tsx'), 'utf8');
const ACTIONS = readDailyChallengesUnit('useDailyMissionActions.ts');

describe('Daily Challenges repaired accessibility contracts', () => {
  it('gives wrapped mission headings at least one full line of ink in both first and loaded paint', () => {
    for (const path of [
      'src/pages/daily-challenges/10-hero.base.module.css',
      'src/components/challenges/DailyChallengesRouteFallback.module.css',
    ]) {
      const css = readFileSync(resolve(path), 'utf8');
      const heading = sliceBetween(css, '.heroCopy h1 {', '}');
      const lineHeight = Number(heading.match(/line-height:\s*([\d.]+);/)?.[1]);
      expect(lineHeight, path).toBeGreaterThanOrEqual(1);
      expect(heading, path).toContain('overflow-wrap: anywhere;');
    }
  });

  it('keeps Escape available after focus leaves the inline reroll confirmation', () => {
    expect(ACTIONS).toMatch(
      /if \(!confirmingRerollId\) return undefined;[\s\S]*window\.addEventListener\('keydown', onKey\)[\s\S]*window\.removeEventListener\('keydown', onKey\)/
    );
    expect(ACTIONS).toContain("if (event.key === 'Escape') setConfirmingRerollId(null)");
  });

  it('exposes one streak value while keeping the adjacent reactor decorative', () => {
    const STREAK = readDailyChallengesUnit('MissionStreakConsole.tsx');
    const visualStart = STREAK.indexOf('<span className={styles.streakFireVisual}');
    const copyStart = STREAK.indexOf('<div className={styles.streakInfo}', visualStart);
    expect(visualStart).toBeGreaterThan(-1);
    expect(copyStart).toBeGreaterThan(visualStart);

    const visual = STREAK.slice(visualStart, copyStart);
    const copy = sliceBetween(
      STREAK,
      '<div className={styles.streakInfo}',
      '<div className={styles.milestoneTracker}'
    );
    expect(visual).toContain('aria-hidden="true"');
    expect(visual).toContain('variant="streak"');
    expect(visual).toContain("? 'active' : 'idle'");
    expect(copy).toContain('id="streak-console-title"');
    expect(copy).toContain('Day Streak');
  });
});
