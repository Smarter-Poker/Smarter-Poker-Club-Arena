import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceBetween } from './helpers/sourceWindow';
import { readDailyChallengesUnit } from './helpers/dailyChallengesSources';

const PAGE = readFileSync(resolve('src/pages/DailyChallengesPage.tsx'), 'utf8');
const ACTIONS = readDailyChallengesUnit('useDailyMissionActions.ts');

describe('Daily Challenges repaired accessibility contracts', () => {
  it('names the page with a hidden heading in both first and loaded paint', () => {
    // Dan 2026-10-17: no visible page title, so no wrapped title to hold a
    // full line of ink. Both paints keep the h1 for screen readers.
    const shell = readFileSync(
      resolve('src/components/challenges/DailyChallengesRouteFallback.tsx'),
      'utf8'
    );
    expect(shell).toContain('<h1 className={styles.srOnly}>{TITLES[tier]}</h1>');
    const shellCss = readFileSync(
      resolve('src/components/challenges/DailyChallengesRouteFallback.module.css'),
      'utf8'
    );
    expect(sliceBetween(shellCss, '.srOnly {', '}')).toContain('clip: rect(0, 0, 0, 0);');
    expect(readDailyChallengesUnit('MissionHero.tsx')).toContain('titleId="missions-title"');
    expect(readDailyChallengesUnit('MissionLoadingState.tsx')).toContain(
      '<h1 className={styles.srOnly}>{presentation.title}</h1>'
    );
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
