/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLES INTEGRITY GUARD — the 49-item dynamic system must stay whole
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-21 production REGRESSED to the pre-rebuild throwables: a deploy
 * loop on the Mac rebuilt Club Arena from a STALE local checkout (which had
 * never pulled the cloud-pushed v1-v5 work) and synced that old bundle over
 * the World Hub's assets. The source in THIS repo was never broken — the
 * regression happened a layer above it. Two guards came out of that incident:
 *
 *   1. THIS TEST (source level): the 49-item catalog, its per-item sound
 *      recipes, and the per-item signature CSS must stay complete and wired.
 *      Any future edit that guts the catalog, drops a recipe, orphans a
 *      signature, or unwires the imports fails the suite — and the client
 *      test suite gates the bundle.
 *
 *   2. World Hub CHECK "club-arena throwables freshness" (deploy level):
 *      the synced TablePage bundle must contain the v5 marker, so a stale
 *      local build can never silently replace a current one again.
 *
 * If you are here because this test failed: the throwables system is
 * documented in ThrowableService.ts / ThrowAnimation.tsx /
 * ThrowableSignatures.css / ThrowableSoundService.ts. Fix the wiring —
 * do not delete the guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

const service = read('src/services/ThrowableService.ts');
const sound = read('src/services/ThrowableSoundService.ts');
const signatures = read('src/components/table/ThrowableSignatures.css');
const animation = read('src/components/table/ThrowAnimation.tsx');
const image = read('src/components/table/ThrowableImage.tsx');
const selector = read('src/components/table/ThrowableSelector.tsx');

/**
 * Catalog rows are T('id', 'Name', 'category', 'physics', 'impact', 'sound',
 * 'weight', linger, '#color', spin[, '#color2']) — parse them formatting-
 * agnostically (prettier may put every argument on its own line).
 */
function parseCatalog(): Array<{ id: string; sound: string }> {
  const rows: Array<{ id: string; sound: string }> = [];
  const re =
    /T\(\s*'([a-z0-9_]+)',\s*'[^']+',\s*'(?:reactions|throws|sports|cheers|premium)',\s*'[a-z]+',\s*'[a-z]+',\s*'(\w+)',/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(service))) {
    rows.push({ id: m[1], sound: m[2] });
  }
  return rows;
}

const catalog = parseCatalog();
const rigManifest: { rigs: Record<string, string[]> } = JSON.parse(
  read('src/throwables/artwork.generated.json')
);
const registry = read('src/throwables/registry.ts');

describe('throwables integrity — 49-item dynamic system', () => {
  it('the catalog holds the 49 enabled items with local or storage artwork', () => {
    // 49 -> 48 on 2026-08-21: Dan removed 'Card Shark' (mouse_card). Its
    // storage render still exists; the CATALOG is what decides what ships, and
    // this count is the ratchet that makes any further loss deliberate.
    expect(catalog.length).toBe(49);
    const ids = catalog.map((r) => r.id);
    expect(new Set(ids).size).toBe(49);
    // Spot anchors across every category — these ids ARE the storage
    // filenames (throwables/<id>.jpg); renaming one breaks the images.
    for (const anchor of [
      'thumbs_up',
      'tomato',
      'bowling_ball',
      'champagne',
      'bomb',
      'water_gun',
    ]) {
      expect(ids).toContain(anchor);
    }
  });

  it('every item has its own sound recipe, and no recipe is orphaned', () => {
    const recipes = new Set([...sound.matchAll(/^\s{4}(\w+):\s*\(\)\s*=>/gm)].map((m) => m[1]));
    const sounds = catalog.map((r) => r.sound);
    expect(new Set(sounds).size).toBe(49); // one UNIQUE key per item
    for (const r of catalog) {
      if (rigManifest.rigs[r.id]) {
        expect(registry).toContain(`${r.id}:`);
        expect(read(`src/throwables/rigs/${r.id}.tsx`)).toContain('audio:');
      } else expect(recipes.has(r.sound), `item '${r.id}' has no recipe '${r.sound}'`).toBe(true);
    }
    for (const key of recipes) {
      expect(sounds.includes(key), `recipe '${key}' belongs to no item`).toBe(true);
    }
  });

  it('every item has a per-item signature block in ThrowableSignatures.css', () => {
    for (const r of catalog) {
      if (rigManifest.rigs[r.id]) {
        expect(registry).toContain(`${r.id}:`);
        expect(read(`src/throwables/rigs/${r.id}.css`)).toContain('@keyframes');
        continue;
      }
      expect(
        signatures.includes(`data-throwable='${r.id}'`),
        `item '${r.id}' lost its signature CSS`
      ).toBe(true);
    }
  });

  it('the animation pipeline is wired: signatures imported, audio owned by the animation', () => {
    expect(animation).toContain("import './ThrowableSignatures.css'");
    expect(animation).toContain('throwableSoundService.playLaunch');
    expect(animation).toContain('throwableSoundService.playImpact');
    expect(animation).toContain('data-throwable');
  });

  it('images route through the sized transform pipeline with the raw-URL fallback', () => {
    expect(service).toContain('/storage/v1/render/image/public/');
    expect(image).toContain('getThrowableRawUrl');
    expect(selector).toContain('ThrowableImage');
  });

  it('the retired SVG icon system stays retired', () => {
    // ThrowableIcons.tsx (750 lines of hand-drawn SVGs) was deleted in the
    // 2026-08-20 rebuild. Its return — or the animation reading from it —
    // is the signature of an old checkout overwriting the new system.
    expect(animation.includes('THROWABLE_ICONS')).toBe(false);
    expect(selector.includes('THROWABLE_ICONS')).toBe(false);
  });
});
