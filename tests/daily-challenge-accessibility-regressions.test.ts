import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceBetween } from './helpers/sourceWindow';

const PAGE = readFileSync(resolve('src/pages/DailyChallengesPage.tsx'), 'utf8');

describe('Daily Challenges repaired accessibility contracts', () => {
  it('keeps Escape available after focus leaves the inline reroll confirmation', () => {
    expect(PAGE).toMatch(
      /if \(!confirmingRerollId\) return undefined;[\s\S]*window\.addEventListener\('keydown', onKey\)[\s\S]*window\.removeEventListener\('keydown', onKey\)/
    );
    expect(PAGE).toContain("if (event.key === 'Escape') setConfirmingRerollId(null)");
  });

  it('exposes one streak value while keeping the adjacent reactor decorative', () => {
    const visualStart = PAGE.indexOf('<span className={styles.streakFireVisual}');
    const copyStart = PAGE.indexOf('<div className={styles.streakInfo}', visualStart);
    expect(visualStart).toBeGreaterThan(-1);
    expect(copyStart).toBeGreaterThan(visualStart);

    const visual = PAGE.slice(visualStart, copyStart);
    const copy = sliceBetween(
      PAGE,
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
