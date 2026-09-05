/**
 * THE CLUB GREETING IS A CONTAINED POPUP, NOT A SHEET OVER THE LOBBY.
 *
 * Dan, 2026-09-04: "IT NEEDS TO BE INSIDE THE SCREEN, AND HAVE 20 PIXEL MARGIN
 * ON ALL SIDES, NOT COVER THE ENTIRE FUCKING SCREEN."
 *
 * Measured on the live Deep Stack lobby BEFORE this rule:
 *   .club-entry-message-modal   526 x 1195   in a 566 x 1235 window
 * 20px of inset on paper, an opaque sheet in practice - which is what "the page
 * goes black after loading for a split second" was, and why the close control
 * read as part of the black rather than as a way out.
 *
 * AFTER, same lobby, same window:
 *   .club-entry-message-modal   480 x 342    23% of the screen
 * lobby visible behind it, close control inside the card.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'src/components/club/ClubEntryMessage.css'), 'utf8');

function ruleBody(selector: string): string {
  const i = CSS.indexOf(selector + ' {');
  expect(i, `${selector} must exist`).toBeGreaterThan(-1);
  return CSS.slice(i + selector.length, CSS.indexOf('}', i)).replace(/\s+/g, ' ');
}

/* `.ca-modal--fullscreen`, not `.modal-fullscreen` (2026-09-04): the shared
   Modal's classes are namespaced now, because its `.modal-overlay` backdrop
   was being restyled by nine other stylesheets and ended up painted OVER this
   card. See tests/the-shared-modal-owns-its-class-names.law.test.ts. */
const PANEL = '.club-entry-message-modal.ca-modal--fullscreen';

describe('the greeting is a contained popup', () => {
  it('is sized by its content, never by the viewport', () => {
    const b = ruleBody(PANEL);
    expect(b).toContain('height: auto');
    // The regression was a viewport-sized panel. A full-height rule must not
    // come back in any form.
    // `height:`, not `max-height:` — the cap below is allowed and required.
    const bare = b.replace(/max-height:[^;]*;/g, '');
    expect(bare).not.toMatch(/(^|;)\s*height:\s*calc\(100dvh/);
    expect(bare).not.toMatch(/(^|;)\s*height:\s*100(dvh|vh|%)/);
  });

  it('is capped at a normal dialog width', () => {
    expect(ruleBody(PANEL)).toContain('480px');
  });

  it('keeps a 20px gutter on all four sides', () => {
    const b = ruleBody(PANEL);
    // 40px = 20 left + 20 right, and the same vertically.
    // 40px = 20 left + 20 right, and the same vertically — with the device's
    // own reserved insets winning where they are larger (notch, home bar).
    expect(b).toMatch(/100vw - max\(40px, env\(safe-area-inset-left\)/);
    expect(b).toMatch(/100dvh - max\(40px, env\(safe-area-inset-top\)/);
    // A hard floor, because the overlay's centring alone does not guarantee it.
    expect(b).toMatch(/margin:\s*max\(20px, env\(safe-area-inset-top\)\)/);
  });

  it('cannot grow past the screen it opens on', () => {
    const b = ruleBody(PANEL);
    expect(b).toContain('max-height');
    // dvh, not vh: a collapsing mobile address bar must not defeat the cap.
    expect(b).toContain('dvh');
    expect(b).not.toMatch(/max-height:\s*[^;]*\d+vh/);
  });

  it('a long message scrolls inside the card', () => {
    // The card fills its own height, and the wrapper scrolls its overflow —
    // together that is what keeps a long greeting from pushing the card off
    // screen. Without the .ca-modal-content link, `flex: 1` has no flex parent
    // (the shared Modal wraps children) and the content collapses (#2899).
    const inner = ruleBody(`${PANEL} > .ca-modal-content`);
    expect(inner).toContain('display: flex');
    expect(inner).toContain('flex: 1');
    expect(inner).toContain('flex-direction: column');
    expect(inner).toContain('min-height: 0');
    expect(ruleBody('.club-entry-message')).toContain('overflow-y: auto');
  });

  it('the close control is still a 44px target', () => {
    // A greeting nobody can dismiss on the first try is worse than no greeting.
    const close = ruleBody('.club-entry-message__close');
    expect(close).toContain('width: 44px');
    expect(close).toContain('height: 44px');
  });
});
