/**
 * THE HEADER'S WAY OUT (2026-08-19).
 *
 * Dan: "the club arena needs a back button and hub button inside the global
 * header, and the global header should stretch across the top of the page."
 *
 * All three faults were invisible to every test that existed, because none of
 * them are logic:
 *
 *   - Back was rendered only when `pageDepth >= 2`, so the lobby never had one.
 *   - Hub had a handler, `handleHubClick`, and no button anywhere that called
 *     it. Written, wired to nothing, shipped.
 *   - The bar shrank to the width of its own icons, because it sits in a
 *     `align-items: center` flex column and nothing told it to stretch.
 *
 * These assertions read the source rather than rendering it, and that is a
 * deliberate trade. Rendering GlobalHeader means standing up react-router, two
 * zustand stores, the MasterBus and a Supabase-backed auth hook — the same
 * import-time Supabase client that already leaves 71 files failing in this
 * suite. A test that cannot run is worth less than one that pins the exact
 * three things that were wrong. What it cannot catch is a button that renders
 * but is invisible or unclickable; that is what the screenshot check is for.
 *
 * The asset checks are not padding. These buttons are images with no text
 * fallback, so a renamed or missing PNG is a blank space in the header that
 * nothing else in CI would notice.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const readBytes = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const exists = (rel: string) => existsSync(fileURLToPath(new URL(rel, import.meta.url)));

const TSX = read('../../src/components/navigation/GlobalHeader.tsx');
const CSS = read('../../src/components/navigation/GlobalHeader.module.css');
const LAYOUT = read('../../src/components/layouts/AppLayout.tsx');
const OPTIMIZER = read('../../scripts/optimize-dist-media.mjs');
const APPROVED_DESKTOP = readBytes('../../public/images/global-header/global-header-desktop.png');

/**
 * Comments explain the bugs by name, so "the word is gone" is the wrong
 * question — "the identifier is gone" is the right one. Strip block and line
 * comments before asking.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const TSX_CODE = stripComments(TSX);
const LAYOUT_CODE = stripComments(LAYOUT);

/** The declaration block for a single class selector, e.g. `.header { ... }`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

describe('the bar stretches across the top', () => {
  const header = ruleBody(CSS, '.header');

  it.each([
    ['align-self: stretch', 'overrides the parent flex column centring the bar'],
    ['width: 100%', 'covers parents that are not flex containers'],
    ['box-sizing: border-box', 'keeps the horizontal padding inside the 100%'],
  ])('.header declares %s — %s', (decl) => {
    expect(header).toContain(decl);
  });

  it('reserves the approved artwork ratio before the image loads', () => {
    expect(CSS).toContain('aspect-ratio: 1648 / 168');
    expect(TSX).toContain('width={1648}');
    expect(TSX).toContain('height={168}');
  });

  it('uses the artwork width as the one coordinate system for art and controls', () => {
    const art = ruleBody(CSS, '.desktopArtwork');
    const controls = ruleBody(CSS, '.headerControls');
    const button = ruleBody(CSS, '.artButton');

    expect(CSS).not.toContain('--global-header-height');
    expect(art).toContain('height: auto');
    expect(art).toContain('object-fit: contain');
    expect(controls).toContain('left: env(safe-area-inset-left, 0px)');
    expect(controls).toContain('right: env(safe-area-inset-right, 0px)');
    expect(controls).not.toMatch(/\bheight\s*:/);
    expect(button).toContain('top: 13%');
    expect(button).toContain('height: 74%');
  });

  it('cannot shrink the click plane to a fixed-height aspect box again', () => {
    const controls = ruleBody(CSS, '.headerControls');
    const profile = ruleBody(CSS, '.profileBtn');

    // The shipped bug combined `height: 84px` with aspect-ratio. That made the
    // containing block 824px wide on a 1179px screen and placed the portrait
    // over the logo. The source crop starts at pixel 1111 of 1648, so that
    // exact ratio must keep scaling with the complete artwork plane.
    expect(controls).not.toContain('height: var(');
    expect(profile).toContain('left: 66.75%');
    expect(1171 * 0.6675).toBeCloseTo(781.64, 2);
    expect(390 * 0.6675).toBeCloseTo(260.33, 2);
  });

  it('paints no background of its own behind or around the artwork', () => {
    /*
     * Dan, 2026-09-01: "on mobile, the global header needs the background
     * removed on all pages inside smarter.poker, club arena, and club
     * commander." The approved artwork is opaque across its whole canvas, so a
     * fill on .header was only ever visible where the artwork is NOT - the
     * safe-area band this rule pads by, the standalone band, and the left/right
     * insets - which on a phone is an opaque black block above and around the
     * header. Desktop has no insets, so nothing changed there.
     */
    expect(header).toContain('background: transparent');
    expect(header).not.toMatch(/background:\s*#000/);
    expect(header).toContain('padding-top: env(safe-area-inset-top, 0px)');
  });

  it('blacks out the safe-area padding so nothing scrolls above the header', () => {
    /*
     * Dan, 2026-09-02, with a screenshot of the club lobby's own rows sitting
     * above the header behind the status bar: "THE HEADER MUST ALWAYS BE AT THE
     * TOP, AND NOTHING SHOULD EVER APPEAR, OR BE DISPLAYED ABOVE IT IN THE
     * PADDING AREA ABOVE IT. THAT SHOULD BE BLACK AND NEVER SHOW ANYTHING ABOVE
     * IT."
     *
     * This does NOT reopen the rule above it. `.header` still paints nothing -
     * the band is a pseudo-element sized to exactly the padding, so the artwork
     * canvas and the left/right insets stay bare, and the only pixels that
     * gained a fill are the ones Dan asked to be black. The two pins are
     * deliberately adjacent: whoever comes to relax one must read the other.
     */
    const band = ruleBody(CSS, '.header::before');
    expect(band).toContain('height: env(safe-area-inset-top, 0px)');
    expect(band).toContain('background: #000');
    expect(band).toContain('top: 0');
    // A band that swallowed clicks would eat the top edge of the hamburger.
    expect(band).toContain('pointer-events: none');
    // The installed-app override pads by max(inset, 24px); the band must say
    // the same thing or it leaves a sliver uncovered exactly there.
    expect(CSS).toMatch(
      /@media \(display-mode: standalone\)[\s\S]*?\.header::before\s*\{[\s\S]*?height: max\(env\(safe-area-inset-top, 0px\), 24px\)/
    );
  });

  it('is not capped by a max-width anywhere in the file', () => {
    // A max-width on .header would reinstate the floating pill by another route.
    expect(ruleBody(CSS, '.header')).not.toContain('max-width');
  });
});

