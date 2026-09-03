/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN AD ROW CANNOT CHOOSE WHERE THE ROUTER GOES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `ads.target_url` is free text typed into the admin panel and stored in the
 * database. It was read out as `String(r.target_url)`, typed `string | null`,
 * and handed straight to `navigate(path)` by both ad surfaces. Nothing checked
 * it — even though the module's own `isSafeAdImage` docstring already claimed
 * "a destination is checked before a browser is sent to it".
 *
 * Two things that buys, in order of severity: an off-site destination reached
 * from a control the player trusts because it sits inside the club lobby; and,
 * in the in-tab lobby, any non-tournament path collapses MultiTablePage and
 * takes the action bar with it mid-hand.
 *
 * The lobby strip also rotates every seven seconds, so the destination under
 * the player's thumb changes while they read it.
 */
import { describe, it, expect } from 'vitest';
import { isSafeAdTarget, isSafeAdImage } from '../../src/services/AdService';

describe('isSafeAdTarget', () => {
  it('accepts rooted same-origin paths', () => {
    for (const ok of [
      '/tournaments/abc',
      '/table/xyz',
      '/clubs/1/cashier',
      '/marketplace?club=2',
      '/promo/summer#top',
    ]) {
      expect(isSafeAdTarget(ok), ok).toBe(true);
    }
  });

  it('rejects anything that leaves the origin', () => {
    for (const bad of [
      'https://evil.example/steal',
      'http://evil.example',
      '//evil.example', // protocol-relative: starts with "/" but is another site
      '//evil.example/path',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'mailto:a@b.c',
    ]) {
      expect(isSafeAdTarget(bad), bad).toBe(false);
    }
  });

  it('rejects backslash forms browsers normalise toward //', () => {
    // Chrome and Firefox both treat "/\evil.example" as "//evil.example".
    for (const bad of ['/\\evil.example', '/\\\\evil.example', '/path\\..\\x']) {
      expect(isSafeAdTarget(bad), bad).toBe(false);
    }
  });

  it('rejects relative paths, empty values and non-strings', () => {
    for (const bad of ['', 'tournaments/abc', './x', '../x', null, undefined]) {
      expect(isSafeAdTarget(bad as string | null | undefined), String(bad)).toBe(false);
    }
  });

  it('is the same rule the image check uses, so neither can drift', () => {
    // Every destination the image check accepts, the target check accepts too.
    for (const p of ['/a', '/a/b?c=1']) {
      expect(isSafeAdImage(p)).toBe(true);
      expect(isSafeAdTarget(p)).toBe(true);
    }
    for (const p of ['//x', 'https://x']) {
      expect(isSafeAdImage(p)).toBe(false);
      expect(isSafeAdTarget(p)).toBe(false);
    }
  });
});
