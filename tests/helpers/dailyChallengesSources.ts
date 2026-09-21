import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Source readers for the Daily Challenges surface.
 *
 * The page is decomposed into focused units under `DASHBOARD_DIR`, and its
 * stylesheet into layer partials stitched by the module manifest. Source-text
 * pins that describe one unit read that unit; pins that describe the whole
 * surface (negatives such as "no setInterval anywhere", or counts across the
 * page and its units) read the stitched surface so an extraction can never
 * move a pinned behaviour out of sight.
 */
export const ROOT = join(__dirname, '..', '..');
export const PAGE_PATH = 'src/pages/DailyChallengesPage.tsx';
export const STYLESHEET_PATH = 'src/pages/DailyChallengesPage.module.css';
export const DASHBOARD_DIR = 'src/components/challenges/dashboard';

const read = (relativePath: string) => readFileSync(join(ROOT, relativePath), 'utf8');

export function readDailyChallengesPage(): string {
  return read(PAGE_PATH);
}

/** One focused unit, by file name inside `DASHBOARD_DIR` (for example `MissionCard.tsx`). */
export function readDailyChallengesUnit(name: string): string {
  return read(join(DASHBOARD_DIR, name));
}

function listDashboardUnits(): string[] {
  const dir = join(ROOT, DASHBOARD_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => join(DASHBOARD_DIR, name))
    .filter((relativePath) => statSync(join(ROOT, relativePath)).isFile())
    .sort();
}

/** The page plus every unit it was decomposed into, joined by newlines. */
export function readDailyChallengesSurface(): string {
  return [PAGE_PATH, ...listDashboardUnits()].map(read).join('\n');
}

/**
 * The page stylesheet with every `@import './...'` partial inlined in manifest
 * order, so CSS pins see the complete text exactly as the bundler scopes it.
 */
export function readDailyChallengesStylesheet(): string {
  const seen = new Set<string>();
  const inline = (absolutePath: string): string => {
    if (seen.has(absolutePath)) return '';
    seen.add(absolutePath);
    const source = readFileSync(absolutePath, 'utf8');
    return source.replace(/^@import\s+['"](\.[^'"]+)['"]\s*;\s*$/gm, (_match, relative: string) =>
      inline(resolve(dirname(absolutePath), relative))
    );
  };
  return inline(join(ROOT, STYLESHEET_PATH));
}
