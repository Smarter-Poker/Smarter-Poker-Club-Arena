import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const executable = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function sources(path: string): string[] {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(`${path}/${entry.name}`)
      : /\.(tsx?|css)$/.test(entry.name)
        ? [`${path}/${entry.name}`]
        : []
  );
}

describe('owner prohibition on opponent HUDs', () => {
  it('all table and tournament presentation paths have no opponent HUD, style badge or classifier', () => {
    for (const path of [
      ...sources('src/components/table'),
      ...sources('src/components/tournament'),
      'src/pages/TablePage.tsx',
    ]) {
      if (path.endsWith('.css')) continue;
      const code = executable(read(path));
      expect(code, path).not.toMatch(
        /<MiniHUD\b|className=["'](?:mini-hud|seat__style-badge|ft-player__style)\b|playerStyleClassifier|hudStatsProvider\s*=/
      );
    }
  });
  it('the keyboard cannot toggle an opponent HUD', () => {
    expect(executable(read('src/hooks/useTableKeyboard.ts'))).not.toContain('onToggleStats');
    expect(executable(read('src/pages/TablePage.tsx'))).not.toMatch(
      /userSettings\.showHUD|onToggleStats/
    );
  });
});
