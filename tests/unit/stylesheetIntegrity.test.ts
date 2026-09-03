/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A STYLESHEET WITH A STRANDED SELECTOR IS NOT A STYLESHEET
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Defect, found 2026-08-25 and shipped to production before it was:
 *
 *   .status-dot.running,
 *   /* TOURNAMENT CARD * /
 *   .empty-tables { text-align: center; padding: 2rem; color: #888; }
 *
 * A bulk deletion of dead rules removed the declaration BLOCKS and left the
 * selectors and their trailing commas behind. A comma does not end a rule, so
 * each orphan simply joined the NEXT rule's selector list — `.status-dot` on
 * every page that renders one silently inherited `.empty-tables`' centred grey
 * padding. The second occurrence was worse: two orphans swallowed an
 * `@keyframes`, so the at-rule stopped existing and an invalid qualified rule
 * shipped in its place.
 *
 * PostCSS parses all of that without complaint, which is why the deletion
 * looked clean. What follows checks the two shapes a stranded selector makes.
 *
 * Scoped to the stylesheets this repo hand-edits most; the cost is a few
 * milliseconds and the failure it catches is invisible in review.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..', 'src');

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Strip comments so a comma inside prose cannot look like a selector list. */
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const files = cssFiles(SRC);

describe('no stylesheet has a selector stranded by a deletion', () => {
  it('finds css to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))(
    '%s: no selector list runs into an at-rule',
    (_name, file) => {
      const src = withoutComments(readFileSync(file, 'utf8'));
      /* `foo,` followed by `@media` / `@keyframes` / `@supports`: the at-rule
         is being read as part of the selector list, so it no longer exists. */
      const swallowed = src.match(/^[^\n{}]*,[ \t]*\n\s*@[a-z-]+/gm) || [];
      expect(swallowed, `stranded selector before an at-rule:\n${swallowed.join('\n')}`).toEqual(
        []
      );
    }
  );

  it.each(files.map((f) => [path.relative(SRC, f), f]))(
    '%s: no selector list runs into a closing brace',
    (_name, file) => {
      const src = withoutComments(readFileSync(file, 'utf8'));
      // `foo,` followed by `}` — the rule it belonged to is gone entirely.
      const dangling = src.match(/^[^\n{}]*,[ \t]*\n\s*\}/gm) || [];
      expect(dangling, `selector list ends in a comma:\n${dangling.join('\n')}`).toEqual([]);
    }
  );
});

describe('every keyframes animation this page declares is used', () => {
  /* Two orphan keyframes (liveCardGlow, cardScanSweep) survived the card-grid
     removal because nothing fails when an animation is merely unreferenced.
     They are also exactly what a stranded selector hides behind. */
  it('ClubHomePage.css declares no unused @keyframes', () => {
    const file = path.join(SRC, 'pages/ClubHomePage.css');
    const src = readFileSync(file, 'utf8');
    const declared = [...src.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const unused = declared.filter((name) => {
      const uses = src.split(new RegExp(`\\b${name}\\b`)).length - 1;
      return uses <= 1; // only the declaration itself
    });
    expect(unused, `unused keyframes: ${unused.join(', ')}`).toEqual([]);
  });
});
