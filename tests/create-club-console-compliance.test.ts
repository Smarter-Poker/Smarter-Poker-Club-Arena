import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceBetween, sliceCssRule } from './helpers/sourceWindow';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const createClub = read('src/components/modals/CreateClubModal.tsx');
const createClubCss = read('src/components/modals/CreateClubModal.module.css');
const openingWizard = read('src/components/club/ClubOpeningWizard.tsx');
const openingWizardCss = read('src/components/club/ClubOpeningWizard.css');
const launchProgress = read('src/components/club/ClubLaunchProgress.tsx');
const launchProgressCss = read('src/components/club/ClubLaunchProgress.css');

const visualCss = [createClubCss, openingWizardCss, launchProgressCss].join('\n');

/** Every value a property is given in a sheet, comments stripped, whitespace folded. */
const declarationsOf = (css: string, property: string) =>
  [
    ...css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'g')),
  ].map((match) => match[1].replace(/\s+/g, ' ').trim());

/** Split a shadow list on its top-level commas only. */
const shadowLayers = (value: string) => {
  const layers: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      layers.push(current.trim());
      current = '';
    } else current += char;
  }
  layers.push(current.trim());
  return layers;
};

/** The master's engraved rule: a one-pixel light line, no blur, no spread. */
const ENGRAVED_RULE = /^(?:inset )?0 1px 0 rgb\(255 255 255 \/ (?:[0-9]|1[0-2])%\)$/;

/** The console element and everything printed inside it. */
const createConsoleJsx = sliceBetween(createClub, '<SpadeConsole', '</SpadeConsole>');

describe('#ClubArenaConsole Create A Club compliance', () => {
  it('uses the approved painted console chassis for every direct creation surface', () => {
    for (const surface of [createClub, openingWizard, launchProgress]) {
      expect(surface).toContain('import { SpadeConsole }');
      expect(surface).toContain('<SpadeConsole');
    }

    // Create A Club (#4696) wears an approved kit head (it passes no crest, so
    // the spade master's own), prints both actions on the plates painted into
    // the foot, and its own sheet paints no frame art of any kind.
    const createCrest = createClub.match(/crest="([a-z]+)"/)?.[1];
    if (createCrest) expect(['spade', 'flat', 'diamond', 'vip', 'club']).toContain(createCrest);
    expect(createConsoleJsx).toContain('plates={{');
    expect(createClubCss).not.toMatch(/url\(/);
    expect(openingWizard).toContain('crest="club"');
    expect(launchProgress).toContain('crest="diamond"');
  });

  it('never builds the chassis, frames, or action plates from generic CSS effects', () => {
    expect(visualCss).not.toMatch(/(?:linear|radial)-gradient\s*\(/i);

    // The wizard and the launch checklist refuse every radius and every shadow.
    const declarations = [openingWizardCss, launchProgressCss]
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const radii = declarations.filter((line) => line.startsWith('border-radius:'));
    const shadows = declarations.filter((line) => line.startsWith('box-shadow:'));

    expect(radii.every((line) => line === 'border-radius: 0 !important;')).toBe(true);
    expect(shadows.every((line) => line === 'box-shadow: none !important;')).toBe(true);

    // Create A Club (#4696) refuses the same corners and draws no drop shadow,
    // bevel or glow. Its only shadows are the master's engraved rule under a
    // row or a groove (skill section 4, Step 5), which is a hairline, not chrome.
    const createRadii = declarationsOf(createClubCss, 'border-radius');
    const createShadows = declarationsOf(createClubCss, 'box-shadow');
    expect(createRadii.length).toBeGreaterThan(0);
    expect(createShadows.length).toBeGreaterThan(0);
    for (const radius of createRadii) expect(radius).toMatch(/^0(?: !important)?$/);
    for (const shadow of createShadows) {
      const layers = shadow.replace(/\s*!important$/, '');
      if (layers === 'none') continue;
      for (const layer of shadowLayers(layers)) expect(layer).toMatch(ENGRAVED_RULE);
    }
  });

  it('keeps the creation page full-height, scrollable, and its painted actions reachable', () => {
    expect(createClubCss).toContain('position: fixed');
    expect(sliceCssRule(createClubCss, '.modalContainer')).toMatch(/height:\s*100dvh/);
    expect(createClubCss).toContain('flex: 1 1 auto');
    expect(createClubCss).toContain('overflow-y: auto');
    // The console fills the stage and only its own body scrolls, so the plates
    // painted into the foot, after the scroll body, never leave the screen.
    expect(sliceCssRule(createClubCss, '.stage')).toMatch(/overflow:\s*hidden/);
    expect(sliceCssRule(createClubCss, '.console > :global(.sc__body)')).toMatch(
      /flex:\s*1 1 auto/
    );
    expect(sliceCssRule(createClubCss, '.scrollBody')).toMatch(/overflow-y:\s*auto/);
    expect(createConsoleJsx).toContain('className={styles.scrollBody}');
    expect(createConsoleJsx.indexOf('plates={{')).toBeLessThan(
      createConsoleJsx.indexOf('className={styles.scrollBody}')
    );
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
