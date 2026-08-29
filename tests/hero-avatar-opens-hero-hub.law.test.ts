/**
 * ═══ LAW: YOUR OWN AVATAR OPENS THE HERO HUB. ALWAYS. ═══════════════════════
 *
 * Dan 2026-08-29, verbatim: "THE ACTION BAR THAT POPS UP WHEN YOU CLICK ON
 * YOUR OWN AVATAR NEEDS TO BE ... THE TABBED HERO HUB ... ON EVERY SINGLE
 * PAGE INSIDE THE CLUB ARENA REGUARDLESS OF WHAT KIND OF GAME YOU ARE
 * PLAYING."
 *
 * Every beat below is the bug that shipped on 2026-08-29 or the regression
 * that would re-ship it. The rule is a pure function (src/lib/heroSeatTap.ts)
 * precisely so this file can pin it without a table; the wiring beat then
 * pins that TablePage actually uses the rule rather than a hand-rolled copy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { seatTapTarget } from '../src/lib/heroSeatTap';

const USER = 'user-123';

describe('seatTapTarget — the rule itself', () => {
  it('a seated hero (isHero stamped) opens the hub', () => {
    expect(seatTapTarget({ id: USER, isHero: true }, USER)).toBe('hero-hub');
  });

  it('THE 2026-08-29 BUG: the pending/waiting placeholder still opens the hub', () => {
    // While the hero is pending / waiting to be dealt in, the raw snapshot
    // player is null and the seat renders a synthesized placeholder. Checking
    // the raw player here is what sent the hero to the throwable-only
    // selector. The rule reads the RENDERED player, so the placeholder wins.
    expect(seatTapTarget({ id: USER, isHero: true }, USER)).toBe('hero-hub');
    // And even a placeholder that lost its stamp is still you, by id:
    expect(seatTapTarget({ id: USER, isHero: false }, USER)).toBe('hero-hub');
    expect(seatTapTarget({ id: USER }, USER)).toBe('hero-hub');
  });

  it('a snapshot rebuild that drops the isHero stamp cannot demote you', () => {
    expect(seatTapTarget({ id: USER, isHero: undefined }, USER)).toBe('hero-hub');
  });

  it('a villain opens the throwable selector, never your hub', () => {
    expect(seatTapTarget({ id: 'villain-9', isHero: false }, USER)).toBe('villain-throwables');
    expect(seatTapTarget({ id: 'villain-9' }, USER)).toBe('villain-throwables');
  });

  it('no player rendered, or no signed-in user: never the hub', () => {
    expect(seatTapTarget(null, USER)).toBe('villain-throwables');
    expect(seatTapTarget(undefined, USER)).toBe('villain-throwables');
    // A guest with no id gets no hub from an id match alone…
    expect(seatTapTarget({ id: '' }, '')).toBe('villain-throwables');
    // …but a stamped hero seat is still theirs.
    expect(seatTapTarget({ isHero: true }, '')).toBe('hero-hub');
  });
});

describe('the wiring — TablePage uses THIS rule, on the RENDERED player', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');

  it('the avatar tap decides via seatTapTarget(displayPlayer, …)', () => {
    expect(
      src.includes("seatTapTarget(displayPlayer, userId) === 'hero-hub'"),
      'TablePage no longer routes the avatar tap through seatTapTarget(displayPlayer, ...) — ' +
        'a hand-rolled check here is how the 2026-08-29 throwable-only bug shipped'
    ).toBe(true);
  });

  it('no tap handler decides hero-ness from the RAW snapshot player again', () => {
    expect(
      /onAvatarClick=\{[\s\S]{0,600}?player\?\.isHero/.test(src),
      'an onAvatarClick reads player?.isHero — the raw player is null in the ' +
        'pending-seat placeholder window; use displayPlayer via seatTapTarget'
    ).toBe(false);
  });
});