describe('both ways out are always there', () => {
  it('renders a Back button', () => {
    expect(TSX).toContain('aria-label="Go Back"');
  });

  it('renders a Hub button', () => {
    expect(TSX).toContain('aria-label="Go To The Hub"');
  });

  it('neither is behind a page-depth condition any more', () => {
    // The exact shape of the old bug: `{isSubPage && (<button ... Go Back`.
    expect(TSX_CODE).not.toContain('isSubPage');
    expect(TSX_CODE).not.toContain('pageDepth');
  });

  it('AppLayout no longer passes a depth the header ignores', () => {
    expect(LAYOUT_CODE).not.toContain('pageDepth');
  });
});

describe('no handler is left wired to nothing', () => {
  it.each(['handleHubClick', 'handleBackClick', 'handleMenuToggle'])(
    '%s is both defined and used in an onClick',
    (fn) => {
      expect(TSX_CODE, `${fn} is not defined`).toContain(`const ${fn} =`);
      expect(TSX_CODE, `${fn} is defined but never wired to a button`).toContain(`onClick={${fn}}`);
    }
  );

  it('Back goes back through the browser, not just the router', () => {
    // Dan's choice: one step down the history stack, even out of Club Arena.
    expect(TSX_CODE).toContain('window.history.back()');
  });

  it('Hub leaves for /hub rather than routing inside Club Arena', () => {
    expect(TSX_CODE).toMatch(/navigateToHub\(\s*'\/hub'\s*\)/);
  });
});

