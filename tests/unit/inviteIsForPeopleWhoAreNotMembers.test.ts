/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE INVITE PAGE IS FOR PEOPLE WHO ARE NOT MEMBERS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28, mobile pass item 4, verbatim:
 *
 *   "IF YOU ARE ALREADY A MEMBER YOU SHOULD NEVER EVER EVER SEE THIS... AND IT
 *    NEEDS TO BE FULLY UPGRADED, ENHANCED AND OPTIMIZED. NEEDS TO BE FACEBOOK
 *    COLOR SCHEMA AND LOOK BETTER."
 *
 * The page used to answer an active member with a "You're Already A Member!"
 * panel and an Enter Club button — a dead end that made someone press one more
 * button to reach somewhere they were already entitled to be. Now the member
 * check redirects into the club before anything paints.
 *
 * A SOURCE-TEXT TEST, deliberately. Rendering InvitePage means standing up the
 * Supabase client, the auth hook, the toast provider, the master bus and a
 * router, and the thing worth pinning is not what React does with a mocked
 * membership row — it is that the branch exists, that it REPLACES rather than
 * pushes, and that the copy which contradicts it is gone. All three are
 * one-line regressions and all three are visible in the file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../src/pages/InvitePage.tsx'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../../src/pages/InvitePage.css'), 'utf8');

