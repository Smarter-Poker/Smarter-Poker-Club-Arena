/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: ONE NAME REACHES THE PUBLIC SURFACES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AEO phase 2, 2026-09-17. The arena answers to three names: Poker Arena in
 * the title and the manifest, Club Arena in this repository and the publish
 * path, Diamond Arena inside the product. An AI engine that meets all three
 * files them as three products and splits whatever authority each has earned.
 *
 * The fix is not a rename of the whole application: what the app calls itself
 * in a wallet dialog or a tournament ticker is a branding decision, and a
 * blanket rename breaks copy this estate pins on purpose (measured: seven law
 * files). It is narrower and it is the part that matters here. The surfaces a
 * crawler can actually read - the prerendered landing, the Help Center, the
 * title, the manifest and the schema - say POKER ARENA, once, and the schema
 * declares the other names as alternates so an engine can unify them itself.
 *
 * So this pins two things:
 *
 *   1. the prerendered public copy does not say Club Arena;
 *   2. the SoftwareApplication node is named Poker Arena and keeps Club Arena
 *      as an alternateName, which is how an engine learns they are one thing.
 *
 * Legal documents are deliberately out of scope: they are contracts, and the
 * name in them is the owner's to change, not a search optimisation.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** The files whose words are rendered into the prerendered public pages. */
const PUBLIC_COPY = [
  'src/pages/helpContent.ts',
  'src/prerender/HelpPrerender.tsx',
  'src/pages/HelpPage.tsx',
];

describe('one name reaches the public surfaces', () => {
  it('the prerendered public copy calls it Poker Arena', () => {
    for (const file of PUBLIC_COPY) {
      const visible = read(file)
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');
      expect(visible, `${file} still says Club Arena in copy a crawler reads`).not.toMatch(
        /Club Arena/
      );
    }
  });

  it('the schema names Poker Arena and keeps the other names as alternates', () => {
    const seo = read('src/lib/seo.ts');
    expect(seo).toMatch(/name: 'Poker Arena'/);
    // alternateName is how an engine is told these are one entity, so it must
    // keep naming the alias rather than quietly dropping it.
    expect(seo).toMatch(/alternateName: \[[^\]]*'Club Arena'/);
  });
});
