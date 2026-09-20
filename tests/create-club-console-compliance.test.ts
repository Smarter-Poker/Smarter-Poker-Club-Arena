import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const createClub = read('src/components/modals/CreateClubModal.tsx');
const createClubCss = read('src/components/modals/CreateClubModal.module.css');
const openingWizard = read('src/components/club/ClubOpeningWizard.tsx');
const openingWizardCss = read('src/components/club/ClubOpeningWizard.css');
const launchProgress = read('src/components/club/ClubLaunchProgress.tsx');
const launchProgressCss = read('src/components/club/ClubLaunchProgress.css');

const visualCss = [createClubCss, openingWizardCss, launchProgressCss].join('\n');

describe('#ClubArenaConsole Create A Club compliance', () => {
  it('uses the approved painted console chassis for every direct creation surface', () => {
    for (const surface of [createClub, openingWizard, launchProgress]) {
      expect(surface).toContain('import { SpadeConsole }');
      expect(surface).toContain('<SpadeConsole');
    }

    expect(createClub).toContain('crest="club"');
    expect(openingWizard).toContain('crest="club"');
    expect(launchProgress).toContain('crest="diamond"');
  });

  it('never builds the chassis, frames, or action plates from generic CSS effects', () => {
    expect(visualCss).not.toMatch(/(?:linear|radial)-gradient\s*\(/i);

    const declarations = visualCss
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const radii = declarations.filter((line) => line.startsWith('border-radius:'));
    const shadows = declarations.filter((line) => line.startsWith('box-shadow:'));

    expect(radii.every((line) => line === 'border-radius: 0 !important;')).toBe(true);
    expect(shadows.every((line) => line === 'box-shadow: none !important;')).toBe(true);
  });

  it('keeps the creation page full-height, scrollable, and its painted actions reachable', () => {
    expect(createClubCss).toContain('position: fixed');
    expect(createClubCss).toContain('height: calc(100dvh');
    expect(createClubCss).toContain('flex: 1 1 auto');
    expect(createClubCss).toContain('overflow-y: auto');
    expect(openingWizardCss).toContain('min-height: 100dvh');
    expect(openingWizardCss).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(openingWizardCss).toContain('grid-template-rows: auto minmax(0, 1fr) auto');
  });

  it('uses ten curated crest renders and offers no AI image generator', () => {
    const presets = createClub.match(/club-logos\/preset-\d+\.webp/g) ?? [];
    expect(new Set(presets).size).toBe(10);
    expect(createClub).not.toContain('Generate With AI');
    expect(createClub).not.toContain('Create Image With AI');
    expect(createClub).not.toContain('Generate A Club Logo');
  });

  it('uses words rather than emoji or symbolic completion furniture', () => {
    expect(openingWizard).not.toContain("'✓'");
    expect(launchProgress).not.toContain("'✓'");
    expect(openingWizard).toContain("index < step ? 'Done'");
    expect(launchProgress).toContain("task.complete ? 'Done'");
  });

  it('removes the completed checklist rather than leaving a decorative 100 percent gate', () => {
    expect(launchProgress).toContain('if (allTasksResolved) return null;');
  });
});
