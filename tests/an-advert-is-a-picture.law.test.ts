/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW: AN ADVERT IS A PICTURE, AND A TAP OPENS IT FULL SCREEN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-13, verbatim: "MAKE SURE YOU MAKE THE STANDARD FOR ADS EVERYWHERE
 * INSIDE OF SMARTER.POKER TO BE RESPONSIVE FLUID IMAGES ONLY! AND ANY TIME THEY
 * ARE CLICKED THEY SHOULD BE OPEN AND DIRECTED TO WHATEVER THE AD IS DISPLAYING
 * AS A FULL SCREEN POP UP AS WELL."
 *
 * Two rules. Both are pinned at every layer they exist in, because a standard
 * enforced in one component is one refactor away from not being a standard.
 *
 *  1. PICTURES ONLY. Every ad surface renders through the one rotator. The
 *     rotator renders an <img> in a fixed-aspect box with object-fit: contain
 *     and nothing else - no headline text, no glyph, no card. The resolver
 *     refuses to serve a placement with no picture, so a text card is not
 *     merely un-rendered; it is not inventory. No text-card ad component may
 *     exist in the tree.
 *
 *  2. A TAP OPENS FULL SCREEN. A tap on any advert opens the interstitial -
 *     the poster, fluid and whole, with one button that goes where the advert
 *     points. The tap itself logs nothing; the button logs the click for an
 *     internal destination, and the redirect logs it for an external one.
 *     Closing without going is a dismiss.
 *
 * Every pin below is a decision Dan made out loud. If your change turns one
 * red, you are re-shipping the thing he retired. Fix your change.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(resolve(ROOT, p));

const ROTATOR = read('src/components/ads/HouseAdRotator.tsx');
const ROTATOR_CSS = read('src/components/ads/HouseAdRotator.css');
const INTERSTITIAL = read('src/components/ads/AdInterstitial.tsx');
const INTERSTITIAL_CSS = read('src/components/ads/AdInterstitial.css');
const SERVICE = read('src/services/AdService.ts');
const LOBBY = read('src/pages/ClubHomePage.tsx');
const SESSION = read('src/components/session/SessionSummaryHost.tsx');
const STANDARD_MIGRATION = read(
  'supabase/migrations/20260913182547_an_advert_is_a_picture_everywhere_and_a_tap_opens_it_full_sc.sql'
);

describe('LAW 1: every advert on every surface is a responsive fluid image, and nothing else', () => {
  it('no text-card ad component exists in the tree', () => {
    expect(exists('src/components/ads/HouseAdCard.tsx')).toBe(false);
    expect(exists('src/components/lobby/LobbyAdStrip.tsx')).toBe(false);
    /* And nothing under components/ads renders headline text as a card body.
       The interstitial shows the headline UNDER the picture, as a caption on
       the popup; the rotator on a surface shows the picture alone. */
    const adDir = readdirSync(resolve(ROOT, 'src/components/ads'));
    expect(adDir.filter((f) => /card|strip/i.test(f))).toEqual([]);
  });

  it('every Club Arena ad surface is mounted through the one rotator', () => {
    // lobby_strip, empty_state, session_summary. hub_promotions is the Hub's.
    expect(LOBBY).toMatch(/<HouseAdRotator[\s\n]+slot="lobby_strip"/);
    expect(LOBBY).toMatch(/<HouseAdRotator[\s\n]+slot="empty_state"/);
    expect(SESSION).toMatch(/<HouseAdRotator[\s\n]+slot="session_summary"/);
    // And through nothing else: no other component renders an ad_event surface.
    const srcAdRenderers =
      [LOBBY, SESSION].join('\n').match(/slot="(lobby_strip|empty_state|session_summary)"/g) ?? [];
    expect(srcAdRenderers).toHaveLength(3);
  });

  it('the rotator renders a picture in a fixed-shape box, contained, and no text', () => {
    // Responsive: the box is 100% wide and owns the shape.
    expect(ROTATOR).toMatch(/style=\{\{ aspectRatio: ratio \}\}/);
    expect(ROTATOR_CSS).toMatch(/\.ad-rotator \{[\s\S]*?width: 100%;/);
    // Fluid, never cut off, never distorted.
    const img = ROTATOR_CSS.slice(ROTATOR_CSS.indexOf('.ad-rotator__image {'));
    expect(img).toMatch(/object-fit: contain;/);
    expect(ROTATOR_CSS).not.toMatch(/object-fit: cover/);
    // Only pictures are shown; an advert without one is dropped, not rendered as text.
    expect(ROTATOR).toMatch(/rows\.filter\(\(a\) => isSafeAdImage\(a\.imageUrl\)\)/);
    expect(ROTATOR).not.toMatch(/ad\.headline\}\s*<\/span>|ad\.body\}|ad\.glyph\}/);
    // Every surface has a declared shape.
    for (const slot of [
      'lobby_strip',
      'session_summary',
      'empty_state',
      'hub_promotions',
      'table_between_hands',
    ]) {
      expect(ROTATOR).toMatch(new RegExp(`${slot}: '\\d+ / \\d+'`));
    }
  });

  it('the resolver refuses to serve an advert that has no picture, on any surface', () => {
    /* This is the line that makes it a standard rather than a convention: a
       renderer can be replaced or forgotten, the resolver cannot be bypassed. */
    expect(STANDARD_MIGRATION).toMatch(/AND COALESCE\(pl\.image_url, c\.image_url\) IS NOT NULL/);
    expect(STANDARD_MIGRATION).toMatch(/the picture standard is not enforced in the resolver/);
    // Asserted against live rows at apply time: nothing active is pictureless.
    expect(STANDARD_MIGRATION).toMatch(/active placements still have no picture/);
  });

  it('a creative is delivered at the size its surface needs, and the sizes are written down', () => {
    // 6:1 1200x200, 3:1 900x300, 16:9 1200x675, 3:4 1080x1440 - all six campaigns.
    const ads = readdirSync(resolve(ROOT, 'public/assets/ads'));
    for (const key of [
      'spins-jackpot',
      'bbj-running',
      'vip-upsell',
      'diamonds-store',
      'referral-invite',
      'tournaments-daily',
    ]) {
      for (const shape of ['lobby-strip', 'session-summary', 'hub-promotions', 'poster']) {
        expect(ads, `${key}-${shape}-v1.webp`).toContain(`${key}-${shape}-v1.webp`);
      }
    }
  });
});

