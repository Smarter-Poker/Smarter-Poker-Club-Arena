/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE WEB APP MANIFEST POINTS AT THE SUB-PATH THE ARENA LIVES ON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AEO phase 1, 2026-09-17. public/manifest.json ships verbatim and said
 * start_url "/" and scope "/": a player who installed the arena as a PWA from
 * smarter.poker/hub/club-arena got an app that opened the World Hub root and
 * claimed the whole origin, and the icon path was the web sub-path even in
 * the native shell. scripts/stamp-manifest-base.mjs rewrites the built copy
 * from the build's base. This pins the stamp for both targets and that it
 * runs in build:ci after vite build.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - a plain .mjs script with named exports
import { manifestBase, stampManifest } from '../scripts/stamp-manifest-base.mjs';

const ROOT = join(__dirname, '..');
const source = JSON.parse(readFileSync(join(ROOT, 'public/manifest.json'), 'utf8'));

describe('the manifest points at the sub-path', () => {
  it('build:ci stamps the manifest after vite build', () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const steps: string[] = scripts['build:ci'].split('&&').map((s: string) => s.trim());
    const at = (needle: string) => steps.findIndex((s) => s.includes(needle));
    expect(at('scripts/stamp-manifest-base.mjs')).toBeGreaterThan(at('vite build'));
  });

  it('the web build gets the sub-path everywhere', () => {
    const base = manifestBase({});
    expect(base).toBe('/hub/club-arena/');
    const out = stampManifest(source, base);
    // Slashless: the World Hub serves the front door at /hub/club-arena and a
    // "/hub/club-arena/" scope would not cover it (same choice as the SW).
    expect(out.start_url).toBe('/hub/club-arena');
    expect(out.scope).toBe('/hub/club-arena');
    expect(out.id).toBe('/hub/club-arena');
    expect(out.icons[0].src).toBe('/hub/club-arena/poker-chip-logo.png');
    expect(out.name).toBe(source.name);
  });

  it('the native build gets the root', () => {
    const base = manifestBase({ VITE_NATIVE: '1', CA_PUBLIC_BASE: '/' });
    expect(base).toBe('/');
    const out = stampManifest(source, base);
    expect(out.start_url).toBe('/');
    expect(out.scope).toBe('/');
    expect(out.icons[0].src).toBe('/poker-chip-logo.png');
  });

  it('a base without slashes is normalised', () => {
    expect(manifestBase({ CA_PUBLIC_BASE: 'hub/club-arena' })).toBe('/hub/club-arena/');
  });
});
