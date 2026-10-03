import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Club Data painted-console contract', () => {
  it('uses intentional approved console families and only finished crests', () => {
    const clubData = read('src/pages/club/ClubDataPage.tsx');
    const rake = read('src/components/club/RakeSnapshotPanel.tsx');
    const union = read('src/pages/UnionDataPage.tsx');

    expect(clubData).toContain('family="spade"');
    expect(clubData).toContain('family="shark"');
    expect(clubData).toContain('family="riveted"');
    expect(rake).toContain('family="shark"');
    expect(union).toContain('family="riveted"');
    expect(`${clubData}\n${rake}\n${union}`).not.toMatch(/crest="(?:club|diamond)"/);
  });

  it('keeps Union Data navigation on painted plates and title-cases its live label', () => {
    const union = read('src/pages/UnionDataPage.tsx');
    const header = read('src/components/rewards/RewardsSurfaceHeader.tsx');

    expect(header).toContain('family?: ConsoleFamily;');
    expect(header).toContain('family={family}');
    expect(union).toContain('plates={{');
    expect(union).toContain('titleCase(unionName)');
    expect(union).not.toContain('className={styles.headerBtn}');
    expect(union).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*?setUnionName\(null\)/);
    expect(union).toContain("reportError(error, 'UnionDataPage.union_name')");
    expect(union).toContain("reportError(error, 'UnionDataPage.club_count')");
  });

  it('uses organic period words instead of generic arrow glyph controls', () => {
    const clubData = read('src/pages/club/ClubDataPage.tsx');

    expect(clubData).not.toMatch(/&#(?:8592|8594);/);
    expect(clubData).toContain('Previous');
    expect(clubData).toContain('Next');
  });

  it('keeps the connected financial health consoles on explicit approved families', () => {
    for (const path of [
      'src/pages/FinancialHealthPage.tsx',
      'src/pages/FinancialAlertsPage.tsx',
      'src/pages/DriftIncidentsPage.tsx',
    ]) {
      const source = read(path);
      const consoles = source.match(/<SpadeConsole\b[\s\S]*?>/g) ?? [];
      expect(consoles.length, `${path} has no painted consoles`).toBeGreaterThan(0);
      for (const consoleTag of consoles) {
        expect(consoleTag, `${path} falls back to the default console family`).toMatch(
          /family="(?:spade|shark|riveted)"/
        );
        expect(consoleTag).not.toMatch(/crest="(?:club|diamond)"/);
      }
    }
  });
});