describe('the button artwork exists', () => {
  const IMAGES = ['menu.png', 'back.png', 'hub.png'] as const;

  it.each(IMAGES)('%s is referenced by the header', (file) => {
    expect(TSX).toContain(`APPROVED_HEADER_ASSET}${file}`);
  });

  it.each(IMAGES)('%s is actually in public/images/global-header', (file) => {
    // These buttons are images with no text fallback. A missing file is a hole
    // in the header, and nothing else in CI would say a word about it.
    expect(exists(`../../public/images/global-header/${file}`)).toBe(true);
  });

  it('every header image reference resolves to a real file', () => {
    const referenced = [...TSX.matchAll(/\$\{APPROVED_HEADER_ASSET\}([A-Za-z0-9._-]+)/g)].map(
      (m) => m[1]
    );
    expect(referenced.length).toBeGreaterThanOrEqual(IMAGES.length);
    for (const file of referenced) {
      expect(
        exists(`../../public/images/global-header/${file}`),
        `missing public/images/global-header/${file}`
      ).toBe(true);
    }
  });
});

describe('mobile uses the identical desktop header', () => {
  it('has no portrait-only alternate composition', () => {
    expect(CSS).not.toContain('@media (max-width: 767px) and (orientation: portrait)');
    expect(CSS).not.toContain('flex-direction: column');
    expect(CSS).not.toContain('border-image-source');
  });

  it('keeps the approved raster visible at every viewport width', () => {
    expect(CSS).toContain('width: calc(100% - env(safe-area-inset-left');
    expect(CSS).toContain('aspect-ratio: 1648 / 168');
    expect(CSS).not.toMatch(/\.desktopArtwork\s*\{\s*display: none;/);
  });

  it('uses only artwork derived from the approved source image', () => {
    expect(TSX).toContain('global-header-desktop.png');
    for (const file of [
      'menu.png',
      'back.png',
      'hub.png',
      'profile.png',
      'wallet.png',
      'vip.png',
      'messenger.png',
      'notifications.png',
    ]) {
      expect(TSX).toContain(`APPROVED_HEADER_ASSET}${file}`);
    }
    // The supplied artwork already contains Smarter.Poker. No route-specific
    // plate is allowed to cover or replace it.
    expect(TSX).toContain('aria-label="Smarter.Poker Global Header"');
    expect(TSX).not.toContain('images/club-arena/vault-iris-emblem');
    expect(TSX).not.toContain('className={styles.headerCenter}');
    expect(TSX).not.toContain('className={styles.brandName}');
    expect(CSS).not.toContain('.headerCenter');
  });

  it('locks the approved desktop bytes and excludes global-header art from resizing', () => {
    expect(createHash('sha256').update(APPROVED_DESKTOP).digest('hex')).toBe(
      '7c5613a84a395abd6b9527785b46c99fb28b6264e2258bee366a04cac5500c7f'
    );
    expect(OPTIMIZER).toContain("{ prefix: 'images/global-header/', maxDim: 0 }");
  });
});

describe('the profile region shows the complete live profile picture', () => {
  /*
   * UPDATED 2026-09-01. This block used to pin an opaque black disc over the
   * baked ornament on EVERY width, with a 72% portrait centred at 50%/50%.
   * Measured against the artwork this header actually renders
   * (images/global-header/global-header-desktop.png, 1648x168), the ornament is
   * a circle centred at (1159.75, 80.5) with a 94-unit outer diameter and an
   * 81-unit aperture inside its chrome band. The disc was 117.8 units - wider
   * than the ornament - so it painted out the ring and its blue glow, and the
   * 72% portrait was 84.8 units sitting 3.6 units low, overlapping the band.
   * Dan, 2026-09-01: "the profile image needs to be fixed on most of them".
   * Below 901px the portrait now fills the measured aperture and the approved
   * ring frames it. At and above 901px the artwork is squashed by
   * `object-fit: fill` into a 96px band, so the ornament is an ellipse up there
   * and the old opaque mask is still correct - the second test pins that it
   * survived unchanged.
   */
  it('fills the measured ornament aperture and stops covering the approved ring', () => {
    expect(TSX_CODE).toContain('avatarUrl');
    expect(TSX).toContain('className={styles.profileAvatarSlot}');
    expect(TSX).toContain('className={styles.profileAvatar}');
    expect(TSX).not.toContain('className={styles.profileFrameOverlay}');
    expect(CSS).toContain('.profileAvatarSlot');
    expect(CSS).toContain('.profileAvatar');
    expect(CSS).not.toContain('.profileFrameOverlay');

    const profileButton = ruleBody(CSS, '.profileBtn');
    expect(profileButton).toContain('contain: layout paint');
    expect(profileButton).toContain('left: 66.75%');
    expect(profileButton).toContain('width: 7.15%');
    expect(profileButton).toContain('top: 15%');
    expect(profileButton).toContain('aspect-ratio: 1');
    // The hit region paints nothing. A shape drawn over approved artwork is a
    // defect, and this one was hiding the chrome ring and its glow.
    expect(profileButton).not.toMatch(/background:\s*#000/);
    expect(profileButton).not.toMatch(/border-radius:\s*50%/);

    const slot = ruleBody(CSS, '.profileAvatarSlot');
    expect(slot).toContain('top: 46.9% !important');
    expect(slot).toContain('left: 50.7% !important');
    expect(slot).toContain('width: 68.7%');
    expect(slot).toContain('aspect-ratio: 1');
    expect(slot).toContain('transform: translate(-50%, -50%) !important');
    expect(slot).toContain('border-radius: 50%');
    expect(slot).toContain('background: transparent');
    expect(slot).toContain('z-index: 1');

    const portrait = ruleBody(CSS, '.profileAvatarSlot > .profileAvatar');
    expect(portrait).toContain('width: 100% !important');
    expect(portrait).toContain('border-radius: 50% !important');
    expect(portrait).toContain('background: transparent !important');
    // cover, never contain: an avatar is almost never 1:1, and contain
    // letterboxes it with black bars instead of filling the aperture.
    expect(portrait).toContain('object-fit: cover !important');
    expect(portrait).not.toContain('object-fit: contain');
  });

  it('keeps the desktop profile mask inside the compressed 96px header rail', () => {
    expect(CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.profileBtn\s*\{[\s\S]*?top: 13%;[\s\S]*?height: 74%;[\s\S]*?aspect-ratio: auto;[\s\S]*?background: #000;/
    );
    /* THE PORTRAIT IS INSIDE THE FRAME (Dan 2026-09-05: "THE PROFILE PIC IN
       THE GLOBAL HEADER IS DISTORTED AND NOT IN ITS FRAME").

       PIN CORRECTED. It used to require `width: 72%` on the desktop slot,
       preserving the pre-2026-09-01 geometry verbatim. That geometry was the
       defect: the rule above cancels `aspect-ratio` while the mobile
       `width: 7.15%` is inherited, so this button is ~120px wide by ~71px tall
       at a 1680px viewport - and 72% of its WIDTH is an 86px circle inside a
       71px box that is `overflow: hidden`. The portrait had its top and bottom
       sliced off, which is what "distorted" looks like.

       The slot is sized from the button's HEIGHT now, which is the axis that
       constrains it. The pin follows: it must never again be sized from the
       width on this breakpoint. */
    expect(CSS).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.profileAvatarSlot\s*\{[\s\S]*?top: 50% !important;[\s\S]*?left: 50% !important;[\s\S]*?width: auto;[\s\S]*?height: 86%;/
    );
    const desktopSlot = CSS.slice(CSS.indexOf('@media (min-width: 901px)')).match(
      /\.profileAvatarSlot\s*\{([\s\S]*?)\}/
    );
    expect(desktopSlot?.[1]).not.toMatch(/width:\s*\d/);
  });
});

describe('VIP membership state without header shimmer', () => {
  it('dims non-members while keeping active VIP and every header control free of selector boxes and shimmer', () => {
    expect(TSX_CODE).toContain('isVipActive');
    expect(TSX).toContain("data-vip-active={isVipActive ? 'true' : 'false'}");
    expect(CSS).toContain('.vipBtn:not(.vipActive)::after');
    expect(CSS).not.toMatch(/\.vipActive\s*\{/);
    expect(CSS).not.toContain('rgba(255, 255, 255, 0.92)');
    expect(TSX_CODE).not.toMatch(/shimmer/i);
    expect(CSS).not.toMatch(/shimmer/i);
  });
});

describe('compact unread badges preserve the mobile notification bell', () => {
  it('moves the readable count beyond the bell artwork right edge', () => {
    expect(CSS).toContain('@media (max-width: 900px)');
    expect(CSS).toContain('right: -2px');
    expect(CSS).toContain('min-width: clamp(12px, 1.7vw, 18px)');
    expect(CSS).toContain('font-size: clamp(7px, 1vw, 10px)');
  });
});
