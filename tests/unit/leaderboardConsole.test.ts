import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const files = [
  'src/pages/LeaderboardPage',
  'src/components/leaderboard/LeaderboardPrizeWizard',
  'src/components/leaderboard/LeaderboardSettlementCard',
  'src/components/table/LeaderboardPanel',
];
describe('Leaderboard Painted Console Contract', () => {
  it.each(files)('%s contains no substitute artwork or generic icon glyphs', (file) => {
    const source = readFileSync(`${file}.tsx`, 'utf8');
    const css = readFileSync(`${file}.css`, 'utf8');
    expect(source).not.toMatch(/[◆◈♛★▦▤▲▼≡]/u);
    expect(css).not.toMatch(
      /(?:linear|radial)-gradient|:hover|championship-machine|backdrop-filter/
    );
    expect(css).not.toMatch(/(?:animation|transition):\s*none/);
  });
  it('keeps the settlement unframed and the wizard on a single painted two-action foot', () => {
    expect(
      readFileSync('src/components/leaderboard/LeaderboardSettlementCard.tsx', 'utf8')
    ).not.toContain('SpadeConsole');
    const wizard = readFileSync('src/components/leaderboard/LeaderboardPrizeWizard.tsx', 'utf8');
    expect(wizard.match(/<SpadeConsole\b/g)).toHaveLength(1);
    expect(wizard).toContain('plates={{');
    /* Was step="0.01" (2026-09-20 pin). Prize places are whole chips now:
       forward-facing figures carry no decimals, and the splits the wizard
       shows must be the exact whole-chip list it publishes
       (tests/components/leaderboardPrizeWizardWholeChips.test.tsx). */
    expect(wizard).toContain('step="1"');
    expect(wizard).not.toContain('step="0.01"');
    expect(wizard).toContain('value={row.amount');
    expect(readFileSync('src/components/leaderboard/LeaderboardPrizeWizard.css', 'utf8')).toContain(
      'z-index: 10050'
    );
    expect(readFileSync('src/components/table/LeaderboardPanel.css', 'utf8')).toContain(
      'z-index: 600'
    );
  });
  it('keeps period-specific prizes out of the all-recorded tournament view', () => {
    const page = readFileSync('src/pages/LeaderboardPage.tsx', 'utf8');
    expect(page).toContain('All Recorded Tournaments');
    expect(page).toMatch(
      /activeTab === 'rankings' && scope === 'my-clubs' && settings\?\.setup_complete/
    );
    expect(page).toContain('data-label="Total Prizes"');
    expect(page).toContain('data-label="Biggest Win"');
  });
  it('uses the approved off-felt console ink for positive table leaderboard values', () => {
    const css = readFileSync('src/components/table/LeaderboardPanel.css', 'utf8');
    expect(css).toMatch(/\.leaderboard-row__amount--positive\s*\{\s*color:\s*#c8ffd2;/);
  });
  it('keeps promotion row feedback when reduced motion is requested', () => {
    const css = readFileSync('src/components/leaderboard/LeaderboardCard.module.css', 'utf8');
    expect(css).not.toMatch(/(?:animation|transition):\s*none/);
    expect(css).toContain('transition: opacity 0.2s ease-out');
  });
});
