/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PROTECTED FEATURES — the generic source-level anti-regression guard
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reads tests/protected-features.json and asserts every registered feature is
 * still present in the source tree. One test, N features. Adding protection
 * for a new feature is ONE entry in that file — no new test.
 *
 * WHY (2026-08-21): production silently lost the 49-item dynamic throwables
 * when a build from a checkout 96 commits behind main replaced the current
 * bundle. The first fix was a hand-written test for throwables alone. This
 * generalises it, because the next feature to vanish is the one nobody wrote
 * a bespoke test for.
 *
 * This guard covers the SOURCE. Two companions cover the other layers:
 *   scripts/stamp-build-provenance.mjs         (build) records where a build
 *                                              came from and refuses to build
 *                                              a tree that is behind main
 *   World Hub check-ca-protected-features.mjs  (deploy) enforces the same
 *                                              manifest's bundleMarkers, and
 *                                              check-ca-build-provenance.mjs
 *                                              refuses a bundle whose source
 *                                              is older than the deployed one
 *
 * If this fails: the named feature lost a file, a symbol, or dropped below a
 * ratchet. Restore it. Removing a feature ON PURPOSE means deleting its entry
 * in the same commit, with the reason in the message — so removal is a
 * visible act, never a silent disappearance.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

interface Feature {
  id: string;
  title: string;
  owner?: string;
  since?: string;
  files?: string[];
  contains?: Record<string, string[]>;
  absent?: Record<string, string[]>;
  minCount?: Record<string, { pattern: string; min: number }>;
  bundleMarkers?: string[];
}

const ROOT = process.cwd();
const manifestPath = path.join(ROOT, 'tests', 'protected-features.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  features: Feature[];
};

const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('protected features registry', () => {
  it('the manifest itself is well formed', () => {
    expect(Array.isArray(manifest.features)).toBe(true);
    expect(manifest.features.length).toBeGreaterThan(0);
    const ids = manifest.features.map((f) => f.id);
    expect(new Set(ids).size, 'feature ids must be unique').toBe(ids.length);
    for (const f of manifest.features) {
      expect(f.id, 'every feature needs an id').toBeTruthy();
      expect(f.title, `feature '${f.id}' needs a human title`).toBeTruthy();
    }
  });

  for (const feature of manifest.features) {
    describe(`${feature.id} — ${feature.title}`, () => {
      if (feature.files?.length) {
        it('all required files exist', () => {
          for (const rel of feature.files!) {
            expect(
              existsSync(path.join(ROOT, rel)),
              `'${feature.id}' lost ${rel}. If this removal is intentional, delete the ` +
                `feature's entry from tests/protected-features.json in the same commit.`
            ).toBe(true);
          }
        });
      }

      if (feature.contains && Object.keys(feature.contains).length) {
        it('required symbols are still wired', () => {
          for (const [rel, needles] of Object.entries(feature.contains!)) {
            const src = read(rel);
            for (const needle of needles) {
              expect(
                src.includes(needle),
                `'${feature.id}': ${rel} no longer contains '${needle}'`
              ).toBe(true);
            }
          }
        });
      }

      if (feature.absent && Object.keys(feature.absent).length) {
        it('retired code has not come back', () => {
          for (const [rel, needles] of Object.entries(feature.absent!)) {
            const src = read(rel);
            for (const needle of needles) {
              expect(
                src.includes(needle),
                `'${feature.id}': ${rel} contains retired marker '${needle}'. ` +
                  `That is the signature of an older tree overwriting a newer one.`
              ).toBe(false);
            }
          }
        });
      }

      if (feature.minCount && Object.keys(feature.minCount).length) {
        it('ratchets have not gone backwards', () => {
          for (const [rel, spec] of Object.entries(feature.minCount!)) {
            const src = read(rel);
            const re = new RegExp(spec.pattern, 'gm');
            const found = (src.match(re) || []).length;
            expect(
              found,
              `'${feature.id}': ${rel} matched /${spec.pattern}/ ${found} time(s), ` +
                `below the ratchet of ${spec.min}. Something was deleted. Ratchets go UP: ` +
                `raise it when the feature grows, never lower it to go green.`
            ).toBeGreaterThanOrEqual(spec.min);
          }
        });
      }
    });
  }
});
