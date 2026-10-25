/**
 * A RAISE HAS ITS OWN SOUND, AND IT IS NOT THE CALL
 *
 * Dan 2026-10-24: "A RAISE SHOULD HAVE A DIFFERENT SOUND EFFECT THEN A CALL."
 *
 * Two defects made them the same sound:
 *   1. TablePage's opponent action echo sent bet, raise AND call to
 *      `playChips()`, so every raise by anyone but the hero was the call clink.
 *   2. `playRaise()` itself was the call clink three times over — the same
 *      down-swept oscillator click — so even the hero's raise read as a call.
 *
 * These source contracts complement playerActionAudio.test.ts and the native
 * Web Audio browser fixture, which execute the actual synthesizer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../helpers/sourceWindow';

const readRaw = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SOUND = strip(readRaw('src/services/SoundService.ts'));
const PAGE = strip(readRaw('src/pages/TablePage.tsx'));

describe('the opponent action echo', () => {
  const echo = sliceMethod(
    PAGE,
    'if (soundService.isEnabled() && ambientSoundsAllowed && !isHeroEcho)'
  );

  it('dispatches the accepted action with amount and BB through the tested cue selector', () => {
    expect(echo).toContain('playPlayerActionSound(action, actionAmount,');
    expect(PAGE).toContain("import { playPlayerActionSound } from '../lib/playerActionSound'");
  });
});

describe('playRaise is built from pieces the call does not have', () => {
  const raise = sliceMethod(SOUND, 'playRaise(');
  const call = sliceMethod(SOUND, 'playChips(');

  it('pushes the stack with an upward noise sweep', () => {
    const m = raise.match(/createSweptNoiseBurst\(t, [^,]+, [^,]+, (\d+), (\d+)/);
    expect(m, 'the raise opens with a swept push').not.toBeNull();
    expect(Number(m![2])).toBeGreaterThan(Number(m![1]));
    expect(call).not.toMatch(/createSweptNoiseBurst/);
  });

  it('ends on a rising interval, which nothing else in the action set does', () => {
    const flick = raise.slice(raise.indexOf('const flick'));
    const pitches = [...flick.matchAll(/scheduleTone\(flick[^,]*, (\d+)/g)].map((x) =>
      Number(x[1])
    );
    expect(pitches.length).toBe(2);
    expect(pitches[1]).toBeGreaterThan(pitches[0]);
  });

  it('is scheduled on the audio clock, not on main-thread timers', () => {
    expect(raise).not.toMatch(/setTimeout/);
  });

  it('plays under the raise priority, not the call/bet one', () => {
    expect(raise).toMatch(/shouldPlay\('raise', 'action'\)/);
  });
});

describe('isolated browser audio regression enforcement', () => {
  it('runs the real audio fixture in the existing Chromium and WebKit gate', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('tests/e2e/mobile-lobby-chrome.spec.ts');
    const entry = readFileSync('tests/e2e/mobile-lobby-chrome.spec.ts', 'utf8');
    expect(entry).toContain('registerPlayerActionAudioCases();');
    expect(entry).toContain('registerLeaderboardLoadingLayoutCases();');
    expect(readFileSync('playwright.config.ts', 'utf8')).toContain('mobile-lobby-chrome');
    expect(readFileSync('tests/e2e/fixtures/playerActionAudio.ts', 'utf8')).toContain(
      'OfflineAudioContext'
    );
  });
});