describe('LAW 2: a tap opens the advert full screen, and the button does the going', () => {
  it('a tap opens the interstitial and logs nothing', () => {
    const activate = ROTATOR.slice(
      ROTATOR.indexOf('const activate = () => {'),
      ROTATOR.indexOf('const proceed = () => {')
    );
    expect(activate).toMatch(/setOpen\(true\)/);
    expect(activate).not.toMatch(/logClick|logImpression|logViewable|navigate|window\./);
    expect(ROTATOR).toMatch(/<AdInterstitial/);
  });

  it('the interstitial is full screen, and its picture is fluid and contained', () => {
    expect(INTERSTITIAL).toMatch(/createPortal\(/);
    expect(INTERSTITIAL).toMatch(/role="dialog"/);
    expect(INTERSTITIAL).toMatch(/aria-modal="true"/);
    expect(INTERSTITIAL_CSS).toMatch(
      /\.ad-interstitial \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/
    );
    const pic = INTERSTITIAL_CSS.slice(INTERSTITIAL_CSS.indexOf('.ad-interstitial__picture img {'));
    expect(pic).toMatch(/object-fit: contain;/);
    expect(INTERSTITIAL_CSS).not.toMatch(/object-fit: cover/);
    // The box reads the picture's real shape rather than assuming one.
    expect(INTERSTITIAL).toMatch(
      /setRatio\(`\$\{img\.naturalWidth\} \/ \$\{img\.naturalHeight\}`\)/
    );
  });

  it('the popup shows the poster, and the resolver always hands one back', () => {
    expect(SERVICE).toMatch(/posterUrl: r\.poster_url == null \? null : String\(r\.poster_url\)/);
    expect(INTERSTITIAL).toMatch(
      // Whitespace-tolerant: Prettier breaks the nested ternary across lines.
      /isSafeAdImage\(ad\.posterUrl\)\s*\?\s*ad\.posterUrl\s*:\s*isSafeAdImage\(ad\.imageUrl\)\s*\?\s*ad\.imageUrl\s*:\s*null/
    );
    expect(STANDARD_MIGRATION).toMatch(
      /COALESCE\(c\.poster_url, pl\.image_url, c\.image_url\) AS poster_url/
    );
    expect(STANDARD_MIGRATION).toMatch(/ad_catalog_poster_is_same_origin/);
  });

  it('the button goes where the advert points, and only then is a click a click', () => {
    const proceed = ROTATOR.slice(
      ROTATOR.indexOf('const proceed = () => {'),
      ROTATOR.indexOf('const dismiss = () => {')
    );
    // Internal: logged here, before the route changes.
    expect(proceed.indexOf('AdService.logClick')).toBeGreaterThan(-1);
    expect(proceed.indexOf('AdService.logClick')).toBeLessThan(
      proceed.indexOf('onNavigate?.(target)')
    );
    // External: a new tab, noopener, and NOT logged here - the redirect counts it.
    expect(proceed).toMatch(/window\.open\(target, '_blank', 'noopener,noreferrer'\)/);
    expect(proceed.indexOf('window.open(target')).toBeLessThan(
      proceed.indexOf('AdService.logClick')
    );
    expect(proceed).toMatch(/if \(external\) \{[\s\S]*?return;\s*\}\s*AdService\.logClick/);
  });

  it('closing without going is a dismiss, not a click', () => {
    const dismiss = ROTATOR.slice(
      ROTATOR.indexOf('const dismiss = () => {'),
      ROTATOR.indexOf('const ratio =')
    );
    expect(dismiss).toMatch(/AdService\.logDismiss/);
    expect(dismiss).not.toMatch(/logClick/);
    expect(ROTATOR).toMatch(/onClose=\{dismiss\}/);
    expect(ROTATOR).toMatch(/onProceed=\{proceed\}/);
  });

  it('the rotation holds while the popup is up, and the popup is fetched on the tap', () => {
    expect(ROTATOR).toMatch(/if \(openRef\.current\) return;/);
    expect(ROTATOR).toMatch(
      /const AdInterstitial = lazy\(\(\) => import\('\.\/AdInterstitial'\)\)/
    );
  });

  it('the popup respects the player: Escape closes, focus lands on Close, scroll is locked, motion honours the speed setting', () => {
    expect(INTERSTITIAL).toMatch(/e\.key === 'Escape'/);
    expect(INTERSTITIAL).toMatch(/closeRef\.current\?\.focus\(\)/);
    expect(INTERSTITIAL).toMatch(/document\.body\.style\.overflow = 'hidden'/);
    expect(INTERSTITIAL_CSS).toMatch(/calc\(220ms \* var\(--animation-speed, 1\)\)/);
    expect(INTERSTITIAL_CSS).toMatch(/prefers-reduced-motion: reduce/);
  });
});
