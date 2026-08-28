import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const componentSource = readFileSync(
  resolve(root, 'src/components/club-buttons/ClubButtons.tsx'),
  'utf8'
);
const componentCss = readFileSync(
  resolve(root, 'src/components/club-buttons/club-buttons.css'),
  'utf8'
);
const showcaseSource = readFileSync(
  resolve(root, 'src/pages/dev/ClubButtonsShowcasePage.tsx'),
  'utf8'
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('#ClubButtons factory scope', () => {
  it('keeps product modes inside the laboratory without authorizing product migration', () => {
    expect(componentSource).toContain(
      "export type ClubButtonsMode = 'arena' | 'hub' | 'commander'"
    );
    expect(showcaseSource).toContain('Factory Preview Mode');
    expect(showcaseSource).toContain('Future World Hub Adapter');
    expect(showcaseSource).toContain('Future Commander Adapter');
  });

  it('does not install tokens or native-control rules globally', () => {
    expect(componentCss).not.toMatch(/(^|\})\s*:root\s*\{/m);
    expect(componentCss).not.toMatch(/^\s*(?:button|input|select|textarea|a|\*)\b/m);
  });

  it('is consumed only by the Club Arena showcase, approved lobby, and approved BBJ page', () => {
    const consumers = sourceFiles(resolve(root, 'src'))
      .filter((path) => readFileSync(path, 'utf8').includes('components/club-buttons'))
      .map((path) => relative(resolve(root, 'src'), path))
      .sort();

    expect(consumers).toEqual([
      'pages/BadBeatJackpotPage.tsx',
      'pages/ClubHomePage.tsx',
      'pages/dev/ClubButtonsShowcasePage.tsx',
    ]);
  });

  it('ships every purpose-specific factory shell as a lossless master and runtime WebP', () => {
    const shells = [
      'action-primary-v2',
      'action-secondary-v2',
      'action-compact-v2',
      'action-danger-v2',
      'utility-chat-v2',
      'utility-stats-v2',
      'utility-time-bank-v2',
      'utility-rabbit-hunt-v2',
      'utility-previous-hand-v2',
      'utility-menu-v2',
      'navigation-console-v2',
      'tabs-subnav-v2',
      'value-display-v2',
      'status-badge-v2',
      'modal-frame-v2',
      'information-panel-v2',
      'input-field-v2',
      'select-control-v2',
      'toggle-control-v2',
    ];

    for (const shell of shells) {
      expect(
        existsSync(resolve(root, `design/club-buttons/production-shells/desktop/${shell}.png`))
      ).toBe(true);
      expect(existsSync(resolve(root, `public/assets/club-buttons/${shell}.webp`))).toBe(true);
    }
  });
});
