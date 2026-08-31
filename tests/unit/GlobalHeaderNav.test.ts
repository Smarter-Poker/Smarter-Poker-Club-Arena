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
const APPROVED_DESKTOP = readBytes(
  '../../public/images/global-header/global-header-command-center-v1.png'
);

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
  const IMAGES = ['command-center-v1.png', 'back.png', 'hub.png'] as const;

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
    expect(TSX).toContain('global-header-command-center-v1.png');
    for (const file of [
      'command-center-v1.png',
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
      'bb62242b86cef3eb440e152390b09e966f5a4fc28487ddf2ed701a2c4adae3f9'
    );
    expect(OPTIMIZER).toContain("{ prefix: 'images/global-header/', maxDim: 0 }");
  });
});

describe('the profile region shows the complete live profile picture', () => {
  it('removes the baked ornament and centers one thin black-framed circle', () => {
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
    expect(profileButton).toContain('border: 0');
    expect(profileButton).toContain('border-radius: 50%');
    expect(profileButton).toContain('background: #000');
    const slot = ruleBody(CSS, '.profileAvatarSlot');
    expect(slot).toContain('top: 50% !important');
    expect(slot).toContain('left: 50% !important');
    expect(slot).toContain('width: 72%');
    expect(slot).toContain('aspect-ratio: 1');
    expect(slot).toContain('transform: translate(-50%, -50%) !important');
    expect(slot).toContain('box-sizing: border-box');
    expect(slot).toContain('border: 1px solid rgba(0, 0, 0, 0.94)');
    expect(slot).toContain('border-radius: 50%');
    expect(slot).toContain('background: transparent');
    expect(slot).toContain('z-index: 1');
    const portrait = ruleBody(CSS, '.profileAvatarSlot > .profileAvatar');
    expect(portrait).toContain('width: 100% !important');
    expect(portrait).toContain('border-radius: 50% !important');
    expect(portrait).toContain('background: transparent !important');
    expect(portrait).toContain('object-fit: cover !important');
  });
});

describe('VIP membership state without header shimmer', () => {
  it('dims non-members, outlines active VIP, and keeps every header control free of shimmer effects', () => {
    expect(TSX_CODE).toContain('isVipActive');
    expect(TSX).toContain("data-vip-active={isVipActive ? 'true' : 'false'}");
    expect(CSS).toContain('.vipBtn:not(.vipActive)::after');
    expect(CSS).toContain('.vipActive');
    expect(CSS).toContain('rgba(255, 255, 255, 0.92)');
    expect(TSX_CODE).not.toMatch(/shimmer/i);
    expect(CSS).not.toMatch(/shimmer/i);
  });
});
