/**
 * QUICK AVATAR — the composed avatar has to survive the write point
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `AvatarCustomizer` shipped emitting the string `preset:<emoji>:<hex>` from a
 * Save button that no mount site listened to. Even wired up it could not have
 * worked: `AvatarService.setUserAvatar` runs every value through
 * `isLibraryAvatarUrl`, which refuses anything that is not library art, an
 * AI-generated image, or a locally drawn SVG. `preset:...` is none of those, so
 * the save would have returned false and the player would have watched a
 * "Save Avatar" button do nothing.
 *
 * The component now composes an SVG data URL. These tests pin the two
 * properties that make that correct rather than merely different: it PASSES the
 * guard, and it stays small enough to live in a column that is re-sent to every
 * client rendering this player at a table (which is precisely why the base64
 * photo path was removed).
 */
import { describe, it, expect } from 'vitest';
import { composeQuickAvatar } from '../../src/components/customization/AvatarCustomizer';
import { isLibraryAvatarUrl } from '../../src/services/AvatarService';

describe('composeQuickAvatar', () => {
  it('produces a URL the library-only guard accepts', () => {
    const url = composeQuickAvatar('♠', '#3b82f6');
    expect(isLibraryAvatarUrl(url)).toBe(true);
  });

  it('is deterministic: the same choice is the same avatar', () => {
    expect(composeQuickAvatar('♠', '#3b82f6')).toBe(composeQuickAvatar('♠', '#3b82f6'));
  });

  it('a different glyph or colour is a different avatar', () => {
    const a = composeQuickAvatar('♠', '#3b82f6');
    expect(composeQuickAvatar('♥', '#3b82f6')).not.toBe(a);
    expect(composeQuickAvatar('♠', '#ef4444')).not.toBe(a);
  });

  it('stays under 1KB, because this string is stored and re-sent per seat', () => {
    expect(composeQuickAvatar('♠', '#3b82f6').length).toBeLessThan(1024);
  });

  it('carries the chosen background into the markup', () => {
    const svg = decodeURIComponent(composeQuickAvatar('♠', '#22c55e').split(',')[1]);
    expect(svg).toContain('#22c55e');
    expect(svg).toContain('♠');
  });

  it('strips markup characters so a glyph cannot break out of the SVG', () => {
    // The glyph list is a constant today. This is here so it stays safe if a
    // later change ever lets a value reach it from outside.
    const svg = decodeURIComponent(
      composeQuickAvatar('</text><script>x()</script>', '#000000').split(',')[1]
    );
    expect(svg).not.toContain('<script');
    // The injected string must not have opened or closed any element: the SVG
    // still holds exactly one <text> and one </text>, its own.
    expect(svg.match(/<text\b/g)).toHaveLength(1);
    expect(svg.match(/<\/text>/g)).toHaveLength(1);
  });

  it('the SAVED value is what the guard sees. Not the old preset: form', () => {
    // Sabotage check on the actual regression: the previous payload shape.
    expect(isLibraryAvatarUrl('preset:♠:#ef4444')).toBe(false);
  });
});