/* Comments quote Dan's instruction and describe the old markup, so any
   assertion about what the page RENDERS has to strip them first. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('an existing member is never shown the invitation', () => {
  it('redirects into the club instead of rendering a panel', () => {
    expect(CODE, 'the membership branch must send them into the club').toMatch(
      /\}\s*else if \(membership\)\s*\{[\s\S]{0,400}?enterClub\(/
    );
  });

  it('REPLACES the history entry, so Back is not a trap', () => {
    /* A push would leave the invite page on the stack: Back from the club lands
       here, the member check runs again and throws them forward. The Back button
       then appears broken, which is a worse bug than the one being fixed. */
    expect(CODE).toMatch(/navigate\(\s*`\/clubs\/\$\{slugOrId\}`\s*,\s*\{\s*replace:\s*true\s*\}/);
  });

  it('routes every "you are in now" exit through the same helper', () => {
    // Three call sites: the member redirect, the pending row that redeems on
    // load, and a successful Join. They used to be three separate navigate()
    // calls with slightly different arguments, which is how one of them kept
    // its push semantics after the others were fixed.
    expect(CODE, 'the helper itself must exist').toMatch(/const enterClub = useCallback\(/);
    const calls = CODE.match(/enterClub\(/g) ?? [];
    expect(calls.length, 'member redirect, pending redemption, and join').toBe(3);
    expect(
      CODE.match(/navigate\(`\/clubs\//g) ?? [],
      'no direct club navigation may bypass enterClub'
    ).toHaveLength(1);
  });

  it('has no "already a member" copy or share panel left to reach', () => {
    for (const gone of [
      'already-member',
      "You're Already A Member",
      'Enter Club',
      'share-invite-panel',
      'QRCodeSVG',
      'alreadyMember',
    ]) {
      expect(CODE, `${gone} is unreachable now and must not be rendered`).not.toContain(gone);
    }
  });

  it('does not keep querying profiles to build a link nobody can see', () => {
    // The invite-URL effect existed only to feed the share panel's `?ref=`, and
    // it ran a `profiles` round trip on every single load. Dead code that still
    // makes a request is worse than dead code.
    expect(CODE).not.toContain('setInviteUrl');
    expect(CODE).not.toMatch(/from\('profiles'\)/);
  });
});

describe('the page wears the black-glass and gold treatment', () => {
  /**
   * Dan sent three reference cards on 2026-08-28 with "CUSTOM SWAP, CUSTOM MAKE
   * AND DESIGN THEM, BUT THEY SHOULD LOOK AND FEEL LIKE THIS". They supersede
   * the Facebook palette he had asked for an hour earlier, which this beat used
   * to pin (`--fb-blue: #1877f2`, `--fb-bg: #f9fafb`). The look is the Club
   * Arena house one: black glass in a brushed-steel frame, blue neon down the
   * long edges, gold Cinzel display type.
   */
  it('declares the gold / neon / steel palette', () => {
    for (const token of ['--iv-gold:', '--iv-neon:', '--iv-steel:', '--iv-ink:']) {
      expect(CSS, `${token} went missing`).toContain(token);
    }
    expect(CSS, 'Cinzel is the display face in the reference').toMatch(/Cinzel/);
  });

  /**
   * The frame is BUILT, not imported. "Custom make and design them" rules out
   * shipping the mockups as three PNGs, and a background-image here would also
   * mean a fixed width, a network request and a re-export every time a colour
   * moves. Everything is gradients, borders and shadows.
   */
  it('draws the frame in CSS rather than referencing an image', () => {
    expect(CSS, 'no image assets - the bezel and the neon are drawn').not.toMatch(
      /url\((?!['"]?https:\/\/fonts\.googleapis\.com)/
    );
    const frame = CSS.match(/\.invite-page \.invite-frame\s*\{([^}]*)\}/);
    expect(frame, 'the steel frame rule went missing').toBeTruthy();
    expect(frame![1], 'the bezel is a brushed gradient').toMatch(/linear-gradient/);
  });

  /**
   * `background-clip: text` with a transparent fill is how the silver and gold
   * headings are done, and its one failure mode is a browser that drops the
   * clip and renders nothing at all. Every such rule must therefore set a real
   * `color` FIRST, as the fallback.
   */
  it('never leaves a gradient heading invisible if background-clip is dropped', () => {
    const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*background-clip:\s*text[^{}]*)\}/g)];
    expect(rules.length, 'no gradient text found - did the technique change?').toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      if (!/-webkit-text-fill-color:\s*transparent/.test(body)) continue;
      // A heading may inherit its fallback from a shorter selector, so only the
      // top-level headings are required to carry their own.
      if (!/(club-name|error-state h2)/.test(selector)) continue;
      /* `(?<![-\w])` so this matches the `color` property and not the tail of
         `-webkit-text-fill-color`, and so an intervening comment between the
         previous declaration and this one cannot hide it. */
      expect(body, `${selector.trim()} needs a plain colour before the gradient`).toMatch(
        /(?<![-\w])color:\s*[^;]+;/
      );
    }
  });

  it('keeps every tap target at 44px, the phone minimum', () => {
    const btn = CSS.match(/\.invite-page \.invite-btn\s*\{([^}]*)\}/);
    expect(btn, 'the button rule went missing').toBeTruthy();
    const minH = Number(btn![1].match(/min-height:\s*(\d+)px/)?.[1]);
    expect(minH, 'below the 44px minimum touch target').toBeGreaterThanOrEqual(44);
  });

  /**
   * This stylesheet is a plain global, not a module, and it used to declare bare
   * `.club-name`, `.club-description`, `.club-stats` and `.join-btn` — all four
   * of which are live class names in OTHER components (ClubDiscovery, HomePage,
   * FavoriteTablesWidget, TournamentLobbyPage, ClubSettingsPage). Whichever
   * stylesheet the bundler emitted last won, so this page's typography was
   * landing on the club discovery grid.
   */
  it('namespaces every selector, so it cannot style other pages', () => {
    const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...withoutComments.matchAll(/(^|\})\s*([^{}@]+)\{/g)]
      .map((m) => m[2].trim())
      .filter((s) => s.startsWith('.') || s.startsWith('#'));

    expect(
      selectors.length,
      'no selectors parsed - the regex is wrong, not the CSS'
    ).toBeGreaterThan(5);
    for (const sel of selectors) {
      for (const part of sel.split(',')) {
        expect(part.trim(), `"${part.trim()}" escapes the .invite-page namespace`).toMatch(
          /^\.invite-page\b/
        );
      }
    }
  });
});
