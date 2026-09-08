/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY RIGGED THROWABLE OBEYS THE MEASURED GRAMMAR (phase 1, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thirty-one PokerBros throws were read frame by frame at 30 fps
 * (docs/throwables/pokerbros-reference-video-1.md and -2.md) and they all
 * share one grammar: spawn on the thrower, a STRAIGHT constant-speed flight of
 * 133-400 ms, a blink-and-pop landing, then a performance on the target's
 * chair for about four seconds, drawn over the avatar, cut in one frame.
 *
 * `throwTimeline.test.ts` did this for the legacy physics/impact engine. This
 * does it for the spec-driven rigs, and it is stricter, because a spec is data
 * rather than a regex over a component.
 *
 * THE ONE THAT WOULD HAVE SHIPPED WRONG: `water_gun`'s rig was authored with
 * its payload delays counted from "landing = flight + the 100 ms blink-pop",
 * while the player mounts the payload at `flight.ms`. Every beat in it fired
 * 100 ms early. The darkroom caught it (the splat was gone at its own
 * loop-end beat) and `payloadBeatsAreReachable` below is why it cannot come
 * back: a beat later than the payload's own life is a beat nobody sees.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { RIGGED_IDS, riggedThrowable, allSpecs } from '../../src/throwables/registry';
import { THROWABLE_GRAMMAR, throwableTotalMs, throwableLandingMs } from '../../src/throwables/spec';
import { THROWABLE_CUE_MANIFEST } from '../../src/throwables/cueManifest.generated';
import throwableService from '../../src/services/ThrowableService';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/* Strip comments so a guard cannot pass or fail on prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the rigged throwables', () => {
  it('has at least the phase-1 four, and every one resolves', () => {
    expect(RIGGED_IDS.length).toBeGreaterThanOrEqual(4);
    for (const id of ['beer', 'water_gun', 'tomato', 'cracked_egg']) {
      expect(RIGGED_IDS, `${id} is a phase-1 rig`).toContain(id);
      const r = riggedThrowable(id);
      expect(r?.spec.id).toBe(id);
      expect(typeof r?.rig.Projectile).toBe('function');
      expect(typeof r?.rig.Payload).toBe('function');
    }
  });

  it('every rig id is a REAL catalogue id, so the wire still resolves it', () => {
    // `[THROW:<id>:<seat>]` goes over the engine's chat channel and the
    // receiving client looks the id up in ThrowableService. A rig for an id
    // the catalogue does not know would draw for the thrower and nobody else.
    for (const id of RIGGED_IDS) {
      expect(throwableService.getThrowableById(id), `${id} is in the catalogue`).toBeTruthy();
    }
  });

  it('the registry entry, the spec id and the file name agree', () => {
    for (const id of RIGGED_IDS) {
      expect(riggedThrowable(id)!.spec.id).toBe(id);
      expect(fs.existsSync(path.join(process.cwd(), `src/throwables/rigs/${id}.tsx`))).toBe(true);
      expect(fs.existsSync(path.join(process.cwd(), `src/throwables/rigs/${id}.css`))).toBe(true);
    }
  });
});

describe('the grammar bounds, from the measured reference', () => {
  const specs = allSpecs();

  it('spawns on the thrower for no longer than the reference ever does', () => {
    for (const s of specs) {
      expect(s.spawnMs, `${s.id} spawnMs`).toBeGreaterThanOrEqual(THROWABLE_GRAMMAR.spawnMs.min);
      expect(s.spawnMs, `${s.id} spawnMs`).toBeLessThanOrEqual(THROWABLE_GRAMMAR.spawnMs.max);
    }
  });

  it('flies STRAIGHT, and crosses the felt in 133-400 ms', () => {
    for (const s of specs) {
      if (s.flight.mode === 'none') continue;
      expect(s.flight.mode, `${s.id} flight mode`).toBe('straight');
      expect(s.flight.ms, `${s.id} flight`).toBeGreaterThanOrEqual(THROWABLE_GRAMMAR.flightMs.min);
      expect(s.flight.ms, `${s.id} flight`).toBeLessThanOrEqual(THROWABLE_GRAMMAR.flightMs.max);
    }
  });

  it('performs at the target for 1.8-5.8 s, and the whole throw fits 2-6.5 s', () => {
    for (const s of specs) {
      expect(s.payload.ms, `${s.id} payload`).toBeGreaterThanOrEqual(
        THROWABLE_GRAMMAR.payloadMs.min
      );
      expect(s.payload.ms, `${s.id} payload`).toBeLessThanOrEqual(THROWABLE_GRAMMAR.payloadMs.max);
      const total = throwableTotalMs(s);
      expect(total, `${s.id} total`).toBeGreaterThanOrEqual(THROWABLE_GRAMMAR.totalMs.min);
      expect(total, `${s.id} total`).toBeLessThanOrEqual(THROWABLE_GRAMMAR.totalMs.max);
    }
  });

  it('every beat is reachable: nothing is scheduled after the payload is gone', () => {
    // THE water_gun BUG, pinned. A rig whose beats are counted from a landing
    // the player does not use puts its last beats past the unmount, where
    // nobody will ever see them.
    for (const s of specs) {
      const landing = throwableLandingMs(s);
      const lastFrame = landing + Math.max(s.payload.ms, s.residue?.ms ?? 0);
      for (const b of s.beats) {
        expect(
          b.at,
          `${s.id}: beat '${b.marker}' at ${b.at} is after the last frame ${lastFrame}`
        ).toBeLessThanOrEqual(lastFrame);
      }
      // The beat list must DESCRIBE THE END, or the darkroom never photographs
      // it and nobody reviews the last thing a player sees. It does not have
      // to end ON the cut: water_gun's splat cuts at 3467 and the gun then
      // scales out over the next 100 ms, exactly as the capture shows.
      const lastBeat = Math.max(...s.beats.map((b) => b.at));
      expect(
        lastBeat,
        `${s.id}: the last beat (${lastBeat}) is far from the last frame (${lastFrame})`
      ).toBeGreaterThanOrEqual(lastFrame - 300);
    }
  });

  it('beats are ordered, named once, and start at or after the landing', () => {
    for (const s of specs) {
      const ats = s.beats.map((b) => b.at);
      expect(
        [...ats].sort((a, b) => a - b),
        `${s.id} beats are in order`
      ).toEqual(ats);
      expect(new Set(s.beats.map((b) => b.marker)).size, `${s.id} beat names are unique`).toBe(
        s.beats.length
      );
    }
  });

  it('every audio cue exists in the built manifest, placeholders included', () => {
    // A spec that names a cue in neither the file list nor the placeholder
    // list is silent, and silence is the one thing the animation law forbids.
    for (const s of specs) {
      for (const cue of s.audio) {
        expect(THROWABLE_CUE_MANIFEST[cue.sample], `${s.id} cue '${cue.sample}'`).toBeTruthy();
      }
    }
  });

  it('every cue fires while something is on screen', () => {
    for (const s of specs) {
      const lastFrame = throwableLandingMs(s) + Math.max(s.payload.ms, s.residue?.ms ?? 0);
      for (const cue of s.audio) {
        expect(cue.at, `${s.id} cue '${cue.sample}'`).toBeGreaterThanOrEqual(0);
        expect(cue.at, `${s.id} cue '${cue.sample}' fires after the cut`).toBeLessThanOrEqual(
          lastFrame
        );
        if (cue.loopUntil !== undefined) {
          expect(cue.loopUntil, `${s.id} cue '${cue.sample}' loops backwards`).toBeGreaterThan(
            cue.at
          );
        }
      }
    }
  });

  it('a spec that carries a caption keeps it to the five Dan allowed', () => {
    // Ruling 7: the reference shows ONE label in thirty-one throws. Five
    // survive here because they are the joke; the rest went with the TTS.
    const ALLOWED = ['Good Luck', 'Strike!', "It's Good!", 'Oof', 'Tilt'];
    for (const s of specs) {
      if (!s.caption) continue;
      expect(ALLOWED, `${s.id} caption`).toContain(s.caption.text);
    }
  });
});

describe('the rigs themselves', () => {
  it('draw in the one viewBox, so the darkroom and the seat rungs agree', () => {
    for (const id of RIGGED_IDS) {
      const src = read(`src/throwables/rigs/${id}.tsx`);
      expect(src, `${id} uses RIG_VIEWBOX`).toMatch(/viewBox=\{RIG_VIEWBOX\}/);
    }
  });

  it('scope every SVG def id to the instance uid', () => {
    // <defs> ids are global to the DOCUMENT and a multi-table view mounts
    // several throws at once; duplicates silently repaint each other. The
    // knockout learned this and so does every rig.
    for (const id of RIGGED_IDS) {
      const src = code(read(`src/throwables/rigs/${id}.tsx`));
      const literalIds = src.match(/\bid="(?!\$\{)[^"]+"/g) || [];
      expect(literalIds, `${id} has a hardcoded def id: ${literalIds.join(', ')}`).toEqual([]);
      // Raster-only rigs have no defs. Any rig that declares an id still
      // must scope it to its instance so simultaneous throws stay isolated.
      if (/\bid=/.test(src)) expect(src, `${id} builds ids from uid`).toMatch(/uid/);
    }
  });

  it('scale every duration and delay by the player Animation Speed', () => {
    // CLAUDE.md 10.6: speed scaling is the ONE sanctioned control over
    // animation duration, and a rig that opts out drifts from its own sound.
    for (const id of RIGGED_IDS) {
      const css = code(read(`src/throwables/rigs/${id}.css`));
      const durations = css.match(/animation(?:-duration|-delay)?:\s*[^;]+;/g) || [];
      for (const d of durations) {
        if (/animation:\s*none/.test(d)) continue;
        if (
          /^animation-(name|timing-function|iteration-count|fill-mode|direction|play-state)/.test(d)
        )
          continue;
        expect(d, `${id}: '${d.trim()}' does not scale by --animation-speed`).toMatch(
          /var\(--animation-speed/
        );
      }
      expect(durations.length, `${id} has keyframed animation`).toBeGreaterThan(0);
    }
  });

  it('namespace every keyframe, because @keyframes is one global namespace', () => {
    for (const id of RIGGED_IDS) {
      const css = read(`src/throwables/rigs/${id}.css`);
      const names = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      for (const n of names) {
        expect(n, `${id}: keyframe '${n}' is not namespaced`).toMatch(new RegExp(`^thr-${id}-`));
      }
    }
  });

  it('never promote a layer permanently, and never animate a filter', () => {
    // Eight simultaneous throws is the budget. A permanently promoted layer
    // per element is a GPU memory bill, not a paint saving, and Chrome
    // promotes a RUNNING transform animation on its own.
    for (const id of RIGGED_IDS) {
      const css = code(read(`src/throwables/rigs/${id}.css`));
      expect(css, `${id} sets will-change`).not.toMatch(/will-change/);
      const keyframeBlocks = css.match(/@keyframes[\s\S]*?\n\}/g) || [];
      for (const block of keyframeBlocks) {
        expect(block, `${id} animates filter inside a keyframe`).not.toMatch(/^\s*filter:/m);
      }
    }
  });

  it('carry a reduced-motion block that keeps the meaning', () => {
    for (const id of RIGGED_IDS) {
      const css = read(`src/throwables/rigs/${id}.css`);
      expect(css, `${id} has no reduced-motion block`).toMatch(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)/
      );
    }
  });

  it('use approved local atlas art without remote assets or emoji', () => {
    for (const id of RIGGED_IDS) {
      const src = read(`src/throwables/rigs/${id}.tsx`);
      // Raw images bypass authored atlas bounds; use AtlasSprite for approved art.
      expect(src, `${id} bypasses atlas bounds`).not.toMatch(/<img\b|<image\b/);
      // `url(#thr-...)` is how SVG paint references its own defs and is
      // correct; a url() that leaves the document is a fetch and is not.
      expect(src, `${id} fetches a remote or embedded asset`).not.toMatch(
        /url\(\s*['"]?(?:https?:|data:|\/)/
      );
      expect(src, `${id} contains an emoji`).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });
});
